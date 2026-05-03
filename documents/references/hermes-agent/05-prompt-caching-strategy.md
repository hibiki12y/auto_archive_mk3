---
status: stable
authority: external-code-reference
last_verified: 2026-05-01
source_paths:
  - resource/hermes-agent/agent/prompt_caching.py
scope: Hermes Agent prompt caching subsystem의 reference material. auto_archive_mk3 동작에 대한 contract가 아니며 참조 전용.
---

# 05 — Prompt Caching Strategy

## 1. Purpose & Boundary

Hermes의 `agent/prompt_caching.py`는 Anthropic Messages API의 prompt caching을 단일 전략(`system_and_3`)으로 일관되게 적용하는 73 LOC 순수 함수 모듈이다. 멀티턴 대화에서 prefix를 캐시하여 input token 비용을 약 75% 절감하는 것이 목표이며, 다른 provider(OpenAI, Gemini, Bedrock)는 각자의 adapter 안에서 별도 메커니즘을 사용한다. **본 문서는 Anthropic-only 캐싱 패턴**을 정리하고, 캐시 무효화를 유발하지 않는 conversation lifecycle 불변식을 함께 기록한다.

## 2. Source Anchors

| 항목 | 위치 |
| --- | --- |
| 모듈 docstring (전략 요약) | `resource/hermes-agent/agent/prompt_caching.py:1-9` |
| `_apply_cache_marker()` 헬퍼 | `resource/hermes-agent/agent/prompt_caching.py:15-38` |
| `apply_anthropic_cache_control()` 공개 API | `resource/hermes-agent/agent/prompt_caching.py:41-72` |
| Cache marker 기본값 + 1h TTL 분기 | `resource/hermes-agent/agent/prompt_caching.py:57-59` |
| 시스템 prompt + 마지막 3 비-시스템 selection | `resource/hermes-agent/agent/prompt_caching.py:63-70` |
| Cache invariants ("Prompt Caching Must Not Break") | `resource/hermes-agent/AGENTS.md:521-535` |

## 3. Architecture Sketch

호출 흐름은 단순하다. 에이전트 루프가 매 턴 직전에 `apply_anthropic_cache_control(api_messages, cache_ttl=...)`를 호출하면, 함수는 messages를 deep copy한 뒤 최대 4개의 `cache_control` 브레이크포인트를 주입한다.

- **Breakpoint 1**: 최상단 system prompt (있을 때만, line 63-65)
- **Breakpoints 2~4**: 비-시스템 messages 중 마지막 3개 (line 67-70, rolling window)

`_apply_cache_marker()`는 message content 형태에 따라 marker 위치를 다르게 처리한다 — string content는 `[{"type": "text", "text": ..., "cache_control": ...}]`로 list-wrap되고(line 29-32), list content는 마지막 dict block에 `cache_control`을 붙이며(line 35-38), tool role은 `native_anthropic=True`일 때만 message 레벨에 marker를 단다(line 20-23). 함수는 stateless이며 클래스 인스턴스나 외부 캐시를 갖지 않는다.

## 4. Key Invariants

1. **Deep copy mandatory** — 입력 messages를 절대 mutate하지 않는다 (`copy.deepcopy(api_messages)`, line 53). caller가 보유한 message log는 원본 그대로 유지되어야 trajectory 저장과 디버깅이 일관된다.
2. **최대 4 breakpoints** — Anthropic API 한도 (line 67 `remaining = 4 - breakpoints_used`).
3. **순서 의존**: system이 messages[0]일 때만 첫 브레이크포인트 자리를 차지. system이 없으면 비-시스템 마지막 4개에 모두 분배.
4. **Mid-conversation immutability** — past context, toolsets, memories, system prompt를 대화 중간에 바꾸지 않는다 (`AGENTS.md:521-535`). compaction(요약)만 예외이며 그 경우 session_id를 회전시켜 새 캐시 prefix를 시작한다 (doc 03 참조).
5. **Cache-aware slash commands** — skills/tools/memory를 변형하는 슬래시 명령은 deferred invalidation이 default. 즉시 적용은 `--now` opt-in으로만 (`/skills install --now`가 정전형, `AGENTS.md:532-535`).

## 5. Notable Constants & Defaults

| 이름 | 값 | 비고 |
| --- | --- | --- |
| Strategy 이름 | `system_and_3` | 코드에는 변수로 노출되지 않으며 docstring/README 어휘 |
| Cache marker (default) | `{"type": "ephemeral"}` | line 57 |
| Cache marker (1h opt-in) | `{"type": "ephemeral", "ttl": "1h"}` | line 58-59 — `cache_ttl="1h"`일 때만 |
| `cache_ttl` 기본값 | `"5m"` | function signature line 43 |
| Breakpoint 한도 | 4 | Anthropic API 제한 |
| `native_anthropic` 기본값 | `False` | OpenAI-compat 호출 경로용; native SDK일 때 tool role도 marker 가능 |

## 6. Comparison to auto_archive_mk3

| 측면 | Hermes | auto_archive_mk3 |
| --- | --- | --- |
| Provider 범위 | Anthropic만 직접; 나머지는 adapter별 자체 처리 | claude-agent-sdk가 표면 노출 (Anthropic 직결) |
| Strategy 선택 | 단일 `system_and_3` 강제 | 동일 전략 채택 가능 — Plana가 system prompt + 최근 turn에 mark |
| TTL knob | 5m default, 1h opt-in (config key) | 미정 — M3에서 trait config로 노출 권고 |
| Mutation 정책 | 매뉴얼·코드 수준 invariant | trait/admission policy로 enforce 필요 (M3 연계) |
| Slash command 전략 | `--now` opt-in 패턴 | 미정 — Plana 슬래시 커맨드 도입 시 동일 패턴 채택 |

## 7. Adoption Notes

**PORT (개념) — M3.** 코드 verbatim 차용은 하지 않는다 (claude-agent-sdk가 marker 주입을 자동화). 대신 다음 두 invariant를 우리 conversation lifecycle에 결합한다:

1. **system prompt + 최근 turn cache 보존** — Plana session 내 turn 사이에 system/toolset/memory를 mutate하지 않는다. 변경이 필요한 경우 새 session(=새 conversation prefix)을 만든다. M3 spec(`specs/CURRENT/...`)의 session_id rotation 항목과 직접 연결.
2. **Slash command cache-aware default** — Plana CLI가 `/skills install`, `/memory load`, `/tools enable` 같은 변형 명령을 도입할 때 deferred invalidation이 기본이며 `--now`만 즉시 적용한다.

연관 M-item: **M3** (memory + state lifecycle). 인접 도큐먼트: `03-memory-state-sessiondb.md`.

## 8. Pitfalls / Anti-Patterns Observed

- **Mid-conversation mutation = cost explosion** — 시스템 prompt를 한 번 다시 만들면 4개 브레이크포인트가 모두 무효화되어 다음 턴부터 prefix 전체가 재청구된다. compaction 외 어떤 케이스에서도 금지(`AGENTS.md:530`).
- **Toolset swap mid-session** — 새 도구 활성화/비활성화는 system prompt 안의 tool 카탈로그를 바꿔 cache miss를 유발. `--now` 플래그가 없는 한 다음 session에서만 적용되도록 강제.
- **Memory reload on every turn** — 각 턴 시작 때 memory를 새로 fetch해 system prompt에 inject하면 system 자체가 매 턴 변하는 셈이 되므로 cache를 깨뜨림. 캐시 친화적 패턴은 session 시작 시 한 번 로드 → conversation 동안 freeze → 다음 session에서 갱신.
- **String content mutation** — `_apply_cache_marker()`는 string content를 list로 wrapping해야 marker를 붙일 수 있다(line 29-32). caller가 string 채로 처리한다고 가정하면 marker가 누락될 수 있으니, marker 적용 후 message shape이 list로 바뀐 점을 후속 코드가 처리해야 한다.
