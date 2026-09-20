// App patterns on top of the decision layer: output verification (LLM -> Jev
// -> policy) and model routing (Jev judges, code routes). Jev never executes.
const { join } = require("node:path");
const { decide } = require("./decision-engine.cjs");
const { ROOT } = require("./config.cjs");

function loadSDKShapes() {
  try {
    return require("@typesafe-ai/sdk");
  } catch {}
  try {
    return require(join(ROOT, "node_modules", "@typesafe-ai", "sdk"));
  } catch {}
  return null;
}

// Verify a generated artifact before accept/revise/escalate. Each check is one
// atomic noul question; caller maps overallGate to policy.
async function verifyOutput({ artifact, requirements, prohibitions = [], model } = {}) {
  const SDK = loadSDKShapes();
  if (!SDK) throw new Error("verifyOutput: SDK not installed");
  const questions = {
    meets_requirements: SDK.noul(
      "Does `artifact` satisfy `requirements`?",
    ),
  };
  prohibitions.slice(0, 6).forEach((rule, i) => {
    questions[`violates_${i}`] = SDK.noul(
      `Does \`artifact\` violate this rule: ${rule}`,
    );
  });
  const res = await decide({
    state: { artifact, requirements, prohibitions },
    questions,
    model,
    downstream: "verify-output",
  });
  if (res.fallback) return { ...res, verdict: "escalate" };
  const bad = Object.entries(res.results).some(
    ([id, r]) => id.startsWith("violates_") && r.decision === "yes" && r.gate === "auto",
  );
  const ok =
    res.results.meets_requirements &&
    res.results.meets_requirements.decision === "yes" &&
    res.results.meets_requirements.gate === "auto";
  return { ...res, verdict: bad ? "escalate" : ok ? "accept" : res.overallGate };
}

// Judge difficulty/risk; returns scores, caller selects the route
// (deterministic code | cheap model | strong model | human).
async function routeTask({ request, context = {}, model } = {}) {
  const SDK = loadSDKShapes();
  if (!SDK) throw new Error("routeTask: SDK not installed");
  const res = await decide({
    state: { request, context },
    questions: {
      difficulty: SDK.score("How difficult is this engineering task?", [
        "Trivial: deterministic code or a single lookup.",
        "Routine: standard implementation or short reasoning.",
        "Hard: multi-step reasoning, ambiguity, or significant blast radius.",
      ]),
      risk: SDK.score("How risky is autonomous action here?", [
        "Low: read-only, docs, tests, easily reversible.",
        "Moderate: app code changes, testable and reversible.",
        "High: auth, migrations, infra, permissions, prod data, destructive.",
      ]),
      needs_human: SDK.noul(
        "Does this require a human decision before acting?",
      ),
    },
    model,
    downstream: "model-routing",
  });
  if (res.fallback) return { ...res, route: "human" };
  const risk = res.results.risk ? Number(res.results.risk.decision) : 2;
  const diff = res.results.difficulty ? Number(res.results.difficulty.decision) : 2;
  const human =
    res.results.needs_human &&
    res.results.needs_human.decision === "yes" &&
    res.results.needs_human.gate !== "auto"
      ? false
      : res.results.needs_human
        ? res.results.needs_human.decision === "yes"
        : true;
  let route = "cheap-model";
  if (human || risk >= 1.5) route = "human";
  else if (diff >= 1.5) route = "strong-model";
  else if (diff < 0.5 && risk < 0.5 && res.overallGate === "auto") route = "deterministic";
  return { ...res, route };
}

module.exports = { verifyOutput, routeTask };
