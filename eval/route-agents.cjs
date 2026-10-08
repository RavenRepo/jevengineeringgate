// Live replay of eval/route-agents.json on Jev: the routing each case gets,
// the downgrades below their label (unsafe), and the calls left stronger than
// needed (money left on the table).
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { routeAgent } = require("../lib/route-agent.cjs");

const RANK = { haiku: 0, sonnet: 1, inherit: 2 };
const { cases } = JSON.parse(readFileSync(join(__dirname, "route-agents.json"), "utf8"));
// Replayed as from an Opus session, so Sonnet and Haiku are both downgrades.
const { mkdtempSync, writeFileSync } = require("node:fs");
const transcriptPath = join(mkdtempSync(join(require("node:os").tmpdir(), "jev-route-eval-")), "t.jsonl");
writeFileSync(transcriptPath, '{"message":{"model":"claude-opus-5-5"}}\n');
(async () => {
  let unsafe = 0, exact = 0, stronger = 0;
  for (const c of cases) {
    const r = await routeAgent({ prompt: c.prompt, subagent_type: c.type, description: c.id }, { transcriptPath });
    const got = r.model || "inherit";
    const verdict = RANK[got] < RANK[c.label] ? "UNSAFE" : RANK[got] > RANK[c.label] ? "stronger" : "ok";
    if (verdict === "UNSAFE") unsafe += 1; else if (verdict === "ok") exact += 1; else stronger += 1;
    console.log(`${verdict.padEnd(8)} ${c.id.padEnd(16)} label=${c.label.padEnd(7)} got=${got.padEnd(7)} ${r.why}`);
  }
  console.log(`\n${exact}/${cases.length} exact, ${stronger} left stronger, ${unsafe} unsafe downgrades`);
})();
