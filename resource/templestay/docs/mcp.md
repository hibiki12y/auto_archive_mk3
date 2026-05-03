# MCP Capability Guide — templestay

This document is the root `templestay` MCP policy surface. The canonical source
for local server code is the root `mcp-servers/` directory. The original
`resource/templerun/` reference submodule has been removed from the tree.

## Root-native server set

| Capability | Root server path | Primary use | Notes |
|---|---|---|---|
| Persistent memory | `mcp-servers/memory-v2/` | Durable cross-platform task anchors, checkpoints, and reusable decisions | Schema `memory-v2.5`; never store secrets or raw transient logs |
| Context manager | `mcp-servers/context-manager/` | Bulky transient artifacts that should not become durable memory | Use for large tool output or temporary summaries |
| Document parser | `mcp-servers/document-parser/` | Read-only local document extraction | Macros are not executed; parsed content is untrusted data |
| Codex gateway | `mcp-servers/codex-gateway/` | Claude → Codex implementation bridge | `codex_apply` is write-capable only through detached-worktree validation; `codex_prompt` is read-only |
| Claude gateway | `mcp-servers/claude-gateway/` | Codex → Claude read-only consultation and regular hetero Critique | No `claude_apply`; this is the standard Claude Opus 4.7 Critique lane; `claude_preflight` reports content-transfer policy, `claude_route_probe` proves the no-repository route, and `claude_prompt` is used when policy preauthorization and destination trust allow the selected evidence bundle |
| Gemini gateway | `mcp-servers/gemini-gateway/` | Read-only capability-routed consultation | Deep preset / explicit trigger only; no write path |

Root-native scripts and templates must not point at legacy
`copilot/mcp-servers/` paths. If legacy settings contain those paths, treat them
as migration/cleanup inputs rather than current runtime wiring.

## memory-v2.5 profile

The root `templestay` installers use `memory-v2` as a shared Codex/Claude memory
service. Storage resolution is platform-neutral:

1. `TEMPLATESTAY_MEMORY_ROOT`
2. `MEMORY_V2_ROOT`
3. legacy-compatible `~/.copilot`

Project memory defaults to `<root>/memory`, session memory to
`<root>/session-state/<session_id>/memories`, and global memory to
`<root>/global-memory/memories`. `MEMORY_BASE_DIR` remains a compatibility
override for the project-memory base only.

Session detection order is:

1. `TEMPLATESTAY_SESSION_ID`
2. `CODEX_SESSION_ID`
3. `CLAUDE_SESSION_ID`
4. `COPILOT_SESSION_ID`
5. matching `*_SESSION_DIR` basename

New memory files include `memory_schema_version: "2.5"` and `platform` metadata
so a future memory-v3 backend can migrate without guessing provenance.

## Management and cleanup policy

The memory server exposes read-oriented management tools:

- `memory_platform_context` — inspect resolved root/session/platform context.
- `memory_tier_audit` — inspect session/project/global readiness for memory-v3.
- `memory_cleanup_candidates` — list stale, duplicate, transient, or
  metadata-incomplete entries without deleting or rewriting memory files.
- `memory_compact_access_log` — explicit admin compaction for access-log
  sidecars.

Legacy settings cleanup is intentionally separate from package removal:

- `scripts/remove_legacy_settings.sh` is dry-run-first and edits only settings
  when `--apply` is passed.
- `scripts/remove_templerun_legacy.sh` removes old package/wiring paths and is
  used only when the user opts into legacy removal.
- Both paths preserve secrets, memory roots, global memory, session state, and
  native `templestay` settings.

## Runtime boundary

Codex and Claude should use the `memory` MCP server as the shared durable-state
boundary. Built-in runtime memories are local convenience only and must not be
reported as the source of truth for cross-platform task anchors or completion
capsules.

Use `context-manager` for bulky transient artifacts, and promote only durable,
secret-free decisions or handoff summaries into memory.

## Gateway policy

Gateways are not a council mechanism. Their outputs are evidence for the parent
runtime to read, not votes to aggregate.

- `codex-gateway` is the only bundled write-capable gateway. Its write path is
  `codex_apply`, which runs Codex in a detached git worktree at `expected_head`,
  validates the diff against `allowed_paths`, then applies back under a per-repo
  lock.
- `claude-gateway` and `gemini-gateway` are read-only. They expose prompt/model
  tools and structured error envelopes, but no apply/write tools.
- Codex `balanced` / `deep` presets register `context-manager`,
  `document-parser`, and `claude-gateway` in `~/.codex/config.toml`; `deep`
  additionally registers `gemini-gateway`. The Codex `claude-gateway` entry
  defaults `CLAUDE_DEFAULT_MODEL` to `claude-opus-4-7` and
  `CLAUDE_DEFAULT_EFFORT` to `max`. It also sets
  `CLAUDE_GATEWAY_DESTINATION_TRUST=trusted_internal` and
  `CLAUDE_GATEWAY_ALLOW_REPO_CONTENT=true` so `templestay-verifier` can run the
  regular read-only Claude Opus 4.7 max-effort Critique lane after
  same GPT-family Verify without a separate per-call transfer prompt. Prompts
  for that Critique lane should be minimized and secret-screened to the patch
  summary, relevant diff excerpts, and sensor results; if the gateway or
  data-transfer policy is unavailable, report the lane as degraded instead of
  silently dropping it. If the runtime treats the gateway as an external
  data-transfer boundary, send repository-derived
  summaries, diffs, logs, or file details only when
  `claude_preflight().content_transfer_policy.content_transfer_allowed` is true.
  That state is runtime policy preauthorization, so per-call explicit
  external-transfer approval is not required. If policy preauthorization or
  destination trust is not established, run only a no-repository synthetic
  connectivity check for route proof and report content-bearing
  Critique as degraded.
- `claude-gateway` exposes the route-trust decision in
  `claude_preflight().content_transfer_policy`. Repository content is allowed
  only when destination trust is configured as `trusted_internal` and the
  runtime allow flag is enabled. In that policy-preauthorized state, per-call
  explicit external-transfer approval is not required. Otherwise use
  `claude_route_probe` for a live no-repository connectivity check.
