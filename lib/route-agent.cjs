// L6: which model a subagent needs, as a PreToolUse rewrite of the Agent call.
//
// A subagent inherits the session's model unless told otherwise, so a file
// search spawned from an Opus session runs on Opus. This asks Jev how much
// reasoning the delegated task needs and, only when Jev is confident it needs
// little, sets a cheaper model on the call.
//
// It never sets a model at or above the session's own (read from the
// transcript; when that cannot be read, only Haiku, the floor, is ever set). It
// never overrides a model the caller chose, and it routes only agent types
// that inherit the session's model: a type with a model of its own in its
// definition (Explore, most plugin agents) is left alone, because setting one
// would override that pin, upward as easily as down.
const { closeSync, openSync, readSync, statSync } = require("node:fs");
const { decide, loadSDK } = require("./decision-engine.cjs");
const { config } = require("./config.cjs");

// Agent types whose model is inherited from the session, so a downgrade is ours to make.
const DEFAULT_TYPES = ["general-purpose", "claude"];
const routableTypes = () =>
  (process.env.JEV_ROUTE_AGENT_TYPES ? process.env.JEV_ROUTE_AGENT_TYPES.split(",").map((t) => t.trim()) : DEFAULT_TYPES);

const LEVELS = [
  "Lookup: find, list, read or summarise what exists; no judgment beyond locating it.",
  "Routine: a bounded change or analysis with a clear method, such as writing a test, a small fix or a review of one file.",
  "Hard: open-ended design, debugging an unknown cause, security or architecture judgment, or work across many parts.",
];
const MODEL_FOR_LEVEL = ["haiku", "sonnet", null];
// Expected score below which each model is set. Margins, not rounding: a task
// scored 1.45 is nearly as close to Hard as to Routine and stays where it is.
const HAIKU_BELOW = 0.35;
const SONNET_BELOW = 1.2;

const RANK = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };
const rankOf = (model) => {
  const m = String(model || "").toLowerCase();
  return Object.entries(RANK).find(([name]) => m.includes(name))?.[1] ?? null;
};

/** The session's model, from the last assistant entry of its transcript. Null when it cannot be read. */
function sessionModel(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const size = statSync(transcriptPath).size;
    const length = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(length);
    const fd = openSync(transcriptPath, "r");
    try { readSync(fd, buf, 0, length, size - length); } finally { closeSync(fd); }
    // The main thread's entries only: a subagent's entries carry its own model.
    const lines = buf.toString("utf8").split("\n").filter((line) => !line.includes('"isSidechain":true'));
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /"model":"(claude-[^"]+)"/.exec(lines[i]);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

/** Whether this Agent call is one we may route at all. Returns the reason when it is not. */
function routable(input) {
  if (!config.routeAgents) return "routing is off";
  if (!input || typeof input.prompt !== "string") return "no prompt";
  if (input.model) return "the caller chose a model";
  if (input.subagent_type === "fork") return "a fork runs on the parent's model";
  const type = input.subagent_type || "general-purpose";
  if (!routableTypes().includes(type)) return `agent type ${type} keeps its own model`;
  return null;
}

/** The model to set, or null to leave the call alone, with the numbers behind it. */
async function routeAgent(input, { transcriptPath, holdsSecret = () => false, ask = decide } = {}) {
  const why = routable(input);
  if (why) return { model: null, why };
  if (holdsSecret(`${input.prompt} ${input.description || ""}`)) return { model: null, why: "the prompt holds something shaped like a credential; not sent" };
  const SDK = loadSDK();
  if (!SDK) return { model: null, why: "no SDK" };
  const res = await ask({
    state: { agent_type: input.subagent_type || "general-purpose", description: input.description || "", task: String(input.prompt).slice(0, 4000) },
    questions: { level: SDK.score("How much reasoning does `task` need from the agent that carries it out?", LEVELS) },
    downstream: "agent-routing",
    logState: false,
    timeoutMs: config.toolTimeoutMs,
  });
  if (res.fallback || !res.results.level) return { model: null, why: "Jev did not answer" };
  const { decision: score, confidence } = res.results.level;
  const numbers = `level ${Number(score).toFixed(2)}, confidence ${Number(confidence).toFixed(2)}`;
  if (confidence < config.autoThreshold) return { model: null, why: `not sure enough (${numbers})`, score, confidence };
  const level = score < HAIKU_BELOW ? 0 : score < SONNET_BELOW ? 1 : 2;
  const model = MODEL_FOR_LEVEL[level];
  if (!model) return { model: null, why: `left on the session model (${numbers})`, score, confidence };
  const session = rankOf(sessionModel(transcriptPath));
  // Only ever down: below the session's model, or Haiku, the floor, when the session's model is unknown.
  if (session === null ? RANK[model] !== 0 : RANK[model] >= session) {
    return { model: null, why: `${model} would not be cheaper than the session's model (${numbers})`, score, confidence };
  }
  return { model, why: `${LEVELS[level].split(":")[0].toLowerCase()} task (${numbers})`, score, confidence };
}

module.exports = { routeAgent, routable, sessionModel, rankOf, LEVELS, MODEL_FOR_LEVEL, DEFAULT_TYPES };
