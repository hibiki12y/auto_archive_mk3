---
status: current
authority: implementation-explanation
last_verified: 2026-05-10
source_paths:
  - README.md
  - src/discord/
  - src/core/
scope: 현재의 지속형 Discord 컨트롤 플레인 동작과 그 실행 경계.
---

# Discord 컨트롤 플레인 — Always-On

## 경계 결정

"Always-on"은 지속형 대화/태스크 원장을 갖춘 장수 Discord/Arona 컨트롤 플레인을
의미한다. 이는 장수 컴퓨트 세션, 워밍 풀, 태스크 런타임 세션 재사용, 영구 GPU
예약을 의미하지 **않는다**. 연구 실행은 여전히 태스크에 묶여 있다. 즉, 받아들여진
하나의 요청이 Dispatcher 경계로 진입하고, 하나의 컴퓨트 할당/Agent Instance를
받고, 종료 증거(terminal evidence)를 발행한 뒤 자원을 해제한다.

런타임 프로바이더 범위는 현재 bootstrap-time multi-provider seam이다. 기본값은
`AUTO_ARCHIVE_RUNTIME_PROVIDER=codex`이며,
`AUTO_ARCHIVE_RUNTIME_PROVIDER=claude-agent`는 Claude Agent provider를 선택한다.
이 동반 문서는 mid-flight provider switching, runtime fan-out/council execution,
프로바이더로서의 Copilot CLI, OpenClaw 런타임 채택을 정의하거나 승인하지
않는다. 세부 인증·비용·감사 invariant의 정본은
`../CLARIFICATIONS/multi-provider-scope.md`이다.

## 구현된 v1 슬라이스

- `ControlPlaneLedgerPort`는 기본적으로
  `runtime-state/research-control-events.jsonl` 위치에 append-only JSONL
  컨트롤 이벤트를 기록한다. 본 컨트롤 원장 JSONL의 schemaVersion은 `1`로 고정되며,
  schema 변경은 SemVer minor bump 이상으로 반영한다(C1 Wave 1 freeze 후보).
- `DiscordTaskRegistry`는 원장 이벤트를 리플레이할 수 있어 서비스 재시작 후에도
  최근 태스크 상태가 보존된다.
- Discord command registry의 현재 등록 command set: `/ask`, `/research`,
  `/evidence`, `/claim`, `/critique`, `/proof`, `/status`, `/cancel`, `/rerun`, `/tasks`, `/traits`, `/archive`, `/unarchive`,
  `/agenda`, `/history`, `/context`, `/escalate`, `/feed`, `/approve`, `/deny`, `/doctor`,
  `/subagents`, `/focus`, `/unfocus`, `/auth`, `/insights`, `/config`, `/research-plan`, `/help`, `/quickstart`, `/follow`.
  `/traits`는 TraitModule manifest metadata를 read-only로 나열하며
  install/enable/external registry fetch를 수행하지 않는다. `/archive`는
  replay-backed task registry에 terminal task에 대해 `task.archived`
  이벤트를 남기고 기본 `/tasks` 목록에서 숨기며, `/tasks archived`로
  재조회할 수 있다. `/unarchive`는 같은 replay-backed registry에
  `task.unarchived` 이벤트를 남기고 archived 상태를 해제해 기본 `/tasks`
  목록에 다시 노출한다. `/rerun`은 terminal task의 원 요청 지시를 fresh task로
  다시 제출하되 기존 managed artifact root를 재사용하지 않는다. `/cancel`,
  `/rerun`, `/archive`, `/unarchive`는 tracked task owner 또는 configured
  Discord admin만 적용할 수 있다. `/archive`는 active task 숨김에는 사용하지
  않는다. `/history view:talk` slash option과 slash-text `/history --talk`은
  observed Discord message ledger에서 sanitized read-only channel talk
  history를 보여주며, raw mention ping과 backtick formatting은 neutralize한다.
  `/escalate`는 Discord-only operator escalation request로
  `escalation.requested` ledger event를 남기며 task state는 변경하지 않고
  ACP surface에는 노출하지 않는다. 응답은 no-mention sanitized text이고,
  ledger payload의 `reason`은 길이 제한된 untrusted audit field이므로 이를
  표시하는 downstream viewer는 별도 sanitization을 적용해야 한다.
  `/feed`는 Discord-only bounded control-plane live tail이며 `loadSince`
  기반으로 최근 이벤트를 읽고 task/escalation/approval/all kind filter,
  50-event output cap, 1분 최소 since window, user별 2/min handler rate-limit,
  no-mention sanitized rendering을 적용한다. 큰 JSONL ledger는 Discord 응답에서
  fail-fast로 안내하며 ACP surface에는 노출하지 않는다.
  `/follow`는 Discord-only single-task live tail로 `task_id` 인자를 받아
  `loadSince` poll을 등록한다 (DiscordFollowController). 한 taskId당 한 구독,
  user별 기본 cap=3, 14분 idle timeout, `task.terminal` 이벤트 시 자동
  unsubscribe. 구독은 followUp으로 `📡` 배치/`✅⛔` terminal/`⏸️` idle 메시지를
  보내며 ACP surface에는 노출하지 않는다.
  `/proof action:status`는 Discord-only admin proof status bridge로,
  `mission_id`가 tracked Research Mission이면 mission-local proof counter를
  함께 보여주고 unknown `mission_id` 값은 sanitized header context only로 남긴다.
  configured live-proof manifest scorecard를 병렬로 보여주되 raw proof
  summaries/correlation ids를 렌더링하지 않고 proof files mutation이나 live service
  contact를 수행하지 않는다. proof artifact와 mission-local counter의 durable
  linking은 별도 후속 slice로 남는다.
  `/proof action:start surface:<surface>`는 한 live-proof matrix surface에 대한
  operator start preflight를 렌더링한다. checklist 확인, template export,
  capture 준비, `live:proof:report` scoring 순서를 Discord 안에서 안내하지만
  proof process spawn, proof file read/write, manifest mutation, live service
  contact, mission proof linking은 수행하지 않는다.
  `/proof action:export surface:<surface>`는 한 live-proof matrix surface에 대한
  `live:proof:report` 호환 manifest skeleton을 Discord에 inline export하되
  template-only WARN으로 남기며 proof 파일을 읽거나 쓰지 않는다.
  `/proof action:capture surface:<surface>`는 한 live-proof matrix surface에 대한
  operator capture preflight를 렌더링한다. operator가 외부에서 redacted proof
  artifact를 수집하고 `live:proof:report`로 template/scorecard를 갱신하는 절차만
  안내하며, Discord 핸들러는 proof 파일 read/write, manifest mutation, live service
  contact, mission proof linking을 수행하지 않는다.
  `/research action:pause|resume|complete`는 mission lifecycle label을
  `research.mission_status_updated` control-plane event로만 갱신한다. pause는
  `blocked`, resume은 `running`, complete는 `completed` 상태를 기록하며 provider
  dispatch, proof/archive/GitLab mutation, live service contact를 수행하지 않는다.
  해당 lifecycle label 변경은 mission owner 또는 configured Discord admin만 수행할
  수 있으며 denial 응답은 owner id를 노출하지 않는다. `/research
  action:show|status|pin`은 read-only mission inspection으로 남아 mission
  owner/admin gate를 적용하지 않는다.
  `/critique mission_id:<id> lens:<...>`는 methodology/evidence/counterargument/
  reproducibility lens에 대한 read-only critique preflight를 렌더링한다. 현재
  slice에서는 mission evidence/claim/synthesis 상태와 lens-specific warning만
  보여주며 외부 critic 호출, evidence/claim/proof/archive mutation, GitLab write는
  수행하지 않는다.
  `/doctor mission_id:<id>`는 service readiness `/doctor`의 mission-scoped
  진단 카드로, plan approval, synthesis, retained evidence, unresolved claims,
  thread binding, configured global proof-report status를 읽어 연구 품질 warning과
  recommended next action을 보여준다. 이 경로는 proof file read/write, GitLab write,
  live service contact, mission/archive mutation을 수행하지 않는다.
  Configured live-proof report status는 `/research action:show|status|pin`
  mission summary에도 global proof-report note로 표시된다. `/proof action:status
  mission_id:<id>`는 tracked mission의 mission-local proof counter를 함께
  보여주지만, proof artifact와 mission-local counter의 durable linking은 별도
  후속 slice로 남긴다.
  `/research action:archive`는 mission archive 실행 전 closeout preflight
  checklist를 렌더링한다. 현재 slice에서는 plan approval, synthesis,
  retained evidence, unresolved claims, configured live-proof report 상태를
  점검하지만 mission archive mutation, GitLab write, proof manifest mutation,
  live service contact는 수행하지 않는다.
  Mission summary와 closeout checklist의 `research-mission:*` /
  `research-closeout:*` 버튼은 Discord button interaction adapter를 통해 기존
  slash-command handler로만 라우팅된다. 따라서 버튼은 `/research`, `/evidence`,
  `/critique`, `/proof action:capture`의 동일한 권한/검증/경계 조건을 재사용하며,
  별도 archive/proof mutation fast path를 만들지 않는다.
  `/subagents action:tree mission_id:<id>`는 suggestion.md의 연구 역할 기반
  subagent UX를 Discord admin surface에 read-only preflight로 노출한다.
  planner/collector/experimenter/critic/synthesizer/archivist 역할 map과,
  `discord-research-mission-plan-<mission_id>-<numeric-run-suffix>` parent-task
  형식에 정확히 연결된 active descriptor만 보여주며
  spawn/kill/steer/log read/proof/archive/GitLab/live-contact 경로는
  실행하지 않는다.
  `/subagents action:spawn mission_id:<id> role:<...> text:<task>`는 같은
  연구 역할 기반 UX의 spawn envelope preflight이다. role별 목적, depth-1
  root-owned policy, evidence/claim/uncertainty 반환 schema, redaction boundary를
  Discord에서 확인하게 하지만 provider session 생성, 실제 subagent spawn,
  log read, proof/archive/GitLab/live-contact 경로는 실행하지 않는다.
  `/research action:show|status|pin` mission summary는 subagent operator roster가
  wired된 경우 같은 parent-task match 규칙으로 mission-scoped role-state counts를
  read-only로 함께 표시한다. 이 summary line은 live spawn 실행, log read, steering,
  proof/archive/GitLab mutation을 의미하지 않는다.
  unknown proof action은 명시적인 not-implemented 응답을 반환한다.
  `/help`와 Discord command registry description은 이 task-mutating
  owner/admin 경계와 read-only inspection 경계를 함께 노출한다.
  Discord command registry는 structured `permissionClass` metadata도 함께
  보유해 새 command가 추가될 때 owner/admin, admin-only, owner-focus,
  escalation, read-only, research-state, dispatch, help 분류 drift를 테스트로
  차단한다.
- `DiscordInstructionEnvelope`은 현재 태스크 지시를 신뢰할 수 없는 컨텍스트
  이력과 분리해 보존한다.
- `DiscordAccessPolicy`는 fail-closed 길드/DM/봇 검사와 서비스 모드용 선택적
  사용자/채널/관리자 허용목록을 제공한다.

## 신뢰·안전 불변식

- Discord 메시지 이력은 신뢰할 수 없는 입력이며 컨텍스트로만 주입될 수 있다.
  실행 가능한 지시는 `currentInstruction`이다.
- 멘션 모드의 접두 전용 자연어 메시지는 컨텍스트 전용으로 유지된다.
- 본 슬라이스는 원시 Discord 컨텍스트를 연구 메모리로 승격하지 않는다.
- Plana는 정책 평가자로 남고, Arona는 사용자 응대 조정을, Dispatcher는
  제출/취소 경계를 소유한다.
- 승인 명령은 컨트롤 원장에 운영자 결정을 기록한다. 런타임 승인 포트로의
  전달은 후속 통합 게이트로 남아 있다.

## 검증 게이트

- 단위 테스트는 JSONL 리플레이/잘린 라인 처리, 태스크 레지스트리 리플레이,
  디스패치 이전 접근 거부, 제한된 history/context/task 뷰, 서비스 부트스트랩
  환경 변수 파싱을 반드시 다루어야 한다.
- 결정적 점검: `pnpm typecheck`, 집중된 Discord/컨트롤 플레인 테스트, 그 다음
  릴리스 전에 `pnpm test`.
- 라이브 평가는 Discord GUI 변경에 대해 Peekaboo 직접 제어 MCP 경로를 사용해야
  한다. Discord REST는 관찰/증거 전용으로 남는다.
