---
status: active
authority: spec-governance
last_verified: 2026-04-29
source_paths:
  - specs/README.md
  - specs/METADATA/cross-references.md
scope: 라이브 spec을 폐기하고 권한 중복 없이 역사적 흔적을 보존하는 규칙.
---

# Spec 폐기 정책

## 다음 경우에 spec을 폐기한다

- 더 이상 현재 브랜치 진실과 일치하지 않을 때
- 더 좁은 계약이나 클라리피케이션이 혼합 상태 계획 문서를 대체할 때
- 실행별 계획이 증거 용도로만 보유될 때

## 폐기 절차

1. 옛 파일을 `ARCHIVE/`로 이동한다.
2. 가능한 곳에서 직접 참조를 갱신한다.
3. 대체 경로를 `specs/METADATA/cross-references.md`에 기록한다.

## 다음을 하지 않는다

- 두 개의 라이브 권한 사본을 유지하지 않는다
- 역사적 종결 기록을 조용히 현재 진실로 다시 쓰지 않는다
