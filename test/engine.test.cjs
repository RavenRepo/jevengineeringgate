// Offline tests: config defaults/env, gating boundaries, sanitizer.
// No network, no key required.
const { test } = require("node:test");
const assert = require("node:assert/strict");

test("config defaults are the calibrated operating point, not the guide's starting values", () => {
  delete process.env.JEV_AUTO_THRESHOLD;
  delete process.env.JEV_REVIEW_THRESHOLD;
  delete require.cache[require.resolve("../lib/config.cjs")];
  const { config } = require("../lib/config.cjs");
  // Generic gates: the guide's starting values, still unfitted.
  assert.equal(config.autoThreshold, 0.85);
  assert.equal(config.reviewThreshold, 0.6);
  // Intake gates: fitted by eval/calibrate.cjs. If you change one by hand this
  // test should fail -- re-record and re-sweep instead.
  assert.equal(config.clarifyThreshold, 0.885);
  assert.equal(config.securityThreshold, 0.905);
  assert.equal(config.archThreshold, 0.875);
  assert.equal(config.riskThreshold, 1.93);
  assert.equal(config.model, process.env.TYPESAFE_DEFAULT_MODEL || "jev-latest");
});

test("calibrated thresholds sit above every should-not-fire value in the dataset", () => {
  // Guards the property the sweep enforces: no threshold below a labeled
  // negative. A recording drifting under a threshold means re-calibrate.
  const { existsSync, readFileSync } = require("node:fs");
  const recPath = require("node:path").join(__dirname, "../eval/calibration.json");
  if (!existsSync(recPath)) return; // recording is optional in a fresh checkout
  delete require.cache[require.resolve("../lib/config.cjs")];
  const { config } = require("../lib/config.cjs");
  const rows = JSON.parse(readFileSync(recPath, "utf8")).rows;
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  const dims = [
    ["needs_clarification", "unclear", config.clarifyThreshold],
    ["security_sensitive", "security", config.securityThreshold],
    ["architecture_change", "architecture", config.archThreshold],
    ["change_risk", "risky", config.riskThreshold],
  ];
  for (const c of require("../eval/requests.json").cases) {
    const row = byId[c.id];
    if (!row) continue;
    for (const [dim, label, threshold] of dims) {
      if (!c.dims[label]) {
        assert.ok(row[dim] < threshold, `${c.id}: ${dim}=${row[dim]} should stay under ${threshold}`);
      }
    }
  }
});

test("config honors env overrides", () => {
  process.env.JEV_AUTO_THRESHOLD = "0.9";
  process.env.JEV_MODEL = "jev-1.13.0";
  delete require.cache[require.resolve("../lib/config.cjs")];
  const { config } = require("../lib/config.cjs");
  assert.equal(config.autoThreshold, 0.9);
  assert.equal(config.model, "jev-1.13.0");
  delete process.env.JEV_AUTO_THRESHOLD;
  delete process.env.JEV_MODEL;
  delete require.cache[require.resolve("../lib/config.cjs")];
});

test("gateAnswer boundaries", () => {
  delete require.cache[require.resolve("../lib/config.cjs")];
  delete require.cache[require.resolve("../lib/decision-engine.cjs")];
  const { gateAnswer } = require("../lib/decision-engine.cjs");
  assert.equal(gateAnswer({ type: "choice", choice: "x", confidence: 0.85 }).gate, "auto");
  assert.equal(gateAnswer({ type: "choice", choice: "x", confidence: 0.6 }).gate, "review");
  assert.equal(gateAnswer({ type: "choice", choice: "x", confidence: 0.59 }).gate, "escalate");
  assert.equal(gateAnswer({ type: "noul", noul: 0.5 }).gate, "escalate");
  assert.equal(gateAnswer(null).gate, "escalate");
});

test("sanitizeState redacts secrets and truncates", () => {
  const { sanitizeState } = require("../lib/decision-engine.cjs");
  const out = sanitizeState({ api_key: "abc", goal: "x" });
  assert.equal(out.api_key, "[redacted]");
  const big = sanitizeState({ blob: "y".repeat(9000) });
  assert.equal(big._truncated, true);
});

test("decide refuses empty questions instead of guessing", async () => {
  const { decide } = require("../lib/decision-engine.cjs");
  await assert.rejects(() => decide({ state: {}, questions: {} }), /non-empty/);
});
