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

module.exports = { filterEntries, CHUNK, CONCURRENCY };
