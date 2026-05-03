---
status: stable
authority: stable-contract-interpretation
last_verified: 2026-04-29
version: 1.0.0
source_paths:
  - src/contracts/runtime-driver.ts
scope: 라이프사이클 오케스트레이션이 소비하는 runtime-driver 포트의 안정적 해석.
---

# Runtime Driver 인터페이스

## 목적

라이프사이클 오케스트레이션이 소비하고 런타임 어댑터가 구현하는 runtime-driver
포트를 정의한다.

## 계약

- `RuntimeDriver.run(context)`는 단일 진입점이다.
- `RuntimeExecutionContext`는 plan, agent instance, 이벤트 발행, 승인 요청,
  abort 상태 검사를 제공한다.
- `RuntimeDriverResult.cause`는 필수이며 드라이버 경계에서 종료 상태를 전달하는
  권한 있는 캐리어이다.

## 라이프사이클 / 불변식

1. 하나의 드라이버 호출은 하나의 논리 실행에 매핑된다.
2. 종료 원인은 임시 문자열에서 추론되지 않고 구조화되어 있다.
3. 취소와 거부 표면은 `RuntimeCancellationBoundary`를 통해 명시적으로
   유지된다.

### Carry-forward 예외 (OQ-V4)

`external-cancel` cause는 boundary에서 outcome `abort`로 lift된다. 이는 cause↔outcome 매핑의 carry-forward 예외이며, `RuntimeDriverResult.cause` 유니온이 `TerminalCauseExternalCancel`을 보존하는 근거이다. 정렬 위치: `src/contracts/runtime-driver.ts:69-87` JSDoc.

## 테스트 경계

- 구조화된 cause 전파와 fail-closed 동작을 단언하는 `tests/` 하위 드라이버
  및 어댑터 테스트.
