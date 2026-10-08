#!/usr/bin/env node
// L5: the output filter, as a Claude Code PostToolUse hook on Bash.
//
// A long test, build, install or log command is read once by the most
// expensive model in the loop. This hook hands that model the lines the
// command's purpose needs, verbatim, and saves the full output to a file it
// can read when it wants the rest. It never touches short output, a command
// that reads or searches, a command that prints environment or secrets, output
// that holds anything shaped like a credential, or anything it cannot parse.
//
// Contract: hook JSON on stdin, JSON on stdout, exit 0. On any failure it
// emits nothing and Claude Code shows the original output.
//   JEV_HOOKS_DISABLE=1  every jev hook off
//   JEV_FILTER=0         this hook off; or put JEV_FILTER=0 in the command itself
//
// Limit: Claude Code runs PostToolUse hooks in parallel on the original output
// and the last rewrite wins, so a redacting hook beside this one can be undone
// by it. This hook therefore refuses to touch any output that holds a secret.
const { createHash } = require("node:crypto");
const { mkdirSync, readdirSync, unlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { filterOutput } = require("../lib/filter.cjs");
const { config } = require("../lib/config.cjs");
const { holdsSecret, scrubCommand } = require("../lib/secrets.cjs");

// Command heads that run something and report on it.
const RUNNERS = /^(npm|pnpm|yarn|bun|npx|bunx|node|vitest|jest|mocha|pytest|tox|cargo|go|make|cmake|ninja|tsc|eslint|biome|vite|next|turbo|nx|docker|podman|kubectl|helm|terraform|journalctl|gradle|gradlew|\.\/gradlew|mvn|pip|pip3|uv|poetry|bundle|rake|dotnet|swift|xcodebuild|playwright)$/;
// Heads whose output the reader asked for line by line: never filtered.
const READERS = /^(cat|head|tail|sed|awk|less|more|bat|grep|egrep|rg|ag|find|fd|ls|tree|jq|yq|diff|wc|nl|xxd|od|strings|base64)$/;
const GIT_READERS = /^git\s+(-C\s+\S+\s+)?(show|diff|log|blame|grep|cat-file|ls-files)\b/;
// Runner subcommands that print data the reader asked for, not a run's report.
const DATA_COMMANDS = /^node\s+(-e|-p|--eval|--print)\b|^(npm|pnpm|yarn)\s+(ls|list|view|info|pkg|config|explain|why|outdated)\b|^(pip|pip3|uv\s+pip)\s+(list|show|freeze)\b|^(kubectl|helm)\s+(get|describe|status|list)\b|^(docker|podman)\s+(ps|images|logs\s+--tail)\b|^cargo\s+(tree|metadata)\b|^go\s+(list|env|version)\b|^terraform\s+(plan\s+-json)\b/;
// Commands that print environment, configuration or secrets. Never sent anywhere.
const SECRET_COMMANDS = /^(env|printenv|set|export|declare)\b|^kubectl\s+.*\b(get|describe)\s+secrets?\b|^(docker|podman)\s+(.*\s)?(inspect|config)\b|^(docker|podman)\s+compose\s+(.*\s)?config\b|^(gh|aws|gcloud|az|vercel|heroku|doppler|op|vault)\b.*\b(token|secret|credential|env|login|auth)\b|^terraform\s+(output|show|state)\b/;

const MAX_SAVED = 200;

function emit(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function readStdin() {
  return new Promise((res) => {
    let buf = "";
    let done = false;
    const finish = () => { if (!done) { done = true; res(buf); } };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    setTimeout(finish, 1500).unref();
  });
}

/** Each simple command of a shell line, with leading VAR=value prefixes, `cd x`, `time` and `sudo` taken off its head. */
function segments(command) {
  return String(command)
    .split(/&&|\|\||;|\||\n/)
    .map((part) => part.trim().replace(/^(\(|\{)\s*/, "").replace(/^((time|sudo|nice|nohup|xargs|env(\s+-i)?|timeout\s+\S+)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ""))
    .filter((part) => part && !/^cd(\s|$)|^pushd\b|^popd\b|^true$|^:$|^echo\b|^printf\b/.test(part));
}

/** Null when this call's output may be filtered; otherwise why not. */
function eligible(evt) {
  if (evt.tool_name !== "Bash") return "not Bash";
  const command = String(evt.tool_input?.command || "");
  const response = evt.tool_response;
  if (!response || typeof response !== "object" || typeof response.stdout !== "string") return "unknown output shape";
  if (response.interrupted || response.isImage) return "interrupted or image";
  if (/\bJEV_FILTER=0\b/.test(command)) return "opted out in the command";
  const parts = segments(command);
  if (parts.length === 0) return "not a runner";
  if (parts.some((part) => SECRET_COMMANDS.test(part))) return "prints environment or secrets";
  if (parts.some((part) => READERS.test(part.split(/\s+/)[0]) || GIT_READERS.test(part) || DATA_COMMANDS.test(part))) return "reads or searches";
  if (!parts.some((part) => RUNNERS.test(part.split(/\s+/)[0]))) return "not a runner";
  const text = response.stdout;
  if (text.split("\n").length < config.filterMinLines && text.length < config.filterMinChars) return "short";
  if (holdsSecret(text) || holdsSecret(response.stderr || "") || holdsSecret(command)) return "holds something shaped like a credential";
  return null;
}

function save(text, command) {
  mkdirSync(config.filterDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(config.filterDir, `${stamp}-${createHash("sha256").update(command + text).digest("hex").slice(0, 8)}.log`);
  writeFileSync(path, text, { mode: 0o600 });
  // Keep the newest MAX_SAVED; names sort by time.
  try {
    const old = readdirSync(config.filterDir).filter((name) => name.endsWith(".log")).sort().slice(0, -MAX_SAVED);
    for (const name of old) unlinkSync(join(config.filterDir, name));
  } catch {}
  return path;
}

/** The hook's answer for one event, or null to leave the output alone. `filter` is injectable for tests. */
async function respond(evt, filter = filterOutput) {
  if (eligible(evt)) return null;
  const command = scrubCommand(String(evt.tool_input.command));
  const goal = [evt.tool_input.description, `\`${command.slice(0, 300)}\``].filter(Boolean).join(" — ");
  const text = evt.tool_response.stdout;
  const res = await Promise.race([
    filter({ text, goal }),
    new Promise((r) => setTimeout(() => r(null), config.filterTimeoutMs + 2000).unref()),
  ]);
  if (!res || !res.changed) return null;
  const path = save(text, command);
  const note = `[jev-filter] kept ${res.stats.linesKept} of ${res.stats.linesIn} lines for: ${goal}. Full output: ${path}`;
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: { ...evt.tool_response, stdout: `${res.text}\n${note}` },
    },
  };
}

async function main() {
  if (process.env.JEV_HOOKS_DISABLE === "1" || process.env.JEV_FILTER === "0") return emit(null);
  let evt = {};
  try { evt = JSON.parse((await readStdin()) || "{}"); } catch { return emit(null); }
  return emit(await respond(evt));
}

module.exports = { eligible, respond, segments, RUNNERS, READERS, SECRET_COMMANDS };
if (require.main === module) main().catch(() => emit(null));
