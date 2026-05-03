---
status: stable
authority: external-code-reference
last_verified: 2026-05-01
source_paths:
  - resource/hermes-agent/batch_runner.py
scope: Hermes Agent batch runner subsystem의 reference material. auto_archive_mk3 동작에 대한 contract가 아니며 참조 전용.
---

# 08 — Batch Runner

## 1. Purpose & Boundary

`batch_runner.py`(1287 LOC)는 멀티프롬프트 데이터셋(JSONL)을 multiprocessing Pool로 병렬 실행하고, trajectory와 tool usage 통계를 일관된 schema로 저장하는 batch orchestrator다. RL training 데이터 수집과 평가용으로 사용되며, 체크포인트 기반 resumption / per-prompt container image override / toolset distribution sampling을 지원한다. **auto_archive_mk3는 batch RL/dataset processing이 범위 밖**이므로 본 문서는 SKIP 결정의 근거 정리용이다.

## 2. Source Anchors

| 항목 | 위치 |
| --- | --- |
| 모듈 docstring + CLI 사용법 | `resource/hermes-agent/batch_runner.py:1-21` |
| Worker 전역 config dict | `resource/hermes-agent/batch_runner.py:48` |
| `ALL_POSSIBLE_TOOLS` 자동 파생 | `resource/hermes-agent/batch_runner.py:50-54` |
| `DEFAULT_TOOL_STATS` 스키마 | `resource/hermes-agent/batch_runner.py:57` |
| `_normalize_tool_stats()` (count/success/failure) | `resource/hermes-agent/batch_runner.py:60-87` |
| `_normalize_tool_error_counts()` | `resource/hermes-agent/batch_runner.py:90-111` |
| 단일 prompt 처리 함수 docstring | `resource/hermes-agent/batch_runner.py:240-249` |
| Per-prompt container image override | `resource/hermes-agent/batch_runner.py:254-299` |

## 3. Architecture Sketch

CLI는 fire(line 36)로 진입점이 노출되며 다음 인자를 받는다(line 13-21):
- `--dataset_file=<path>.jsonl` — 프롬프트 한 줄당 JSON 객체(`prompt`, optional `image`/`docker_image`/`cwd`).
- `--batch_size=<int>` — Pool 워커가 동시에 처리할 prompt 수.
- `--run_name=<string>` — checkpoint 디렉터리 식별자.
- `--distribution=<name>` (옵션) — `toolset_distributions`(line 39-43)에서 정의한 toolset 샘플링 분포.
- `--resume` — 중단된 run 재개.

흐름:
1. **Bootstrap**: `_WORKER_CONFIG`에 agent 설정을 채워 worker pool에 전달(line 48).
2. **Tool 스키마 고정**: `ALL_POSSIBLE_TOOLS = set(TOOL_TO_TOOLSET_MAP.keys())`로 가능한 도구 집합을 자동 파생(line 50-54). HuggingFace Arrow/Parquet 로드 시 schema mismatch를 막기 위해 모든 trajectory가 동일 키 세트를 갖도록 정규화한다.
3. **Per-prompt 실행**: `process_single_prompt()`가 prompt를 받아 (a) `image`/`docker_image` 필드가 있으면 컨테이너를 사전 풀(line 254-291), (b) `register_task_env_overrides()`로 docker/modal/singularity/daytona 4-backend 동시 설정(line 292-299), (c) `AIAgent`(`run_agent.py`) 인스턴스로 작업 실행, (d) trajectory + tool stats 반환.
4. **Aggregation**: 모든 결과를 정규화된 schema로 모아 JSONL trajectory 파일과 tool stats 요약을 출력. 각 도구는 `{count, success, failure}` 3-필드(line 57)로 통계화되며 사용되지 않은 도구는 zero default.
5. **Checkpointing**: 배치 단위로 진행 상태를 저장해 `--resume`로 이어서 진행 가능.

## 4. Key Invariants

1. **모든 trajectory는 동일 tool schema** — `ALL_POSSIBLE_TOOLS` 전체에 대해 `{count, success, failure}` dict가 항상 존재(zero fill, line 76-80). HuggingFace dataset loader가 schema mismatch로 깨지지 않도록 강제.
2. **자동 sync** — `TOOL_TO_TOOLSET_MAP`(line 44, model_tools.py)에 새 도구가 추가되면 `ALL_POSSIBLE_TOOLS`도 자동 확장. 정규화 로직 line 83-85가 예상 외 도구를 그대로 보존.
3. **Container image precedence** — `image` 필드가 우선이고, 없으면 `docker_image` fallback(line 256). 적용 시 docker/modal/singularity/daytona 4-backend 모두에 같은 image를 등록(line 292-298).
4. **Image 사전 검증** — Docker backend(`TERMINAL_ENV=docker`, line 261)에서는 `docker image inspect` 후 미존재 시 `docker pull`로 미리 받아 토큰 낭비를 방지(line 263-285).
5. **Worker 격리** — `_WORKER_CONFIG`는 multiprocessing initializer로만 채워지며, agent 실행 중 worker 간 상태 공유는 없다.

## 5. Notable Constants & Defaults

| 이름 | 값/위치 | 비고 |
| --- | --- | --- |
| `_WORKER_CONFIG` | `{}` (Pool initializer로 채움) | line 48 |
| `ALL_POSSIBLE_TOOLS` | `set(TOOL_TO_TOOLSET_MAP.keys())` | line 54, 자동 파생 |
| `DEFAULT_TOOL_STATS` | `{'count': 0, 'success': 0, 'failure': 0}` | line 57 |
| `TERMINAL_ENV` env var (image 사전 검증 트리거) | `"docker"` | line 261 |
| Docker pull timeout | 600초 | line 274 |
| Docker inspect timeout | 10초 | line 268 |

## 6. Comparison to auto_archive_mk3

| 측면 | Hermes | auto_archive_mk3 |
| --- | --- | --- |
| 적용 목적 | RL training/eval batch | 해당 없음 |
| 병렬 모델 | multiprocessing Pool + JSONL | 미적용 |
| Tool stats schema | `{count, success, failure}` 정규화 | 미적용 (단, 패턴은 InsightsEngine 후보) |
| Container backend 처리 | docker/modal/singularity/daytona 4종 | 우리 환경엔 backend 추상이 없음 |
| Resume 정책 | per-batch checkpoint | 미적용 |

## 7. Adoption Notes

**SKIP — out of auto_archive_mk3 scope.** 우리 로드맵에는 batch dataset 처리가 없으며, 단일 인터랙티브 세션이 주된 형태. 다만 다음 한 가지 패턴은 인접 M-item 작업 시 참조 가치가 있다.

- **Tool stats 정규화 (count/success/failure)** — InsightsEngine(M6, doc 14)에서 도구 사용 텔레메트리 schema를 정의할 때 동일한 3-필드 구조를 채택할 수 있다. 그러나 본 batch_runner의 코드를 verbatim 차용하지는 않는다. 본 항목은 "패턴 인지" 수준이며 별도 M-item으로 끌어올리지 않는다.

연관 M-item: 없음 (M6 작업 시 §8의 패턴만 인지하고 진행).

## 8. Pitfalls / Anti-Patterns Observed

- **Schema drift on dataset load** — trajectory 간 tool 키 집합이 다르면 HF Arrow/Parquet loader가 mismatch로 실패. 모든 도구 zero-fill 패턴(line 76-80)이 정답.
- **Image 검증 없이 진행 → 토큰 낭비** — 컨테이너 부재를 agent 루프 진입 후 알면 LLM 호출 비용이 이미 발생. 사전 `docker image inspect` + pull(line 263-285)이 강한 가드.
- **Backend별 분기 누락** — `register_task_env_overrides()`는 docker/modal/singularity/daytona 4종에 동일 image를 동시 등록(line 292-298). 일부만 처리 시 silent skip.
- **Worker config 전역 dict** — `_WORKER_CONFIG={}`(line 48)는 multiprocessing initializer 패턴이지만 module-level 가변 상태이므로 테스트 격리 주의.
