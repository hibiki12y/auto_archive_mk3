---
status: pointer
authority: pointer-only
last_verified: 2026-04-29
source_paths:
  - README.md
  - src/core/gitlab-project-manager.ts
  - src/core/arona.ts
scope: 현재 브랜치의 GitLab 프로젝트 배정 워크플로에 대한 빠른 운영자/spec 포인터.
---

# 가이드: GitLab 프로젝트 배정 워크플로

## 사용 시점

GitLab 프로젝트 배정과 작업 결과 기록이 디스패치 흐름에 어떻게 결합하는지에
대한 짧은 요약이 필요할 때 본 가이드를 사용한다.

## 사전 조건

- GitLab 통합이 활성화되고 설정되어 있음
- 고정 프로젝트 모드와 배정 모드 중 어느 것을 원하는지 인지
- 라이브 셋업 단계가 필요하면 자세한 운영 가이드를 보유

## 워크플로 요약

1. GitLab 통합을 활성화한다.
2. 고정 프로젝트 모드 또는 배정 모드를 선택한다.
3. 태스크 범위 작업을 위해 선택적으로 프로젝트 자동 생성을 활성화한다.
4. Arona가 프로젝트 배정을 디스패치 plan에 부착하도록 둔다.
5. 완료를 이슈 또는 노트로 기록하되, GitLab 장애를 디스패치 실패로 만들지
   않는다.

## 운영자 노트

- `AUTO_ARCHIVE_GITLAB_TOKEN_ENV`를 통한 토큰 간접 참조가 권장됨
- 배정은 디스패치에 부가적이며 정상 완료를 대체하지 않음
- 작업 결과 기록은 사이드카 약속이며 독립적으로 실패할 수 있음

## 권한 노트

본 가이드는 포인터 전용이다. 현재 구현 진실은 `README.md`와 소스 파일에 머무른다.
라이브 셋업/runbook 상세는 아래 documents 가이드에 있다.

## 주요 동반 문서

- `documents/guides/GITLAB_CONNECTION_TEST_GUIDE.md`
