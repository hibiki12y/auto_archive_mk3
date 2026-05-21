---
status: current
authority: implementation-explanation
last_verified: 2026-05-05
source_paths:
  - README.md
  - IMPLEMENTATION_LOG.md
scope: 본 브랜치에서 OpenClaw 영향 갭 슬라이스의 현재 구현 상태 기록.
---

# OpenClaw 갭 구현

## 현재 능력 상태

본 파일은 단순한 전환 계획이 아니라 현재 적용된 내용을 기록하므로 `CURRENT/`에
머무른다. 여러 OpenClaw 영향 갭 슬라이스가 현재 브랜치에서 로컬로 또는
스캐폴드 표면으로 구현되었지만, 라이브 완료에는 여전히 런타임 자격 증명과
증거가 필요하다. OpenClaw 자체는 참조 전용이다. 여기서 OpenClaw는 런타임
의존성, 프로바이더, 또는 벤더링된 소스 표면이 아니다.

## 권한 경계

본 파일은 현재 브랜치의 권한 모델을 기준으로 추적한다: Arona, Plana, Agent
Instance, Codex SDK, Docker Discord 서비스, GitLab 태스크 결과 발행. 본 spec은
어떤 OpenClaw 소스 트리도 클론하거나 벤더링하지 않는다.

## 현재 작업 단위 상태

| 작업 단위 | 현재 상태 | 구현 표면 |
| --- | --- | --- |
| OC-1A 도구 루프/무진전 검출기 | 로컬 구현 | `src/core/tool-loop-detector.ts`, `src/core/plana.ts`, 런타임 경고 증거, Discord/GitLab 렌더러 |
| OC-1A.1 Task health mid-cycle observer foundation | 로컬 구현 | `RuntimeMidCycleObserver`, default-off `TaskStallObserver`, Plana observer fan-out/release, service bootstrap opt-in wiring, `/doctor` on-demand task-health section, `task.health_stalled` durable control-plane recorder and default-off service interval for `/feed kind=task`, `pnpm task:health:evidence:report` retained control-plane JSONL scorecard, `/doctor` redacted task-health evidence summary. Live threshold tuning and push delivery remain operator-gated |
| OC-1B 라이브 승인 라우팅 및 실행 승인 바인딩 | 로컬 구현 | `src/core/runtime-approval-registry.ts`, `src/core/execution-approval-store.ts`, Discord 승인 핸들러, 서비스/스모크 부트스트랩의 Plana 승인 훅 |
| OC-2A 서브에이전트 운영자 표면 | 로컬 구현 | `src/runtime/subagent-operator.ts`, Discord `/subagents` 명령, 깊이 1 루트 소유 policy, `pnpm subagent:operator:evidence:report` retained roster-event JSONL scorecard with safe digest/ref artifact metadata only, raw message/reason/prompt/response/payload/raw-artifact fail-closed handling, `/doctor` redacted subagent-operator evidence summary |
| OC-2B 스레드/채널 포커스 바인딩 | 로컬 구현 | `src/discord/discord-session-binding.ts`, `/focus`, `/unfocus`, metadata-only domain-separated HMAC `bindingAudit` control-plane records for focus/steering lifecycle, `pnpm session:binding:evidence:report` retained scorecard, `/doctor` redacted session-binding evidence summary |
| OC-3A 신뢰 기준선 doctor | 로컬 구현 | `src/core/doctor.ts`, `scripts/auto-archive-doctor.mjs`, `pnpm run doctor` package script, 확장된 `/doctor` 렌더링 |
| OC-3B GitLab 라이프사이클 강화 | 로컬 구현 | 태스크 프로젝트 README 렌더러, 이슈 종료 증거 섹션, 선택적 Arona list/inspect/archive/follow-up 헬퍼 |
| OC-4A Agent Harness Plugin ABI | 로컬 구현 | `src/contracts/agent-harness-plugin.ts`, `src/runtime/agent-harness-registry.ts`, `src/runtime/runtime-driver-factory.ts`의 explicit wrapper binding, read-only registry report/descriptor CLI, descriptor `--print-template` skeleton UX, `/doctor` descriptor summary |
| OC-4B Durable task archive UX | 로컬 구현 | `DiscordTaskRegistry.archiveTask` / `unarchiveTask`, metadata-only control ledger `task.archived` / `task.unarchived` schema-versioned archiveAudit records with safe task/actor/reason hashes, Discord `/archive`, `/unarchive`, `/tasks archived`, owner/admin mutation guard, `pnpm task:archive:evidence:report` retained control-plane JSONL scorecard with strict archiveAudit allowlist/hash-shape validation/filter-scoped transition counts, `/doctor` redacted task-archive evidence summary |
| OC-4C Skill/Trait discovery UX | 로컬 구현 | Discord `/traits`, `renderTraitModuleList`, service bootstrap TraitModule manifest discovery. read-only metadata surface이며 auto-install/auto-enable/external registry는 제외 |
| OC-4D Terminal task rerun UX | 로컬 구현 | Discord `/rerun`, `DiscordTaskRecord.requestedInstruction` / `rerunOfTaskId`, fresh managed artifact root 재발급, terminal-only rerun guard, owner/admin mutation guard |
| OC-4E Operator escalation request UX | 로컬 구현 | Discord-only `/escalate`, control ledger `escalation.requested`, bounded untrusted reason payload, sanitized no-mention acknowledgement, ACP surface exclusion |
| OC-4F Control-plane live feed / observability UX | 로컬 구현 | Discord-only `/feed`, `ControlPlaneLedgerPort.loadSince`, task/escalation/approval/all filter, 50-event cap, user별 2/min rate-limit, sanitized no-mention rendering, ACP surface exclusion, default-off OTLP safe-metadata observer, `/doctor` redacted OTLP config diagnostics |
| OC-4G Autonomous research archive-loop evidence UX | 로컬 구현 | repository-owned `trait.research.autonomous-goal-loop.v1`, default-off evidence decorator, `/doctor` runtime-mode boundary, `pnpm autonomous:research:evidence:report` TerminalEvidence scorecard and non-promoting `--print-template`, `/doctor` redacted autonomous evidence summary |
| OC-4H Live proof artifact scorecard UX | 로컬 구현 | `pnpm live:proof:report`, operator-owned redacted proof manifest parser, live-proof matrix artifact-token gate, boundary/redaction scorecard, `/doctor` redacted live-proof scorecard. 정적 proof checker이며 live 서비스 접속/파일 mutation/원문 summary·correlation id rendering은 제외 |
| OC-4I Peekaboo quantitative evidence UX | 로컬 구현 | `pnpm peekaboo:evidence:report`, 기존 Peekaboo evidence JSONL bounded replay, malformed/torn line `replayAudit`, MCP quantitative-report rubric 재사용, `/doctor` redacted scorecard. 정적 replay 표면이며 GUI submit/Discord poll/provider contact/ledger mutation/raw note·correlation id rendering은 제외 |
| OC-4J Persona telemetry evidence UX | 로컬 구현 | `pnpm persona:telemetry:report`, `persona-transform-observed` metadata JSONL bounded replay, success/fallback·latency·token·human no-copy review scorecard, `/doctor` redacted telemetry summary. 정적 replay 표면이며 persona model call/provider contact/ledger mutation/raw prompt·source dialogue·transformed text·task id rendering은 제외. raw content·task id·credential key와 과도한 nested telemetry는 FAIL 처리 |
| OC-4K Runtime provider retained evidence UX | 로컬 구현 | `pnpm runtime:provider:evidence:report`, Codex/Claude Agent TerminalEvidence bounded replay, canonical driver provenance scorecard, provider-failure classification counts, `/doctor` redacted provider evidence summary. 정적 evidence reader이며 RuntimeDriver 생성/provider contact/provider switching/env reload/evidence mutation/raw task id·runtime id·reason·transcript rendering은 제외 |
| OC-0 소스/문서 위생 | 적용됨 | 현재 spec 기록과 과거 리다이렉트 위생. 외부 체크아웃 불필요 |

## 현재 비목표

- `allow-always` 실행 승인: 명시적으로 미지원
- 깊이 2 중첩 서브에이전트 spawn: 비활성. `maxSpawnDepth=1` 유지
- Harness plugin의 mid-flight provider switching: 미지원. 현재 ABI는
  bootstrap-selected `RuntimeDriver`를 감싸는 wrapper 경계일 뿐이다.
- GitLab CI 파일 생성: README 메타데이터 전용
- 자격 증명과 라이브 증거 없는 라이브 Discord/GitLab 완료 주장
- Autonomous research TraitModule을 숨은 무한 루프, provider switch, prompt
  origin switch, 또는 권한 상승 표면으로 사용하는 것

## 검증 경계

로컬 구현은 다음으로 증명되어야 한다.

- 도구 루프 검출기 단위·런타임 거부 테스트
- runtime mid-cycle observer fan-out/release 테스트, default-off task stall
  observer env/threshold/tick/release 테스트, `task.health_stalled` recorder
  및 service interval 테스트, `/doctor` task-health 표시 테스트,
  `task:health:evidence:report` retained JSONL scorecard/byte guard/raw-payload
  guard 테스트, quality score rubric(evidence presence 35, task scope 20,
  runtime correlation scope 20, clean replay 25), `/doctor` redacted
  task-health evidence summary 테스트
- 승인 레지스트리와 실행 승인 리플레이/드리프트/만료 테스트
- 서브에이전트 운영자와 세션 바인딩 테스트
- doctor redaction, non-mutating package-level doctor entrypoint, GitLab README/이슈 렌더링 테스트
- harness registry selection/fail-closed/report 테스트,
  `agent:harness:registry:report` descriptor CLI 테스트, `/doctor` descriptor
  summary 테스트와 runtime-driver-factory sync/lazy wrapper 테스트
- Discord-only `/escalate` surface isolation, `escalation.requested` ledger
  append, unknown/unavailable/denied branch, channel-scope reason bound,
  sanitized no-mention acknowledgement 테스트
- `task:archive:evidence:report` retained JSONL scorecard tests, archive/unarchive metadata-only audit records with hashed actor/reason/request metadata, idempotent retained semantics tests, and `/doctor` redacted task-archive evidence summary tests
- `subagent:operator:evidence:report` retained roster-event scorecard tests, raw operator payload/raw artifact fail-closed tests, filter-scoped transition-count tests, and `/doctor` redacted subagent-operator evidence summary tests
- `session:binding:evidence:report` retained focus/steering lifecycle scorecard tests, metadata-only bindingAudit payload tests, legacy raw binding payload fail-closed tests, filter-scoped transition-count tests, and `/doctor` redacted session-binding evidence summary tests
- Discord-only `/feed` surface isolation, `loadSince` bounded read, kind filter,
  50-event cap, missing/oversized ledger branch, handler rate-limit,
  sanitized no-mention rendering 테스트
- Control-plane OTLP observer default-off/fail-open/payload allowlist 테스트와
  `/doctor` endpoint/resource-attribute redaction/config diagnostics 테스트
- `pnpm build`와 `pnpm test`
- autonomous-research TraitModule contract/runtime/resolver 테스트,
  `autonomous:research:evidence:report` TerminalEvidence CLI 테스트, `/doctor`
  runtime-mode/evidence-summary 테스트
- `live:proof:report` manifest parser/CLI 테스트, surface filter, required
  artifact-token gate, unsafe boundary flag, no raw summary/correlation-id
  rendering, byte guard, read-only determinism 테스트, `/doctor` scorecard
  rendering/pass-through/config failure redaction 테스트
- `runtime:provider:evidence:report` TerminalEvidence CLI 테스트,
  Codex/Claude provider filter, canonical driver provenance gate,
  provider-failure classification count, byte guard, no raw task id/runtime id/
  reason/transcript rendering, `/doctor` provider evidence scorecard
  rendering/pass-through/config failure redaction 테스트
- Peekaboo evidence JSONL bounded replay/audit 테스트,
  `peekaboo:evidence:report` CLI 필터/byte guard/redaction 테스트,
  `/doctor` Peekaboo scorecard rendering/pass-through/config failure redaction
  테스트
- Persona telemetry JSONL bounded replay/audit 테스트,
  `persona:telemetry:report` CLI success/fallback/latency/human-review/raw-content
  guard 테스트(중첩 raw content·task id·credential key와 과도한 nested
  telemetry는 값 미렌더링 + FAIL),
  quality score rubric(success 40, latency 25, human no-copy review 20, sample 15),
  `/doctor` persona telemetry scorecard
  rendering/pass-through/config failure redaction 테스트

라이브 완료에는 추가로 Docker Discord 서비스 헬스, 라이브 GitLab 발행 태스크 1건,
승인 게이트 경로 1건, focus/follow-up/unfocus 경로 1건, `/doctor` 진단이 필요하다.
