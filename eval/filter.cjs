// Live replay of eval/filter-cases.json: for each engine and keep threshold,
// how many must-keep lines survived (recall) and how much was cut (reduction).
// The default threshold is the largest cut that loses no must-keep line.
//   node eval/filter.cjs [--engines liquid,jev] [--keeps 0.3,0.5,0.7]
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { filterOutput } = require("../lib/filter.cjs");

const args = process.argv.slice(2);
const list = (flag, fallback) => { const i = args.indexOf(flag); return (i >= 0 ? args[i + 1] : fallback).split(","); };
const engines = list("--engines", "liquid,jev");
const keeps = list("--keeps", "0.3,0.5,0.7").map(Number);
const { cases } = JSON.parse(readFileSync(join(__dirname, "filter-cases.json"), "utf8"));

(async () => {
  for (const engine of engines) {
    for (const keep of keeps) {
      let must = 0, kept = 0, linesIn = 0, linesOut = 0, calls = 0;
      const misses = [];
      for (const c of cases) {
        const text = readFileSync(join(__dirname, "filter-fixtures", c.file), "utf8");
        const res = await filterOutput({ text, goal: c.goal, engine, keep });
        if (res.why.startsWith("the engines did not answer")) misses.push(`${c.id}: engines failed`);
        for (const line of c.mustKeep) {
          must += 1;
          if (res.text.includes(line)) kept += 1;
          else misses.push(`${c.id}: lost "${line}"`);
        }
        linesIn += res.stats.linesIn;
        linesOut += res.text.split("\n").length;
        calls += res.stats.requests;
      }
      const cut = (((linesIn - linesOut) / linesIn) * 100).toFixed(1);
      console.log(`${engine.padEnd(6)} keep=${keep.toFixed(2)}  recall ${kept}/${must}  cut ${cut}% (${linesIn}→${linesOut} lines)  ${calls} requests${misses.length ? "\n    " + misses.join("\n    ") : ""}`);
    }
  }
})();
