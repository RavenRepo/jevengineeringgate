// Live replay of eval/compact-cases.json: for each supersede threshold, how
// many must-keep entries survived the supersession pass (recall, the safety
// number), how many must-drop entries it caught, and what it cost. A
// must-keep entry the relevance pass drops is listed apart: no supersede
// threshold changes it.
// Each request is asked once and its answers reused at every threshold, so the
// thresholds are compared on the same answers. The default threshold is the
// lowest one that loses no must-keep entry.
//   node eval/compact.cjs [--thresholds 0.6,0.7,0.8,0.9] [--keep 0.5]
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { filterEntries } = require("../lib/compact.cjs");
const { decide } = require("../lib/decision-engine.cjs");

const args = process.argv.slice(2);
const get = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
const thresholds = get("--thresholds", "0.6,0.7,0.8,0.9").split(",").map(Number);
const keepThreshold = Number(get("--keep", "0.5"));
const { cases } = JSON.parse(readFileSync(join(__dirname, "compact-cases.json"), "utf8"));

// Ask each distinct request once; count what the live ones cost.
const cache = new Map();
const spent = {};
async function judge(req) {
  const key = JSON.stringify([req.downstream, req.state, req.questions]);
  if (!cache.has(key)) {
    cache.set(key, decide(req).then((res) => {
      const s = (spent[req.downstream] ||= { requests: 0, questions: 0, input: 0, output: 0, failed: 0 });
      s.requests += 1;
      s.questions += Object.keys(req.questions).length;
      if (res.fallback) s.failed += 1;
      if (res.usage) { s.input += res.usage.input_tokens || 0; s.output += res.usage.output_tokens || 0; }
      return res;
    }));
  }
  return cache.get(key);
}

(async () => {
  const rows = [];
  for (const t of thresholds) {
    let must = 0, kept = 0, drop = 0, caught = 0, gone = 0, requests = 0, failed = 0;
    const misses = [];
    const relevanceLosses = [];
    for (const c of cases) {
      const res = await filterEntries({ goal: c.goal, entries: c.entries, keepThreshold, supersedeThreshold: t, judge });
      requests += res.stats.requests + res.stats.supersedeRequests;
      failed += res.stats.failedChunks + res.stats.failedSupersedeRequests;
      const dropped = new Map(res.dropped.map((e) => [e.id, e]));
      for (const id of c.mustKeep) {
        must += 1;
        const d = dropped.get(id);
        if (d && d.reason === "superseded") misses.push(`${c.id}: lost ${id}, superseded by ${d.supersededBy} at ${d.ps.toFixed(2)}`);
        else kept += 1;
        if (d && d.reason === "irrelevant") relevanceLosses.push(`${c.id}: ${id} dropped as irrelevant at ${d.p.toFixed(2)}`);
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
    console.log(`supersede=${t.toFixed(2)}  recall ${kept}/${must} (${pct(kept, must)}%)  caught ${caught}/${drop} (${pct(caught, drop)}%), dropped by either pass ${gone}/${drop}  ${requests} requests${failed ? `, ${failed} failed` : ""}${misses.length ? "\n    " + misses.join("\n    ") : ""}`);
    if (t === thresholds[0] && relevanceLosses.length) {
      console.log(`  relevance pass (keep ${keepThreshold}, same at every threshold) dropped must-keep entries:\n    ${relevanceLosses.join("\n    ")}`);
    }
  }
  const safe = rows.filter((r) => r.recall === 1).map((r) => r.t).sort((a, b) => a - b);
  console.log(safe.length ? `lowest threshold with full recall: ${safe[0]}` : "no threshold keeps every must-keep entry");
  for (const [downstream, s] of Object.entries(spent)) {
    console.log(`${downstream}: ${s.requests} live requests, ${s.questions} questions, ${s.input} input / ${s.output} output tokens, ${(s.input / s.questions).toFixed(0)} input tokens a question${s.failed ? `, ${s.failed} failed` : ""}`);
  }
})();
