---
status: current
authority: implementation-plan
last_verified: 2026-05-17
external_evidence_date: 2026-05-17
external_evidence_method: GitHub repository README/landing-page primary-source review; no local clone, no live execution, and external commit SHAs not pinned.
source_paths:
  - PROJECT.md
  - README.md
  - specs/CURRENT/architecture-hexagonal-microkernel.md
  - specs/CURRENT/discord-control-plane-always-on.md
  - specs/CURRENT/full-matrix-release-blockers-2026-05-16.md
  - specs/CURRENT/hermes-pattern-adoption.md
  - specs/CURRENT/live-proof-matrix.md
  - specs/CURRENT/openclaw-gap-implementation.md
  - specs/CURRENT/orchestrator-subagent-skill-pattern.md
  - https://github.com/NousResearch/hermes-agent
  - https://github.com/Cranot/super-hermes
  - https://github.com/openclaw/openclaw
  - https://github.com/siimvene/openclaw-claude-runner
  - https://github.com/stainlu/openclaw-managed-agents
  - https://github.com/RobertTLange/headless-cli
  - https://github.com/microsoft/conductor
  - https://github.com/Potarix/agent-hub
  - https://github.com/totorospirit/cc-openclaw-bridge
scope: Hermes/OpenClaw 계열 및 headless/workflow/managed-agent 저장소와 비교해 Auto Archive의 현 미진한 부분과 당분간 채택하지 않을 범위를 분리한 개량 계획.
supersedes:
---

# Agent Repository Comparison Improvement Plan — 2026-05-17

## 1. 목적

이 문서는 Auto Archive를 다음 저장소군과 비교해 **현재 브랜치에서 아직 약한 부분**과
**개량 우선순위**를 정리한다.

- Hermes Agent
- Super Hermes
- OpenClaw
- OpenClaw Claude Runner
- OpenClaw Managed Agents
- Headless CLI
- Microsoft Conductor
- Agent Hub
- CC OpenClaw Bridge

비교의 목적은 기능 목록을 그대로 복제하는 것이 아니다. Auto Archive의 현재 정본은
`README.md`, `src/`, `tests/`이고, 현재 브랜치는 reimplementation scaffold 및
runtime/control-plane slice가 누적된 상태이지 full rewrite complete 상태가 아니다.
따라서 이 문서는 다음 세 가지 질문에만 답한다.

1. 연구/아카이브 특화 에이전트 프레임워크로서 당장 경쟁력이 부족한 축은 무엇인가?
2. 비교 저장소의 어떤 패턴만 Auto Archive 목표에 맞게 흡수할 것인가?
3. 다중 입력 채널, 모바일/음성/캔버스처럼 당분간 상관없는 범위는 무엇을 제외할 것인가?

## 1.1. 평가 시점과 방법

외부 저장소는 2026-05-17에 GitHub repository README/landing page를 1차 출처로
검토했다. 이 문서는 외부 저장소를 로컬 clone하거나 실행하지 않았고, 모든 저장소의
commit SHA를 고정하지도 않았다. 따라서 비교는 "현재 공개 README가 드러내는 제품/설계
패턴" 기준이며, 정확한 재현 감사를 하려면 후속 작업에서 repo별 commit pin과 local
structural read를 별도로 수행해야 한다.

재검토 트리거:

- 비교 대상 저장소의 major release 또는 architecture rewrite.
- Auto Archive가 Wave 1 이후 외부 API/DSL/product surface를 실제로 열 때.
- 사용자가 제외 범위였던 multi-channel, GUI, vault, SaaS productization을 명시적으로
  다시 요구할 때.

## 2. 명시적 비목표

아래 항목은 비교 저장소에는 보이지만 현재 Auto Archive 개량 계획에서는 제외한다.

| 제외 범위 | 예시 저장소 | 제외 이유 |
| --- | --- | --- |
| 다중 입력/메시징 채널 확장 | Hermes Gateway, OpenClaw, CC OpenClaw Bridge | 현재 제품 표면은 Discord 중심이다. Telegram/Slack/WhatsApp/Signal/Home Assistant 확장은 live-proof와 핵심 runtime 안정화 이후 재평가한다. |
| 음성, wake word, 모바일 node, 카메라/화면 캡처 | OpenClaw | 연구 아카이브/증거/서브에이전트 control-plane의 현 blocker를 해결하지 못한다. |
| Canvas/A2UI/desktop-native GUI 우선 개발 | OpenClaw, Agent Hub, Conductor web UI | Discord/CLI/정적 scorecard 표면을 먼저 완결한다. GUI는 증거 링크와 승인 UX가 텍스트 표면에서 검증된 뒤 별도 제품화 판단을 한다. |
| multi-tenant SaaS credential vault/product API 전체 | OpenClaw Managed Agents | 현재는 operator-owned single deployment가 기준이다. credential vault 전체가 아니라 secret-reference boundary와 egress policy만 먼저 검토한다. |
| provider fan-out, mid-flight model switching, council runtime | Headless CLI, Agent Hub, Hermes providers | `multi-provider-scope.md`의 bootstrap-time provider seam을 유지한다. provider proliferation은 목표가 아니다. |
| RL trajectory/batch-runner 학습 데이터화 | Hermes Agent, Super Hermes 일부 실험 흐름 | 현재 연구 아카이브 제품 목표와 직접 연결되지 않는다. constraint report 수준의 학습 루프만 검토한다. |

## 3. Auto Archive 현재 기준선

현재 브랜치의 강점과 한계는 다음으로 요약한다.

| 축 | 현재 상태 | 비교 시 해석 |
| --- | --- | --- |
| 아키텍처 | Hexagonal + microkernel. `Arona`, `Plana`, `Dispatcher`, `ComputeNode`, `RuntimeDriver`, `TraitModule` 경계가 문서화되어 있다. | 구조적 경계는 좋지만, 외부에서 호출 가능한 managed-agent API와 workflow DSL은 아직 약하다. |
| Runtime provider | bootstrap-time `codex` 기본, optional `claude-agent`. mid-flight switching은 명시적으로 out-of-scope. | provider 범위를 좁게 유지하는 점은 장점이다. 대신 backend capability/introspection UX가 필요하다. |
| Discord control-plane | `/ask`, `/research`, `/proof`, `/subagents`, `/focus`, `/feed`, `/doctor` 등 command surface와 JSONL ledger가 존재한다. | OpenClaw/Hermes의 다중 채널성은 제외하되, operator-visible progress/approval/human gate의 완성도는 더 높여야 한다. |
| Evidence/readiness | static scorecard CLI가 많고 live-proof matrix가 분리되어 있다. | 증거 원칙은 강하지만, release-complete를 막는 live-proof row가 많아 "실제로 동작함"을 아직 충분히 주장할 수 없다. |
| Subagent | depth-1 root-owned roster/operator 표면이 있다. | live operator proof, per-subagent capability envelope, progress tree가 미흡하다. |
| Skills/traits | TraitModule, methodology origin, usage telemetry, scheduler slice가 있다. | Hermes/Super Hermes식 self-improvement loop는 아직 constrained/benchmarked artifact로 닫혀 있지 않다. |
| Workflow | research-plan orchestrator가 sequential N-sub-task + synthesis 형태로 존재한다. | Conductor식 declarative DAG, dry-run validation, human gates, script exit-code routing은 아직 일반화되어 있지 않다. |

## 4. 비교 저장소에서 흡수할 패턴

| 저장소 | 관련 패턴 | Auto Archive 적용 방향 | 제외/주의 |
| --- | --- | --- | --- |
| Hermes Agent | skills hub, persistent memory, command approval, MCP/toolsets, cron, terminal backends, context files | 이미 채택 추적 문서가 있으므로 남은 gap은 live proof, per-subagent grant, skill admission quality metric 중심으로 좁힌다. | messaging gateway 확장, provider zoo, RL trajectory/batch runner는 제외. |
| Super Hermes | prism-style falsifiable analysis, constraint transparency, structural invariant extraction | 연구 mission/critique 결과에 `constraintReport` artifact를 추가해 blind spot과 반례를 남긴다. | "생각을 더 깊게"라는 prompt-only 기능으로 도입하지 않는다. 검증 가능한 artifact와 reviewer checklist가 있어야 한다. |
| OpenClaw | personal assistant runtime, skills/onboarding, sandbox/security, tool loop hardening, companion control surfaces | tool-loop/stall/doctor/skills 일부는 이미 반영됨. 남은 것은 onboarding consolidation, operator proof, capability envelope이다. | voice/canvas/mobile/multi-channel은 제외. OpenClaw를 runtime dependency로 채택하지 않는다. |
| OpenClaw Claude Runner | session continuity, context fill, compaction controls, SDK/CLI bridge comparison | `/context`와 provider evidence에 context budget/fill telemetry를 추가한다. SDK가 compaction event를 노출하지 않는 한 approximation으로 표기한다. | Claude subscription billing/Max-plan path는 제품 runtime 전제에 넣지 않는다. |
| OpenClaw Managed Agents | Agent/Environment/Session/Event API, isolated container per active session, durable session state, SSE events, quotas, network modes, vault metadata, audit | Auto Archive도 내부적으로 task/session/event vocabulary를 안정화하고, Discord 외부에서 읽을 수 있는 read-only event stream/report를 준비한다. | multi-tenant SaaS 전체, per-end-user credential vault full clone은 보류. |
| Headless CLI | backend-normalized prompt/model/reasoning/workdir/session/env-check/print-command | RuntimeDriver capability report와 redacted `print-run-plan`을 추가해 operator가 provider 차이를 안전하게 볼 수 있게 한다. | provider proliferation, ACP registry 전체 수용, mid-flight switching은 제외. |
| Microsoft Conductor | YAML workflow, parallel/for-each/evaluator-optimizer/human gate/script step, dry-run, validation, workspace instructions, web dashboard | research-plan schema v2에서 validation/dry-run/human gate/parallel-safe fan-out subset을 흡수한다. | dashboard와 arbitrary script graph는 후순위. 우선은 연구 plan DSL과 evidence closeout에 제한. |
| Agent Hub | real CLI wrapper, local/SSH host, per-agent permission modes, thread history, visual approval | permission mode vocabulary와 per-thread approval history를 Discord/CLI text UX에 반영한다. | Electron/native GUI, image paste, remote host sidebar는 제외. |
| CC OpenClaw Bridge | headless `ask_user`/`notify_user` MCP, pending-file IPC, callback, auto-summary, multi-agent context env | Auto Archive 내부 `HumanGatePort`/`NotifyPort` 후보로 축소 적용한다. 첫 구현은 Discord/CLI만 대상으로 한다. | Telegram/Signal delivery bridge 자체와 Claude Code 전용 install side effect는 제외. |

## 5. 미진한 축 종합 진단

비교 결과 Auto Archive가 가장 약한 축은 다음 7개이다. 이 표는 아래 G0~G11 실행
항목의 요약 진단이며, 외부 기능 clone 요청이 아니다.

| 미진한 축 | 왜 부족한가 | 대응 gap |
| --- | --- | --- |
| Live product proof | static scorecard와 테스트는 많지만, release-complete를 막는 operator-gated live proof row가 남아 있다. | G0, G7 |
| Managed session/event vocabulary | Discord task registry 중심이라 외부 app/read-only projection이 안정된 `Agent/Session/Event` 어휘로 정리되지 않았다. | G1, G6 |
| Declarative workflow/replay | research-plan은 있으나 validation/dry-run/human gate/parallel subset이 Conductor식 workflow로 일반화되지 않았다. | G2 |
| Runtime introspection/cost/context | bootstrap seam은 안전하지만 실행 전 backend capability, token/cost/context provenance를 operator가 한눈에 보기 어렵다. | G3, G4, G11 |
| Permission/capability envelope | approval/admission은 있으나 per-task/per-subagent filesystem/network/tool/secret/cost envelope가 한 단위로 보이지 않는다. | G5 |
| Operator human-gate UX | Discord command는 많지만 ask/notify/approval/timeout/summary를 하나의 bounded port로 묶는 표준이 약하다. | G9, G10 |
| Self-improvement/eval loop | Trait/curator 표면은 있으나 blind spot, constraint, reusable skill candidate, external eval signal을 reviewable artifact로 닫는 루프가 약하다. | G8, G11 |

## 6. 미진한 부분과 개량 계획

### G0. Full-matrix live proof blocker 해소

- **문제**: 현재 full-matrix release는 operator-gated live proof row가 남아 blocked이다.
- **비교 신호**: Hermes/OpenClaw/Managed Agents 계열은 README에서 즉시 실행 가능한 quickstart와
  session/service loop를 전면에 둔다. Auto Archive는 static readiness와 scorecard가 강하지만,
  실제 live artifact 수집이 완료되지 않았다.
- **개량**:
  1. `full-matrix-release-blockers-2026-05-16.md`의 row를 release gate의 최상위 queue로 유지한다.
  2. 신규 기능 구현보다 먼저 Discord service, provider TerminalEvidence, subagent roster,
     focus/session binding, GitLab recording의 최소 pass artifact를 수집한다.
  3. 각 artifact는 기존 scorecard CLI로만 판정하고 raw token/prompt/response는 남기지 않는다.
- **우선순위**: P0.
- **완료 조건**: aggregate `live:proof:report`가 mandatory row에서 `operatorApproved:true`,
  `status:"pass"`를 보고하고, repo-local gate가 다시 통과한다. 최소 산출물은
  redacted live-proof manifest, row-specific retained evidence file, scorecard JSON,
  그리고 raw secret/content boundary flag PASS 기록이다.

### G1. Managed session/event API의 부재

- **문제**: Discord task registry와 JSONL ledger는 있지만, 외부 app이 호출할 수 있는
  `Agent / Environment / Session / Event` 수준의 안정 read/write API는 없다.
- **비교 신호**: OpenClaw Managed Agents는 Agent 생성, Session open, Event send/stream,
  durable respawn을 명확한 서비스 API로 제공한다.
- **개량**:
  1. 우선 `SessionRecord`/`AgentRecord`/`EventRecord` 용어를 내부 contract로 고정한다.
  2. Discord registry와 runtime TerminalEvidence를 같은 read-only event projection으로 내보내는
     `agent:events:report` CLI를 추가한다. 2026-05-18 first slice는 retained
     TerminalEvidence를 metadata-only `SessionRecord`/`AgentRecord`/`EventRecord`
     projection으로 내보내며, REST/SSE나 public API는 열지 않는다.
  3. API 서버는 바로 열지 않고, 파일/CLI projection이 안정된 뒤 REST/SSE surface를 별도 판단한다.
     이 단계는 operator-local projection이며 public SaaS product API가 아니다.
- **우선순위**: P1 after G0.
- **완료 조건**: 같은 task가 Discord view, terminal evidence view, event projection view에서
  동일한 terminal outcome과 redacted correlation을 가진다.

### G2. Research-plan DSL이 Conductor식 workflow 수준에는 못 미침

- **문제**: 현재 research-plan orchestrator는 sequential N-sub-task + 1-synthesis에 강하지만,
  validation, dry-run, human gate, parallel-safe fan-out, script exit-code routing 같은 일반 workflow
  요소는 부족하다.
- **비교 신호**: Conductor는 YAML workflow, for-each/parallel, evaluator-optimizer, human gate,
  script step, dry-run/validation을 명시한다.
- **개량**:
  1. `research-plan` schema v2를 추가하되 기본은 backward-compatible로 둔다.
  2. `pnpm research:plan:validate`와 `research:plan:dry-run`을 먼저 구현한다. 2026-05-18 first slice는 current v1 sequential subset에 대해 provider-free validation/dry-run JSON을 추가했다.
  3. v2에서 허용할 node type은 `task`, `synthesis`, `human_gate`, `parallel_group`의 bounded subset으로 제한한다.
     2026-05-18 second slice는 `research-plan.v2` validate/dry-run-only subset을 추가하고,
     live `research:plan:run`은 v2 입력을 fail-closed로 거부하도록 했다.
  4. arbitrary shell/script step은 release live proof 이후 별도 gate로 둔다.
  5. Conductor 전체 clone이 아니라 research-plan DSL subset임을 schema와 help text에 명시한다.
- **우선순위**: P1.
- **완료 조건**: invalid plan은 provider call 없이 fail closed 되고, dry-run은 예상 task graph와 evidence
  requirements를 deterministic JSON으로 출력한다.

### G3. Runtime backend introspection이 약함

- **문제**: provider seam은 bootstrap-time으로 안전하게 좁혀져 있으나, operator가 "현재 provider가
  어떤 model/reasoning/env/capability로 실행될지"를 headless하게 미리 확인하기 어렵다.
- **비교 신호**: Headless CLI는 backend 차이를 한 CLI로 normalize하고, `print-command`/env check를 제공한다.
  Agent Hub도 실제 CLI를 감싸되 permission mode를 표면화한다.
- **개량**:
  1. `runtime:driver:check` 또는 기존 `runtime:provider:evidence:report`의 companion으로
     redacted `run-plan` report를 추가한다. 2026-05-17 first slice는
     `pnpm runtime:driver:check -- --pretty`로 착수했다.
  2. report는 provider, model override, reasoning effort, auth source classification,
     permission/capability mode, expected artifact roots를 보여주되 secret/env value는 렌더링하지 않는다.
  3. 실행 명령 문자열은 "실제 argv 전체"가 아니라 secret-safe plan 형태로 출력한다.
  4. 이 report는 provider switching/fan-out 기능이 아니라 bootstrap-selected provider의
     introspection임을 출력 schema에 포함한다.
- **우선순위**: P1.
- **완료 조건**: provider call 없이 active bootstrap settings의 안전한 실행 계획을 볼 수 있고,
  inaccessible model/auth-source mismatch를 live run 전 감지한다.

### G4. Context budget/compaction 가시성 부족

- **문제**: `/context`는 있지만 provider별 context fill, compaction, transcript budget을 사용자가
  Hermes/OpenClaw Claude Runner 수준으로 직관적으로 보기는 어렵다.
- **비교 신호**: Hermes는 `/compress`, `/usage`, insight류 command를 표면화하고, OpenClaw Claude Runner는
  context fill 및 compaction endpoint를 강조한다.
- **현재 제약**: 기존 조사에 따르면 Codex SDK/Claude Agent SDK가 compaction lifecycle event를 직접 노출하지
  않는 경우가 있으므로, "정확한 compaction event"를 허위로 주장하면 안 된다.
- **개량**:
  1. provider가 token usage/context metadata를 제공할 때만 `contextFill`을 authoritative로 기록한다.
  2. 제공하지 않을 때는 `estimatedContextPressure`로 분리 표기한다.
  3. `/context`와 TerminalEvidence report에 `authoritative|estimated|unavailable` provenance를 붙인다.
     2026-05-18 first slice는 `runtime:provider:evidence:report`에 metadata-only
     `ContextBudgetSnapshot`을 추가하여 token usage `provider-reported|unavailable`,
     context fill `estimated|unavailable`, compaction `unavailable`을 raw transcript 없이 표기한다.
  4. manual checkpoint summary/export는 raw transcript를 저장하지 않는 redacted artifact로 제한한다.
- **우선순위**: P1.
- **완료 조건**: 사용자가 context 상태를 확인할 때 추정치와 provider 제공치를 혼동하지 않는다.

### G5. Per-task/per-subagent capability envelope 미흡

- **문제**: admission gate, approval registry, blocklist는 존재하지만 Hermes/OpenClaw/Managed Agents식
  per-session tool grant, network mode, secret-reference boundary가 하나의 envelope로 묶여 있지는 않다.
- **비교 신호**: OpenClaw Managed Agents는 limited/unrestricted network mode와 vault credential metadata를
  API 차원에 둔다. Agent Hub는 per-agent permission mode를 사용자가 고른다.
- **개량**:
  1. `CapabilityEnvelope` 초안을 contract로 추가한다: filesystem write scope, network egress class,
     tool grant class, credential reference class, max runtime/cost. 2026-05-18 first slice는
     metadata-only `CapabilityEnvelope` projection을 추가하고 research-plan dry-run node에 노출했다.
     Wave 2 first slice는 같은 envelope를 `agent:events:report`의 `AgentRecord` projection에도
     연결해 retained TerminalEvidence task/subagent metadata에서 권한 envelope를 확인할 수 있게 했다.
  2. 기존 `CapabilityFlag`, `NetworkPolicy`, approval store와 중복되지 않게 projection layer로 둔다.
  3. 첫 구현은 report/doctor/dry-run 검증만 한다. 실제 egress proxy/vault는 별도 operator-gated slice로 둔다.
- **우선순위**: P1/P2.
- **완료 조건**: subagent spawn/report에 어떤 권한 envelope로 실행됐는지 metadata-only로 남고,
  envelope drift가 테스트에서 잡힌다.

### G6. Durable resume/cancel lifecycle의 제품화 부족

- **문제**: task registry replay와 cancel boundary는 있으나, "session이 evict된 뒤 같은 state로 respawn"하는
  managed-agent 수준의 durable session lifecycle은 아직 제품 표면이 아니다.
- **비교 신호**: OpenClaw Managed Agents는 active session container eviction/respawn과 durable state를 전면에 둔다.
- **개량**:
  1. Auto Archive의 task-bound lifecycle은 유지한다. 장수 warm pool은 비목표로 남긴다.
  2. 대신 terminal/interrupted/cancelled task의 redacted restart recipe를 표준화한다.
     2026-05-18 first slice는 `RestartRecipeSnapshot` contract와 `agent:events:report`
     projection에 terminal-cause 기반 retryability/recommended action metadata를 추가했다.
  3. `/rerun`과 provider TerminalEvidence가 같은 restart recipe schema를 사용하게 한다.
- **우선순위**: P2.
- **완료 조건**: 실패/취소 task는 raw prompt 노출 없이 "재시도 가능/불가능/필요 operator action"을
  deterministic하게 설명한다.

### G7. Subagent observability가 아직 live-proven product UX가 아님

- **문제**: role tree, roster, operator report, Discord preflight는 존재하지만 live roster interaction 증거가
  release blocker로 남아 있다.
- **비교 신호**: Conductor/Agent Hub/OpenClaw 계열은 multi-agent progress와 thread/session 상태를 사용자 표면에
  더 직접적으로 보여준다.
- **개량**:
  1. G0의 subagent live-proof row를 먼저 닫는다.
  2. 이후 mission summary에 parent-child lifecycle count, active role, last progress age,
     terminal evidence digest를 같은 schema로 표시한다.
  3. depth-1 root-owned invariant는 유지한다.
- **우선순위**: P1.
- **완료 조건**: `/subagents`와 mission summary가 같은 roster evidence를 참조하고,
  raw prompt/response/log를 렌더링하지 않는다.

### G8. Skill/Trait self-improvement loop의 검증 부족

- **문제**: TraitModule, curator, usage telemetry, methodology origin은 있으나, Super Hermes식
  "무엇을 못 봤는지/어떤 제약이 남았는지"를 반복 가능한 artifact로 축적하는 루프는 약하다.
- **비교 신호**: Super Hermes는 prism/constraint transparency를 통해 분석 절차 자체를 artifact화한다.
  Hermes는 skills/procedural memory와 self-improvement loop를 강조한다.
- **개량**:
  1. `constraintReport` schema를 mission/critique artifact로 추가한다.
  2. report에는 falsifiable claim, hidden assumption, counterexample, next verification target,
     reusable skill-candidate 여부를 기록한다.
  3. Trait promotion은 자동 적용하지 않고 user/operator approval 또는 project-memory promotion gate를 통과해야 한다.
- **우선순위**: P2.
- **완료 조건**: repeated research mission에서 blind spot/constraint report가 누적되되,
  raw user content와 unapproved prompt rewrite는 durable memory로 승격되지 않는다.

### G9. Onboarding/doctor가 하나의 operator journey로 묶이지 않음

- **문제**: `doctor`, deployment guide, evidence scorer는 많지만, Hermes/OpenClaw식 "설치 → 설정 →
  첫 task → proof capture"의 하나짜리 guided path는 약하다.
- **비교 신호**: Hermes/OpenClaw/Headless 계열은 quickstart와 first-run command를 전면에 둔다.
- **개량**:
  1. `pnpm quickstart:doctor` 또는 `pnpm doctor --profile first-run`을 추가한다.
  2. 출력은 missing env 이름을 값 없이 보여주고, 다음 안전 command를 하나씩 제안한다.
  3. live-proof template export와 provider run-plan check를 같은 journey에 연결한다.
- **우선순위**: P2.
- **완료 조건**: 새 operator가 secret 값을 노출하지 않고 first proof artifact까지 필요한 단계를 확인할 수 있다.

### G10. Generic human-gate/notification port가 좁게 정리되어 있지 않음

- **문제**: Discord `/approve`, `/deny`, `/escalate`는 있지만, runtime 내부에서 "사용자에게 질문"과
  "진행 알림"을 일관된 port로 남기는 경계는 CC OpenClaw Bridge만큼 단순하지 않다.
- **비교 신호**: CC OpenClaw Bridge는 `ask_user`/`notify_user` 두 도구와 auto-summary로 headless agent의
  인간 상호작용을 최소 표면에 묶는다. Conductor도 human gate를 workflow primitive로 둔다.
- **개량**:
  1. `HumanGatePort` 후보를 설계한다: ask, notify, timeout, answer provenance, summary.
     2026-05-18 first slice는 `HumanGateSnapshot` contract를 추가하고 research-plan
     dry-run human gate 및 runtime approval event projection을 raw question/answer 없이 연결했다.
  2. 첫 adapter는 Discord/CLI only로 제한한다.
  3. Telegram/Signal/Slack delivery는 이 문서의 비목표로 유지한다.
  4. `NotifyPort`라는 이름이 multi-channel gateway를 암시하지 않도록, first slice는
     "Discord/CLI notification projection"으로 표기한다.
- **우선순위**: P2.
- **완료 조건**: approval/escalation/research-plan human gate가 동일한 answer provenance schema를 사용한다.

### G11. Token/cost/eval accountability가 한 축으로 닫혀 있지 않음

- **문제**: provider evidence가 token usage를 담을 수 있고 Claude max budget 설정도 있으나,
  token/cost/eval 결과를 mission/task closeout에서 일관된 accountability artifact로 묶는 축은 약하다.
- **비교 신호**: Headless/Conductor/managed-agent 계열은 실행 단위와 backend 선택을 명시적으로 드러내며,
  Hermes/Super Hermes 계열은 반복 개선의 질을 artifact화하려 한다.
- **개량**:
  1. TerminalEvidence와 mission summary에 `costUsageProvenance`를 추가한다:
     `provider-reported|estimated|configured-budget-only|unavailable`. 2026-05-18 first slice는
     `CostUsageSnapshot` contract를 추가하고 `agent:events:report` scorecard/records에서
     provider token usage와 unavailable billing provenance를 metadata-only로 표시한다.
  2. research mission closeout에 최소 eval signal을 추가한다: acceptance check coverage,
     unresolved claim count, constraintReport count, live-proof linkage status.
  3. cost/eval report는 raw prompt/response 없이 metadata-only로 유지한다.
- **우선순위**: P2.
- **완료 조건**: task/mission closeout이 "성공/실패"뿐 아니라 cost provenance와 eval coverage를
  redacted metadata로 설명한다.

## 7. 용어 미니 글로서리

| 용어 | 이 문서에서의 의미 |
| --- | --- |
| Managed session | operator-local task/session/event projection. Public SaaS session API나 multi-tenant vault를 뜻하지 않는다. |
| Capability envelope | filesystem, network, tool, credential-reference, runtime/cost limits를 한 task/subagent 실행 단위로 설명하는 metadata contract. |
| Research-plan DSL subset | Auto Archive 연구 plan에 필요한 bounded workflow subset. Conductor 전체 clone이나 arbitrary script graph가 아니다. |
| Human gate | bounded 질문/승인/timeout/answer provenance primitive. 다중 메시징 채널 gateway가 아니다. |
| Runtime introspection | bootstrap-selected provider의 safe run-plan report. provider switching/fan-out이 아니다. |

## 8. 실행 순서

| Wave | 목표 | 포함 gap | 선행 조건 | 완료 증거 |
| --- | --- | --- | --- | --- |
| Wave 0 | release/live proof 신뢰 회복 | G0, G7 일부 | 현재 worktree 정리와 operator 승인 | full-matrix blocker row의 최소 pass set |
| Wave 1 | operator가 실행 전/중/후 상태를 이해하게 만들기 | G2, G3, G4, G7 | Wave 0 최소 provider/Discord proof | plan dry-run, run-plan report, context provenance, subagent evidence projection |
| Wave 2 | 권한/세션/인간 게이트/비용 책임 표준화 | G1, G5, G6, G10, G11 | Wave 1 reports 안정화 | first slice landed: event projection, capability envelope projection, restart recipe, HumanGateSnapshot schema, cost provenance metadata; remaining: `/rerun` binding and mission closeout eval coverage |
| Wave 3 | self-improvement와 onboarding 제품화 | G8, G9 | Wave 2 schema 안정화 | constraintReport artifact, quickstart doctor journey, promotion gate tests |

## 9. 채택/보류 decision log

| 결정 | 상태 | 재평가 트리거 |
| --- | --- | --- |
| Discord 중심을 유지하고 multi-channel gateway clone은 하지 않는다. | locked for near term | Discord live proof가 안정되고 외부 사용자가 실제로 다른 채널을 요구할 때 |
| bootstrap-time provider seam을 유지한다. | locked | 한 task 안에서 provider fan-out이 연구 품질을 실증적으로 개선하고 비용/감사 경계가 설계될 때 |
| workflow는 research-plan v2 subset부터 확장한다. | active | v2 dry-run/validation이 안정되고 arbitrary scripts가 필요한 operator use case가 생길 때 |
| per-end-user vault full clone은 하지 않는다. | deferred | multi-tenant hosted mode가 실제 roadmap에 들어올 때 |
| GUI/dashboard는 당장 만들지 않는다. | deferred | Discord/CLI proof UX가 stable이고 live operator가 visual diff/approval을 반복적으로 요구할 때 |

현재 이 문서는 이전 decision 문서를 supersede하지 않는다. `supersedes:`는 비어 있으며,
기존 `hermes-pattern-adoption.md`, `openclaw-gap-implementation.md`,
`live-proof-matrix.md`를 대체하지 않고 cross-repo 개선 우선순위만 추가한다.

## 10. 검증 원칙

1. 새 plan/report/doctor surface는 raw token, raw prompt, raw response, raw private artifact를 렌더링하지 않는다.
2. live-proof row를 닫는 증거와 static scorecard를 혼동하지 않는다.
3. provider/backend normalization은 provider switching을 뜻하지 않는다.
4. Human gate는 질문 수와 timeout이 bounded여야 하며, answer provenance를 남겨야 한다.
5. Trait/self-improvement는 자동 prompt rewrite가 아니라 reviewable artifact와 promotion gate로만 들어온다.
