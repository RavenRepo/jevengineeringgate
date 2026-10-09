# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Supersession in compaction** (`lib/compact.cjs`, `jev-compact`). An entry
  another entry has replaced is dropped when its replacement survives. Up to
  60 entries every pair is judged (`allPairsUpTo`, within `maxPairs` 2000);
  above that, pairs that share an anchor or content words. Entries without
  `meta.ts` are unordered (`order`): each pair is judged both ways and one
  side drops only when the reverse answer is below 0.5. Dropped entries carry
  `reason`, `supersededBy`, `ps` and `psReverse`; stats add `superseded`,
  `order`, `pairsJudged`, `supersedeRequests` and `failedSupersedeRequests`,
  and `requests` is still the relevance count. `--no-supersede`,
  `--supersede-threshold` and `--order` on the CLI. The default threshold,
  0.8, is the lowest that kept every must-keep entry over three runs with a
  margin of 0.1.
- **`eval/compact-cases.json`, `eval/compact-cases-holdout.json` and
  `npm run eval:compact`.** 14 synthetic cases with their true pairs, and four
  held out. The harness reports must-keep recall, catches, candidate recall
  and the highest answer against a must-keep entry.

### Fixed

- **The compaction relevance pass dropped done items.** Its question said to
  drop entries "superseded, already acted on", so a merged PR or a finished
  task scored as noise; it also scored entries late in a request lower. On
  the eval it lost 11–14 of 104 must-keep entries; now 0.

## [1.0.0] - 2026-09-20

First public release.

### Added

- **Fitted threshold calibration** (`eval/calibrate.cjs`, `eval/requests.json`).
  26 labeled intake cases with per-head ground truth, a record/sweep split so
  the grid search costs no tokens, and a lexicographic objective that puts zero
  unsafe outcomes first and threshold margin above routing quality.
- **L0 deterministic tool classification** (`lib/tool-gate.cjs`). Allow / deny /
  gate with a quote-aware shell segment splitter, a head-anchored deny floor,
  heredoc stripping, sensitive-path detection, operator-protected patterns, and
  a TTL-bounded result cache.
- **L1 `PreToolUse` hook** (`hooks/jev-pretooluse.cjs`). Emits `deny`, `ask` or
  nothing; never `allow` unless `JEV_TOOL_AUTO_ALLOW=1`.
- **L2 `UserPromptSubmit` hook** (`hooks/jev-intake.cjs`). Injects routing
  context; never blocks a turn.
- **L4 context compaction as a relevance filter** (`lib/compact.cjs`,
  `bin/jev-compact.cjs`), with pinning and keep-on-failure semantics.
- CLIs: `jev-gate`, `jev-route`, `jev-verify`, `jev-compact`.
- `bin/install-hooks.cjs` — idempotent hook registration with backup and removal.
- 48 offline tests requiring no API key.

### Changed

- **Severity ordering in the intake gate.** Decisions now rank
  `HUMAN_APPROVAL > SECURITY_REVIEW > ARCHITECTURE_REVIEW > ASK_USER`. Previously
  ambiguity was checked first, so `drop the users table in production` reported
  `ASK_USER` while its risk and security signals were computed and discarded.
  `reasons` now lists every dimension that tripped.
- **The `needs_clarification` question was rewritten.** It previously asked
  whether "a competent engineer must ask for details" and answered yes to
  roughly four of five real requests, escalating a README typo fix at 0.80. It
  now asks whether a required input is actually absent, with an explicit
  negative anchor. Should-fire cases separated to 0.93–0.96 against 0.16–0.84.
- **Intake thresholds refitted**: clarify 0.70 → 0.885, security 0.80 → 0.905,
  architecture 0.70 → 0.875, risk 1.50 → 1.93. Hand-picked values scored 4 wrong
  and 17/26 primary hits; fitted values score 0 wrong and 25/26.
- `jev-gate` is now a thin CLI over `lib/gate.cjs`, shared with the intake hook.
  Exit codes are unchanged (0 proceed, 3 escalate, 2 usage error).
- All paths resolve from the repository root instead of an absolute install
  location, so a clone works wherever it lands.
- `audit.cjs` reads page text from a file or stdin instead of embedding it.

### Fixed

- Cache TTL comparison was exclusive, so `JEV_TOOL_CACHE_TTL_MS=0` kept an entry
  valid within the same millisecond instead of disabling the cache.
- Three deny false-positive classes found by replaying real tool traffic:
  heredoc bodies being scanned as commands, shell operators inside quoted
  strings splitting a string literal into a phantom command, and interpreter
  recursion matching string literals in languages the patterns were not written
  for.
- Omitting `cd` from the read-only command heads sent 85% of real tool calls to
  the model.
