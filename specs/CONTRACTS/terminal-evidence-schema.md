---
status: stable
authority: stable-contract-interpretation
last_verified: 2026-04-29
version: 1.0.0
source_paths:
  - src/contracts/terminal-evidence.ts
  - src/contracts/terminal-cause.ts
scope: 디스패치마다 발행되는 지속형 종료 증거 레코드의 안정적 해석.
---

# Terminal Evidence 스키마

## 목적

각 디스패치에 대해 발행되는 지속형 종료 레코드를 정의한다.

## 계약

- `TerminalEvidence.cause`는 필수이다.
- `executionContext`, `resourceEnvelope`, 타임스탬프, provenance, 그리고 reason은
  항상 함께 전달된다.
- `abort`는 거부 형태의 종료 원인에 한해서만 유효하다.
- transcript, warnings, 관찰된 자원, 그리고 산출물 위치는 부가 증거 필드이다.

## 라이프사이클 / 불변식

1. 하나의 디스패치는 하나의 종료 증거 레코드로 정착한다.
2. 구조화된 cause가 종료 분류를 소유한다.
3. abort 상세는 abort가 아닌 cause에 나타나서는 안 된다.

### Carry-forward 예외 (OQ-V4 정렬)

`external-cancel` cause는 outcome `abort`로 lift된다. `abort`는 거부 형태 cause에서만 유효하다는 §3 규칙은 boundary lifting 이후의 outcome 표기에 적용되며, cause 자체에는 `external-cancel`이 보존된다. 정본 carry-forward 노트는 `runtime-driver-interface.md`에 있다.

## 테스트 경계

- 종료 증거와 cause 매핑을 구성하거나 검증하는 dispatcher/runtime 테스트.
