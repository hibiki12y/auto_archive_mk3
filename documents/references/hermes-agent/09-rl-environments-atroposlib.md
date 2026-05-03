---
status: stable
authority: external-code-reference
last_verified: 2026-05-01
source_paths:
  - resource/hermes-agent/environments/
scope: Hermes Agent RL environments + atroposlib integration의 reference material. auto_archive_mk3 동작에 대한 contract가 아니며 참조 전용.
---

# 09 — RL Environments + atroposlib

## 1. Purpose & Boundary

`environments/`는 Hermes Agent를 Nous Research의 RL 프레임워크 `atroposlib` 위에 얹어 SFT/RLHF 데이터 수집 및 정책 학습을 수행하는 어댑터 묶음이다. SWE-Bench / terminal test / agentic OPD 3개 환경, 11개 모델별 tool-call parser, Modal/Docker 샌드박스 백엔드를 포함한다. **RL 학습 전용**이며 auto_archive_mk3의 단일-에이전트 실행 흐름과 직교 — 채택은 SKIP.

## 2. Source Anchors

| 항목 | 위치 |
| --- | --- |
| Atropos 통합 모듈 docstring | `resource/hermes-agent/environments/hermes_base_env.py:1-17` |
| `atroposlib` import 표면 | `resource/hermes-agent/environments/hermes_base_env.py:50-61` |
| `HermesAgentBaseEnv(BaseEnv)` 추상 베이스 | `resource/hermes-agent/environments/hermes_base_env.py:221-241` |
| `HermesSweEnv` (SWE-Bench 구현) | `resource/hermes-agent/environments/hermes_swe_env/hermes_swe_env.py:62-100` |
| `config_init() → (Config, [APIServerConfig])` 진입점 | `resource/hermes-agent/environments/hermes_swe_env/hermes_swe_env.py:76-100` |
| `ToolContext` 클래스 (terminal/file/web 노출) | `resource/hermes-agent/environments/tool_context.py:66-107` |
| `ToolCallParser` ABC + 레지스트리 | `resource/hermes-agent/environments/tool_call_parsers/__init__.py:35-79` |
| 11개 모델별 parser import | `resource/hermes-agent/environments/tool_call_parsers/__init__.py:108-120` |
| `TERMINAL_ENV` 백엔드 디스패치 | `resource/hermes-agent/batch_runner.py:261` |

## 3. Architecture Sketch

`HermesAgentBaseEnv`는 `atroposlib.envs.base.BaseEnv`를 상속해 두 운용 모드를 제공한다. **Phase 1**은 OpenAI/VLLM/SGLang가 tool call 파싱을 native로 수행하는 SFT 데이터 생성용, **Phase 2**는 `ManagedServer` 경유 `/generate`로 토큰 ID + logprob을 받고 클라이언트 측 `ToolCallParser`가 raw 텍스트에서 tool_calls를 재구성하는 RL 학습용 (`hermes_base_env.py:225-233`). 서브클래스는 `setup` / `get_next_item` / `format_prompt` / `compute_reward` / `evaluate` 5개 메서드만 구현한다. `HermesSweEnv`는 SWE-bench/HumanEval 데이터셋을 Modal 샌드박스에서 실행하고 `compute_reward()`가 동일 샌드박스의 파일시스템 상태에 대해 테스트를 돌려 점수를 매긴다. `ToolContext(task_id)`는 rollout마다 고유 샌드박스를 묶어 `terminal/read_file/write_file/web_search/web_extract`를 노출.

## 4. Key Invariants

1. **task_id로 rollout 격리** — 모든 도구 호출의 라우팅 키. 충돌 시 샌드박스 공유로 reward 오염 (`tool_context.py:75-76`).
2. **Async-safe dispatch** — Modal/Docker/Daytona 백엔드 내부 `asyncio.run()`이 Atropos 루프 안에서 데드락. `_run_tool_in_thread()`가 ThreadPoolExecutor로 격리 (`tool_context.py:55-63`).
3. **Patch on import** — `apply_patches()`가 `SwerexModalEnvironment`를 스레드 기반으로 재작성, 모든 환경 모듈이 import 시점에 적용 (`hermes_base_env.py:46-48`).
4. **Parser 등록 = 전역 import 사이드이펙트** — `@register_parser` 데코레이터가 `PARSER_REGISTRY`에 즉시 등록 (`tool_call_parsers/__init__.py:62-79`). 미import 시 `KeyError`.
5. **Terminal backend는 `TERMINAL_ENV` 환경변수 단일 결정** — `local/docker/modal/daytona/...` (`tool_context.py:94`).

## 5. Notable Constants & Defaults

| 이름 | 값 | 비고 |
| --- | --- | --- |
| 등록 parser 종류 | 11종 | hermes / longcat / mistral / llama / qwen / deepseek_v3 / deepseek_v3_1 / kimi_k2 / glm45 / glm47 / qwen3_coder (`__init__.py:108-120`) |
| `HermesSweEnv.max_agent_turns` | 30 | `hermes_swe_env.py:89` |
| `HermesSweEnv.max_token_length` | 4096 | `hermes_swe_env.py:90` |
| `HermesSweEnv.agent_temperature` | 1.0 | `hermes_swe_env.py:91` |
| 기본 toolset | `["terminal", "file", "web"]` | `hermes_swe_env.py:85` |
| 기본 dataset | `bigcode/humanevalpack` | `hermes_swe_env.py:100` |
| 기본 backend (SWE) | `modal` | `hermes_swe_env.py:98` |
| `terminal()` timeout 기본 | 180초 | `tool_context.py:82` |
| Thread pool timeout (도구 호출) | 300초 | `tool_context.py:60` |

## 6. Comparison to auto_archive_mk3

| 측면 | Hermes | auto_archive_mk3 |
| --- | --- | --- |
| 1차 목적 | RL 학습 데이터 수집 + 정책 업데이트 | 단일 사용자 자동 아카이빙 |
| 추상 베이스 | `BaseEnv` (atroposlib) — Phase 1/2 듀얼 모드 | 해당 없음 |
| Tool dispatch 컨텍스트 | `ToolContext(task_id)` | Plana dispatcher → trait module |
| Tool-call 파싱 | 11개 모델별 정규식 parser, 클라이언트 측 | claude-agent-sdk가 자동 처리 |
| 샌드박스 백엔드 | local/Docker/Modal/Daytona/Singularity | 호스트 실행 (sandbox 구성 미정) |
| 데이터셋 입력 | HuggingFace `datasets` 로드 | 사용자 명령 / Discord 입력 |
| Reward 함수 | 테스트 실행 결과 기반 | 해당 없음 |

## 7. Adoption Notes

**SKIP — 채택하지 않음.** RL 학습 파이프라인은 auto_archive_mk3의 운영 영역과 직교하며 (a) atroposlib 의존 비용, (b) Modal/Daytona 등 외부 SaaS 결합, (c) 11개 모델별 parser를 유지할 동기 부재 — 셋 모두 도입 가치보다 운영 부담이 크다. 대응 M-item 없음.

**참고로만 보존할 패턴 1개**: `ToolContext.terminal()` / `file_view()` / `web()` 같이 **단일 객체에 좁힌 도구 표면을 노출**하는 형태는 subagent에 부여할 도구 집합을 좁히는 패턴(M4 — `04-tools-delegate-terminal-backends.md`)과 사상적으로 일치하므로 별도 리팩토링 시 어휘만 차용 가능.

## 8. Pitfalls / Anti-Patterns Observed

- **`asyncio.run()` 중첩 데드락** — 모달/도커 백엔드가 자체 이벤트 루프를 만들어 Atropos 루프 안에서 즉시 hang. 도구 호출은 thread pool로 격리(`tool_context.py:55-63`). 비-RL에서도 SDK 내부 루프 모두 동일 위험.
- **Parser 등록 순서 의존** — import 사이드이펙트라 lazy-load 환경에서 침묵 실패. `get_parser` 호출 전 모든 parser 모듈이 반드시 import되어 있어야 함 (`__init__.py:97-99`).
- **task_id 충돌 = reward 오염** — UUID 발급은 caller 책임. 두 rollout이 같은 ID로 돌면 한쪽 변경이 다른 쪽 테스트 통과 유도.
- **`TERMINAL_ENV` 전역 상태** — 단일 환경변수가 모든 도구 호출 실행 위치를 좌우, `os.environ` 격리 없는 멀티 테스트는 교차 오염. auto_archive_mk3 도입 시 명시적 인자 전달 권장.
- **RL config 어휘 누출** — `enabled_toolsets / distribution / max_agent_turns` 같은 RL 어휘를 production 도구 표면에 노출하지 말 것.
