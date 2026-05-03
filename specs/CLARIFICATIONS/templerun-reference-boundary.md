---
status: ratified
authority: binding-clarification
last_verified: 2026-04-29
source_paths:
  - README.md
  - specs/CLARIFICATIONS/scaffold-adapter-driver-trait-definitions.md
  - src/contracts/trait-module.ts
  - src/contracts/capability-flag.ts
  - src/contracts/methodology-skill.ts
  - tests/agent-methodology-origin-integration.spec.ts
scope: 정본 구속 명확화로 되돌아가는 짧은 templerun 경계 리마인더.
---

# Templerun 참조 경계

본 문서는 templerun에 한정된 짧은 리마인더로 사용한다. 정본 구속 보정 프레임은
`./scaffold-adapter-driver-trait-definitions.md` §0에 있다.

## 구속 진술

`resource/templerun`은 **참조 전용**이다.

## 다음에 해당하지 않음

- 런타임 의존성
- 프로바이더
- 프롬프트 출처의 진실 소스
- 인프로세스 컴포넌트
- import 가능한 브랜치 소유 실행 표면

## 허용된 사용

- 문서 작성 시 비교
- 용어 보정
- 방법론 계보/출처 매핑 논의

## 금지된 사용

- `src/`에서 templerun 자료를 import하거나 실행
- 지시 텍스트를 런타임 프롬프트나 코드로 복사
- templerun을 부트스트랩 모드, 프로바이더 셀렉터, 또는 필수 의존성으로 표현

## 도출 규칙

현재 브랜치의 진실은 저장소 소유 계약, 가이드, spec으로 진술되어야 한다.
templerun은 인간 해석에 정보를 줄 수는 있지만 결코 부하를 지는 런타임 의존성이
되지 않는다.
