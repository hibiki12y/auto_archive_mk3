---
status: implemented
level: L3
type: native-platform-memory
created: 2026-04-28
author: codex-orchestrator
relates_to: "install.sh, scripts/install_templestay_memory.sh, mcp-servers/memory-v2/server.py, docs/mcp.md"
---

# Spec: templestay root memory-v2.5 platform layer

## Goal

Keep the root `templestay` repository self-contained while preparing memory-v2
for Codex/Claude multi-platform use and a future memory-v3 backend.
`resource/templerun` is reference material only; root installers and MCP wiring
must use root `mcp-servers/` paths.

## Requirements

1. Root `install.sh` installs only templestay Codex, templestay Claude, and the
   shared memory profile by default.
2. Legacy templerun/Copilot/templerun-codex setup is not called by default.
   Legacy package cleanup and settings cleanup are explicit, dry-run-capable
   paths.
3. memory-v2 supports platform-neutral roots and sessions:
   `TEMPLATESTAY_MEMORY_ROOT`, `MEMORY_V2_ROOT`, `TEMPLATESTAY_SESSION_ID`,
   `CODEX_SESSION_ID`, `CLAUDE_SESSION_ID`, and `COPILOT_SESSION_ID`.
4. New memories carry `memory_schema_version: "2.5"` and `platform` metadata.
5. Cleanup is advisory/read-oriented by default. Automatic destructive memory
   cleanup is out of scope.

## Implemented surface

- Root installers: `install.sh`, `scripts/install_templestay_codex_cli.sh`,
  `scripts/install_templestay_claude_cli.sh`, and
  `scripts/install_templestay_memory.sh`.
- Legacy cleanup:
  - `scripts/remove_templerun_legacy.sh` for legacy package/wiring paths.
  - `scripts/remove_legacy_settings.sh` / `.py` for settings-only cleanup.
- Memory tools: `memory_platform_context`, `memory_tier_audit`,
  `memory_cleanup_candidates`, and `memory_compact_access_log`.

## Acceptance checks

- Root install dry-runs show templestay-only Codex/Claude/memory steps.
- Root native MCP templates and installers do not reference legacy
  `copilot/mcp-servers/` paths.
- Legacy settings cleanup preserves native `templestay` entries and requires
  `--apply` before writing.
- memory-v2 root/session tests cover platform-neutral env precedence and
  read-oriented audit/cleanup behavior.
