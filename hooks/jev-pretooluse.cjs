#!/usr/bin/env node
// L1: the Auto Mode gate, as a Claude Code PreToolUse hook.
//
// This is the piece that makes "Jev decides" true rather than aspirational.
// The previous setup asked the agent, in prose, to run jev-gate before risky
// actions -- which requires the agent to already know the action is risky, the
// exact judgment the gate exists to make. A hook does not need to be remembered.
//
// Contract: hook JSON on stdin, JSON on stdout, exit 0.
//
// This hook NEVER emits permissionDecision "allow". An "allow" from PreToolUse
// bypasses Claude Code's own permission prompt, so emitting it would make the
// session more permissive than it was without the gate. The gate is additive:
//   deny  -- deterministic catastrophe, or Jev is confident this destroys data
//   ask   -- Jev sees risk; the human decides
//   {}    -- no opinion; normal permission flow proceeds untouched
// Set JEV_TOOL_AUTO_ALLOW=1 to opt into allow-on-clear for speed.
const { classifyTool, cacheKey, cacheGet, cacheSet } = require("../lib/tool-gate.cjs");
const { decide, loadSDK } = require("../lib/decision-engine.cjs");
const { DESTRUCTIVE_RE } = require("../lib/gate.cjs");
const { config } = require("../lib/config.cjs");

function emit(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}
function decision(kind, reason) {
  return {
    continue: true,
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: kind, permissionDecisionReason: reason },
  };
}
const PASS = process.env.JEV_TOOL_AUTO_ALLOW === "1" ? (r) => decision("allow", r) : () => null;

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

// One batched call: three judgments about an action that is about to run.
function questions(SDK) {
  const { noul } = SDK;
  return {
    destructive: noul(
      "Would executing `tool_input` irreversibly destroy data, drop or truncate a database, rewrite published history, or change a deployed or production system? Answer no for changes confined to a working tree, a build or cache directory, or a local development database.",
    ),
    out_of_scope: noul(
      "Would executing `tool_input` write to, move, or delete files outside `cwd`, excluding temporary and cache directories?",
    ),
    secret_exposure: noul(
      "Would executing `tool_input` read, print, or transmit a credential, API key, private key, or password to somewhere it is not already stored?",
    ),
  };
}

async function main() {
  // Kill switch: JEV_HOOKS_DISABLE=1 makes every jev hook a no-op, for when
  // the decision layer itself is what you are debugging.
  if (process.env.JEV_HOOKS_DISABLE === "1") return emit(null);

  const raw = await readStdin();
  let evt = {};
  try { evt = JSON.parse(raw || "{}"); } catch { return emit(null); }

  const toolName = evt.tool_name || evt.toolName || "";
  const toolInput = evt.tool_input || evt.toolInput || {};
  const cwd = evt.cwd || process.cwd();
  if (!toolName) return emit(null);

  // L0: deterministic, no API call.
  const pre = classifyTool({ toolName, toolInput, cwd });
  if (pre.verdict === "deny") {
    return emit(decision("deny", `[jev] ${pre.reason}. This is a deterministic block, not a model judgment. Run it yourself with \`! <command>\` if you intend it.`));
  }
  if (pre.verdict === "allow") return emit(PASS(`[jev] ${pre.reason}`));

  // L1: cached Jev judgment.
  const key = cacheKey({ toolName, toolInput, cwd });
  const hit = cacheGet(key);
  if (hit) {
    if (hit.verdict === "deny") return emit(decision("deny", hit.reason));
    if (hit.verdict === "ask") return emit(decision("ask", hit.reason));
    return emit(PASS(hit.reason));
  }

  const SDK = loadSDK();
  if (!SDK) return emit(null);

  const res = await decide({
    state: { tool: toolName, tool_input: toolInput, cwd },
    questions: questions(SDK),
    downstream: "tool-gate",
    timeoutMs: config.toolTimeoutMs,
  });

  if (res.fallback) {
    // Fail open so an API outage does not brick the session -- but only for
    // calls the deterministic floor does not already find alarming.
    const text = `${toolName} ${JSON.stringify(toolInput)}`;
    if (!config.toolFailOpen || DESTRUCTIVE_RE.test(text)) {
      return emit(decision("ask", `[jev] decision layer unavailable (${res.reason}) and this call matches a destructive pattern. Confirm manually.`));
    }
    return emit(null);
  }

  const p = (id) => (res.results[id] ? Number(res.results[id].noul) : 0);
  const destructive = p("destructive");
  const outOfScope = p("out_of_scope");
  const secret = p("secret_exposure");

  let verdict = "allow";
  let reason = `[jev] no risk signal (destructive ${destructive.toFixed(2)}, scope ${outOfScope.toFixed(2)}, secret ${secret.toFixed(2)})`;
  if (destructive >= config.toolDenyThreshold) {
    verdict = "deny";
    reason = `[jev] destructive with confidence ${destructive.toFixed(2)} (>= ${config.toolDenyThreshold}). Irreversible data loss or a change to a deployed system. If intended, ask the user to run it, or restate the task with the target made explicit.`;
  } else if (secret >= config.toolDenyThreshold) {
    // Moving a credential somewhere it is not already stored is as final as
    // deleting data: it cannot be taken back once it has left.
    verdict = "deny";
    reason = `[jev] would move a credential or private key somewhere it is not already stored (confidence ${secret.toFixed(2)}). Blocked. A secret that has left cannot be recalled; rotate it rather than re-running this.`;
  } else if (Math.max(destructive, outOfScope, secret) >= config.toolAskThreshold) {
    const top = [["destructive", destructive], ["writes outside cwd", outOfScope], ["exposes a secret", secret]]
      .filter(([, v]) => v >= config.toolAskThreshold)
      .map(([k, v]) => `${k} ${v.toFixed(2)}`)
      .join(", ");
    verdict = "ask";
    reason = `[jev] needs confirmation: ${top}.`;
  }

  cacheSet(key, { verdict, reason });
  if (verdict === "deny") return emit(decision("deny", reason));
  if (verdict === "ask") return emit(decision("ask", reason));
  return emit(PASS(reason));
}

main().catch(() => emit(null));
