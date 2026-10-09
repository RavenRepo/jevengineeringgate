#!/usr/bin/env node
// jev-compact --goal "<goal>" [--file entries.json|-] [--keep 0.5] [--pin-first N] [--pin-last N]
//   [--no-supersede] [--supersede-threshold N] [--order chronological|unordered]
//   [--all-pairs-up-to N] [--max-pairs N] [--json]
// Entries: a JSON array of strings/objects, or JSONL, on stdin or in --file.
// Prints the surviving entries; --json prints the full result with scores.
// Entries another entry supersedes are dropped too; --no-supersede turns that off.
// --order: "chronological" trusts index order (or meta.ts); "unordered", the
// default unless every entry has meta.ts, asks each pair in both directions.
// --all-pairs-up-to N: with at most N entries, ask every pair, not only those
// sharing an anchor (default 0), within --max-pairs (default 2000).
const { readFileSync } = require("node:fs");
const { filterEntries, SUPERSEDE_THRESHOLD } = require("../lib/compact.cjs");

const USAGE =
  'Usage: jev-compact --goal "<goal>" [--file entries.json|-] [--keep 0.5] [--pin-first N] [--pin-last N] [--no-supersede] [--supersede-threshold N] [--order chronological|unordered] [--all-pairs-up-to N] [--max-pairs N] [--json]';

function parseEntries(raw) {
  const t = raw.trim();
  if (!t) return [];
  if (t.startsWith("[")) return JSON.parse(t);
  return t.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return line; }
  });
}

// The filterEntries options a command line asks for, without the entries.
// Throws on a value it cannot use: an unknown --order, a number that does not
// parse (0,6), or a flag whose value is missing or is another flag.
function options(args) {
  const get = (f, d = "") => {
    const i = args.indexOf(f);
    if (i < 0) return d;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${f} needs a value`);
    return v;
  };
  const num = (f, d) => {
    const v = get(f, d);
    const n = Number(v);
    if (v.trim() === "" || !Number.isFinite(n)) throw new Error(`${f} must be a number, not "${v}"`);
    return n;
  };
  const order = get("--order") || undefined;
  if (order && order !== "chronological" && order !== "unordered") throw new Error(`--order must be chronological or unordered, not "${order}"`);
  return {
    goal: get("--goal"),
    keepThreshold: num("--keep", "0.5"),
    pinFirst: num("--pin-first", "0"),
    pinLast: num("--pin-last", "0"),
    supersede: !args.includes("--no-supersede"),
    supersedeThreshold: num("--supersede-threshold", String(SUPERSEDE_THRESHOLD)),
    order,
    allPairsUpTo: num("--all-pairs-up-to", "0"),
    maxPairs: num("--max-pairs", "2000"),
  };
}

// `judge` and `out` exist for tests: the judge in place of the engine, the
// output sinks in place of the console.
async function run(args, { input, judge, out = console.log, err = console.error } = {}) {
  let opts;
  try {
    opts = options(args);
  } catch (e) {
    err(`jev-compact: ${e.message}`);
    err(USAGE);
    return 2;
  }
  if (!opts.goal) {
    err(USAGE);
    return 2;
  }
  const file = args.includes("--file") ? args[args.indexOf("--file") + 1] : "-";
  const raw = input ?? (file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8"));
  const res = await filterEntries({ ...opts, entries: parseEntries(raw), ...(judge ? { judge } : {}) });
  if (args.includes("--json")) {
    out(JSON.stringify(res, null, 2));
  } else {
    for (const e of res.kept) out(e.text);
    const s = res.stats;
    err(`[jev-compact] kept ${s.entriesKept}/${s.entriesIn} entries (${s.superseded} superseded), -${s.reductionPct}% chars, ${s.requests + s.supersedeRequests} request(s), ${s.latencyMs}ms`);
  }
  return 0;
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then((code) => { if (code) process.exit(code); })
    .catch((e) => { console.error("jev-compact:", String((e && e.message) || e).slice(0, 200)); process.exit(1); });
}

module.exports = { run, options, parseEntries };
