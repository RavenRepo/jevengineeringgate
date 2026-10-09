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

async function scoreChunk({ goal, chunk, model, timeoutMs }) {
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
  const res = await decide({
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

// Score every entry, keep those at or above `keepThreshold`.
// `pinFirst` / `pinLast` survive unscored: the opening instructions and the
// most recent turns are load-bearing regardless of how they score.
async function filterEntries({
  goal,
  entries = [],
  keepThreshold = 0.5,
  pinFirst = 0,
  pinLast = 0,
  model,
  timeoutMs,
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
  const scoredChunks = await pool(chunks, CONCURRENCY, (c) => scoreChunk({ goal, chunk: c, model, timeoutMs }));
  const byId = new Map();
  for (const c of scoredChunks) for (const e of c) byId.set(e.id, e);

  const kept = [];
  const dropped = [];
  all.forEach((e, i) => {
    if (pinnedIdx.has(i)) {
      kept.push({ ...e, p: null, pinned: true });
      return;
    }
    const s = byId.get(e.id) || { ...e, p: 1 };
    (s.p >= keepThreshold ? kept : dropped).push(s);
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
      charsIn: before,
      charsKept: after,
      reductionPct: before ? +(((before - after) / before) * 100).toFixed(1) : 0,
      requests: chunks.length,
      failedChunks: scoredChunks.filter((c) => c.some((e) => e.failed)).length,
      latencyMs: Date.now() - started,
    },
  };
}

module.exports = { filterEntries, candidatePairs, anchors, CHUNK, CONCURRENCY };
