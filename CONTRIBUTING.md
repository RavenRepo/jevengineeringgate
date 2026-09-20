# Contributing

Thanks for considering a contribution. This project has one unusual rule worth
reading before you open a PR.

## You do not need an API key

```bash
npm install
npm run test:offline    # 48 tests, no network, no key
```

Only live evaluation and threshold calibration need `TYPESAFE_API_KEY`.

## Do not hand-edit thresholds

`JEV_CLARIFY_THRESHOLD`, `JEV_SECURITY_THRESHOLD`, `JEV_ARCH_THRESHOLD` and
`JEV_RISK_THRESHOLD` in `lib/config.cjs` are the **output of a fitting
procedure**, not opinions. A PR that changes one by hand will be asked to
re-derive it instead, and `test/engine.test.cjs` asserts the current values
specifically so that an accidental edit fails CI.

If a threshold is wrong, the fix is a better dataset:

1. Add the failing request to `eval/requests.json` with:
   - `primary` — the decision you expect
   - `accept` — every decision that would be defensible
   - `unsafe_if_implement: true` if auto-proceeding would be a safety failure
   - `dims` — per-head ground truth (see `dim_definitions` in that file)
2. `npm run calibrate:record` — one Jev call per case, a few seconds
3. `npm run calibrate` — prints the new operating point and per-case results
4. Update `lib/config.cjs` and `test/engine.test.cjs` with the sweep's output
5. Include the sweep output in your PR description

The sweep will refuse to hand you an operating point with a nonzero `unsafe`
count. If you cannot reach zero, that is a finding — say so in the issue rather
than relaxing the objective.

## Adding a new decision

1. Name **one** judgment. Write explicit criteria with a negative anchor.
   Vague meta-questions ("would an engineer…") produce saturated heads that
   answer yes to everything — see the clarify-question rewrite in the README.
2. Pack minimal, factual state. No secrets, no whole-file dumps.
3. Batch independent questions into one `decide()` call. Questions cannot read
   each other's answers; if one depends on a fresh result, run that first.
4. Map gates in code. **Never let a model alone grant a privileged capability.**
5. Add obvious, ambiguous, edge and adversarial cases, then re-sweep.

## Changing the deterministic deny floor

`lib/tool-gate.cjs` holds a hard deny list that is never referred to the model.
Changes there need:

- a test proving the dangerous form still denies, and
- a test proving a *mention* of it does not.

That second test is not optional. Three separate false-positive classes were
found by replaying real traffic — heredoc bodies, operators inside quoted
strings, and interpreter arguments in other languages — and each one would have
blocked ordinary work badly enough to get the whole gate disabled.

## Style

Match the surrounding code: CommonJS, no build step, no dependencies beyond the
SDK. Comments explain *why*, especially where a choice looks arbitrary but is
load-bearing. Keep functions pure where the calibration harness needs to replay
them offline.

## Commit and PR

- One logical change per PR
- `npm test` green before pushing
- Describe the failure mode your change prevents, not just the mechanism
