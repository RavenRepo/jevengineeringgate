# jevengineeringgate — a calibrated decision layer and risk gate for AI coding agents

[![CI](https://github.com/RavenRepo/jevengineeringgate/actions/workflows/ci.yml/badge.svg)](https://github.com/RavenRepo/jevengineeringgate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Decisions cost](https://img.shields.io/badge/per%20decision-~%240.0000123-blue.svg)](#measured-cost)

**An LLM creates the work. Something else should decide what happens next.**

Every AI agent has the same leak: a frontier model sits in a loop answering
yes-or-no, picking the next worker, and scoring relevance. Those calls never
needed generation. This repository moves them to [Jev](https://typesafe.ai), the
System One decision model from TypeSafe AI — and then **enforces the result
deterministically**, as host hooks rather than as a rule an agent has to
remember.

```
LLM generates  →  Jev decides  →  code executes  →  humans handle uncertainty
```

- **~292 input tokens, ~0.98s, ~$0.0000123 per decision** (measured, not quoted)
- **Thresholds are fitted, not guessed** — a sweep over 26 labeled cases
- **0 wrong, 0 unsafe, 25/26 primary-label hits** at the current operating point
- **48 offline tests**, no API key required to run them

---

## Why a prose rule is not a gate

Most agent setups put the guardrail in an instruction file:

> *"Before any risky, destructive, or irreversible action, run the risk gate."*

That cannot work. It asks the agent to **already know the action is risky** —
which is the exact judgment the gate exists to make. The gate only fires when
it was not needed.

A [`PreToolUse` hook](docs/jev.md) does not need to be remembered. It runs on
every tool call, before execution, and returns `deny`, `ask`, or nothing.

## Install

```bash
git clone https://github.com/RavenRepo/jevengineeringgate.git
cd jevengineeringgate
npm install
echo 'TYPESAFE_API_KEY=your_key_here' > .env   # gitignored
npm test                                        # 48 offline tests, no key needed
```

Wire the hooks into Claude Code (idempotent, backs up first, preserves existing hooks):

```bash
node bin/install-hooks.cjs        # --remove to reverse
```

Restart your agent. `JEV_HOOKS_DISABLE=1` is the runtime kill switch.

## The five layers

| Layer | What decides | Cost | Where |
|---|---|---|---|
| **L0** | Deterministic code. No model call. | 0 | [`lib/tool-gate.cjs`](lib/tool-gate.cjs) |
| **L1** | Jev, on a tool call about to execute | ~1s, cached 6h | [`hooks/jev-pretooluse.cjs`](hooks/jev-pretooluse.cjs) |
| **L2** | Jev, on an incoming task | ~1s | [`hooks/jev-intake.cjs`](hooks/jev-intake.cjs) |
| **L3** | Jev, on finished work and on routing | ~1s | [`lib/verify.cjs`](lib/verify.cjs) |
| **L4** | Jev, on what to keep in context | ~1.5s / 25 entries | [`lib/compact.cjs`](lib/compact.cjs) |

**L0 is the layer that makes the rest viable.** A decision costs ~1s and a
session makes hundreds of tool calls. Gate all of them and the session becomes
unusable — and an unusable gate gets switched off. Only what L0 cannot settle
reaches the model.

## Command line

```bash
jev-gate    --request "add OAuth login"               # 0 proceed, 3 escalate
jev-route   --request "rename a local variable"       # deterministic|cheap|strong|human
jev-verify  --artifact-file out.ts --requirements "…" # 0 accept, 3 revise
jev-compact --goal "…" --file history.json            # relevance filter
```

## Thresholds are fitted, not chosen

This is the part most guardrail projects skip, and it is the part that decides
whether anyone keeps the gate switched on.

```bash
npm run calibrate:record   # one Jev call per labeled case (~3s, ~$0.0005)
npm run calibrate          # offline sweep; prints the operating point
```

The sweep optimizes lexicographically:

1. **Zero unsafe outcomes** — never traded away
2. Fewest decisions outside the case's accept set
3. **Largest minimum margin** — thresholds sit mid-band, not on a recorded value
4. Most decisions matching the primary label
5. Largest total margin

Margin outranks routing quality on purpose. Buying the last primary-label hit
cost risk-head margin, and a risk threshold pinned just above a recorded value
turns the next destructive request scoring slightly lower into an unsupervised
auto-proceed. A misrouted architecture change only costs a prompt.

Each threshold's search is bounded by per-head ground truth: **a threshold is
never set below a value labeled should-not-fire**, however well it scores.
Without that bound the sweep drove the security threshold to the grid floor,
because the risk head happened to mask it on that dataset — and would not have
on the next request.

| | Hand-picked | Fitted |
|---|---|---|
| Wrong decisions | 4/26 | **0/26** |
| Primary-label hits | 17/26 | **25/26** |
| Unsafe outcomes | 0 | **0** |
| Min margin | — | **0.025** |

### The question that was saturating

The original clarify question asked whether *"a competent engineer must ask the
user for details"*. Jev answered yes to almost everything — 0.79–0.97 across
real requests, including a **README typo fix at 0.80**. An agent told to ask for
clarification about a typo learns to ignore the gate.

Rewritten to ask the checkable thing — *is a required input actually absent?* —
with an explicit negative anchor. Should-fire cases now sit at 0.93–0.96,
everything else at 0.16–0.84.

### Severity is ordered, and nothing is masked

The original checked ambiguity first, so `drop the users table in production`
reported **ASK_USER** — its risk 2.0 and security 0.85 were computed and thrown
away. Decisions are now ordered `HUMAN_APPROVAL > SECURITY_REVIEW >
ARCHITECTURE_REVIEW > ASK_USER`, and `reasons` lists **every** dimension that
tripped, so a strong signal is never hidden behind a weaker one.

## The gate never says yes

`hooks/jev-pretooluse.cjs` emits `deny`, `ask`, or **nothing**. It does not emit
`allow`, because an `allow` from a `PreToolUse` hook bypasses the host's own
permission prompt — a gate that emitted it would make the session *more*
permissive than having no gate at all. Silence leaves the normal flow intact, so
the gate is purely additive.

The deterministic deny floor is **never referred to the model**, so neither an
outage nor a confidently wrong answer can approve `rm -rf /`.

### What running it against real traffic found

Replaying 54 real tool calls surfaced three false-positive deny classes, each
fatal to adoption — a gate that blocks ordinary work gets switched off:

- **Heredoc bodies.** Writing a file that *discusses* `rm -rf /` — including
  this project's own tests — was denied. Bodies are now stripped first.
- **Quoted operators.** `node -e 'const c=["ls && rm -rf /"]'` was split on the
  `&&` *inside a JavaScript string literal*, and the remainder read as a bare
  `rm` command. Segment splitting is now quote- and escape-aware.
- **Foreign languages.** Following `node -e` / `python3 -c` arguments matched
  string literals, and would not catch real deletion (`fs.rm`) anyway. Recursion
  is limited to shell interpreters, where the patterns actually apply.

A deny now requires the *segment's own head* to be a dangerous binary.
**Mentioning** a dangerous string gates at worst; **running** one denies.

## Compaction is a filter, not a summary

Context compaction is conventionally a summarization prompt: hand the history to
a large model and hope it keeps the right parts. That is generation — slow,
lossy, and it rewrites what it keeps.

Keeping or dropping an entry is a *decision*. Every entry is scored against the
goal in batched questions and either survives verbatim or is dropped.

```
KEPT     0.78  Blocker: PaymentIntents requires idempotency keys…
KEPT     0.77  Decision: keep the legacy webhook endpoint alive until Dec 1
KEPT     0.70  src/billing/webhooks.ts:212 is where the signature check lives
DROPPED  0.14  Ran `ls` in the repo root, saw 14 files
DROPPED  0.05  Weather is nice today, unrelated aside
```

A failed chunk keeps everything: dropping an entry cannot be undone in-process,
keeping one only costs tokens.

## Measured cost

Per decision: **~292 input tokens, ~0.98s, ~$0.0000123** on `jev-latest`.

On 54 real tool calls from the session that built this: **17% allow, 83% gate,
0 denies**. That 83% is inflated — that session wrote nearly every file through
Bash heredocs, and an output redirect always gates. A session using normal
file-edit tools gates far less. Measure your own mix before deciding:

```js
const { classifyTool } = require("./lib/tool-gate.cjs");
// classify a transcript's tool calls without spending a token
```

## FAQ

**Does this replace my LLM?** No. The LLM still researches, writes and
generates. Jev routes, scores, approves and escalates. Code executes.

**What happens when the API is down?** `decide()` returns
`{ fallback: true, overallGate: "escalate" }`. The tool gate is the one
deliberate exception: it fails *open* for calls the deterministic floor does not
find alarming, so an outage does not brick the session, and fails to `ask` for
anything matching the destructive pattern.

**Is this a security boundary?** No. Jev is advisory, never authorization. The
code executing a decision still checks permissions, paths and approvals.

**Does it work outside Claude Code?** The libraries and CLIs are plain Node and
host-agnostic. The two hooks implement the Claude Code hook contract; porting
them to another host means reading that host's event JSON and emitting its
permission verdict.

**Do I need an API key to contribute?** No. `npm test` runs 48 offline tests
with no network and no key. Only `--live` eval and calibration need one.

## Documentation

- [Full reference](docs/jev.md) — layers, environment variables, calibration
  procedure, fallback semantics, security boundary
- [Contributing](CONTRIBUTING.md) — including how to add a calibration case
- [Security policy](SECURITY.md) — threat model and what counts as a vulnerability
- [Changelog](CHANGELOG.md)

## Credits

Built on [Jev](https://typesafe.ai), the System One model from TypeSafe AI.
The layering — *LLM generates, Jev decides, code executes* — follows the Jev
Engineering discipline; the calibration harness, deterministic deny floor, and
host hook enforcement are this project's contribution.

## License

[MIT](LICENSE) © [RavenRepo](https://github.com/RavenRepo)
