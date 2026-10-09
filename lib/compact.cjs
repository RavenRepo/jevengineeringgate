// L4: context compaction as a filter.
//
// Compaction is conventionally a summarization prompt: hand the history to a
// large model and hope it keeps the right parts. That is generation -- slow,
// lossy, and it rewrites what it keeps. Keeping or dropping an entry is a
// decision, so it belongs here: every entry either survives verbatim or is
// dropped, in two passes.
//
// Relevance: each entry is scored against the goal in batched noul questions.
// Supersession: an entry scored on its own cannot tell that a later entry has
// replaced it -- an old status line is still on-topic. So pairs of entries
// that share an anchor (an issue or ADR number, a SHA, a path, an id, the
// leading label) or enough words are found by code, and Jev is asked, pair by
// pair, whether the later one makes the older one out of date. The older one
// is dropped only when its replacement survives.
//
// Limits: entries must be in chronological order (or all carry meta.ts); a
// replacement that shares no anchor and few words with the old entry is never
// asked about; and an old entry that holds anything its replacement does not
// repeat is meant to stay.
//
// A summarizer rewrites. A filter keeps or drops. Only the second is reversible
// in the sense that matters: what survives is exactly what was there.
const { createHash } = require("node:crypto");
const { decide, loadSDK } = require("./decision-engine.cjs");

const CHUNK = 25;          // questions per request
const CONCURRENCY = 6;     // requests in flight
const MAX_ENTRY_CHARS = 1200;
// Measured on eval/compact-cases.json (68 must-keep, 32 must-drop entries in
// ten synthetic sessions), `npm run eval:compact` at keep 0.5 on jev-1.13.0:
//   supersede 0.6: recall 68/68, caught 11/32, 20 requests
//   supersede 0.7: recall 68/68, caught  8/32
//   supersede 0.8: recall 68/68, caught  3/32
//   supersede 0.9: recall 68/68, caught  2/32
// The lowest threshold that keeps every must-keep entry. The highest answer
// for a pair whose older entry must stay was 0.28; a wider sweep kept full
// recall down to 0.3, which leaves no margin. Catches move by about two
// between runs. Many misses are the relevance pass dropping the newer entry
// (an entry is only superseded by one that survives); with relevance off
// (--keep 0), 0.6 caught 23/32.
const SUPERSEDE_THRESHOLD = 0.6;

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
// `PR #40`, `pull/40` and `#40` match. A leading list marker (`- `, `* `,
// `1. `) is ignored.
const LIST_MARKER = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/;

function anchors(text) {
  const t = String(text).replace(LIST_MARKER, "");
  const out = new Set();
  const add = (a) => { if (a) out.add(a); };
  // The leading label: `**Label**` or `Label:` at the start of the entry.
  const label = t.match(/^\s*\*\*([^*\n]{1,60})\*\*/) || t.match(/^\s*([A-Za-z][^:\n]{0,59}):(?!\/)/);
  if (label) add(`label:${label[1].trim().replace(/[:\s]+$/, "").replace(/\s+/g, " ").toLowerCase()}`);
  // The leading keyword run: the first one to three words, when the entry
  // opens in bold or with an all-caps word ("STATUS", "READY for review").
  const bold = t.match(/^\s*\*\*([^*\n]{1,80})\*\*/);
  const lead = bold ? bold[1] : /^\s*[A-Z]{2,}\b/.test(t) ? t : "";
  if (lead) {
    const words = (lead.match(/[A-Za-z0-9][\w'-]*/g) || []).slice(0, 3).map((w) => w.toLowerCase());
    for (let n = 1; n <= words.length; n++) add(`lead:${words.slice(0, n).join(" ")}`);
  }
  for (const m of t.matchAll(/\bADR[ -]?(\d+)\b/gi)) { add(`adr:${Number(m[1])}`); add(`num:${Number(m[1])}`); }
  for (const m of t.matchAll(/(?:^|[^\w&])#(\d+)\b/g)) add(`#${Number(m[1])}`);
  for (const m of t.matchAll(/\b(?:PR|pull request|issue)[ -]?#?(\d+)\b/gi)) add(`#${Number(m[1])}`);
  for (const m of t.matchAll(/\b(?:pull|pulls|issues)\/(\d+)\b/g)) add(`#${Number(m[1])}`);
  // Bare numbers that look like ids (zero-padded, 3-5 digits: 0027), and dates.
  for (const m of t.matchAll(/(?<![\w.#-])(0\d{2,4})(?![\w.-])/g)) add(`num:${Number(m[1])}`);
  for (const m of t.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) add(`date:${m[1]}`);
  for (const m of t.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
    if (/\d/.test(m[0]) && /[a-f]/.test(m[0])) add(`sha:${m[0]}`);
  }
  // name@version: queue-client@4.2.1, @scope/pkg@2.0.0.
  for (const m of t.matchAll(/((?:@[\w.-]+\/)?[A-Za-z][\w.-]*)@(v?\d[\w.-]*\w)/g)) add(`pkg:${m[1].toLowerCase()}@${m[2]}`);
  for (const m of t.matchAll(/`([^`\n]+)`/g)) add(`code:${m[1].trim().toLowerCase()}`);
  // Paths: a file name with an extension, or a slash path that has one, starts
  // at a root, or runs three segments deep. Not "and/or".
  for (const m of t.matchAll(/(?:^|[\s(\["'])((?:[\w.~-]*\/)+[\w.-]+)/g)) {
    const path = m[1].replace(/[.]+$/, "");
    const segs = path.split("/").filter(Boolean);
    const pathy = /^[./~]/.test(path) || segs.length >= 3 || /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(path);
    if (!/^\w+:\/\//.test(m[1]) && /[A-Za-z]/.test(path) && pathy) add(`path:${path}`);
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
function timestamps(all) {
  return all.map((e) => {
    const v = e.meta && e.meta.ts;
    if (v === undefined || v === null || v === "") return NaN;
    return typeof v === "number" ? v : Date.parse(v);
  });
}

function chronology(all) {
  const ts = timestamps(all);
  const order = all.map((_, i) => i);
  if (all.length && ts.every(Number.isFinite)) order.sort((a, b) => ts[a] - ts[b] || a - b);
  const rank = new Array(all.length);
  order.forEach((idx, r) => { rank[idx] = r; });
  return rank;
}

// "chronological" when every entry carries a usable meta.ts, else
// "unordered": curated notes and memory files are edited in place, so their
// index order says nothing about which entry is newer.
function defaultOrder(all) {
  const ts = timestamps(all);
  return all.length && ts.every(Number.isFinite) ? "chronological" : "unordered";
}

/**
 * Candidate supersession pairs: for each entry i, up to `maxPerEntry` other
 * entries j that share an anchor with it or whose content-word Jaccard is at
 * least 0.35, ranked by shared anchors, then Jaccard, then most recent.
 * `order: "chronological"` (index order, or meta.ts when every entry has one)
 * only pairs i with later entries: [{ i, j, shared, jaccard }], i older.
 * `order: "unordered"` pairs i with any other entry and returns each pair once,
 * i < j by index, marked `both: true`: it is to be judged in both directions.
 * With at most `allPairsUpTo` entries, every pair is returned instead, unless
 * that is more than `maxPairs`. Never more than `maxPairs` pairs.
 */
function candidatePairs(entries, { maxPerEntry = 4, order, allPairsUpTo = 0, maxPairs = Infinity } = {}) {
  const all = entries.map(normalize);
  const unordered = (order || defaultOrder(all)) === "unordered";
  const rank = chronology(all);
  const anc = all.map((e) => new Set(anchors(e.text)));
  const words = all.map((e) => contentWords(e.text));
  const pair = (i, j) => ({ i, j, shared: [...anc[i]].filter((a) => anc[j].has(a)), jaccard: +jaccard(words[i], words[j]).toFixed(3) });
  // Few entries: every pair, so a replacement that shares no anchor is still
  // asked about. Only when that stays within maxPairs.
  const n = all.length;
  if (n <= allPairsUpTo && (n * (n - 1)) / 2 <= maxPairs) {
    const every = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (unordered ? j > i : rank[j] > rank[i]) every.push(unordered ? { ...pair(i, j), both: true } : pair(i, j));
      }
    }
    return every;
  }
  const pairs = [];
  const seen = new Set();
  for (let i = 0; i < all.length; i++) {
    const cands = [];
    for (let j = 0; j < all.length; j++) {
      if (unordered ? j === i : rank[j] <= rank[i]) continue;
      const shared = [...anc[i]].filter((a) => anc[j].has(a));
      const jac = jaccard(words[i], words[j]);
      if (shared.length || jac >= SUPERSEDE_JACCARD) cands.push({ i, j, shared, jaccard: +jac.toFixed(3) });
    }
    cands.sort((a, b) => b.shared.length - a.shared.length || b.jaccard - a.jaccard || rank[b.j] - rank[a.j]);
    for (const c of cands.slice(0, maxPerEntry)) {
      if (!unordered) { pairs.push(c); continue; }
      const [lo, hi] = c.i < c.j ? [c.i, c.j] : [c.j, c.i];
      if (seen.has(`${lo}>${hi}`)) continue;
      seen.add(`${lo}>${hi}`);
      pairs.push({ ...c, i: lo, j: hi, both: true });
    }
  }
  return pairs.slice(0, maxPairs);
}

// Measured on eval/compact-cases.json (14 cases, 104 must-keep entries), at
// keep 0.5. The first wording told the model to drop entries "superseded,
// already acted on": it dropped 11-14 must-keep entries, among them the newest
// status lines, because a merged or done item reads as acted on. Supersession
// has its own pass now. Dropping that criterion left 8; naming current status,
// rules and identifiers as reasons to keep left 4. The rest was position: an
// entry referenced as `entries[9]` or later scored 0.70 on average against
// 0.86 before it, the newest status line of a release log 0.11. Comparing the
// goal with the entry's own text instead of a reference evened that out
// (0.83 / 0.82) and lost 0, over two runs, for about 8% more input tokens.
const RELEVANCE_QUESTION =
  "Is this entry still needed to continue working toward the goal? Keep it if it holds a rule or constraint, a decision, the current status of an item (done and merged included), an unresolved problem, a file path, number or identifier that may be referenced again, or evidence that would have to be re-gathered. Answer no only for entries unrelated to the goal (chatter, routine commands, asides) or that restate something kept elsewhere.";

async function scoreChunk({ goal, chunk, model, timeoutMs, judge = decide }) {
  const SDK = loadSDK();
  const { noul } = SDK;
  const texts = chunk.map((e) => e.text.slice(0, MAX_ENTRY_CHARS));
  const questions = {};
  texts.forEach((text, i) => {
    questions[`e${i}`] = noul({ question: RELEVANCE_QUESTION, compare: ["`goal`", text] });
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

// Measured on eval/compact-cases.json (48 true supersession pairs, 20 pairs
// whose older entry must stay). The design's starting wording asked whether
// the later entry supersedes the older one "so that i adds nothing needed for
// goal that j does not already say"; it held the must-stay pairs to 0.42 but
// put only 12 of 48 true pairs at 0.6 or above (median 0.37), because almost
// any older status line says something its replacement does not repeat.
// Asking whether the older entry is out of date, with the same three ways
// out, held the must-stay pairs to 0.28 and put 30-31 of 48 at 0.6 or above
// (median 0.68), over three runs.
const SUPERSEDE_QUESTION = (i, j) =>
  `Is \`entries.${i}\` out of date because \`entries.${j}\`, written later, replaces it: the same item or subject with a newer status, a reversed decision, the item completed, or a corrected value? Answer no if they are about different items or subjects, if \`entries.${j}\` only adds detail to \`entries.${i}\`, or if \`entries.${i}\` holds a constraint, rule or identifier still needed for \`goal\` that \`entries.${j}\` omits.`;

// Unordered entries carry no time, so the question does not assert one.
// Measured on eval/compact-cases.json, unordered, every pair of each case
// asked (64 true pairs, 1676 questions): with the texts in a list referenced
// as `entries[3]`, the model took the lower index for the older entry. It
// answered that a case's newest status line was out of date because of an
// older one at 0.58, and 25 true pairs passed 0.6 with the reverse below 0.5.
// Keyed by hash, the same questions put 39-41 true pairs there, and the
// highest answer against a must-keep entry with its reverse below 0.5 fell
// to 0.48-0.52, over two runs. Telling the model in words that list order
// says nothing about time did not fix it.
const SUPERSEDE_QUESTION_UNORDERED = (i, j) =>
  `Is \`entries.${i}\` out of date because \`entries.${j}\` is newer and replaces it: the same item or subject with a newer status, a reversed decision, the item completed, or a corrected value? Answer no if they are about different items or subjects, if \`entries.${j}\` only adds detail to \`entries.${i}\`, or if \`entries.${i}\` holds a constraint, rule or identifier still needed for \`goal\` that \`entries.${j}\` omits.`;

// One request for up to CHUNK questions. The state holds only this chunk's
// texts, keyed by a short hash rather than listed: with a list, the model
// read the lower index as the older entry (see SUPERSEDE_QUESTION_UNORDERED).
// A pair marked `both` is asked in both directions: `ps` is whether i is out
// of date because of j, `psReverse` whether j is because of i.
// A failed request answers no pair: no supersession, so both entries stay.
async function judgePairs({ goal, pairs, all, model, timeoutMs, judge = decide }) {
  const SDK = loadSDK();
  const { noul } = SDK;
  const slot = new Map();
  const texts = {};
  const at = (idx) => {
    if (!slot.has(idx)) {
      const text = all[idx].text.slice(0, MAX_ENTRY_CHARS);
      let key;
      for (let salt = 0; !key || key in texts; salt++) key = `e${createHash("sha1").update(`${salt}:${idx}:${text}`).digest("hex").slice(0, 5)}`;
      slot.set(idx, key);
      texts[key] = text;
    }
    return slot.get(idx);
  };
  const ask = (Q, x, y) => noul({ question: Q(x, y), compare: [`\`entries.${x}\``, `\`entries.${y}\``] });
  const questions = {};
  pairs.forEach((pr, k) => {
    const a = at(pr.i);
    const b = at(pr.j);
    if (pr.both) {
      questions[`s${k}`] = ask(SUPERSEDE_QUESTION_UNORDERED, a, b);
      questions[`r${k}`] = ask(SUPERSEDE_QUESTION_UNORDERED, b, a);
    } else {
      questions[`s${k}`] = ask(SUPERSEDE_QUESTION, a, b);
    }
  });
  const res = await judge({
    state: { goal, entries: texts },
    questions,
    model,
    downstream: "compaction-supersede",
    timeoutMs,
  });
  const num = (r) => (r && Number.isFinite(Number(r.noul)) ? Number(r.noul) : null);
  if (res.fallback) return pairs.map((pr) => ({ ...pr, ps: null, psReverse: null, failed: true }));
  return pairs.map((pr, k) => {
    const ps = num(res.results[`s${k}`]);
    const psReverse = pr.both ? num(res.results[`r${k}`]) : null;
    return { ...pr, ps, psReverse, failed: ps === null || (pr.both && psReverse === null) };
  });
}

// Two passes, then one decision per entry.
// Relevance: every entry is scored against the goal; below `keepThreshold` it
// is dropped as irrelevant. `pinFirst` / `pinLast` survive unscored: the
// opening instructions and the most recent turns are load-bearing regardless
// of how they score.
// Supersession (`supersede`, default on): with `order: "chronological"`, each
// candidate pair (older i, later j) is asked whether j replaces i. With
// `order: "unordered"` (the default unless every entry has meta.ts), each pair
// is asked in both directions, and an entry is only replaced by the other when
// the reverse answer is below 0.5: if each says it replaces the other, both
// stay. An entry is dropped as superseded when the answer is at least
// `supersedeThreshold`, it is not pinned, and its replacement survives the
// final set -- or was itself superseded by an entry that does, and so on. If
// no replacement survives, it stays. Up to `allPairsUpTo` (60) entries, every
// pair is asked about, within `maxPairs` (2000); above that, only pairs that
// share an anchor or enough words.
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
  order,
  allPairsUpTo = 60,
  maxPairs = 2000,
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
  // A pinned entry is never dropped, so in chronological order it is never
  // asked about as the older one; it can still be the later one that
  // supersedes. Unordered pairs are asked both ways, so they stay whole.
  const mode = order || defaultOrder(all);
  const pairs = supersede ? candidatePairs(all, { maxPerEntry, order: mode, allPairsUpTo, maxPairs }).filter((pr) => pr.both || !pinnedIdx.has(pr.i)) : [];
  const perChunk = mode === "unordered" ? Math.floor(CHUNK / 2) : CHUNK;
  const pairChunks = [];
  for (let i = 0; i < pairs.length; i += perChunk) pairChunks.push(pairs.slice(i, i + perChunk));

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

  // Directed edges: x may be dropped as out of date because of y.
  const superseders = new Map();
  const edge = (x, y, ps, reverse) => {
    if (ps === null || ps < supersedeThreshold) return;
    if (reverse !== undefined && (reverse === null || reverse >= 0.5)) return;
    if (!superseders.has(x)) superseders.set(x, []);
    superseders.get(x).push({ j: y, ps, ...(reverse !== undefined ? { psReverse: reverse } : {}) });
  };
  for (const c of judgedChunks) {
    for (const pr of c) {
      if (!pr.both) { edge(pr.i, pr.j, pr.ps); continue; }
      edge(pr.i, pr.j, pr.ps, pr.psReverse);
      edge(pr.j, pr.i, pr.psReverse, pr.ps);
    }
  }

  // An entry is settled once every entry that may replace it is: it is
  // superseded if one of them survives (kept, or superseded itself, which is
  // what makes the rule transitive), else kept. Chronological edges always
  // point later, so this always finishes. Unordered edges can, in principle,
  // form a cycle of three or more; whatever a cycle leaves unsettled is kept.
  const rank = chronology(all);
  const status = all.map((e, i) => {
    if (pinnedIdx.has(i)) return "kept";
    const s = byId.get(e.id) || { p: 1 };
    return s.p < keepThreshold ? "irrelevant" : "pending";
  });
  const by = new Array(all.length);
  const survives = (x) => status[x] === "kept" || status[x] === "superseded";
  const settle = (i, final) => {
    const outs = superseders.get(i) || [];
    if (!final && outs.some((e) => status[e.j] === "pending")) return false;
    const live = outs.filter((e) => survives(e.j)).sort((a, b) => b.ps - a.ps || rank[b.j] - rank[a.j]);
    if (live.length) { status[i] = "superseded"; by[i] = live[0]; return true; }
    if (final) return false;
    status[i] = "kept";
    return true;
  };
  for (;;) {
    const pending = status.map((s, i) => (s === "pending" ? i : -1)).filter((i) => i >= 0);
    if (!pending.length) break;
    if (pending.filter((i) => settle(i, false)).length) continue;
    if (pending.filter((i) => settle(i, true)).length) continue;
    for (const i of pending) status[i] = "kept";
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
    else dropped.push({ ...s, reason: "superseded", supersededBy: all[by[i].j].id, ps: by[i].ps, ...(by[i].psReverse !== undefined ? { psReverse: by[i].psReverse } : {}) });
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
      order: supersede ? mode : undefined,
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
