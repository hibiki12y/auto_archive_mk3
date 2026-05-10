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
| Structured user prompts | Yes — `AskUserQuestion` (1–4 questions, 2–4 options each, optional preview) | No | No | **Yes (post-cycle 7, partial)** — `/subagents list` ok-replies attach per-row [Kill] / [Log] interactive button rows (Discord ActionRow + ButtonBuilder). The button-press interaction is parsed by `adaptSubagentButtonInteraction` (custom-id `subagents:<verb>:<subagentId>`) and re-dispatches through the existing `handleSubagents` path. Other commands still take free text |
| Task lifecycle visibility | Yes — Claude Code TaskOutput streams live; Codex CLI exec streams as the task runs | Yes — same | No | **Yes (post-cycle 8–10)** — accept/running/terminal lifecycle now flows through a single in-place `editReply` (one channel message per task, no `Lifecycle: runtime-entering` / `runtime-running` followUp noise — UX-23 cycle 8). Each `/ask`/`/research` task additionally opens a Discord-native thread off its accept message; lifecycle + terminal mirror into the thread for a progressive history viewable without `/status task_id:<id>` re-fetch (UX-24 cycle 9). Cycle 10 extended the same in-place lifecycle + thread-anchor behavior to the natural-language mention adapter. Thread creation is fail-open: missing permission or DM channel falls back to channel-only delivery |
| Background notifications | Yes — `PushNotification` (terminal + remote-control phone) | No | No | Partial — Discord session-log thread router (per-task threads) but no operator-side push |
| Slash commands w/ namespace | Yes — `plugin:skill` form | Not applicable | Not applicable | Yes — `/<name>` (no namespace, single registry) |
| JSON / machine-readable output | Yes — structured tool results carry typed shapes | Yes — `codex exec --json` | No | **Yes (post-cycle 6)** — `scripts/research-plan-runner.mjs --json` emits per-sub-task / synthesis / final-summary records as JSONL on stdout; legacy human summary preserved when omitted |
| NL → command suggestion | Partial — agent infers command intent | No (single conversation) | Yes — `gh copilot suggest "<intent>"` returns shell/git/gh command | **Partial (post-cycle 12)** — mention-driven NL now defaults to chat, can infer work-shaped messages, and offers a bounded task-escalation handshake (`<@bot> 진행` / `yes`) instead of dispatching every mention. There is still no general slash-command recommendation surface equivalent to `gh copilot suggest` |
| Multi-task team coordination | Yes — `TeamCreate` + `SendMessage` + `TaskList` shared between teammates | No | No | Partial — subagent operator surface (list/info/kill) but no peer-to-peer messaging |
| Live tail (long-running task) | Yes — `TaskOutput` streams stdout from background tasks | Yes — `codex exec` streams the prompt as it runs | No | **Yes (post-cycle 7)** — `/follow task_id:<id>` subscribes a per-task live tail of the control-plane ledger. Posts a `📡` event-batch followUp per `loadSince` tick, `✅`/`⛔` on terminal, `⏸️` on idle timeout (default 14 min). Per-user cap (default 3) + per-task de-duplication enforced by `DiscordFollowController`. `/feed` global tail still available |
| Per-tool / pre-execution gate | Partial — settings.json hooks; pre-tool-use hook can deny | Yes — `approval-on-request` policy | No | **Yes (post-cycle 6, opt-in)** — `AUTO_ARCHIVE_RESEARCH_PLAN_APPROVAL_ON_REQUEST=on` adds a pre-dispatch `RuntimeApprovalRegistry` gate to `/research-plan` (deny → clean stoppedEarly). Per-tool granularity remains a Plana-advisor veto only. |
| Onboarding / quickstart | Partial — `/help` slash + IDE first-launch flow | Yes — `codex --help` is canonical, plus interactive `codex` REPL | Yes — `gh copilot suggest` with interactive refinement | **Yes (post-cycle 6)** — `/quickstart` surfaces a "first 60 seconds" card with recent terminal + in-flight task ids + top-used inspection / control verbs + `/help` link |
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

## 4. Backlog (cycles 4–12)

Mapped to the gap categories above. Cycle 5 closed five error-path
items (UX-17..UX-22) raised by a plan-mode DT audit (3 axis Explore)
that the original cycle-4 spec missed. Cycle 6 closed three of the
deferred originals (UX-12 quickstart, UX-13 CLI `--json`, UX-16
opt-in approval-on-request gate). Cycle 7 carries the remaining two
medium-risk originals (UX-14 button row, UX-15 `/follow` live tail).
Cycles 8–12 then closed user-feedback-driven lifecycle and mention UX
issues: in-place task lifecycle, per-task threads, natural-language
adapter parity, ledger-observed delivery proof, and chat-by-default
mention routing with explicit task escalation.

| ID | Cycle | Gap | Description | Status |
|----|-------|-----|-------------|--------|
| UX-11 | 4 | 3.1 activity stream | Tool-use heartbeat in `/research-plan` Discord progress (throttled per-tool-class summary) | landed |
| UX-17 | 5 | spec correction | This row's claim about per-tool-use visibility was outdated post-UX-11; cycle 5 corrected it | landed |
| UX-18 | 5 | activity stream / test pin | Fake-timer test for the heartbeat 60 s time-gate (only the count-gate was previously covered) | landed |
| UX-19 | 5 | error-path UX | `renderApprovalResolutionFailed` status-aware hint (`unknown`/`duplicate` → `/feed kind:approval` recovery) | landed |
| UX-20 | 5 | error-path UX | Replace `throw new Error('task_id is required …')` in `/status`, `/cancel`, `/rerun`, `/archive`, `/unarchive` with a Discord-friendly editReply + hint | landed |
| UX-21 | 5 | error-path UX | `renderTerminalResult` reuses cycle-2's `humanizeResearchPlanCauseKind` + adds `buildTerminalNextStepHint` so non-success terminals carry operator next-step guidance | landed |
| UX-22 | 5 | error-path UX (rename drift) | `renderSubagentOperatorUnavailable` hint imports `AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH` from `doctor.ts` instead of hardcoding the literal string | landed |
| UX-12 | 6 | 3.4 NL → suggest | `/quickstart` slash command — recent terminal/active task ids + top-5 commands + link to `/help` | landed |
| UX-13 | 6 | matrix gap (JSON output) | CLI runner `--json` flag emits structured progress + summary as JSONL on stdout (legacy human summary preserved when omitted) | landed |
| UX-14 | 7 | 3.3 structured input | Discord button row for `/subagents` list reply (per-row [Kill] [Log]); button-press routes through `adaptSubagentButtonInteraction` to the existing `handleSubagents` | landed |
| UX-15 | 7 | 3.5 single-task tail | `/follow task_id:<id>` registers a `DiscordFollowController` subscription, polls `loadSince` per tick, posts batched followUps, auto-stops on terminal or 14 min idle | landed |
| UX-23 | 8 | user feedback (channel noise) | `/ask` / `/research` lifecycle (accept → running → terminal) flows through `editReply` instead of separate followUps; one in-place updated channel message per task | landed |
| UX-24 | 9 | user feedback (intuitive task surface) | Each `/ask` / `/research` task opens a Discord-native thread off its accept message; lifecycle + terminal mirror into the thread so the task is followable without `/status task_id:<id>` re-fetch. Fail-open: missing permission / DM falls back to channel-only delivery (UX-23 still applies) | landed |
| UX-23/24-NL | 10 | user feedback (mention parity) | Natural-language mention adapter uses the same in-place lifecycle update and task-thread anchor path as slash `/ask`/`/research`, instead of falling back to noisy followUps or channel-only task tracking | landed |
| UX-25 | 11 | live verification / task delivery proof | `task.delivery_observed` control-plane ledger event records Discord delivery metadata so retained ledgers can prove a task was delivered without requiring raw Discord content or live service access in tests | landed |
| UX-26 | 12 | user feedback (chat-by-default mentions) | Mention-driven NL defaults to chat; work-shaped mentions get a bounded task-escalation hint, and explicit `task:` / confirm replies dispatch through the task lifecycle | landed |
| UX-26H | 12 | hardening (Discord interaction invariant) | Task-confirm escalation path preserves the single-defer invariant before entering shared task dispatch, avoiding a real Discord double-defer/reply failure while retaining the escalation acknowledgement | landed |
| UX-16 | 6 | 3.2 pre-execution gate | Opt-in `AUTO_ARCHIVE_RESEARCH_PLAN_APPROVAL_ON_REQUEST=on` env-flag adds a pre-dispatch `RuntimeApprovalRegistry`-backed gate to `/research-plan` (deny → clean stoppedEarly) | landed |

## 5. References

- Claude Code agent contract: `~/.claude/CLAUDE.md` (project memory pattern)
- Codex CLI sandbox/approval modes: documented in `~/.codex/auth.json` config patterns
- Copilot CLI `gh copilot suggest|explain` (gh extension)
- Cycle 1–3 UX work: commits `4b563c6` → `f3cb63d`
- Cycle 4 UX work: commit `be11acc` (heartbeat + this spec)
- Cycle 5 UX work (DT-audit-augmented error-path closure): branch `ux/cycle-5-2026-05-09`
- Cycle 6 UX work (`/quickstart` + CLI `--json` + opt-in approval-on-request gate): branch `ux/cycle-6-2026-05-09`
- Cycle 7 UX work (`/subagents` button row + `/follow` live tail): branch `ux/cycle-7-2026-05-09`
- Cycle 8 UX work (in-place lifecycle edit, user-feedback driven): branch `ux/cycle-8-2026-05-09`
- Cycle 9 UX work (per-task auto thread, user-feedback driven): branch `ux/cycle-9-2026-05-09`
- Cycle 10 UX work (natural-language adapter in-place edit + thread anchor): branch `ux/cycle-10-2026-05-09`
- Cycle 11 UX work (`task.delivery_observed` retained delivery evidence): branch `ux/cycle-11-2026-05-09`
- Cycle 12 UX work (chat-by-default mention routing + task escalation): branch `ux/cycle-12-2026-05-09`
- Open backlog tracker: this file (future cycles column)
