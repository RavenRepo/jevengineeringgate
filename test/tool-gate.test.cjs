// Offline tests for the deterministic tool classifier and its cache.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { classifyTool, cacheKey, cacheGet, cacheSet } = require("../lib/tool-gate.cjs");

const v = (toolName, toolInput, cwd = "/w") => classifyTool({ toolName, toolInput, cwd }).verdict;

test("read-only tools never reach the model", () => {
  for (const t of ["Read", "Glob", "Grep", "WebSearch", "TodoWrite"]) {
    assert.equal(v(t, {}), "allow", t);
  }
});

test("read-only shell commands are recognized, including compound ones", () => {
  for (const c of [
    "ls -la",
    "ls -la && git status",
    "grep -rn foo src/ 2>/dev/null | head -20",
    "cat package.json | jq .name",
    "git log --oneline -n 5",
    "sed -n '1,5p' file.txt",
    "git config --get user.email",
    "node --version",
  ]) {
    assert.equal(v("Bash", { command: c }), "allow", c);
  }
});

test("writing forms of read-shaped commands are gated", () => {
  for (const c of [
    "sed -i 's/a/b/' f.txt",
    "git config user.email x@y",
    "git tag v1.0.0",
    "npm install",
    "npm test",
    "node script.js",
    "tee out.txt",
    "awk 'BEGIN{system(\"rm x\")}'",
  ]) {
    assert.equal(v("Bash", { command: c }), "gate", c);
  }
});

test("shell features that hide intent are gated, not allowed", () => {
  for (const c of [
    "echo hi > /etc/passwd",
    "ls $(rm -rf build)",
    "cat f | sh",
    "sudo ls",
    "eval \"$CMD\"",
    "ls `whoami`",
  ]) {
    assert.equal(v("Bash", { command: c }), "gate", c);
  }
});

test("benign stderr redirects do not disqualify a read", () => {
  assert.equal(v("Bash", { command: "git status 2>/dev/null" }), "allow");
  assert.equal(v("Bash", { command: "ls 2>&1" }), "allow");
});

test("catastrophes are denied deterministically, never referred to the model", () => {
  for (const c of [
    "rm -rf /",
    "rm -rf ~",
    "rm -rf $HOME",
    "ls && rm -rf /",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    "shutdown -h now",
  ]) {
    assert.equal(v("Bash", { command: c }), "deny", c);
  }
});

test("a dangerous segment poisons an otherwise read-only chain", () => {
  assert.equal(v("Bash", { command: "ls -la && npm publish" }), "gate");
  assert.equal(v("Bash", { command: "cat a.txt; rm -rf /" }), "deny");
});

test("ordinary in-tree edits pass; sensitive and out-of-tree edits gate", () => {
  assert.equal(v("Write", { file_path: "/w/src/a.ts" }, "/w"), "allow");
  assert.equal(v("Edit", { file_path: "/w/lib/b.js" }, "/w"), "allow");
  assert.equal(v("Write", { file_path: "/w/.env" }, "/w"), "gate");
  assert.equal(v("Write", { file_path: "/w/.github/workflows/ci.yml" }, "/w"), "gate");
  assert.equal(v("Write", { file_path: "/w/deploy/Caddyfile" }, "/w"), "gate");
  assert.equal(v("Write", { file_path: "/etc/hosts" }, "/w"), "gate");
  assert.equal(v("Write", { file_path: "/other/a.ts" }, "/w"), "gate");
  assert.equal(v("Write", {}, "/w"), "gate");
});

test("a path that escapes the workspace by traversal is still out of tree", () => {
  assert.equal(v("Write", { file_path: "/w/../outside/a.ts" }, "/w"), "gate");
});

test("a workspace-prefix lookalike is not treated as in-tree", () => {
  assert.equal(v("Write", { file_path: "/workspace-other/a.ts" }, "/workspace"), "gate");
});

test("MCP calls split on read vs write by name", () => {
  assert.equal(v("mcp__Neon__list_projects", {}), "allow");
  assert.equal(v("mcp__Neon__get_connection_string", {}), "allow");
  assert.equal(v("mcp__Neon__run_sql", {}), "gate");
  assert.equal(v("mcp__Neon__delete_branch", {}), "gate");
});

test("operator-protected patterns force a gate", () => {
  process.env.JEV_TOOL_PROTECTED = "Caddyfile,/srv/www";
  assert.equal(v("Bash", { command: "systemctl reload caddy && cat /etc/caddy/Caddyfile" }), "gate");
  assert.equal(v("Write", { file_path: "/srv/www/index.html" }, "/srv"), "gate");
  delete process.env.JEV_TOOL_PROTECTED;
});

test("an unrecognized tool gates rather than passing", () => {
  assert.equal(v("SomeFutureTool", {}), "gate");
  assert.equal(classifyTool({}).verdict, "gate");
});

test("cache round-trips and is keyed on the exact call", () => {
  const a = { toolName: "Bash", toolInput: { command: "npm test" }, cwd: "/w" };
  const b = { toolName: "Bash", toolInput: { command: "npm run build" }, cwd: "/w" };
  const ka = cacheKey(a);
  cacheSet(ka, { verdict: "ask", reason: "x" });
  assert.equal(cacheGet(ka).verdict, "ask");
  assert.equal(cacheGet(cacheKey(b)), null);
  assert.notEqual(ka, cacheKey({ ...a, cwd: "/other" }), "cwd must be part of the key");
});

test("an expired cache entry is a miss, not a stale allow", () => {
  const k = cacheKey({ toolName: "Bash", toolInput: { command: "expiry-probe" }, cwd: "/w" });
  process.env.JEV_TOOL_CACHE_TTL_MS = "0";
  delete require.cache[require.resolve("../lib/config.cjs")];
  delete require.cache[require.resolve("../lib/tool-gate.cjs")];
  const fresh = require("../lib/tool-gate.cjs");
  fresh.cacheSet(k, { verdict: "allow", reason: "x" });
  assert.equal(fresh.cacheGet(k), null);
  delete process.env.JEV_TOOL_CACHE_TTL_MS;
  delete require.cache[require.resolve("../lib/config.cjs")];
  delete require.cache[require.resolve("../lib/tool-gate.cjs")];
});

test("shell navigation does not send ordinary commands to the model", () => {
  // Omitting `cd` sent 85% of a real session's tool calls to Jev, at ~1s each.
  assert.equal(v("Bash", { command: "cd /repo && cat package.json" }), "allow");
  assert.equal(v("Bash", { command: "cd /repo && ls -la && git status" }), "allow");
  assert.equal(v("Bash", { command: "cd /repo && npm test" }), "gate");
});

test("a loop body is classified on its real command, not the loop keyword", () => {
  assert.equal(v("Bash", { command: "for f in a b; do cat $f; done" }), "allow");
  assert.equal(v("Bash", { command: "for f in a b; do rm -rf /; done" }), "deny");
  assert.equal(v("Bash", { command: "for f in a b; do npm publish; done" }), "gate");
});

test("the deny floor follows an interpreter argument", () => {
  assert.equal(v("Bash", { command: 'bash -c "rm -rf /"' }), "deny");
  assert.equal(v("Bash", { command: "sh -c 'rm -rf $HOME'" }), "deny");
});

test("mentioning a dangerous string is not running it", () => {
  // A deny that fires on a mention blocks grepping for the pattern, editing
  // this file, or writing a test about it -- and teaches people to disable it.
  assert.equal(v("Bash", { command: 'grep -rn "rm -rf /" lib/' }), "allow");
  assert.equal(v("Bash", { command: 'echo "never run rm -rf /"' }), "allow");
  assert.equal(v("Bash", { command: "rm -rf /" }), "deny", "the real thing still denies");
});

test("an env-var prefix does not hide the command head", () => {
  assert.equal(v("Bash", { command: "FOO=1 rm -rf /" }), "deny");
  assert.equal(v("Bash", { command: "FOO=1 ls -la" }), "allow");
});

test("a heredoc body is data, not commands", () => {
  // Writing a file that discusses a dangerous pattern must not be denied.
  const cmd = "cat > t.md <<'EOF'\nnever run rm -rf / in production\nEOF";
  assert.notEqual(v("Bash", { command: cmd }), "deny");
  // The redirect still gates it, because it writes.
  assert.equal(v("Bash", { command: cmd }), "gate");
});

test("the deny floor does not parse languages its patterns are not written for", () => {
  // `rm -rf /` inside a JS or Python string is data. Denying it blocks writing
  // tests about the gate. These still gate, so Jev sees them.
  assert.equal(v("Bash", { command: `node -e 'const cases=["rm -rf /"]; console.log(cases)'` }), "gate");
  assert.equal(v("Bash", { command: `python3 -c 'print("rm -rf /")'` }), "gate");
  // Shell stays covered, because the patterns are shell syntax.
  assert.equal(v("Bash", { command: 'bash -c "rm -rf /"' }), "deny");
});

test("operators inside a quoted string are not segment boundaries", () => {
  const { splitSegments } = require("../lib/tool-gate.cjs");
  assert.equal(splitSegments(`node -e 'const a=["x && y"]; f(a)'`).length, 1);
  assert.equal(splitSegments("ls && git status").length, 2);
  // The regression this fixes: a shell operator inside a JS string literal cut
  // the literal in half, and the remainder read as a bare `rm -rf /` command.
  assert.equal(v("Bash", { command: `node -e 'const c=[["ls && rm -rf /","deny"]]; console.log(c)'` }), "gate");
});

test("whole-command denies fire, and quoting one does not", () => {
  assert.equal(v("Bash", { command: "dd if=/dev/zero > /dev/sda" }), "deny");
  assert.equal(v("Bash", { command: ":(){ :|:& };:" }), "deny");
  // Mentioning the pattern gates rather than denies. It does not reach `allow`
  // because redirect detection is not quote-aware, and a conservative gate on a
  // command containing a stray `>` is a fine place to stop.
  assert.notEqual(v("Bash", { command: `echo "> /dev/sda"` }), "deny");
});
