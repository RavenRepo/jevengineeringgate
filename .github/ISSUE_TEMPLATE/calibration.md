---
name: Calibration issue (wrong decision)
about: The gate made a decision you disagree with
title: 'Calibration: <short description of the request>'
labels: calibration
---

**The request**

```
<the exact text passed to --request, or the tool call>
```

**What it decided, and what it should have decided**

Paste the `--json` output so the raw probabilities are visible:

```json
```

Expected decision:
Defensible alternatives:

**Is auto-proceeding here a safety failure?**

<yes/no — this determines whether the case is marked `unsafe_if_implement`>

**Per-head ground truth**

See `dim_definitions` in `eval/requests.json`.

- security:
- architecture:
- unclear:
- risky:

**Environment**

- `JEV_MODEL`:
- Any non-default `JEV_*_THRESHOLD`:
