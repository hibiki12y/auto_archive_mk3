# templestay

Third-generation native template for Claude Code and Codex CLI. Inherited the
durable techniques of [`templerun`](https://github.com/hibiki12y/templerun)
without migrating Copilot runtime protocols. The original templerun reference
submodule has been removed from the tree; what remained valuable was ported,
the rest was intentionally dropped (council/vote/AWAIT/.agent.md/etc.).

```text
Input → Atomize → Plan → Execute → Verify → Critique → Report
Verify → Execute
Critique → Atomize → Plan
```

## Lineage

| Generation | Surface | Status |
|---|---|---|
| 1 | Copilot CLI / VS Code Copilot (templerun) | retired |
| 2 | Codex CLI (templerun-codex package) | retired |
| **3** | **templestay** — Claude Code + Codex CLI native | **canonical** |

This repository is the canonical install target for `templestay`. The
`templerun` lineage above is historical attribution only.

## Layout

```
.
├── .codex-plugin/
│   └── plugin.json            # repo-level Codex plugin wrapper
├── claude/                     # Claude Code surface
│   ├── .claude-plugin/
│   │   └── marketplace.json    # local plugin marketplace
│   └── templestay/             # the installable plugin
│       ├── .claude-plugin/plugin.json
│       ├── CLAUDE.md           # entry instructions
│       ├── .claude/rules/      # topic-scoped rules
│       ├── .mcp.json           # project-scope MCP template
│       ├── skills/             # native skills
│       ├── agents/             # leaf subagents and audit roles
│       ├── settings/presets/   # balanced / deep / minimal JSON
│       └── hooks/              # optional hardening
├── codex/                      # Codex CLI surface
│   └── templestay/
│       ├── .codex-plugin/plugin.json
│       ├── AGENTS.md
│       ├── skills/             # Codex-native skills, consultation, audit
│       ├── agents/             # Codex leaves, consultants, audit roles
│       ├── config/presets/     # balanced / deep / minimal TOML
│       └── hooks/
├── shared/                     # source of truth for shared instructions/skills
│   └── templestay/
│       ├── instructions/       # common kernel + CLAUDE/AGENTS templates
│       └── skills/             # shared SKILL.md templates
├── mcp-servers/                # bundled MCP server backends
│   ├── memory-v2/              # cross-platform durable memory (schema 2.5)
│   ├── context-manager/
│   ├── document-parser/
│   ├── codex-gateway/          # Codex CLI leaf bridge (detached worktree)
│   ├── claude-gateway/         # Claude Code read-only consultation bridge
│   └── gemini-gateway/         # Gemini read-only consultation bridge
├── docs/
├── specs/
└── tests/
```

`docs/` holds the kernel, MCP, shared-techniques, and Codex-as-subagent
documents; `specs/` holds the index, templates, and active specs; `tests/`
holds the regression suite.

`shared/templestay/` is the shared-resource source of truth for content that
Claude and Codex can safely share. `CLAUDE.md`, `AGENTS.md`, and common skills
are materialized from that directory by `scripts/materialize_shared_resources.py`.
The root installer runs that materializer before installing platform surfaces;
`--dry-run` runs the same path in non-mutating `--check` mode.

## Install

### Claude Code (user scope, plugin marketplace)

```bash
claude plugin marketplace add /path/to/templestay/claude
claude plugin install templestay@templestay --scope user
```

### Codex CLI

Use the root-native installer; it installs from `codex/templestay/` and does
not call the legacy submodule installers:

```bash
bash install.sh --preset balanced --memory-profile shared
bash scripts/install_templestay_codex_cli.sh --preset balanced --dry-run
```

To verify the generated platform surfaces are synchronized with the shared
source without installing anything:

```bash
python3 scripts/materialize_shared_resources.py --check
```

The repository root is also wrapped as a Codex plugin with
`.codex-plugin/plugin.json`. That wrapper points at the canonical Codex skill
surface under `codex/templestay/skills/` while keeping the smaller
`codex/templestay/` package available for the installer path above. The wrapper
is static plugin metadata; MCP/profile/config wiring is still handled by
`install.sh` and `scripts/install_templestay_codex_cli.sh`.

### Legacy cleanup

Preview settings-only cleanup before writing anything:

```bash
bash scripts/remove_legacy_settings.sh --dry-run
bash scripts/remove_legacy_settings.sh --apply   # writes backups first
```

Preview old package/wiring removal separately:

```bash
bash scripts/remove_templerun_legacy.sh --dry-run
```

## Boundaries

- Claude and Codex are independent native surfaces. Lifecycle phases are
  framework-built-in; the surfaces add discipline (subagent contract,
  research workflow, memory schema), not phase re-statement.
- Shared instruction and skill text lives under `shared/templestay/`; generated
  platform files keep native wrappers and must not be hand-edited when the
  shared source can express the change.
- Codex CLI may be invoked as a leaf Claude subagent through
  `mcp-servers/codex-gateway/`. Detached worktree only; no
  council/vote/consensus; bounded refinement loop (N=2) on executable signals
  only. See `claude/templestay/skills/templestay-codex-delegation/` and
  `docs/codex-as-subagent.md`.
- Claude Code may be consulted from Codex through
  `mcp-servers/claude-gateway/`. This reverse path is read-only by design:
  `claude_prompt` returns evidence for Claude-native surface review,
  architecture synthesis, instruction critique, or challenge lenses. There is
  no `claude_apply`; Codex remains the repository writer. Codex Verify uses deterministic sensors and the same GPT-family runtime;
  Claude Opus 4.7 through this gateway is the regular read-only hetero Critique
  lane after Verify on non-trivial changes.
  The gateway prompt must be secret-screened and minimized to the patch
  summary, relevant diff excerpts, and sensor results. If the active runtime
  treats `claude-gateway` as an external data-transfer boundary, live
  Critique is allowed without per-call explicit external-transfer
  approval when `claude_preflight().content_transfer_policy` reports
  `content_transfer_allowed=true`. That state means the route is
  policy-preauthorized by runtime configuration (`trusted_internal` destination
  plus the repository-content allow flag). If destination trust or policy
  preauthorization is not established, use a no-repository synthetic
  connectivity check for live-route proof and report content-bearing
  Critique as degraded. The gateway reports this policy through
  `claude_preflight().content_transfer_policy` and exposes `claude_route_probe`
  for the synthetic route check.
- Gemini may be consulted as a read-only leaf via `mcp-servers/gemini-gateway/` under capability triggers (long-context, abstract reasoning, multimodal, tool coordination); evidence-only return; `deep` preset only; never inside the Tier 1 refinement loop. See `claude/templestay/skills/templestay-deep-think/` and `specs/codex-gemini-capability-routed-consultation.md`.
- The Claude side defaults to orchestrator-by-default — the parent thread
  atomizes, plans, dispatches leaf subagents, and reports. Code authoring is
  delegated by tier (`templestay-coder` for Tier 3, `templestay-codex-coder`
  for Tier 2/1 via `codex-gateway`). See `claude/templestay/CLAUDE.md`
  § Default Operating Posture and the `templestay-orchestration` /
  `templestay-codex-delegation` skills.
- No Copilot approval gates, `AWAIT`, `.agent.md` dispatch, or mediator chains.
- No vote/consensus-based council semantics. The DT Audit Ultra-Team v3.1
  protocol (`specs/dt-audit-ultra-team-v3-1.md`) is a deliberate, gated
  exception: it forbids voting, requires external evidence (executable tests,
  citation fetch via deterministic tools, artifact verification) for any
  verified finding, fails closed when verification cannot fire, is
  eligibility-gated and **default-disabled by intent** — reserved for explicit
  manual invocation on ultra-high-precision work (irreversible architecture
  decisions, paper reproducibility audits). Real-test validation completed
  2026-04-30 (CRLN self-test + DPO research benchmark) confirms protocol
  behavior; harness §25 measurement continues only for ongoing recalibration,
  not as a gate to default routing. Lighter multi-vendor work continues through
  CRLN (`specs/codex-gemini-capability-routed-consultation.md`) and
  `templestay-deep-think` lenses, both of which remain explicitly
  vote-free / consensus-free.
- Hooks are optional hardening only. Correctness must not depend on them.
- Spec/report standards live under `specs/_templates/` and `specs/_index.md`;
  they retain templerun traceability ideas without legacy approval wrappers.
- Auto-memory is disabled by templestay presets. The `memory` MCP server
  (`mcp__memory__*`) with schema `memory-v2.5` is the single source of truth
  for durable cross-platform progress.
- Codex `balanced` / `deep` presets use `gpt-5.5` and materialize their MCP
  profile in `~/.codex/config.toml`: shared memory plus context/document
  servers and `claude-gateway` with
  `CLAUDE_DEFAULT_MODEL=claude-opus-4-7`, `CLAUDE_DEFAULT_EFFORT=max`,
  `CLAUDE_GATEWAY_DESTINATION_TRUST=trusted_internal`, and
  `CLAUDE_GATEWAY_ALLOW_REPO_CONTENT=true`;
  `deep` also adds `gemini-gateway`. GPT-5.5 reasoning effort defaults are
  deliberately conservative for routine work (`minimal=low`,
  `balanced=medium`) but preserve `deep=xhigh` for DT Audit and high-utility
  orchestration; otherwise escalate above the routine defaults only after
  concrete verification or ambiguity signals.
- Root-native runtime paths must use `mcp-servers/`; legacy
  `copilot/mcp-servers/` paths are cleanup inputs only.

## License

MIT.
