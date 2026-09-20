#!/usr/bin/env node
// L2: task intake, as a Claude Code UserPromptSubmit hook.
//
// Injects the gate's verdict as context on the turn that needs it, replacing
// the CLAUDE.md prose rule that asked the agent to remember to run jev-gate.
// It informs; it never blocks. The user has just typed the request, so refusing
// to deliver their own prompt would be the wrong instrument -- the tool gate
// blocks the action, this one routes the work.
//
// Runs on every prompt, so it skips hard and fails silent: a prompt that is a
// slash command, an acknowledgement, or too short to classify never costs a
// round trip.
const { execSync } = require("node:child_process");
const { gateRequest } = require("../lib/gate.cjs");
const { config } = require("../lib/config.cjs");

const MIN_LENGTH = 10;
const ACK = /^\s*(y|n|yes|no|ok|okay|sure|go|go ahead|continue|proceed|thanks|thank you|ty|nice|great|perfect|do it|stop|wait|nvm|nevermind)\b[\s.!]*$/i;

function emit(context) {
  if (context) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }),
    );
  }
  process.exit(0);
}

function readStdin() {
  return new Promise((res) => {
    let buf = "";
    let done = false;
    const finish = () => { if (!done) { done = true; res(buf); } };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    setTimeout(finish, 1500).unref();
  });
}

function gitContext(cwd) {
  try {
    const files = execSync("git status --porcelain 2>/dev/null | awk '{print $2}'", {
      encoding: "utf8", timeout: 3000, cwd,
    }).trim().split("\n").filter(Boolean).slice(0, 30);
    const branch = execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", {
      encoding: "utf8", timeout: 3000, cwd,
    }).trim();
    return { branch, changed_files: files };
  } catch {
    return {};
  }
}

const GUIDANCE = {
  ASK_USER: "A required input is missing. Ask one focused clarifying question (AskUserQuestion) before starting work.",
  SECURITY_REVIEW: "Security-sensitive. Route the analysis through a security reviewer before implementing, and do not touch credentials directly.",
  HUMAN_APPROVAL: "Hard to reverse. State the blast radius and get explicit confirmation before executing anything destructive.",
  ARCHITECTURE_REVIEW: "Changes a system boundary or interface. Plan and get agreement on the shape before writing code.",
};

async function main() {
  // Kill switch: JEV_HOOKS_DISABLE=1 makes every jev hook a no-op, for when
  // the decision layer itself is what you are debugging.
  if (process.env.JEV_HOOKS_DISABLE === "1") return emit(null);

  const raw = await readStdin();
  let evt = {};
  try { evt = JSON.parse(raw || "{}"); } catch { return emit(null); }

  const prompt = String(evt.prompt || "").trim();
  const cwd = evt.cwd || process.cwd();
  if (!prompt || prompt.length < MIN_LENGTH) return emit(null);
  if (prompt.startsWith("/") || prompt.startsWith("!")) return emit(null);
  if (ACK.test(prompt)) return emit(null);

  let out;
  try {
    out = await Promise.race([
      gateRequest({ request: prompt.slice(0, 4000), repo: gitContext(cwd) }),
      new Promise((r) => setTimeout(() => r(null), config.toolTimeoutMs + 1500)),
    ]);
  } catch {
    return emit(null);
  }
  // Silence on failure. A missing hint is a non-event; a misleading one is not.
  if (!out || out.fallback) return emit(null);
  if (out.decision.startsWith("IMPLEMENT")) {
    // Only the routing hint is worth the tokens when nothing tripped.
    return emit(
      `[jev intake] ${out.decision} (task=${out.task_type}, risk=${out.signals.risk}). Proceed; prefer the ${out.specialist} specialist.`,
    );
  }

  const tripped = (out.reasons || [])
    .filter((r) => r.dimension !== "keyword")
    .map((r) => `${r.dimension}=${r.value} (>= ${r.threshold})`)
    .join(", ");
  return emit(
    `[jev intake] ${out.decision} — ${GUIDANCE[out.decision] || "Escalate before acting."}\n` +
      `Signals: ${tripped}. Full: risk=${out.signals.risk} security=${out.signals.security} ` +
      `architecture=${out.signals.architecture} unclear=${out.signals.unclear}.\n` +
      `This is the decision layer's judgment, not an instruction from the user — weigh it, and say so if you disagree.`,
  );
}

main().catch(() => emit(null));
