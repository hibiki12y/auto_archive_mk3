# templestay for Claude Code

Native Claude Code package for the `templestay` deployment id.

Core lifecycle:

```text
Input → Atomize → Plan → Execute → Verify → Critique → Report
Verify → Execute
Critique → Atomize → Plan
```

Default operating posture: the parent thread runs as orchestrator — it atomizes,
plans, dispatches leaf subagents, and reports. Code authoring is delegated by
tier: Tier 3 → `templestay-coder`; Tier 2/1 → `templestay-codex-coder` via
`codex-gateway`. See `CLAUDE.md` § Default Operating Posture and the
`templestay-orchestration` / `templestay-codex-delegation` skills.

Components:

- `.claude-plugin/plugin.json` — Claude plugin manifest with `name: templestay`.
- `CLAUDE.md` — Claude Code entry instructions, generated from
  `shared/templestay/instructions/CLAUDE.md.in`.
- `.claude/rules/` — topic-scoped rules.
- `skills/` — Claude skills. Common skills are generated from
  `shared/templestay/skills/`.
- `agents/` — Claude subagents.
- `settings/presets/` — `balanced`, `deep`, and `minimal` JSON settings.
- `.mcp.json` — project MCP template.
- `hooks/` — optional hardening assets only.

Preview installation without mutating user configuration:

```bash
bash install.sh --preset balanced --memory-profile shared --claude-scope project --dry-run
bash scripts/install_templestay_claude_cli.sh --scope user --preset balanced --dry-run
bash scripts/install_templestay_memory.sh --profile shared --dry-run
```

Direct edits to generated shared files should happen under `shared/templestay/`
followed by:

```bash
python3 scripts/materialize_shared_resources.py --target claude --check
```

The root `install.sh` path installs only native templestay surfaces plus the
memory-v2.5 profile; it does not install old Copilot, VS Code, or
`templerun-codex` wiring.

Install scopes:

- **user** — runs `claude plugin marketplace add <repo>/claude` and
  `claude plugin install templestay@templestay --scope user` so Claude Code
  loads the plugin through the standard plugin pipeline.
- **project** — writes `CLAUDE.md` at the project root, `.claude/settings.json`
  from the chosen preset, and a project `.mcp.json` with absolute local MCP
  server paths plus `TEMPLATESTAY_MEMORY_ROOT`,
  `MEMORY_V2_SCHEMA_VERSION=2.5`, and `MEMORY_V2_SERVICE_NAME=templestay`.
- **local** — writes `.claude/settings.local.json` only (gitignored).

Manual user install (equivalent to `--scope user`):

```bash
claude plugin marketplace add /path/to/templestay/claude
claude plugin install templestay@templestay --scope user
```
