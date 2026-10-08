// Offline tests for the output filter, the PostToolUse eligibility rules and
// agent routing's guards. Nothing here needs an engine to answer.
// Before anything reads config: saved outputs go to a temp folder, and a filter
// that never answers is given up on quickly.
process.env.JEV_FILTER_DIR = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "jev-filter-"));
process.env.JEV_FILTER_TIMEOUT_MS = "200";
process.env.JEV_LOG_FILE = require("node:path").join(require("node:os").tmpdir(), `jev-filter-test-${process.pid}.jsonl`);
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { splitBlocks, filterOutput, FLOOR, PASSING } = require("../lib/filter.cjs");
const { eligible } = require("../hooks/jev-posttooluse.cjs");
const { routable, routeAgent, sessionModel, rankOf } = require("../lib/route-agent.cjs");
const { holdsSecret, scrubCommand } = require("../lib/secrets.cjs");
const { respond } = require("../hooks/jev-posttooluse.cjs");
const { mkdtempSync, writeFileSync, readFileSync, statSync } = require("node:fs");
const { loadKey, ENGINES } = require("../lib/decision-engine.cjs");

test("blocks are cut at blank lines, at twelve lines, and where passes meet anything else", () => {
  const text = ["a", "b", "", ...Array.from({ length: 14 }, (_, i) => `l${i}`), "✔ one", "✔ two", "✖ three", "✔ four"].join("\n");
  const blocks = splitBlocks(text);
  assert.deepEqual(blocks.map((b) => [b.start, b.end]), [[1, 2], [4, 15], [16, 17], [18, 19], [20, 20], [21, 21]]);
  assert.equal(blocks[4].text, "✖ three", "a failure never shares a block with the passes around it");
});

test("the floor reads failures and file locations, not timestamps or passing test names", () => {
  assert.ok(FLOOR.test("AssertionError: expected 'sig_ok'"));
  assert.ok(FLOOR.test("    at verify (src/billing/webhooks.ts:212:9)"));
  assert.ok(!FLOOR.test("2026-10-08T14:18:44Z INFO http GET /health 200"), "a timestamp is not a file location");
  assert.ok(!FLOOR.test("npm warn deprecated inflight@1.0.6"), "warnings are left to the model");
  assert.ok(PASSING.test("  ✔ a batch that fails on every engine (2ms)"));
});

test("a passing run is cut to its summary without asking an engine", async () => {
  const text = ["▶ suite", ...Array.from({ length: 40 }, (_, i) => `  ✔ passes case ${i} (1ms)`), "ℹ tests 40", "ℹ pass 40", "ℹ fail 0"].join("\n");
  const res = await filterOutput({ text, goal: "run the tests" });
  assert.equal(res.stats.requests, 0);
  assert.equal(res.text, ["▶ suite", "[jev-filter: lines 2-41 dropped (40 non-blank)]", "ℹ tests 40", "ℹ pass 40", "ℹ fail 0"].join("\n"));
});

test("a single success line is not mistaken for a list of passes", async () => {
  const text = ["vite v8 building...", "", "✓ built in 261ms", "", "done"].join("\n");
  const res = await filterOutput({ text, goal: "build" });
  assert.ok(res.text.includes("✓ built in 261ms"));
});

test("only long output of a command that runs something is filtered", () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const call = (command, stdout = long, extra = {}) => ({ tool_name: "Bash", tool_input: { command }, tool_response: { stdout, stderr: "", ...extra } });
  assert.equal(eligible(call("npm test")), null);
  assert.equal(eligible(call("cd app && pnpm build")), null);
  assert.equal(eligible(call("npm test", "ok")), "short");
  assert.equal(eligible(call("cat src/big.ts")), "reads or searches");
  assert.equal(eligible(call("git diff HEAD~3")), "reads or searches");
  assert.equal(eligible(call("ls -la")), "reads or searches");
  assert.equal(eligible(call("npm run build && cat dist/stats.txt")), "reads or searches", "a reader anywhere in the line keeps it whole");
  assert.equal(eligible(call("git grep -n docker")), "reads or searches");
  assert.equal(eligible(call("ls -R | grep next")), "reads or searches");
  assert.equal(eligible(call("git -C repo diff")), "reads or searches");
  assert.equal(eligible(call("CI=1 npm test")), null, "an env prefix is not the head");
  assert.equal(eligible(call("echo hi")), "not a runner");
  for (const command of ['node -e "console.log(1)"', "npm ls --all", "pip freeze", "kubectl get configmap app -o yaml", "docker ps", "cargo tree", "go list ./..."]) {
    assert.equal(eligible(call(command)), "reads or searches", command);
  }
  assert.equal(eligible(call("timeout 60 npm test")), null, "a wrapper is not the head");
  assert.equal(eligible(call("node --test test/")), null);
  assert.equal(eligible(call("JEV_FILTER=0 npm test")), "opted out in the command");
  assert.equal(eligible(call("npm test", long, { interrupted: true })), "interrupted or image");
  assert.equal(eligible({ tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: "text" }), "unknown output shape");
  assert.equal(eligible({ tool_name: "Read", tool_input: {}, tool_response: { stdout: long } }), "not Bash");
});

test("the PostToolUse hook stays silent on output it does not filter", () => {
  const out = execFileSync("node", [join(__dirname, "../hooks/jev-posttooluse.cjs")], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "a\nb" } }),
    encoding: "utf8",
    env: { ...process.env, JEV_LOG_FILE: join(tmpdir(), "jev-filter-test.jsonl") },
  });
  assert.equal(out, "");
});

test("agent routing never overrides a chosen model, a fork, or an agent type with its own model", async () => {
  assert.equal(routable({ prompt: "find files", model: "opus" }), "the caller chose a model");
  assert.equal(routable({ prompt: "x", subagent_type: "fork" }), "a fork runs on the parent's model");
  assert.match(routable({ prompt: "x", subagent_type: "oh-my-claudecode:architect" }), /keeps its own model/);
  // Explore and the plugin's explore and writer agents pin Haiku; setting Sonnet on them would be an upgrade.
  for (const type of ["Explore", "oh-my-claudecode:explore", "oh-my-claudecode:writer"]) assert.match(routable({ prompt: "x", subagent_type: type }), /keeps its own model/, type);
  assert.equal(routable({ prompt: "find files", subagent_type: "general-purpose" }), null);
  assert.equal(routable({ prompt: "find files" }), null, "no type means general-purpose");
  assert.deepEqual(await routeAgent({ prompt: "x", model: "haiku" }), { model: null, why: "the caller chose a model" });
});

test("each engine reads its own key variable", () => {
  assert.equal(ENGINES.liquid.keyVar, "LIQUID_API_KEY");
  const before = process.env.LIQUID_API_KEY;
  process.env.LIQUID_API_KEY = "liquid-test-key";
  try {
    assert.equal(loadKey("liquid"), "liquid-test-key");
    assert.notEqual(loadKey("jev"), "liquid-test-key");
  } finally {
    if (before === undefined) delete process.env.LIQUID_API_KEY;
    else process.env.LIQUID_API_KEY = before;
  }
});

test("output that holds a credential, or a command that prints secrets, is never filtered or sent", () => {
  const long = (extra) => Array.from({ length: 200 }, (_, i) => (i === 100 ? extra : `line ${i}`)).join("\n");
  const call = (command, stdout) => ({ tool_name: "Bash", tool_input: { command }, tool_response: { stdout, stderr: "" } });
  const aws = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
  assert.equal(eligible(call("npm test", long(`key ${aws}`))), "holds something shaped like a credential");
  assert.equal(eligible(call("npm test", long(["STRIPE", "SECRET", `KEY=${["sk", "live", "0123456789abcdef"].join("_")}`].join("_")))), "holds something shaped like a credential");
  for (const command of ["env | grep uv", "printenv", "kubectl get secret db -o yaml", "docker compose config", "docker inspect web", "terraform output"]) {
    assert.equal(eligible(call(command, long("x"))), "prints environment or secrets", command);
  }
  assert.ok(holdsSecret(`-----BEGIN OPENSSH ${["PRIVATE", "KEY"].join(" ")}-----`));
  // Shapes put together here so this file never holds a credential as written.
  for (const shape of [
    ["postgresql://neondb_owner:", "npg_abc123@ep-x.neon.tech/neondb"].join(""),
    ["DATABASE_URL=postgres://u:", "pass@db:5432/app"].join(""),
    ["Authorization: Bearer ", "eyabcdefghijklmnopqrstuvwx"].join(""),
    ["sk_", "test_", "0123456789abcdefABCD"].join(""),
    ["whsec_", "0123456789abcdefABCD"].join(""),
    ["npm_", "a".repeat(36)].join(""),
    ["AIza", "b".repeat(35)].join(""),
    ["napi_", "c".repeat(48)].join(""),
  ]) assert.ok(holdsSecret(shape), shape.slice(0, 12));
  assert.ok(!holdsSecret("GET https://registry.npmjs.org/react 200"), "a URL without a password is not a secret");
  assert.ok(!holdsSecret("ℹ pass 239\nℹ fail 0"));
  assert.equal(scrubCommand("API_KEY=abc123 FOO='x y' npm test"), "API_KEY=[redacted] FOO=[redacted] npm test");
});

test("the floor keeps a failure's values, diff, code frame and traceback even when the model scores them low", async () => {
  const low = async ({ chunk }) => ({ scores: chunk.map(() => 0.1), engine: "stub" });
  const noise = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join("\n");
  const cases = {
    jest: [noise(30, "PASS src/a.test.ts"), "", "FAIL src/sum.test.ts", "  ● sums two numbers", "", "    expect(received).toBe(expected) // Object.is equality", "", "    Expected: 4", "    Received: 3", "", "      10 | test('sums', () => {", "    > 11 |   expect(sum(1, 2)).toBe(4);", "         |                     ^", "", noise(20, "info"), "", "Tests: 1 failed, 30 passed"],
    node: [noise(30, "✔ ok"), "", "✖ adds (1ms)", "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", "", "  3 !== 4", "", noise(20, "info"), "", "ℹ fail 1"],
    pytest: [noise(30, "collected"), "", "Traceback (most recent call last):", ...Array.from({ length: 14 }, (_, i) => `  File "app/m${i}.py", line ${i + 1}, in f${i}`), "ZeroDivisionError: division by zero", "", noise(20, "info"), "", "1 failed in 0.2s"],
  };
  const must = { jest: ["Expected: 4", "Received: 3", "> 11 |"], node: ["3 !== 4"], pytest: ['File "app/m9.py", line 10', "ZeroDivisionError"] };
  for (const [name, lines] of Object.entries(cases)) {
    const res = await filterOutput({ text: lines.join("\n"), goal: "run the tests and find the failure", score: low });
    for (const line of must[name]) assert.ok(res.text.includes(line), `${name}: lost ${line}`);
  }
});

test("the hook returns the output's own shape with the kept lines, a note, and the full output saved owner-only", async () => {
  const text = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n");
  const evt = { tool_name: "Bash", tool_input: { command: "TOKEN=abc npm test", description: "Run the tests" }, tool_response: { stdout: text, stderr: "warn: x", interrupted: false, isImage: false } };
  const res = await respond(evt, async () => ({ changed: true, text: "line 0\n[jev-filter: lines 2-120 dropped (119 non-blank)]", stats: { linesKept: 1, linesIn: 120 } }));
  const out = res.hookSpecificOutput;
  assert.equal(out.hookEventName, "PostToolUse");
  assert.deepEqual(Object.keys(out.updatedToolOutput), ["stdout", "stderr", "interrupted", "isImage"]);
  assert.equal(out.updatedToolOutput.stderr, "warn: x");
  const note = out.updatedToolOutput.stdout.split("\n").pop();
  assert.match(note, /^\[jev-filter\] kept 1 of 120 lines for: Run the tests — `TOKEN=\[redacted\] npm test`\. Full output: /);
  const saved = note.split("Full output: ")[1];
  assert.ok(saved.startsWith(process.env.JEV_FILTER_DIR), "saved where the config says, not in the real logs");
  assert.equal(readFileSync(saved, "utf8"), text);
  assert.equal(statSync(saved).mode & 0o777, 0o600);
  assert.equal(await respond(evt, async () => ({ changed: false })), null, "nothing dropped: the original output stands");
  assert.equal(await respond(evt, async () => new Promise(() => {})).catch(() => "threw"), null, "a filter that never answers times out and leaves the output");
});

test("routing reads the session's model and never sets one at or above it", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-route-"));
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, ['{"message":{"model":"claude-sonnet-5-5"}}', '{"message":{"model":"claude-opus-5-5"}}', '{"isSidechain":true,"message":{"model":"claude-haiku-5-5"}}'].join("\n"));
  assert.equal(sessionModel(transcript), "claude-opus-5-5", "the main thread's last entry wins; a subagent's does not count");
  assert.equal(sessionModel(join(dir, "missing.jsonl")), null);
  assert.deepEqual([rankOf("claude-haiku-5-5"), rankOf("sonnet"), rankOf("claude-opus-5-5"), rankOf("claude-fable-5-1"), rankOf("x")], [0, 1, 2, 3, null]);
});

test("routing only ever goes down, at the margins, with the session's model as the ceiling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-route-"));
  const session = (model) => {
    const path = join(dir, `${model}.jsonl`);
    writeFileSync(path, `{"message":{"model":"claude-${model}-5-5"}}\n`);
    return path;
  };
  const scored = (score, confidence = 0.95) => async () => ({ fallback: false, results: { level: { decision: score, confidence } } });
  const route = (score, transcriptPath, confidence) => routeAgent({ prompt: "task", subagent_type: "general-purpose" }, { transcriptPath, ask: scored(score, confidence) });
  assert.equal((await route(0.34, session("opus"))).model, "haiku");
  assert.equal((await route(0.35, session("opus"))).model, "sonnet", "0.35 is no longer a lookup");
  assert.equal((await route(1.19, session("opus"))).model, "sonnet");
  assert.equal((await route(1.2, session("opus"))).model, null, "1.2 stays on the session model");
  assert.equal((await route(1.0, session("sonnet"))).model, null, "sonnet on a sonnet session is not cheaper");
  assert.equal((await route(0.1, session("sonnet"))).model, "haiku");
  assert.equal((await route(1.0, session("haiku"))).model, null, "never above a haiku session");
  assert.equal((await route(1.0, undefined)).model, null, "unknown session: only haiku");
  assert.equal((await route(0.1, undefined)).model, "haiku");
  assert.equal((await route(0.1, session("opus"), 0.8)).model, null, "below the auto threshold nothing is set");
  const secret = await routeAgent({ prompt: "use key", subagent_type: "general-purpose" }, { ask: scored(0.1), holdsSecret: () => true });
  assert.match(secret.why, /credential/);
});
