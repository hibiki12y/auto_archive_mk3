좋습니다. 전제는 이렇게 수정하는 게 맞습니다.

**Auto Archive Mk3의 목표는 Hermes/OpenClaw식 “범용 멀티채널 개인 비서”를 따라가는 것이 아니라, Discord를 연구 운영실처럼 쓰는 연구 특화 하네스가 되는 것**입니다. 따라서 UI/UX 개선 방향도 “다채널 확장”이 아니라 **Discord 안에서 연구 계획, 실행, 검증, 증거 축적, 아카이브가 끊기지 않는 경험**으로 잡아야 합니다.

아래는 그 전제에 맞춘 재구상안입니다.

---

# Discord 최적화 연구 하네스 UX 개선 계획

## 1. 제품 방향 재정의

기존 Hermes/OpenClaw와의 비교 기준을 “기능 수 parity”로 잡으면 Auto Archive Mk3의 방향이 흐려집니다. Hermes는 TUI, gateway, multi-provider, memory, skills, cron, terminal backend를 폭넓게 제공하고, OpenClaw는 multi-channel Gateway, subagents, ACP, thread binding, auto-archive 등을 강하게 밀고 있습니다. 

하지만 Auto Archive Mk3는 이미 README에서 Discord first-slice integration, always-on Discord research control-plane, `/ask`, `/research`, `/status`, `/cancel`, `/rerun`, `/tasks`, `/archive`, `/unarchive`, `/agenda`, `/history`, `/context`, `/feed`, `/doctor`, `/subagents`, `/focus`, `/research-plan` 등을 구현 표면으로 갖고 있습니다. 또한 command registry도 실제로 Discord slash command 중심으로 구성되어 있습니다.

따라서 목표는 다음처럼 잡는 것이 좋습니다.

> **Discord 기반 연구 운영 하네스**
> 연구자가 Discord 채널/스레드 안에서 연구 목표를 만들고, 계획을 승인하고, sub-task를 실행하고, 중간 증거를 보고, 실패를 복구하고, 최종 산출물과 live proof를 아카이브하는 시스템.

이렇게 하면 Hermes/OpenClaw보다 연구활동에 강한 차별점이 생깁니다.

---

## 2. 기존 하네스가 연구활동에 약한 지점

Hermes와 OpenClaw는 범용 agent harness로서는 강하지만, 연구활동 UX 관점에서는 다음 한계가 있습니다.

첫째, **연구 목표가 task 단위로 흩어지기 쉽습니다.**
긴 연구는 “질문 → 하위 질문 → 실험/검증 → 반박 → 종합 → 후속 연구” 흐름을 갖는데, 일반 하네스는 보통 단일 turn, background task, subagent run, cron job 단위로 관리합니다.

둘째, **증거와 판단의 provenance가 약합니다.**
연구에서는 “왜 이 결론을 냈는지”, “어떤 artifact를 봤는지”, “어떤 가정이 실패했는지”, “어떤 검증이 operator-approved인지”가 중요합니다. Auto Archive Mk3의 live-proof matrix와 retained evidence CLI는 이 방향에 이미 강점이 있습니다. 다만 현재는 operator-gated static proof가 많아 UX로는 무겁습니다.

셋째, **장기 연구의 상태 관리가 약합니다.**
OpenClaw subagents는 spawn/list/kill/log/info/steer, thread binding, auto-archive, nested depth 같은 운영 UX가 좋습니다. 그러나 “연구 agenda”, “가설”, “실험”, “반박”, “synthesis” 같은 연구 개념이 1급 객체는 아닙니다.

Auto Archive Mk3는 이 약점을 보완하는 방향으로 가야 합니다.

---

# 3. 핵심 UX 컨셉: Discord Research War Room

Auto Archive Mk3는 Discord를 단순 채팅창이 아니라 **연구 작전실**로 써야 합니다.

## 3.1 채널 구조

권장 구조는 다음과 같습니다.

```text
#research-control
  운영자 명령, /doctor, /proof, /agenda, /config

#research-runs
  연구 run 시작 알림, plan 승인, 진행 요약

#research-archive
  완료된 연구 산출물, GitLab/파일 artifact 링크, proof summary

Thread per research task
  각 연구 task의 세부 진행, subtask, evidence, critique, synthesis
```

Discord Forum Channel을 사용할 수 있다면, 각 연구 목표를 forum post 하나로 만드는 것이 좋습니다.

```text
Forum post: [R-20260509-a1] Auto Archive UX 개선 연구
  - Plan
  - Subtasks
  - Evidence
  - Critique
  - Synthesis
  - Archive/proof status
```

이 구조는 multi-channel 확장이 아니라 **Discord 내부의 channel/thread affordance를 최대한 활용하는 전략**입니다.

---

# 4. 연구 특화 1급 객체 설계

기존 task 중심 구조를 유지하되, 연구활동을 위해 다음 객체를 추가하는 것이 좋습니다.

## 4.1 Research Mission

가장 큰 단위입니다.

```ts
ResearchMission {
  missionId
  title
  goal
  ownerId
  discordChannelId
  discordThreadId
  status: draft | approved | running | blocked | synthesizing | completed | archived
  planId
  agendaLinks
  evidenceSummary
  proofStatus
  createdAt
  updatedAt
}
```

Discord 명령:

```text
/research new goal:<text>
/research show mission_id:<id>
/research approve mission_id:<id>
/research pause mission_id:<id>
/research resume mission_id:<id>
/research complete mission_id:<id>
/research archive mission_id:<id>
```

## 4.2 Research Plan

기존 `/research-plan`과 CLI plan runner를 Discord-first UX로 감싸는 객체입니다.

현재 README에는 `pnpm research:plan:run <plan.json>`과 `/research-plan plan-id`가 설명되어 있습니다. 이걸 advanced/manual mode로 두고, 일반 UX는 `/research new`에서 plan draft를 자동 생성하게 합니다.

```text
/research new goal:"OpenClaw/Hermes 대비 Auto Archive 연구 UX 개선"
```

응답:

```text
Research mission draft created: R-20260509-a1

Plan draft:
1. Baseline comparison
2. Auto Archive current state audit
3. Research workflow gap analysis
4. Discord-first UX proposal
5. Implementation roadmap
6. Risk/proof matrix

Actions:
[Approve plan] [Edit plan] [Split more] [Cancel]
```

Discord button 기반 승인이 핵심입니다. Slash command만으로 UX를 만들면 연구 계획 승인 흐름이 딱딱해집니다.

## 4.3 Evidence Item

연구활동의 차별점은 evidence입니다.

```ts
EvidenceItem {
  evidenceId
  missionId
  taskId?
  kind: source | experiment | terminal | critique | proof | artifact | operator-note
  summary
  artifactRef
  redactionStatus
  confidence
  createdAt
}
```

Discord 명령:

```text
/evidence add mission_id:<id> note:<text>
/evidence list mission_id:<id>
/evidence show evidence_id:<id>
/evidence promote evidence_id:<id>
```

Auto Archive Mk3의 기존 retained evidence/report 철학을 Discord UX로 끌어올리는 기능입니다.

## 4.4 Claim / Hypothesis

연구는 결과보다 중간 주장 관리가 중요합니다.

```ts
ResearchClaim {
  claimId
  missionId
  text
  status: proposed | supported | contradicted | uncertain | accepted | rejected
  evidenceIds[]
  critiqueIds[]
}
```

Discord 명령:

```text
/claim add mission_id:<id> text:<claim>
/claim support claim_id:<id> evidence_id:<id>
/claim challenge claim_id:<id> reason:<text>
/claim list mission_id:<id>
```

이 기능이 생기면 기존 하네스와 다르게 “연구 판단 구조”를 보존할 수 있습니다.

---

# 5. Discord 명령 체계 재설계

현재 명령은 이미 많습니다. 문제는 research workflow 기준으로 묶여 있지 않다는 점입니다.

## 5.1 기존 명령 유지

기존 명령은 유지합니다.

```text
/ask
/research
/status
/cancel
/rerun
/archive
/unarchive
/tasks
/agenda
/history
/context
/feed
/doctor
/subagents
/focus
/unfocus
/research-plan
/help
```

## 5.2 연구 특화 명령 추가 또는 재구성

새 UX에서는 `/research`를 단순 dispatch가 아니라 mission controller로 승격합니다.

```text
/research new goal:<text>
/research plan mission_id:<id>
/research approve mission_id:<id>
/research run mission_id:<id>
/research status mission_id:<id>
/research synthesize mission_id:<id>
/research archive mission_id:<id>
```

`/research-plan`은 내부적으로 유지하되, operator-facing primary command는 `/research`가 되는 편이 좋습니다.

## 5.3 `/proof` 추가

현재 live-proof matrix는 좋은데, UX가 파일/CLI 중심입니다. 이를 Discord로 끌어와야 합니다.

```text
/proof status mission_id:<id>
/proof start mission_id:<id> surface:<surface>
/proof capture mission_id:<id>
/proof export mission_id:<id>
/proof doctor mission_id:<id>
```

예시 출력:

```text
Proof status for R-20260509-a1

PASS
- research-plan-approved
- terminal-evidence-retained
- synthesis-artifact-written

WARN
- operator-review-missing
- archive-unarchive-cycle-missing

Next actions:
1. /archive task_id:discord-task-a1b2
2. /proof capture mission_id:R-20260509-a1 surface:durable-task-archive-ux
```

## 5.4 `/review` 또는 `/critique` 추가

연구 하네스라면 critique가 1급 UX여야 합니다.

```text
/critique mission_id:<id> lens:methodology
/critique mission_id:<id> lens:evidence
/critique mission_id:<id> lens:counterargument
/critique mission_id:<id> lens:reproducibility
```

이 기능은 Auto Archive Mk3의 Plana/advisor, methodology TraitModule, retained evidence와 잘 맞습니다.

---

# 6. Discord UI 컴포넌트 적극 활용

Slash command만으로는 연구 UX가 충분히 좋아지지 않습니다. Discord에 최적화하려면 다음 컴포넌트를 적극 써야 합니다.

## 6.1 Buttons

연구 계획과 승인 흐름에 버튼을 씁니다.

```text
[Approve Plan] [Request Revision] [Run First Subtask] [Pause]
```

특히 approval/deny는 이미 Auto Archive에 `/approve`, `/deny` 표면이 있으므로 버튼과 연결하기 좋습니다.

## 6.2 Select Menus

Mission, subtask, evidence, proof surface 선택에 select menu를 씁니다.

```text
Select evidence to attach to this claim:
- E-001 Hermes README
- E-002 OpenClaw subagents docs
- E-003 Auto Archive live-proof matrix
```

## 6.3 Threads

각 mission마다 thread를 만들고, subtask별 thread 또는 message anchor를 둡니다.

```text
R-20260509-a1 main thread
  ↳ subtask-1 baseline comparison
  ↳ subtask-2 current implementation audit
  ↳ subtask-3 synthesis
```

기존 `/focus`와 session binding UX를 연구 mission thread에 결합해야 합니다. Auto Archive에는 `/focus`, `/unfocus`, session binding evidence surface가 이미 있습니다.

## 6.4 Pinned Summary Message

각 mission thread의 첫 메시지를 지속적으로 업데이트합니다.

```text
Mission: Auto Archive UX 개선
Status: running
Current phase: evidence synthesis
Subtasks: 4/6 complete
Claims: 7 proposed, 4 supported, 1 contradicted
Proof: 3 pass, 2 warn
Next action: /critique mission_id:R-20260509-a1 lens:evidence
```

이 하나만 있어도 Discord UX가 크게 좋아집니다.

---

# 7. 연구 특화 Subagent 전략

OpenClaw의 subagents UX는 강합니다. `/subagents spawn`, thread binding, context isolated/fork, model override, timeout, nested depth, cascade stop 등이 잘 정리되어 있습니다. 하지만 연구활동에서는 그냥 subagent를 많이 띄우는 것보다 **역할이 분명한 연구 subagent**가 중요합니다.

Auto Archive Mk3는 다음처럼 연구 역할 기반 subagent를 설계하는 편이 좋습니다.

## 7.1 Research Subagent Roles

```text
planner
  연구 질문을 하위 질문으로 분해

collector
  근거/source/artifact 수집

experimenter
  코드 실행, repo 분석, 테스트 실행

critic
  주장 반박, 누락된 근거 탐지

synthesizer
  최종 보고서 작성

archivist
  evidence/proof/archive 정리
```

명령 예시:

```text
/subagents spawn role:collector mission_id:R-... task:"OpenClaw subagent UX 근거 정리"
/subagents spawn role:critic mission_id:R-... task:"현재 개선안의 약점 반박"
/subagents tree mission_id:R-...
```

## 7.2 연구용 subagent는 “결과”보다 “증거”를 반환해야 함

기존 하네스 subagent는 보통 summary/result를 반환합니다. 연구 하네스에서는 반환 형식을 강제하는 것이 좋습니다.

```json
{
  "summary": "...",
  "claims": ["..."],
  "evidence": [
    {
      "kind": "source",
      "summary": "...",
      "artifactRef": "..."
    }
  ],
  "uncertainties": ["..."],
  "recommendedNextSteps": ["..."]
}
```

이렇게 해야 synthesis 단계에서 근거 기반으로 종합할 수 있습니다.

## 7.3 Depth는 보수적으로 유지

현재 Auto Archive의 OpenClaw gap 문서는 depth-1 root-owned policy를 유지하고, depth-2 nested spawn은 비활성이라고 정리합니다. 연구 UX를 강화하더라도 처음부터 nested depth를 넓히면 관리가 어려워집니다.

권장:

```text
기본: depth 1
고급 연구 모드: depth 2 opt-in
모든 child는 missionId, role, evidence policy 필수
```

---

# 8. Archive UX는 “정리”가 아니라 “연구 closeout”으로 설계

Auto Archive라는 이름을 살리려면 archive는 단순 task 숨김이 아니라 연구 closeout이어야 합니다.

## 8.1 Mission Archive

```text
/research archive mission_id:R-...
```

실행 시 자동으로:

1. 모든 task 상태 확인
2. terminal evidence 확인
3. synthesis report 확인
4. unresolved claim 확인
5. proof status 확인
6. GitLab issue/note 기록
7. Discord pinned summary final update
8. archive ledger 기록

## 8.2 Archive 전 체크리스트

```text
Archive checklist for R-20260509-a1

PASS
✓ synthesis report exists
✓ all subtasks terminal
✓ evidence summary generated
✓ proof manifest generated

WARN
! 2 claims remain uncertain
! no human critique approval
! GitLab closeout not recorded

Actions:
[Archive anyway] [Run critique] [Record GitLab] [Cancel]
```

이 UX는 기존 `/archive`, `/unarchive`, task archive evidence와 연결할 수 있습니다. Auto Archive에는 durable task archive UX와 retained JSONL scorecard가 이미 구현되어 있습니다.

---

# 9. `/doctor`를 연구 운영 중심으로 재편

현재 `/doctor`는 readiness inspection에 강합니다. 앞으로는 연구 운영 관점의 doctor가 필요합니다.

## 9.1 기존 `/doctor`

서비스 readiness, provider evidence, live-proof, task-health, subagent evidence 등은 유지합니다.

## 9.2 Mission-scoped Doctor 추가

```text
/doctor mission_id:R-...
```

출력 예시:

```text
Research Mission Doctor: R-20260509-a1

Runtime
✓ provider: codex
✓ terminal evidence: 6 records
! claude critic: not configured

Research integrity
✓ plan approved
✓ synthesis exists
! 2 claims have no supporting evidence
! no counterargument critique after final synthesis

Discord UX
✓ mission thread bound
✓ pinned summary updated
✓ archive proof captured

Recommended next action:
  /critique mission_id:R-20260509-a1 lens:counterargument
```

이렇게 하면 `/doctor`가 단순 인프라 진단이 아니라 연구 품질 진단 도구가 됩니다.

---

# 10. 구현 로드맵

## Phase 1: Discord Research Mission MVP

목표: 연구 task를 mission 단위로 묶고 Discord thread에 고정.

구현 항목:

```text
/research new
/research show
/research approve
/research status
```

데이터:

```text
ResearchMissionStore
ResearchPlanStore
MissionThreadBinding
PinnedSummaryRenderer
```

완료 기준:

```text
- /research new가 plan draft를 생성한다.
- Discord thread 또는 current channel binding이 생성된다.
- pinned summary가 mission 상태를 보여준다.
- /research approve 후 기존 research-plan orchestrator로 연결된다.
```

## Phase 2: Evidence/Claim UX

목표: 연구 결과를 단순 텍스트가 아니라 evidence와 claim으로 축적.

구현 항목:

```text
/evidence add
/evidence list
/claim add
/claim support
/claim challenge
/claim list
```

완료 기준:

```text
- 각 subtask terminal result에서 evidence candidate를 추출한다.
- operator가 evidence를 claim에 연결할 수 있다.
- synthesis는 claim/evidence 기반으로 작성된다.
```

## Phase 3: Proof UX Discord화

목표: live-proof/report CLI를 Discord UX에 연결.

구현 항목:

```text
/proof status
/proof start
/proof capture
/proof export
```

완료 기준:

```text
- operator가 manifest JSON을 직접 편집하지 않아도 된다.
- proof status가 mission summary에 표시된다.
- 기존 live:proof:report와 호환되는 artifact를 생성한다.
```

## Phase 4: Research Subagent Roles

목표: subagent를 연구 역할 기반으로 운용.

구현 항목:

```text
/subagents spawn role:<planner|collector|experimenter|critic|synthesizer|archivist>
/subagents tree mission_id:<id>
/critique mission_id:<id> lens:<...>
```

완료 기준:

```text
- subagent output이 evidence/claim/uncertainty schema로 반환된다.
- role별 prompt envelope가 다르다.
- mission summary에 subagent role 상태가 표시된다.
```

## Phase 5: Research Closeout Archive

목표: archive를 연구 closeout으로 승격.

구현 항목:

```text
/research archive
/archive policy
/doctor mission_id:<id>
```

완료 기준:

```text
- archive 전 checklist가 표시된다.
- unresolved claim, missing proof, missing synthesis를 경고한다.
- archive 후 Discord summary, GitLab record, proof manifest가 연결된다.
```

---

# 11. 최우선으로 만들 UX 화면

가장 먼저 만들 화면은 이 세 가지입니다.

## 11.1 Mission Summary

```text
Research Mission R-20260509-a1
Title: Auto Archive Mk3 Discord 연구 UX 개선

Status: running
Phase: evidence synthesis
Owner: @operator
Thread: #research-runs / R-20260509-a1

Plan:
✓ 1. Hermes/OpenClaw baseline
✓ 2. Auto Archive current audit
▶ 3. Gap analysis
□ 4. Discord-first proposal
□ 5. Implementation roadmap

Evidence: 9 items
Claims: 6 supported, 2 uncertain, 1 challenged
Proof: 3 PASS, 4 WARN

Next:
[Run critique] [Synthesize] [Show evidence] [Archive]
```

## 11.2 Subtask Card

```text
Subtask 3/5: Gap analysis
Status: running
Role: critic
Provider: codex
Started: 2026-05-09T...

Recent events:
- source compared: OpenClaw subagents
- claim challenged: "manual archive is enough"
- evidence added: E-007

Actions:
[Status] [Steer] [Cancel] [Open history]
```

## 11.3 Closeout Checklist

```text
Closeout for R-20260509-a1

Required:
✓ all subtasks terminal
✓ synthesis report exists
✓ evidence ledger retained
! proof has WARN rows
! one claim remains uncertain

Recommended:
- Run /critique lens:counterargument
- Capture durable-task-archive proof
- Record GitLab closeout

Actions:
[Archive anyway] [Run missing proof] [Cancel]
```

---

# 12. 기존 기능과 연결되는 지점

이 계획은 새로 모든 것을 갈아엎는 방향이 아닙니다. 기존 Auto Archive Mk3 표면을 연구 UX로 재조립하는 방향입니다.

| 기존 기능                    | 연구 UX에서의 역할                         |
| ------------------------ | ----------------------------------- |
| `/research`              | mission 생성/실행 entrypoint            |
| `/research-plan`         | advanced plan runner, 내부 executor   |
| `/agenda`                | 장기 연구 backlog                       |
| `/history`, `/context`   | mission evidence/history inspection |
| `/feed`                  | mission event stream                |
| `/doctor`                | infra + mission quality doctor      |
| `/subagents`             | role-based research workers         |
| `/focus`, `/unfocus`     | mission thread/session binding      |
| `/archive`, `/unarchive` | task-level archive                  |
| live-proof report        | mission proof scorecard             |
| TerminalEvidence         | subtask/research evidence           |
| GitLab recording         | final research artifact publication |

---

# 13. 성공 지표

이 개선은 “기능이 많아졌는가”가 아니라 “연구가 더 잘 굴러가는가”로 평가해야 합니다.

권장 지표:

```text
1. 연구 시작 시간
   goal 입력 후 plan 승인까지 걸리는 시간

2. 중간 상태 파악 시간
   operator가 현재 연구 상태를 이해하는 데 걸리는 시간

3. evidence coverage
   최종 claim 중 evidence가 연결된 비율

4. critique coverage
   synthesis 전 critique lens가 최소 1회 이상 실행된 비율

5. closeout completeness
   archive 시 proof/evidence/synthesis/GitLab 기록이 모두 있는 비율

6. rerun recovery
   실패 task가 /rerun 또는 plan repair로 복구된 비율

7. Discord-only completion
   CLI/파일 직접 편집 없이 Discord 안에서 완료된 mission 비율
```

---

# 14. 최종 권장 방향

다채널 입력을 배제한다면, Auto Archive Mk3의 UX 목표는 더 선명해집니다.

**OpenClaw처럼 모든 채널에서 동작하는 assistant가 아니라, Discord에서 연구를 지휘·검증·보존하는 specialist harness가 되어야 합니다.**

따라서 개선 방향은 다음입니다.

1. `/research`를 단순 task dispatch가 아니라 **Research Mission controller**로 승격
2. Discord thread/forum/pinned message/button/select menu를 활용해 **연구 작전실 UX** 구성
3. subagent를 범용 worker가 아니라 **planner/collector/critic/synthesizer/archivist 역할 기반 연구 worker**로 재설계
4. live proof, TerminalEvidence, archive ledger를 Discord 안에서 볼 수 있는 **research evidence UX**로 통합
5. `/doctor`를 infra readiness뿐 아니라 **mission quality doctor**로 확장
6. archive를 task 숨김이 아니라 **연구 closeout ritual**로 강화

이렇게 가면 Hermes/OpenClaw와 정면으로 “범용 하네스” 경쟁을 하지 않고, Auto Archive Mk3가 원래 만들려는 이유였던 **연구활동에 강한 새 하네스**라는 포지션을 분명하게 가져갈 수 있습니다.
