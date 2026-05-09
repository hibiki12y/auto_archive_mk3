---
title: UX comparison vs Claude Code / Codex CLI / Copilot CLI
status: current
last_verified: 2026-05-09
scope: Comparative UX analysis — pattern catalogue from peer agent CLIs and the gap-list against `auto_archive_mk3`'s Discord + CLI surfaces. Drives the next-cycle UX work-units (UX-11 onward).
authors:
  - opus-orchestrator (cycle 4)
---

## 1. Why this document exists

UX cycles 1–3 closed local pain points (silence during long runs, bare
errors, dense progress, /help discoverability, access-denied dead ends,
empty-state guidance). The remaining gaps are ones an internal review
cannot easily surface — we needed a comparative lens against established
peer CLIs to identify *categories* of UX affordances we have not adopted
at all. This document records the comparison and the resulting backlog.

## 2. Comparison matrix

| Capability | Claude Code | Codex CLI | Copilot CLI (`gh copilot`) | auto_archive_mk3 (today) |
|---|---|---|---|---|
| Per-tool-use visibility | Yes — every tool call is rendered with name + args summary as it lands | Yes — `approval-on-request` shows the upcoming command before it runs | Not applicable (single-shot suggest/explain) | **Yes (partial, post-cycle 4)** — `renderResearchPlanHeartbeat` posts a per-tool-class breakdown (`mcp_tool_call=N, command_execution=M, …`) on a throttled gate (5 tool uses OR 60 s elapsed), plus the per-sub-task completion line with the final aggregate |
| Plan mode (explicit gate) | Yes — `EnterPlanMode` + `ExitPlanMode` requires user approval before execution | No (uses sandbox modes + approval policies) | No | **No** equivalent — Plana advisor vetoes tool loops but cannot interpose a plan-vs-execute gate |
| Resume mid-task | Yes — session resume preserves context | Yes — thread resume by id | No | **Partial** — `/rerun` restarts from terminal evidence; sub-task-N resume is not supported |
| Structured user prompts | Yes — `AskUserQuestion` (1–4 questions, 2–4 options each, optional preview) | No | No | **No** — every Discord input is free text; Discord button + select interactions are not used |
| Background notifications | Yes — `PushNotification` (terminal + remote-control phone) | No | No | Partial — Discord session-log thread router (per-task threads) but no operator-side push |
| Slash commands w/ namespace | Yes — `plugin:skill` form | Not applicable | Not applicable | Yes — `/<name>` (no namespace, single registry) |
| JSON / machine-readable output | Yes — structured tool results carry typed shapes | Yes — `codex exec --json` | No | **Partial** — CLI runner emits one-line summary JSON per sub-task, no `--json` mode |
| NL → command suggestion | Partial — agent infers command intent | No (single conversation) | Yes — `gh copilot suggest "<intent>"` returns shell/git/gh command | **No** — Discord parses `@bot status for <id>` heuristically; no command-recommendation surface |
| Multi-task team coordination | Yes — `TeamCreate` + `SendMessage` + `TaskList` shared between teammates | No | No | Partial — subagent operator surface (list/info/kill) but no peer-to-peer messaging |
| Live tail (long-running task) | Yes — `TaskOutput` streams stdout from background tasks | Yes — `codex exec` streams the prompt as it runs | No | **Partial** — `/feed` is global ledger tail; per-task live tail does not exist |
| Per-tool / pre-execution gate | Partial — settings.json hooks; pre-tool-use hook can deny | Yes — `approval-on-request` policy | No | **Partial** — Plana advisor can veto, but `/research-plan` child approvals are auto-rejected |
| Onboarding / quickstart | Partial — `/help` slash + IDE first-launch flow | Yes — `codex --help` is canonical, plus interactive `codex` REPL | Yes — `gh copilot suggest` with interactive refinement | **No** dedicated onboarding command beyond `/help` |
| File edit awareness | Yes — `Edit`/`Write`/`Read` tools surface file path + diff | Yes — workspace-write sandbox shows planned writes | No | **Not applicable in scope** — auto_archive_mk3 is an orchestration surface, not an editor; out-of-scope for this gap list |
| Cross-session memory | Yes — Memory MCP (`memory_*` tools) surfaces session/project/global tiers | Partial — `~/.codex/sessions/` history | No | **No** equivalent surfaced to operators (insight ledger exists but is admin-only and not addressed by NL queries) |

## 3. Gap categories

The matrix collapses into five gap categories worth a UX work-unit each:

### 3.1 Activity stream gap (CLOSED in cycle 4 — preserved here for history)

Claude Code and Codex CLI both make *what is happening right now*
visible: tool calls land in the conversation as they happen; approval
policies show the next command before it runs.

Pre-cycle 4: auto_archive_mk3's `/research-plan` dispatch went silent
for the full duration of each sub-task (3–10 minutes typical, 15+
minutes possible) and only emitted a single completion line at the end.

Cycle 4 / UX-11 closed this gap. `renderResearchPlanHeartbeat`
emits a throttled per-tool-class breakdown (one nudge per ≥5 tool
uses OR ≥60 s elapsed since the last post / sub-task start), plus
the per-sub-task completion line. Operators distinguish "still
working" from "stuck" via the heartbeat cadence. See
`tests/discord-research-plan-heartbeat.spec.ts` for the throttle
invariants. Cycle 5 / UX-18 added a fake-timer test for the 60 s
time-gate so refactors of either gate fail closed in CI.

### 3.2 Pre-execution gate gap

Codex's `approval-on-request` lets a user OK each command before it
runs. auto_archive_mk3 has Plana advisor vetoes (post-hoc) but no
opt-in pre-execution gate for `/research-plan` or ad-hoc `@mention`
tasks. Operators cannot say "ask me before any `mcp_tool_call`".

This is a behavioural gap, not just UX; out of scope for the cycle 4
PR but recorded here so it does not get lost.

### 3.3 Structured input gap

Discord supports button rows and select menus (`MessageActionRow`).
auto_archive_mk3 uses neither: every operator interaction is free text,
including `/auth add user_id:<id>` (where the bot could offer a list of
recent unknown users to choose from) and `/subagents kill <id>` (where
the bot could enumerate currently-killable ids).

A small Discord-side investment here would move several commands from
"type the id verbatim" to "tap the row".

### 3.4 NL → command suggestion gap

Copilot CLI's `gh copilot suggest "show me failing GitHub Actions in
the last week"` returns a runnable command. auto_archive_mk3 parses
some natural-language patterns (`status for <id>`) but has no
suggestion surface for unknown inputs. A `@bot suggest <intent>` route
that maps NL → slash-command-with-options would close the discovery
gap that `/help` only partially addresses.

### 3.5 Live tail / single-task progress gap

`/feed` shows the global control-plane tail. There is no
single-task live tail — an operator who wants to watch a specific
`/research-plan` dispatch progress in real time has to wait for the
per-sub-task completion follow-ups. Codex's `codex exec` and Claude
Code's `TaskOutput` both stream the live event log of a single task;
auto_archive_mk3 does not.

## 4. Backlog (cycles 4–6)

Mapped to the gap categories above. Cycle 5 closed five error-path
items (UX-17..UX-22) raised by a plan-mode DT audit (3 axis Explore)
that the original cycle-4 spec missed. Original UX-12..UX-16 backlog
deferred to cycle 6+.

| ID | Cycle | Gap | Description | Status |
|----|-------|-----|-------------|--------|
| UX-11 | 4 | 3.1 activity stream | Tool-use heartbeat in `/research-plan` Discord progress (throttled per-tool-class summary) | landed |
| UX-17 | 5 | spec correction | This row's claim about per-tool-use visibility was outdated post-UX-11; cycle 5 corrected it | landed |
| UX-18 | 5 | activity stream / test pin | Fake-timer test for the heartbeat 60 s time-gate (only the count-gate was previously covered) | landed |
| UX-19 | 5 | error-path UX | `renderApprovalResolutionFailed` status-aware hint (`unknown`/`duplicate` → `/feed kind:approval` recovery) | landed |
| UX-20 | 5 | error-path UX | Replace `throw new Error('task_id is required …')` in `/status`, `/cancel`, `/rerun`, `/archive`, `/unarchive` with a Discord-friendly editReply + hint | landed |
| UX-21 | 5 | error-path UX | `renderTerminalResult` reuses cycle-2's `humanizeResearchPlanCauseKind` + adds `buildTerminalNextStepHint` so non-success terminals carry operator next-step guidance | landed |
| UX-22 | 5 | error-path UX (rename drift) | `renderSubagentOperatorUnavailable` hint imports `AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH` from `doctor.ts` instead of hardcoding the literal string | landed |
| UX-12 | 6 | 3.4 NL → suggest | `/quickstart` slash command — sample plan ids, top-5 commands, link to `/help` | open |
| UX-13 | 6 | matrix gap (JSON output) | CLI runner `--json` flag emits structured progress + summary as JSONL | open |
| UX-14 | 6 | 3.3 structured input | Discord button row for `/subagents` (kill, log) on the `list` reply | open |
| UX-15 | 6 | 3.5 single-task tail | `/follow task_id:<id>` streams sub-task lifecycle for one dispatch | open |
| UX-16 | TBD | 3.2 pre-execution gate | Opt-in `approval-on-request` for `/research-plan` (env-flag) — recorded, deferred | deferred |

## 5. References

- Claude Code agent contract: `~/.claude/CLAUDE.md` (project memory pattern)
- Codex CLI sandbox/approval modes: documented in `~/.codex/auth.json` config patterns
- Copilot CLI `gh copilot suggest|explain` (gh extension)
- Cycle 1–3 UX work: commits `4b563c6` → `f3cb63d`
- Cycle 4 UX work: commit `be11acc` (heartbeat + this spec)
- Cycle 5 UX work (DT-audit-augmented error-path closure): branch `ux/cycle-5-2026-05-09`
- Open backlog tracker: this file (cycles 6+ column)
