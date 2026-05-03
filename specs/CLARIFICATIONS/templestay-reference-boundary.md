---
status: ratified
authority: binding-clarification
last_verified: 2026-04-30
source_paths:
  - .gitmodules
  - README.md
  - specs/CLARIFICATIONS/templerun-reference-boundary.md
  - tests/resource-boundary.spec.ts
scope: `resource/templestay` submodule boundary: reference/plugin resource posture, not runtime dependency.
---

# Templestay Reference Boundary

`resource/templestay` is a checked-in reference/plugin resource posture. It is
not part of Auto Archive's runtime stack.

## Not allowed

- importing or executing `resource/templestay` from `src/`,
- treating it as a provider, runtime driver, bootstrap mode, or prompt source of
  truth,
- making tests pass only by executing code inside the submodule.

## Allowed

- documentation comparison,
- instruction/protocol reference for human review,
- migration notes that keep Auto Archive source contracts as the actual runtime
  truth.

This supersedes the historical `resource/templerun` posture for current work,
while the older templerun clarification remains as historical boundary context.
