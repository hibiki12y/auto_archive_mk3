---
status: active
authority: spec-governance
last_verified: 2026-04-29
source_paths:
  - specs/README.md
scope: 재구성된 specs 트리에 대한 정본 마이그레이션 메타데이터와 경로 안내.
---

# 교차 참조

## 정본 경로 안내

- 라이브 참조를 갱신할 때 아래 정본 경로를 그대로 사용한다.
- 문서에서는 `specs/...`로 시작하는 폴더 상대 참조를 선호한다. 마이그레이션
  히스토리만을 위해 제거된 레거시 루트 경로 리터럴을 복원하지 않는다.
- 소문자 `specs/archive/` 경로는 리다이렉트 전용 호환 stub로 취급한다.
- 레거시 참조가 활성 파일과 아카이브 파일 모두를 가리킬 때, 활성(비-아카이브)
  파일이 정본 대상이다.

## 마이그레이션 맵

| 레거시 참조 라벨 | 정본 경로 | 마이그레이션 상태 | 비고 |
| --- | --- | --- | --- |
| 과거 루트 methodology-origin spec | `specs/CURRENT/methodology-skill-admission-governance.md` | 마이그레이션됨 | 현재 구현 응대 기록 |
| 과거 루트 always-on conversational platform spec | `specs/CURRENT/discord-control-plane-always-on.md` | 마이그레이션됨 | 현재 구현 응대 기록 |
| 과거 Codex 부트스트랩/인증 분리 노트 | `specs/CURRENT/codex-sdk-runtime-bootstrap.md` | 마이그레이션됨 | 현재 정본 상세 부트스트랩 spec |
| 과거 루트 OpenClaw gap spec | `specs/CURRENT/openclaw-gap-implementation.md` | 마이그레이션됨 | 현재 능력 상태 기록 |
| 과거 루트 scaffold adapter/driver/trait 클라리피케이션 | `specs/CLARIFICATIONS/scaffold-adapter-driver-trait-definitions.md` | 마이그레이션됨 | 구속 클라리피케이션 + 역사적 분류 흔적 |
| 과거 루트 작업 단위, 마이그레이션, 스모크, 강화, 트래커 spec | `specs/ARCHIVE/` | 아카이브됨 | 역사 전용 |
| 과거 소문자 archive 트리 | `specs/ARCHIVE/` | 리다이렉트됨 | `specs/archive/` 아래 새 문서 두지 말 것 |
| 과거 소문자 GitHub 측 import archive 트리 | `specs/ARCHIVE/github-specs/` | 리다이렉트됨 | 소문자 리다이렉트 경로 아래 새 문서 두지 말 것 |
| 과거 `documents/` 최상위 historical 문서 (`ARCHITECTURE.md`, `ARCHITECTURE_OVERVIEW.md`, `MIGRATION_MAP.md`, `REMOTE_NODE_PROTOCOL.md`, `LLM_PROVIDER_ARCHITECTURE.md`, `DEPLOYMENT.md`, `PROJECT.md`) | `documents/archive/2026-04-cleanup-into-specs-v1/top-level/` | 아카이브됨 | 현재 진실은 `specs/CURRENT/`, `specs/CLARIFICATIONS/`, root `README.md` |
| 과거 `documents/drafts/` 트리 (DT-Council/v1 아키텍처 초안) | `documents/archive/2026-04-cleanup-into-specs-v1/drafts/` | 아카이브됨 | 현재 적용 디자인은 `specs/CURRENT/architecture-hexagonal-microkernel.md`와 `src/` 코드 |
| 과거 `documents/final/arona-plana-redesign-spec.md` | `documents/archive/2026-04-cleanup-into-specs-v1/final/` | 아카이브됨 | 현재 정본은 `specs/CURRENT/`와 `specs/CONTRACTS/`로 분산 정제됨 |
| 과거 `documents/audits/` 시점 보고서 | `documents/archive/2026-04-cleanup-into-specs-v1/audits/` | 아카이브됨 | 종결된 WU-H/WU-P 감사와 시점 패키지/Discord helper 검증 |
| 과거 `documents/plans/` 비활성 계획 (post-Track-b, M8 Phase 2, P3·P4 메모리 등) | `documents/archive/2026-04-cleanup-into-specs-v1/plans/` | 아카이브됨 | 활성 plan은 `documents/plans/AUTO_ARCHIVE_OPENCLAW_GAP_REMAINING_PLAN_2026-04-27.md` 한 건만 유지 |
| 과거 `documents/archived/KERNEL_ARCHITECTURE_PLAN.md` 단일 트리 | `documents/archive/2026-04-cleanup-into-specs-v1/archived/` | 통합 아카이브됨 | documents 내 두 곳에 흩어져 있던 archive 트리를 단일 archive 버킷으로 통합 |

## 읽기 순서

1. `specs/README.md`
2. 관련 `CURRENT/` 문서
3. 참조된 `CONTRACTS/`
4. 참조된 `CLARIFICATIONS/`
5. 필요할 때만 `GUIDES/`
6. 역사적 흔적 용도의 `ARCHIVE/`
