// Live replay of eval/compact-cases.json: for each supersede threshold, how
// many must-keep entries survived the supersession pass (recall, the safety
// number), how many must-drop entries it caught, and what it cost. A
// must-keep entry the relevance pass drops is listed apart: no supersede
// threshold changes it.
// Each request is asked once and its answers reused at every threshold, so the
// thresholds are compared on the same answers. Also reported, before any
// request: candidate recall, the share of the true pairs (`pairs` in each
// case) that candidate generation puts to the model at all; and after: the
// highest answer that any must-keep entry is out of date (the must-stay
// ceiling a threshold needs a margin over).
// The default threshold is the lowest one that loses no must-keep entry.
//   node eval/compact.cjs [--thresholds 0.5,0.6,0.7,0.8,0.9] [--keep 0.5]
//     [--order chronological|unordered] [--all-pairs-up-to N] [--cases file]
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { filterEntries, candidatePairs } = require("../lib/compact.cjs");
const { decide } = require("../lib/decision-engine.cjs");

const args = process.argv.slice(2);
const get = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
const thresholds = get("--thresholds", "0.5,0.6,0.7,0.8,0.9").split(",").map(Number);
const keepThreshold = Number(get("--keep", "0.5"));
const order = get("--order", undefined);
const allPairsUpTo = get("--all-pairs-up-to", undefined) === undefined ? undefined : Number(get("--all-pairs-up-to"));
const casesFile = get("--cases", undefined) ? resolve(get("--cases")) : join(__dirname, "compact-cases.json");
const { cases } = JSON.parse(readFileSync(casesFile, "utf8"));
const opts = { ...(order ? { order } : {}), ...(allPairsUpTo === undefined ? {} : { allPairsUpTo }) };

// Ask each distinct request once; count what the live ones cost, and keep
// every supersession answer with the texts it was about.
const cache = new Map();
const spent = {};
const answers = [];
async function judge(req) {
  const key = JSON.stringify([req.downstream, req.state, req.questions]);
  if (!cache.has(key)) {
    cache.set(key, decide(req).then((res) => {
      const s = (spent[req.downstream] ||= { requests: 0, questions: 0, input: 0, output: 0, failed: 0 });
      s.requests += 1;
      s.questions += Object.keys(req.questions).length;
      if (res.fallback) s.failed += 1;
      if (res.usage) { s.input += res.usage.input_tokens || 0; s.output += res.usage.output_tokens || 0; }
      if (req.downstream === "compaction-supersede" && !res.fallback) {
        for (const [k, q] of Object.entries(req.questions)) {
          const [a, b] = q.instructions.compare.map((ref) => req.state.entries[Number(ref.match(/\[(\d+)\]/)[1])]);
          if (res.results[k]) answers.push({ subject: a, by: b, p: Number(res.results[k].noul) });
        }
      }
      return res;
    }));
  }
  return cache.get(key);
}

(async () => {
  // Candidate recall: no model call.
  let reachable = 0, truePairs = 0;
  const unreachable = [];
  for (const c of cases) {
    const idx = new Map(c.entries.map((e, i) => [e.id, i]));
    const found = new Set();
    for (const p of candidatePairs(c.entries, { maxPerEntry: 4, ...opts })) {
      found.add(`${p.i}>${p.j}`);
      if (p.both) found.add(`${p.j}>${p.i}`);
    }
    for (const [older, newer] of c.pairs || []) {
      truePairs += 1;
      if (found.has(`${idx.get(older)}>${idx.get(newer)}`)) reachable += 1;
      else unreachable.push(`${c.id}: ${older}>${newer}`);
    }
  }
  console.log(`candidate recall ${reachable}/${truePairs}${unreachable.length ? ` (not asked: ${unreachable.join(", ")})` : ""}`);

  const rows = [];
  const relevanceLosses = new Set();
  for (const t of thresholds) {
    let must = 0, kept = 0, drop = 0, caught = 0, gone = 0, requests = 0, failed = 0, pairs = 0;
    const misses = [];
    for (const c of cases) {
      const res = await filterEntries({ goal: c.goal, entries: c.entries, keepThreshold, supersedeThreshold: t, judge, ...opts });
      requests += res.stats.requests + res.stats.supersedeRequests;
      failed += res.stats.failedChunks + res.stats.failedSupersedeRequests;
      pairs += res.stats.pairsJudged;
      const dropped = new Map(res.dropped.map((e) => [e.id, e]));
      for (const id of c.mustKeep) {
        must += 1;
        const d = dropped.get(id);
        if (d && d.reason === "superseded") misses.push(`${c.id}: lost ${id}, superseded by ${d.supersededBy} at ${d.ps.toFixed(2)}`);
        else kept += 1;
        if (d && d.reason === "irrelevant") relevanceLosses.add(`${c.id}: ${id} dropped as irrelevant at ${d.p.toFixed(2)}`);
      }
      for (const id of c.mustDrop) {
        drop += 1;
        const d = dropped.get(id);
        if (d) gone += 1;
        if (d && d.reason === "superseded") caught += 1;
        else misses.push(`${c.id}: not superseded ${id}${d ? ` (dropped as irrelevant at ${d.p.toFixed(2)})` : ""}`);
      }
    }
    rows.push({ t, recall: kept / must });
    const pct = (a, b) => ((a / b) * 100).toFixed(1);
    console.log(`supersede=${t.toFixed(2)}  recall ${kept}/${must} (${pct(kept, must)}%)  caught ${caught}/${drop} (${pct(caught, drop)}%), dropped by either pass ${gone}/${drop}  ${pairs} pairs, ${requests} requests${failed ? `, ${failed} failed` : ""}${misses.length ? "\n    " + misses.join("\n    ") : ""}`);
  }
  console.log(`relevance pass (keep ${keepThreshold}) dropped ${relevanceLosses.size} must-keep entries${relevanceLosses.size ? ":\n    " + [...relevanceLosses].join("\n    ") : ""}`);

  // The must-stay ceiling: the highest answer that a must-keep entry is out of date.
  const keepTexts = new Map();
  for (const c of cases) for (const e of c.entries) if (c.mustKeep.includes(e.id)) keepTexts.set(e.text.slice(0, 1200), `${c.id}:${e.id}`);
  const idOf = new Map();
  for (const c of cases) for (const e of c.entries) idOf.set(e.text.slice(0, 1200), `${c.id}:${e.id}`);
  const mustStay = answers.filter((a) => keepTexts.has(a.subject)).sort((a, b) => b.p - a.p);
  if (mustStay.length) {
    console.log(`must-stay ceiling ${mustStay[0].p.toFixed(2)} over ${mustStay.length} answers; highest: ${mustStay.slice(0, 3).map((a) => `${idOf.get(a.subject)} by ${idOf.get(a.by).split(":")[1]} ${a.p.toFixed(2)}`).join(", ")}`);
  }
  const safe = rows.filter((r) => r.recall === 1).map((r) => r.t).sort((a, b) => a - b);
  console.log(safe.length ? `lowest threshold with full recall: ${safe[0]}` : "no threshold keeps every must-keep entry");
  for (const [downstream, s] of Object.entries(spent)) {
    console.log(`${downstream}: ${s.requests} live requests, ${s.questions} questions, ${s.input} input / ${s.output} output tokens, ${(s.input / s.questions).toFixed(0)} input tokens a question${s.failed ? `, ${s.failed} failed` : ""}`);
  }
})();
