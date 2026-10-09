// Offline tests for compaction: supersession anchors and candidate pairs.
// Nothing here needs an engine to answer.
process.env.JEV_LOG_FILE = require("node:path").join(require("node:os").tmpdir(), `jev-compact-test-${process.pid}.jsonl`);
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { anchors, candidatePairs } = require("../lib/compact.cjs");

test("anchors name the things an entry is about, normalised so references match", () => {
  assert.deepEqual(anchors("ADR 0030: reserved for the cache layer"), ["adr:30", "label:adr 0030"]);
  assert.ok(anchors("ADR-30 decided").includes("adr:30"));
  assert.ok(anchors("see adr30").includes("adr:30"));
  const pr = anchors("Waiting on PR 41 and pull/42, then #43");
  for (const a of ["#41", "#42", "#43"]) assert.ok(pr.includes(a), a);
  assert.ok(anchors("merged as 3f9c2ab").includes("sha:3f9c2ab"));
  assert.ok(!anchors("the build was defaced").some((a) => a.startsWith("sha:")), "a hex-looking word is not a SHA");
  assert.ok(!anchors("on 20261009").some((a) => a.startsWith("sha:")), "digits alone are not a SHA");
  const t = anchors("Run `npm test` in src/lib/cache.ts and README.md on v1.2.3 for task_c883e33feac0 and ctx_9f2");
  for (const a of ["code:npm test", "path:src/lib/cache.ts", "path:README.md", "version:1.2.3", "id:task_c883e33feac0", "id:ctx_9f2"]) {
    assert.ok(t.includes(a), a);
  }
  assert.ok(!anchors("scored 0.71 on 2026-10-09").some((a) => a.startsWith("version:") || a.startsWith("id:")), "a decimal or a date is not an anchor");
  assert.ok(anchors("**Status** all green").includes("label:status"));
  assert.ok(anchors("Status: all green").includes("label:status"));
  assert.deepEqual(anchors("the weather is nice today"), []);
});

test("candidate pairs run from an older entry to a later one only", () => {
  const pairs = candidatePairs(["ADR 0030: reserved for the cache", "unrelated chatter about lunch", "ADR 30 done: cache uses LRU"]);
  assert.deepEqual(pairs.map((p) => [p.i, p.j]), [[0, 2]]);
  assert.deepEqual(pairs[0].shared, ["adr:30"]);
});

test("meta.ts sets the order when every entry has one", () => {
  const entries = [
    { id: "a", text: "ADR 30 done: cache uses LRU", meta: { ts: "2026-10-02T00:00:00Z" } },
    { id: "b", text: "ADR 0030: reserved for the cache", meta: { ts: "2026-10-01T00:00:00Z" } },
  ];
  assert.deepEqual(candidatePairs(entries).map((p) => [p.i, p.j]), [[1, 0]]);
  // One entry without a timestamp: index order.
  const partial = [entries[0], { id: "b", text: entries[1].text }];
  assert.deepEqual(candidatePairs(partial).map((p) => [p.i, p.j]), [[0, 1]]);
});

test("candidate pairs are capped per entry, best overlap first, then the most recent", () => {
  const entries = [
    "Status of #7: pending review in src/a.ts",
    "#7 noted",
    "#7 noted again",
    "#7 noted a third time",
    "Status of #7: merged, src/a.ts shipped",
    "#7 noted once more",
  ];
  const pairs = candidatePairs(entries, { maxPerEntry: 2 }).filter((p) => p.i === 0);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].j, 4, "the most shared anchors rank first");
  assert.equal(pairs[1].j, 5, "ties go to the most recent");
  assert.ok(candidatePairs(entries).filter((p) => p.i === 0).length === 4, "the default cap is 4");
});

test("unrelated entries make no pairs; shared vocabulary alone can", () => {
  assert.deepEqual(candidatePairs(["the cache layer uses redis", "lunch was pasta today", "deploy the frontend tomorrow"]), []);
  const pairs = candidatePairs(["release checklist signed staging smoke tests passing", "release checklist signed staging smoke tests failing"]);
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0].jaccard >= 0.35);
  assert.deepEqual(pairs[0].shared, []);
});
