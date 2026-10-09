#!/usr/bin/env node
// jev-compact --goal "<goal>" [--file entries.json|-] [--keep 0.5] [--pin-first N] [--pin-last N] [--no-supersede] [--supersede-threshold N] [--order chronological|unordered] [--json]
// Entries: a JSON array of strings/objects, or JSONL, on stdin or in --file.
// Prints the surviving entries; --json prints the full result with scores.
// Entries a later entry supersedes are dropped too; --no-supersede turns that off.
// --order: "chronological" trusts index order (or meta.ts); "unordered", the
// default unless every entry has meta.ts, asks each pair in both directions.
const { readFileSync } = require("node:fs");
const { filterEntries, SUPERSEDE_THRESHOLD } = require("../lib/compact.cjs");

function parseEntries(raw) {
  const t = raw.trim();
  if (!t) return [];
  if (t.startsWith("[")) return JSON.parse(t);
  return t.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return line; }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const get = (f, d = "") => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
  const goal = get("--goal");
  if (!goal) {
    console.error('Usage: jev-compact --goal "<goal>" [--file entries.json|-] [--keep 0.5] [--pin-first N] [--pin-last N] [--no-supersede] [--supersede-threshold N] [--order chronological|unordered] [--json]');
    process.exit(2);
  }
  const file = get("--file", "-");
  const raw = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  const res = await filterEntries({
    goal,
    entries: parseEntries(raw),
    keepThreshold: Number(get("--keep", "0.5")),
    pinFirst: Number(get("--pin-first", "0")),
    pinLast: Number(get("--pin-last", "0")),
    supersede: !args.includes("--no-supersede"),
    supersedeThreshold: Number(get("--supersede-threshold", String(SUPERSEDE_THRESHOLD))),
    order: get("--order") || undefined,
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    for (const e of res.kept) console.log(e.text);
    const s = res.stats;
    console.error(`[jev-compact] kept ${s.entriesKept}/${s.entriesIn} entries (${s.superseded} superseded), -${s.reductionPct}% chars, ${s.requests + s.supersedeRequests} request(s), ${s.latencyMs}ms`);
  }
}
main().catch((e) => { console.error("jev-compact:", String((e && e.message) || e).slice(0, 200)); process.exit(1); });
