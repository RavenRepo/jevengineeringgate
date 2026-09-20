// Shared Jev configuration. Env-overridable, no secrets printed.
// JEV_MODEL: default jev-latest (current behavior). Pin production with JEV_MODEL=jev-1.13.0.
// JEV_AUTO_THRESHOLD / JEV_REVIEW_THRESHOLD: generic confidence gates (guide defaults 0.85 / 0.60).
// JEV_CLARIFY_THRESHOLD / JEV_SECURITY_THRESHOLD / JEV_ARCH_THRESHOLD: noul gates for jev-gate.
// JEV_RISK_THRESHOLD: score gate for change_risk (rubric 0..2).
// JEV_TIMEOUT_MS: per-attempt API timeout. JEV_LOG_FILE: JSONL observability sink.
// JEV_TOOL_* : PreToolUse tool gate (see lib/tool-gate.cjs).
//
// The four gate thresholds below are fitted, not chosen. `node eval/calibrate.cjs`
// sweeps them against eval/requests.json and reports the operating point; these
// are its output for jev-latest recorded 2026-09-20 (0 wrong, 0 unsafe, 25/26
// primary hits, min-margin 0.025). Re-record and re-sweep after a model change
// rather than hand-editing them: the previous hand-picked values scored 4 wrong
// and escalated a README typo fix.
const { join, resolve } = require("node:path");

// Everything resolves from the repo root, so a clone works wherever it lands.
const ROOT = resolve(__dirname, "..");

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  model: process.env.JEV_MODEL || process.env.TYPESAFE_DEFAULT_MODEL || "jev-latest",
  autoThreshold: num("JEV_AUTO_THRESHOLD", 0.85),
  reviewThreshold: num("JEV_REVIEW_THRESHOLD", 0.6),
  clarifyThreshold: num("JEV_CLARIFY_THRESHOLD", 0.885),
  securityThreshold: num("JEV_SECURITY_THRESHOLD", 0.905),
  archThreshold: num("JEV_ARCH_THRESHOLD", 0.875),
  riskThreshold: num("JEV_RISK_THRESHOLD", 1.93),
  timeoutMs: num("JEV_TIMEOUT_MS", 10000),
  logFile: process.env.JEV_LOG_FILE || join(ROOT, "logs", "jev-decisions.jsonl"),

  // Tool gate (PreToolUse). Deliberately stricter than the intake gate: it runs
  // on an action about to execute, not on a request about to be planned.
  toolDenyThreshold: num("JEV_TOOL_DENY_THRESHOLD", 0.85),
  toolAskThreshold: num("JEV_TOOL_ASK_THRESHOLD", 0.5),
  toolTimeoutMs: num("JEV_TOOL_TIMEOUT_MS", 3500),
  toolCacheTtlMs: num("JEV_TOOL_CACHE_TTL_MS", 6 * 60 * 60 * 1000),
  toolCacheFile: process.env.JEV_TOOL_CACHE_FILE || join(ROOT, "logs", "tool-gate-cache.json"),
  // Tool gate only: when the API is unreachable, allow non-destructive calls
  // rather than bricking the session. The deterministic destructive floor in
  // lib/tool-gate.cjs still denies, so an outage cannot approve `rm -rf /`.
  toolFailOpen: process.env.JEV_TOOL_FAIL_OPEN !== "0",
};

module.exports = { config, ROOT };
