#!/usr/bin/env node
// jev-verify --artifact-file F --requirements "<what it must do>" [--prohibit "rule"]... [--json]
// Exit: 0 accept, 3 escalate/revise, 2 usage error.
// The completion check that CLAUDE.md asks for, as a decision rather than a
// second opinion from another generative model.
const { readFileSync } = require("node:fs");
const { verifyOutput } = require("../lib/verify.cjs");

async function main() {
  const args = process.argv.slice(2);
  const get = (f, d = "") => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
  const all = (f) => args.reduce((acc, a, i) => (a === f && args[i + 1] ? [...acc, args[i + 1]] : acc), []);
  const requirements = get("--requirements");
  const file = get("--artifact-file");
  if (!requirements || !file) {
    console.error('Usage: jev-verify --artifact-file F --requirements "<...>" [--prohibit "rule"]... [--json]');
    process.exit(2);
  }
  const res = await verifyOutput({
    artifact: readFileSync(file, "utf8").slice(0, 20000),
    requirements,
    prohibitions: all("--prohibit"),
  });
  if (args.includes("--json")) console.log(JSON.stringify(res, null, 2));
  else {
    console.log(`${res.verdict.toUpperCase()}  [gate=${res.overallGate}${res.fallback ? " fallback" : ""}]`);
    for (const [id, r] of Object.entries(res.results || {})) {
      console.log(`  ${id}: ${r.decision} (${r.confidence.toFixed(2)}, ${r.gate})`);
    }
  }
  process.exit(res.verdict === "accept" ? 0 : 3);
}
main().catch((e) => { console.error("jev-verify:", String((e && e.message) || e).slice(0, 200)); process.exit(2); });
