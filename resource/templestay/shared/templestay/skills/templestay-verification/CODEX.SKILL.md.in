---
name: templestay-verification
description: "Use after Codex changes to run same GPT-family verification plus hetero-model Critique, then summarize with PASS/WARN/FAIL status."
---

<!-- templestay-generated-from: shared/templestay/skills/templestay-verification/CODEX.SKILL.md.in -->

# templestay Verification and Critique

Verification discipline for Codex-side templestay changes. Use it after code,
docs, installer, config, preset, MCP, instruction, or shared-resource edits.
Codex verification intentionally separates two stages:

1. **Verify** — deterministic sensors plus same GPT-family semantic review.
2. **Critique** — a regular hetero-model double-check, normally Claude Opus 4.7
   through `claude-gateway`, after Verify.

## Verify: Sensor Priority

Run computational sensors before inferential review:

1. Diff metadata — what actually changed and whether scope stayed clean.
2. Parse / schema checks — JSON, TOML, YAML, Markdown-frontmatter, plugin
   manifests, presets, and MCP config.
3. Focused tests — the closest tests for changed behavior.
4. Broader tests — when shared contracts, installers, MCP backends, or native
   surfaces moved.
5. Static or dry-run checks — installer dry-runs, CLI validation, materializer
   checks, or hook smoke checks when material.

Same GPT-family review may explain deterministic evidence and inspect gaps, but
it does not replace executable sensors. Do not use a hetero model as the Verify
result.

If Verify fails and the failed check is in scope, actionable, and repairable
inside the current plan, return a `Verify → Execute` repair record to the
parent/coder instead of proceeding to Critique. The record must include
`failed_check`, `evidence`, `execute_repair_target`, `updated_assumption`, and
the next acceptance check to re-run. The parent state machine owns the final
branching decision; verifier leaves report the repair target and remain
read-only. After the focused Execute fix, repeat the relevant Verify checks
before running hetero Critique. If the failure invalidates the plan, changes
decomposition, needs new scope, or lacks a concrete repair target, do not patch
ad hoc; surface the ledger for `Critique → Atomize → Plan` or `Report(FAIL)`
according to the parent state machine.

## Critique: Hetero Claude Opus 4.7 Double-Check

For non-trivial Codex changes, run the lifecycle in two verification layers:

1. **Verify first** — executable/static sensors, same GPT-family review, and a
   compact evidence ledger.
2. **Critique second** — invoke `claude_prompt` through `claude-gateway` with
   `model=claude-opus-4-7` and `effort=max` (or the explicit user-approved
   successor/alias). Provide the patch summary, relevant diff excerpts, and
   deterministic check results. Ask Claude for evidence-grounded verification
   risks and missed-check suggestions, not for edits, votes, or a binding
   verdict.

Before the gateway call, run `claude_preflight` when available and prepare a
minimal, secret-screened evidence bundle. Include only the patch summary,
relevant diff excerpts, and deterministic check results. Do not send `.env`,
private keys, credentials, secret-bearing raw logs, or unrelated repository
content. When the runtime/tooling treats `claude-gateway` as an external
data-transfer boundary, use
`claude_preflight().content_transfer_policy` as the transfer gate before
calling `claude_prompt`. If `content_transfer_allowed=true`, the route is
policy-preauthorized and per-call explicit external-transfer approval is not
required. If policy preauthorization or destination trust is absent, do not
transmit repository-derived summaries, diffs, logs, or file details; a request
to document, test, or improve the Critique lane is not by itself transfer
authorization. You may run a separate synthetic connectivity check with no
repository-derived or private content to prove the Claude route is live, but
report it separately from content-bearing Critique.

Treat the Claude response as independent Critique evidence. Codex remains the
repository writer and final reporter. If the gateway/model/auth path is
unavailable, if policy preauthorization is absent, if user/system policy blocks
the required data transfer, or if destination trust is not established, mark the
Critique `WARN runtime-degraded` or `WARN tool-degraded`; do not claim full
hetero Critique readiness, but do not replace deterministic failures or passes
with an LLM-only judgment. Do not replace a missing hetero Critique with the
same GPT-family verifier. Use a hetero successor only when explicitly
authorized; otherwise report the Critique lane as degraded.

Skip the Claude Opus 4.7 Critique only for trivial/local checks where the change
is single-line, fully covered by deterministic sensors, or when the
gateway/data-transfer path is explicitly out of scope, lacks policy
preauthorization, is missing destination trust, or is degraded. The report must
record the skip reason or degradation. Do not run iterative LLM-vs-LLM critique
loops.

## Static vs Live Readiness

Separate readiness claims in the report:

- Static readiness: parse, build, test, config validation, materializer sync,
  dry-run installer, plugin manifest validation, and static proof that the
  regular Claude Opus 4.7 Critique route is configured.
- Live runtime readiness: a real install, MCP server start, external auth path,
  network-backed check, hook execution, a synthetic no-repository
  `claude_prompt` route check, or a successful content-bearing `claude_prompt`
  invocation against Claude Opus 4.7 with effort `max` when the transfer is
  policy-preauthorized and destination trust is established.

If live runtime proof was not exercised, mark it skipped or out of scope. Do not
imply end-to-end runtime proof from static evidence alone.

## Generator/Evaluator Separation

For non-trivial Codex work, prefer a same GPT-family Verify pass that is not the
implementation step's only unchecked assertion, then include the Claude Opus 4.7
Critique result in the evidence ledger. The hetero Critique is evidence, not a
vote, authority, or writer. Keep the Verify evidence and Critique evidence
separate in reports so Claude findings are not mislabeled as same-family
verification.

## Status Tokens and Degradation Labels

Use compact tokens:

- `PASS` — planned evidence passed and Critique found no blocking issue, or a
  read-only answer is grounded.
- `WARN` — useful work completed with skipped evidence, degraded tooling, live
  proof not exercised, Critique unavailable, or residual risk.
- `FAIL` — an in-scope blocker remains unresolved.

When a check or delegated lens is partial, attribute the gap with
`scope-degraded`, `runtime-degraded`, `tool-degraded`, or `evidence-degraded`.

## Digest Rule

All-passing verification and Critique should be a digest. A single compact
`PASS` sentence is enough unless a check failed, warned, was skipped, performed
a live mutation, or the user requested audit detail. Do not enumerate passing
test files, pass counts, per-suite pass lines, or successful command output in
normal reports.

## Boundaries

Read-only by default. Claude Opus 4.7 Critique is also read-only: no
`claude_apply`, no patch generation, no permission bypass, no vote/consensus
claim. Surfaced fix opportunities go back to a coder or parent loop; this skill
does not perform mutating auto-fixes.
