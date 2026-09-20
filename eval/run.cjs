// Eval runner: offline gate-logic checks always run (no network, no key).
// Live Jev cases run only with --live and a key; missing key => skip, exit 0.
// A failing *expected label* with high confidence is a reliability flag;
// a failing label with low confidence on an uncertain-ok case counts as pass
// (escalate-path success).
const { gateAnswer, loadKey, loadSDK } = require("../lib/decision-engine.cjs");
const dataset = require("./dataset.json");

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`ok - ${name}`);
  } else {
    fail++;
    console.log(`FAIL - ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function offline() {
  console.log("# offline gate checks");
  check("choice auto", gateAnswer({ type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9 } }).gate === "auto");
  check("choice review", gateAnswer({ type: "choice", choice: "a", confidence: 0.7, probabilities: { a: 0.7 } }).gate === "review");
  check("choice escalate", gateAnswer({ type: "choice", choice: "a", confidence: 0.4, probabilities: { a: 0.4 } }).gate === "escalate");
  check("score auto", gateAnswer({ type: "score", score: 2.1, confidence: 0.95 }).gate === "auto");
  check("noul yes auto", gateAnswer({ type: "noul", noul: 0.93 }).decision === "yes" && gateAnswer({ type: "noul", noul: 0.93 }).gate === "auto");
  check("noul no auto", gateAnswer({ type: "noul", noul: 0.05 }).decision === "no");
  check("noul coin-flip escalates", gateAnswer({ type: "noul", noul: 0.51 }).gate === "escalate");
  check("malformed escalates", gateAnswer(null).gate === "escalate");
}

async function live() {
  console.log("# live Jev cases");
  const SDK = loadSDK();
  const key = loadKey();
  if (!SDK || !key) {
    console.log("skip - no SDK or key (offline pass only)");
    return;
  }
  process.env.TYPESAFE_API_KEY = key;
  const { TypeSafeClient, noul, score } = SDK;
  const { config } = require("../lib/config.cjs");
  const client = new TypeSafeClient({ defaultModel: config.model });
  for (const c of dataset.cases) {
    let q;
    if (c.question.type === "noul") q = { [c.question.id]: noul(c.question.instructions) };
    else if (c.question.type === "score")
      q = {
        [c.question.id]: score(c.question.instruct || c.question.instructions, [
          "Filler: compact listing only",
          "Standard card",
          "Section lead",
          "Homepage hero",
        ]),
      };
    else continue;
    let res;
    try {
      res = await client.systemOne({ state: c.state, questions: q, model: config.model });
    } catch (e) {
      check(`${c.id} (api reachable)`, false, String((e && e.message) || e).slice(0, 100));
      continue;
    }
    const ans = res.answers[c.question.id];
    const g = gateAnswer(ans);
    if (c.expected === "uncertain-ok") {
      check(`${c.id} (uncertain handled via ${g.gate})`, g.gate !== "auto", `decision=${g.decision} conf=${g.confidence.toFixed(2)}`);
    } else if (c.question.type === "noul") {
      const okLabel = g.decision === c.expected;
      check(`${c.id} (label=${g.decision} conf=${g.confidence.toFixed(2)})`, okLabel || g.gate !== "auto", okLabel ? "" : "low-confidence escalate accepted");
      if (!okLabel && g.gate === "auto") console.log(`  RELIABILITY FLAG: wrong label with high confidence on ${c.id}`);
    } else {
      const lo = c.expected === "low-score";
      const s = Number(ans.score);
      check(`${c.id} (score=${s.toFixed(2)})`, lo ? s < 1.0 : true);
    }
  }
}

async function main() {
  offline();
  if (process.argv.includes("--live")) await live();
  else console.log("# live cases skipped (run with --live for API eval)");
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error("ERR", String((e && e.message) || e).slice(0, 200));
  process.exit(1);
});
