#!/usr/bin/env node
// jev-filter --goal "<goal>" [--file out.txt|-] [--keep 0.5] [--engine liquid|jev] [--json]
// Long command output in, the lines the goal needs out, verbatim. Each dropped
// run becomes one "[jev-filter: lines a-b dropped]" marker. Any failure prints
// the input unchanged.
//   npm test 2>&1 | jev-filter --goal "why the tests fail"
const { readFileSync } = require("node:fs");
const { filterOutput } = require("../lib/filter.cjs");

async function main() {
  const args = process.argv.slice(2);
  const get = (f, d = "") => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
  const goal = get("--goal");
  if (!goal) {
    console.error('Usage: jev-filter --goal "<goal>" [--file out.txt|-] [--keep 0.5] [--engine liquid|jev] [--json]');
    process.exit(2);
  }
  const file = get("--file", "-");
  const text = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  let res;
  try {
    res = await filterOutput({ text, goal, ...(get("--keep") ? { keep: Number(get("--keep")) } : {}), ...(get("--engine") ? { engine: get("--engine") } : {}) });
  } catch (e) {
    process.stdout.write(text);
    console.error("jev-filter: kept everything:", String((e && e.message) || e).slice(0, 200));
    process.exit(0);
  }
  if (args.includes("--json")) return console.log(JSON.stringify(res, null, 2));
  process.stdout.write(res.text.endsWith("\n") ? res.text : res.text + "\n");
  const s = res.stats;
  console.error(`[jev-filter] kept ${s.linesKept}/${s.linesIn} lines, ${s.requests} request(s) on ${(s.engines || []).join("+") || "no engine"}, ${s.latencyMs}ms — ${res.why}`);
}
main();
