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
echo 'LIQUID_API_KEY=your_liquid_key' >> .env  # optional: d1 for the output filter
npm test                                        # offline tests, no key needed
```

Wire the hooks into Claude Code (idempotent, backs up first, preserves existing hooks):

```bash
node bin/install-hooks.cjs        # --remove to reverse
```

Restart your agent. `JEV_HOOKS_DISABLE=1` is the runtime kill switch.

## The layers

| Layer | What decides | Cost | Where |
|---|---|---|---|
| **L0** | Deterministic code. No model call. | 0 | [`lib/tool-gate.cjs`](lib/tool-gate.cjs) |
| **L1** | Jev, on a tool call about to execute | ~1s, cached 6h | [`hooks/jev-pretooluse.cjs`](hooks/jev-pretooluse.cjs) |
| **L2** | Jev, on an incoming task | ~1s | [`hooks/jev-intake.cjs`](hooks/jev-intake.cjs) |
| **L3** | Jev, on finished work and on routing | ~1s | [`lib/verify.cjs`](lib/verify.cjs) |
| **L4** | Jev, on what to keep in context | ~1.5s / 25 entries | [`lib/compact.cjs`](lib/compact.cjs) |
| **L5** | Jev (or Liquid d1), on which lines of a long command output the reader needs | 0 for passing runs; ~1s / 25 blocks | [`hooks/jev-posttooluse.cjs`](hooks/jev-posttooluse.cjs), [`lib/filter.cjs`](lib/filter.cjs) |
| **L6** | Jev, on which model a subagent needs | ~1s per spawn | [`lib/route-agent.cjs`](lib/route-agent.cjs) |

**L0 is the layer that makes the rest viable.** A decision costs ~1s and a
session makes hundreds of tool calls. Gate all of them and the session becomes
unusable — and an unusable gate gets switched off. Only what L0 cannot settle
reaches the model.

## Command line

```bash
jev-gate    --request "add OAuth login"               # 0 proceed, 3 escalate
jev-route   --request "rename a local variable"       # deterministic|cheap|strong|human
jev-verify  --artifact-file out.ts --requirements "…" # 0 accept, 3 revise
jev-compact --goal "…" --file history.json            # relevance and supersession filter
npm test 2>&1 | jev-filter --goal "why the tests fail"  # keep the lines the goal needs
```

## Output is a filter, not a summary

The most expensive thing in an agent session is the context the strongest
model reads, and the longest things it reads are command outputs: a test run,
a build, an install. Most of those lines are passes and progress. The
PostToolUse hook hands the agent the lines the command's purpose needs,
verbatim, and saves the full output to a file it can read for the rest
(`logs/filtered/`, owner-only, newest 200 kept). Every segment of the command
line is checked: short output, anything that reads or searches (`cat`, `grep`,
`ls`, `git diff`, anywhere in the line), and anything it cannot parse pass
through untouched; any failure keeps everything.

**Secrets are never sent.** A command that prints environment or secrets
(`env`, `printenv`, `kubectl get secret`, `docker inspect`, `docker compose
config`, `terraform output`, …) and any output that holds a credential shape
(AWS, GitHub, OpenAI-style keys, JWTs, private keys, `*_KEY=` assignments) is
left alone and not sent to an engine. Filter requests are logged as counts, not
text, and the decision log is owner-only. `VAR=value` prefixes are struck from
the goal before it is sent.

Cheapest first: error and failure lines, the lines that carry a failure's
values and place (`Expected`/`Received`, `3 !== 4`, a diff's `+`/`-` lines, a
code frame, stack and traceback frames), the block right after any of them, and
the line saying how a command finished are kept without asking; lists of passing tests and repeated blocks
are dropped without asking; only what is left is scored against the goal, on Jev.

Liquid d1 can score instead (`JEV_FILTER_ENGINE=liquid`) and keeps the same
lines, but it is not the cheaper engine here: it bills every question as its
own prompt with the whole state, so on the filter evals it used **3,786 input
tokens a question against Jev's 380**, about ten times the cost despite
generating no output.

On `eval/filter-cases.json` (a passing and a failing test run, a Vite build,
an npm install that fails, a server log with one crash), at the fitted keep
threshold of 0.5: **14/14 must-keep lines survive on both engines, and about 64%
of the lines are cut in 3–4 requests.** A jest, a node:test and a 14-frame
pytest failure keep their values, code frame and traceback even when every
block is scored 0.1 (`test/filter.test.cjs`). A passing 250-line test run becomes 9
lines with no model call. Re-run with `npm run eval:filter`.

The question's wording was measured, not guessed: the structured `compare`
form scored the one failing line of a test run at 0.70 on Jev and 0.18 on d1;
plain keep criteria with a negative anchor scored it at 0.96 and 1.00.

## Subagents run on the model their task needs

A subagent inherits the session's model, so a file search spawned from an Opus
session runs on Opus. On an Agent call that names no model, Jev scores how much
reasoning the task needs; below 0.35 goes to Haiku and below 1.2 to Sonnet, but
only when Jev's confidence clears the auto threshold (0.85), and only to a
model below the session's own, read from the transcript (when it cannot be
read, only Haiku). Only types that inherit the session's model are routed
(`general-purpose`, `claude`): Explore and plugin agents pin their own, and
setting a model on them could raise it. Hard tasks, forks and calls that chose a
model are left alone. On `eval/route-agents.json`, replayed as from an Opus
session: **15/16 exact, 1 left on the stronger model, 0 unsafe downgrades**
(`npm run eval:route`). `JEV_ROUTE_AGENTS=0` turns it off.

This is the one place the PreToolUse hook returns `allow`: Claude Code applies
a rewritten input only with `allow` or `ask`. It is returned only for an Agent
call the deterministic layer already allows, and the subagent's own tool calls
still pass through the gate.

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

Scoring each entry on its own misses one kind of dead weight: an entry a later
entry has replaced. An old status line is still on-topic. On 50 real
orchestration-memory entries, four stale ones (an old "ready for review" line
after a newer one, "ADR N: reserved for X" left beside "ADR N done") scored
0.71–0.74, the same as live ones, and nothing was dropped.

So there is a second pass. Code finds the pairs worth asking about, with no
model call: an older entry and a later one that share an anchor (an issue or
ADR number, a SHA, a path, a backticked span, a version, an id with a digit,
the leading label) or enough content words, at most four per entry. Jev is
asked, pair by pair, whether the later entry makes the older one out of date —
a newer status, a reversed decision, the item done, a corrected value — and
told to answer no for different subjects, for a later entry that only adds
detail, and for an older entry holding a rule, constraint or identifier the
later one omits. The older entry is dropped as superseded only when the answer
reaches the threshold, it is not pinned, and its replacement survives the final
set, directly or through its own replacement. Dropped entries say why
(`reason: "irrelevant" | "superseded"`, with `supersededBy`).

On `eval/compact-cases.json` (ten synthetic sessions: status logs, ADR number
allocations, PRs going from pending to merged, a reversed decision, corrected
facts), at the threshold of 0.6: **68/68 must-keep entries survive, including
near-duplicates that are not replacements, and 11 of 32 superseded entries are
caught**, for one extra request per 25 pairs. 0.6 is the lowest threshold that
kept every must-keep entry; the pairs whose older entry must stay never scored
above 0.28. Re-run with `npm run eval:compact`.

The question's wording was measured too. The first wording asked whether the
older entry "adds nothing" the later one does not say; it put 12 of 48 true
replacements at 0.6 or above, because nearly every old status line says
something its replacement does not repeat. Asking whether the older entry is
out of date put 30 there, and held the must-stay pairs lower.

Limits. Entries must be in chronological order, or all carry `meta.ts`: an
"ADR N done" line filed above "ADR N reserved" cannot replace it. A
replacement that shares no anchor and few words with the old entry ("Decision:
use advisory locks", then "Decision reversed: use a unique index") is never
asked about. A long status line that lists several items is only replaced by a
line covering all of them. And supersession can only drop an entry whose
replacement the relevance pass keeps; on the eval, relevance dropping the newer
entry accounts for most of the misses. On the 50 real entries, the second pass
dropped nothing.

A failed chunk keeps everything: dropping an entry cannot be undone in-process,
keeping one only costs tokens. `--no-supersede` turns the second pass off,
`--supersede-threshold` moves it.

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

## Author

**Amit Kumar** — aka **growthperclick** — GitHub: [@RavenRepo](https://github.com/RavenRepo)

## Credits

Built on [Jev](https://typesafe.ai), the System One model from TypeSafe AI.
The layering — *LLM generates, Jev decides, code executes* — follows the Jev
Engineering discipline; the calibration harness, deterministic deny floor, and
host hook enforcement are this project's contribution.

## License

[MIT](LICENSE) © Amit Kumar ([@RavenRepo](https://github.com/RavenRepo))
