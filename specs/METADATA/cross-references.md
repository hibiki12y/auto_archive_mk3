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

## 마이그레이션 맵

| 레거시 참조 라벨 | 정본 경로 | 마이그레이션 상태 | 비고 |
| --- | --- | --- | --- |
| 과거 루트 methodology-origin spec | `specs/CURRENT/methodology-skill-admission-governance.md` | 마이그레이션됨 | 현재 구현 응대 기록 |
| 과거 루트 always-on conversational platform spec | `specs/CURRENT/discord-control-plane-always-on.md` | 마이그레이션됨 | 현재 구현 응대 기록 |
| 과거 Codex 부트스트랩/인증 분리 노트 | `specs/CURRENT/codex-sdk-runtime-bootstrap.md` | 마이그레이션됨 | 현재 정본 상세 부트스트랩 spec |
| 과거 루트 OpenClaw gap spec | `specs/CURRENT/openclaw-gap-implementation.md` | 마이그레이션됨 | 현재 능력 상태 기록 |
| 과거 루트 scaffold adapter/driver/trait 클라리피케이션 | `specs/CLARIFICATIONS/scaffold-adapter-driver-trait-definitions.md` | 마이그레이션됨 | 구속 클라리피케이션 + 역사적 분류 흔적 |

## 읽기 순서

1. `specs/README.md`
2. 관련 `CURRENT/` 문서
3. 참조된 `CONTRACTS/`
4. 참조된 `CLARIFICATIONS/`
5. 필요할 때만 `GUIDES/`
