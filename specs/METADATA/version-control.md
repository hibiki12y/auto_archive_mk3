---
status: active
authority: spec-governance
last_verified: 2026-04-29
source_paths:
  - specs/README.md
scope: specs 트리에 대한 라이브 vs 역사적 유지 규칙.
---

# Spec 버전 관리

## 모델

- `CURRENT/`는 현재 구현 응대 설명을 기록한다
- `CONTRACTS/`는 안정적 인터페이스 의미를 기록한다
- `CLARIFICATIONS/`는 비준된 용어/경계 결정을 기록한다
- `GUIDES/`는 운영자에게 실행 응대 안내를 가리킨다
- `ARCHIVE/`는 대체되었거나 역사적 자료를 보존한다

## 변경 규칙

의미가 바뀔 때 기존 활성 파일을 갱신하거나 옮긴다. 라이브 사본을 중복으로
남기지 않는다.

## 역사 규칙

spec이 더 이상 라이브 진실은 아니지만 출처 측면에서 여전히 중요할 때, 그 자리에서
히스토리를 다시 쓰지 말고 `ARCHIVE/`로 옮긴다.
