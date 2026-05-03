# Dual-CLI Prior Art — Codex CLI + Claude Code (2026-04-29)

Reconnaissance of public projects that wire both OpenAI's `codex` CLI and
Anthropic's `claude` CLI (Claude Code) on the same workflow. Companion to
`docs/codex-as-subagent.md` (templestay's own integration spec) and
`docs/multi-vendor-coordination-research.md` (the broader multi-LLM
evidence sweep). Read those for rationale and evidence; this file is a
catalogue of what other people have shipped.

This is *prior art reconnaissance*, not endorsement. Inclusion does not
imply alignment with templestay's boundaries (no council / no LLM-vs-LLM
critique / executable signals only) — many of these cases violate one or
more of those.

## Confirmation

The user's recollection that "multiple cases exist" is correct. As of
2026-04, at least **a dozen** public repositories ship a working
Claude+Codex dual-CLI integration, plus several blog posts, an official
OpenAI plugin, and active Reddit / HN discussion. The space is not
theoretical.

## Five observed patterns

### Pattern A — MCP-Gateway Leaf

Codex is exposed to Claude Code as an MCP server. Claude orchestrates;
Codex executes via tool calls. No bash bridging.

| Repo | Notes |
|---|---|
| `openai/codex-plugin-cc` | Official OpenAI plugin (2026-03-30, 16.6k stars). Ships `/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, `/codex:status`, `/codex:result`, `/codex:cancel` slash commands. |
| `tuannvm/codex-mcp-server` | Most mature 3rd-party (443 stars, 31 releases). Standard `Claude → MCP → codex CLI → OpenAI API` chain. |
| `kky42/codex-as-mcp` | 159 stars. Two MCP tools: `spawn_agent()` / `spawn_agents_parallel()`. Internally `codex exec --cd <cwd> --dangerously-bypass-approvals-and-sandbox "<prompt>"`. |
| `mkXultra/ai-cli-mcp` | Multi-engine (Codex + Claude + Gemini + Forge) behind one MCP server with parallel-background `wait` / `peek` / `kill_process`. |
| Sangho Oh tutorial (Medium 2025-12-21) | Earliest documented walkthrough of `codex mcp-server` registered as a Claude MCP. |

**templestay's `mcp-servers/codex-gateway/` is a hardened variant of this
pattern**: detached-worktree apply-back, allowed-paths validation, per-repo
lock, stable error taxonomy. None of the public Pattern A projects above
implement worktree isolation or path validation; they trust Codex with
direct repo access (with `--dangerously-bypass-approvals-and-sandbox` in
several cases).

### Pattern B — Tmux / Split-Pane Parallel Terminals

Both CLIs run in separate terminal panes with inter-agent messaging via
filesystem or commands. No single orchestrator process; human or
scheduling script coordinates.

| Repo | Notes |
|---|---|
| `bfly123/claude_code_bridge` | 2.4k stars. Terminal split-pane runtime for Claude / Codex / Gemini / OpenCode. `/ask agent_name "task"` or `/ask all "message"`. Each AI in an isolated tmux pane with shared project context. |
| `kingbootoshi/codex-orchestrator` | 276 stars. Spawns Codex agents as detached tmux sessions. Claude plans; `codex-agent start "<task>"` runs each delegated task in a named tmux window. |

### Pattern C — Bash-Bridge Slash-Command Orchestration

Claude Code calls Codex via a bash wrapper script; the collaboration
protocol is encoded in markdown slash commands. Lightest infrastructure.

| Repo | Notes |
|---|---|
| `AlessioZazzarini/claude-codex-collab` | Bash bridge `.claude/bin/codex-bridge.sh` plus markdown commands. Claude debates architecture, delegates spec to Codex; Codex implements asynchronously while Claude stays interactive. |
| AgentBridge (`raysonmeng`, openai/codex Discussion #15374) | Bidirectional bridge connecting Claude Code's MCP notifications to Codex's JSON-RPC App Server, with mid-execution injection in both directions. The bridge was co-written by both CLIs *using itself* as it was built. |

### Pattern D — Unified CLI Dispatch Layer (JSON Contract)

A dedicated binary abstracts over Claude, Codex, and Gemini CLIs. Callers
specify `{engine, model, prompt}` via a standardized contract; the
dispatch layer shells out to the correct binary.

| Repo | Notes |
|---|---|
| `buildoak/agent-mux` | 32 stars, Go. JSON profile files declare engine + model + system prompt. `--coordinator` lets a Codex session spawn `claude-opus-4.6` (or vice versa) as sub-coordinator. No server. |
| `mkXultra/ai-cli-mcp` | Listed in Pattern A but is also Pattern D structurally — single `run` tool dispatches based on requested model. |
| `catlog22/Claude-Code-Workflow` | 1.9k stars, 22+ specialized agents, JSON-driven cadence. Integrates Gemini / Qwen / Codex / Claude. The `.codex/skills/` workflow needs Codex's `enable_fanout` and `multi_agent`. |

### Pattern E — Shared Config / Peer Use

Both CLIs configured on the same project via a shared `AGENTS.md` (often
symlinked to `CLAUDE.md`). No automated delegation; developer chooses tool
per task. Config-level interop, no runtime interop.

| Repo | Notes |
|---|---|
| `fcakyon/claude-codex-settings` | 650 stars, v2.3.0. Daily-driver dotfiles. `AGENTS.md` and `GEMINI.md` symlink to `CLAUDE.md`. |
| `shakacode/claude-code-commands-skills-agents` (`docs/claude-code-with-codex.md`) | Documents four manual workflow patterns: sequential, cross-validation, parallel worktrees, spec-first. No automated dispatch. |

## Where API-layer multi-vendor sits (not Pattern A–E)

A separate observation: **mainstream wrappers do not shell out to the
CLIs** — they hit vendor APIs directly. Aider (BYOM via OpenAI-compatible
endpoint), Cline (Anthropic / OpenAI / Bedrock / Azure), RooCode (Cline
fork; GPT-5.5 via the OpenAI Codex *API provider*, not the binary), and
Cursor all mix at the API layer. Zed is the IDE-layer exception: it runs
Claude Code and Codex CLI as external processes via the Agent Client
Protocol, each reading its own native config — but dispatched per-thread,
not in parallel.

This is a meaningful distinction for templestay: the dual-CLI integrations
above choose to shell out to the binaries specifically to inherit Codex's
sandbox semantics, Claude's skills/subagent infrastructure, and the
respective auth flows — exactly the rationale templestay's
`docs/codex-as-subagent.md` documents.

## Dominant role assignment

Across blog posts, surveys, and README claims:

> "Claude Code for architecture, Codex for keystrokes."

Recurring across multiple independent sources (UX Collective 2025-10-30,
DEV Community Reddit-survey article 2026, HN thread on
`AlessioZazzarini/claude-codex-collab`). Concrete sub-patterns:

- **Architecture / orchestration ↔ implementation / refactoring** — the
  most common split. Matches the Aider Architect/Editor result and Cline
  Plan/Act telemetry. This is the shape templestay's Tier 1/2 already
  uses.
- **Generate ↔ adversarial-review** — one tool generates, the other
  reviews before commit. Encoded in `openai/codex-plugin-cc`'s
  `/codex:adversarial-review` flow and in dotfiles where global
  `CLAUDE.md` instructs Claude to "send diffs to Codex for review."
- **Parallel independent worktrees** — both run on different branches
  with shared instructions (`AGENTS.md` ⇄ `CLAUDE.md` symlink).

## Anti-cases / counter-arguments

- **XDA Developers, "I switched from Claude Code to Codex for a week"** —
  switched *away* from Claude Code rather than combining both; usage limits
  cited as the driver, not architectural objection.
- **Leanware comparison post** — "Claude Code hits usage limits too
  quickly to be a daily driver" framing favors single-tool use for cost
  predictability.
- **DEV Reddit survey (500+ devs)** — most respondents pick one as
  primary (≈80/20 split). True simultaneous dual-CLI is a power-user
  pattern, not the median workflow.

No surveyed source argues against dual-CLI on *architectural* grounds. The
objections are practical (cost, auth overhead, context fragmentation).

## Where templestay sits in this taxonomy

- **Architecturally**: Pattern A (MCP-Gateway Leaf), with worktree
  isolation and allowed-paths validation that the public Pattern A
  projects do not implement.
- **Role split**: matches the dominant industry pattern (Claude
  orchestrator / Codex implementer), with the additional Tier 1
  Architect/Editor refinement loop that mirrors Aider.
- **What templestay rejects that several public projects accept**:
  bidirectional reverse delegation (AgentBridge), unbounded parallel
  fan-out (`Claude-Code-Workflow`), Codex-as-judge of Claude output
  (LLM-vs-LLM critique seen in some `/codex:review` usage). These are
  forbidden by `README.md` boundaries.

## Citations

GitHub repos:

- `openai/codex-plugin-cc` — `https://github.com/openai/codex-plugin-cc`
- `tuannvm/codex-mcp-server` — `https://github.com/tuannvm/codex-mcp-server`
- `kky42/codex-as-mcp` — `https://github.com/kky42/codex-as-mcp`
- `mkXultra/ai-cli-mcp` (slug `claude-code-mcp`) — `https://github.com/mkXultra/claude-code-mcp/`
- `catlog22/Claude-Code-Workflow` — `https://github.com/catlog22/Claude-Code-Workflow`
- `buildoak/agent-mux` — `https://github.com/buildoak/agent-mux`
- `fcakyon/claude-codex-settings` — `https://github.com/fcakyon/claude-codex-settings`
- `kingbootoshi/codex-orchestrator` — `https://github.com/kingbootoshi/codex-orchestrator`
- `bfly123/claude_code_bridge` — `https://github.com/bfly123/claude_code_bridge`
- `AlessioZazzarini/claude-codex-collab` — `https://github.com/AlessioZazzarini/claude-codex-collab`
- `openai/codex` Discussion #15374 (AgentBridge) — `https://github.com/openai/codex/discussions/15374`

Articles / threads:

- Sangho Oh, "Claude + Codex CLI: Agentic Coding," Medium 2025-12-21 — `https://medium.com/@sangho.oh/claude-codex-cli-agentic-coding-a98c83ba043e`
- "Building AI-driven workflows powered by Claude Code and other tools," UX Collective 2025-10-30 — `https://uxdesign.cc/designing-with-claude-code-and-codex-cli-building-ai-driven-workflows-powered-by-code-connect-ui-f10c136ec11f`
- buildoak, "Codex Inside Claude Code. Subagents Inside Codex." DEV — `https://dev.to/buildoak/codex-inside-claude-code-subagents-inside-codex-1oe5`
- "Introducing Codex Plugin for Claude Code," OpenAI Community 2026-03-30 — `https://community.openai.com/t/introducing-codex-plugin-for-claude-code/1378186`
- Mark Chen, "When Rivals Collaborate," Medium March 2026 — `https://medium.com/@markchen69/when-rivals-collaborate-installing-openais-codex-plugin-in-claude-code-5d3e503ce493`
- shakacode `docs/claude-code-with-codex.md` — `https://github.com/shakacode/claude-code-commands-skills-agents/blob/main/docs/claude-code-with-codex.md`
- HN: "Claude × Codex Collab" — `https://news.ycombinator.com/item?id=47466997`
- "Claude Code vs Codex 2026 — 500+ Reddit Developers" DEV — `https://dev.to/_46ea277e677b888e0cd13/claude-code-vs-codex-2026-what-500-reddit-developers-really-think-31pb`
- Nick Oak, "agent-mux," personal blog — `https://www.nickoak.com/posts/agent-mux/`
- Zed External Agents docs — `https://zed.dev/docs/ai/external-agents`
- XDA: "I switched from Claude Code to Codex" — `https://www.xda-developers.com/ditched-claude-code-for-codex/`

## See also

- `docs/codex-as-subagent.md` — templestay's own dual-CLI rationale and
  spec, with the architectural decisions that put templestay in Pattern A.
- `docs/multi-vendor-coordination-research.md` — the broader 2026 evidence
  sweep on multi-LLM coordination, including why templestay rejects
  council patterns that several Pattern A/B/D projects accept.
