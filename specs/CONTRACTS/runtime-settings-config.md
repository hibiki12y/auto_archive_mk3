---
status: stable
authority: stable-contract-interpretation
last_verified: 2026-04-29
version: 1.0.0
source_paths:
  - src/contracts/runtime-settings.ts
  - src/contracts/network-policy.ts
  - src/runtime/codex-bootstrap-settings.ts
scope: 신뢰된 런타임 설정과 경계가 정해진 부트스트랩 설정 입력의 안정적 해석.
---

# Runtime Settings Config 계약

## 목적

신뢰된 runtime-settings 번들과 그것에 공급되는 경계가 정해진 부트스트랩 설정
입력을 정의한다.

## 계약

- 런타임 번들 필드: `networkProfile`, `sandboxMode`, `approvalPolicy`, 선택적
  `workingDirectory`, 선택적 `deadlineMs`, 그리고 계산된 `networkProjection`.
- 부트스트랩 settings 파일은 JSON 전용이며 `apiKey` / `codexPathOverride`로
  한정된다.
- 환경 변수/부트스트랩 값은 겹치는 settings 파일 키에 대해 우선권을 유지한다.

## 라이프사이클 / 불변식

1. `createRuntimeSettingsBundle(...)`은 번들을 검증하고 동결한다.
2. 네트워크 프로필 투영은 결정적이다.
3. 손상된 settings 파일 입력은 fail-closed로 끝난다.

## 테스트 경계

- `tests/` 하위 런타임 설정 및 Codex 부트스트랩 테스트.
