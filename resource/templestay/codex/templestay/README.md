# templestay for Codex

Native Codex CLI package for the `templestay` deployment id.

This package is not a Copilot instruction migration. It is a small Codex-native
surface built from the shared templestay kernel:

```text
Input → Atomize → Plan → Execute → Verify → Critique → Report
Verify → Execute
Critique → Atomize → Plan
```

## Components

- `.codex-plugin/plugin.json` — plugin manifest with `name: templestay`.
- `AGENTS.md` — Codex entry instructions, generated from
  `shared/templestay/instructions/AGENTS.md.in`.
- `skills/` — Codex skills for orchestration, verification, research, memory,
  memory consolidation, read-only Claude consultation, DT Audit, and optional
  deep-thinking lenses. Common skills are generated from
  `shared/templestay/skills/`.
- `agents/` — leaf subagent prompt assets, read-only consultants, and DT Audit
  roles.
- `config/presets/` — `balanced`, `deep`, and `minimal` TOML presets.
- `hooks/` — optional hardening assets. Hooks are not part of the correctness
  boundary.

Install through the dry-run-aware script while this package is under active
iteration:

```bash
bash install.sh --preset balanced --memory-profile shared --dry-run
bash scripts/install_templestay_codex_cli.sh --preset balanced --dry-run
bash scripts/install_templestay_memory.sh --profile shared --dry-run
```

Direct edits to generated shared files should happen under `shared/templestay/`
followed by:

```bash
python3 scripts/materialize_shared_resources.py --target codex --check
```

`install.sh` is the templestay-only root installer. It does not install legacy
Copilot, VS Code, or `templerun-codex` surfaces unless you explicitly run their
legacy component scripts. The memory profile writes environment snippets under
`${TEMPLATESTAY_HOME:-$HOME/.templestay}` and defaults to
`${TEMPLATESTAY_MEMORY_ROOT:-$HOME/.templestay/memory-v2}` with
`MEMORY_V2_SCHEMA_VERSION=2.5`.

## MCP profiles

The Codex installer materializes the preset MCP profile in
`~/.codex/config.toml`:

- `minimal` — shared memory only when `--memory-profile` is not `none`.
- `balanced` — memory plus `context-manager`, `document-parser`, and read-only
  `claude-gateway`.
- `deep` — balanced profile plus read-only `gemini-gateway`.

`claude-gateway` exposes `claude_preflight`, `claude_prompt`, and
`claude_route_probe`; it intentionally has no `claude_apply`. `claude_preflight`
reports the content-transfer policy, and `claude_route_probe` proves the
no-repository Claude route without sending repository content. The Codex
verifier uses this gateway with `model=claude-opus-4-7` and `effort=max` as the
regular read-only Critique lane after same GPT-family Verify on
non-trivial changes. The installer also sets
`CLAUDE_GATEWAY_DESTINATION_TRUST=trusted_internal` and
`CLAUDE_GATEWAY_ALLOW_REPO_CONTENT=true` for the `balanced` and `deep` presets
so the standard Critique evidence bundle is policy-preauthorized. The evidence
bundle must be secret-screened and limited to the patch summary, relevant diff
excerpts, and sensor results. If policy treats the gateway as an external
data-transfer boundary, live Critique can run without per-call explicit
external-transfer approval when
`claude_preflight().content_transfer_policy.content_transfer_allowed` is true.
That policy-preauthorized state requires `trusted_internal` destination trust
and the runtime repository-content allow flag. If policy preauthorization or
destination trust is not established, use a no-repository synthetic connectivity
check for route proof and report content-bearing Critique as degraded.
Codex remains the repository writer and treats Claude/Gemini responses as
evidence, not votes.
