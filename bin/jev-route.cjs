#!/usr/bin/env node
// jev-route --request "<task>" [--json]
// Prints deterministic | cheap-model | strong-model | human.
// Jev judges difficulty and risk; this prints the route. Code still picks the
// model -- the decision layer never selects a capability for itself.
const { routeTask } = require("../lib/verify.cjs");

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--request");
  const request = i >= 0 && args[i + 1] ? args[i + 1] : args.filter((a) => !a.startsWith("--"))[0] || "";
  if (!request) { console.error('Usage: jev-route --request "<task>" [--json]'); process.exit(2); }
  const res = await routeTask({ request });
  if (args.includes("--json")) console.log(JSON.stringify(res, null, 2));
  else {
    const d = res.results.difficulty, r = res.results.risk;
    console.log(`${res.route}  [difficulty=${d ? d.decision.toFixed(2) : "?"} risk=${r ? r.decision.toFixed(2) : "?"} gate=${res.overallGate}]`);
  }
  process.exit(0);
}
main().catch((e) => { console.error("jev-route:", String((e && e.message) || e).slice(0, 200)); process.exit(2); });
