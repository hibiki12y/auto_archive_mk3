---
status: stable
authority: stable-contract-interpretation
last_verified: 2026-04-30
version: 1.1.0
source_paths:
  - src/contracts/dispatch-lifecycle.ts
scope: 디스패치 라이프사이클 관찰 어휘의 안정적 해석.
---

# 디스패치 라이프사이클 계약

## 목적

dispatcher, runtime, compute-node 옵저버가 공유하는 라이프사이클 관찰 어휘를
정의한다.

## 계약

- 단계: `accepted`, `admission-denied`, `runtime-entering`, `runtime-running`,
  `settling`, `terminal`.
- `taskId`는 불투명한 전송 데이터이며 옵저버가 파싱해서는 안 된다.
- 옵저버는 기본적으로 권고적이다. 권한은 명시적 옵트인을 요구한다.

## 라이프사이클 / 불변식

1. 종료 관찰은 `cause`를 동반할 수 있다. 종료 이전 단계는 `cause` 부재를 견뎌야
   한다.
2. 권고 옵저버 실패는 디스패치 상태를 변경해서는 안 된다.
3. 권한과 감사 의미는 계약상 가시적으로 유지된다.
4. **(R8 / 1.1.0)** admission gate 가 deny 한 submission 은
   `accepted` → `admission-denied` → `terminal` 순서로 emit 한다. T1
   (DispatcherEntry) short-circuit 과 post-allocate `AdmissionDeniedError`
   flip 모두 동일 시퀀스를 따라야 한다 — `runtime-entering` 이후 단계는 생략된다.

## 테스트 경계

- `tests/` 하위 옵저버 권한과 라이프사이클 fan-out 테스트.
