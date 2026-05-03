---
status: stable
authority: external-code-reference
last_verified: 2026-05-01
source_paths:
  - resource/hermes-agent/agent/trajectory.py
scope: Hermes Agent Trajectory Hooks 서브시스템의 reference material. auto_archive_mk3 동작에 대한 contract가 아니며 참조 전용. RL training 범주이므로 SKIP 결정.
---

# Trajectory Hooks

## 1. Purpose & Boundary

`agent/trajectory.py`는 RL training용 trajectory를 JSONL로 append하는 작은 헬퍼 모듈이다. AIAgent 내부에서 ShareGPT 형식 conversation 리스트를 모은 뒤, 종료 시점에 이 모듈로 한 줄을 dump한다. 본 모듈은 trajectory 변환 로직(`_convert_to_trajectory_format`)을 책임지지 않으며 — 그 메서드는 `AIAgent`에 남아 있다 — 오직 **(a) `<REASONING_SCRATCHPAD>` ↔ `<think>` 태그 정적 변환**과 **(b) JSONL append 한 줄 처리**만 담당한다. RL pipeline의 데이터 sink이며 정상 응답 흐름에 영향을 주지 않는다.

## 2. Source Anchors

| 영역 | Citation |
| --- | --- |
| 모듈 docstring (책임 분리 명시) | `resource/hermes-agent/agent/trajectory.py:1-7` |
| `convert_scratchpad_to_think` | `resource/hermes-agent/agent/trajectory.py:16-20` |
| `has_incomplete_scratchpad` | `resource/hermes-agent/agent/trajectory.py:23-27` |
| `save_trajectory(...)` | `resource/hermes-agent/agent/trajectory.py:30-56` |

## 3. Architecture Sketch

```
AIAgent.run() ─── (turn loop) ─── on completion ───┐
                                                    │
       List[Dict] (ShareGPT conversations) ─────────▼
                                              save_trajectory(
                                                trajectory,
                                                model,
                                                completed: bool,
                                                filename=None,
                                              )
                                                    │
                                                    ▼
        filename = "trajectory_samples.jsonl"  (completed=True)
        filename = "failed_trajectories.jsonl" (completed=False)
                                                    │
                                                    ▼
        f.write(json.dumps({
          "conversations": trajectory,
          "timestamp": isoformat,
          "model": model,
          "completed": completed,
        }) + "\n")
```

`convert_scratchpad_to_think` / `has_incomplete_scratchpad`는 본 sink와 별개로 turn loop 내부에서 모델 출력 후처리에 쓰인다 — 모듈 내부에는 호출자가 없으며, 외부 곳에서 import해서 쓴다.

## 4. Key Invariants

- 저장 실패는 절대 raise하지 않는다 — `try/except`로 잡아 `logger.warning`만 남긴다 (`trajectory.py:51-56`). RL 데이터 수집 실패가 정상 turn 완료를 망치지 않는 것이 첫째 invariant.
- JSONL append는 line-buffered가 아닌 한 줄당 한 dump로, 동시성을 가정하지 않는다 — 같은 파일에 여러 프로세스가 쓰면 손상 가능. RL collection은 단일 프로세스 가정.
- ShareGPT 형식 변환 자체는 본 모듈 책임이 아니다 — `AIAgent._convert_to_trajectory_format`이 만든 결과를 그대로 받는다.
- `<REASONING_SCRATCHPAD>` ↔ `<think>` 매핑은 양방향 단순 치환이며, 중첩이나 escape는 처리하지 않는다.

## 5. Notable Constants & Defaults

- 기본 파일명: `trajectory_samples.jsonl` (성공) / `failed_trajectories.jsonl` (실패) — `save_trajectory` 호출 시 `filename`이 None이면 `completed` flag로 자동 결정.
- 인코딩: `utf-8`, `ensure_ascii=False` — 비영문 토큰을 그대로 저장.
- 태그 페어: `<REASONING_SCRATCHPAD>` / `</REASONING_SCRATCHPAD>` ↔ `<think>` / `</think>`.
- 파일 경로 base는 cwd (절대경로 처리 없음) — 호출자가 책임.

## 6. Comparison to auto_archive_mk3

| 측면 | Hermes Trajectory | auto_archive_mk3 (현재) |
| --- | --- | --- |
| RL training pipeline | `environments/`, `batch_runner.py` 등 별도 11서브시스템 | 없음 |
| ShareGPT 변환 | `AIAgent._convert_to_trajectory_format` | 없음 |
| Trajectory sink | `agent/trajectory.py` (본 모듈) | 없음 |
| `<think>` tag 후처리 | `convert_scratchpad_to_think` | 없음 |

## 7. Adoption Notes

**채택 결정: SKIP (M-item 없음)**

RL training 자체가 auto_archive_mk3 범위 밖이다. 현재 plan에서 다음 이유로 채택하지 않는다:

- 우리 시스템은 self-improving agent 데이터셋 수집 모드를 운영하지 않음.
- ShareGPT 형식, `<think>` 태그 컨벤션 모두 Hermes 모델 군이 채택한 사양이며 auto_archive_mk3가 호환할 이유가 없음.
- 이 모듈만 따로 떼서 PORT할 가치가 없음 — 진짜 가치는 `environments/`, `batch_runner.py`, `trajectory_compressor.py`와 묶일 때 발생하는데 그 전부를 SKIP하기 때문.

향후 확장 시 참고:

- 만약 우리 agent 응답 로깅을 JSONL에 dump하는 기능이 필요해진다면, 본 모듈의 "raise 안 함, warning만, 단일 프로세스 가정" 패턴이 가장 작은 형태의 출발점.

연결되는 spec/문서: 없음.

## 8. Pitfalls / Anti-Patterns Observed

- **단일 프로세스 가정**: append 모드 단독 write는 멀티 프로세스 환경에서 손상될 수 있다. RL collection이 분산되면 별도 lock 또는 sink 서버가 필요하다 (Hermes 자체도 본 모듈을 그렇게는 쓰지 않는다).
- **태그 단순 치환의 위험**: 모델 출력에 사용자 콘텐츠 형태로 `<REASONING_SCRATCHPAD>` 문자열이 들어올 수도 있는데(예: 이 문서가 모델에 입력될 때) 단순 치환은 그것까지 변환한다. 일반적인 컨텐츠 처리 모듈로는 부적절 — RL 도메인에 한정된 헬퍼로 봐야 한다.
- 그 외 모듈 자체가 매우 작아 별도 anti-pattern 관찰 사항 없음.
