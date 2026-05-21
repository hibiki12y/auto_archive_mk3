# Specs

본 트리는 현재 스캐폴드/평가 표면에 대한 브랜치 소유 spec 맵이다. 저장소의
상위 진실 소스 파일을 무시하지 않는 선에서, 현재 구현 동작, 안정 계약 의미,
구속 클라리피케이션, 운영자 포인터, 그리고 spec 거버넌스를 설명한다.

## 먼저 읽을 것

1. 브랜치/프로그램 상태, 단계, 메타데이터는 `../PROJECT.md`.
2. 현재 브랜치 구현 진실은 `../README.md`와 `../src/`, `../tests/`.
3. spec 내비게이션과 권한 어휘는 본 파일.
4. `CURRENT/`의 관련 파일.
5. 연결된 `CONTRACTS/`와 `CLARIFICATIONS/`.
6. 운영자/spec 차원 사용 포인터가 필요할 때만 `GUIDES/`.
7. 역사적 출처 용도의 `ARCHIVE/`.

`../PROJECT_SPEC.md`는 프로젝트 spec 사용에 대한 템플릿/참고 가이드로 남는다.
브랜치 진실에 대해 `PROJECT.md`, `README.md`, `src/`, `tests/`보다 위에 있지
않다.

## 진실 소스 위계

| 순위 | 경로 | 권한 |
| --- | --- | --- |
| 1 | `../PROJECT.md` | 브랜치/프로그램 상태, 단계, 메타데이터, 폭넓은 계획 자세 |
| 2 | `../README.md`, `../src/`, `../tests/` | 현재 브랜치 구현 진실 |
| 3 | `specs/CURRENT/` | 현재 authoritative 계획만: Hermes 비교 기반 미진점 개발 계획과 연구 플랫폼 readiness/scope SSoT. 기타 파일은 redirect-only 호환 stub |
| 4 | `specs/CONTRACTS/` | 소스 타입과 인터페이스의 안정적 계약 해석 |
| 5 | `specs/CLARIFICATIONS/` | 구속 어휘와 경계 결정 |
| 6 | `specs/GUIDES/` | 운영자/spec 차원 사용 포인터. 결코 소스 또는 현재 spec의 대체가 아님 |
| 7 | `specs/METADATA/` | spec 거버넌스 규칙, 마이그레이션 메타데이터, 경로 정책 |

충돌 규칙: 명시된 도메인에 한해 상위 순위 출처가 이긴다. `specs/` 내부에서는
`CURRENT`가 현재 계획/범위 SSoT를 담고, `CONTRACTS`가 안정 소스 계약을 해석하고,
`CLARIFICATIONS`가 어휘/경계 모호성을 해결한다. 이들 중 어느 것도 `README.md`,
`src/`, `tests/`를 무시하지 않는다.

## 폴더 모델

| 폴더 | 의미 | 일반 권한 |
| --- | --- | --- |
| `CURRENT/` | 현재 authoritative 계획 문서와 redirect-only 호환 stub | `implementation-plan` / `implementation-risk-ledger` / `redirect-only` |
| `CONTRACTS/` | 소스 인터페이스, 타입, 불변식의 안정적 해석 | `stable-contract-interpretation` |
| `CLARIFICATIONS/` | 비준된 경계, 명명, 용어 결정 | `binding-clarification` |
| `GUIDES/` | 동반 가이드/spec에 대한 간결한 spec 차원 사용 포인터 | `pointer-only` |
| `METADATA/` | spec 거버넌스, 마이그레이션, 폐기 규칙 | `spec-governance` |
| `ARCHIVE/` | 대체된, 실행별, 혼합 상태, 또는 역사적 문서 | 역사 전용 |

## 공통 메타데이터 스키마

활성 비-아카이브 spec 파일은 가능한 곳에서 다음 최소 frontmatter를 사용해야
한다.

```yaml
---
status: current | stable | ratified | pointer | active | redirect
authority: implementation-explanation | implementation-plan | implementation-risk-ledger | stable-contract-interpretation | binding-clarification | pointer-only | spec-governance | redirect-only
last_verified: YYYY-MM-DD
source_paths:
  - repo/path
scope: 문서가 다루는 범위에 대한 짧은 진술
supersedes: 선택적 경로 또는 문서 라벨
replaces: 선택적 경로 또는 문서 라벨
---
```

어휘 규칙:

- **status**는 "이 spec이 어떤 라이프사이클 상태에 있는가?"에 답한다.
- **authority**는 "이 spec을 어떻게 사용해야 하는가?"에 답한다.
- **last_verified**는 가장 최근의 문서/소스 정합 점검 날짜이며, 실행 증명
  주장이 아니다.
- **source_paths**는 현재 정본 소스 파일 또는 동반 문서를 가리킨다.
- **scope**는 문서가 다루는 것과 다루지 않는 것을 명시한다.
- **supersedes/replaces**는 선택적이며 실제 마이그레이션 관계가 있을 때만
  나타난다.

## 계약 포함 규칙

파일은 다음을 만족할 때만 `CONTRACTS/`에 속한다.

1. 저장소 소유 타입, 인터페이스, 또는 스키마 파일에 정착된 안정 소스 계약을
   해석한다.
2. 다른 구현 슬라이스가 의존하는 불변식 또는 허용된 의미를 표현한다.
3. 폭넓은 현재 상태 서술 또는 계획 노트보다 좁다.

문서가 Hermes 비교 기반 현재 개발 계획 또는 그 계획의 readiness/scope SSoT이면
`CURRENT/`에 둔다. 이미 구현된 능력 설명, dated checkpoint, 보조 evidence는
`ARCHIVE/`로 이동하고, 안정 소스 계약은 `CONTRACTS/`, 어휘/경계 혼란은
`CLARIFICATIONS/`에 둔다.

## 파일 인덱스

### `CURRENT/`

`CURRENT/`의 live authority는 현재 계획에 필요한 두 파일로 제한한다. Hermes 등
비교 저장소 대비 미진한 내용을 개발하는 현재 계획과, 그 계획의 제품 범위/증거
자세를 고정하는 SSoT만 `status: current`를 유지한다. 같은 폴더의 다른 `.md`
파일은 과거 경로 호환을 위한 `status: redirect` / `authority: redirect-only`
stub이며, 구현/계획 authority로 사용하지 않는다.

| 파일 | 목적 | 읽을 시점 | 권한 |
| --- | --- | --- | --- |
| `CURRENT/agent-repo-comparison-improvement-plan-2026-05-17.md` | Hermes/OpenClaw/headless/workflow/managed-agent 저장소 비교 기반 미진점과 현재 개발 계획. 모델 자동 학습/RL/provider-zoo는 축소·제외하고 workflow/evidence platform gap만 남긴다. | 다음 개발 wave 또는 비교 기반 scope 결정을 잡을 때 | implementation-plan |
| `CURRENT/research-platform-readiness-and-scope-2026-05-21.md` | 현재 제품 경계, retained live-proof replay posture, archived gate, active/deferred gap SSoT. | 릴리즈/연구 플랫폼 readiness와 모델 자동 학습 축소 결정을 확인할 때 | implementation-risk-ledger |

Redirect-only stub은 오래된 내부/외부 링크를 깨지 않기 위한 포인터다. 자세한
이동 대상은 `METADATA/cross-references.md`와 각 stub frontmatter의
`source_paths`를 따른다.

### `ARCHIVE/`

`ARCHIVE/`는 대체된 current spec, 날짜가 박힌 checkpoint, 구현 완료/역사적
ledger, 또는 현재 개발 계획의 보조 evidence를 보존한다. 이 폴더의 문서는 감사와
테스트 fixture의 출처가 될 수 있지만, `CURRENT/`의 두 live 문서를 대체하지
않는다.

| 파일/그룹 | 역사적 목적 | 현재 참조 방식 |
| --- | --- | --- |
| `ARCHIVE/architecture-hexagonal-microkernel.md`, `ARCHIVE/discord-control-plane-always-on.md`, `ARCHIVE/codex-sdk-runtime-bootstrap.md`, `ARCHIVE/trait-module-submodule-plugin-system.md`, `ARCHIVE/methodology-skill-admission-governance.md` | 이미 구현/검증 표면에 흡수된 architecture/runtime/trait 설명 | 코드·테스트 주석 또는 `METADATA/spec-test-coverage-matrix.md`의 supporting source로만 사용 |
| `ARCHIVE/live-proof-matrix.md` | live-proof surface checklist와 static-vs-live proof 분리 규칙 | live-proof CLI/test의 frozen requirement source로 사용하되 current readiness 판단은 `CURRENT/research-platform-readiness-and-scope-2026-05-21.md`에서 수행 |
| `ARCHIVE/hermes-pattern-adoption.md`, `ARCHIVE/openclaw-gap-implementation.md`, `ARCHIVE/orchestrator-subagent-skill-pattern.md` | 비교 저장소 패턴의 과거 adoption/gap 추적 | current plan의 근거 자료로만 사용 |
| `ARCHIVE/full-matrix-release-blockers-2026-05-16.md`, `ARCHIVE/release-readiness-checkpoint-2026-05-16.md`, `ARCHIVE/midpoint-checkpoint-2026-05-05.md`, `ARCHIVE/open-harness-parity-completion-audit-2026-05-05.md`, `ARCHIVE/remaining-issues-2026-04-30.md` | dated blocker/checkpoint/close-out ledger | old `CURRENT/` 경로의 redirect stub과 2026-05-21 readiness SSoT를 통해 해석 |
| `ARCHIVE/claude-token-offload-implementation-plan-2026-05-05.md`, `ARCHIVE/dispatcher-rate-throttle.md`, `ARCHIVE/subagent-runtime-activation-2026-05-08.md`, `ARCHIVE/task-health-and-escalation.md`, `ARCHIVE/ux-comparison-2026-05-09.md`, `ARCHIVE/discord-session-log-thread.md`, `ARCHIVE/discord-ui-interface-captures-2026-05-09.md`, `ARCHIVE/control-plane-otel-and-feed.md`, `ARCHIVE/m10-acp-adapter-design.md` | landed or support slice specs no longer part of live current plan | code comments/tests may cite them as archived source evidence |
| `ARCHIVE/hrm-experiment-ledger.md`, `ARCHIVE/hrm-experiment-ledger.json` | HRM experiment evidence ledger | research guide and verification script default source; not current Auto Archive product plan |

### `CONTRACTS/`

| 파일 | 목적 | 읽을 시점 | 권한 |
| --- | --- | --- | --- |
| `CONTRACTS/admission-rule-trait.md` | 진입 규칙, TraitModule id, capability flag 의미 정의 | 진입 어휘를 편집하거나 검토할 때 | stable-contract-interpretation |
| `CONTRACTS/dispatch-lifecycle-contract.md` | 디스패치 라이프사이클 관찰 의미 정의 | 라이프사이클 옵저버나 디스패치 단계 의미를 다룰 때 | stable-contract-interpretation |
| `CONTRACTS/microkernel-module-boundary.md` | microkernel module taxonomy와 TraitModule 가능/금지 경계 | microkernel 모듈을 trait/extension으로 분류하거나 변환할 때 | stable-contract-interpretation |
| `CONTRACTS/runtime-driver-interface.md` | runtime-driver 포트 의미 정의 | 런타임 어댑터/드라이버를 구현하거나 검토할 때 | stable-contract-interpretation |
| `CONTRACTS/runtime-settings-config.md` | 신뢰된 runtime-settings/부트스트랩 설정 의미 정의 | 설정 파싱, env 우선순위, 또는 부트스트랩 검증을 변경할 때 | stable-contract-interpretation |
| `CONTRACTS/terminal-evidence-schema.md` | 종료 증거 구조와 불변식 정의 | 디스패치 완료/증거 처리를 변경할 때 | stable-contract-interpretation |
| `CONTRACTS/trait-module-versioning.md` | TraitModule id major/version 공존·중복·마이그레이션 계약 | TraitModule loader, migration, deprecation policy를 다룰 때 | stable-contract-interpretation |

### `CLARIFICATIONS/`

| 파일 | 목적 | 읽을 시점 | 권한 |
| --- | --- | --- | --- |
| `CLARIFICATIONS/codex-sdk-provider-scope.md` | superseded: 과거 Codex SDK 단일 범위 기록, 현재는 multi-provider-scope가 대체 | 과거 문서 drift를 해석할 때만 | binding-clarification |
| `CLARIFICATIONS/compute-node-slurm-apptainer-unification.md` | 컴퓨트 노드 용어를 통합된 SLURM+Apptainer 솔기에 묶음 | 문서가 스케줄러와 격리를 별도 프로덕션 솔기로 분리하려 할 때 | binding-clarification |
| `CLARIFICATIONS/multi-provider-scope.md` | Codex + Claude Agent bootstrap-time multi-provider 범위와 advisor 패턴 | 런타임 provider scope, 인증, 비용/감사 invariant를 다룰 때 | binding-clarification |
| `CLARIFICATIONS/scaffold-adapter-driver-trait-definitions.md` | adapter/driver/trait 용어에 대한 구속 용어집과 역사적 분류 기록 | 어휘나 역할 분류가 분쟁 대상일 때 | binding-clarification |
| `CLARIFICATIONS/templerun-reference-boundary.md` | 정본 클라리피케이션 링크가 있는 간결한 templerun 경계 리마인더 | 문서가 templerun을 런타임/프로바이더/프롬프트 출처로 취급할 위험이 있을 때 | binding-clarification |
| `CLARIFICATIONS/templestay-reference-boundary.md` | `resource/templestay` reference/plugin resource 경계 | templestay submodule을 runtime dependency처럼 표현할 위험이 있을 때 | binding-clarification |

### `GUIDES/`

| 파일 | 목적 | 읽을 시점 | 권한 |
| --- | --- | --- | --- |
| `GUIDES/bootstrap-codex-auth-precedence.md` | Codex 인증 우선순위에 대한 빠른 운영자/spec 포인터 | 전체 부트스트랩 spec을 읽기 전 짧은 우선순위 리마인더가 필요할 때 | pointer-only |
| `GUIDES/discord-stack-deployment.md` | Docker Compose `discord-service` 스택 운영에 대한 빠른 운영자/spec 포인터 | 컨트롤 플레인 스택을 띄우거나 헬스 게이트를 점검할 때 | pointer-only |
| `GUIDES/discord-service-hardening-runbook.md` | admin seed, slurm-apptainer, observer failure, subprocess env hardening checklist | Discord service 운영 hardening을 확인할 때 | pointer-only |
| `GUIDES/gitlab-project-assignment-workflow.md` | GitLab 배정 흐름에 대한 빠른 운영자/spec 포인터 | GitLab 프로젝트 배정 동작을 활성화하거나 설명할 때 | pointer-only |
| `GUIDES/gpu-transformer-research-readiness.md` | GPU Transformer 연구 실행 전 `nvidia-smi` readiness gate와 최신 구조 연구 target | GPU 학습/평가 smoke를 실행하기 전 | pointer-only |
| `GUIDES/peekaboo-remote-evaluation-mcp.md` | 라이브 Peekaboo 증거 흐름에 대한 빠른 운영자/spec 포인터 | 라이브 Discord 증거 자세를 검증할 때 | pointer-only |

### `METADATA/`

| 파일 | 목적 | 읽을 시점 | 권한 |
| --- | --- | --- | --- |
| `METADATA/cross-references.md` | 정본 마이그레이션 맵과 경로 안내 | 레거시 참조를 정본 spec 경로로 교체할 때 | spec-governance |
| `METADATA/memory-baseline.md` | Wave 1 Memory Baseline Freeze. text-truth alignment 컨트랙트와 promotion-gate taxonomy. | memory 표면 도입 또는 promotion-gate 적용 결정을 다룰 때 | spec-governance |
| `METADATA/deprecation-policy.md` | 라이브 spec이 폐기/이동되는 방식 정의 | spec을 은퇴시키거나 아카이브할 때 | spec-governance |
| `METADATA/version-control.md` | 라이브 vs 역사적 spec 유지 규칙 정의 | spec을 편집, 이동, 또는 아카이브할지 결정할 때 | spec-governance |

## 언어와 용어 노트

- **current**, **stable**, **ratified**, **pointer**, **historical**은 메타데이터
  의미로만 사용하며, "권위 있음(authoritative)"의 호환 동의어로 쓰지 않는다.
- **canonical path**(정본 경로)는 선호되는 파일 위치를 의미하며, 그 자체로
  진실 소스 순위를 의미하지 않는다.
- **templerun**은 역사적 참조 문서 용어로만 사용한다. 정본 경계 보정은
  `CLARIFICATIONS/scaffold-adapter-driver-trait-definitions.md` §0이며, 짧은
  리마인더로는 `CLARIFICATIONS/templerun-reference-boundary.md`를 사용한다.
- **templestay** submodule은 현재 reference/plugin resource posture이며 runtime
  dependency가 아니다. 짧은 리마인더로는
  `CLARIFICATIONS/templestay-reference-boundary.md`를 사용한다.

## 링크 안전

- 가능한 곳에서 직접 참조를 정본 현재 경로로 갱신한다
- 마이그레이션 메타데이터에는 `specs/METADATA/cross-references.md`를 사용한다
- 라이브 권한 사본을 중복으로 두지 않는다
