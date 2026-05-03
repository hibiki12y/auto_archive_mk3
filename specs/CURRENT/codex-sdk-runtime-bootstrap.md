---
status: current
authority: implementation-explanation
last_verified: 2026-04-29
source_paths:
  - README.md
  - src/runtime/codex-bootstrap-settings.ts
  - src/runtime/codex-runtime-adapter.ts
  - src/core/compute-node-factory.ts
scope: 현재 브랜치의 Codex SDK 부트스트랩 동작, 인증 우선순위, 제한된 settings 파일 지원, 그리고 컴퓨트 노드 부트스트랩 선택의 정본.
replaces: 현재는 클라리피케이션·가이드 포인터 문서로 요약된 과거의 Codex 부트스트랩/인증 분리 노트
---

# Codex SDK 런타임 부트스트랩

본 문서는 이 브랜치에서 Codex 부트스트랩에 대한 정본 상세 현재-구현 spec이다.
현재 동작을 확인할 때 이 문서를 사용한다. 동반 문서인 클라리피케이션
`../CLARIFICATIONS/codex-sdk-provider-scope.md`와 가이드
`../GUIDES/bootstrap-codex-auth-precedence.md`는 요약/포인터 문서일 뿐이다.

## 현재 능력 상태

- 런타임 프로바이더 범위는 **Codex SDK 단일**이다.
- 부트스트랩은 우선순위가 가장 높은 Codex CLI 로컬 인증, API 키 폴백, 제한된
  settings 파일 입력, 그리고 현재의 컴퓨트 노드 선택을 지원한다.
- 부트스트랩 선택은 프로바이더 다중화나 두 번째 런타임을 의미하지 않는다.

## 인증 우선순위

1. 유효한 `~/.codex/auth.json`
2. `AUTO_ARCHIVE_CODEX_API_KEY`
3. 검출된 자격 증명 없음

양성으로 검출된 CLI 인증이 손상되었거나 읽을 수 없으면 fail-closed로 끝난다.
조용히 API 키 부트스트랩으로 다운그레이드하지 않는다.

## 지원 입력

| 입력 | 의미 | 비고 |
| --- | --- | --- |
| `AUTO_ARCHIVE_CODEX_API_KEY` | API 키 폴백 자격 증명 소스 | 유효한 로컬 Codex 인증이 없을 때만 사용 |
| `AUTO_ARCHIVE_CODEX_CLI_PATH` | 선택적 Codex CLI 경로 오버라이드 | 부트스트랩 지원일 뿐, 별도 프로바이더가 아님 |
| `AUTO_ARCHIVE_CODEX_SETTINGS_FILE` | 선택적 운영자 작성 JSON 설정 파일 | JSON 전용. `apiKey`와 `codexPathOverride`로 한정. 키가 겹치면 환경 변수가 우선함 |
| `AUTO_ARCHIVE_CODEX_MODEL` | 선택적 기본 모델 오버라이드 | 환경 변수 전용 런타임 오버라이드 |
| `AUTO_ARCHIVE_CODEX_MODEL_FALLBACK` | 선택적 일회성 폴백 모델 | 모델 한정 영구 설정 실패 후 재시도 시에만 사용 |
| `AUTO_ARCHIVE_CODEX_REASONING_EFFORT` | 선택적 추론 effort 오버라이드 | 환경 변수 전용 런타임 오버라이드 |

## 지원하지 않는 해석

- Codex CLI를 별도 런타임/프로바이더로 취급
- 다중 프로바이더 부트스트랩 라우팅
- settings 파일이 임의의 모델/설정 키를 받는 동작
- 부트스트랩 소스 선택을 프로바이더 선택으로 간주

## 컴퓨트 노드 관계

`AUTO_ARCHIVE_COMPUTE_NODE`는 현재 다음과 같이 해석된다.

- 미설정 / `slurm-apptainer` → `SlurmApptainerComputeNode`
- `git-clone` → `GitLabCloneComputeNode`
- `current-node` → `CurrentNodeComputeNode`

컴퓨트 노드 선택은 프로바이더 범위와 직교한다. 이 브랜치는 여전히 단일 프로바이더
경로(Codex SDK)를 사용한다.

## 불변식

1. Codex CLI 인증 우선 순위는 두 번째 프로바이더를 만들지 않는다.
2. settings 파일 지원은 좁고 fail-closed를 유지한다.
3. 환경 변수는 겹치는 settings 파일 키보다 우선권을 유지한다.
4. 지원하지 않는 컴퓨트 노드 값은 throw한다.

## 동반 문서

- 클라리피케이션 요약: `../CLARIFICATIONS/codex-sdk-provider-scope.md`
- 빠른 우선순위 포인터: `../GUIDES/bootstrap-codex-auth-precedence.md`
- 컴퓨트 노드 어휘: `../CLARIFICATIONS/compute-node-slurm-apptainer-unification.md`

## 테스트 경계

- `tests/` 하위 Codex 부트스트랩 및 어댑터 테스트
- `current-node`용 컴퓨트 노드 부트스트랩 테스트
