---
status: stable
authority: external-code-reference
last_verified: 2026-05-01
source_paths:
  - resource/hermes-agent/trajectory_compressor.py
scope: Hermes Agent trajectory compression subsystem의 reference material. auto_archive_mk3 동작에 대한 contract가 아니며 참조 전용.
---

# 07 — Trajectory Compression

## 1. Purpose & Boundary

`trajectory_compressor.py`(1508 LOC)는 **완료된** agent trajectory를 RL training용 token budget(기본 15,250 tokens)에 맞게 사후 압축하는 batch 스크립트다. 라이브 conversation의 mid-session compaction과는 완전히 별개이며, JSONL 입출력 + multiprocessing pool로 대용량 데이터셋을 처리한다. **auto_archive_mk3는 RL training이 범위 밖**이므로 본 문서는 SKIP 결정의 근거 정리용이다.

## 2. Source Anchors

| 항목 | 위치 |
| --- | --- |
| 모듈 docstring + 압축 전략 1~6단계 | `resource/hermes-agent/trajectory_compressor.py:1-31` |
| CLI 사용 예시 (--input, --sample_percent) | `resource/hermes-agent/trajectory_compressor.py:16-30` |
| `_effective_temperature_for_model()` shim | `resource/hermes-agent/trajectory_compressor.py:59-79` |
| `CompressionConfig` dataclass | `resource/hermes-agent/trajectory_compressor.py:82-124` |
| Tokenizer 기본값 (Kimi-K2-Thinking) | `resource/hermes-agent/trajectory_compressor.py:86` |
| 압축 타깃 + 보호 turn 설정 | `resource/hermes-agent/trajectory_compressor.py:90-99` |
| Summarization model + OpenRouter 구성 | `resource/hermes-agent/trajectory_compressor.py:101-106` |
| YAML config loader | `resource/hermes-agent/trajectory_compressor.py:125-149` |

## 3. Architecture Sketch

처리 단계는 docstring에 6 step으로 명문화되어 있다(line 8-14):

1. **첫 turn 보호** — system / first human / first gpt / first tool은 항상 보존 (line 94-97).
2. **마지막 N turn 보호** — 기본 4개의 종결부 turn은 그대로 유지 (line 98).
3. **중간 구간만 압축** — 두 번째 tool response부터 압축 후보, 필요한 만큼만(target 도달 시 중지).
4. **단일 human summary로 치환** — 압축 영역을 LLM 요약(750 tokens 목표) 단일 메시지로 교체.
5. **나머지 tool call 보존** — summary 이후의 tool 호출은 그대로 둬서 모델이 이어서 작업 가능.
6. **Notice 부착** — `summary_notice_text`("...your previous tool responses may be summarized...", line 110)를 시스템에 안내.

CLI는 fire(line 45)로 배포되며 directory 또는 단일 JSONL을 받는다. multiprocessing Pool(num_workers=4 기본, line 114)로 trajectory별 병렬 처리하고, async semaphore(max 50 concurrent, line 115)로 OpenRouter API 호출을 throttle한다. Tokenizer는 huggingface `moonshotai/Kimi-K2-Thinking`(line 86, `trust_remote_code=True`)에 의존.

## 4. Key Invariants

1. **First-N + Last-N 두 끝은 절대 손대지 않는다** — RL trajectory의 학습 신호는 시작(작업 정의)과 종결(결과 행동)에 농축돼 있어 보존이 곧 품질이다(line 94-99).
2. **압축은 필요한 만큼만** — `skip_under_target=True`(line 116)이면 target 미만 trajectory는 통과. `save_over_limit=True`(line 117)이면 압축 후 여전히 초과해도 저장.
3. **Single summary message** — 중간 구간을 잘게 잘라 여러 메시지로 교체하지 않고 하나의 human 메시지로 치환한다(line 13). Conversation flow는 selectively human → assistant → tool 패턴을 유지.
4. **Per-trajectory timeout** — 기본 300초(5 min, line 118)로 hang 방지.
5. **Tokenizer trust_remote_code 필수** — Kimi tokenizer는 `trust_remote_code=True` 설정 없이는 로드 실패(line 87).

## 5. Notable Constants & Defaults

| 이름 | 값 | 비고 |
| --- | --- | --- |
| `tokenizer_name` | `moonshotai/Kimi-K2-Thinking` | line 86 |
| `target_max_tokens` | 15,250 | line 90 |
| `summary_target_tokens` | 750 | line 91 |
| `protect_last_n_turns` | 4 | line 98 |
| `summarization_model` | `google/gemini-3-flash-preview` | line 101 |
| `base_url` | `OPENROUTER_BASE_URL` | line 102 |
| `api_key_env` | `OPENROUTER_API_KEY` | line 103 |
| `temperature` | 0.3 | line 104 |
| `max_retries` | 3 | line 105 |
| `num_workers` | 4 | line 114 |
| `max_concurrent_requests` | 50 | line 115 |
| `per_trajectory_timeout` | 300s | line 118 |

## 6. Comparison to auto_archive_mk3

| 측면 | Hermes | auto_archive_mk3 |
| --- | --- | --- |
| 적용 목적 | RL training data 후처리 | 해당 없음 (RL 미수행) |
| 적용 시점 | trajectory 완료 후 batch | 라이브 compaction은 별도 — doc 03 참조 |
| Tokenizer | huggingface Kimi-K2 | 미적용 |
| 출력 형식 | JSONL with `_compressed` suffix | 미적용 |
| 보호 정책 | first system/human/gpt/tool + last 4 | 우리 compaction에는 직접 매핑 X |

## 7. Adoption Notes

**SKIP — out of auto_archive_mk3 scope.** RL training pipeline이 우리 로드맵에 없으며, 라이브 conversation compaction은 doc 03(`memory-state-sessiondb`)에서 다룬 session_id rotation 패턴으로 충분하다. 미래에 데이터셋 사후 처리가 필요해진다면 본 문서를 다시 참조한다.

연관 M-item: 없음.

## 8. Pitfalls / Anti-Patterns Observed

본 모듈은 사후 batch 도구이므로 라이브 시스템에 적용되는 anti-pattern 관찰은 제한적이다. 참고용 메모만 둔다.

- **Hardcoded summarization model + provider** — `google/gemini-3-flash-preview` + OpenRouter 고정(line 101-103). 라이브 시스템이라면 provider routing(doc 06)을 거쳐야 하지만 batch 도구 특성상 단순 hardcode가 더 이해 가능. 우리가 비슷한 batch 도구를 만든다면 같은 trade-off.
- **Tokenizer 의존성 = remote code 실행** — `trust_remote_code=True`는 Kimi tokenizer 로드를 위해 필수지만 임의 코드 실행 surface가 됨. 격리된 환경에서만 실행하는 게 안전.
