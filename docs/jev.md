# Jev decision layer — full reference

LLMs generate → **Jev decides** → code executes → humans handle uncertainty.

Jev is not a chat model. It returns typed Choice / Score / Noul answers with
probabilities. One question = one judgment, clean state, batched questions,
confidence-based routing. It is **advisory, never authorization**: the code that
executes a decision still checks permissions, paths and approvals.

## The layers

| | What decides | Cost | Where |
| --- | --- | --- | --- |
| **L0** | Deterministic code. No model call. | 0 | `lib/tool-gate.cjs` |
| **L1** | Jev, on a tool call about to execute. | ~1s, cached | `hooks/jev-pretooluse.cjs` |
| **L2** | Jev, on an incoming task. | ~1s | `hooks/jev-intake.cjs`, `bin/jev-gate.cjs` |
| **L3** | Jev, on finished work and on routing. | ~1s | `lib/verify.cjs`, `bin/jev-verify.cjs`, `bin/jev-route.cjs` |
| **L4** | Jev, on what to keep in context. | ~1.5s / 25 entries | `lib/compact.cjs`, `bin/jev-compact.cjs` |

L0 exists because a decision costs ~1s and a session makes hundreds of tool
calls. Gating all of them makes the session unusable and teaches everyone to
turn the gate off. Only what L0 cannot settle reaches Jev.

## Layout

- `lib/config.cjs` — model + thresholds from env (no secrets printed).
- `lib/decision-engine.cjs` — `decide()`, `gateAnswer()`, JSONL observability,
  safe fallback (escalate, never auto).
- `lib/gate.cjs` — `gateRequest()` / `classify()`: the intake gate's six
  judgments and its severity ordering. Shared by the CLI and the intake hook.
- `lib/tool-gate.cjs` — `classifyTool()`: deterministic allow / deny / gate,
  plus the TTL cache.
- `lib/verify.cjs` — `verifyOutput()` and `routeTask()`.
- `lib/compact.cjs` — `filterEntries()`: compaction as a relevance filter.
- `bin/` — `jev-gate`, `jev-verify`, `jev-route`, `jev-compact`.
  `~/.local/bin/jev-*` are thin shims onto these, so edits here take effect.
- `hooks/` — the PreToolUse and UserPromptSubmit hooks.
- `eval/requests.json` + `eval/calibrate.cjs` — labeled intake cases and the
  threshold sweep. `eval/dataset.json` + `eval/run.cjs` — gate-logic cases.
- `test/` — offline unit tests (no network, no key).
- `logs/jev-decisions.jsonl` — observability sink (auto-created, gitignored).

## Environment

| Var | Default | Meaning |
| --- | ------- | ------- |
| `TYPESAFE_API_KEY` | (required) | API key. Never hard-code, never log. |
| `JEV_MODEL` | `jev-latest` | Pin prod with `JEV_MODEL=jev-1.13.0`. |
| `JEV_AUTO_THRESHOLD` | `0.85` | confidence ≥ this → `auto`. |
| `JEV_REVIEW_THRESHOLD` | `0.60` | in `[review, auto)` → `review`; below → `escalate`. |
| `JEV_CLARIFY_THRESHOLD` | `0.885` | intake `needs_clarification` gate. **Fitted.** |
| `JEV_SECURITY_THRESHOLD` | `0.905` | intake `security_sensitive` gate. **Fitted.** |
| `JEV_ARCH_THRESHOLD` | `0.875` | intake `architecture_change` gate. **Fitted.** |
| `JEV_RISK_THRESHOLD` | `1.93` | intake `change_risk` gate (rubric 0..2). **Fitted.** |
| `JEV_TOOL_DENY_THRESHOLD` | `0.85` | tool gate: deny at/above this. |
| `JEV_TOOL_ASK_THRESHOLD` | `0.50` | tool gate: ask at/above this. |
| `JEV_TOOL_TIMEOUT_MS` | `3500` | tool gate budget (tighter than the general one). |
| `JEV_TOOL_CACHE_TTL_MS` | `21600000` | 6h. `0` disables the cache. |
| `JEV_TOOL_FAIL_OPEN` | `1` | `0` = ask instead of passing when the API is down. |
| `JEV_TOOL_AUTO_ALLOW` | unset | `1` lets the hook emit `allow` (see below). |
| `JEV_TOOL_PROTECTED` | unset | `Caddyfile,/srv/www` or `/regex/` — always gate. |
| `JEV_HOOKS_DISABLE` | unset | `1` makes every jev hook a no-op. |
| `JEV_TIMEOUT_MS` | `10000` | general per-attempt API timeout. |
| `JEV_LOG_FILE` | `logs/jev-decisions.jsonl` | observability sink. |

## Thresholds are fitted, not chosen

The four intake thresholds are the output of `eval/calibrate.cjs`, not
judgement calls. Do not hand-edit them; re-record and re-sweep:

```
node eval/calibrate.cjs --record   # one Jev call per labeled case (~3s, ~$0.0005)
node eval/calibrate.cjs            # offline sweep; prints the operating point
```

The sweep's objective, strongest constraint first:

1. **zero unsafe outcomes** — never traded. An unsafe outcome is a case marked
   `unsafe_if_implement` that the thresholds would let an agent start alone.
2. fewest decisions outside the case's `accept` set
3. **largest minimum margin** — thresholds sit in the middle of their band, not
   on the edge of a recorded value
4. most decisions matching the `primary` label (routing quality)
5. largest total margin

Margin outranks routing quality deliberately. Buying the last primary-label hit
costs risk-head margin, and a risk threshold pinned just above a recorded value
turns the next destructive request that scores slightly lower into an
unsupervised auto-proceed. A misrouted architecture change only costs a prompt.

Each threshold's search is bounded by `dims`, the per-head ground truth in
`eval/requests.json`: **a threshold is never set below a value labeled
should-not-fire**, however well it scores. Without that bound the sweep drove
the security threshold to the grid floor, because the risk head happened to
mask it on this dataset — and would not have on the next request.

Current operating point for `jev-latest`: 0 wrong, 0 unsafe, 25/26 primary hits,
min-margin 0.025, across 26 labeled cases.

### Why the clarify question was rewritten

The original asked whether "a competent engineer must ask the user for details".
Jev answered yes to almost everything — 0.79–0.97 across real requests,
including a README typo fix at 0.80 — so with a 0.70 threshold the gate
escalated work it should have waved through, and an agent that is told to ask
for clarification about a typo learns to ignore the gate. The question now asks
the checkable thing (*is a required input actually absent?*) with an explicit
negative anchor. Should-fire cases now sit at 0.93–0.96, everything else at
0.16–0.84: a real separation with somewhere to put a threshold.

### Why severity is ordered

The original checked clarify first, so *"drop the users table in production"*
reported `ASK_USER` — its risk 2.0 and security 0.85 were computed and
discarded. Decisions are now ordered `HUMAN_APPROVAL > SECURITY_REVIEW >
ARCHITECTURE_REVIEW > ASK_USER`, ambiguity last, and `reasons` lists **every**
dimension that tripped so a strong signal is never hidden behind a weaker one.

## Measured cost

Per decision: **~292 input tokens, ~0.98s, ~$0.0000123** (jev-latest, measured).
Cost is a rounding error; latency is the budget, which is why L0 exists.

On 54 real tool calls from the session that built this: **17% allow, 83% gate,
0 denies**. That 83% is inflated — the session wrote nearly every file through
Bash heredocs, and an output redirect always gates. A session using the
Write/Edit tools for edits (in-tree writes allow deterministically) gates far
less. Check your own mix before deciding the gate is too expensive:

```js
// classify a transcript's tool calls without spending a token
const { classifyTool } = require("./lib/tool-gate.cjs");
```

Levers, in the order worth trying: the 6h cache (repeat calls are free),
`JEV_TOOL_AUTO_ALLOW=1`, a shorter `JEV_TOOL_TIMEOUT_MS`, and adding genuinely
read-only command heads to `READ_ONLY_HEADS`.

## The deny floor is anchored, not a substring match

Three false-positive classes were found by running the classifier over real
traffic, and each one would have been fatal to adoption — a gate that blocks
ordinary work gets switched off:

- **Heredoc bodies.** Writing a file that *discusses* `rm -rf /` (this file, its
  tests) was denied. Heredoc bodies are stripped before the deny scan.
- **Quoted operators.** `node -e 'const c=["ls && rm -rf /"]'` was split on the
  `&&` *inside a JavaScript string*, and the remainder read as a bare `rm`
  command. `splitSegments()` is quote- and escape-aware.
- **Foreign languages.** Following `node -e` / `python3 -c` arguments matched
  string literals, and would not have caught real deletion (`fs.rm`) anyway.
  Recursion is limited to shell interpreters, where the patterns apply.

A deny now requires the *segment's own head* to be a dangerous binary
(`DANGEROUS_HEADS`), plus two whole-command forms that are not head-shaped (a
fork bomb, a redirect onto a block device). Mentioning a dangerous string gates
at worst; running one denies.

## The tool gate never says yes

`hooks/jev-pretooluse.cjs` emits `deny`, `ask`, or **nothing**. It does not emit
`allow`, because an `allow` from a PreToolUse hook bypasses Claude Code's own
permission prompt — a gate that emitted it would make the session *more*
permissive than having no gate. Staying silent leaves the normal flow intact, so
the gate is purely additive. `JEV_TOOL_AUTO_ALLOW=1` opts into allow-on-clear if
you want the speed-up and accept that trade.

The deterministic deny floor in `lib/tool-gate.cjs` is never referred to Jev, so
neither an outage nor a confidently wrong answer can approve `rm -rf /`.

## Usage

```js
const { decide } = require("./lib/decision-engine.cjs");
const { noul, choice } = require("@typesafe-ai/sdk");

const res = await decide({
  state: { goal: "...", evidence: "..." }, // facts, no secrets/dumps
  questions: {
    path: choice("Which next action?", { a: "...", b: "...", other: "None fit" }),
    ready: noul("Is evidence sufficient to act without more tools?"),
  },
  downstream: "my-workflow",
});
// res.results.path => { decision, confidence, gate, probabilities, ... }
// res.overallGate => auto | review | escalate; res.fallback true => escalate.
```

CLIs:

```
jev-gate    --request "<task>" [--diff-file PATCH] [--json]   # 0 proceed, 3 escalate
jev-route   --request "<task>"                                # deterministic|cheap|strong|human
jev-verify  --artifact-file F --requirements "..." [--prohibit "..."]   # 0 accept, 3 revise
jev-compact --goal "..." [--file entries.json|-] [--keep 0.5] [--pin-first N] [--pin-last N]
```

Gate policy: `auto` → act; `review` → stronger model/checks; `escalate` → gather
state, ask the user, or take a reversible default. Noul near 0.5 is a coin-flip,
not "medium yes". Destructive work needs confidence ≥ 0.85 **and** user confirm.

## Compaction is a filter, not a summary

`filterEntries()` scores each entry against the goal and keeps or drops it.
Nothing is rewritten, so what survives is exactly what was there. `pinFirst` /
`pinLast` keep the opening instructions and the latest turns unscored — the goal
statement itself tends to score low, because the goal is already in `state`.

A failed chunk keeps everything: dropping an entry cannot be undone in-process,
keeping one only costs tokens.

## Adding a new decision

1. Name one judgment; write explicit criteria with a negative anchor. Vague
   meta-questions ("would an engineer...") produce saturated heads.
2. Pack minimal factual state (goal, constraints, evidence, options + `other`).
3. Batch independent questions into one `decide()` call.
4. Map gates in code. Never let Jev alone grant a privileged capability.
5. Add labeled cases — obvious, ambiguous, edge, adversarial — and re-sweep.

## Eval & tests

- `npm test` — offline units + gate-logic eval + threshold sweep. No key needed.
- `npm run eval:live` — live Jev; `uncertain-ok` cases pass via escalate.
- `npm run calibrate:record && npm run calibrate` — refit after a model change.
- `node --env-file=.env check.cjs` — connectivity smoke test.

A wrong label with high confidence is a reliability flag: fix the criteria or
the state, do not trust the label.

## Fallback & errors

Missing SDK/key, timeouts, rate limits, malformed state: `decide()` returns
`{ fallback: true, overallGate: "escalate" }` and logs the error message only.
Callers must not promote a fallback to `auto`. The tool gate is the one
deliberate exception — it fails *open* for calls its deterministic floor does
not find alarming, so an API outage does not brick the session, and fails to
`ask` for anything matching the destructive pattern.
