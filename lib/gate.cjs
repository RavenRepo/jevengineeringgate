// Task-intake risk gate: one Jev call, six judgments, severity-ordered decision.
// Single source of truth for `jev-gate`, the UserPromptSubmit intake hook, and
// any caller that needs "should an agent start this work unsupervised?".
//
// Two properties the first version lacked and that callers depend on:
//   1. Severity ordering. A destructive request is HUMAN_APPROVAL even when it
//      also reads as vague; ambiguity is the weakest signal, so it sorts last.
//   2. No masking. `reasons` lists every dimension that tripped, so a caller
//      sees security=0.96 even when the headline decision is HUMAN_APPROVAL.
const { decide, loadSDK } = require("./decision-engine.cjs");
const { config } = require("./config.cjs");

// Higher wins. IMPLEMENT is the absence of a tripped dimension.
const SEVERITY = {
  HUMAN_APPROVAL: 4,
  SECURITY_REVIEW: 3,
  ARCHITECTURE_REVIEW: 2,
  ASK_USER: 1,
  IMPLEMENT: 0,
};

// Deterministic floor. Applies when Jev is unreachable, and is also consulted
// by the tool gate so a model outage can never turn a destructive verb into an
// automatic yes.
const DESTRUCTIVE_RE =
  /(\bdelete\b|\bdrop\s|\bdestroy\b|\btruncate\b|rm\s+-rf|\bproduction\b|\bprod\s(?:data|db|deploy)|\bpassword\b|\bsecret\b|\bcredential\b|\bauth(?:entication|orization)?\b|\bmigrat(?:e|ion)\b|\bdeploy\b|\bmerge\b|\bforce[- ]push\b|\bpayment\b|\bpii\b|personal data)/i;
const VAGUE_RE = /^(?:how|what|which|should|is|are|can|do|does|why)\b/i;

function fallbackDecision(request) {
  if (DESTRUCTIVE_RE.test(request)) {
    return {
      decision: "HUMAN_APPROVAL",
      reasons: [{ dimension: "keyword", value: null, threshold: null, note: "destructive keyword" }],
      fallback: true,
      reason: "fallback-keyword",
    };
  }
  if ((VAGUE_RE.test(request) || /\?\s*$/.test(request)) && request.length < 80) {
    return {
      decision: "ASK_USER",
      reasons: [{ dimension: "keyword", value: null, threshold: null, note: "short question form" }],
      fallback: true,
      reason: "fallback-possibly-vague",
    };
  }
  return { decision: "IMPLEMENT:general", reasons: [], fallback: true, reason: "fallback-default" };
}

function buildQuestions(SDK) {
  const { choice, noul, score } = SDK;
  return {
    task_type: choice("What type of engineering task is `user_request`?", {
      feature: "A new product capability.",
      bugfix: "A correction to existing behavior.",
      refactor: "Restructuring without intended behavior change.",
      security: "Security-sensitive change or vulnerability.",
      infrastructure: "Deployment, infra, CI/CD, or operations.",
      dependency: "Dependency or package change.",
      documentation: "Docs or comments only.",
      unclear: "Cannot be classified reliably.",
    }),
    architecture_change: noul(
      "Would `user_request` change a system boundary, public interface, data model, or how components depend on each other? Answer no for work contained inside one existing module that keeps its current interface.",
    ),
    security_sensitive: noul(
      "Does `user_request` or `repo` touch authentication, authorization, secrets, payments, personal data, production credentials, or a security control?",
    ),
    change_risk: score("How risky is autonomous implementation of `user_request`?", [
      "Low: read-only, docs, tests, easily reversible.",
      "Moderate: app code changes, testable and reversible.",
      "High: auth, migrations, infra, permissions, prod data, destructive or hard-to-reverse.",
    ]),
    // Rewritten. The original asked whether "a competent engineer must ask for
    // details", a meta-judgment Jev answered yes to on ~4 of 5 real requests
    // (a README typo fix scored 0.80). This asks the concrete, checkable thing:
    // is a required input actually absent? The explicit negative anchor pulls
    // the head off its ceiling so the threshold has usable range below it.
    needs_clarification: noul(
      "Does `user_request` omit a required input — no identifiable target to change (file, component, command, or system), or no identifiable desired outcome — so that work cannot begin without guessing what the user wants? Answer no when a competent engineer could make a concrete first edit from `user_request` plus `repo`, even if smaller details need reasonable defaults.",
    ),
    specialist: choice("Best next handler for `user_request`?", {
      general: "Normal implementation.",
      debugging: "Diagnose existing failures.",
      architecture: "Architectural analysis.",
      security: "Security-focused analysis.",
      testing: "Test design or verification.",
      infrastructure: "Deploy, CI/CD, cloud, infra.",
    }),
  };
}

// Pure: raw signals + thresholds -> decision. Separated from the API call so
// the calibration sweep can replay recorded probabilities without spending a
// single token re-querying the model.
function classify(signals, thresholds = config) {
  const reasons = [];
  const add = (dimension, value, threshold, decision) => {
    if (value === null || value === undefined) return;
    if (value >= threshold) reasons.push({ dimension, value: +value.toFixed(3), threshold, decision });
  };
  // Order of evaluation does not matter; severity picks the winner.
  add("change_risk", signals.change_risk, thresholds.riskThreshold, "HUMAN_APPROVAL");
  add("security_sensitive", signals.security_sensitive, thresholds.securityThreshold, "SECURITY_REVIEW");
  add("architecture_change", signals.architecture_change, thresholds.archThreshold, "ARCHITECTURE_REVIEW");
  add("needs_clarification", signals.needs_clarification, thresholds.clarifyThreshold, "ASK_USER");

  let decision = "IMPLEMENT";
  for (const r of reasons) {
    if (SEVERITY[r.decision] > SEVERITY[decision]) decision = r.decision;
  }
  reasons.sort((a, b) => SEVERITY[b.decision] - SEVERITY[a.decision]);
  return { decision, severity: SEVERITY[decision], reasons };
}

async function gateRequest({ request, diff = "", repo = {}, model } = {}) {
  if (!request || !String(request).trim()) throw new Error("gateRequest: request is required");
  const SDK = loadSDK();
  if (!SDK) return { ...fallbackDecision(request), signals: {}, severity: null };

  const state = { user_request: request, repo, git_diff: String(diff).slice(0, 6000) };
  const res = await decide({
    state,
    questions: buildQuestions(SDK),
    model,
    downstream: "jev-gate",
  });
  if (res.fallback) {
    return { ...fallbackDecision(request), signals: {}, severity: null, apiReason: res.reason };
  }

  const r = res.results;
  const signals = {
    change_risk: r.change_risk ? Number(r.change_risk.score) : null,
    security_sensitive: r.security_sensitive ? Number(r.security_sensitive.noul) : null,
    architecture_change: r.architecture_change ? Number(r.architecture_change.noul) : null,
    needs_clarification: r.needs_clarification ? Number(r.needs_clarification.noul) : null,
  };
  const { decision, severity, reasons } = classify(signals);
  const specialist = r.specialist ? r.specialist.choice : "general";
  return {
    decision: decision === "IMPLEMENT" ? `IMPLEMENT:${specialist}` : decision,
    severity,
    reasons,
    signals: {
      risk: signals.change_risk === null ? null : +signals.change_risk.toFixed(2),
      security: signals.security_sensitive === null ? null : +signals.security_sensitive.toFixed(3),
      architecture: signals.architecture_change === null ? null : +signals.architecture_change.toFixed(3),
      unclear: signals.needs_clarification === null ? null : +signals.needs_clarification.toFixed(3),
    },
    task_type: r.task_type ? r.task_type.choice : "unclear",
    specialist,
    fallback: false,
    requestId: res.requestId,
    latencyMs: res.latencyMs,
  };
}

module.exports = {
  gateRequest,
  classify,
  buildQuestions,
  fallbackDecision,
  SEVERITY,
  DESTRUCTIVE_RE,
};
