// Offline tests for the hook processes. Only the paths that return before any
// API call are exercised, so these run with no key and no network.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

const PRE = join(__dirname, "../hooks/jev-pretooluse.cjs");
const INTAKE = join(__dirname, "../hooks/jev-intake.cjs");

function run(script, payload, env = {}) {
  const out = execFileSync("node", [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
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

test("PreToolUse asks rather than fails open when the API is down on a destructive call", () => {
  // No key => fallback. A destructive-looking call must still surface.
  const r = run(
    PRE,
    { tool_name: "Bash", tool_input: { command: "psql $PROD -c 'DROP TABLE users'" }, cwd: "/tmp" },
    { TYPESAFE_API_KEY: "x", JEV_MODEL: "jev-latest", JEV_TOOL_TIMEOUT_MS: "1", JEV_TOOL_CACHE_TTL_MS: "0" },
  );
  assert.equal(decisionOf(r), "ask");
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /destructive pattern/);
});

test("intake skips slash commands, acknowledgements and fragments", () => {
  for (const prompt of ["/plan x", "!ls", "yes", "ok thanks", "hi"]) {
    assert.equal(run(INTAKE, { prompt, cwd: "/tmp" }, { JEV_HOOKS_DISABLE: "0" }), null, prompt);
  }
});

test("intake never blocks the turn", () => {
  const r = run(INTAKE, { prompt: "drop the production users table now", cwd: "/tmp" }, { TYPESAFE_API_KEY: "" });
  // With no key it falls back and stays silent; either way it must not deny.
  assert.ok(r === null || !r.hookSpecificOutput.permissionDecision);
});
