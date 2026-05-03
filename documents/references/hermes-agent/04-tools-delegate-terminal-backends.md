---
status: stable
authority: external-code-reference
last_verified: 2026-05-01
source_paths:
  - resource/hermes-agent/tools/registry.py
  - resource/hermes-agent/tools/delegate_tool.py
  - resource/hermes-agent/tools/environments/base.py
  - resource/hermes-agent/agent/tool_guardrails.py
scope: Hermes Agent의 tool registry, delegate_task subagent 구조, terminal backend ABC, tool guardrail의 reference material. auto_archive_mk3 동작에 대한 contract가 아니며 참조 전용.
---

# 04 — Tools + Delegate + Terminal Backends

## 1. Purpose & Boundary

Hermes의 `tools/registry.py`는 모든 tool을 module-level singleton에 register하고, `model_tools.py`는 `check_fn()` 결과를 TTL 캐시(약 30s)로 거른 정의를 모델에 노출한다. `delegate_task`는 leaf vs orchestrator role과 depth-cap, concurrent-children, blocked-tools subset으로 subagent fan-out을 통제한다. 7개 terminal backend(local, docker, ssh, modal, daytona, singularity, vercel_sandbox)는 단일 `BaseEnvironment` ABC + `ProcessHandle` Protocol 위에서 spawn-per-call 모델로 동작한다. `tool_guardrails`는 per-turn failure threshold로 loop 차단. 본 문서는 contract surface와 invariants만 정리한다 — auto_archive_mk3 contract가 아니다.

## 2. Source Anchors

| 항목 | Path |
| --- | --- |
| `ToolEntry` dataclass | resource/hermes-agent/tools/registry.py:77-100 |
| `registry.register()` | resource/hermes-agent/tools/registry.py:226-280 |
| `registry.dispatch()` | resource/hermes-agent/tools/registry.py:347-380 |
| `_AGENT_LOOP_TOOLS` 인터셉트 | resource/hermes-agent/run_agent.py:326 |
| `DELEGATE_BLOCKED_TOOLS` | resource/hermes-agent/tools/delegate_tool.py:40 |
| `MAX_DEPTH = 1` (flat default) | resource/hermes-agent/tools/delegate_tool.py:128 |
| `_get_max_concurrent_children` | resource/hermes-agent/tools/delegate_tool.py:324-360 |
| `_get_max_spawn_depth` (clamp [1,3]) | resource/hermes-agent/tools/delegate_tool.py:389-425 |
| `child_timeout_seconds` (default 600) | resource/hermes-agent/tools/delegate_tool.py:363-385 |
| `ProcessHandle` Protocol | resource/hermes-agent/tools/environments/base.py:166-182 |
| `_ThreadedProcessHandle` | resource/hermes-agent/tools/environments/base.py:184-220 |
| 7 backend 구현 | resource/hermes-agent/tools/environments/ |
| Guardrail thresholds | resource/hermes-agent/agent/tool_guardrails.py:73-80 |
| `IDEMPOTENT_TOOL_NAMES` / `MUTATING_TOOL_NAMES` | resource/hermes-agent/agent/tool_guardrails.py:19-50 |
| `ToolGuardrailDecision` | resource/hermes-agent/agent/tool_guardrails.py:144 |

## 3. Architecture Sketch

- Registration: import-time `registry.register()` per file under `tools/`. `ToolEntry` slots: `name`, `toolset`, `schema` (JSON Schema), `handler` (callable), `check_fn` (availability probe), `is_async`, `max_result_size_chars`.
- Dispatch: exception-safe — handler가 예외 던져도 항상 JSON 문자열 반환. `dispatch(name, args, **kwargs)`.
- `model_tools.py:get_definitions()`는 `check_fn()` 결과를 TTL 캐시(~30s)로 거른 후 모델에 schema 노출.
- Tool-call path: model emits tool_call → `pre_tool_call` hook (block 가능) → `coerce_tool_args()` → `registry.dispatch(args, task_id=...)` → JSON result → `post_tool_call` hook → optional `transform_tool_result` hook.
- `_AGENT_LOOP_TOOLS = {todo, memory, session_search, delegate_task}` — `run_agent.py`가 dispatcher 이전에 직접 intercept. 미인터셉트 시 stub error.
- Subagent (delegate):
  - role: `leaf` (default, re-delegate 불가) vs `orchestrator` (depth-capped).
  - `MAX_DEPTH = 1` flat default. `delegation.max_spawn_depth`로 [1,3] clamp.
  - `DELEGATE_BLOCKED_TOOLS = {delegate_task, clarify, memory, send_message, execute_code}`.
  - 자식 toolset ⊆ 부모 toolset 항상 만족 (intersection).
  - `ThreadPoolExecutor(max_workers=delegation.max_concurrent_children)` (default 3). `child_timeout_seconds` default 600s, min 30s.
  - Process-global `_last_resolved_tool_names`는 `_run_single_child()`가 save/restore해서 nested execution stale resolve 방지.
- `ProcessHandle` Protocol (duck type): `poll() -> int|None`, `kill() -> None`, `wait(timeout) -> int`, properties `stdout: IO[str]|None`, `returncode: int|None`. `subprocess.Popen` natively 만족, SDK backend는 `_ThreadedProcessHandle`로 wrap.
- 7 backend: `local` (subprocess.Popen), `docker` (volumes from `TERMINAL_SANDBOX_DIR`), `ssh` (OpenSSH), `modal` (`modal.Sandbox.create()`), `daytona` (SDK), `singularity` (OCI + overlay), `vercel_sandbox` (v0.12.0 신규).
- Spawn-per-call: 모든 command는 fresh `bash -c`. Session snapshot(env vars, functions, aliases)을 매번 re-source. CWD는 stdout marker(remote) 또는 temp file(local)로 persist.
- Guardrail: per-turn threshold — `exact_failure_warn_after=2`, `same_tool_failure_warn_after=3`, `no_progress_warn_after=2` (warn) + 별도 hard-stop variant. `IDEMPOTENT_TOOL_NAMES` vs `MUTATING_TOOL_NAMES` 분류로 progress 판정. `ToolGuardrailDecision.action ∈ {allow, warn, block, halt}`.
- Hardline blocklist: 회복 불가 command는 precompiled `DANGEROUS_PATTERNS`로 즉시 차단.

## 4. Key Invariants

- 자식 toolset ⊆ 부모 toolset (subset 항상 성립).
- `leaf` role은 `delegate_task`를 호출 못함 — re-delegate 봉쇄.
- `_AGENT_LOOP_TOOLS`는 dispatcher 이전에 intercept 필수 — 미처리 시 stub error 반환.
- Process-global `_last_resolved_tool_names`는 nested run 직전 save / 직후 restore.
- `ProcessHandle` Protocol을 모든 backend가 구현 — Popen 또는 `_ThreadedProcessHandle` 어댑터.
- Spawn-per-call: 매 command는 fresh shell — interactive REPL이나 long-lived shell session은 backend 책임.
- Guardrail decision의 `halt` action은 모든 후속 tool call을 block — turn 종료 요청과 동치.
- Hardline blocklist는 user approval로도 우회 불가 — 단계적 confirm조차 reject.

## 5. Notable Constants & Defaults

- `MAX_DEPTH = 1` (flat — parent depth 0, child depth 1). Clamp range `[1, 3]`.
- `delegation.max_concurrent_children` default 3.
- `delegation.child_timeout_seconds` default 600s, min 30s.
- `DELEGATE_BLOCKED_TOOLS` size = 5: `{delegate_task, clarify, memory, send_message, execute_code}`.
- `_AGENT_LOOP_TOOLS` size = 4: `{todo, memory, session_search, delegate_task}`.
- Guardrail warn thresholds: 2 / 3 / 2 (exact_failure / same_tool / no_progress).
- Tool definition TTL cache: ~30s (`model_tools.py`).
- Backend count = 7 (`local`, `docker`, `ssh`, `modal`, `daytona`, `singularity`, `vercel_sandbox`).

## 6. Comparison to auto_archive_mk3

| Hermes mechanism | auto_archive_mk3 등가물 |
| --- | --- |
| `tools/registry.py` singleton | 미존재 — `src/contracts/runtime-driver.ts` + `src/runtime/runtime-driver-factory.ts`로 driver-level만 |
| `_AGENT_LOOP_TOOLS` intercept | 부분적 — `src/core/dispatcher.ts` admission 단계 |
| `delegate_task` subagent | 부분적 — `src/runtime/subagent-operator.ts` + `src/runtime/subagent-roster.ts` |
| Toolset subset invariant | 미존재 — admission gate는 trait module 단위 |
| `MAX_DEPTH=1` clamp | 부분적 — subagent roster의 nested subagent 제한 |
| 7 terminal backend ABC | 부분적 — `src/core/compute-node.ts` + `src/core/compute-node-slurm-apptainer.ts` (1 backend) |
| `ProcessHandle` Protocol | 부분적 — `src/core/process-subprocess-runner.ts` |
| Guardrail threshold | 부분적 — `src/core/tool-loop-detector.ts` |
| `pre_tool_call` block | 부분적 — `src/core/admission-gate.ts` |

## 7. Adoption Notes

**Decision: PORT-PARTIAL (M4)**. M4에서 (a) terminal backend ABC를 `src/core/compute-node.ts` 위에 추가 (현재 slurm/apptainer만 → docker/ssh/local 분리), (b) `ProcessHandle` Protocol을 `src/contracts/`에 명문화, (c) tool guardrail threshold(2/3/2)를 `tool-loop-detector.ts`에 docstring으로 채택. Tool registry singleton과 import-time auto-register는 우리 contracts-first 모델과 충돌하므로 SKIP. Subagent depth clamp [1,3]은 `src/runtime/subagent-roster.ts`에 차용. Connection point: `src/contracts/process-handle.ts` (신규), `src/contracts/terminal-backend.ts` (신규).

## 8. Pitfalls / Anti-Patterns Observed

CODE_STANDARDS.md §8 후보:

- Subagent depth는 항상 explicit clamp range — unbounded recursion은 fork bomb 등가.
- Subagent toolset은 항상 parent superset of child — child가 parent에 없는 tool 갖는 path 차단.
- Re-delegate-blocked tools는 contract level에 명시 (frozenset 류) — runtime check만으로는 부족.
- Process-global state(`_last_resolved_tool_names` 류)는 nested run 직전 save / 직후 restore — try/finally 강제.
- 다중 backend의 공통 Protocol은 작은 surface로 — 큰 ABC는 신규 backend 추가 비용 증가.
- Spawn-per-call 모델에서 session state(env, cwd)는 명시적 marker로 persist — implicit shared shell 가정 금지.
- Guardrail decision은 4-state enum (`allow/warn/block/halt`) — boolean(allow/deny)는 부족, halt는 turn 종료 신호.
- Hardline blocklist는 user approval로도 우회 불가 — destructive command는 confirm 단계 자체를 두지 말 것.
- Tool schema description 안에 다른 tool 이름 cross-reference 금지 — "prefer X over Y" 같은 문구는 hallucination 유발.
- Subagent의 stdin 부재 — approval은 auto-deny 또는 auto-approve config로만 결정 (interactive prompt 금지).
