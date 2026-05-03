---
name: templestay-verification
description: "Use after templestay changes to select deterministic verification and summarize the result with PASS/WARN/FAIL status."
---

<!-- templestay-generated-from: shared/templestay/skills/templestay-verification/SKILL.md.in -->

# templestay Verification

Verification discipline for templestay changes. Use it after code, docs,
installer, config, preset, MCP, instruction, or shared-resource edits.

## Sensor Priority

Run computational sensors before inferential review:

1. Diff metadata — what actually changed and whether scope stayed clean.
2. Parse / schema checks — JSON, TOML, YAML, Markdown-frontmatter, plugin
   manifests, presets, and MCP config.
3. Focused tests — the closest tests for changed behavior.
4. Broader tests — when shared contracts, installers, MCP backends, or native
   surfaces moved.
5. Static or dry-run checks — installer dry-runs, CLI validation, materializer
   checks, or hook smoke checks when material.

Inferential review explains deterministic evidence; it does not replace it.

If Verify fails and the failed check is in scope, actionable, and repairable
inside the current plan, return a `Verify → Execute` repair record to the
parent/coder rather than performing mutating fixes inside this read-only skill.
The record must include `failed_check`, `evidence`, `execute_repair_target`,
`updated_assumption`, and the next acceptance check to re-run. The parent state
machine owns the final branching decision; verifier leaves report the repair
target and remain read-only. If the failure invalidates the plan, changes
decomposition, needs new scope, or lacks a concrete repair target, surface the
ledger for the parent state machine to re-slice through Critique/Atomize or
report `FAIL`.

## Static vs Live Readiness

Separate readiness claims in the report:

- Static readiness: parse, build, test, config validation, materializer sync,
  dry-run installer, or plugin manifest validation.
- Live runtime readiness: a real install, MCP server start, external auth path,
  network-backed check, or hook execution.

If live runtime proof was not exercised, mark it skipped or out of scope. Do not
imply end-to-end runtime proof from static evidence alone.

## Generator/Evaluator Separation

For non-trivial work, prefer an independent verifier lens, reviewer subagent, or
fresh read-only pass after implementation. The same path that generated the
change should not be the sole judge of correctness when separate evidence is
available.

## Status Tokens and Degradation Labels

Use compact tokens:

- `PASS` — planned evidence passed or a read-only answer is grounded.
- `WARN` — useful work completed with skipped evidence, degraded tooling, live
  proof not exercised, or residual risk.
- `FAIL` — an in-scope blocker remains unresolved.

When a check or delegated lens is partial, attribute the gap with
`scope-degraded`, `runtime-degraded`, `tool-degraded`, or `evidence-degraded`.

## Digest Rule

All-passing verification should be a digest. A single compact `PASS` sentence is
enough unless a check failed, warned, was skipped, performed a live mutation, or
the user requested audit detail. Do not enumerate passing test files, pass
counts, per-suite pass lines, or successful command output in normal reports.

## Boundaries

Read-only by default. Surfaced fix opportunities go back to a coder or parent
loop; this skill does not perform mutating auto-fixes.
