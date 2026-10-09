// L4: context compaction as a relevance filter.
//
// Compaction is conventionally a summarization prompt: hand the history to a
// large model and hope it keeps the right parts. That is generation -- slow,
// lossy, and it rewrites what it keeps. Keeping or dropping an entry is a
// decision, so it belongs here: every entry is scored against the goal in
// batched noul questions and either survives verbatim or is dropped.
//
// A summarizer rewrites. A filter keeps or drops. Only the second is reversible
// in the sense that matters: what survives is exactly what was there.
const { decide, loadSDK } = require("./decision-engine.cjs");

const CHUNK = 25;          // questions per request
const CONCURRENCY = 6;     // requests in flight
const MAX_ENTRY_CHARS = 1200;
// Not yet measured; set from eval/compact.cjs.
const SUPERSEDE_THRESHOLD = 0.7;

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

function normalize(entry, i) {
  if (typeof entry === "string") return { id: String(i), text: entry };
  return { id: String(entry.id ?? i), text: String(entry.text ?? entry.content ?? ""), meta: entry.meta };
}

// Supersession candidates. Deterministic and free: only pairs that share an
// anchor or enough content words are ever put to the model.
const SUPERSEDE_JACCARD = 0.35;
const STOPWORDS = new Set(
  ("this that with from have been were will would should could they them their there then than what when where which " +
    "while into onto over under about after before again also only just more most much some such very each other " +
    "does done doing being here your yours ours mine itself these those because still until upon must need needs").split(" "),
);

// Anchors: the tokens that name a thing, so two entries naming the same thing
// can be compared. Normalised so `ADR 0030`, `ADR-30` and `adr30` match, and
// `PR #40`, `pull/40` and `#40` match.
function anchors(text) {
  const t = String(text);
  const out = new Set();
  const add = (a) => { if (a) out.add(a); };
  // The leading label: `**Label**` or `Label:` at the start of the entry.
  const label = t.match(/^\s*\*\*([^*\n]{1,60})\*\*/) || t.match(/^\s*([A-Za-z][^:\n]{0,59}):(?!\/)/);
  if (label) add(`label:${label[1].trim().replace(/[:\s]+$/, "").replace(/\s+/g, " ").toLowerCase()}`);
  for (const m of t.matchAll(/\bADR[ -]?(\d+)\b/gi)) add(`adr:${Number(m[1])}`);
  for (const m of t.matchAll(/(?:^|[^\w&])#(\d+)\b/g)) add(`#${Number(m[1])}`);
  for (const m of t.matchAll(/\b(?:PR|pull request|issue)[ -]?#?(\d+)\b/gi)) add(`#${Number(m[1])}`);
  for (const m of t.matchAll(/\b(?:pull|pulls|issues)\/(\d+)\b/g)) add(`#${Number(m[1])}`);
  for (const m of t.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
    if (/\d/.test(m[0]) && /[a-f]/.test(m[0])) add(`sha:${m[0]}`);
  }
  for (const m of t.matchAll(/`([^`\n]+)`/g)) add(`code:${m[1].trim().toLowerCase()}`);
  for (const m of t.matchAll(/(?:^|[\s(\["'])((?:[\w.~-]*\/)+[\w.-]+)/g)) {
    if (!/^\w+:\/\//.test(m[1]) && /[A-Za-z]/.test(m[1])) add(`path:${m[1].replace(/[.]+$/, "")}`);
  }
  for (const m of t.matchAll(/(?:^|[\s(\["'])([\w-]{2,}\.[A-Za-z][A-Za-z0-9]{0,5})(?=$|[\s)\]"',:;]|\.(?:\s|$))/g)) add(`path:${m[1]}`);
  for (const m of t.matchAll(/\bv?(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/g)) add(`version:${m[1]}`);
  for (const m of t.matchAll(/\bv(\d+(?:\.\d+)+)\b/g)) add(`version:${m[1]}`);
  for (const m of t.matchAll(/\b[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)+\b/g)) {
    if (/\d/.test(m[0]) && /[A-Za-z]/.test(m[0])) add(`id:${m[0].toLowerCase()}`);
  }
  return [...out].sort();
}

function contentWords(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  return new Set(words.filter((w) => w.length >= 4 && !STOPWORDS.has(w)));
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both += 1;
  return both / (a.size + b.size - both);
}

// Chronological rank of each entry: `meta.ts` when every entry has a usable
// one, else index order. Ties keep index order.
function chronology(all) {
  const ts = all.map((e) => {
    const v = e.meta && e.meta.ts;
    if (v === undefined || v === null || v === "") return NaN;
    return typeof v === "number" ? v : Date.parse(v);
  });
  const order = all.map((_, i) => i);
  if (all.length && ts.every(Number.isFinite)) order.sort((a, b) => ts[a] - ts[b] || a - b);
  const rank = new Array(all.length);
  order.forEach((idx, r) => { rank[idx] = r; });
  return rank;
}

/**
 * Candidate supersession pairs: for each entry i, up to `maxPerEntry` later
 * entries j that share an anchor with it or whose content-word Jaccard is at
 * least 0.35, ranked by shared anchors, then Jaccard, then most recent.
 * Returns [{ i, j, shared, jaccard }] with i and j as input indexes.
 */
function candidatePairs(entries, { maxPerEntry = 4 } = {}) {
  const all = entries.map(normalize);
  const rank = chronology(all);
  const anc = all.map((e) => new Set(anchors(e.text)));
  const words = all.map((e) => contentWords(e.text));
  const pairs = [];
  for (let i = 0; i < all.length; i++) {
    const cands = [];
    for (let j = 0; j < all.length; j++) {
      if (rank[j] <= rank[i]) continue;
      const shared = [...anc[i]].filter((a) => anc[j].has(a));
      const jac = jaccard(words[i], words[j]);
      if (shared.length || jac >= SUPERSEDE_JACCARD) cands.push({ i, j, shared, jaccard: +jac.toFixed(3) });
    }
    cands.sort((a, b) => b.shared.length - a.shared.length || b.jaccard - a.jaccard || rank[b.j] - rank[a.j]);
    pairs.push(...cands.slice(0, maxPerEntry));
  }
  return pairs;
}

async function scoreChunk({ goal, chunk, model, timeoutMs, judge = decide }) {
  const SDK = loadSDK();
  const { noul } = SDK;
  const texts = chunk.map((e) => e.text.slice(0, MAX_ENTRY_CHARS));
  const questions = {};
  texts.forEach((_, i) => {
    questions[`e${i}`] = noul({
      question:
        "Is this entry still needed to continue working toward the goal? Keep it if it holds a decision, a constraint, an unresolved problem, a file path or identifier that will be referenced again, or evidence that would have to be re-gathered. Drop it if it is superseded, already acted on, or restates something kept elsewhere.",
      compare: ["`goal`", `\`entries[${i}]\``],
    });
  });
  const res = await judge({
    state: { goal, entries: texts },
    questions,
    model,
    downstream: "compaction-filter",
    timeoutMs,
  });
  // A failed chunk keeps everything. Dropping an entry is unrecoverable inside
  // this process; keeping one only costs tokens.
  if (res.fallback) return chunk.map((e) => ({ ...e, p: 1, failed: true }));
  return chunk.map((e, i) => {
    const r = res.results[`e${i}`];
    return { ...e, p: r ? Number(r.noul) : 1, failed: !r };
  });
}

// The starting wording from the design. It names the subject test, the kinds
// of replacement, and the three ways a near-duplicate is not a replacement.
const SUPERSEDE_QUESTION = (i, j) =>
  `Does \`entries[${j}]\` supersede \`entries[${i}]\`: is it about the same subject and does it replace \`entries[${i}]\`'s status, value or decision (a newer status, a reversal, a completed item, a corrected fact), so that \`entries[${i}]\` adds nothing needed for \`goal\` that \`entries[${j}]\` does not already say? Answer no if they are about different subjects, if \`entries[${j}]\` only adds detail, or if \`entries[${i}]\` holds a constraint, rule or identifier \`entries[${j}]\` omits.`;

// One request for up to CHUNK pairs. The state holds only this chunk's texts.
// A failed request answers no pair: no supersession, so both entries stay.
async function judgePairs({ goal, pairs, all, model, timeoutMs, judge = decide }) {
  const SDK = loadSDK();
  const { noul } = SDK;
  const slot = new Map();
  const texts = [];
  const at = (idx) => {
    if (!slot.has(idx)) {
      slot.set(idx, texts.length);
      texts.push(all[idx].text.slice(0, MAX_ENTRY_CHARS));
    }
    return slot.get(idx);
  };
  const questions = {};
  pairs.forEach((pr, k) => {
    const a = at(pr.i);
    const b = at(pr.j);
    questions[`s${k}`] = noul({ question: SUPERSEDE_QUESTION(a, b), compare: [`\`entries[${a}]\``, `\`entries[${b}]\``] });
  });
  const res = await judge({
    state: { goal, entries: texts },
    questions,
    model,
    downstream: "compaction-supersede",
    timeoutMs,
  });
  if (res.fallback) return pairs.map((pr) => ({ ...pr, ps: null, failed: true }));
  return pairs.map((pr, k) => {
    const r = res.results[`s${k}`];
    const ps = r ? Number(r.noul) : NaN;
    return { ...pr, ps: Number.isFinite(ps) ? ps : null, failed: !Number.isFinite(ps) };
  });
}

// Two passes, then one decision per entry.
// Relevance: every entry is scored against the goal; below `keepThreshold` it
// is dropped as irrelevant. `pinFirst` / `pinLast` survive unscored: the
// opening instructions and the most recent turns are load-bearing regardless
// of how they score.
// Supersession (`supersede`, default on): each candidate pair (older i, later
// j) is asked whether j replaces i. i is dropped as superseded when the answer
// is at least `supersedeThreshold`, i is not pinned, and j survives the final
// set -- or was itself superseded by an entry that does, and so on. If no
// superseder survives, i stays.
// `judge` replaces decide() in both passes; it exists for tests.
async function filterEntries({
  goal,
  entries = [],
  keepThreshold = 0.5,
  pinFirst = 0,
  pinLast = 0,
  supersede = true,
  supersedeThreshold = SUPERSEDE_THRESHOLD,
  maxPerEntry = 4,
  model,
  timeoutMs,
  judge = decide,
} = {}) {
  if (!goal) throw new Error("filterEntries: goal is required");
  if (!loadSDK()) throw new Error("filterEntries: SDK not installed");
  const all = entries.map(normalize);
  const started = Date.now();

  const pinnedIdx = new Set();
  for (let i = 0; i < Math.min(pinFirst, all.length); i++) pinnedIdx.add(i);
  for (let i = Math.max(0, all.length - pinLast); i < all.length; i++) pinnedIdx.add(i);
  const scoreable = all.filter((_, i) => !pinnedIdx.has(i));

  const chunks = [];
  for (let i = 0; i < scoreable.length; i += CHUNK) chunks.push(scoreable.slice(i, i + CHUNK));
  // A pinned entry is never dropped, so it is never asked about as the older
  // one; it can still be the later one that supersedes.
  const pairs = supersede ? candidatePairs(all, { maxPerEntry }).filter((pr) => !pinnedIdx.has(pr.i)) : [];
  const pairChunks = [];
  for (let i = 0; i < pairs.length; i += CHUNK) pairChunks.push(pairs.slice(i, i + CHUNK));

  // Both passes share one pool of CONCURRENCY requests.
  const tasks = [
    ...chunks.map((c) => () => scoreChunk({ goal, chunk: c, model, timeoutMs, judge })),
    ...pairChunks.map((c) => () => judgePairs({ goal, pairs: c, all, model, timeoutMs, judge })),
  ];
  const results = await pool(tasks, CONCURRENCY, (t) => t());
  const scoredChunks = results.slice(0, chunks.length);
  const judgedChunks = results.slice(chunks.length);
  const byId = new Map();
  for (const c of scoredChunks) for (const e of c) byId.set(e.id, e);

  const superseders = new Map();
  for (const c of judgedChunks) {
    for (const pr of c) {
      if (pr.ps === null || pr.ps < supersedeThreshold) continue;
      if (!superseders.has(pr.i)) superseders.set(pr.i, []);
      superseders.get(pr.i).push(pr);
    }
  }

  // Latest first, so every possible superseder is settled before the entries
  // it may replace. A superseded entry counts as surviving through its own
  // superseder, which is what makes the rule transitive.
  const rank = chronology(all);
  const order = all.map((_, i) => i).sort((a, b) => rank[b] - rank[a]);
  const status = new Array(all.length);
  const by = new Array(all.length);
  for (const i of order) {
    if (pinnedIdx.has(i)) { status[i] = "kept"; continue; }
    const s = byId.get(all[i].id) || { p: 1 };
    if (s.p < keepThreshold) { status[i] = "irrelevant"; continue; }
    const live = (superseders.get(i) || []).filter((pr) => status[pr.j] === "kept" || status[pr.j] === "superseded");
    if (!live.length) { status[i] = "kept"; continue; }
    live.sort((a, b) => b.ps - a.ps || rank[b.j] - rank[a.j]);
    status[i] = "superseded";
    by[i] = live[0];
  }

  const kept = [];
  const dropped = [];
  all.forEach((e, i) => {
    if (pinnedIdx.has(i)) {
      kept.push({ ...e, p: null, pinned: true });
      return;
    }
    const s = byId.get(e.id) || { ...e, p: 1 };
    if (status[i] === "kept") kept.push(s);
    else if (status[i] === "irrelevant") dropped.push({ ...s, reason: "irrelevant" });
    else dropped.push({ ...s, reason: "superseded", supersededBy: all[by[i].j].id, ps: by[i].ps });
  });

  const chars = (a) => a.reduce((n, e) => n + e.text.length, 0);
  const before = chars(all);
  const after = chars(kept);
  return {
    kept,
    dropped,
    stats: {
      entriesIn: all.length,
      entriesKept: kept.length,
      entriesDropped: dropped.length,
      superseded: dropped.filter((e) => e.reason === "superseded").length,
      charsIn: before,
      charsKept: after,
      reductionPct: before ? +(((before - after) / before) * 100).toFixed(1) : 0,
      requests: chunks.length,
      failedChunks: scoredChunks.filter((c) => c.some((e) => e.failed)).length,
      pairsJudged: pairs.length,
      supersedeRequests: pairChunks.length,
      failedSupersedeRequests: judgedChunks.filter((c) => c.some((pr) => pr.failed)).length,
      latencyMs: Date.now() - started,
    },
  };
}

module.exports = { filterEntries, candidatePairs, anchors, CHUNK, CONCURRENCY, SUPERSEDE_THRESHOLD };
