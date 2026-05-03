---
status: superseded
authority: binding-clarification
last_verified: 2026-04-30
superseded_by: specs/CLARIFICATIONS/multi-provider-scope.md
source_paths:
  - README.md
  - specs/CURRENT/codex-sdk-runtime-bootstrap.md
  - src/runtime/codex-bootstrap-settings.ts
  - src/runtime/codex-runtime-adapter.ts
scope: 프로바이더 범위에 대한 짧은 구속 명확화 (deprecated, multi-provider-scope.md로 이전).
---

> **본 명확화는 2026-04-30자로 supersede됨.** Codex SDK 단일 정책이 Codex + Claude Agent 이중 프로바이더로 확장되었습니다. 정본은 `multi-provider-scope.md` 참조.


# Codex SDK 프로바이더 범위

문서나 검토가 부트스트랩 입력 선택을 프로바이더 다중화와 혼동할 때 본 명확화를
사용한다. 정본 상세 현재 동작은 `../CURRENT/codex-sdk-runtime-bootstrap.md`에
있다.

## 구속 진술

현재 프로바이더 범위는 **Codex SDK 단일**이다.

## 범위 내

- `@openai/codex-sdk` 런타임 실행
- 우선되는 자격 증명 소스로서의 Codex CLI 로컬 인증
- 동일 런타임 경로에 대한 문서화된 환경 변수/부트스트랩 오버라이드

## 범위 외

- 두 번째 런타임/프로바이더로서의 Codex CLI
- 프로바이더 다중 추상화
- 현재 브랜치 런타임으로서의 OpenAI 도구 호출 브리지
- 부트스트랩 경로 선택을 프로바이더 선택과 동일시하는 모든 주장

## 운영적 결과

인증, 모델, 부트스트랩 입력은 다양할 수 있지만, 런타임 프로바이더는 동일한
Codex SDK 경로로 유지된다.

## 주요 동반 문서

- `../CURRENT/codex-sdk-runtime-bootstrap.md`
