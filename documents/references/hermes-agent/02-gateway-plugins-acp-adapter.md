---
status: stable
authority: external-code-reference
last_verified: 2026-05-01
source_paths:
  - resource/hermes-agent/hermes_cli/plugins.py
  - resource/hermes-agent/hermes_cli/commands.py
  - resource/hermes-agent/gateway/run.py
  - resource/hermes-agent/acp_adapter/server.py
scope: Hermes Agent Gateway plugin system, hook surface, command registry, ACP adapter의 reference material. auto_archive_mk3 동작에 대한 contract가 아니며 참조 전용.
---

# 02 — Gateway Plugins + ACP Adapter

## 1. Purpose & Boundary

Hermes의 plugin system은 4-tier discovery (bundled / user / project / pip entry-point)와 단일 `register(ctx)` entry-point로 외부 코드의 tool / hook / command / platform 확장을 허용한다. Single source-of-truth `COMMAND_REGISTRY`가 모든 slash command를 정의하고, `_handle_message` 안에서 two-guard dispatch(platform adapter validate + gateway runner control flow)가 작동한다. ACP adapter는 동일한 command surface를 IDE-side ACP client(Zed 등)에게 노출한다. 본 문서는 plugin-context API surface, 15개 hook의 위치, command registry schema, two-guard dispatch flow를 정리한 reference material이다 — auto_archive_mk3의 contract가 아니다.

## 2. Source Anchors

| 항목 | Path |
| --- | --- |
| `VALID_HOOKS` (15개) | resource/hermes-agent/hermes_cli/plugins.py:78-119 |
| Plugin kinds 상수 | resource/hermes-agent/hermes_cli/plugins.py:176 |
| `register_tool` / `register_cli_command` / `register_command` | resource/hermes-agent/hermes_cli/plugins.py:242-381 |
| `inject_message` / `dispatch_tool` | resource/hermes-agent/hermes_cli/plugins.py:273-412 |
| `register_context_engine` / `register_image_gen_provider` | resource/hermes-agent/hermes_cli/plugins.py:413-470 |
| `register_platform` | resource/hermes-agent/hermes_cli/plugins.py:472-527 |
| `register_hook` validation | resource/hermes-agent/hermes_cli/plugins.py:528-545 |
| `register_skill` | resource/hermes-agent/hermes_cli/plugins.py:547-605 |
| `CommandDef` dataclass | resource/hermes-agent/hermes_cli/commands.py:42-55 |
| `COMMAND_REGISTRY` 본체 | resource/hermes-agent/hermes_cli/commands.py:61-170 |
| Gateway runner two-guard `_handle_message` | resource/hermes-agent/gateway/run.py:4178-4290 |
| `pre_gateway_dispatch` 호출 | resource/hermes-agent/gateway/run.py:4197-4225 |
| ACP `HermesACPAgent` | resource/hermes-agent/acp_adapter/server.py:157 |
| `_available_commands()` | resource/hermes-agent/acp_adapter/server.py:912-927 |
| Teams platform adapter sample | resource/hermes-agent/plugins/platforms/teams/adapter.py:663 |

## 3. Architecture Sketch

- Discovery 4-tier (override 순서, 뒤가 우선):
  1. Bundled `<repo>/plugins/<name>/`
  2. User `~/.hermes/plugins/`
  3. Project `./.hermes/plugins/` — `HERMES_ENABLE_PROJECT_PLUGINS` opt-in
  4. pip entry-point group `hermes_agent.plugins`
- Plugin manifest = `plugin.yaml` + `__init__.py` with `register(ctx)`.
- Plugin kinds (`_VALID_PLUGIN_KINDS`): `standalone` (default) / `backend` / `exclusive` / `platform`.
- `PluginContext` API: `register_tool`, `register_hook(name, callback)`, `register_command`, `register_cli_command`, `register_platform`, `register_skill`, `register_context_engine`, `register_image_gen_provider`, `inject_message`, `dispatch_tool`.
- `VALID_HOOKS` (15): `pre_tool_call`, `post_tool_call`, `transform_terminal_output`, `transform_tool_result`, `pre_llm_call`, `post_llm_call`, `pre_api_request`, `post_api_request`, `on_session_start`, `on_session_end`, `on_session_finalize`, `on_session_reset`, `subagent_stop`, `pre_gateway_dispatch`, `pre_approval_request`, `post_approval_response`.
- `COMMAND_REGISTRY`는 `@dataclass(frozen=True) CommandDef`의 list. 파생 자료구조 `COMMANDS`, `COMMANDS_BY_CATEGORY`, `SUBCOMMANDS`, `GATEWAY_KNOWN_COMMANDS`, `ACTIVE_SESSION_BYPASS_COMMANDS`가 모두 이 단일 list에서 도출.
- `resolve_command(name)`은 leading slash strip + case-insensitive lookup 후 `CommandDef` 반환.
- Two-guard dispatch:
  - **Guard 1** — `BasePlatformAdapter.on_message_received(MessageEvent)` (platform-specific dedup, rate-limit, media validation).
  - **Guard 2** — `GatewayRunner._handle_message` (`gateway/run.py:4178-4290`): internal-event bypass → `pre_gateway_dispatch` hook → user-identity validation → command dispatch.
- `pre_gateway_dispatch` 반환 shape: `{"action": "skip"|"rewrite"|"allow", "reason": "...", "text": "..."}`.
- `pre_tool_call` hook은 `{"action": "block", "message": "..."}`로 실행 차단 가능.
- `pre_approval_request` / `post_approval_response`는 observer-only — return 무시, veto 불가.
- ACP adapter (`acp_adapter/server.py:157`): `HermesACPAgent`는 `_available_commands()` (912-927)로 slash command를 client에 광고하고, `make_approval_callback`이 `asyncio.run_coroutine_threadsafe()`로 permission을 bridging.

## 4. Key Invariants

- 모든 hook 등록은 `VALID_HOOKS` set에 포함된 이름으로만 — 미등록 이름은 즉시 거부.
- 한 카테고리당 active `exclusive` plugin은 최대 1개 (e.g. memory).
- `bundled`/`platform` plugin은 자동 load. `standalone`은 opt-in.
- Plugin은 core 파일 수정 금지 (Teknium 2026-05 rule). 모든 확장은 `register(ctx)` API를 통해서만.
- Two-guard 모두 approval / control command(`/approve`, `/deny`, `/stop`)은 bypass해야 함 — `ACTIVE_SESSION_BYPASS_COMMANDS` 참조.
- `pre_gateway_dispatch`의 `skip` 결정은 reply 자체를 생략 — 빈 메시지 응답이 아님.
- ACP의 `_available_commands` 반환은 항상 `COMMAND_REGISTRY`의 derived view여야 함 — 별도 enumeration 금지.

## 5. Notable Constants & Defaults

- `_VALID_PLUGIN_KINDS = {"standalone", "backend", "exclusive", "platform"}`.
- `VALID_HOOKS` size = 15.
- 4-tier override 순서: bundled < user < project < entry-point.
- Project tier env gate: `HERMES_ENABLE_PROJECT_PLUGINS`.
- Entry-point group: `hermes_agent.plugins`.
- `CommandDef` default `cli_only=False`, `gateway_only=False`, `gateway_config_gate=None`.
- `COMMAND_REGISTRY`는 module-level frozen list — runtime mutation 금지.

## 6. Comparison to auto_archive_mk3

| Hermes mechanism | auto_archive_mk3 등가물 |
| --- | --- |
| 4-tier plugin discovery | 미존재 — `src/discord/discord-service-bootstrap.ts`에서 explicit wiring |
| `register(ctx)` plugin contract | 미존재 — adapter 추가는 source 변경 필요 |
| `COMMAND_REGISTRY` single SoT | 부분적 — `src/discord/discord-command-handlers.ts`에 분산. SoT collapse 필요 (M5 후보) |
| 15-hook surface | 부분적 — `src/contracts/trait-runtime-hook.ts`는 trait-decorator 1종만 |
| `pre_gateway_dispatch` rewrite/skip/allow | 미존재 — `src/discord/discord-bot.ts`의 instruction envelope에 단일 path |
| ACP adapter (Zed) | 미존재 — Discord-only |
| `pre_tool_call` block | 부분적 — `src/core/admission-gate.ts`로 admit/deny만, hook 모델 아님 |

## 7. Adoption Notes

**Decision: PORT-PARTIAL (M5a / M5b / M5c + M10)**. M5a에서 `COMMAND_REGISTRY`-style single source of truth로 Discord command를 정리, M5b에서 `pre_gateway_dispatch`-equivalent rewrite/skip hook을 instruction envelope 직전에 도입, M5c에서 hook validation set을 `src/contracts/`에 추가. M10에서 ACP-style adapter 검토 (Zed integration). Plugin discovery 4-tier는 우리 codebase 규모에서 over-engineering이므로 SKIP. Connection points: `src/contracts/` 새 파일 `command-def.ts`, `src/control/` 새 파일 `gateway-dispatch-hook.ts`.

## 8. Pitfalls / Anti-Patterns Observed

CODE_STANDARDS.md §8 후보:

- Slash command 정의는 단일 frozen registry — handler-side에 description / args_hint를 다시 적지 말 것.
- Hook 이름은 closed set으로 enforce — typo가 silent no-op이 되지 않도록 register 시점에 reject.
- Approval / control command은 모든 dispatch guard에서 bypass — auth 거부로 사용자가 락-아웃되는 path 차단.
- `pre_gateway_dispatch` 같은 mutation hook은 명시적 return shape (`action ∈ {skip, rewrite, allow}`)으로 — return value-less side effect 금지.
- Observer-only hook (`pre_approval_request`)은 spec에 명시 — return 값을 우연히 사용하면 silent veto 발생.
- Plugin은 core 파일 수정 금지 — 모든 확장은 명시적 `register*` API 통과.
- Discovery override 순서는 deterministic이어야 함 (later wins) — undefined order는 사용자 plugin이 bundled를 못 덮음.
- ACP 같은 외부 surface의 command list는 항상 internal registry의 derived view — 두 곳에서 enumerate하면 drift 발생.
