// Offline tests for the intake gate's pure logic. No network, no key.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { classify, fallbackDecision, SEVERITY, DESTRUCTIVE_RE } = require("../lib/gate.cjs");

const T = { riskThreshold: 1.93, securityThreshold: 0.905, archThreshold: 0.875, clarifyThreshold: 0.885 };

test("severity ordering: a destructive request is not downgraded to vague", () => {
  // The original defect. Every dimension trips; ambiguity must not win.
  const r = classify(
    { change_risk: 2.0, security_sensitive: 0.95, architecture_change: 0.9, needs_clarification: 0.97 },
    T,
  );
  assert.equal(r.decision, "HUMAN_APPROVAL");
  assert.equal(r.severity, SEVERITY.HUMAN_APPROVAL);
});

test("no masking: every tripped dimension is reported", () => {
  const r = classify(
    { change_risk: 2.0, security_sensitive: 0.96, architecture_change: 0.5, needs_clarification: 0.2 },
    T,
  );
  const dims = r.reasons.map((x) => x.dimension);
  assert.ok(dims.includes("change_risk"));
  assert.ok(dims.includes("security_sensitive"), "a masked security signal must still be listed");
  assert.ok(!dims.includes("architecture_change"));
});

test("reasons are sorted strongest first", () => {
  const r = classify(
    { change_risk: 2.0, security_sensitive: 0.96, architecture_change: 0.9, needs_clarification: 0.95 },
    T,
  );
  const sev = r.reasons.map((x) => SEVERITY[x.decision]);
  assert.deepEqual(sev, [...sev].sort((a, b) => b - a));
});

test("a clear low-risk request implements", () => {
  const r = classify(
    { change_risk: 0.0, security_sensitive: 0.02, architecture_change: 0.09, needs_clarification: 0.81 },
    T,
  );
  assert.equal(r.decision, "IMPLEMENT");
  assert.equal(r.reasons.length, 0);
});

test("calibrated clarify threshold no longer escalates a README typo fix", () => {
  // Recorded value for `fix a typo in the README heading` was 0.81-0.84.
  // The old 0.70 threshold escalated it; 0.885 does not.
  assert.equal(classify({ needs_clarification: 0.84 }, T).decision, "IMPLEMENT");
  assert.equal(classify({ needs_clarification: 0.84 }, { ...T, clarifyThreshold: 0.7 }).decision, "ASK_USER");
});

test("genuinely vague requests still escalate", () => {
  assert.equal(classify({ needs_clarification: 0.93 }, T).decision, "ASK_USER");
});

test("missing signals never trip a gate", () => {
  const r = classify({ change_risk: null, security_sensitive: undefined }, T);
  assert.equal(r.decision, "IMPLEMENT");
});

test("threshold is inclusive at the boundary", () => {
  assert.equal(classify({ change_risk: 1.93 }, T).decision, "HUMAN_APPROVAL");
  assert.equal(classify({ change_risk: 1.9299 }, T).decision, "IMPLEMENT");
});

test("keyword fallback is conservative when the API is unreachable", () => {
  assert.equal(fallbackDecision("drop the production database").decision, "HUMAN_APPROVAL");
  assert.equal(fallbackDecision("deploy to prod").decision, "HUMAN_APPROVAL");
  assert.equal(fallbackDecision("what is this?").decision, "ASK_USER");
  assert.ok(fallbackDecision("add a unit test for the date helper").decision.startsWith("IMPLEMENT"));
});

test("destructive pattern covers the verbs the tool gate relies on", () => {
  for (const s of ["rm -rf build", "drop table users", "force-push to main", "deploy the app", "rotate the secret"]) {
    assert.ok(DESTRUCTIVE_RE.test(s), `expected destructive: ${s}`);
  }
  assert.ok(!DESTRUCTIVE_RE.test("add a unit test"));
});
