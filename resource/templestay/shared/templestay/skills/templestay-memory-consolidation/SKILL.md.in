---
name: templestay-memory-consolidation
description: "Use at session end or on demand to extract durable decisions, learnings, corrections, and conventions and persist them to the memory MCP with tier-aware preservation."
---

<!-- templestay-generated-from: shared/templestay/skills/templestay-memory-consolidation/SKILL.md.in -->

# templestay Memory Consolidation

This skill extracts durable learnings from a templestay session and persists
them to the memory MCP (schema `memory-v2.5`, service `templestay`) with
tier-aware classification and promotion gating. It is the consolidation and
promotion counterpart to `templestay-memory`, which handles task anchors and
checkpoint capsules during active work.

## Four-phase path

1. **Collect candidates** — read the session report, memory capsules, user
   feedback, and explicit decisions. Do not invent durable lessons from routine
   command output.
2. **Classify** — bucket each candidate as `decision`, `bug_root_cause`,
   `convention`, `user_feedback`, or `external_reference`, with confidence
   `high`, `medium`, or `low`.
3. **Persist with tiering** — session facts stay session-scoped; reusable
   project conventions may be promoted to project memory; global/user memory is
   approval-gated.
4. **Prune candidates** — surface stale or duplicate memories for user-approved
   cleanup only; do not delete automatically.

## When to invoke

- **Session-end** — manual user request ("consolidate", "save learnings",
  "consolidate memory") or a session-end hook if the user has one configured.
  Runs all four phases including Phase 4 pruning.
- **On-demand** — same triggers as session-end; bypasses any due-ness check.
- **Post-completion candidate scan** — parent orchestrator invokes this skill
  read-only after Report to identify candidates only. Do not persist from the
  micro path without explicit user approval.

## Extraction gate

Candidate content must be durable, reusable, and secret-free. Keep only medium
or high confidence items.

Skip: one-off task details, anything derivable from the codebase or git history,
debugging steps, build/test commands, file paths, and content already in tracked
instruction files (`CLAUDE.md`, `.claude/rules/`, `AGENTS.md`, platform presets)
or generated from `shared/templestay/`.

## Persistence gate

- Session memory: active-loop capsules, completion capsules, handoff summaries.
- Project memory: durable repo conventions, known pitfalls, user-approved
  project decisions.
- User/global memory: only explicit cross-project preferences or corrections;
  require user approval before writing.

If the memory MCP is unavailable, return `memory-record-degraded` and present the
candidate list in the visible report instead of falling back to local-only state.

## Memoryify failure loop

If a candidate fails a safety or confidence gate, do not force it into memory.
Return the failed gate, the evidence, and the narrower candidate (if any). If no
safe durable candidate remains, exit quietly.
