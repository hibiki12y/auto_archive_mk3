# templestay Orchestration Rule

The parent thread runs as orchestrator. For non-trivial work, delegate
read-heavy, write-heavy, verification, challenge, and research tasks to the
matching leaf subagent rather than acting in the parent context.

Tiered code authoring:

- Tier 3 → `templestay-coder` (single file, ≤30 LOC, doc/comment/log/lint/format, no new symbols).
- Tier 2 → `templestay-codex-coder` via `codex-gateway` (multi-file or >80 LOC, new symbols/tests; default for non-trivial code).
- Tier 1 → `templestay-codex-coder` in Architect/Editor with bounded executable-signal refinement, hard cap N=2.

The parent must not call `Edit`, `MultiEdit`, or `Write` outside a verbatim
single-line nudge the user named in the same turn.

See `CLAUDE.md` § Default Operating Posture, plus the `templestay-orchestration`
and `templestay-codex-delegation` skills.
