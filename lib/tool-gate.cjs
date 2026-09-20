// L0: deterministic tool classification + a result cache.
//
// The point of this file is that most tool calls never reach Jev. A decision
// costs ~1s, and a session makes hundreds of tool calls; gating all of them
// makes the session unusable and teaches everyone to disable the gate. So:
//
//   allow  -- provably read-only, or an ordinary edit inside the workspace.
//             Returned in microseconds, no API call.
//   deny   -- unambiguous catastrophe. A hard floor that does not consult Jev,
//             so a model outage (or a confident wrong answer) cannot approve it.
//   gate   -- everything else: ask Jev.
//
// Nothing here is a security boundary on its own. It is a cost filter with a
// deny floor; the privileged checks still belong to whatever executes the call.
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { dirname, resolve, sep } = require("node:path");
const { config } = require("./config.cjs");

// Tools that cannot mutate anything.
const READ_ONLY_TOOLS = new Set([
  "Read", "Glob", "Grep", "NotebookRead", "TodoWrite", "WebSearch", "WebFetch",
  "Task", "Agent", "ListMcpResourcesTool", "ReadMcpResourceTool", "ToolSearch",
  "AskUserQuestion", "Skill", "ExitPlanMode", "EnterPlanMode",
]);

// Bash command heads that only read. `sed` and `awk` are here conditionally --
// see readOnlySegment, which rejects their writing forms.
const READ_ONLY_HEADS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "egrep", "fgrep", "find",
  "file", "stat", "pwd", "echo", "printf", "which", "type", "whoami", "date",
  "uname", "df", "du", "tree", "jq", "yq", "sort", "uniq", "cut", "tr", "column",
  "basename", "dirname", "realpath", "readlink", "sha256sum", "md5sum", "cksum",
  "diff", "cmp", "true", "false", "test", "sleep", "seq", "tee",
  // Navigation and grouping. Omitting `cd` alone sent 85% of real calls to the
  // model, because almost every command in a repo starts with one.
  "cd", "pushd", "popd", "time", "env", "[", "[[", ":",
  "sed", "awk", "git", "node", "python3", "npm", "pnpm", "yarn", "cargo", "go",
]);

// Subcommands that only report. Anything else under these heads is gated.
const SUBCOMMAND_ALLOW = {
  git: new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "describe",
    "ls-files", "ls-remote", "blame", "shortlog", "tag", "config", "worktree", "count-objects"]),
  npm: new Set(["ls", "list", "view", "outdated", "why", "root", "prefix", "config"]),
  pnpm: new Set(["ls", "list", "why", "outdated", "root"]),
  yarn: new Set(["list", "why", "info"]),
  cargo: new Set(["tree", "metadata", "search"]),
  go: new Set(["list", "version", "env"]),
};

// Heads that are read-only only when given a version/help flag.
const VERSION_ONLY = new Set(["node", "python3"]);

// Unambiguous catastrophe. Denied without asking Jev.
const HARD_DENY = [
  [/\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(\/|\/\*|~|\$HOME|\/home|\/etc|\/usr|\/var|\/boot)(\s|$|\*)/, "recursive delete of a system or home root"],
  [/\bmkfs(\.[a-z0-9]+)?\b/, "filesystem format"],
  [/\bdd\b[^|;]*\bof=\/dev\/(sd|nvme|vd|hd|disk)/, "raw write to a block device"],
  [/\bchmod\s+(-[a-zA-Z]+\s+)*777\s+\/(\s|$)/, "world-writable system root"],
  [/\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/, "host power state change"],
  [/\bshred\b\s+[^|;]*\/dev\//, "device destruction"],
];

// Paths an ordinary edit should never touch without a look.
const SENSITIVE_PATH = [
  /(^|\/)\.env(\.|$)/, /(^|\/)\.ssh(\/|$)/, /(^|\/)\.aws(\/|$)/, /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)id_(rsa|ed25519|ecdsa)/, /(^|\/)\.netrc$/, /(^|\/)credentials(\.|$)/,
  /(^|\/)secrets?(\.|\/)/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/,
  /(^|\/)\.git\/(config|hooks)/, /(^|\/)\.github\/workflows\//, /(^|\/)\.gitlab-ci\.yml$/,
  /(^|\/)Dockerfile$/, /(^|\/)docker-compose\.ya?ml$/, /(^|\/)Caddyfile$/,
  /(^|\/)nginx\.conf$/, /(^|\/)\.claude\/settings/, /(^|\/)crontab$/,
  /^\/etc\//, /^\/usr\//, /^\/boot\//, /^\/var\/(lib|www)\//, /^\/opt\//,
];

// Operator-supplied protected patterns, e.g. a deployed host's config.
// JEV_TOOL_PROTECTED="Caddyfile,/srv/www" -> substring or /regex/ per entry.
function protectedPatterns() {
  const raw = process.env.JEV_TOOL_PROTECTED || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("/") && s.endsWith("/") && s.length > 2 ? new RegExp(s.slice(1, -1), "i") : new RegExp(escapeRe(s), "i")));
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strip the redirect forms that appear in ordinary read commands so they do not
// disqualify an otherwise read-only segment.
function stripBenignRedirects(cmd) {
  return cmd
    .replace(/\d?>\s*\/dev\/null/g, " ")
    .replace(/\d?>&\d/g, " ")
    .replace(/\|\s*(head|tail|cat|wc|sort|uniq|grep|rg|jq|column|cut|tr)\b/g, " | $1 ");
}

function hasDangerousShellFeature(cmd) {
  if (/\$\(|`/.test(cmd)) return "command substitution";
  if (/(^|[^0-9&>])>{1,2}(?!&)\s*[^\s|;&]/.test(cmd)) return "output redirect";
  if (/\beval\b|\bexec\b|\bsource\b|^\s*\./.test(cmd)) return "dynamic evaluation";
  if (/\bsudo\b|\bsu\b\s|\bdoas\b/.test(cmd)) return "privilege escalation";
  if (/\|\s*(sh|bash|zsh|python3?|node|perl|ruby)\b/.test(cmd)) return "pipe into an interpreter";
  return null;
}

function readOnlySegment(seg) {
  const t = stripKeywords(seg);
  if (!t) return true;
  // `for f in a b` leaves `f in a b` after keyword stripping: a loop header,
  // which runs nothing.
  if (/^[A-Za-z_][A-Za-z0-9_]*\s+in\s+/.test(t)) return true;
  const parts = t.split(/\s+/);
  const head = parts[0].replace(/^.*\//, "");
  if (!READ_ONLY_HEADS.has(head)) return false;
  if (head === "sed") return !parts.some((p) => p === "-i" || p.startsWith("-i") || p === "--in-place");
  if (head === "awk") return !/system\s*\(|print\s*>|printf\s*>/.test(t);
  if (head === "tee") return false; // writes by definition
  if (VERSION_ONLY.has(head)) return parts.slice(1).some((p) => /^(--version|-v|--help|-h)$/.test(p));
  const allow = SUBCOMMAND_ALLOW[head];
  if (allow) {
    const sub = parts.slice(1).find((p) => !p.startsWith("-"));
    if (!sub || !allow.has(sub)) return false;
    // `git config --get x` reads; `git config x y` writes.
    if (head === "git" && sub === "config" && !parts.some((p) => /^(--get|--list|-l)/.test(p))) return false;
    if (head === "git" && sub === "tag" && !parts.some((p) => /^(-l|--list)$/.test(p))) return false;
    if (head === "git" && sub === "worktree" && !parts.includes("list")) return false;
    return true;
  }
  return true;
}

// Shell keywords that prefix a real command inside a loop or conditional.
const KEYWORDS = new Set(["do", "done", "then", "else", "elif", "fi", "esac", "if", "while", "until", "for", "case", "{", "}", "(", ")", "!"]);

// Only SHELL interpreters. The deny patterns are shell syntax, so following
// them into `bash -c "..."` is sound. Following them into `node -e "..."` is
// not: there `rm -rf /` is nearly always a string literal, and real deletion
// uses fs.rm, which these patterns would not catch anyway. Those calls are not
// read-only heads, so they still gate -- the floor just does not pretend to
// parse a language it was not written for.
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "env"]);

// A deny is anchored to the binary being run, not to text appearing anywhere in
// the command. Without this anchor, grepping for a pattern, echoing it, or
// writing a test about it all get denied -- false positives that block real
// work and teach people to switch the gate off.
const DANGEROUS_HEADS = new Set(["rm", "mkfs", "dd", "chmod", "shutdown", "reboot", "halt", "poweroff", "shred"]);

// Whole-command forms that are not head-shaped: a fork bomb, and a redirect
// onto a raw block device.
const WHOLE_COMMAND_DENY = [
  [/:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;\s*:/, "fork bomb"],
  [/>\s*\/dev\/(sd|nvme|vd|hd|disk)[a-z0-9]*/, "raw write to a block device"],
];

// Split on shell operators that are OUTSIDE quotes. Splitting naively turns the
// `&&` inside `node -e 'a && b'` into a segment boundary, which then reads the
// remainder of a string literal as its own command. This is not a shell parser;
// it tracks quoting and escaping, which is what the operator split needs.
function splitSegments(cmd) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (quote === '"' && ch === "\\") { cur += ch + (cmd[++i] || ""); continue; }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "\\") { cur += ch + (cmd[++i] || ""); continue; }
    if ((ch === "&" && cmd[i + 1] === "&") || (ch === "|" && cmd[i + 1] === "|")) {
      out.push(cur); cur = ""; i++; continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.filter((x) => x.trim());
}

// Remove quoted literals, so whole-command checks look at shell structure only.
function stripQuoted(cmd) {
  return cmd.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function stripKeywords(seg) {
  let t = seg.trim();
  let prev;
  do {
    prev = t;
    const first = t.split(/\s+/)[0];
    // Drop loop/conditional keywords and `VAR=value` prefixes.
    if (KEYWORDS.has(first) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) t = t.slice(first.length).trim();
  } while (t !== prev && t);
  return t;
}

// A heredoc body is data being written, not commands being run. Scanning it
// denies any attempt to write a file that discusses a dangerous pattern --
// including this file and its own tests.
function stripHeredocs(cmd) {
  return cmd.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm, "<<HEREDOC");
}

function hardDenySegment(seg, depth = 0) {
  const t = stripKeywords(seg);
  if (!t) return null;
  const parts = t.split(/\s+/);
  const head = parts[0].replace(/^.*\//, "");
  const base = head.split(".")[0]; // mkfs.ext4 -> mkfs

  if (INTERPRETERS.has(base) && depth < 2) {
    const flagIdx = parts.findIndex((x) => x === "-c" || x === "--command");
    if (flagIdx >= 0) {
      const after = t.slice(t.indexOf(parts[flagIdx]) + parts[flagIdx].length).trim();
      const inner = after.replace(/^(['"])([\s\S]*)\1$/, "$2");
      for (const sub of splitSegments(inner)) {
        const hit = hardDenySegment(sub, depth + 1);
        if (hit) return hit;
      }
    }
  }
  if (!DANGEROUS_HEADS.has(base)) return null;
  for (const [re, why] of HARD_DENY) {
    if (re.test(t)) return why;
  }
  return null;
}

function classifyBash(cmd) {
  const raw = String(cmd || "");
  const body = stripHeredocs(raw);
  for (const [re, why] of WHOLE_COMMAND_DENY) {
    if (re.test(stripQuoted(body))) return { verdict: "deny", reason: `blocked: ${why}`, rule: "hard-deny" };
  }
  for (const seg of splitSegments(body)) {
    const why = hardDenySegment(seg);
    if (why) return { verdict: "deny", reason: `blocked: ${why}`, rule: "hard-deny" };
  }
  for (const re of protectedPatterns()) {
    if (re.test(raw)) return { verdict: "gate", reason: "touches an operator-protected path", rule: "protected" };
  }
  const cleaned = stripBenignRedirects(raw);
  const danger = hasDangerousShellFeature(cleaned);
  if (danger) return { verdict: "gate", reason: danger, rule: "shell-feature" };
  if (splitSegments(cleaned).every(readOnlySegment)) {
    return { verdict: "allow", reason: "read-only command", rule: "read-only" };
  }
  return { verdict: "gate", reason: "mutating or unrecognized command", rule: "default" };
}

function classifyWrite(toolName, input, cwd) {
  const path = input && (input.file_path || input.path || input.notebook_path);
  if (!path) return { verdict: "gate", reason: "no resolvable path", rule: "write-unknown" };
  const abs = resolve(String(path));
  for (const re of SENSITIVE_PATH) {
    if (re.test(abs)) return { verdict: "gate", reason: "sensitive path", rule: "write-sensitive" };
  }
  for (const re of protectedPatterns()) {
    if (re.test(abs)) return { verdict: "gate", reason: "operator-protected path", rule: "protected" };
  }
  const root = cwd ? resolve(cwd) : null;
  if (root && (abs === root || abs.startsWith(root + sep))) {
    return { verdict: "allow", reason: "ordinary edit inside the workspace", rule: "write-in-tree" };
  }
  return { verdict: "gate", reason: "write outside the workspace", rule: "write-out-of-tree" };
}

// Main deterministic entry. Never throws: an unclassifiable call gates.
function classifyTool({ toolName, toolInput = {}, cwd } = {}) {
  try {
    if (!toolName) return { verdict: "gate", reason: "no tool name", rule: "unknown" };
    if (READ_ONLY_TOOLS.has(toolName)) {
      return { verdict: "allow", reason: "read-only tool", rule: "tool-allowlist" };
    }
    if (toolName === "Bash" || toolName === "BashOutput") {
      return classifyBash(toolInput.command);
    }
    if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
      return classifyWrite(toolName, toolInput, cwd);
    }
    if (toolName.startsWith("mcp__")) {
      // Read-shaped MCP calls are common and cheap to recognize by name.
      if (/__(get|list|read|describe|search|query|explain|fetch|inspect|count)(_|$)/.test(toolName)) {
        return { verdict: "allow", reason: "read-shaped MCP call", rule: "mcp-read" };
      }
      return { verdict: "gate", reason: "mutating MCP call", rule: "mcp-write" };
    }
    return { verdict: "gate", reason: "unrecognized tool", rule: "unknown" };
  } catch (e) {
    return { verdict: "gate", reason: "classification error", rule: "error" };
  }
}

// --- cache -----------------------------------------------------------------
// Keyed on the exact call, so a repeated `npm test` costs nothing after the
// first decision. TTL-bounded and size-capped; a corrupt file is discarded
// rather than fixed, because a cache miss is always safe.
const MAX_ENTRIES = 500;

function cacheKey({ toolName, toolInput, cwd }) {
  const norm = JSON.stringify(toolInput || {}).replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${toolName}\u0000${norm}\u0000${cwd || ""}`).digest("hex").slice(0, 32);
}

function readCache() {
  try {
    const raw = JSON.parse(readFileSync(config.toolCacheFile, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function cacheGet(key) {
  const c = readCache();
  const hit = c[key];
  if (!hit) return null;
  // >= so that a TTL of 0 means "no cache" rather than "valid for one tick".
  if (Date.now() - hit.ts >= config.toolCacheTtlMs) return null;
  return hit;
}

function cacheSet(key, value) {
  try {
    const c = readCache();
    c[key] = { ...value, ts: Date.now() };
    const keys = Object.keys(c);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => c[a].ts - c[b].ts).slice(0, keys.length - MAX_ENTRIES).forEach((k) => delete c[k]);
    }
    mkdirSync(dirname(config.toolCacheFile), { recursive: true });
    writeFileSync(config.toolCacheFile, JSON.stringify(c));
  } catch {
    // A cache that cannot be written must not break the gate.
  }
}

module.exports = {
  classifyTool, classifyBash, splitSegments, classifyWrite, cacheKey, cacheGet, cacheSet,
  READ_ONLY_TOOLS, READ_ONLY_HEADS, HARD_DENY, SENSITIVE_PATH,
};
