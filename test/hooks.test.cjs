// Offline tests for the hook processes. Only the paths that return before any
// API call are exercised, so these run with no key and no network.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

const PRE = join(__dirname, "../hooks/jev-pretooluse.cjs");
const INTAKE = join(__dirname, "../hooks/jev-intake.cjs");

// Tests write to a throwaway log, never the real decision log: a forced
// 1 ms timeout here once read as fourteen production outages.
const LOG = join(require("node:os").tmpdir(), `jev-hooks-test-${process.pid}.jsonl`);

function run(script, payload, env = {}) {
  const out = execFileSync("node", [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, JEV_LOG_FILE: LOG, JEV_TOOL_CACHE_FILE: `${LOG}.cache`, JEV_FILTER_DIR: `${LOG}.filtered`, ...env },
    timeout: 15000,
  });
  return out.trim() ? JSON.parse(out) : null;
}
const decisionOf = (r) => (r && r.hookSpecificOutput ? r.hookSpecificOutput.permissionDecision : null);

test("PreToolUse denies a deterministic catastrophe without a key", () => {
  const r = run(PRE, { tool_name: "Bash", tool_input: { command: "rm -rf /" }, cwd: "/tmp" }, { TYPESAFE_API_KEY: "" });
  assert.equal(decisionOf(r), "deny");
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /deterministic block/);
});

test("PreToolUse stays silent on a read-only call, leaving the normal prompt intact", () => {
  // Silence matters: emitting "allow" here would bypass Claude Code's own
  // permission flow and make the session more permissive than no gate at all.
  assert.equal(run(PRE, { tool_name: "Read", tool_input: { file_path: "/tmp/a" }, cwd: "/tmp" }), null);
  assert.equal(run(PRE, { tool_name: "Bash", tool_input: { command: "ls -la" }, cwd: "/tmp" }), null);
});

test("PreToolUse opts into allow only when asked", () => {
  const r = run(PRE, { tool_name: "Read", tool_input: { file_path: "/tmp/a" }, cwd: "/tmp" }, { JEV_TOOL_AUTO_ALLOW: "1" });
  assert.equal(decisionOf(r), "allow");
});

test("the kill switch disables the gate entirely", () => {
  assert.equal(
    run(PRE, { tool_name: "Bash", tool_input: { command: "rm -rf /" }, cwd: "/tmp" }, { JEV_HOOKS_DISABLE: "1" }),
    null,
  );
});

test("PreToolUse survives malformed input rather than blocking the session", () => {
  const out = execFileSync("node", [PRE], { input: "not json", encoding: "utf8", timeout: 15000 });
  assert.equal(out.trim(), "");
  assert.equal(run(PRE, {}), null);
});

test("PreToolUse never prompts the person by default: a risky call with the API down is passed to the agent as context", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "psql $PROD -c 'DROP TABLE users'" }, cwd: "/tmp" };
  const env = { TYPESAFE_API_KEY: "x", JEV_MODEL: "jev-latest", JEV_TOOL_TIMEOUT_MS: "1", JEV_TOOL_CACHE_TTL_MS: "0" };
  const r = run(PRE, payload, env);
  assert.equal(decisionOf(r) ?? null, null, "no ask: the agent decides");
  assert.match(r.hookSpecificOutput.additionalContext, /destructive pattern/);
  assert.equal(decisionOf(run(PRE, payload, { ...env, JEV_TOOL_ASK: "1" })), "ask", "JEV_TOOL_ASK=1 restores prompting");
});

test("intake skips slash commands, acknowledgements and fragments", () => {
  for (const prompt of ["/plan x", "!ls", "yes", "ok thanks", "hi"]) {
    assert.equal(run(INTAKE, { prompt, cwd: "/tmp" }, { JEV_HOOKS_DISABLE: "0" }), null, prompt);
  }
});

test("intake stays silent on automated notices", () => {
  for (const prompt of ["<task-notification>\n<task-id>a1</task-id>\n<status>completed</status> security review finished", "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT] the agent finished", "[SYSTEM NOTIFICATION - NOT USER INPUT] background task done"]) {
    assert.equal(run(INTAKE, { prompt, cwd: "/tmp" }, { TYPESAFE_API_KEY: "" }), null, prompt.slice(0, 30));
  }
});

test("intake never blocks the turn", () => {
  const r = run(INTAKE, { prompt: "drop the production users table now", cwd: "/tmp" }, { TYPESAFE_API_KEY: "" });
  // With no key it falls back and stays silent; either way it must not deny.
  assert.ok(r === null || !r.hookSpecificOutput.permissionDecision);
});
