---
status: final
type: report
level: L2|L3|L4|L5
created: YYYY-MM-DD
author: agent-or-user
relates_to: "specs/[parent].md"
parent_plan: "specs/[plan].md"
commits: []
---

# [Summary-Word]: [One-Line Detail]

## Summary

[What was accomplished, what changed, and whether the requested outcome is
complete. Keep enough detail for review without repeating full command output.]

Use `[REPORT]` for visible completion summaries, `[VERIFY]` for standalone
verification summaries, and `[RISK]` when residual risk is the dominant outcome.

## Implementation

| Surface | Result |
|---|---|
| `path/to/file` | [brief result] |

## Verification

| Check | Result | Notes |
|---|---|---|
| [command or review] | PASS|WARN|FAIL | [short note] |

- Static readiness: PASS|WARN|FAIL
- Live runtime readiness: PASS|WARN|FAIL|SKIPPED

All-passing verification should stay compact unless a check failed, warned, was
skipped, performed a live mutation, or the user requested audit detail.

## Remaining Risk

[Residual risk, intentionally excluded scope, or "None." Do not end with a
promise to continue the same request later.]

## Deviations

| Planned | Actual | Reason |
|---|---|---|
| [item] | [result] | [reason] |

## Follow-Up Context

[Optional non-blocking follow-up suggestions.]

---
*Template: `specs/_templates/report.md` — for templestay completion reports*
