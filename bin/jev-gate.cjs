#!/usr/bin/env node
// jev-gate — task-intake triage + risk gate in ONE Jev call.
//
//   jev-gate --request "<task>" [--diff-file PATCH] [--json]
//
// Exit: 0 = proceed (IMPLEMENT:<specialist>), 3 = escalate, 2 = usage error.
// Exit codes are unchanged from the first version; callers that only check the
// code keep working. `--json` now also carries `reasons`, every dimension that
// tripped, so a caller can see a masked signal (security 0.96 under a headline
// HUMAN_APPROVAL) instead of losing it.
//
// Key: TYPESAFE_API_KEY env, else silently read from /mnt/kronos/jev/.env.
const { execSync } = require("node:child_process");
const { readFileSync, existsSync } = require("node:fs");
const { gateRequest } = require("../lib/gate.cjs");

function gitContext() {
  // Best-effort repo state; never fails the gate.
  try {
    const files = execSync(
      "git diff --name-only HEAD 2>/dev/null; git status --porcelain 2>/dev/null | awk '{print $2}'",
      { encoding: "utf8", timeout: 10000 },
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(0, 30);
    let stat = "";
    try {
      stat = execSync("git diff HEAD --stat 2>/dev/null | tail -n 5", { encoding: "utf8", timeout: 10000 }).trim();
    } catch {}
    return { changed_files: files, diff_stat: stat };
  } catch {
    return { changed_files: [], diff_stat: "" };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const get = (f) => {
    const i = args.indexOf(f);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : "";
  };
  const request = get("--request") || args.filter((a) => !a.startsWith("--"))[0] || "";
  const asJson = args.includes("--json");
  if (!request) {
    console.error('Usage: jev-gate --request "<task>" [--diff-file PATCH] [--json]');
    process.exit(2);
  }
  let diff = "";
  const df = get("--diff-file");
  if (df && existsSync(df)) diff = readFileSync(df, "utf8").slice(0, 6000);

  const out = await gateRequest({ request, diff, repo: gitContext() });
  const proceed = out.decision.startsWith("IMPLEMENT");

  if (out.fallback) console.error(`jev-gate: fallback mode (${out.reason || out.apiReason || "unavailable"})`);
  if (asJson) {
    console.log(JSON.stringify(out));
  } else {
    const s = out.signals || {};
    const detail = out.fallback
      ? `[fallback: ${out.reason || out.apiReason}]`
      : `[type=${out.task_type} risk=${s.risk} sec=${s.security} arch=${s.architecture} unclear=${s.unclear}]`;
    console.log(`${out.decision}  ${detail}`);
    // Every tripped dimension, so the headline never hides a stronger signal.
    for (const r of out.reasons || []) {
      if (r.dimension === "keyword") continue;
      console.log(`  - ${r.dimension}=${r.value} >= ${r.threshold} -> ${r.decision}`);
    }
  }
  process.exit(proceed ? 0 : 3);
}

main().catch((e) => {
  console.error("jev-gate:", String((e && e.message) || e).slice(0, 200));
  process.exit(2);
});
