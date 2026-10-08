// L5: tool output as a relevance filter.
//
// A long command output is read once, by the most expensive model in the loop,
// and most of it is passing checks, progress bars and install chatter. Keeping
// or dropping a block is a decision, so it belongs here, and like compaction it
// is a filter rather than a summary: every kept line is exactly what the
// command printed.
//
// Four layers, cheapest first:
//   floor   -- a block with an error or failure line, or a line saying how
//              the command finished, is kept without asking.
//   passing -- a list of three or more passing-test lines is dropped without
//              asking; the pinned summary line still carries the count.
//   repeat  -- a block identical to one already seen is dropped without asking.
//   model   -- everything else is scored against the goal; below `keep` drops.
// The first and last blocks are pinned: a command's first lines say what ran
// and its last lines are usually the summary.
//
// Every failure keeps everything. A dropped line cannot be recovered inside
// the reader's context; a kept one only costs tokens.
const { decide, loadSDK } = require("./decision-engine.cjs");
const { config } = require("./config.cjs");

const MAX_BLOCK_LINES = 12;
const CHUNK = 25;
const CONCURRENCY = 6;
const MAX_BLOCK_CHARS = 1500;
// More chunks than this and the output passes through: a huge log would be paid
// for and then dropped by the hook's time limit.
const MAX_CHUNKS = 8;

// Lines that are evidence on their own. Kept without a model call.
// Warnings are left to the model: most are deprecation chatter.
const FLOOR_WORDS = /\b(error|errors|fail|failed|failing|failure|fatal|panic|exception|traceback|assert(ion)?|not ok|denied|refused|segfault|cannot|unable)\b|\b[A-Z]\w*(Error|Exception)\b|\bERR_[A-Z_]+|✖|✗|✘|⨯|\bERR!|[\w@./-]+\.[a-z]{1,5}:\d+(:\d+)?\b/im;

// The lines inside a failure report that carry its values and its place:
// expected/received, a diff's +/- lines, a code frame, a stack or traceback frame.
const FLOOR_EVIDENCE = /^\s*(Expected|Received|expected|actual|Difference)\b|!==|===|^\s*[-+] \S|^\s*>?\s*\d+\s*\|\s|^\s+at\s|^\s*File "[^"]+", line \d+|^\s*\^+\s*$|\b(thread '.*' panicked|--- FAIL:|FAILED\b)/;
const FLOOR = { test: (line) => FLOOR_WORDS.test(line) || FLOOR_EVIDENCE.test(line) };

// A passing-test line. Its name can say "fails" without anything having failed,
// so these lines are never read by the floor.
const PASSING = /^\s*(✔|✓|√|ok \d+\b|PASS\b|\[PASS\]|[Pp]assed\b)/;
// How a command finished: the result line almost every goal needs.
const RESULT = /\b(built in|compiled (successfully|with)|done in|finished in|completed in|build (succeeded|complete)|\d+ (passing|passed|failed|failing)|tests? (passed|failed)|exit(ed)? (code|with))\b/i;
const floorHit = (text) => text.split("\n").some((line) => RESULT.test(line) || (!PASSING.test(line) && FLOOR.test(line)));
// A list of passes, not one status line: Vite prints "✓ built in 261ms" alone.
const allPassing = (text) => {
  const lines = text.split("\n");
  return lines.length >= 3 && lines.every((line) => PASSING.test(line));
};

// Measured on eval/filter-cases.json. Explicit keep criteria and a negative
// anchor; the structured `compare` form scored the one failing line at 0.18 on d1.
const QUESTION = (i) =>
  `Does \`blocks[${i}]\` contain information needed to achieve \`goal\` (an error, a failure, a file path or line that must be looked at, or a result the goal asks about)? Answer no for passing checks, routine progress, download or install chatter, and unrelated noise.`;

/**
 * Lines into blocks, cut at blank lines, at MAX_BLOCK_LINES, and wherever lines
 * switch between passing-test lines and anything else, so a failure never
 * shares a block with the passes around it. Line numbers are 1-based.
 */
function splitBlocks(text) {
  const lines = String(text).split("\n");
  const blocks = [];
  let current = null;
  lines.forEach((line, index) => {
    if (!line.trim()) {
      if (current) blocks.push(current);
      current = null;
      return;
    }
    if (current && PASSING.test(line) !== PASSING.test(current.lines[current.lines.length - 1])) {
      blocks.push(current);
      current = null;
    }
    if (!current) current = { start: index + 1, lines: [] };
    current.lines.push(line);
    if (current.lines.length >= MAX_BLOCK_LINES) {
      blocks.push(current);
      current = null;
    }
  });
  if (current) blocks.push(current);
  return blocks.map((block, i) => ({ id: i, start: block.start, end: block.start + block.lines.length - 1, text: block.lines.join("\n") }));
}

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

/** Scores for one chunk. Tries `engine`, then Jev; null when both failed. */
// Jev by default: it bills the shared state once a request, d1 once a question.
async function scoreChunk({ goal, chunk, engine, timeoutMs }) {
  const { noul } = loadSDK();
  const blocks = chunk.map((block) => block.text.slice(0, MAX_BLOCK_CHARS));
  const questions = Object.fromEntries(blocks.map((_, i) => [`b${i}`, noul(QUESTION(i))]));
  for (const which of engine === "jev" ? ["jev"] : [engine, "jev"]) {
    // The blocks are command output: logged as counts only, never as text.
    const res = await decide({ state: { goal, blocks }, questions, engine: which, downstream: "output-filter", timeoutMs, logState: false });
    if (res.fallback) continue;
    const scores = chunk.map((_, i) => (res.results[`b${i}`] ? Number(res.results[`b${i}`].noul) : null));
    if (scores.every((p) => Number.isFinite(p))) return { scores, engine: which };
  }
  return null;
}

/**
 * Filter `text` for `goal`. Returns the filtered text (kept blocks verbatim,
 * each dropped run replaced by one marker line) and what was done.
 */
async function filterOutput({ text, goal, engine = config.filterEngine, keep = config.filterKeep, timeoutMs = config.filterTimeoutMs, score = scoreChunk } = {}) {
  if (!goal) throw new Error("filterOutput: goal is required");
  const started = Date.now();
  const totalLines = String(text).split("\n").length;
  const blocks = splitBlocks(text);
  const unchanged = (why) => ({ text, changed: false, why, stats: { linesIn: totalLines, linesKept: totalLines, blocks: blocks.length, requests: 0, latencyMs: Date.now() - started } });
  if (blocks.length < 3) return unchanged("too few blocks to filter");
  if (score === scoreChunk && !loadSDK()) return unchanged("no SDK");

  const seen = new Set();
  const verdict = new Map(); // id -> { keep, why, p? }
  const toScore = [];
  // A failure report is often split by a blank line; the block after a failure keeps the rest of it.
  const afterFloor = new Set();
  blocks.forEach((block, i) => {
    if (i > 0 && floorHit(blocks[i - 1].text) && !allPassing(block.text)) afterFloor.add(i);
  });
  blocks.forEach((block, i) => {
    if (i === blocks.length - 1) verdict.set(block.id, { keep: true, why: "pinned" });
    else if (floorHit(block.text)) verdict.set(block.id, { keep: true, why: "floor" });
    else if (afterFloor.has(i)) verdict.set(block.id, { keep: true, why: "floor" });
    else if (allPassing(block.text)) verdict.set(block.id, { keep: false, why: "passing" });
    else if (i === 0) verdict.set(block.id, { keep: true, why: "pinned" });
    else if (seen.has(block.text)) verdict.set(block.id, { keep: false, why: "repeat" });
    else toScore.push(block);
    seen.add(block.text);
  });

  const chunks = [];
  for (let i = 0; i < toScore.length; i += CHUNK) chunks.push(toScore.slice(i, i + CHUNK));
  if (chunks.length > MAX_CHUNKS) return unchanged(`too long to score in time (${chunks.length} requests); nothing was dropped`);
  const scored = await pool(chunks, CONCURRENCY, (chunk) => score({ goal, chunk, engine, timeoutMs }));
  if (scored.some((result) => result === null)) return unchanged("the engines did not answer; nothing was dropped");
  const engines = new Set();
  chunks.forEach((chunk, c) => {
    engines.add(scored[c].engine);
    chunk.forEach((block, i) => {
      const p = scored[c].scores[i];
      verdict.set(block.id, { keep: p >= keep, why: "model", p });
    });
  });

  const out = [];
  let dropped = [];
  const flush = () => {
    if (!dropped.length) return;
    const lines = dropped.reduce((n, block) => n + block.end - block.start + 1, 0);
    const from = dropped[0].start;
    const to = dropped[dropped.length - 1].end;
    out.push(`[jev-filter: ${from === to ? `line ${from}` : `lines ${from}-${to}`} dropped (${lines} non-blank)]`);
    dropped = [];
  };
  let linesKept = 0;
  for (const block of blocks) {
    if (verdict.get(block.id).keep) {
      flush();
      out.push(block.text);
      linesKept += block.end - block.start + 1;
    } else dropped.push(block);
  }
  flush();
  const changed = blocks.some((block) => !verdict.get(block.id).keep);
  return {
    text: changed ? out.join("\n") : text,
    changed,
    why: changed ? "dropped blocks the goal does not need" : "every block was needed",
    verdicts: blocks.map((block) => ({ start: block.start, end: block.end, ...verdict.get(block.id) })),
    stats: {
      linesIn: totalLines,
      linesKept,
      blocks: blocks.length,
      floor: [...verdict.values()].filter((v) => v.why === "floor").length,
      requests: chunks.length,
      engines: [...engines],
      latencyMs: Date.now() - started,
    },
  };
}

module.exports = { filterOutput, splitBlocks, FLOOR, PASSING, QUESTION };
