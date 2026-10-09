// Offline tests for compaction: supersession anchors, candidate pairs and the
// drop rule, the last through an injected judge.
// Nothing here needs an engine to answer.
process.env.JEV_LOG_FILE = require("node:path").join(require("node:os").tmpdir(), `jev-compact-test-${process.pid}.jsonl`);
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { anchors, candidatePairs, filterEntries } = require("../lib/compact.cjs");

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

// A judge that answers from tables instead of a model. Relevance answers come
// from `relevance` by entry text (default 0.9); supersession answers from
// `supersedes` by "older text => later text" (default 0.1). Every request is
// recorded.
function fakeJudge({ relevance = {}, supersedes = {}, fail = [] } = {}) {
  const calls = [];
  const judge = async ({ state, questions, downstream }) => {
    calls.push({ downstream, n: Object.keys(questions).length, entries: state.entries.length });
    if (fail.includes(downstream)) return { results: {}, fallback: true };
    const results = {};
    for (const [k, q] of Object.entries(questions)) {
      const [a, b] = q.instructions.compare.map((ref) => ref.match(/\[(\d+)\]/)?.[1]);
      const noul = downstream === "compaction-filter"
        ? relevance[state.entries[b]] ?? 0.9
        : supersedes[`${state.entries[a]} => ${state.entries[b]}`] ?? 0.1;
      results[k] = { noul };
    }
    return { results, fallback: false };
  };
  return { judge, calls };
}

const ids = (list) => list.map((e) => e.id);

test("a later entry that supersedes an older one drops it, and says which", async () => {
  const entries = ["Status #5: pending review", "Rule: never deploy on Fridays", "Status #5: merged"];
  const { judge, calls } = fakeJudge({ supersedes: { "Status #5: pending review => Status #5: merged": 0.95 } });
  const res = await filterEntries({ goal: "ship #5", entries, judge });
  assert.deepEqual(ids(res.kept), ["1", "2"]);
  assert.equal(res.dropped.length, 1);
  assert.deepEqual({ ...res.dropped[0], p: undefined }, { id: "0", text: entries[0], p: undefined, failed: false, reason: "superseded", supersededBy: "2", ps: 0.95 });
  assert.equal(res.stats.superseded, 1);
  assert.equal(res.stats.pairsJudged, 1);
  assert.equal(res.stats.supersedeRequests, 1);
  assert.equal(res.stats.requests, 1, "requests stays the relevance count");
  const pairCall = calls.find((c) => c.downstream === "compaction-supersede");
  assert.equal(pairCall.entries, 2, "a supersession request holds only its chunk's texts");
});

test("supersession is transitive: i -> j -> k drops i and j when k survives", async () => {
  const entries = ["Status #5: pending", "Status #5: in review", "Status #5: merged"];
  const { judge } = fakeJudge({
    supersedes: {
      "Status #5: pending => Status #5: in review": 0.9,
      "Status #5: in review => Status #5: merged": 0.9,
    },
  });
  const res = await filterEntries({ goal: "ship #5", entries, judge });
  assert.deepEqual(ids(res.kept), ["2"]);
  assert.deepEqual(res.dropped.map((e) => [e.id, e.reason, e.supersededBy]), [["0", "superseded", "1"], ["1", "superseded", "2"]]);
});

test("an entry stays when no superseder survives", async () => {
  const entries = ["Status #5: pending", "Status #5: in review", "Status #5: merged, lunch was nice"];
  const { judge } = fakeJudge({
    relevance: { "Status #5: merged, lunch was nice": 0.1 },
    supersedes: {
      "Status #5: pending => Status #5: in review": 0.9,
      "Status #5: in review => Status #5: merged, lunch was nice": 0.9,
    },
  });
  const res = await filterEntries({ goal: "ship #5", entries, judge });
  // k is irrelevant, so j has no surviving superseder and stays; i is then
  // superseded by j, which survives.
  assert.deepEqual(ids(res.kept), ["1"]);
  assert.deepEqual(res.dropped.map((e) => [e.id, e.reason, e.supersededBy]), [["0", "superseded", "1"], ["2", "irrelevant", undefined]]);

  const alone = fakeJudge({
    relevance: { "Status #5: in review": 0.1 },
    supersedes: { "Status #5: pending => Status #5: in review": 0.9 },
  });
  const res2 = await filterEntries({ goal: "ship #5", entries: entries.slice(0, 2), judge: alone.judge });
  assert.deepEqual(ids(res2.kept), ["0"], "the only superseder was dropped as irrelevant, so the older entry stays");
});

test("an answer below supersedeThreshold drops nothing", async () => {
  const entries = ["Status #5: pending", "Status #5: merged"];
  const { judge } = fakeJudge({ supersedes: { "Status #5: pending => Status #5: merged": 0.65 } });
  assert.equal((await filterEntries({ goal: "g", entries, judge, supersedeThreshold: 0.7 })).dropped.length, 0);
  assert.equal((await filterEntries({ goal: "g", entries, judge, supersedeThreshold: 0.6 })).dropped.length, 1);
});

test("pinned entries are never superseded, but can supersede", async () => {
  const entries = ["Status #5: pending", "Status #5: in review", "Status #5: merged"];
  const supersedes = {
    "Status #5: pending => Status #5: in review": 0.9,
    "Status #5: in review => Status #5: merged": 0.9,
  };
  const first = fakeJudge({ supersedes });
  const res = await filterEntries({ goal: "g", entries, judge: first.judge, pinFirst: 1 });
  assert.deepEqual(ids(res.kept), ["0", "2"]);
  assert.equal(res.stats.pairsJudged, 1, "a pinned entry is not asked about as the older one");
  const last = fakeJudge({ supersedes });
  const res2 = await filterEntries({ goal: "g", entries, judge: last.judge, pinLast: 1 });
  assert.deepEqual(ids(res2.kept), ["2"], "a pinned later entry supersedes");
});

test("a failed supersession request keeps everything it was asked about", async () => {
  const entries = ["Status #5: pending", "Status #5: merged"];
  const { judge } = fakeJudge({ supersedes: { "Status #5: pending => Status #5: merged": 0.99 }, fail: ["compaction-supersede"] });
  const res = await filterEntries({ goal: "g", entries, judge });
  assert.equal(res.dropped.length, 0);
  assert.equal(res.stats.failedSupersedeRequests, 1);
  const both = fakeJudge({ fail: ["compaction-filter", "compaction-supersede"] });
  const res2 = await filterEntries({ goal: "g", entries, judge: both.judge });
  assert.deepEqual(ids(res2.kept), ["0", "1"]);
});

test("supersede: false is the relevance filter alone", async () => {
  const entries = ["Status #5: pending", "lunch was pasta", "Status #5: merged", "Rule: tests before merge"];
  const opts = { relevance: { "lunch was pasta": 0.1 }, supersedes: { "Status #5: pending => Status #5: merged": 0.99 } };
  const off = fakeJudge(opts);
  const res = await filterEntries({ goal: "g", entries, judge: off.judge, supersede: false });
  assert.ok(off.calls.every((c) => c.downstream === "compaction-filter"), "no supersession request is made");
  assert.deepEqual(res.kept.map((e) => [e.id, e.p]), [["0", 0.9], ["2", 0.9], ["3", 0.9]]);
  assert.deepEqual(res.dropped.map((e) => [e.id, e.p, e.reason]), [["1", 0.1, "irrelevant"]]);
  assert.deepEqual([res.stats.superseded, res.stats.pairsJudged, res.stats.supersedeRequests, res.stats.requests], [0, 0, 0, 1]);
  const on = fakeJudge(opts);
  assert.deepEqual(ids((await filterEntries({ goal: "g", entries, judge: on.judge })).kept), ["2", "3"]);
});
