# templestay shared resources

This directory is the tracked source of truth for content that Claude Code and
Codex CLI can safely share without becoming compatibility shims for one another.
Platform packages under `claude/templestay/` and `codex/templestay/` are
materialized from these files by `scripts/materialize_shared_resources.py`.

## Layout

- `instructions/` — shared instruction kernel and platform instruction
  templates for `CLAUDE.md` and `AGENTS.md`.
- `skills/` — shared skill templates that render to both platform packages.

The generated files keep platform-specific wrappers and tool names where needed,
but common lifecycle, memory, verification, research, deep-think, and
consolidation policy lives here first.

Some shared directories contain platform-specific templates when the policy is
deliberately not identical. For example, Claude uses
`skills/templestay-verification/SKILL.md.in`, while Codex uses
`skills/templestay-verification/CODEX.SKILL.md.in` so Codex can add
the regular Claude Opus 4.7 hetero Critique contract without changing Claude's
own verification workflow.

## Update flow

1. Edit the shared source file in this directory.
2. Run `python3 scripts/materialize_shared_resources.py` from the repository
   root to refresh generated Claude/Codex surfaces.
3. Run `python3 scripts/materialize_shared_resources.py --check` in CI or before
   release to prove generated surfaces are synchronized.

`install.sh` also runs the materializer before installing platform surfaces. In
`--dry-run` mode it performs a non-mutating sync check.
