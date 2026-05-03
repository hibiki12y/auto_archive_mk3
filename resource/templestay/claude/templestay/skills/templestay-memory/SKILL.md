---
name: templestay-memory
description: "Use to preserve task anchors and durable progress through the shared templestay memory MCP server when available."
---

<!-- templestay-generated-from: shared/templestay/skills/templestay-memory/SKILL.md.in -->

# templestay Memory

Durable cross-platform progress for templestay tasks. The memory MCP server
(`mcp__memory__*` or the platform plugin's equivalent namespace) is the single
source of truth. Claude auto memory and Codex built-in memories are disabled by
templestay presets and should be treated as historical/local context only.

## Task Anchor Capsule

For looping or long-running tasks, write a compact task-anchor capsule when the
memory MCP is available. Include these fields when available and safe
(secret-screen the request before writing):

- `deployment_id`: `templestay`
- `project_key`: stable repo identity. Prefer `git rev-parse --show-toplevel`
  combined with the remote URL; fall back to a normalized cwd hash.
- `session_id`: runtime/session id from session-gate, MCP context, or another
  platform-provided id. If detection fails, derive a deterministic fallback such
  as `templestay-<project_slug>-<request_hash>` or a platform-prefixed variant.
- `request_hash`: short hash of the active user request plus `project_key`.
  Anchor only — not a secret, do not embed credentials.
- request summary, constraints, acceptance checks, exclusions, safety boundary
- `loop_index`, `max_loop_budget` when known (or pending until Atomize chooses
  it), current state, stop condition
- verification expectations and current blocker when applicable

Re-inject the capsule into the working context before each Atomize after the
first pass, after every Critique repair edge, and before any compaction so the
original user intent survives context loss. Update the capsule after the
initial Atomize pass records the chosen loop budget.

Legacy session capsules may use the former `Feedback` repair-edge label. Treat
those records as historical aliases for Critique repair context when reading
old memory, but write new capsules with `Critique` terminology only.

## Concurrency and Namespacing

Concurrent sessions in the same project must not collide. Do not use a shared
singleton entry named "current task". Namespace all memory MCP records by the
triple `(project_key, session_id, request_hash)`.

- Use session-scoped memory for active loop capsules.
- Promote only durable, secret-free decisions or handoff summaries to shared
  project memory.
- Do not write per-session mutable request capsules into tracked instruction
  files such as `CLAUDE.md`, `.claude/rules/`, `AGENTS.md`, or preset files;
  those files record stable project protocol only.

## Write Evidence and Failure Recovery

For non-trivial repository work, the task-anchor capsule is a required
`memory_session_save` write when the tool is available, not a planned note.

- Default: call `memory_session_save` with the capsule.
- If it fails with no active session detected, retry once with an explicit
  `session_id` (live runtime id, or the deterministic fallback).
- If memory MCP tools are unavailable or the explicit-session retry still fails,
  label the result `memory-record-degraded`, keep the capsule contents in the
  visible plan/report, and do not claim cross-platform memory sharing succeeded.
- At Report, write a completion capsule (final `loop_index`, verification
  outcome, residual risks). Include the saved record id/path in the report when
  available.

## Checkpoint Capsule (Long-Running Work)

Before compaction, a long background continuation point, or any multi-loop pause,
persist a compact checkpoint capsule that re-anchors to the same request:

- `request_anchor`: the same `(project_key, session_id, request_hash)` triple,
  plus `intake_mode` (`fresh_reset` when a new task superseded the prior
  request, `explicit_continuation` when the user continued the same one),
  `superseded_request`, `loop_index`, `max_loop_budget`, `stop_condition`.
- `phase`: current state.
- `summary` and `completed_work` so far.
- `key_decisions` and `open_risks`.
- `next_action` so a resumed session can continue without re-reading the full
  history.

Keep `request_anchor` stable across checkpoint updates while the same request is
active. On `fresh_reset`, refresh `request_hash` and clear stale
request-specific acceptance/exclusions unless the user explicitly asked to
continue.

## Post-Completion Micro-Consolidation

After Report on a non-trivial task, run a read-only extraction pass for durable
lessons:

- Scope: `decisions`, `bugs and root causes`, `conventions established`, `user
  feedback / corrections`, `external references` mentioned.
- Output: candidate items with content, type, source, and confidence (high /
  medium / low). Surface them as candidates only.
- This pass is **read-only** — do not call `memory_save`,
  `memory_session_save`, `memory_update`, `memory_delete`, or any promote /
  persist tool from this micro path. The user authorizes promotion separately.
- If extraction finds no medium- or high-confidence items, exit quietly.

## Shared memory-v2.5 Profile

When available, prefer:

- storage root: `TEMPLATESTAY_MEMORY_ROOT` (or `MEMORY_V2_ROOT` fallback)
- schema version: `2.5`
- service name: `templestay`

Both Claude and Codex read/write through the same root, so capsules survive
platform handoff.

## Cleanup Discipline

Before proposing cleanup, run `memory_tier_audit` or
`memory_cleanup_candidates` when available (read-only). Do not perform
destructive cleanup automatically — surface candidates and let the user
authorize deletion.
