---
status: current
authority: implementation-explanation
last_verified: 2026-05-05
source_paths:
  - README.md
  - specs/CLARIFICATIONS/multi-provider-scope.md
  - src/runtime/codex-bootstrap-settings.ts
  - src/runtime/codex-runtime-adapter.ts
  - src/runtime/runtime-driver-factory.ts
  - src/core/compute-node-factory.ts
scope: 현재 브랜치의 Codex provider branch 부트스트랩 동작, 인증 우선순위, 제한된 settings 파일 지원, 그리고 컴퓨트 노드 부트스트랩 선택의 정본.
replaces: 현재는 클라리피케이션·가이드 포인터 문서로 요약된 과거의 Codex 부트스트랩/인증 분리 노트
---

# Codex SDK 런타임 부트스트랩

본 문서는 이 브랜치에서 Codex 부트스트랩에 대한 정본 상세 현재-구현 spec이다.
Codex provider branch의 인증·settings·모델 override 동작을 확인할 때 이 문서를
사용한다. 전체 런타임 provider 선택 범위의 정본은
`../CLARIFICATIONS/multi-provider-scope.md`이며, 과거
`../CLARIFICATIONS/codex-sdk-provider-scope.md`는 superseded historical
reference이다. 가이드 `../GUIDES/bootstrap-codex-auth-precedence.md`는
요약/포인터 문서일 뿐이다.

## 현재 능력 상태

- 런타임 provider 범위는 bootstrap-time multi-provider seam이다:
  `AUTO_ARCHIVE_RUNTIME_PROVIDER=codex`가 기본값이며,
  `AUTO_ARCHIVE_RUNTIME_PROVIDER=claude-agent`는 별도 Claude Agent provider
  branch를 선택한다.
- 본 문서는 그중 `codex` branch의 우선순위가 가장 높은 Codex CLI 로컬 인증,
  API 키 폴백, 제한된 settings 파일 입력, Codex 모델 override, 그리고 현재의
  컴퓨트 노드 선택을 설명한다.
- `AUTO_ARCHIVE_RUNTIME_PROVIDER=claude-agent`가 선택된 경우 본 Codex 인증
  우선순위는 적용되지 않는다. Claude Agent branch의 인증·모델 입력은
  `../CLARIFICATIONS/multi-provider-scope.md`와 README의 runtime provider bootstrap
  section을 따른다.
- Codex branch 안에서의 인증·settings 선택은 provider switching이나 runtime
  fan-out을 의미하지 않는다.

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
- Codex 인증·settings 입력을 provider routing 신호로 취급
- settings 파일이 임의의 모델/설정 키를 받는 동작
- Codex branch 내부의 부트스트랩 소스 선택을 provider 선택으로 간주
- mid-flight provider switching 또는 runtime fan-out/council execution

## 컴퓨트 노드 관계

`AUTO_ARCHIVE_COMPUTE_NODE`는 현재 다음과 같이 해석된다.

- 미설정 / `slurm-apptainer` → `SlurmApptainerComputeNode`
- `git-clone` → `GitLabCloneComputeNode`
- `current-node` → `CurrentNodeComputeNode`

컴퓨트 노드 선택은 provider 범위와 직교한다. `runtime-driver-factory`가
bootstrap 시점에 `codex` 또는 `claude-agent` driver를 고른 뒤에도 compute node
선택은 같은 방식으로 적용된다.

## 불변식

1. Codex CLI 인증 우선순위는 두 번째 provider를 만들지 않으며,
   `AUTO_ARCHIVE_RUNTIME_PROVIDER` 선택을 우회하지 않는다.
2. settings 파일 지원은 좁고 fail-closed를 유지한다.
3. 환경 변수는 겹치는 settings 파일 키보다 우선권을 유지한다.
4. 지원하지 않는 컴퓨트 노드 값은 throw한다.
5. provider는 서비스 bootstrap 시점에 한 번만 선택되며 dispatch 중간에 전환하지
   않는다.

## 동반 문서

- provider 범위 정본: `../CLARIFICATIONS/multi-provider-scope.md`
- 과거 단일-provider 기록: `../CLARIFICATIONS/codex-sdk-provider-scope.md`
  (superseded historical reference)
- 빠른 우선순위 포인터: `../GUIDES/bootstrap-codex-auth-precedence.md`
- 컴퓨트 노드 어휘: `../CLARIFICATIONS/compute-node-slurm-apptainer-unification.md`

## 테스트 경계

- `tests/` 하위 Codex 부트스트랩 및 어댑터 테스트
- `current-node`용 컴퓨트 노드 부트스트랩 테스트
