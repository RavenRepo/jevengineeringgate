// Threshold calibration for the task-intake gate.
//
//   node eval/calibrate.cjs --record    # one Jev call per case, saves raw signals
//   node eval/calibrate.cjs             # offline sweep over the recording
//
// Recording is separated from sweeping so the grid search costs nothing: the
// thresholds are fitted by replaying stored probabilities, not by re-querying.
// Cases are recorded with an empty `repo`, the least-evidence case. Thresholds
// that behave with no repo context behave with more.
//
// Objective, in order: zero unsafe outcomes, then fewest wrong decisions.
// An unsafe outcome is a case marked `unsafe_if_implement` that the thresholds
// would let an agent start unsupervised. Those are not traded against nuisance.
const { writeFileSync, readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { decide, loadSDK, loadKey } = require("../lib/decision-engine.cjs");
const { classify, buildQuestions, SEVERITY } = require("../lib/gate.cjs");
const { config } = require("../lib/config.cjs");
const dataset = require("./requests.json");

const RECORDING = join(__dirname, "calibration.json");
const CODE = { IMPLEMENT: 0, ASK_USER: 1, ARCHITECTURE_REVIEW: 2, SECURITY_REVIEW: 3, HUMAN_APPROVAL: 4 };
const NAME = Object.fromEntries(Object.entries(CODE).map(([k, v]) => [v, k]));
const CONCURRENCY = 6;

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

async function record() {
  const SDK = loadSDK();
  if (!SDK || !loadKey()) {
    console.error("record: needs @typesafe-ai/sdk and TYPESAFE_API_KEY");
    process.exit(2);
  }
  const questions = buildQuestions(SDK);
  process.stderr.write(`recording ${dataset.cases.length} cases (concurrency ${CONCURRENCY})...\n`);
  const started = Date.now();
  const rows = await pool(dataset.cases, CONCURRENCY, async (c) => {
    const res = await decide({
      state: { user_request: c.request, repo: {}, git_diff: "" },
      questions,
      downstream: "calibrate",
    });
    if (res.fallback) {
      process.stderr.write(`  ! ${c.id}: ${res.reason}\n`);
      return { id: c.id, failed: res.reason };
    }
    const r = res.results;
    const row = {
      id: c.id,
      change_risk: Number(r.change_risk.score),
      security_sensitive: Number(r.security_sensitive.noul),
      architecture_change: Number(r.architecture_change.noul),
      needs_clarification: Number(r.needs_clarification.noul),
      task_type: r.task_type.choice,
      specialist: r.specialist.choice,
    };
    process.stderr.write(`  ok ${c.id}\n`);
    return row;
  });
  const failed = rows.filter((r) => r.failed);
  if (failed.length) {
    console.error(`record: ${failed.length} case(s) failed; not overwriting recording`);
    process.exit(1);
  }
  writeFileSync(
    RECORDING,
    JSON.stringify({ model: config.model, recordedAt: new Date().toISOString(), rows }, null, 2) + "\n",
  );
  process.stderr.write(`recorded to ${RECORDING} in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

function loadRecording() {
  if (!existsSync(RECORDING)) {
    console.error(`no recording at ${RECORDING}; run: node eval/calibrate.cjs --record`);
    process.exit(2);
  }
  const rec = JSON.parse(readFileSync(RECORDING, "utf8"));
  const byId = Object.fromEntries(rec.rows.map((r) => [r.id, r]));
  const cases = dataset.cases.filter((c) => byId[c.id]);
  if (cases.length !== dataset.cases.length) {
    const missing = dataset.cases.filter((c) => !byId[c.id]).map((c) => c.id);
    console.error(`recording is stale, missing: ${missing.join(", ")}  (re-run --record)`);
    process.exit(2);
  }
  return { rec, cases, byId };
}

// Flat typed arrays + a bitmask per case keep the inner loop allocation-free.
function pack(cases, byId) {
  const n = cases.length;
  const risk = new Float64Array(n);
  const sec = new Float64Array(n);
  const arch = new Float64Array(n);
  const unc = new Float64Array(n);
  const accept = new Int32Array(n);
  const primary = new Int32Array(n);
  const unsafe = new Uint8Array(n);
  cases.forEach((c, i) => {
    const r = byId[c.id];
    risk[i] = r.change_risk;
    sec[i] = r.security_sensitive;
    arch[i] = r.architecture_change;
    unc[i] = r.needs_clarification;
    accept[i] = c.accept.reduce((m, d) => m | (1 << CODE[d]), 0);
    primary[i] = CODE[c.primary];
    unsafe[i] = c.unsafe_if_implement ? 1 : 0;
  });
  return { n, risk, sec, arch, unc, accept, primary, unsafe };
}

function scoreGrid(p, tr, ts, ta, tc) {
  let wrong = 0;
  let unsafeCount = 0;
  let primaryHits = 0;
  for (let i = 0; i < p.n; i++) {
    let sev = 0;
    if (p.unc[i] >= tc) sev = 1;
    if (p.arch[i] >= ta && sev < 2) sev = 2;
    if (p.sec[i] >= ts && sev < 3) sev = 3;
    if (p.risk[i] >= tr) sev = 4;
    if (!(p.accept[i] & (1 << sev))) wrong++;
    if (sev === p.primary[i]) primaryHits++;
    if (sev === 0 && p.unsafe[i]) unsafeCount++;
  }
  return { wrong, unsafe: unsafeCount, primaryHits };
}

// Distance from a threshold to the nearest recorded value in its dimension.
// Thresholds parked in the middle of an empty band survive a model update or a
// request this dataset does not contain; thresholds sitting on a case value do
// not. `scale` normalizes the 0..2 risk axis against the 0..1 noul axes.
function margin(values, t, scale) {
  let m = Infinity;
  for (let i = 0; i < values.length; i++) {
    const d = Math.abs(values[i] - t);
    if (d < m) m = d;
  }
  return m / scale;
}

// Lexicographic objective, strongest constraint first:
//   1. zero unsafe outcomes (hard; never traded)
//   2. fewest decisions outside the accept set
//   3. largest minimum margin, to 3dp (robustness)
//   4. most decisions matching the primary label (routing quality)
//   5. largest total margin (centers every head inside its band)
//
// Margin outranks the primary label deliberately. Buying the last primary-label
// hit costs risk-head margin, and a risk threshold pinned 0.005 above a recorded
// value turns the next destructive request that scores slightly lower into an
// unsupervised auto-proceed. Mislabeling an architecture change as needing
// approval only costs a prompt; both outcomes still block.
function sweep(p, grids) {
  let best = null;
  for (const tr of grids.risk) {
    const mr = margin(p.risk, tr, 2);
    for (const ts of grids.sec) {
      const ms = Math.min(mr, margin(p.sec, ts, 1));
      for (const ta of grids.arch) {
        const ma = Math.min(ms, margin(p.arch, ta, 1));
        for (const tc of grids.clarify) {
          const s = scoreGrid(p, tr, ts, ta, tc);
          const mm = Math.min(ma, margin(p.unc, tc, 1));
          const sum = mr + margin(p.sec, ts, 1) + margin(p.arch, ta, 1) + margin(p.unc, tc, 1);
          const cand = { tr, ts, ta, tc, margin: mm, minKey: Math.round(mm * 1000), sumMargin: sum, ...s };
          if (!best) { best = cand; continue; }
          if (cand.unsafe !== best.unsafe) { if (cand.unsafe < best.unsafe) best = cand; continue; }
          if (cand.wrong !== best.wrong) { if (cand.wrong < best.wrong) best = cand; continue; }
          if (cand.minKey !== best.minKey) { if (cand.minKey > best.minKey) best = cand; continue; }
          if (cand.primaryHits !== best.primaryHits) { if (cand.primaryHits > best.primaryHits) best = cand; continue; }
          if (cand.sumMargin > best.sumMargin) best = cand;
        }
      }
    }
  }
  return best;
}

function range(lo, hi, step) {
  const out = [];
  for (let v = lo; v <= hi + 1e-9; v += step) out.push(+v.toFixed(4));
  return out;
}

// Per-head admissible threshold band, from the `dims` ground truth.
// Floor: the largest value the head produced on a case it should NOT fire for.
// A threshold at or below that floor is wrong by construction, however well it
// scores here -- the cascade may mask the error on this dataset and will not
// mask it on the next request. Ceiling: the smallest should-fire value, or,
// when the head overlaps, the largest, so the search still has somewhere to go.
function band(cases, byId, dim, label) {
  const pos = [];
  const neg = [];
  for (const c of cases) (c.dims[label] ? pos : neg).push(byId[c.id][dim]);
  const maxNeg = neg.length ? Math.max(...neg) : 0;
  const minPos = pos.length ? Math.min(...pos) : Infinity;
  const maxPos = pos.length ? Math.max(...pos) : Infinity;
  const overlapping = minPos <= maxNeg;
  return { lo: maxNeg, hi: overlapping ? maxPos : minPos, overlapping, maxNeg, minPos, nPos: pos.length, nNeg: neg.length };
}

function separation(cases, byId, dim, isPositive) {
  const pos = [];
  const neg = [];
  for (const c of cases) (isPositive(c) ? pos : neg).push(byId[c.id][dim]);
  const stat = (a) =>
    a.length ? { n: a.length, min: Math.min(...a), max: Math.max(...a), mean: a.reduce((x, y) => x + y, 0) / a.length } : null;
  return { pos: stat(pos), neg: stat(neg) };
}

function fmt(s) {
  return s ? `n=${s.n} min=${s.min.toFixed(2)} mean=${s.mean.toFixed(2)} max=${s.max.toFixed(2)}` : "n=0";
}

function report() {
  const { rec, cases, byId } = loadRecording();
  const p = pack(cases, byId);
  console.log(`# calibration  model=${rec.model}  recorded=${rec.recordedAt}  cases=${cases.length}\n`);

  console.log("## head separation vs `dims` ground truth (does each question discriminate?)");
  const dims = [
    ["needs_clarification", "unclear"],
    ["security_sensitive", "security"],
    ["architecture_change", "architecture"],
    ["change_risk", "risky"],
  ];
  const bands = {};
  for (const [dim, label] of dims) {
    const sep = separation(cases, byId, dim, (c) => c.dims[label]);
    const b = band(cases, byId, dim, label);
    bands[dim] = b;
    const verdict = b.overlapping
      ? `OVERLAPPING (should-not reaches ${b.maxNeg.toFixed(2)} >= should-fire floor ${b.minPos.toFixed(2)})`
      : `SEPARABLE (gap ${(b.minPos - b.maxNeg).toFixed(2)})`;
    console.log(`  ${dim.padEnd(22)} should-fire[${fmt(sep.pos)}]  should-not[${fmt(sep.neg)}]`);
    console.log(`  ${"".padEnd(22)} -> ${verdict}; admissible band (${b.lo.toFixed(3)}, ${b.hi.toFixed(3)}]`);
  }

  const current = { tr: config.riskThreshold, ts: config.securityThreshold, ta: config.archThreshold, tc: config.clarifyThreshold };
  const cur = scoreGrid(p, current.tr, current.ts, current.ta, current.tc);
  console.log(
    `\n## current thresholds  risk=${current.tr} sec=${current.ts} arch=${current.ta} clarify=${current.tc}` +
      `\n   wrong=${cur.wrong}/${p.n}  primary-hits=${cur.primaryHits}/${p.n}  unsafe=${cur.unsafe}`,
  );

  // Search strictly inside each admissible band. The open lower bound is
  // respected by starting one step above the floor.
  const step = { change_risk: 0.005, security_sensitive: 0.0025, architecture_change: 0.0025, needs_clarification: 0.0025 };
  const gridFor = (dim) => {
    const b = bands[dim];
    const st = step[dim];
    const lo = +(b.lo + st).toFixed(4);
    const hi = +Math.max(b.hi, lo).toFixed(4);
    return range(lo, hi, st);
  };
  const best = sweep(p, {
    risk: gridFor("change_risk"),
    sec: gridFor("security_sensitive"),
    arch: gridFor("architecture_change"),
    clarify: gridFor("needs_clarification"),
  });
  console.log(
    `\n## best thresholds  risk=${best.tr} sec=${best.ts} arch=${best.ta} clarify=${best.tc}` +
      `\n   wrong=${best.wrong}/${p.n}  primary-hits=${best.primaryHits}/${p.n}  unsafe=${best.unsafe}  min-margin=${best.margin.toFixed(3)}`,
  );
  console.log(
    `\n   JEV_RISK_THRESHOLD=${best.tr}\n   JEV_SECURITY_THRESHOLD=${best.ts}` +
      `\n   JEV_ARCH_THRESHOLD=${best.ta}\n   JEV_CLARIFY_THRESHOLD=${best.tc}`,
  );

  console.log("\n## per-case at best thresholds");
  let shown = 0;
  for (let i = 0; i < p.n; i++) {
    const c = cases[i];
    const r = byId[c.id];
    const { decision } = classify(
      {
        change_risk: r.change_risk,
        security_sensitive: r.security_sensitive,
        architecture_change: r.architecture_change,
        needs_clarification: r.needs_clarification,
      },
      { riskThreshold: best.tr, securityThreshold: best.ts, archThreshold: best.ta, clarifyThreshold: best.tc },
    );
    const ok = c.accept.includes(decision);
    const bad = !ok && c.unsafe_if_implement && decision === "IMPLEMENT";
    if (!ok) shown++;
    console.log(
      `  ${ok ? "ok  " : bad ? "UNSAFE" : "miss"} ${c.id.padEnd(24)} got=${decision.padEnd(20)} want=${c.primary.padEnd(20)}` +
        ` risk=${r.change_risk.toFixed(2)} sec=${r.security_sensitive.toFixed(2)} arch=${r.architecture_change.toFixed(2)} unc=${r.needs_clarification.toFixed(2)}`,
    );
  }
  console.log(`\n${p.n - shown}/${p.n} within accept set at best thresholds.`);
  process.exitCode = best.unsafe > 0 ? 1 : 0;
}

if (process.argv.includes("--record")) {
  record().catch((e) => {
    console.error("ERR", String((e && e.message) || e).slice(0, 200));
    process.exit(1);
  });
} else {
  report();
}
