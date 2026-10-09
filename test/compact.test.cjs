// Offline tests for compaction: supersession anchors, candidate pairs and the
// drop rule, the last through an injected judge.
// Nothing here needs an engine to answer.
process.env.JEV_LOG_FILE = require("node:path").join(require("node:os").tmpdir(), `jev-compact-test-${process.pid}.jsonl`);
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { anchors, candidatePairs, filterEntries } = require("../lib/compact.cjs");

test("anchors name the things an entry is about, normalised so references match", () => {
  assert.deepEqual(anchors("ADR 0030: reserved for the cache layer"), ["adr:30", "label:adr 0030", "lead:adr", "lead:adr 0030", "lead:adr 0030 reserved", "num:30"]);
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

test("list markers are ignored, and ids, dates, versions and leading keywords are anchors", () => {
  for (const marker of ["- ", "* ", "1. ", "  - "]) {
    assert.ok(anchors(`${marker}**Status:** all green`).includes("label:status"), marker);
    assert.ok(anchors(`${marker}Status: all green`).includes("label:status"), marker);
  }
  const bare = anchors("accept 0027/0030 and migration 0042 on 2026-10-09");
  for (const a of ["num:27", "num:30", "num:42", "date:2026-10-09"]) assert.ok(bare.includes(a), a);
  assert.ok(anchors("ADR 0027 accepted").includes("num:27"), "an ADR number meets its bare form");
  assert.ok(!anchors("took 214 ms, 500 users, in 2026").some((a) => a.startsWith("num:")), "plain counts and years are not ids");
  const pkg = anchors("pin queue-client@4.2.1 and @scope/tool@2.0.0, merged @60d0183");
  for (const a of ["pkg:queue-client@4.2.1", "pkg:@scope/tool@2.0.0", "sha:60d0183"]) assert.ok(pkg.includes(a), a);
  assert.ok(anchors("- STATUS end of day: all green").includes("lead:status"));
  const ready = anchors("READY for review: #49");
  for (const a of ["lead:ready", "lead:ready for", "lead:ready for review"]) assert.ok(ready.includes(a), a);
  assert.ok(anchors("**Pending docs items:** a, b").includes("lead:pending docs items"));
  assert.ok(!anchors("Ready for review").some((a) => a.startsWith("lead:")), "an ordinary capital is not a keyword run");
});

test("slash words are not paths; real paths are", () => {
  assert.ok(!anchors("yes and/or no, pending/merged").some((a) => a.startsWith("path:")));
  const paths = anchors("see docs/adr/0030-y.md, ./run.sh, ~/notes and src/a/b");
  for (const a of ["path:docs/adr/0030-y.md", "path:./run.sh", "path:~/notes", "path:src/a/b"]) assert.ok(paths.includes(a), a);
});

test("candidate pairs run from an older entry to a later one only", () => {
  const pairs = candidatePairs(["ADR 0030: reserved for the cache", "unrelated chatter about lunch", "ADR 30 done: cache uses LRU"], { order: "chronological" });
  assert.deepEqual(pairs.map((p) => [p.i, p.j]), [[0, 2]]);
  assert.deepEqual(pairs[0].shared, ["adr:30", "lead:adr", "num:30"]);
});

test("meta.ts sets the order when every entry has one", () => {
  const entries = [
    { id: "a", text: "ADR 30 done: cache uses LRU", meta: { ts: "2026-10-02T00:00:00Z" } },
    { id: "b", text: "ADR 0030: reserved for the cache", meta: { ts: "2026-10-01T00:00:00Z" } },
  ];
  assert.deepEqual(candidatePairs(entries).map((p) => [p.i, p.j]), [[1, 0]], "meta.ts on every entry: chronological by default");
  // One entry without a timestamp: index order when asked for chronological,
  // and unordered by default.
  const partial = [entries[0], { id: "b", text: entries[1].text }];
  assert.deepEqual(candidatePairs(partial, { order: "chronological" }).map((p) => [p.i, p.j]), [[0, 1]]);
  assert.deepEqual(candidatePairs(partial).map((p) => [p.i, p.j, p.both]), [[0, 1, true]]);
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
  const pairs = candidatePairs(entries, { maxPerEntry: 2, order: "chronological" }).filter((p) => p.i === 0);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].j, 4, "the most shared anchors rank first");
  assert.equal(pairs[1].j, 5, "ties go to the most recent");
  assert.ok(candidatePairs(entries, { order: "chronological" }).filter((p) => p.i === 0).length === 4, "the default cap is 4");
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
    calls.push({ downstream, n: Object.keys(questions).length, entries: Object.keys(state.entries).length, keys: Object.keys(state.entries) });
    if (fail.includes(downstream)) return { results: {}, fallback: true };
    const results = {};
    for (const [k, q] of Object.entries(questions)) {
      // Relevance compares the goal with the entry's text; supersession
      // compares two keys of state.entries.
      const noul = downstream === "compaction-filter"
        ? relevance[q.instructions.compare[1]] ?? 0.9
        : supersedes[q.instructions.compare.map((ref) => state.entries[ref.match(/entries\.(\w+)/)[1]]).join(" => ")] ?? 0.1;
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
  const res = await filterEntries({ goal: "ship #5", entries, judge, order: "chronological", allPairsUpTo: 0 });
  assert.deepEqual(ids(res.kept), ["1", "2"]);
  assert.equal(res.dropped.length, 1);
  assert.deepEqual({ ...res.dropped[0], p: undefined }, { id: "0", text: entries[0], p: undefined, failed: false, reason: "superseded", supersededBy: "2", ps: 0.95 });
  assert.equal(res.stats.superseded, 1);
  assert.equal(res.stats.pairsJudged, 1);
  assert.equal(res.stats.supersedeRequests, 1);
  assert.equal(res.stats.requests, 1, "requests stays the relevance count");
  const pairCall = calls.find((c) => c.downstream === "compaction-supersede");
  assert.equal(pairCall.entries, 2, "a supersession request holds only its chunk's texts");
  assert.ok(pairCall.keys.every((k) => /^e[0-9a-f]{5}$/.test(k)), "keyed by hash, not by position");
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
  const res = await filterEntries({ goal: "g", entries, judge: first.judge, pinFirst: 1, order: "chronological" });
  assert.deepEqual(ids(res.kept), ["0", "2"]);
  assert.equal(res.stats.pairsJudged, 1, "a pinned entry is not asked about as the older one");
  const last = fakeJudge({ supersedes });
  const res2 = await filterEntries({ goal: "g", entries, judge: last.judge, pinLast: 1, order: "chronological" });
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

test("unordered pairs are listed once and asked in both directions", async () => {
  const entries = ["Status #5: merged", "Rule: never deploy on Fridays", "Status #5: pending review"];
  assert.deepEqual(candidatePairs(entries, { order: "unordered" }).map((p) => [p.i, p.j, p.both]), [[0, 2, true]]);
  const { judge, calls } = fakeJudge({ supersedes: { "Status #5: pending review => Status #5: merged": 0.9 } });
  const res = await filterEntries({ goal: "ship #5", entries, judge, allPairsUpTo: 0 });
  assert.equal(res.stats.order, "unordered", "no meta.ts: unordered by default");
  assert.deepEqual(ids(res.kept), ["0", "1"], "the newer entry listed first replaces the older one below it");
  assert.deepEqual(res.dropped.map((e) => [e.id, e.supersededBy, e.ps, e.psReverse]), [["2", "0", 0.9, 0.1]]);
  assert.equal(res.stats.pairsJudged, 1);
  assert.equal(calls.find((c) => c.downstream === "compaction-supersede").n, 2, "one pair, two questions");
});

test("unordered: when each entry says it replaces the other, both stay", async () => {
  const entries = ["Status #5: merged", "Status #5: pending review"];
  const { judge } = fakeJudge({
    supersedes: {
      "Status #5: pending review => Status #5: merged": 0.9,
      "Status #5: merged => Status #5: pending review": 0.6,
    },
  });
  const res = await filterEntries({ goal: "g", entries, judge, order: "unordered" });
  assert.deepEqual(ids(res.kept), ["0", "1"]);
  const high = fakeJudge({
    supersedes: {
      "Status #5: pending review => Status #5: merged": 0.9,
      "Status #5: merged => Status #5: pending review": 0.49,
    },
  });
  assert.deepEqual(ids((await filterEntries({ goal: "g", entries, judge: high.judge, order: "unordered" })).kept), ["0"], "a reverse answer below 0.5 lets one side go");
});

test("unordered: transitive, the replacement must survive, and a cycle of three keeps all", async () => {
  const entries = ["Status #5: merged", "Status #5: in review", "Status #5: pending"];
  const chain = {
    "Status #5: pending => Status #5: in review": 0.9,
    "Status #5: in review => Status #5: merged": 0.9,
  };
  const t = fakeJudge({ supersedes: chain });
  const res = await filterEntries({ goal: "g", entries, judge: t.judge, order: "unordered" });
  assert.deepEqual(ids(res.kept), ["0"]);
  assert.deepEqual(res.dropped.map((e) => [e.id, e.supersededBy]), [["1", "0"], ["2", "1"]]);

  const gone = fakeJudge({ supersedes: chain, relevance: { "Status #5: merged": 0.1 } });
  const res2 = await filterEntries({ goal: "g", entries, judge: gone.judge, order: "unordered" });
  assert.deepEqual(ids(res2.kept), ["1"], "the top of the chain is irrelevant, so the middle stays and replaces the bottom");

  const cycle = fakeJudge({
    supersedes: {
      ...chain,
      "Status #5: merged => Status #5: pending": 0.9,
    },
  });
  const res3 = await filterEntries({ goal: "g", entries, judge: cycle.judge, order: "unordered" });
  assert.deepEqual(ids(res3.kept), ["0", "1", "2"]);
});

test("unordered: a pinned entry is still asked about, never dropped, and can replace", async () => {
  const entries = ["Status #5: pending", "Status #5: merged"];
  const { judge } = fakeJudge({ supersedes: { "Status #5: pending => Status #5: merged": 0.9 } });
  const res = await filterEntries({ goal: "g", entries, judge, order: "unordered", pinFirst: 1 });
  assert.deepEqual(ids(res.kept), ["0", "1"]);
  assert.equal(res.stats.pairsJudged, 1);
  const last = fakeJudge({ supersedes: { "Status #5: pending => Status #5: merged": 0.9 } });
  assert.deepEqual(ids((await filterEntries({ goal: "g", entries, judge: last.judge, order: "unordered", pinLast: 1 })).kept), ["1"]);
});

test("up to allPairsUpTo entries every pair is asked about, within maxPairs", async () => {
  const entries = ["Status #5: merged", "lunch was pasta", "Rule: never deploy on Fridays", "Status #5: pending review"];
  assert.equal(candidatePairs(entries, { order: "unordered" }).length, 1, "candidatePairs alone uses anchors");
  assert.equal(candidatePairs(entries, { order: "unordered", allPairsUpTo: 60 }).length, 6);
  assert.equal(candidatePairs(entries, { order: "chronological", allPairsUpTo: 60 }).length, 6);
  assert.ok(candidatePairs(entries, { order: "unordered", allPairsUpTo: 60 }).every((p) => p.both && p.i < p.j));
  assert.equal(candidatePairs(entries, { order: "unordered", allPairsUpTo: 3 }).length, 1, "more entries than allPairsUpTo: anchors");
  assert.equal(candidatePairs(entries, { order: "unordered", allPairsUpTo: 60, maxPairs: 5 }).length, 1, "every pair would pass maxPairs: anchors");

  const { judge, calls } = fakeJudge({ supersedes: { "Status #5: pending review => Status #5: merged": 0.9 } });
  assert.equal((await filterEntries({ goal: "g", entries, judge: fakeJudge().judge })).stats.pairsJudged, 1, "anchor pairs only by default");
  const res = await filterEntries({ goal: "g", entries, judge, allPairsUpTo: 60 });
  assert.equal(res.stats.pairsJudged, 6, "allPairsUpTo asks every pair of a short list");
  assert.equal(res.stats.supersedeRequests, 1);
  assert.equal(calls.find((c) => c.downstream === "compaction-supersede").n, 12);
  assert.deepEqual(ids(res.kept), ["0", "1", "2"]);

  const many = Array.from({ length: 61 }, (_, i) => `n${i} is x${i}`);
  assert.equal(candidatePairs(many, { order: "unordered", allPairsUpTo: 60 }).length, 0, "above 60, unrelated entries make no pairs");
});

test("jev-compact passes its flags through and prints what survives, offline", async () => {
  const { run, options } = require("../bin/jev-compact.cjs");
  const o = options(["--goal", "g", "--order", "chronological", "--all-pairs-up-to", "30", "--max-pairs", "100", "--supersede-threshold", "0.7"]);
  assert.deepEqual([o.order, o.allPairsUpTo, o.maxPairs, o.supersedeThreshold], ["chronological", 30, 100, 0.7]);
  const d = options(["--goal", "g"]);
  assert.deepEqual([d.order, d.allPairsUpTo, d.maxPairs, d.supersede], [undefined, 0, 2000, true]);
  assert.throws(() => options(["--goal", "g", "--order", "newest"]), /--order/);
  for (const bad of [["--supersede-threshold", "0,6"], ["--keep", "--json"], ["--keep", "abc"], ["--pin-first", "two"], ["--pin-last", ""], ["--max-pairs", "Infinity"], ["--all-pairs-up-to", "NaN"], ["--supersede-threshold"]]) {
    assert.throws(() => options(["--goal", "g", ...bad]), new RegExp(bad[0]), bad.join(" "));
  }

  const input = JSON.stringify(["Status #5: merged", "Rule: never deploy on Fridays", "lunch was pasta", "Status #5: pending review"]);
  const supersedes = { "Status #5: pending review => Status #5: merged": 0.9 };
  const lines = [], errs = [];
  const { judge, calls } = fakeJudge({ supersedes, relevance: { "lunch was pasta": 0.1 } });
  assert.equal(await run(["--goal", "ship #5"], { input, judge, out: (l) => lines.push(l), err: (l) => errs.push(l) }), 0);
  assert.deepEqual(lines, ["Status #5: merged", "Rule: never deploy on Fridays"]);
  assert.match(errs[0], /kept 2\/4 entries \(1 superseded\)/);
  assert.equal(calls.find((c) => c.downstream === "compaction-supersede").n, 2, "unordered by default: one anchor pair, both ways");

  const all = fakeJudge({ supersedes });
  const json = [];
  await run(["--goal", "g", "--json", "--all-pairs-up-to", "10", "--order", "unordered"], { input, judge: all.judge, out: (l) => json.push(l), err: () => {} });
  assert.equal(JSON.parse(json[0]).stats.pairsJudged, 6, "--all-pairs-up-to asks every pair");

  const off = fakeJudge({ supersedes });
  const kept = [];
  await run(["--goal", "g", "--no-supersede"], { input, judge: off.judge, out: (l) => kept.push(l), err: () => {} });
  assert.equal(kept.length, 4);
  assert.ok(off.calls.every((c) => c.downstream === "compaction-filter"));

  const usage = [];
  assert.equal(await run([], { input, judge, out: () => {}, err: (l) => usage.push(l) }), 2);
  assert.match(usage[0], /--all-pairs-up-to N\] \[--max-pairs N\]/);
});

test("a bad numeric flag prints the usage and exits 2 without asking anything", async () => {
  const { run } = require("../bin/jev-compact.cjs");
  const input = JSON.stringify(["Status #5: merged", "Status #5: pending review"]);
  for (const bad of [["--supersede-threshold", "0,6"], ["--keep", "--json"]]) {
    const { judge, calls } = fakeJudge();
    const errs = [];
    const out = [];
    assert.equal(await run(["--goal", "g", ...bad], { input, judge, out: (l) => out.push(l), err: (l) => errs.push(l) }), 2, bad.join(" "));
    assert.match(errs[0], new RegExp(bad[0]));
    assert.match(errs[1], /^Usage: jev-compact/);
    assert.deepEqual([out, calls], [[], []]);
  }
});

test("NaN answers keep everything, and a threshold below 0.5 or NaN is refused", async () => {
  const entries = ["Status #5: pending", "Status #5: merged"];
  const nanJudge = async ({ questions }) => ({ results: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: NaN }])), fallback: false });
  for (const order of ["unordered", "chronological"]) {
    const res = await filterEntries({ goal: "g", entries, judge: nanJudge, order });
    assert.deepEqual(ids(res.kept), ["0", "1"], order);
  }
  const { judge } = fakeJudge({ supersedes: { "Status #5: pending => Status #5: merged": 0.9 } });
  for (const t of [NaN, 0.49, 0, -1, "0,6"]) {
    await assert.rejects(() => filterEntries({ goal: "g", entries, judge, supersedeThreshold: t }), /at least 0.5/, String(t));
  }
});

test("entries sharing an id each come out exactly once, by position", async () => {
  const entries = [{ id: "a", text: "Status #5: pending" }, { id: "a", text: "lunch was pasta" }, { id: "b", text: "Status #5: merged" }];
  for (const supersede of [false, true]) {
    const { judge } = fakeJudge({ relevance: { "lunch was pasta": 0.1 }, supersedes: { "Status #5: pending => Status #5: merged": 0.9 } });
    const res = await filterEntries({ goal: "g", entries, judge, supersede });
    const out = [...res.kept, ...res.dropped].map((e) => e.text).sort();
    assert.deepEqual(out, entries.map((e) => e.text).sort(), `supersede ${supersede}`);
    assert.deepEqual(res.dropped.find((e) => e.text === "lunch was pasta").reason, "irrelevant");
    assert.equal(res.kept.find((e) => e.text === "Status #5: pending") === undefined, supersede);
  }
});

test("a relevance answer that is not a number counts as failed and keeps the entry", async () => {
  const entries = ["Rule: never deploy on Fridays", "lunch was pasta"];
  for (const bad of [NaN, "x", null, undefined]) {
    const judge = async ({ questions, downstream }) => ({
      results: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: downstream === "compaction-filter" ? bad : 0.1 }])),
      fallback: false,
    });
    const res = await filterEntries({ goal: "g", entries, judge });
    assert.deepEqual(ids(res.kept), ["0", "1"], String(bad));
    assert.equal(res.stats.failedChunks, 1, String(bad));
  }
});

test("an entry longer than MAX_ENTRY_CHARS is never dropped as superseded, but can supersede", async () => {
  const long = `Status #5: pending review. ${"detail ".repeat(200)}`;
  assert.ok(long.length > 1200);
  const short = "Status #5: merged";
  const cut = long.slice(0, 1200);
  for (const order of ["unordered", "chronological"]) {
    const { judge } = fakeJudge({ supersedes: { [`${cut} => ${short}`]: 0.95 } });
    const res = await filterEntries({ goal: "g", entries: [long, short], judge, order });
    assert.deepEqual(ids(res.kept), ["0", "1"], `${order}: the long entry stays`);
  }
  const { judge } = fakeJudge({ supersedes: { [`Status #5: pending => ${cut}`]: 0.95 } });
  const res = await filterEntries({ goal: "g", entries: ["Status #5: pending", long], judge, order: "chronological" });
  assert.deepEqual(res.dropped.map((e) => [e.id, e.supersededBy]), [["0", "1"]], "a long entry can still replace a short one");
});
