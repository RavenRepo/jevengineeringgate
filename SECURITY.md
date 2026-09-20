# Security Policy

## Reporting a vulnerability

Open a [private security advisory](https://github.com/RavenRepo/jevengineeringgate/security/advisories/new).
Please do not open a public issue for a vulnerability.

Include what you can: affected file and version, reproduction steps, and the
impact you believe it has. You will get an acknowledgement within 7 days.

## Scope and threat model

Read this before filing, because it defines what counts as a vulnerability here.

**This project is advisory, never authorization.** Jev supplies judgment; the
code that executes a decision is still responsible for checking permissions,
paths and approvals. A report that amounts to "the model returned a wrong
judgment" is a *calibration* issue, not a vulnerability — open a normal issue
with the recorded probabilities and we will add it to `eval/requests.json`.

In scope:

- A way to make the deterministic deny floor in `lib/tool-gate.cjs` approve a
  command it should block — for example, quoting or encoding that slips a
  destructive command past `hardDenySegment`.
- A path through `hooks/jev-pretooluse.cjs` that emits `permissionDecision:
  "allow"` without `JEV_TOOL_AUTO_ALLOW=1`. The hook is designed to be purely
  additive; emitting `allow` bypasses the host's own permission prompt.
- Any path that writes `TYPESAFE_API_KEY`, or state matching the secret filter
  in `sanitizeState()`, to the log sink or to stdout.
- A fallback path that promotes an API failure to `auto` instead of `escalate`.

Out of scope:

- The gate being bypassed by a user who runs the command themselves. That is the
  intended escape hatch.
- Model judgment quality, threshold values, and false positives or negatives in
  classification. File these as issues.
- `JEV_HOOKS_DISABLE=1` disabling the gate. That is a documented kill switch.

## Handling secrets

`TYPESAFE_API_KEY` is read from the environment or from a gitignored `.env` at
the repo root. It is never printed, never logged, and never included in a
decision payload. `sanitizeState()` redacts secret-shaped keys before anything
reaches `logs/jev-decisions.jsonl`, and truncates oversized state.

If you believe a key has been exposed, rotate it first and report second. A
secret that has left cannot be recalled.
