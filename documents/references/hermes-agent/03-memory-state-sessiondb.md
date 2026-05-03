---
status: stable
authority: external-code-reference
last_verified: 2026-05-01
source_paths:
  - resource/hermes-agent/agent/memory_provider.py
  - resource/hermes-agent/agent/memory_manager.py
  - resource/hermes-agent/hermes_state.py
  - resource/hermes-agent/agent/context_compressor.py
scope: Hermes Agent의 memory provider ABC, session DB schema, prompt-cache breakpoint, context compaction 전략의 reference material. auto_archive_mk3 동작에 대한 contract가 아니며 참조 전용.
---

# 03 — Memory + State + SessionDB

## 1. Purpose & Boundary

Hermes는 8개의 외부 memory provider(honcho, mem0, supermemory, byterover, hindsight, holographic, openviking, retaindb)를 단일 ABC `MemoryProvider`로 추상화하고, `MemoryManager`가 한 번에 하나의 external provider만 활성화한다. Conversation history는 `hermes_state.py`의 `SessionDB`(SQLite + WAL + FTS5 + trigram tokenizer)에 저장되며, 4-breakpoint prompt cache 전략과 session-rotation-on-compaction이 함께 작동한다. 본 문서는 ABC contract, DB schema, prompt-cache rule, compaction-induced session rotation, profile mechanism을 정리한다 — auto_archive_mk3의 contract가 아니다.

## 2. Source Anchors

| 항목 | Path |
| --- | --- |
| `MemoryProvider` ABC | resource/hermes-agent/agent/memory_provider.py:43-281 |
| Lifecycle method 시그니처 | resource/hermes-agent/agent/memory_provider.py:53-200 |
| `MemoryManager.register()` (external 1개 enforcement) | resource/hermes-agent/agent/memory_manager.py:210-234 |
| `SessionDB` schema 본체 | resource/hermes-agent/hermes_state.py:38-101 |
| `messages_fts` (FTS5 default) | resource/hermes-agent/hermes_state.py:103-126 |
| `messages_fts_trigram` (CJK substring) | resource/hermes-agent/hermes_state.py:132-156 |
| WAL + jittered retry tuning | resource/hermes-agent/hermes_state.py:167-180 |
| `apply_anthropic_cache_control` (`system_and_3`) | resource/hermes-agent/agent/prompt_caching.py:41-72 |
| `ContextEngine` ABC | resource/hermes-agent/agent/context_engine.py:32-206 |
| Compaction prefix / preamble | resource/hermes-agent/agent/context_compressor.py:38-60 |
| Session-rotation-on-compaction | resource/hermes-agent/run_agent.py:9054-9110 |
| `get_hermes_home()` | resource/hermes-agent/hermes_constants.py:11-71 |

## 3. Architecture Sketch

- 8 external providers + 1 builtin. `MemoryManager`는 builtin은 무제한, external은 정확히 1개만 등록 허용.
- ABC contract methods: `name`, `is_available`, `initialize(session_id, **kwargs)`, `get_tool_schemas()`, `sync_turn(user_content, assistant_content, *, session_id="")`, `prefetch(query, *, session_id="")`, `queue_prefetch(query, *, session_id="")`, `on_session_switch(new_session_id, *, parent_session_id="", reset=False, **kwargs)`, `on_session_end(messages)`, `on_pre_compress(messages) -> str`, `shutdown()`.
- `SessionDB` schema (3 tables + 2 FTS5):
  - `sessions` — id, source, user_id, model, model_config, system_prompt, **`parent_session_id`** FK (compression lineage), started_at, ended_at, end_reason, message_count, tool_call_count, cost columns, title.
  - `messages` — id (autoincrement), session_id (FK), role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason, reasoning fields. Index on `(session_id, timestamp)`.
  - `state_meta` — KV.
  - `messages_fts` — FTS5 default (unicode61) tokenizer.
  - `messages_fts_trigram` — FTS5 with `tokenize='trigram'`. CJK substring search 위한 별도 virtual table.
- WAL + jittered retry: `_WRITE_MAX_RETRIES = 15`, `_WRITE_RETRY_MIN_S = 0.020`, `_WRITE_RETRY_MAX_S = 0.150`. 짧은 SQLite timeout (1s) + application-level retry로 convoy effect 회피.
- Prompt cache (`system_and_3`): system prompt + last 3 non-system messages = 최대 4 cache_control breakpoint. Pure function, deep-copy 후 mutate; 과거 메시지를 in-place 수정하면 cache invalidation.
- Compaction → session rotation: 압축 시 old session은 `end_reason="compression"`으로 종료되고, new session이 `parent_session_id=old`로 생성. 모든 provider에 `on_session_switch(reset=False, reason="compression")` 통보.
- `ContextEngine` ABC: `name`, `last_prompt_tokens`, `threshold_tokens`, `context_length`, `compression_count`, `threshold_percent=0.75`, `protect_first_n=3`, `protect_last_n=6`. 추상 메서드 `update_from_response`/`should_compress`/`compress`. Optional `should_compress_preflight`/`has_content_to_compress`/`on_session_*`/`get_tool_schemas`/`handle_tool_call`/`get_status`/`update_model`.
- Compressor (`context_compressor.py`): summary preamble은 "different assistant" handoff framing + "Resolved/Pending Questions" + "Remaining Work" 구조. Tool result pruning은 cheap pre-pass로 `[read_file] ... (1,200 chars)` 형태 placeholder.
- Profile: `HERMES_HOME` env 우선, fallback `~/.hermes`. `_apply_profile_override()`는 module-level 상수가 stale resolve되지 않도록 import 이전에 실행.

## 4. Key Invariants

- External memory provider는 동시에 1개. 두 번째 등록은 warning 후 reject.
- Prompt cache breakpoint는 항상 4개 이하 — 초과 시 Anthropic API가 거절.
- Cache function은 pure — 입력 messages를 mutate하지 않음 (deep copy 강제).
- Compaction은 session_id를 rotate — 같은 ID에 새 message를 append하지 않음.
- `on_session_switch(reset=False)`는 compaction 신호 — provider가 conversation을 끊지 않도록 알려줌.
- `~/.hermes` hardcoded path 금지 — 모든 storage는 `get_hermes_home()` 경유.
- WAL retry는 항상 jittered random — deterministic backoff은 convoy 유발.
- `parent_session_id`는 항상 sessions FK constraint 만족 — orphan 금지.

## 5. Notable Constants & Defaults

- External provider 8종: `honcho`, `mem0`, `supermemory`, `byterover`, `hindsight`, `holographic`, `openviking`, `retaindb`.
- Prompt cache strategy: `system_and_3` (max 4 breakpoints).
- WAL tuning: 15 retries, 20-150ms jittered sleep, checkpoint every 50 writes (`_CHECKPOINT_EVERY_N_WRITES`).
- ContextEngine defaults: `threshold_percent=0.75`, `protect_first_n=3`, `protect_last_n=6`.
- Compaction summary: `_MIN_SUMMARY_TOKENS=2000`, `_SUMMARY_RATIO=0.20`, `_SUMMARY_TOKENS_CEILING=12_000`.
- FTS5 tokenizer: default `unicode61` + alternate `trigram` (CJK용).
- `HERMES_HOME` env, default `~/.hermes`.

## 6. Comparison to auto_archive_mk3

| Hermes mechanism | auto_archive_mk3 등가물 |
| --- | --- |
| 8-provider memory ABC | 미존재 — `src/runtime/`은 driver-side에서 in-memory state만 |
| `SessionDB` SQLite + WAL | 미존재 — `src/control/control-plane-ledger.ts`가 in-process ledger |
| `parent_session_id` FK lineage | 미존재 — task lineage는 `src/contracts/task-id.ts`로 표현되나 DB 영속 없음 |
| `messages_fts_trigram` (CJK) | 미존재 |
| `apply_anthropic_cache_control` 4-breakpoint | 부분적 — Claude runtime은 `src/runtime/claude-agent-runtime-adapter.ts`에서 SDK가 처리 |
| Compaction → session rotation | 미존재 — auto_archive_mk3는 long-running session 모델 아님 |
| `HERMES_HOME` profile | 미존재 — config는 `package.json` + env로 단일 |

## 7. Adoption Notes

**Decision: PORT-PARTIAL (M3)**. M3에서 (a) task lineage를 SQLite-backed ledger로 영속화 (현재 `control-plane-ledger.ts`의 in-process map 대체), (b) WAL + jittered retry tuning 차용, (c) `parent_session_id`-style lineage column 추가. Memory provider ABC는 우리에게 stateless dispatcher 모델이므로 SKIP. Prompt cache 4-breakpoint는 Claude SDK가 handle하므로 SKIP. Compaction은 long-running conversation이 없는 한 SKIP. Connection point: `src/control/control-plane-ledger.ts` → SQLite-backed implementation, `src/contracts/` 새 파일 `dispatch-lineage.ts`.

## 8. Pitfalls / Anti-Patterns Observed

CODE_STANDARDS.md §8 후보:

- Storage path는 항상 explicit base directory 함수(`get_hermes_home()` 같은) 경유 — `~/.hermes` 같은 하드코딩 금지. Test isolation을 위해 env override 필수.
- Test fixture는 user home에 쓰지 말 것 — autouse fixture로 `HERMES_HOME`-equivalent를 tmpdir로 override.
- SQLite WAL은 짧은 timeout + application-level jittered retry — built-in busy_handler의 deterministic backoff은 convoy 유발.
- Prompt cache breakpoint는 closed-form set (max N) — runtime에서 동적으로 늘리지 말 것.
- 캐시 가능 메시지 변환 함수는 항상 pure (deep copy) — in-place mutation은 silent cache invalidation.
- Long-running conversation에서 compaction 시 session_id rotate — 같은 ID로 history를 잘라 붙이면 lineage 추적 불가.
- 외부 provider가 1개만 활성이어야 하는 카테고리는 register-time enforcement — runtime tie-breaking은 nondeterministic 행동 유발.
- CJK 사용자 검색 지원이 필요하면 trigram tokenizer를 별도 virtual table로 — default unicode61 위에 phrase match가 깨짐.
