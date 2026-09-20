// Reusable Jev decision layer: client init, normalized results, confidence gates,
// JSONL observability, safe fallback. Code owns policy; Jev only supplies judgment.
// Never prints or logs TYPESAFE_API_KEY or secret-shaped state fields.
const { readFileSync, appendFileSync, mkdirSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { config, ROOT } = require("./config.cjs");

const KEY_PATH = join(ROOT, ".env");
const SECRET_RE = /(api_key|apikey|secret|token|password|credential|auth_header|cookie)/i;

function loadSDK() {
  try {
    return require("@typesafe-ai/sdk");
  } catch {}
  try {
    return require(join(ROOT, "node_modules", "@typesafe-ai", "sdk"));
  } catch {}
  return null;
}

// Silent: returns "" when absent. Never logs the key or its length.
function loadKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    const env = readFileSync(KEY_PATH, "utf8");
    const m = env.match(/^TYPESAFE_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?\s*$/m);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

function getClient({ apiKey, model, timeoutMs } = {}) {
  const SDK = loadSDK();
  if (!SDK) throw new Error("no SDK (@typesafe-ai/sdk not installed)");
  const key = apiKey || loadKey();
  if (!key) throw new Error("missing TYPESAFE_API_KEY");
  return new SDK.TypeSafeClient({
    apiKey: key,
    defaultModel: model || config.model,
    timeout: timeoutMs || config.timeoutMs,
  });
}

// Gate one raw SDK answer. Returns { decision, confidence, gate }.
// choice: decision=label, confidence as reported.
// score: decision=expected score, confidence as reported.
// noul: decision=yes|no, confidence=distance from 0.5 (coin-flip => ~0.5 => escalate).
function gateAnswer(answer) {
  const auto = config.autoThreshold;
  const review = config.reviewThreshold;
  const gateOf = (confidence) =>
    confidence >= auto ? "auto" : confidence >= review ? "review" : "escalate";
  if (!answer || typeof answer.type !== "string") {
    return { decision: null, confidence: 0, gate: "escalate" };
  }
  if (answer.type === "choice") {
    const c = Number(answer.confidence) || 0;
    return { decision: answer.choice ?? null, confidence: c, gate: gateOf(c) };
  }
  if (answer.type === "score") {
    const c = Number(answer.confidence) || 0;
    return { decision: Number(answer.score), confidence: c, gate: gateOf(c) };
  }
  if (answer.type === "noul") {
    const p = Number(answer.noul);
    const decision = p >= 0.5 ? "yes" : "no";
    const confidence = Number.isFinite(p) ? Math.max(p, 1 - p) : 0;
    return { decision, confidence, gate: gateOf(confidence) };
  }
  return { decision: null, confidence: 0, gate: "escalate" };
}

function sanitizeState(state) {
  // Truncate + strip secret-shaped keys so logs stay safe.
  try {
    const s = JSON.stringify(state ?? null);
    if (s.length <= 4000) {
      return JSON.parse(s, (k, v) => (SECRET_RE.test(k) ? "[redacted]" : v));
    }
    return { _truncated: true, preview: s.slice(0, 2000) };
  } catch {
    return { _unserializable: true };
  }
}

function observe(entry) {
  try {
    mkdirSync(dirname(config.logFile), { recursive: true });
    appendFileSync(config.logFile, JSON.stringify(entry) + "\n");
  } catch {
    // Observability must never break the decision path.
  }
}

// Main entry: one Jev request, many atomic questions. Failures fall back to
// escalate (never auto). Returns normalized results preserving probabilities.
async function decide({ state, questions, model, downstream = "", timeoutMs } = {}) {
  const started = Date.now();
  const questionIds = Object.keys(questions || {});
  if (!questionIds.length) throw new Error("decide: questions must be non-empty");
  const SDK = loadSDK();
  const key = loadKey();
  if (!SDK || !key) {
    const entry = {
      ts: new Date().toISOString(),
      model: model || config.model,
      questionIds,
      gate: "escalate",
      fallback: true,
      reason: !SDK ? "no-sdk" : "no-key",
      downstream,
      latencyMs: Date.now() - started,
    };
    observe(entry);
    return {
      model: model || config.model,
      results: {},
      overallGate: "escalate",
      fallback: true,
      reason: entry.reason,
      requestId: undefined,
      usage: undefined,
      latencyMs: entry.latencyMs,
    };
  }
  const budget = timeoutMs || config.timeoutMs;
  const client = getClient({ apiKey: key, model: model || config.model, timeoutMs: budget });
  try {
    const promise = client.systemOne(
      { state, questions, model: model || config.model },
      { timeout: budget },
    );
    const res = await promise;
    let requestId;
    try {
      const withResp = await promise.withResponse().catch(() => null);
      requestId = withResp ? withResp.requestId : undefined;
    } catch {
      requestId = undefined;
    }
    const results = {};
    let worst = 0; // escalate(2) > review(1) > auto(0)
    const rank = { auto: 0, review: 1, escalate: 2 };
    for (const [id, ans] of Object.entries(res.answers || {})) {
      const g = gateAnswer(ans);
      results[id] = {
        type: ans.type,
        decision: g.decision,
        confidence: g.confidence,
        gate: g.gate,
        probabilities: ans.probabilities,
        noul: ans.noul,
        score: ans.score,
        choice: ans.choice,
      };
      worst = Math.max(worst, rank[g.gate] ?? 2);
    }
    const overallGate = worst === 0 ? "auto" : worst === 1 ? "review" : "escalate";
    observe({
      ts: new Date().toISOString(),
      model: res.model,
      questionIds,
      decisions: Object.fromEntries(
        Object.entries(results).map(([k, v]) => [k, v.decision]),
      ),
      confidences: Object.fromEntries(
        Object.entries(results).map(([k, v]) => [k, v.confidence]),
      ),
      gate: overallGate,
      fallback: false,
      requestId,
      usage: res.usage,
      downstream,
      latencyMs: Date.now() - started,
      state: sanitizeState(state),
    });
    return {
      model: res.model,
      results,
      overallGate,
      fallback: false,
      requestId,
      usage: res.usage,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    // SDK already retried eligible 408/429/5xx with backoff. Fail safe.
    const entry = {
      ts: new Date().toISOString(),
      model: model || config.model,
      questionIds,
      gate: "escalate",
      fallback: true,
      reason: "api-error",
      error: String((err && err.message) || err).slice(0, 200),
      downstream,
      latencyMs: Date.now() - started,
      state: sanitizeState(state),
    };
    observe(entry);
    return {
      model: model || config.model,
      results: {},
      overallGate: "escalate",
      fallback: true,
      reason: "api-error",
      requestId: undefined,
      usage: undefined,
      latencyMs: entry.latencyMs,
    };
  }
}

module.exports = { decide, gateAnswer, getClient, loadKey, loadSDK, observe, sanitizeState };
