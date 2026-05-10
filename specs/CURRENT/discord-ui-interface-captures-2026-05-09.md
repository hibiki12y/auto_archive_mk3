---
status: current
authority: implementation-explanation
last_verified: 2026-05-10
source_paths:
  - src/control/control-plane-ledger.ts
  - src/discord/discord-command-registry.ts
  - src/discord/discord-result-renderer.ts
  - src/discord/discord-access-policy.ts
  - src/discord/discord-research-mission.ts
  - src/discord/discord-research-plan-store.ts
  - src/discord/discord-command-handlers.ts
  - src/discord/discord-bot.ts
  - tests/discord-command-registry.spec.ts
  - tests/discord-proof-command.spec.ts
  - tests/discord-mention-chat-routing.spec.ts
  - tests/discord-natural-language-in-place.spec.ts
  - tests/discord-delivery-observed.spec.ts
  - tests/discord-research-mission-store.spec.ts
  - tests/discord-research-mission-command.spec.ts
  - tests/discord-research-plan-store.spec.ts
  - tests/discord-research-mission-summary.spec.ts
  - tests/discord-research-evidence-claim-render.spec.ts
  - tests/discord-research-subtask-card.spec.ts
  - tests/discord-research-closeout-checklist.spec.ts
  - tests/wave-0-baseline.spec.ts
scope: Static Discord UI payload captures for reviewer handoff; no live Discord token, gateway, REST call, screenshot, or operator-owned proof is included.
---

# Discord UI interface captures — UX-26H / cycles 10–12 handoff

This file records static UI examples so another worker can review the operator-facing Discord interface without needing live Discord credentials. These are **payload captures**, not live screenshots: they are generated from the renderer contract and checked against the current tests. They support review of message copy, escalation flow, and retained-ledger shape, but they do **not** promote the Discord service row in `live-proof-matrix.md` to live-ready.

## Reviewer handoff index

Use this document as the review packet for UI/message-shape inspection. The
examples are ordered from operator entrypoints to retained-ledger evidence so a
reviewer can validate copy, allowed-mention posture, action labels, and static
vs live-proof boundaries without running Discord.

| Review target | Example(s) | Primary source/test anchors |
| --- | --- | --- |
| Mention routing and task escalation copy | Examples 1, 2, 6, 7 | `renderMentionChatReply`, `renderMentionChatWithTaskHint`, `renderMentionTaskEscalated`; `tests/discord-mention-chat-routing.spec.ts` |
| Research mission summary / pin-ready cards | Examples 3, 3A, 3B, 3J | `renderResearchMissionSummary`, `renderResearchMissionPinnedSummary`, mission-scoped subagent role summary; `tests/discord-research-mission-summary.spec.ts`, `tests/discord-research-mission-command.spec.ts` |
| Approval validation and research-plan handoff | Examples 3C, 3D | `DiscordResearchPlanStore`, `/research action:approve`; `tests/discord-research-plan-store.spec.ts`, `tests/discord-research-mission-command.spec.ts` |
| Evidence/claim ledger surfaces and sub-task extraction | Examples 3E, 3F | `DiscordResearchMissionStore.addEvidence/addClaim/linkEvidence/extractSubtaskEvidence`; `tests/discord-research-mission-store.spec.ts`, `tests/discord-research-evidence-claim-render.spec.ts` |
| Claim/evidence synthesis draft | Example 3G | `DiscordResearchMissionStore.generateSynthesis`, `renderResearchSynthesis`, `research.synthesis_generated`; `tests/discord-research-mission-store.spec.ts`, `tests/discord-research-mission-command.spec.ts` |
| Critique preflight UX | Example 3K | `/critique mission_id:<id> lens:<...>`, `renderResearchCritiquePreflight`; `tests/discord-research-mission-command.spec.ts` |
| Proof status/start/export/capture Discord bridge | Examples 3H, 3M, 3I, 3L, 3J | `/proof action:status`, `/proof action:start surface:<surface>`, `/proof action:export surface:<surface>`, `/proof action:capture surface:<surface>`, `renderProofStatus`, `renderProofStartPreflight`, `renderProofExportTemplate`, `renderProofCapturePreflight`, mission summary proof-report bridge, redacted `AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH` doctor status, live-proof manifest skeleton export, operator start/capture preflight; `tests/discord-proof-command.spec.ts`, `tests/discord-research-mission-command.spec.ts` |
| Mission doctor, closeout/checklist, subagent role tree/spawn preflight, and retained evidence boundaries | Examples 4, 4B, 4C, 5, 5B, 5C, 8 | `renderResearchSubtaskCard`, `renderResearchSubagentTreePreflight`, `renderResearchSubagentSpawnPreflight`, `renderResearchCloseoutChecklist`, `renderResearchMissionDoctor`, `/subagents action:tree mission_id:<id>`, `/subagents action:spawn mission_id:<id> role:<role> text:<task>`, `/research action:archive`, `/doctor mission_id:<id>`, `task.delivery_observed`; `tests/discord-research-subtask-card.spec.ts`, `tests/discord-research-subagent-tree.spec.ts`, `tests/discord-subagents-list.spec.ts`, `tests/discord-research-closeout-checklist.spec.ts`, `tests/discord-research-mission-command.spec.ts`, `scripts/check-task-message-shape.mjs` |

## Capture method

Capture source pinning:

| Field | Value |
| --- | --- |
| Branch at capture | `ux/cycle-12-2026-05-09` |
| HEAD at capture | `728370d` |
| Working-tree note | includes uncommitted UX-26H/lint/spec changes listed in this handoff; the 2026-05-10 synthesis-slice examples are appended to this 2026-05-09 capture packet instead of creating a second near-duplicate file; `dist/` build output is ignored and not tracked |
| Renderer import used | `dist/src/discord/discord-result-renderer.js` after local `pnpm build` |
| Placeholder/PII sweep | all user/channel/task ids are synthetic reviewer fixtures; payload examples disable allowed mention parsing where renderer returns `allowedMentions` |

- `PROJECT.md` status was `ACTIVE`.
- Built local `dist/` from the current working tree, then imported the renderer functions from `dist/src/discord/discord-result-renderer.js`.
- Captured payloads from current renderer outputs; rerun `pnpm build` and import from `dist/src/discord/discord-result-renderer.js` to regenerate.
- Captured payloads from:
  - `renderResearchMissionSummary`
  - `renderResearchMissionPinnedSummary`
  - `renderResearchMissionPlanUnavailable`
  - `renderResearchPlanAccepted`
  - `renderResearchEvidenceAdded`
  - `renderResearchEvidenceList`
  - `renderResearchClaimAdded`
  - `renderResearchClaimLinked`
  - `renderResearchClaimList`
  - `renderResearchSynthesis`
  - `renderResearchCritiquePreflight`
  - `renderProofStatus`
  - `renderProofStartPreflight`
  - `renderProofExportTemplate`
  - `renderProofCapturePreflight`
  - `renderResearchSubtaskCard`
  - `renderResearchSubagentTreePreflight`
  - `renderResearchCloseoutChecklist`
  - `renderResearchMissionDoctor`
  - `renderMentionChatReply`
  - `renderMentionChatWithTaskHint`
  - `renderMentionTaskEscalated`
  - `renderAskAccepted`
  - `renderRunningUpdate`
  - `renderTerminalResult`
- No `.env`, token, gateway session, Discord REST call, or bot account was used.

Reviewer-facing fixture values:

| Field | Value |
| --- | --- |
| User text | `메르센 소수를 출력` |
| Task id | `discord-task-review-001` |
| Runtime instance | `agent-discord-task-review-001` |
| Artifact | `results/task-artifacts/discord-task-review-001` |
| Chat-hint TTL | 300 seconds / 5 minutes (`MentionChatHintState` default is `5 * 60 * 1_000` in `src/discord/discord-mention-intent-classifier.ts`) |
| Mission id | `R-20260509-a1` |
| Mission command/store foundation | `DiscordResearchMissionStore` can now create a draft mission, retain current-channel/thread binding, approve with `planId`, record operator-supplied evidence/claims, link evidence as support/challenge, generate a deterministic claim/evidence synthesis draft, replay from the control-plane ledger, and adapt records into `renderResearchMissionSummary` / `renderResearchMissionPinnedSummary` input. `DiscordResearchPlanStore` now validates configured `/research action:approve plan_id:<id>` values against the existing `/research-plan` JSON loader when wired. When both the plan store and `researchPlanRuntimeDriver` are wired, `/research action:approve` also emits the existing `/research-plan` accepted handoff, dispatches the loaded plan through the research-plan orchestrator, and records each completed sub-task outcome as a mission evidence candidate. The offline `/research action:new/show/status/approve/pin/synthesize`, `/evidence action:add/list`, and `/claim action:add/list/support/challenge` handler paths emit these summaries; live Discord thread creation and actual pinned-message updates remain out of scope for this capture. |
| Missing plan id | `missing-plan` |
| Evidence id | `E-20260510-a1` |
| Claim id | `C-20260510-a1` |
| Subtask id | `R-20260509-a1-subtask-03-gap-analysis` |
| Closeout checklist | `R-20260509-a1` |

## Example 1 — short mention stays chat-only

Operator input:

```text
<@bot> 안녕
```

Expected delivery:

| Property | Value |
| --- | --- |
| Handler path | natural-language mention → `chat-only` |
| Discord operation | `editReply` after `deferReply` |
| Task registry | no task is registered |
| Allowed mentions | disabled (`parse: []`) |

Captured payload:

```json
{
  "content": "메시지 받았습니다: \"안녕\"\n💡 task로 처리하시려면 `task: <메시지>` 형식이나 `<@bot> 처리해줘`로 다시 보내주세요. 단순 대화는 그대로 남겨두면 됩니다.",
  "allowedMentions": {
    "parse": []
  }
}
```

Review notes:

- This is the cycle-12 chat-by-default behavior when `AUTO_ARCHIVE_DISCORD_MENTION_DEFAULT_CHAT=on` wires `MentionChatHintState`.
- Slash `/ask` remains explicit task dispatch and does not use this chat-only branch.

## Example 2 — work-shaped mention offers task escalation

Operator input:

```text
<@bot> 메르센 소수를 출력
```

Expected delivery:

| Property | Value |
| --- | --- |
| Handler path | natural-language mention → `chat-with-task-hint` |
| Discord operation | `editReply` after `deferReply` |
| Task registry | no task is registered yet |
| Hint state | records `(channelId, userId)` with original instruction |
| Confirmation window | 5 minutes |

Captured payload:

```json
{
  "content": "메시지 받았습니다: \"메르센 소수를 출력\"\n🤔 이 작업은 task로 처리하는 게 좋아 보입니다.\n`<@bot> 진행` 또는 `<@bot> yes`로 답하시면 task로 dispatch합니다 (5분 안에 답해주세요).\n단순 대화로 남기시려면 그냥 무시하시면 됩니다.",
  "allowedMentions": {
    "parse": []
  }
}
```

Review notes:

- The user can ignore the hint to leave the interaction as chat.
- The original instruction is retained in memory only as bounded per-channel/user hint state; the confirm word itself is not dispatched as the task instruction.

## Example 3 — research mission summary static payload preview

This is a **static payload preview** generated from `renderResearchMissionSummary`. It helps reviewers inspect the planned Phase 1 Mission Summary UX from `documents/suggestion.md` §11.1 plus the Phase 4 mission-scoped subagent role-state line, without a Discord token, gateway call, live subagent spawn, or operator-owned proof capture.

Captured payload:

```json
{
  "content": "Research Mission `R-20260509-a1`\nTitle: Auto Archive Mk3 Discord 연구 UX 개선\nStatus: running\nPhase: evidence synthesis\nOwner: @​operator\nThread: #research-runs / R-20260509-a1\nPlan:\n✓ 1. Hermes/OpenClaw baseline\n✓ 2. Auto Archive current audit\n▶ 3. Gap analysis\n□ 4. Discord-first proposal\n□ 5. Implementation roadmap\nEvidence: 9 items\nClaims: 6 supported, 2 uncertain, 1 challenged\nProof: 3 PASS, 4 WARN\nSubagents: 2 mission matches\nSubagent roles: collector 1 active; critic 1 reserved\nNext: [Run critique] [Synthesize] [Show evidence] [Archive]",
  "allowedMentions": {
    "parse": []
  },
  "components": [
    {
      "kind": "action-row",
      "components": [
        {
          "kind": "button",
          "customId": "research-mission:run-critique:R-20260509-a1",
          "label": "Run critique",
          "style": "primary"
        },
        {
          "kind": "button",
          "customId": "research-mission:synthesize:R-20260509-a1",
          "label": "Synthesize",
          "style": "success"
        },
        {
          "kind": "button",
          "customId": "research-mission:show-evidence:R-20260509-a1",
          "label": "Show evidence",
          "style": "secondary"
        },
        {
          "kind": "button",
          "customId": "research-mission:archive:R-20260509-a1",
          "label": "Archive",
          "style": "danger"
        }
      ]
    }
  ]
}
```

Review notes:

- `allowedMentions.parse` stays empty and the owner label is zero-width-sanitized (`@​operator`) so the payload remains mention-safe even in static reviewer fixtures.
- This preview is **not** live Discord proof. It does not demonstrate thread creation, live button delivery, permissions, or gateway visibility.
- The button `customId` contract is namespaced as `research-mission:<verb>:<missionId>`; the bot adapter now routes supported mission buttons through the existing slash-command handlers while renderer-side normalization keeps those custom-id parts parse-safe and within Discord's 100-character limit.
- Phase 1 data foundation exists behind this preview: `DiscordResearchMissionStore` records draft mission state, current-channel/thread binding, approval metadata, and control-plane replay; the offline `/research action:new/show/status/approve/pin` command-handler path emits the summary, but no live Discord gateway/thread/pin/button proof is claimed here.
- The `Subagents:` lines are mission-scoped read-only roster state derived from parent task ids matching `discord-research-mission-plan-<mission_id>-<numeric-run-suffix>`; they do not imply `/subagents action:spawn` has executed.


## Example 3A — research mission draft created by the store foundation

This is a **static payload preview** generated from `DiscordResearchMissionStore.createDraft(...)` → `toSummaryInput(...)` → `renderResearchMissionSummary(...)`, matching the offline `/research action:new instruction:<goal>` handler path. It captures the first Phase 1 MVP handoff screen another worker would review before live Discord thread/pin wiring exists.

Captured payload:

```json
{
  "content": "Research Mission `R-20260510-a1`\nTitle: Auto Archive Mk3 Discord 연구 UX 개선\nStatus: draft\nPhase: plan draft\nOwner: @​operator\nThread: research-runs\nPlan:\n▶ 1. Clarify scope for OpenClaw/Hermes 대비 Auto Archive 연구 UX 개선\n□ 2. Baseline comparison\n□ 3. Current state audit\n□ 4. Gap analysis\n□ 5. Implementation roadmap\nEvidence: 0 items\nClaims: 0 supported, 0 uncertain, 0 challenged\nProof: 0 PASS, 0 WARN\nNext: [Approve plan] [Show plan] [Cancel]",
  "allowedMentions": {
    "parse": []
  },
  "components": [
    {
      "kind": "action-row",
      "components": [
        {
          "kind": "button",
          "customId": "research-mission:approve:R-20260510-a1",
          "label": "Approve plan",
          "style": "success"
        },
        {
          "kind": "button",
          "customId": "research-mission:show-plan:R-20260510-a1",
          "label": "Show plan",
          "style": "secondary"
        },
        {
          "kind": "button",
          "customId": "research-mission:cancel:R-20260510-a1",
          "label": "Cancel",
          "style": "danger"
        }
      ]
    }
  ]
}
```

Review notes:

- This preview is derived from the in-memory control-plane-backed store foundation, not a hand-authored renderer-only fixture.
- It demonstrates the current-channel binding fallback (`Thread: research-runs`) before a Discord thread is created; thread-bound summaries render as `channel / thread` once `bindThread(...)` records a binding.
- It preserves the static-preview/live-proof boundary: the offline command-handler path and button adapter are tested, but no live Discord gateway call, pinned-message update, or Discord API call is exercised here.
- Command syntax note: the current registry exposes Phase 1 mission actions as `/research action:<new|show|status|approve|pin|synthesize>` options for backward compatibility with legacy `/research instruction:<task>` dispatch. A future true Discord subcommand migration (`/research new`) should be treated as a separate compatibility slice.
- Approval validation note: production bootstrap wires `DiscordResearchPlanStore` so `/research action:approve` refuses unknown or invalid `plan_id` values before appending `research.mission_approved`; tests can omit the store to exercise the legacy unvalidated handoff path.
- Approval dispatch note: when a configured `DiscordResearchPlanStore` finds the plan and a `researchPlanRuntimeDriver` is wired, `/research action:approve` keeps the approved mission summary as the edited reply, then posts the existing research-plan accepted handoff as a follow-up and dispatches the loaded plan through the existing research-plan orchestrator. If the runtime driver is absent, approval remains a validated mission-state handoff only.

## Example 3B — research mission pin-ready status card

This is a **static payload preview** generated from `renderResearchMissionPinnedSummary`, matching the offline `/research action:pin mission_id:<id>` handler path. It records the Phase 1 `PinnedSummaryRenderer` contract for reviewer handoff without claiming that a Discord message was actually pinned or edited in place.

Captured payload:

```json
{
  "content": "📌 Research Mission Pin `R-20260510-a1`\nTitle: Auto Archive Mk3 Discord 연구 UX 개선\nStatus: draft · Phase: plan draft\nThread: research-runs\nProgress: 0/5 plan steps complete\nCurrent: Clarify scope for OpenClaw/Hermes 대비 Auto Archive 연구 UX 개선\nEvidence: 0 items · Claims: 0 supported, 0 uncertain, 0 challenged · Proof: 0 PASS, 0 WARN\nNext: [Approve plan] [Show plan] [Cancel]",
  "allowedMentions": {
    "parse": []
  },
  "components": [
    {
      "kind": "action-row",
      "components": [
        {
          "kind": "button",
          "customId": "research-mission:approve:R-20260510-a1",
          "label": "Approve plan",
          "style": "success"
        },
        {
          "kind": "button",
          "customId": "research-mission:show-plan:R-20260510-a1",
          "label": "Show plan",
          "style": "secondary"
        },
        {
          "kind": "button",
          "customId": "research-mission:cancel:R-20260510-a1",
          "label": "Cancel",
          "style": "danger"
        }
      ]
    }
  ]
}
```

Review notes:

- This is a pin-ready card, not a live pin proof. It exercises the same renderer/handler contract a future Discord adapter can use when it creates or edits the mission thread's pinned summary message.
- The compact card prioritizes current phase, thread binding, plan progress, evidence/claim/proof counters, and the next action buttons so reviewers can assess the proposed pinned summary UX without a bot token. Supported `research-mission:*` buttons are adapter-wired to the existing `/research`, `/evidence`, and `/critique` handlers; approve still asks for `plan_id` through the existing validation path when the button lacks one.

## Example 3C — research mission approval rejects an unavailable plan

This is a **static payload preview** generated from `renderResearchMissionPlanUnavailable`. It captures the reviewable screen emitted when a configured `DiscordResearchPlanStore` cannot load the requested `plan_id`; the handler sends this before appending any `research.mission_approved` ledger event.

Captured payload:

```json
{
  "content": "Research plan `missing-plan` could not be loaded for mission approval.\nReason: plan missing at [path] for @​everyone and ʼinlineʼ\n💡 Create or fix the plan under `runtime-state/research-plans/`, then retry `/research action:approve mission_id:<id> plan_id:<id>`.",
  "allowedMentions": {
    "parse": []
  }
}
```

Review notes:

- The unavailable-plan screen is **not** a live Discord proof; it is derived from the renderer contract and covered by offline command-handler tests.
- The reason line demonstrates current safety behavior: probable filesystem paths are redacted to `[path]`, `@everyone` is zero-width neutralized, backticks are normalized to `ʼ`, and `allowedMentions.parse` remains empty.
- The default `/research-plan` loader now reports missing files as `configured research-plan directory` rather than exposing a resolved absolute path.

## Example 3D — research mission approval dispatches a validated plan handoff

This static two-message preview captures the offline `/research action:approve mission_id:<id> plan_id:<id>` path when both `DiscordResearchPlanStore` and `researchPlanRuntimeDriver` are configured. The first payload is the approved mission summary edited into the original interaction response; the second is the existing `/research-plan` accepted handoff posted as a follow-up before the loaded plan is dispatched through the research-plan orchestrator.

Edited reply payload:

```json
{
  "content": "Research Mission `R-20260510-a1`\nTitle: Auto Archive Mk3 Discord 연구 UX 개선\nStatus: approved\nPhase: approved (/research-plan plan-id:phase-1)\nOwner: @​operator\nThread: research-runs\nPlan:\n▶ 1. Clarify scope for OpenClaw/Hermes 대비 Auto Archive 연구 UX 개선\n□ 2. Baseline comparison\n□ 3. Current state audit\n□ 4. Gap analysis\n□ 5. Implementation roadmap\nEvidence: 0 items\nClaims: 0 supported, 0 uncertain, 0 challenged\nProof: 0 PASS, 0 WARN\nNext: [Status] [Synthesize] [Show evidence] [Archive]",
  "allowedMentions": {
    "parse": []
  },
  "components": [
    {
      "kind": "action-row",
      "components": [
        {
          "kind": "button",
          "customId": "research-mission:status:R-20260510-a1",
          "label": "Status",
          "style": "secondary"
        },
        {
          "kind": "button",
          "customId": "research-mission:synthesize:R-20260510-a1",
          "label": "Synthesize",
          "style": "primary"
        },
        {
          "kind": "button",
          "customId": "research-mission:show-evidence:R-20260510-a1",
          "label": "Show evidence",
          "style": "secondary"
        },
        {
          "kind": "button",
          "customId": "research-mission:archive:R-20260510-a1",
          "label": "Archive",
          "style": "danger"
        }
      ]
    }
  ]
}
```

Follow-up payload:

```json
{
  "content": "🧭 Research plan `phase-1` accepted.\nSub-tasks queued: **2** (sequential) + 1 synthesis.\nProvider: `codex`.\nPer-sub-task progress will follow as each completes.\n⚠️ Long plans may exceed Discord's ~15-min interaction window — for runs >15 min use `pnpm research:plan:run`.",
  "allowedMentions": {
    "parse": []
  }
}
```

Review notes:

- This is still offline/static evidence: it verifies the handler-to-orchestrator handoff shape without a live Discord token.
- The loaded plan object comes from `DiscordResearchPlanStore.inspect(...).plan`, so the approval path does not re-parse a different file before dispatch.
- If `researchPlanRuntimeDriver` is not wired, `/research action:approve` stops after the validated mission approval summary and does not pretend a plan run has started.

## Example 3E — mission evidence and claim ledger Discord surfaces

This static four-message preview captures the Phase 2 foundation path for
`/evidence action:add/list` plus `/claim action:add/list/support/challenge`.
It is operator-supplied ledger input only; automatic sub-task evidence
candidate extraction and claim/evidence synthesis are captured in Examples 3F
and 3G.

Evidence add payload:

```json
{
  "content": "Evidence `E-20260510-a1` added to research mission `R-20260509-a1`.\nSummary: TerminalEvidence retained for baseline comparison\nSource: terminal:task-baseline\nMission evidence count: 1\nNext: use `/claim action:support mission_id:<id> claim_id:<id> evidence_id:<id>` or `/evidence action:list mission_id:<id>`.",
  "allowedMentions": {
    "parse": []
  }
}
```

Claim add payload:

```json
{
  "content": "Claim `C-20260510-a1` added to research mission `R-20260509-a1`.\nStatus: uncertain\nClaim: Pinned summaries reduce intermediate state lookup time.\nMission claims: 0 supported, 1 uncertain, 0 challenged\nNext: connect evidence with `/claim action:support` or `/claim action:challenge`.",
  "allowedMentions": {
    "parse": []
  }
}
```

Claim support payload:

```json
{
  "content": "Evidence `E-20260510-a1` now supports claim `C-20260510-a1` in research mission `R-20260509-a1`.\nClaim status: supported\nClaim: Pinned summaries reduce intermediate state lookup time.\nMission claims: 1 supported, 0 uncertain, 0 challenged",
  "allowedMentions": {
    "parse": []
  }
}
```

List payloads:

```json
{
  "evidence": {
    "content": "Evidence for research mission `R-20260509-a1`\n1. `E-20260510-a1` — TerminalEvidence retained for baseline comparison (terminal:task-baseline)",
    "allowedMentions": {
      "parse": []
    }
  },
  "claims": {
    "content": "Claims for research mission `R-20260509-a1`\n1. `C-20260510-a1` [supported] — Pinned summaries reduce intermediate state lookup time. (support:1, challenge:0)",
    "allowedMentions": {
      "parse": []
    }
  }
}
```

Review notes:

- The mission summary counts update after these operations: `Evidence: 1 item` and `Claims: 1 supported, 0 uncertain, 0 challenged`.
- The store appends replayable `research.evidence_added`, `research.claim_added`, and `research.claim_supported` / `research.claim_challenged` control-plane events.
- These commands are tagged Discord-only in the command registry so they do not leak into the ACP slash-command surface before an ACP-native research-state UX exists.

## Example 3F — approved research-plan sub-tasks become evidence candidates

This static preview captures the Phase 2 extraction bridge after
`/research action:approve mission_id:<id> plan_id:<id>` dispatches a validated
plan through the research-plan orchestrator. Each completed ordinary sub-task
is recorded as mission evidence; the synthesis step is not recorded as a
sub-task evidence item.

Mission summary after two completed sub-tasks:

```json
{
  "content": "Research Mission `R-20260510-cmd`\nTitle: approved plan dispatch bridge\nStatus: approved\nPhase: approved (/research-plan plan-id:connected-plan)\nOwner: @​operator\nThread: research-runs\nPlan:\n▶ 1. Clarify scope for approved plan dispatch bridge\n□ 2. Baseline comparison\n□ 3. Current state audit\n□ 4. Gap analysis\n□ 5. Implementation roadmap\nEvidence: 2 items\nClaims: 0 supported, 0 uncertain, 0 challenged\nProof: 0 PASS, 0 WARN\nNext: [Status] [Synthesize] [Show evidence] [Archive]",
  "allowedMentions": {
    "parse": []
  }
}
```

Evidence list after extraction:

```json
{
  "content": "Evidence for research mission `R-20260510-cmd`\n1. `E-20260510-cmd` — Research-plan sub-task collect completed with success: collect-done (research-plan:connected-plan/collect)\n2. `E-20260510-cmd-2` — Research-plan sub-task audit completed with success: audit-done (research-plan:connected-plan/audit)",
  "allowedMentions": {
    "parse": []
  }
}
```

Review notes:

- This remains offline/static evidence; the fixture uses a fake runtime driver and does not prove live Discord delivery or provider execution.
- The source format is `research-plan:<planId>/<subTaskId>` so operators can connect later `/claim action:support|challenge` calls to the originating plan lane.
- Repeated deterministic id factory output is de-duplicated with suffixes such as `E-20260510-cmd-2`; production ids still use the store's random default.

## Example 3G — claim/evidence synthesis draft from mission ledger

This static preview captures the remaining Phase 2 bridge for
`/research action:synthesize mission_id:<id>`. The handler does not call an LLM
or claim final research quality; it creates a deterministic synthesis draft from
the mission's recorded claims and linked evidence so another worker can review
the evidence basis before critique or closeout.

Synthesis payload after one supported claim:

```json
{
  "content": "Synthesis draft `S-20260510-cmd` for research mission `R-20260510-cmd`\nGenerated by: operator at 2026-05-10T01:00:00.000Z\nEvidence basis: 1 item\nClaims: 1 supported, 0 uncertain, 0 challenged\nDraft:\nEvidence-backed synthesis draft for R-20260510-cmd: evidence claim mission\nEvidence basis: 1 item.\nClaim coverage: 1 supported, 0 uncertain, 0 challenged; 0 claims without linked evidence.\nSupported claims (1):\n- C-20260510-cmd [supported] Pinned summaries reduce intermediate state lookup time. (support: E-20260510-cmd)\nChallenged claims (0):\n- none\nUncertain claims (0):\n- none\nNext: run critique on unsupported or challenged claims before archive closeout.\nNext: review with `/claim action:list` or `/evidence action:list`; archive closeout is a later slice.",
  "allowedMentions": {
    "parse": []
  }
}
```

Review notes:

- This is deterministic claim/evidence synthesis input, not an autonomous final report. It intentionally surfaces unsupported or challenged claims as review targets.
- `DiscordResearchMissionStore.generateSynthesis(...)` appends a replayable `research.synthesis_generated` ledger event and updates the mission phase to `claim/evidence synthesis`.
- The generated draft references evidence ids rather than embedding raw artifacts; deeper artifact expansion remains a later proof/archive UX task.
- Empty synthesis drafts are explicitly permitted as review placeholders (`0 evidence / 0 claims`) so an operator can see that a mission has no basis yet; tests pin this repeated-generation and replay behavior.
- Synthesis records snapshot the evidence/claim state at generation time. Later claim/evidence edits require a new synthesis id rather than mutating the old capture.
- The renderer keeps synthesis payloads under Discord's 2,000-character single-message limit by truncating body lines and increasing the omitted-line count before appending the closeout-later note.

## Example 3K — critique preflight for a mission lens

This static preview captures the first `/critique` UX slice:
`/critique mission_id:<id> lens:counterargument`. The command is read-only in
this slice. It summarizes the mission's evidence, claim, and synthesis context
for a selected critique lens, but does **not** invoke an external critic, write
critique evidence, mutate claims, update proof/archive state, or contact live
services.

Captured payload:

```json
{
  "content": "Critique preflight for research mission `R-20260510-cmd`\nLens: counterargument\nMission: synthesizing · claim/evidence synthesis\nEvidence: 1 item\nClaims: 1 supported, 1 uncertain, 0 challenged\nSynthesis: `S-20260510-cmd`\nLens focus:\n- Stress-test supported claims with plausible alternatives and failure modes.\n- Look for unaddressed challenged/uncertain claims before archive closeout.\nPreflight warnings:\n! 1 uncertain claim(s) need review\nBoundary: read-only preflight only; no external critic invoked and no evidence, claim, proof, GitLab, or archive state mutated.\nNext: fix warnings, then run a future critique execution slice or record reviewer findings as `/evidence` and `/claim` updates.",
  "allowedMentions": {
    "parse": []
  }
}
```

Review notes:

- The payload is a preflight checklist for reviewer execution, not a completed
  critique result.
- Lens choices are `methodology`, `evidence`, `counterargument`, and
  `reproducibility`; this example uses the counterargument lens because it is
  the closeout-critical path in the proposal.
- The handler reads mission state only and the test asserts no new
  `research.*` mission-mutation ledger event is appended by `/critique` (a
  generic delivery observation may still be recorded by the surrounding
  delivery pipeline).

## Example 3H — proof status Discord bridge from configured live-proof manifest

This static preview captures the first Phase 3 Proof UX bridge:
`/proof action:status mission_id:<id>`. The command is admin-only and, when the
mission is tracked, shows mission-local proof counters beside the same redacted
live-proof report status that `/doctor` receives from
`AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH`; it does **not** start a proof run,
capture live evidence, export a manifest, contact live services, mutate proof
files, link proof artifacts to the mission, or render raw proof
summaries/correlation ids.

Captured payload with a WARN manifest scorecard:

```json
{
  "content": "Proof status\nMission: R-20260510-proof (draft · plan draft)\nMission-local proof: 0 PASS, 0 WARN, 0 FAIL\nMission proof link: local counters only; proof artifact linking is a later slice.\nManifest: [path]\nMax proof bytes: 10000\nReport status: warn\nProof records: 2\nComplete proofs: 1\nWarn/fail proofs: 1/0\nOperator-approved proofs: 2\nUnsafe boundaries: 0\nMissing artifact tokens: 3\nQuality score: 82/100\nRaw summaries: not rendered\nRaw correlation ids: not rendered\nLive service contact: none\nNext: Add 3 missing live-proof artifact token(s) from specs/CURRENT/live-proof-matrix.md.",
  "allowedMentions": {
    "parse": []
  }
}
```

Review notes:

- This is a Discord status bridge over the retained proof scorecard, not live proof collection. It must not promote a `warn`/`fail`/`no-proof` manifest to live-ready.
- The first proof line is mission-local counter state from the tracked
  Research Mission. The manifest scorecard remains global/redacted until a
  later proof-artifact linking slice connects retained proof records to the
  mission.
- `/proof` is explicitly Discord-only and admin-gated so the operator proof surface does not leak into ACP command discovery.
- `/proof action:start` is wired as an operator-start preflight only; it does
  not execute live proof or mutate proof manifests.
- Unknown `mission_id` values still render as sanitized header context only;
  tracked missions render local counters.

## Example 3M — proof start operator preflight for one live-proof surface

This static preview captures `/proof action:start mission_id:<id>
surface:discord-service`. The command is admin-only and turns the proof start
step from `documents/suggestion.md` §5.3 into Discord guidance for one selected
`live-proof-matrix.md` surface. It does **not** spawn proof work, read or write
proof files, mutate manifests, contact live services, capture evidence inside
Discord, or link proof records to the mission.

Captured payload:

```json
{
  "content": "Proof start preflight\nMission: R-20260510-proof (header context only; proof records remain operator-owned)\nSurface: discord-service\nStatus: operator-start preflight; Discord has not executed live proof.\nStart plan:\n1. Confirm the surface checklist in `specs/CURRENT/live-proof-matrix.md`.\n2. Collect the live evidence outside Discord under operator control.\n3. Use `/proof action:export surface:discord-service` for the manifest skeleton.\n4. Use `/proof action:capture surface:discord-service` for redaction and scoring steps.\n5. Score the redacted manifest with `pnpm live:proof:report -- --proof <path> --surface discord-service --pretty`.\nNext: run `/proof action:capture surface:discord-service` when the operator is ready to record evidence.\nBoundary: preflight guidance only; no proof process is spawned, no proof files are read/written, no manifests are mutated, no live services contacted, and no mission proof link is created.",
  "allowedMentions": {
    "parse": []
  }
}
```

Review notes:

- This is a start **preflight**, not proof execution. It provides the operator
  the next safe Discord commands and the compatible `live:proof:report` scoring
  command without claiming live-readiness.
- Missing or invalid `surface` values render mention-safe guidance with the
  known `live-proof-matrix.md` surface list.
- `mission_id` is header context only; mission-scoped proof linking remains a
  later Proof UX slice.

## Example 3I — proof manifest template export for one live-proof surface

This static preview captures the second Phase 3 Proof UX bridge:
`/proof action:export mission_id:<id> surface:discord-service`. The command is
admin-only and emits a `live:proof:report`-compatible manifest skeleton for one
selected `live-proof-matrix.md` surface. It does **not** read or write proof
files, contact live services, capture live evidence, render raw correlation ids,
or promote the template beyond WARN/non-promoting evidence.

Captured payload with a one-surface template:

````json
{
  "content": "Proof export template\nMission: R-20260510-proof (header context only; proof records remain operator-owned)\nSurface: discord-service\nStatus: template-only WARN; replace placeholders with redacted operator-owned live proof before promotion.\nCompatibility: save the JSON as a manifest and run `pnpm live:proof:report -- --proof <path> --surface discord-service --pretty`.\nBoundary: no proof files read/written, no live services contacted, raw summaries/correlation ids not rendered.\n```json\n{\n  \"schemaVersion\": 1,\n  \"proofs\": [\n    {\n      \"proofId\": \"discord-service-proof-template\",\n      \"surface\": \"discord-service\",\n      \"recordedAt\": \"2026-05-10T00:00:00.000Z\",\n      \"status\": \"warn\",\n      \"operatorApproved\": false,\n      \"artifactKind\": \"redacted-artifact-set\",\n      \"summary\": \"Template only. Replace with a redacted operator summary; never include secrets, prompts, raw responses, private artifacts, or raw task instructions.\",\n      \"artifacts\": [\n        \"gateway-ready\",\n        \"command-registration\",\n        \"admin-doctor-or-auth-smoke\",\n        \"correlated-command-reply\"\n      ],\n      \"boundary\": {\n        \"secretsRedacted\": true,\n        \"rawTokensIncluded\": false,\n        \"rawCredentialsIncluded\": false,\n        \"rawPromptsIncluded\": false,\n        \"rawResponsesIncluded\": false,\n        \"rawInstructionsIncluded\": false,\n        \"rawPrivateArtifactContentIncluded\": false\n      }\n    }\n  ]\n}\n```",
  "allowedMentions": {
    "parse": []
  }
}
````

Review notes:

- This is an export of the safe template shape, not a captured live proof artifact. The template stays `status: warn` and `operatorApproved: false`.
- `/proof action:export` requires one selected surface so the inline Discord payload stays reviewable under the 2,000-character message limit.
- The exported template is compatible with the existing `pnpm live:proof:report -- --proof <path> --surface <surface> --pretty` scoring path after an operator saves and replaces placeholders with real redacted evidence.
- `mission_id` is still header context only; the template proof record is not linked to a research mission until a later mission-scoped Proof UX slice.

## Example 3L — proof capture operator preflight for one live-proof surface

This static preview captures the third Phase 3 Proof UX bridge:
`/proof action:capture mission_id:<id> surface:durable-task-archive-ux`. The
command is admin-only and renders operator capture guidance for one selected
`live-proof-matrix.md` surface. It does **not** read or write proof files,
contact live services, mutate manifests, capture live evidence inside Discord,
or link proof records to the mission.

Captured payload:

```json
{
  "content": "Proof capture preflight\nMission: R-20260510-proof (header context only; proof records remain operator-owned)\nSurface: durable-task-archive-ux\nStatus: operator-capture preflight; no live proof artifact has been captured by Discord.\nOperator steps:\n1. Run or collect the live proof for this surface outside Discord.\n2. Save only redacted artifact references/summaries; exclude secrets, raw prompts, raw responses, credentials, and private artifact contents.\n3. Create or update the manifest with `pnpm live:proof:report -- --print-template --surface durable-task-archive-ux --pretty`, replace placeholders with operator-owned evidence, then score it with `pnpm live:proof:report -- --proof <path> --surface durable-task-archive-ux --pretty`.\nNext: rerun `/proof action:status` after the operator-owned manifest is configured.\nBoundary: preflight guidance only; no proof files are read/written, no live services contacted, no manifest mutation performed, and no mission proof link is created.",
  "allowedMentions": {
    "parse": []
  }
}
```

Review notes:

- This is capture guidance, not a captured proof artifact. The proof still
  becomes promotable only after an operator creates redacted artifacts and
  runs the existing `live:proof:report` path.
- Missing or invalid `surface` values render mention-safe guidance with the
  known `live-proof-matrix.md` surface list.
- `mission_id` is header context only; mission-scoped proof linking remains a
  later Proof UX slice.

## Example 3J — research mission summary with configured proof report status

This static preview captures the Phase 3 bridge from the configured
`AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH` doctor status into the Research Mission
Summary. The configured live-proof report remains **global** and read-only in
this slice: the summary shows it as a proof-report note without replacing the
mission's own proof counters or claiming mission-scoped proof linking.

Captured payload:

```json
{
  "content": "Research Mission `R-20260510-proof-report`\nTitle: Proof report bridge\nStatus: running\nPhase: proof review\nOwner: @​operator\nThread: #research-runs / proof-report\nPlan:\n▶ 1. Review configured proof manifest\nEvidence: 2 items\nClaims: 1 supported, 1 uncertain, 0 challenged\nProof: 0 PASS, 0 WARN\nProof report: warn (configured live-proof manifest (global; mission-scoped linking later))\nProof report counts: 1 complete, 2/0 warn/fail, 3 missing artifact tokens\nNext: none queued.",
  "allowedMentions": {
    "parse": []
  }
}
```

Review notes:

- The first `Proof:` line remains the mission-local proof counter. The
  `Proof report:` lines are the configured global manifest status from
  `/doctor`/`/proof action:status`.
- Reviewer scope check: treat `Proof:` and `Proof report:` as different scopes
  in this example. `Proof:` is mission-local; `Proof report:` is the configured
  global manifest scorecard only.
- No proof file path, raw proof summary, raw correlation id, or live-service
  result is rendered in the mission summary.
- The pin-ready card uses the compact equivalent:
  `Proof: 0 PASS, 0 WARN · Report: warn, 3 missing`. The compact `Report:`
  suffix is the same global proof-report shorthand, not a mission-linked proof
  record.
- This is still not mission-scoped proof linking; that remains a later Proof UX
  slice.

## Example 4 — research subtask card static payload preview

This is a **static payload preview** generated from `renderResearchSubtaskCard`. It helps reviewers inspect the planned Phase 1/Phase 4 subtask operation card from `documents/suggestion.md` §11.2 without a Discord token, gateway call, or operator-owned proof capture.

Captured payload:

```json
{
  "content": "Subtask 3/5: Gap analysis\nStatus: running\nRole: critic\nProvider: codex\nStarted: 2026-05-09T14:00:00.000Z\nRecent events:\n- source compared: OpenClaw subagents\n- claim challenged: \"manual archive is enough\"\n- evidence added: E-007\nActions: [Status] [Steer] [Cancel] [Open history]",
  "allowedMentions": {
    "parse": []
  },
  "components": [
    {
      "kind": "action-row",
      "components": [
        {
          "kind": "button",
          "customId": "research-subtask:status:R-20260509-a1-subtask-03-gap-analysis",
          "label": "Status",
          "style": "secondary"
        },
        {
          "kind": "button",
          "customId": "research-subtask:steer:R-20260509-a1-subtask-03-gap-analysis",
          "label": "Steer",
          "style": "primary"
        },
        {
          "kind": "button",
          "customId": "research-subtask:cancel:R-20260509-a1-subtask-03-gap-analysis",
          "label": "Cancel",
          "style": "danger"
        },
        {
          "kind": "button",
          "customId": "research-subtask:open-history:R-20260509-a1-subtask-03-gap-analysis",
          "label": "Open history",
          "style": "secondary"
        }
      ]
    }
  ]
}
```

Review notes:

- `allowedMentions.parse` stays empty; free-form title/role/provider/event text is sanitized by the same renderer helper used by history surfaces.
- This preview is **not** live Discord proof. It does not demonstrate subtask registry lookup, button delivery, steer/cancel behavior, history routing, permissions, or gateway visibility.
- The button `customId` contract is namespaced as `research-subtask:<verb>:<subtaskId>` for future interaction wiring; renderer-side normalization keeps those custom-id parts parse-safe and within Discord's 100-character limit.
- Dense cards cap visible recent events and action labels in the message body while preserving component rows, so static payloads stay within Discord's 2,000-character message budget.

## Example 4B — research subagent role tree preflight

This static preview captures `/subagents action:tree mission_id:<id>`, the
Phase 4 research-role tree preflight from `documents/suggestion.md` §7. It is
admin-only and read-only: it maps the planner/collector/experimenter/critic/
synthesizer/archivist roles and lists active roster descriptors whose parent
research-plan task id matches
`discord-research-mission-plan-<mission_id>-<numeric-run-suffix>`. It does
**not** spawn, kill, steer, read logs, mutate proof/archive state, write
GitLab, or contact live services.

Captured payload:

```json
{
  "content": "Research subagent tree preflight for `R-20260510-tree`\nStatus: read-only role map; no subagents are spawned, steered, killed, or contacted.\nResearch roles:\n- planner: decompose the research question into reviewable subtasks\n- collector: collect sources, artifacts, and retained evidence candidates\n- experimenter: run bounded repo analysis or tests and report executable evidence\n- critic: challenge claims and surface missing evidence or counterarguments\n- synthesizer: turn supported claims and evidence into a synthesis draft\n- archivist: prepare closeout evidence, proof status, and archive handoff notes\nExpected child output: summary, claims, evidence, uncertainties, recommendedNextSteps.\nActive mission matches:\n- subagent-collector-1 role=collector state=active parent=discord-research-mission-plan-R-20260510-tree-001/parent-inst\nBoundary: tree/role preflight only; no spawn, kill, steer, log read, no proof mutation, no archive mutation, no GitLab write, and no live service contact is performed.",
  "allowedMentions": {
    "parse": []
  }
}
```

Review notes:

- This is a role/tree preflight, not a research subagent spawn or nested-depth
  expansion. `/subagents action:tree` only reads current in-memory roster
  descriptors through the configured operator surface.
- Active matches require the
  `discord-research-mission-plan-<mission_id>-<numeric-run-suffix>` parent-task
  shape, so prefix-colliding or dash-nested mission ids such as `R-1` / `R-10`
  and `R-20260510` / `R-20260510-tree` are not conflated.
- Missing/unknown mission ids use the same mention-safe mission-required /
  mission-not-found paths as other mission-scoped commands.

## Example 4C — research subagent spawn envelope preflight

This static preview captures
`/subagents action:spawn mission_id:<id> role:<role> text:<task>`, the Phase 4
research-role spawn envelope from `documents/suggestion.md` §7. It is
admin-only and intentionally preflight-only: it lets an operator review the
role purpose, depth policy, evidence-return schema, and redaction boundary
before live root-owned subagent spawn wiring exists. It does **not** create a
provider session, spawn a subagent, steer, read logs, mutate proof/archive
state, write GitLab, or contact live services.

Captured payload:

```json
{
  "content": "Research subagent spawn preflight for `R-20260510-spawn`\nStatus: role envelope preview only; no subagent is spawned or contacted.\nRole: collector — collect sources, artifacts, and retained evidence candidates\nTask: OpenClaw subagent UX 근거 정리\nOperator surface: configured (preflight only; live spawn wiring pending).\nDepth policy (informational; no spawn occurs here): depth 1 root-owned only; nested spawn remains disabled by default.\nPlanned child output schema (when later wired): summary, claims[], evidence[], uncertainties[], recommendedNextSteps[].\nEvidence policy: return artifact refs/summaries only; no secrets, raw prompts/responses, or private artifact contents.\nNext: use roster-backed `/research-plan` dispatch for live children today, then `/subagents action:tree mission_id:<id>` to inspect active role state.\nBoundary: spawn preflight only; no provider session, no subagent spawn, no steering, no log read, no proof/archive mutation, no GitLab write, and no live service contact is performed.",
  "allowedMentions": {
    "parse": []
  }
}
```

Review notes:

- This is a spawn **preflight**, not live subagent execution. It records the
  role-specific prompt envelope and child output schema for review.
- The role set is constrained to planner/collector/experimenter/critic/
  synthesizer/archivist. Free-form task text is sanitized and capped before
  rendering; reviewers should confirm there is no raw prompt, raw response,
  mention leak, or private artifact content in the captured body.
- Live execution still flows through roster-backed `/research-plan` dispatch
  today; after a live child exists, `/subagents action:tree mission_id:<id>`
  is the inspection surface.

## Example 5 — research closeout checklist static payload preview

This is a **static payload preview** generated from `renderResearchCloseoutChecklist`. It helps reviewers inspect the planned closeout/archive gate from `documents/suggestion.md` §11.3 without a Discord token, gateway call, GitLab write, proof capture, or operator-owned archive run.

Captured payload:

```json
{
  "content": "Closeout for `R-20260509-a1`\nRequired:\n✓ all subtasks terminal\n✓ synthesis report exists\n✓ evidence ledger retained\n! proof has WARN rows\n! one claim remains uncertain\nRecommended:\n- Run /critique lens:counterargument\n- Capture durable-task-archive proof\n- Record GitLab closeout\nActions: [Archive anyway] [Run missing proof] [Cancel]",
  "allowedMentions": {
    "parse": []
  },
  "components": [
    {
      "kind": "action-row",
      "components": [
        {
          "kind": "button",
          "customId": "research-closeout:archive-anyway:R-20260509-a1",
          "label": "Archive anyway",
          "style": "danger"
        },
        {
          "kind": "button",
          "customId": "research-closeout:run-missing-proof:R-20260509-a1",
          "label": "Run missing proof",
          "style": "primary"
        },
        {
          "kind": "button",
          "customId": "research-closeout:cancel:R-20260509-a1",
          "label": "Cancel",
          "style": "secondary"
        }
      ]
    }
  ]
}
```

Review notes:

- `allowedMentions.parse` stays empty; free-form mission/check/recommendation/action text is sanitized before rendering.
- This preview is **not** live Discord proof. It does not demonstrate archive execution, proof capture, GitLab closeout writes, operator approval, permissions, or gateway visibility.
- The button `customId` contract is namespaced as `research-closeout:<verb>:<missionId>`; the bot adapter now routes supported closeout buttons through existing safe preflight handlers (`archive-anyway` re-renders closeout preflight, `run-missing-proof` opens `/proof action:capture` without a surface, and `cancel` returns to mission show) while renderer-side normalization keeps those custom-id parts parse-safe and within Discord's 100-character limit.
- Dense closeout cards cap visible required checks, recommendations, and action labels in the message body while preserving component rows, so static payloads stay within Discord's 2,000-character message budget.

## Example 5B — `/research action:archive` closeout preflight card

This static preview captures the command-wired closeout preflight path for
`/research action:archive mission_id:<id>`. It renders the same checklist shape
as Example 5, but fills it from current mission state and the configured global
live-proof report. The command remains non-mutating in this slice: it does not
archive the mission, write GitLab closeout records, mutate proof manifests,
capture live proof, or contact live services.

Captured payload:

```json
{
  "content": "Closeout preflight for `R-20260510-cmd`\nRequired:\n✓ research plan approved (closeout-plan)\n✓ synthesis report exists (S-20260510-cmd)\n✓ evidence ledger retained (1 item)\n✓ claims resolved\n! proof report warn: 1 complete, 2/0 warn/fail, 3 missing artifact tokens\nRecommended:\n- Run /proof action:status and capture missing live-proof artifacts\n- Record GitLab closeout after operator approval/proof is ready\nActions: [Archive anyway] [Run missing proof] [Cancel]",
  "allowedMentions": {
    "parse": []
  },
  "components": [
    {
      "kind": "action-row",
      "components": [
        {
          "kind": "button",
          "customId": "research-closeout:archive-anyway:R-20260510-cmd",
          "label": "Archive anyway",
          "style": "danger"
        },
        {
          "kind": "button",
          "customId": "research-closeout:run-missing-proof:R-20260510-cmd",
          "label": "Run missing proof",
          "style": "primary"
        },
        {
          "kind": "button",
          "customId": "research-closeout:cancel:R-20260510-cmd",
          "label": "Cancel",
          "style": "secondary"
        }
      ]
    }
  ]
}
```

Review notes:

- The proof line is sourced from the configured global live-proof report status,
  not a mission-linked proof record. No proof file path or raw manifest content
  is rendered.
- `Archive anyway` is a future interaction hook in this slice. The command only
  renders the preflight checklist and does not perform mission archive mutation.
- Missing synthesis, missing retained evidence, unresolved claims, and missing
  proof are surfaced as warning checklist rows before any later archive
  execution slice.

## Example 5C — `/doctor mission_id:<id>` mission quality diagnostics

This static preview captures the first mission-scoped doctor path:
`/doctor mission_id:<id>`. The command remains administrator-only and
non-mutating. When `mission_id` is present, `/doctor` renders a compact research
quality diagnostic from the existing mission store plus configured global
live-proof report status. It does not read or write proof files, contact live
services, write GitLab, execute critique, or mutate mission/archive state.

Captured payload:

```json
{
  "content": "Research Mission Doctor `R-20260510-cmd`\nTitle: mission doctor research integrity\nStatus: synthesizing · Phase: claim/evidence synthesis\nOwner: @​operator\nThread: research-runs\nRuntime:\n✓ provider: codex (scope: multi-provider)\n! mission thread: current channel only\nResearch integrity:\n✓ plan approved: plan-20260510-cmd\n✓ synthesis: S-20260510-cmd\n✓ evidence retained: 1 item\n! claims unresolved: 1 uncertain, 0 challenged\nProof:\n! global proof report warn: 1 complete, 1/0 warn/fail, 2 missing artifact tokens\nMission-local proof: 0 PASS, 0 WARN, 0 FAIL\nRecommended next action: /critique mission_id:R-20260510-cmd lens:counterargument\nBoundary: read-only mission doctor; no proof files are read or written here, no GitLab write or live service contact occurs, and mission state is not mutated.",
  "allowedMentions": {
    "parse": []
  }
}
```

Review notes:

- This is mission quality diagnostics, not archive execution and not a live
  proof capture. The proof row is a redacted global live-proof report summary
  until a later mission-scoped proof-linking slice exists.
- The handler reads mission state and configured doctor status only. Tests pin
  that no new `research.*` mission-mutation ledger event is appended by this
  `/doctor mission_id` path.
- The recommendation is derived from current mission gaps: approval/evidence/
  synthesis gaps are prioritized first, then unresolved claims, then proof
  status, then archive preflight.

## Example 6 — confirmation escalates the original instruction

Operator input after Example 2, within TTL:

```text
<@bot> 진행
```

Expected delivery sequence:

1. Handler consumes the active hint.
2. Handler sends the short escalation acknowledgement below.
3. Handler dispatches the **original** instruction (`메르센 소수를 출력`) through the normal task lifecycle.
4. UX-26H invariant: this path has exactly one `deferReply()` for the interaction. The shared dispatcher is entered with `deferReply:false` because the confirmation branch already deferred.

Captured acknowledgement payload:

```json
{
  "content": "🚀 Task로 dispatch 합니다: \"메르센 소수를 출력\"\n진행 상황은 이 채널과 자동 생성될 thread에서 in-place로 업데이트됩니다.",
  "allowedMentions": {
    "parse": []
  }
}
```

Review notes:

- In a real Discord interaction this acknowledgement can be followed by later `editReply` updates on the same interaction message (accepted/running/terminal). That is intentional: the source channel keeps one evolving message while the per-task thread, when available, receives the progressive history.
- `tests/discord-mention-chat-routing.spec.ts` pins this path to exactly one defer and verifies the task record contains the original instruction.
- The same test file also pins task-explicit and slash command paths to one default dispatcher-owned defer, so the `deferReply:false` opt-out remains scoped to the already-deferred confirmation path.

## Example 7 — task lifecycle message chain

The shared task path uses in-place edits for the source-channel task message. With a thread-capable reply handle, the same payloads are also mirrored into the per-task thread.

### Accepted

```json
{
  "content": "Accepted task `discord-task-review-001`.\nStatus: accepted\nUse `/status task_id:discord-task-review-001` to check progress."
}
```

### Running

```json
{
  "content": "Task `discord-task-review-001` is running.\nLifecycle: runtime-running"
}
```

### Terminal success

```json
{
  "content": "Task `discord-task-review-001` finished with `success`.\nReason: ok\nProvenance: ui-capture-fixture\nArtifact: results/task-artifacts/discord-task-review-001"
}
```

Review notes:

- The source-channel behavior is a single evolving message (`editReply`) rather than separate lifecycle follow-ups.
- The task thread behavior is fail-open: if thread creation or thread send fails, channel delivery continues.

## Example 8 — retained ledger shape for message-shape review

A reviewer can validate the in-place edit shape from retained control-plane events without a bot token. A minimal static ledger excerpt looks like this:

```jsonl
{"type":"task.delivery_observed","taskId":"discord-task-review-001","timestamp":"2026-05-09T14:00:00.000Z","payload":{"operation":"editReply","eventType":"ask-accepted","messageId":"m-review-1"}}
{"type":"task.delivery_observed","taskId":"discord-task-review-001","timestamp":"2026-05-09T14:00:02.000Z","payload":{"operation":"editReply","eventType":"running-update","messageId":"m-review-1"}}
{"type":"task.delivery_observed","taskId":"discord-task-review-001","timestamp":"2026-05-09T14:00:10.000Z","payload":{"operation":"editReply","eventType":"terminal-result","messageId":"m-review-1"}}
```

Expected local review command (the fixture below was smoke-tested with this task id):

```bash
node scripts/check-task-message-shape.mjs discord-task-review-001 --ledger <path-to-jsonl>
```

Expected interpretation:

- PASS when two or more `editReply` observations for the task land on one distinct `messageId`.
- This is static retained-ledger evidence only. It does not contact Discord and does not prove gateway delivery, thread visibility, permissions, or operator acceptance.

## Reviewer checklist

- Confirm Examples 1–2 match the desired chat-by-default and task-escalation hint copy.
- Confirm Example 3 matches the proposed Research Mission Summary screen, includes mission-scoped subagent role state without implying live spawn, and preserves the static-preview/live-proof boundary.
- Confirm Example 3 mission buttons are covered by `tests/discord-button-adapter.spec.ts` and do not introduce a new mutation path outside existing slash handlers.
- Confirm Example 3A matches the `/research action:new` store-created draft mission handoff screen and current-channel binding fallback.
- Confirm Example 3B matches the `/research action:pin` pin-ready status card and does not claim live pinned-message proof.
- Confirm Example 3C matches the configured-plan unavailable approval screen, including path redaction and mention safety.
- Confirm Example 3D matches the validated approval → research-plan accepted handoff and preserves the static/live boundary.
- Confirm Example 3E matches the operator-supplied evidence/claim ledger surfaces and does not imply automatic TerminalEvidence extraction yet.
- Confirm Example 3F matches the approved research-plan sub-task → mission evidence candidate bridge and excludes synthesis from sub-task evidence counts.
- Confirm Example 3G matches the `/research action:synthesize` claim/evidence synthesis draft and does not imply live LLM generation or final research proof.
- Confirm Example 3H matches the `/proof action:status` mission-local counter + redacted scorecard bridge and does not imply live proof capture/export or proof-artifact linking yet.
- Confirm Example 3M matches the `/proof action:start surface:<surface>` operator-start preflight card and does not imply a spawned proof process, file/manifest mutation, live contact, or mission-scoped proof linking.
- Confirm Example 3I matches the `/proof action:export surface:<surface>` manifest skeleton bridge and keeps the exported template WARN/non-promoting until an operator replaces it with real redacted proof.
- Confirm Example 3L matches the `/proof action:capture surface:<surface>` operator preflight card and does not imply Discord captured live proof or mutated a manifest.
- Confirm Example 3J shows the configured live-proof report status inside the mission summary without replacing mission-local proof counts or implying mission-scoped proof linking.
- Confirm Example 3K matches the `/critique mission_id:<id> lens:<...>` preflight card and does not imply an external critic has executed.
- Confirm Example 4 matches the proposed Research Subtask Card screen and preserves the static-preview/live-proof boundary.
- Confirm Example 4B matches the `/subagents action:tree mission_id:<id>` role/tree preflight and does not imply subagent spawn, steering, log read, proof/archive mutation, GitLab write, or live contact.
- Confirm Example 4C matches the `/subagents action:spawn mission_id:<id> role:<role> text:<task>` role envelope preflight and does not imply provider-session creation, live subagent spawn, steering, log read, proof/archive mutation, GitLab write, or live contact; also confirm it contains no raw prompt/response, mention leak, or private artifact content.
- Confirm Example 5 matches the proposed Research Closeout Checklist screen and preserves the static-preview/live-proof boundary.
- Confirm Example 5 closeout buttons are covered by `tests/discord-button-adapter.spec.ts`; `Archive anyway` remains a preflight route, not a real archive mutation.
- Confirm Example 5B matches the `/research action:archive` closeout preflight card and does not imply mission archive/GitLab/proof mutation.
- Confirm Example 5C matches the `/doctor mission_id:<id>` mission quality diagnostics card and does not imply proof file reads, live contact, or mission mutation.
- Confirm Example 6's acknowledgement being overwritten by later in-place lifecycle updates is acceptable for the source channel.
- Confirm Examples 7–8 preserve the live/static boundary: retained message-shape evidence is useful for review but does not replace an operator-owned live Discord run.
- Before release, resolve the ambient `resource/templestay` gitlink state intentionally (commit or revert) so it does not ride along accidentally.
