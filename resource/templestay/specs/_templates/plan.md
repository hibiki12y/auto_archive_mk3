---
status: draft
level: L2|L3|L4|L5
type: plan
created: YYYY-MM-DD
author: agent-or-user
relates_to: "specs/[parent].md"
parent_spec: "specs/[parent].md"
---

# [Summary-Word]: [One-Line Detail]

## Objective

[State the implementation objective in enough detail for another engineer or
agent to execute without inventing missing decisions.]

## Work Units

| # | Work unit | Owner | Surfaces | Depends on | Done when |
|---|---|---|---|---|---|
| 1 | [Description] | [owner] | `path/to/file` | — | [observable condition] |
| 2 | Verification | verifier | tests | 1 | [checks pass] |

## Output Contract

- Use `[PLAN]` for visible decision-complete plans when a plan artifact is
  warranted.
- Use `* Summary:`, `* Implementation:`, `* Verification:`, and
  `* Remaining Risk:` as medium headings when those sections are needed.
- Use `PASS`, `WARN`, and `FAIL` status tokens for evidence outcomes.
- Do not add interactive approval schemas, continuation menus, or legacy runtime
  wrappers to native Codex or Claude output.

## Risk and Mitigation

| Risk | Mitigation |
|---|---|
| [Risk] | [Mitigation] |

## Evidence Contract

| Evidence type | Required evidence | Owner / timing |
|---|---|---|
| Computational sensors | [syntax/schema/tests/dry-run] | [before report] |
| Inferential sensors | [reviewer/challenge lens if material] | [after deterministic checks] |
| Artifacts | [diff summary, memory record, generated docs] | [final report] |

## Assumptions

- [Assumption 1]
- [Assumption 2]

---
*Template: `specs/_templates/plan.md` — for templestay decision-complete implementation plans*
