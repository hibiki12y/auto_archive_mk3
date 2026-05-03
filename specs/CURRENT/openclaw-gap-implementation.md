---
status: current
authority: implementation-explanation
last_verified: 2026-04-29
source_paths:
  - README.md
  - documents/plans/AUTO_ARCHIVE_OPENCLAW_GAP_REMAINING_PLAN_2026-04-27.md
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
| OC-1B 라이브 승인 라우팅 및 실행 승인 바인딩 | 로컬 구현 | `src/core/runtime-approval-registry.ts`, `src/core/execution-approval-store.ts`, Discord 승인 핸들러, 서비스/스모크 부트스트랩의 Plana 승인 훅 |
| OC-2A 서브에이전트 운영자 표면 | 스캐폴드 구현 | `src/runtime/subagent-operator.ts`, Discord `/subagents` 명령. 깊이는 1로 유지되며 루트 소유 |
| OC-2B 스레드/채널 포커스 바인딩 | 스캐폴드 구현 | `src/discord/discord-session-binding.ts`, `/focus`, `/unfocus`, 스티어링 원장 이벤트 |
| OC-3A 신뢰 기준선 doctor | 로컬 구현 | `src/core/doctor.ts`, `scripts/auto-archive-doctor.mjs`, 확장된 `/doctor` 렌더링 |
| OC-3B GitLab 라이프사이클 강화 | 로컬 구현 | 태스크 프로젝트 README 렌더러, 이슈 종료 증거 섹션, 선택적 Arona list/inspect/archive/follow-up 헬퍼 |
| OC-0 소스/문서 위생 | 적용됨 | 현재 spec 기록과 과거 리다이렉트 위생. 외부 체크아웃 불필요 |

## 현재 비목표

- `allow-always` 실행 승인: 명시적으로 미지원
- 깊이 2 중첩 서브에이전트 spawn: 비활성. `maxSpawnDepth=1` 유지
- GitLab CI 파일 생성: README 메타데이터 전용
- 자격 증명과 라이브 증거 없는 라이브 Discord/GitLab 완료 주장

## 검증 경계

로컬 구현은 다음으로 증명되어야 한다.

- 도구 루프 검출기 단위·런타임 거부 테스트
- 승인 레지스트리와 실행 승인 리플레이/드리프트/만료 테스트
- 서브에이전트 운영자와 세션 바인딩 테스트
- doctor redaction과 GitLab README/이슈 렌더링 테스트
- `pnpm build`와 `pnpm test`

라이브 완료에는 추가로 Docker Discord 서비스 헬스, 라이브 GitLab 발행 태스크 1건,
승인 게이트 경로 1건, focus/follow-up/unfocus 경로 1건, `/doctor` 진단이 필요하다.
