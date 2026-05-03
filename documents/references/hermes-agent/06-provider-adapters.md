---
status: stable
authority: external-code-reference
last_verified: 2026-05-01
source_paths:
  - resource/hermes-agent/agent/anthropic_adapter.py
  - resource/hermes-agent/agent/codex_responses_adapter.py
  - resource/hermes-agent/agent/gemini_native_adapter.py
  - resource/hermes-agent/agent/bedrock_adapter.py
  - resource/hermes-agent/agent/auxiliary_client.py
scope: Hermes Agent provider adapter layer의 reference material. auto_archive_mk3 동작에 대한 contract가 아니며 참조 전용.
---

# 06 — Provider Adapters

## 1. Purpose & Boundary

Hermes는 자체 정의한 OpenAI 호환 message format을 단일 internal representation으로 사용하고, 각 provider별 adapter가 그 포맷과 provider-native schema 사이를 양방향 변환한다. 본 문서는 5개의 adapter 모듈(Anthropic, Codex Responses, Gemini Native, Bedrock, Auxiliary routing client)의 역할과 공통 패턴을 정리한다. **auto_archive_mk3는 codex-sdk + claude-agent-sdk를 직접 사용하므로 이 layer는 SKIP** — 미래 awareness 목적의 참조용이다.

## 2. Source Anchors

| 항목 | 위치 |
| --- | --- |
| Anthropic adapter docstring + auth 모드 | `resource/hermes-agent/agent/anthropic_adapter.py:1-11` |
| Anthropic SDK lazy import | `resource/hermes-agent/agent/anthropic_adapter.py:25-43` |
| Thinking budget 매핑 + adaptive effort map | `resource/hermes-agent/agent/anthropic_adapter.py:47-63` |
| xhigh 모델 한정 substring | `resource/hermes-agent/agent/anthropic_adapter.py:65-78` |
| 모델별 max output token 표 | `resource/hermes-agent/agent/anthropic_adapter.py:80-112` |
| Codex Responses tool-call leak regex | `resource/hermes-agent/agent/codex_responses_adapter.py:26-40` |
| Chat ↔ Responses parts 변환 | `resource/hermes-agent/agent/codex_responses_adapter.py:47-95` |
| Gemini native base URL 판별 | `resource/hermes-agent/agent/gemini_native_adapter.py:34-44` |
| Gemini tier probe (RPD 기준) | `resource/hermes-agent/agent/gemini_native_adapter.py:47-118` |
| Bedrock 모듈 docstring + lazy boto3 | `resource/hermes-agent/agent/bedrock_adapter.py:1-87` |
| Auxiliary routing chain 설명 | `resource/hermes-agent/agent/auxiliary_client.py:1-41` |
| OpenAI SDK lazy proxy | `resource/hermes-agent/agent/auxiliary_client.py:53-100` |

## 3. Architecture Sketch

5개 모듈이 두 그룹으로 나뉜다.

**그룹 A — Format adapters**:
- `anthropic_adapter.py` (1921 LOC): Messages API. 인증 3-경로 — API key / OAuth / Claude Code credentials(line 7-10).
- `codex_responses_adapter.py` (999 LOC): Chat ↔ Responses 변환(line 47-95) + tool-call leak regex(line 37-40).
- `gemini_native_adapter.py` (951 LOC): Native REST. `probe_gemini_tier()`가 RPD 헤더로 free/paid 판별, ≤ 1000은 free(line 100).
- `bedrock_adapter.py` (1264 LOC): Converse API + boto3 lazy(line 48-58), cross-region inference profile + Guardrails.

**그룹 B — Routing**: `auxiliary_client.py` (3840 LOC) — 7-단계 fallback chain(line 7-15) + OpenAI SDK lazy proxy(line 81-100).

## 4. Key Invariants

1. **Internal format = OpenAI Chat-style** — `messages: [{role, content, tool_calls?, ...}]`, `tools: [{type:"function", function:{name, parameters}}]`. 모든 adapter는 이 형태를 받아 provider-native로 변환하고, 응답을 다시 이 형태로 정규화한다.
2. **Tool-call canonical shape** — `{"id", "type", "function": {"name", "arguments"}}`로 표준화 후 provider 변환. 응답 파싱 시 동일 shape으로 복원.
3. **Lazy SDK import** — anthropic, openai, boto3는 모두 module top-level이 아닌 사용 직전 import. cold-start 절약 + optional dependency 분리(`anthropic_adapter.py:25-43`, `auxiliary_client.py:53-100`, `bedrock_adapter.py:39-58`).
4. **Auth precedence는 명시적** — Anthropic는 API key → OAuth → Claude Code credentials 순서, Bedrock은 IAM role → SSO → env var → instance metadata(boto3 default chain), Gemini는 query string `?key=...`.
5. **Routing chain hardcoded** — user main → OpenRouter → Nous Portal → custom → native Anthropic → direct API providers(line 7-15). 402/credit-error 시 자동 다음 provider 재시도(line 36-40).

## 5. Notable Constants & Defaults

| 이름 | 값/위치 | 비고 |
| --- | --- | --- |
| `THINKING_BUDGET` | `{"xhigh": 32000, "high": 16000, "medium": 8000, "low": 4000}` | `anthropic_adapter.py:47` |
| `ADAPTIVE_EFFORT_MAP` | max/xhigh/high/medium/low/minimal→low | `anthropic_adapter.py:56-63` |
| `_XHIGH_EFFORT_SUBSTRINGS` | `("4-7", "4.7")` | `anthropic_adapter.py:69` (4.7+만 xhigh) |
| `_ANTHROPIC_DEFAULT_OUTPUT_LIMIT` | 128_000 | `anthropic_adapter.py:112` |
| `DEFAULT_GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` | `gemini_native_adapter.py:34` |
| Free-tier RPD 컷오프 | ≤ 1000 RPD = free | `gemini_native_adapter.py:97-100` |
| Codex tool-call leak marker | `to=functions.<name>` | `codex_responses_adapter.py:30-31` |
| Auxiliary chain 길이 | 7 단계 (text), 6 단계 (vision) | `auxiliary_client.py:7-23` |

## 6. Comparison to auto_archive_mk3

| 측면 | Hermes | auto_archive_mk3 |
| --- | --- | --- |
| Provider 직접 통합 | 5개 adapter + auxiliary router | 0 — codex-sdk + claude-agent-sdk가 표면 추상화 |
| 메시지 포맷 | OpenAI Chat-style internal + 변환 | SDK가 native 형태 노출 |
| Tool-call shape | 자체 canonical → provider 변환 | SDK 제공 type 사용 |
| Lazy import 전략 | manual proxy (`_OpenAIProxy`, `_get_anthropic_sdk`) | Node ESM import — 자동 lazy |
| Auxiliary routing | 7단계 chain hardcoded | 우리 환경엔 single backend(claude/codex)만 |
| Auth precedence | provider별 자체 처리 | spec `bootstrap-codex-auth-precedence.md` 단일 문서 |

## 7. Adoption Notes

**SKIP — out of auto_archive_mk3 scope.** codex-sdk + claude-agent-sdk가 provider-native I/O를 책임지므로 adapter layer 자체 구현 불필요.

다만 두 패턴만 인접 항목으로 기록: (a) **Lazy SDK import 원칙** — M7a로 별도 등록, (b) **Auxiliary routing chain** — 향후 부수 작업 위임 시 결정적 fallback chain 모델로 참조.

## 8. Pitfalls / Anti-Patterns Observed

- **SDK eager import = cold-start tax** — `anthropic` ~220ms, `openai` ~240ms (`anthropic_adapter.py:26-30`, `auxiliary_client.py:54-55`). 호출 직전 lazy load + 캐시가 정답.
- **Provider OpenAI-compat layer 신뢰 금지** — Google OpenAI 호환은 multiturn tool-call brittle해서 native REST 우회(`gemini_native_adapter.py:9-15`).
- **Tool-call leak detection** — Codex/Harmony 모델이 어시스턴트 텍스트에 `to=functions.<name>`을 평문 누설 → regex sanitize 필수(`codex_responses_adapter.py:26-40`).
- **Hardcoded 모델 substring** — `_XHIGH_EFFORT_SUBSTRINGS=("4-7","4.7")`(line 69) 같은 매칭은 신모델 출시마다 수동 sync.
- **Codex OAuth는 fallback chain 제외** — OpenAI 모델 allow-list가 비공개·가변이라 자동 진입 시 silent breakage(`auxiliary_client.py:25-30`).
