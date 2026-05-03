---
status: draft
level: L2
type: feature|bugfix|refactor|behavior|review
created: YYYY-MM-DD
author: agent-or-user
relates_to: "docs/templestay-native-kernel.md"
---

# Spec: [Feature Name]

## Summary

[Describe the problem, intended outcome, and why this is an L2 change in 2–4
sentences. Keep this root-native to templestay; do not copy legacy runtime
protocol text.]

## Requirements

### Problem

[What is broken, missing, or suboptimal. Include evidence when available.]

### Goal

[What success looks like. Prefer observable behavior over implementation prose.]

### Boundaries

- In scope: [short list]
- Out of scope: [short list]
- Runtime boundary: [Codex/Claude/root docs/MCP/tests touched; no legacy runtime wiring]

## Affected Surface

| Surface | Planned change |
|---|---|
| `path/to/file` | [brief change] |

## Acceptance Criteria

- [ ] [Criterion 1]
- [ ] [Criterion 2]
- [ ] Deterministic verification is identified before inferential review.
- [ ] No Copilot approval-gate, continuation-menu, mediator, or legacy MCP wiring semantics are introduced.

## Verification Plan

| Check | Command or method | Expected result |
|---|---|---|
| Static/schema | [command] | PASS |
| Focused tests | [command] | PASS |

## Notes

[Optional context, alternatives, or follow-up items.]

---
*Template: `specs/_templates/lightweight.md` — for templestay L2 root-native changes*
