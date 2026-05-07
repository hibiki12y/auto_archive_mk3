---
status: current
authority: implementation-explanation
last_verified: 2026-05-05
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
  `/status`, `/cancel`, `/rerun`, `/tasks`, `/traits`, `/archive`, `/unarchive`,
  `/agenda`, `/history`, `/context`, `/escalate`, `/feed`, `/approve`, `/deny`, `/doctor`,
  `/subagents`, `/focus`, `/unfocus`, `/auth`, `/insights`, `/config`, `/help`.
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
