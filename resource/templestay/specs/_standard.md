---
status: ready
level: L2
type: behavior
created: 2026-04-30
author: claude-sonnet-4-6
relates_to: "docs/templestay-native-kernel.md"
---

# Spec Authoring Standard

This document codifies the templestay spec format: level and status and type
taxonomies, required frontmatter fields, required sections per template,
acceptance and verification patterns, and naming/SSoT rules. All rules are
native to templestay (Codex CLI / Claude Code). No legacy Copilot runtime
protocol is carried here.

## Level taxonomy

| Level | Definition | Template |
|---|---|---|
| L2 | Single-file or tightly bounded root-native change. Fits one surface. | `lightweight.md` |
| L3 | Multi-surface change requiring design and work-unit decomposition. | `full.md` |
| L4 | Architecture or migration change touching platform contracts or structure. | `full.md` |
| L5 | Cross-platform or native-runtime contract change with external coordination. | `full.md` |

`plan.md` and `report.md` apply at any level.

## Status taxonomy

| Status | Meaning | Gate to next status |
|---|---|---|
| `draft` | Work in progress; acceptance criteria may be incomplete. | Add complete acceptance criteria → `proposed` |
| `proposed` | Acceptance criteria complete; awaiting verification plan. | Add verification plan → `ready` |
| `ready` | Verification plan complete; ready for implementation. | Implementation done and verified → `implemented` |
| `implemented` | All acceptance criteria verified. | Replacement spec added → `superseded` |
| `superseded` | Replaced by a newer spec named in `supersedes:`. | Terminal. |

## Type taxonomy

| Type | Definition |
|---|---|
| `feature` | Adds new user-facing or agent-facing capability. |
| `bugfix` | Corrects an observable defect. |
| `refactor` | Restructures existing logic without changing external behavior. |
| `behavior` | Adjusts policy, defaults, or agent behavior without adding features. |
| `review` | Audit or quality review with no mandatory code change. |
| `architecture` | Changes structural or platform boundaries. |
| `migration` | Moves content or behavior from one surface to another. |
| `native-platform` | Defines or updates a native Codex/Claude platform contract. |
| `integration` | Connects two surfaces or external services via a defined interface. |
| `memory` | Changes the memory schema, routing, or persistence contract. |

`lightweight.md` accepts: `feature`, `bugfix`, `refactor`, `behavior`, `review`.  
`full.md` accepts: `architecture`, `migration`, `native-platform`, `integration`, `memory`.

## Frontmatter

Required fields:

| Field | Value |
|---|---|
| `status` | One of the five status values above. |
| `level` | `L2`, `L3`, `L4`, or `L5`. |
| `type` | One type from the taxonomy above. |
| `created` | `YYYY-MM-DD`. |
| `author` | Agent id or user handle. |
| `relates_to` | Path to the primary SSoT document. |

Optional fields:

| Field | When to include |
|---|---|
| `validated` | Date and method when external validation was performed. |
| `default` | Runtime default if the spec governs an opt-in behavior (`disabled` / `enabled`). |
| `invocation` | Invocation constraint, e.g. `manual_only_ultra_high_precision`. |
| `supersedes` | Path to the spec this one replaces. |

Minimal example:

```yaml
---
status: draft
level: L2
type: feature
created: 2026-04-30
author: claude-sonnet-4-6
relates_to: "docs/templestay-native-kernel.md"
---
```

## Required sections by template

| Template | Required headings |
|---|---|
| `lightweight.md` | Summary · Requirements (Problem / Goal / Boundaries) · Affected Surface · Acceptance Criteria · Verification Plan |
| `full.md` | 1. Requirements · 2. Design · 3. Work Units · 4. Decisions · Acceptance Criteria · Verification Plan |
| `plan.md` | Objective · Work Units · Output Contract · Risk and Mitigation · Evidence Contract · Assumptions |
| `report.md` | Summary · Implementation · Verification · Remaining Risk · Deviations |

Notes sections (lightweight) and Follow-Up Context sections (report) are optional.

## Acceptance criteria pattern

- Write each criterion as an observable outcome, not an implementation step.
- Order deterministic checks before inferential review.
- Include at least one criterion that the change introduces no Copilot approval-gate,
  continuation-menu, mediator, or legacy MCP wiring semantics.
- Do not gate acceptance on approval from an external role, council, or vote.
- Each criterion must have an unambiguous PASS or FAIL state.

Example:

```
- [ ] `templestay-verification` skill returns PASS on all schema checks.
- [ ] No new `ask_user` or `AWAIT` patterns are introduced.
- [ ] Inferential review confirms prose correctness (after deterministic checks pass).
```

## Verification plan pattern

Three evidence types, in this order:

| Evidence type | Definition | Example |
|---|---|---|
| Computational sensors | Parse, build, schema, test, or dry-run commands with deterministic output. | `python -m pytest tests/ -q` → all pass |
| Inferential review | Semantic or qualitative review; only after computational sensors pass. | Verifier reads diff for correctness. |
| Artifacts | Diff summaries, generated files, or memory records produced by the work. | `git diff --stat HEAD~1` |

Computational sensors must appear first in the plan. Inferential review is
optional when computational sensors are sufficient.

## Naming and SSoT

**File naming:** `<topic>-<scope>.md`, lowercase kebab-case. No version suffix
in the filename; version or revision information belongs in frontmatter or in
the document body.

**Cross-reference rule:** every numeric or structural claim names the SSoT file
and section it depends on. Write `(see docs/templestay-native-kernel.md §
Verification Vocabulary)` rather than restating the claim inline.

**Supersession rule:** when a new spec replaces an existing one, set the old
spec's `status` to `superseded` and add `supersedes: "specs/<old-file>.md"` to
the new spec's frontmatter. Both files remain in the tree.

## Templates index

| Template | Role |
|---|---|
| `_templates/lightweight.md` | L2 single-file root-native changes — concise summary, requirements, acceptance, verification. |
| `_templates/full.md` | L3+ changes — numbered sections for requirements, design, work units, and decisions. |
| `_templates/plan.md` | Decision-complete implementation plans at any level — work units, output contract, evidence contract. |
| `_templates/report.md` | Completion reports — implementation table, verification table, remaining risk, deviations. |
