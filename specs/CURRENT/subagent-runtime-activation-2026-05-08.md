---
status: current
authority: invariant-ratification
last_verified: 2026-05-08
source_paths:
  - src/runtime/agent-runtime.ts
  - src/runtime/subagent-roster.ts
  - src/runtime/subagent-roster-registry.ts
  - src/runtime/subagent-policy-enforcer.ts
  - src/runtime/subagent-operator.ts
  - src/runtime/subagent-operator-evidence-ledger.ts
  - src/discord/discord-service-bootstrap.ts
  - src/discord/discord-session-log-thread-router.ts
  - src/core/doctor.ts
  - src/contracts/runtime-driver.ts
scope: P4 Subagent Runtime Activation — invariants ratified for Stages 4-1 (foundation), 4-2 (operator UI + registry), 4-3 (lifecycle evidence stream), 4-4 (spawn-path activation), 4-5 (operator action bridge), 4-6 (research-plan migration + Discord production caller wiring + single-slot emit-shim fail-closed guard).
---

# Subagent Runtime Activation (P4) — Stages 4-1 through 4-5 Invariants

## 1. Status

- Spec status: CURRENT (drafted 2026-05-08)
- Stages ratified by this spec: 4-1, 4-2, 4-3, 4-4, 4-5
- Stages NOT yet ratified (in flight or future): 4-6 (research-plan migration)
- Audit baseline: §07 grade F → B. Stages 4-1..4-5 land the foundation, operator UI, evidence stream, spawn path, and operator action bridge; Stage 4-6 lands the first production callers (CLI runner unconditionally + Discord `/research-plan` opt-in via `AUTO_ARCHIVE_DISCORD_RESEARCH_PLAN_USE_SUBAGENT_ROSTER=on`) and the single-slot emit-shim fail-closed re-entry guard. A-grade promotion requires retained live regression on the Discord opt-in path (deferred per §8).
- Ratification anchor: `~/.claude/plans/sequential-tickling-flurry.md` "P4 — Subagent Runtime Activation Slice (refined 2026-05-08)"

## 2. Pre-decided Architecture

The plan's "사전 결정 사항" table is binding for every stage in this spec; a change to any row forces stage re-design.

| 결정 | 채택안 | 본 spec에서의 정착점 |
|---|---|---|
| **첫 production caller** | (B) AgentRuntime 모든 task가 빈 root roster 보유; spawn은 Stage 4-4까지 미배선 | `src/runtime/agent-runtime.ts:954` (roster 변수), `:967` (enforcer 게이트), `:1058` (`createSubagentRoster` 호출) |
| **Child runtime 모델** | 동일 `RuntimeDriver` 인스턴스 재사용 + 신규 dispatch context. Provider session 격리는 Stage 4 후 별도 work-unit | `src/runtime/agent-runtime.ts:996` (`const driver = this.driver`) + `:1056` (`driver.run(childContext)`) |
| **Policy 기본값** | `maxDepth=1`, `maxConcurrent=2`, `allowedRoles=['explorer','coder','writer','verifier']`, `perRoleCaps={}` | `src/runtime/subagent-policy-enforcer.ts:269` (DEFAULT_ALLOWED_SUBAGENT_ROLES) + `:382` onward (`resolveSubagentPolicyFromEnv`) |

## 3. Stage 4-1 — Foundation

### 3.1 Roster lifetime

INVARIANT (4-1.1) The roster is dispatch-scoped: created in `AgentRuntime.execute(...)` immediately after dispatch identity materialization, terminated via `terminateAll(rosterCleanupCause)` in the dispatch's `finally` block. (`src/runtime/agent-runtime.ts:1058` for construction; `:2002` for `terminateAll`.)

INVARIANT (4-1.2) When `subagentPolicyEnforcer` is undefined (legacy callers), no roster is constructed and `instance.subagentRoster` stays undefined. The accessor is gated by an `undefined`-spread on `AgentInstance`. (`src/runtime/agent-runtime.ts:967`, `:1088`-`:1090`.)

INVARIANT (4-1.3) The roster is keyed off `(plan.taskId, runtimeInstanceId)` materialized within `execute(...)`. A second `execute(...)` call on the same `AgentRuntime` instance produces a fresh roster whose lifetime never overlaps the prior one. (`src/runtime/agent-runtime.ts:1058`-`:1067`.)

### 3.2 Policy defaults

INVARIANT (4-1.4) `resolveSubagentPolicyFromEnv(env)` returns the documented Stage 4-1 defaults: `maxDepth=1`, `maxConcurrent=2`, `allowedRoles=['explorer','coder','writer','verifier']`, `perRoleCaps={}`, `blockedToolNames=[]`, `warnAtPercent=0.8`. (`src/runtime/subagent-policy-enforcer.ts:379`-`:432`.)

INVARIANT (4-1.5) Each default is overridable via the `AUTO_ARCHIVE_SUBAGENT_*` env contract — `MAX_DEPTH`, `MAX_CONCURRENT`, `ALLOWED_ROLES`, `BLOCKED_TOOLS`, `WARN_AT_PERCENT`. Malformed values throw `RangeError` at boot; misconfiguration fails closed before first dispatch. (`src/runtime/subagent-policy-enforcer.ts:261`-`:267` for env-name table; `:281`-`:377` for parsers.)

INVARIANT (4-1.6) `'root-orchestrator'` MUST NOT appear in `allowedRoles`. The `ALLOWED_ROLES` parser rejects it with a `RangeError`; root role cannot be allowed as a child. (`src/runtime/subagent-policy-enforcer.ts:319`-`:323`.)

## 4. Stage 4-2 — Operator UI + Registry

### 4.1 Registry contract

INVARIANT (4-2.1) `SubagentRosterRegistry` is service-scoped (one per service boot, instantiated in `bootstrapDiscordService(...)`). Each `AgentRuntime.execute(...)` dispatch registers immediately after roster construction and unregisters in the same `finally` block. (`src/discord/discord-service-bootstrap.ts:1623` for service-scope creation; `src/runtime/agent-runtime.ts:1076` for register; `:2017` for unregister.)

INVARIANT (4-2.2) `register(...)` is idempotent on duplicate `taskId` (replaces the existing entry atomically). `unregister(taskId)` is idempotent on a missing `taskId` (no-op). Registry bookkeeping never aborts dispatch flow. (`src/runtime/subagent-roster-registry.ts:104`-`:113`.)

INVARIANT (4-2.3) `list()` returns a frozen snapshot. `totals()` aggregates `active`/`spawning`/`reserved` across every registered roster; a roster whose `snapshot()` throws contributes zero (defensive try/catch in `safeDescriptors`) so one broken roster cannot poison the doctor or operator panel. (`src/runtime/subagent-roster-registry.ts:78`-`:97` and `:122`-`:139`.)

### 4.2 Operator surface fan-out

INVARIANT (4-2.4) `SubagentOperatorSurface` accepts EITHER a single `roster` (legacy) OR a `rosterRegistry` (Stage 4-2); when neither is supplied the constructor throws. When given a registry, `info`/`kill`/`log`/`send`/`steer` resolve the owning roster via `findOwningRoster(subagentId)`. Subagent IDs are unique across registered rosters because each roster sequence-keys its own descriptors and IDs are never re-keyed. (`src/runtime/subagent-operator.ts:79`-`:88`, `:269` onward.)

### 4.3 Doctor active-subagent panel

INVARIANT (4-2.5) `resolveActiveSubagentDoctorStatus({subagentRosterRegistry?})` returns `undefined` when no registry is wired — env-only `/doctor` paths are unchanged. When wired, a registry-level probe failure produces `status: 'fail'` rather than throwing, so `/doctor` reports never break on a misbehaving registry. (`src/core/doctor.ts:1058`-`:1085`.)

## 5. Stage 4-3 — Lifecycle Evidence Stream

### 5.1 Event consumer attachment

INVARIANT (4-3.1) The event consumer is attached IMMEDIATELY after roster construction (before the registry `register` call) so no `subagent.spawned`/`subagent.completed`/`subagent.aborted`/`subagent.failed`/`roster.progress` event is dropped. (`src/runtime/agent-runtime.ts:1068`.)

INVARIANT (4-3.2) The event consumer is fire-and-forget: per-event sink errors are caught and counted via `subagentEvidenceObserverErrorCount()`. The consumer never throws outward and never closes the iterator on its own; only the dispatch `finally` block calls `iterator.return()` after `terminateAll`. (`src/runtime/agent-runtime.ts:682`-`:719` for `attachSubagentRosterEventConsumer`; `:2025`-`:2038` for teardown.)

### 5.2 Evidence ledger redaction

INVARIANT (4-3.3) `JsonlSubagentOperatorEvidenceLedger.append(event)` writes a redacted JSONL line that strips `reason` / `message` / `phase` / `cancelDetail` / `requestContext` / `stack` and any unmapped extras from the terminal cause before serialization. The redaction list matches the read-CLI's unsafe-payload heuristic so replay never silently drops a written line. (`src/runtime/subagent-operator-evidence-ledger.ts:104`-`:162` for `RedactedTerminalCause`; `:185`-`:206` for the JSONL ledger; `:277`-`:365` for per-cause redactors.)

INVARIANT (4-3.4) Artifact references on `subagent.completed`/`subagent.aborted` records are clamped to `{digest?, ref?}` strings ≤ 512 chars without CR/LF; non-conforming artifact payloads are recorded as `null`. (`src/runtime/subagent-operator-evidence-ledger.ts:367`-`:389`.)

### 5.3 Session-log routing

INVARIANT (4-3.5) The Discord session-log lifecycle helpers (`buildSubagentLifecycleSessionLogPayload`, `routeSubagentLifecycleEventToSessionLog`, `resolveSubagentLifecycleSessionLogEnabledFromEnv`) ship as the redacted operator-facing payload + dispatcher surface that the bootstrap composes into the AgentRuntime sink. The env flag `AUTO_ARCHIVE_DISCORD_SUBAGENT_LIFECYCLE_LOG` defaults off; production composition is wired in `discord-service-bootstrap.ts`. (`src/discord/discord-session-log-thread-router.ts:192`-`:279`.)

INVARIANT (4-3.deferred-followup) — When `AUTO_ARCHIVE_DISCORD_SUBAGENT_LIFECYCLE_LOG === 'on'` AND a session-log router is available, the bootstrap composes a multi-sink subagent event consumer (ledger + session-log) behind the single `subagentEvidenceLedgerSink` AgentRuntime hook. Each sink runs in its own try/catch so a per-sink failure does not prevent the other from receiving the event. (`src/discord/discord-service-bootstrap.ts:916` for `createSubagentLifecycleSessionLogSinkFromEnv`; `:954` for `composeSubagentEvidenceLedgerSinks`; `:830`-`:856` for the dispatch composition.) Production routers remain operator-supplied via `startDiscordFirstSliceBot({ sessionLogThreadRouter })`; when the env flag is `'on'` without a router, the bootstrap emits a one-time stderr warning and falls back to ledger-only.

## 6. Stage 4-4 — Spawn Path Activation

### 6.1 spawnAndRun contract

INVARIANT (4-4.1) `roster.spawnAndRun({options, instruction})` is enabled only when `parentContext.runChild` was provided to `createSubagentRoster(...)`. Without `runChild`, `spawnAndRun(...)` throws `Error('subagent.spawnAndRun is not enabled: parent context did not provide a runChild callback (Stage 4-4)')`. (`src/runtime/subagent-roster.ts:817`-`:821`.)

INVARIANT (4-4.2) `spawnAndRun(...)` calls the existing `spawn(...)` first. All admission validation — envelope narrowing, role/depth/concurrent caps, sandbox/approval/network override checks, blocked-tool gating — gates the descriptor before `runChild` is invoked. (`src/runtime/subagent-roster.ts:813`-`:822`.)

INVARIANT (4-4.3) On `runChild` success the roster derives a `TerminalCause` from `result.cause` (re-stamped with the parent's `taskId`/`runtimeInstanceId`), calls `terminate(...)`, and returns `{descriptor, result}`. On `runChild` throw the roster synthesizes a `provider-failure` cause with `classification: 'unknown'` and `provenance: 'subagent-roster.spawn-and-run'`, calls `terminate(...)`, then rethrows. Either way the slot is released. (`src/runtime/subagent-roster.ts:679`-`:718` for cause synthesis; `:822`-`:867` for the success/failure flow.)

### 6.2 Child runtime model

INVARIANT (4-4.4) Child task-id format is exactly `${parentTaskId}.sub-${subagentId}` (deterministic, parseable, log-correlatable). Child `instanceId` is `agent-${childTaskId}-${childStartedAt}`. (`src/runtime/agent-runtime.ts:1005`-`:1007`.)

INVARIANT (4-4.5) The child receives a FRESH `RuntimeExecutionContext`, not the parent's. The child's `isAborted()` mirrors the parent's terminal-cause latch via `currentTerminalCause() !== undefined`, so a parent abort cascades to in-flight child drivers. (`src/runtime/agent-runtime.ts:1037`-`:1055`.)

INVARIANT (4-4.6) The child's `instance.subagentRoster` is undefined and `instance.parentDepth` is `1`. Depth=1 cap is enforced structurally — children cannot spawn grandchildren — independent of the policy enforcer's `maxDepth`. (`src/runtime/agent-runtime.ts:1026`-`:1036`.)

INVARIANT (4-4.7) The child uses the parent's same `RuntimeDriver` instance (no fresh provider session per child). This trades isolation for cost; provider-session leakage is not yet measured and is reserved for a future amendment. (`src/runtime/agent-runtime.ts:996` + `:1056`.)

INVARIANT (4-4.8) Stage 4-4 child runtime events are dropped: the child's `emit` is a no-op (re-using the parent `emit` would mis-tag child events with the parent `instanceId`) and `requestApproval` returns a synchronous `rejected` decision (no operator approval surface for children yet). Child evidence routing is deferred to Stage 4-6. (`src/runtime/agent-runtime.ts:1040`-`:1053`.)

INVARIANT (4-4.9) Parent abort propagation: when the roster's `parentTerminationSignal` fires, `terminateAll({kind: 'external-cancel', provenance: 'parent-termination-signal'})` runs as best-effort cleanup. Failures are swallowed into a structured warn so abort never crashes the host. (`src/runtime/subagent-roster.ts:628`-`:665`.)

## 7. Production Caller Status

OBSERVATION (P4-cc.1) As of Stage 4-6 ratification, the production caller surface has THREE invocation points: (a) `AgentRuntime.execute(...)` constructs the dispatch-scoped roster (Stage 4-1 foundation), (b) the CLI runner constructs an explicit roster when `--use-subagent-roster` is set (4-6.6), and (c) the Discord `/research-plan` handler constructs a per-dispatch roster when `AUTO_ARCHIVE_DISCORD_RESEARCH_PLAN_USE_SUBAGENT_ROSTER=on` is set (4-6.7, 4-6.8). The capability `roster.spawnAndRun(...)` is invoked from both (b) and (c) when those opt-ins are active. The Discord opt-in is OFF by default; live regression on the opt-in path is the sensor that promotes §07 from B → A.

OBSERVATION (P4-cc.2) `git grep createSubagentRoster -- src/ ':!**/__test__/**'` returns the `agent-runtime.ts` call site, the contract definition, the Discord handler call site (Stage 4-6 commit 3), and the helper module's docstring example. The Stage 4-1 "no production spawn" regression test pins the AgentRuntime side; the Discord opt-in is pinned by `tests/discord-handle-research-plan.spec.ts` (4-6.10). (`tests/runtime/agent-runtime-roster-foundation.spec.ts:174`.)

## 8. Out of Scope (Future Amendments)

- Stage 4-6 live regression on the Discord opt-in path (B → A grade lift requires retained live evidence; code path fully unit + integration tested as of §12).
- Parallel sub-task fan-out (`maxConcurrent>1` for the orchestrator caller). Current single-slot emit-shim is fail-closed on re-entry (4-6.3); fan-out support requires replacing the slot with a per-sub-task keyed registry.
- Provider-session isolation between parent and child runtime drivers.
- Grandchild support (depth ≥ 2). Currently structurally forbidden by §6 (4-4.6).
- Mid-flight provider-session injection (`/subagents send`/`steer` interactive).

## 9. Live Verification Path

The Codex SDK live smoke at `scripts/subagent-spawn-live-smoke.mjs` exercises §6 invariants end-to-end (root → single explorer child → terminal success). It is operator-only (skips when `~/.codex/auth.json` is absent) and is excluded from `pnpm verify`.

## 10. References

- Plan file: `~/.claude/plans/sequential-tickling-flurry.md` (search "P4 — Subagent Runtime Activation Slice (refined 2026-05-08)")
- Audit baseline: `/tmp/comprehensive-audit-report.md` §07
- Stage 4-1 invariants in test form: `tests/runtime/agent-runtime-roster-foundation.spec.ts`
- Stage 4-1 policy defaults in test form: `tests/runtime/subagent-policy-from-env.spec.ts`
- Stage 4-2 registry invariants in test form: `tests/runtime/subagent-roster-registry.spec.ts`
- Stage 4-3 evidence redaction in test form: `tests/runtime/subagent-operator-evidence-ledger.spec.ts`
- Stage 4-4 spawn-and-run invariants in test form: `tests/runtime/subagent-roster-spawn-and-run.spec.ts`
- Stage 4-4 dispatch wiring in test form: `tests/runtime/agent-runtime-spawn-path.spec.ts`
- Stage 4-5 roster cancellation invariants in test form: `tests/runtime/subagent-roster-cancellation.spec.ts`
- Stage 4-5 per-child AbortController wiring in test form: `tests/runtime/agent-runtime-spawn-cancel.spec.ts`
- Stage 4-5 operator action bridge in test form: `tests/runtime/subagent-operator-action-bridge.spec.ts`

## 11. Stage 4-5 — Operator Action Bridge

### 11.1 RunChildHandle opt-in shape

INVARIANT (4-5.1) The roster's `parentContext.runChild` callback may return either `Promise<RuntimeDriverResult>` (legacy Stage 4-4 shape) or `Promise<RunChildHandle>` where `RunChildHandle = {result: Promise<RuntimeDriverResult>, cancel: (reason: string) => void}`. The roster duck-types the response via `'result' in value && typeof value.cancel === 'function'`; legacy callers continue to work and `cancelActive(...)` simply reports `false` for them. (`src/runtime/subagent-roster.ts:131`-`:144` for the type + duck-type guard; `:984`-`:998` for the dispatch fork.)

### 11.2 Active-handle bookkeeping

INVARIANT (4-5.2) `cancelActive(subagentId, reason)` returns `true` and invokes the in-flight handle's `cancel(reason)` when an active handle is registered for `subagentId`; returns `false` otherwise (legacy `runChild` path, no in-flight dispatch, or descriptor already terminated). The roster maintains an `activeHandles` map keyed by `subagentId`; entries are inserted on `runChild` resolution to a handle and removed automatically on the spawnAndRun finally-block, on `cancelActive(...)` itself, and on `terminateAll(...)` drain. Cancel-callback throws are swallowed into a structured `subagent-roster.cancel-active-threw` warn so cancellation never crashes the host. (`src/runtime/subagent-roster.ts:318` for the map declaration; `:742`-`:768` for `cancelActive`; `:984`-`:998` for insertion/removal.)

INVARIANT (4-5.3) Per-child `AbortController` in `AgentRuntime.execute(...)`'s `runChild`. Each child dispatch owns a fresh `AbortController`; the child's `RuntimeExecutionContext.isAborted()` returns `true` when EITHER the parent's terminal-cause latch is set (`currentTerminalCause() !== undefined`) OR the local controller's signal is aborted. Operator-driven `cancelActive(...)` flips ONLY the local controller — the parent dispatch continues normally. The parent's terminal-cause latch still cascades to every child (Stage 4-4 invariant 4-4.5 preserved). (`src/runtime/agent-runtime.ts:1056` for the controller; `:1074`-`:1077` for the OR'd `isAborted`; `:1079`-`:1099` for the returned handle + `cancel`.)

### 11.3 Operator surface bridge

INVARIANT (4-5.4) `/subagents kill <id>` performs real per-child cancellation. `SubagentOperatorSurface.kill(subagentId, reason)` resolves the owning roster (registry- or single-roster-shaped) and calls `roster.cancelActive(subagentId, reason)`. On `true` the result is `{status: 'ok', descriptor, message: 'Subagent <id> cancel signaled.'}`. On `false` the result is `{status: 'denied', reason: 'subagent is not in an active dispatch state'}`. The audit log entry is appended in BOTH branches (and on the not-found / no-owning-roster pre-checks) so operator intent is always observable for replay. (`src/runtime/subagent-operator.ts:158`-`:191`.)

INVARIANT (4-5.5) `/subagents send` and `/subagents steer` are explanatorily denied with a stable reason. Both actions route through the private `sendLike(...)` helper and return `{status: 'denied', reason: 'mid-flight injection is not supported by current provider session shape; use /subagents kill <id> and re-dispatch'}`. The denied reason is exported as the module constant `SUBAGENT_OPERATOR_MID_FLIGHT_INJECTION_DENIED_REASON` so callers and tests pin the exact string. The audit log records the attempt verbatim (operator intent visibility for replay); descriptors are never mutated. (`src/runtime/subagent-operator.ts:62`-`:67` for the constant; `:204`-`:210` for the public methods; `:242`-`:259` for the helper.)

### 11.4 Termination ordering and boundary scope

INVARIANT (4-5.6) `terminateAll(cause)` drains the active-handle table BEFORE iterating per-descriptor `terminate(...)`. The roster snapshots `activeHandles.entries()`, clears the map, and invokes `cancel('parent terminating')` on each handle (best-effort; cancel-callback throws are swallowed into `subagent-roster.terminate-all-cancel-threw` warns). This prevents the race where slot release would otherwise outpace the in-flight cancel signal. (`src/runtime/subagent-roster.ts:692`-`:734`.)

INVARIANT (4-5.7) Stage 4-5 cancellation does NOT call `RuntimeCancellationBoundary.cancel(...)`. The per-child `cancel(reason)` aborts the child's local `AbortController` only; the child driver observes the flip on its next `isAborted()` poll and surfaces a runtime-veto / external-cancel cause through its normal terminal path. Boundary-direct cancellation requires each child dispatch to own its own `RuntimeCancellationBoundary`, which is deferred to Stage 4-6 once the first production caller exists and child boundary semantics are designed. (`src/runtime/agent-runtime.ts:1081`-`:1098`.)

### 11.5 Observations

OBSERVATION (4-5.O1) Real interactivity (mid-flight `send`/`steer`) is bounded by SDK capability, not by Stage 4-5 design choice. When the underlying provider sessions grow inline-instruction injection, the denied-reason invariant in 4-5.5 may relax in a future amendment; the kill-and-re-dispatch path documented in the denied reason is the only honest contract on the current branch.

OBSERVATION (4-5.O2) The `RunChildHandle` opt-in shape preserves Stage 4-4 callers byte-for-byte: legacy bare-`Promise<RuntimeDriverResult>` returns from `runChild` skip the `activeHandles` map entirely, so `cancelActive(...)` reports `false` and `/subagents kill` denies — matching pre-Stage 4-5 behavior for any caller that has not yet adopted the handle.

## 12. Stage 4-6 — Research-Plan Roster Migration

This section ratifies the Stage 4-6 contract that was deferred at §7 / §8 of this spec when stages 4-1..4-5 were ratified. Stage 4-6 lands across three logical commits: (1) orchestrator `subagentRoster?` option + helper module; (2) CLI runner `--use-subagent-roster` flag; (3) Discord production caller wiring + single-slot emit-shim fail-closed guard.

INVARIANT (4-6.1) `runResearchPlan(driver, plan, options)` accepts an optional `subagentRoster?: SubagentRoster`. When supplied, every sub-task (and the synthesis) is dispatched via `subagentRoster.spawnAndRun({options:{role:subagentRole}, instruction})` instead of `driver.run(...)`. When omitted, the legacy `driver.run(...)` path is preserved bit-for-bit so existing callers see no behavior change. (`src/core/research-plan-orchestrator.ts:687`-`:701`.)

INVARIANT (4-6.2) The roster path uses a per-sub-task emit-forwarding "shim" because each `roster.spawnAndRun(...)` constructs its own child `RuntimeExecutionContext` and the orchestrator cannot pass its accumulator-emit closure through directly. The shim is a SINGLE module-scoped slot (`orchestratorCurrentEmitShim`) — the orchestrator dispatches sub-tasks STRICTLY SEQUENTIALLY, so at most one shim is active at any moment. The dispatch site sets the slot before `spawnAndRun(...)` and clears it in a `finally` block. (`src/core/research-plan-orchestrator.ts:687`-`:698`, `:742`-`:782`.)

INVARIANT (4-6.3) `registerOrchestratorEmitShim(emit)` is fail-closed on re-entry: it throws `OrchestratorEmitShimReentryError` when called while a previous shim is still active. This converts the latent fan-out failure mode (concurrent `runResearchPlan` calls would otherwise silently overwrite each other's shim) into a loud, immediate error. Any future caller introducing parallel sub-task fan-out must replace the single-slot pattern with a per-sub-task keyed registry rather than working around the throw. (`src/core/research-plan-orchestrator.ts:752`-`:779`.)

INVARIANT (4-6.4) The single-slot shim invariants are pinned by unit tests: `getOrchestratorEmitShim()` returns `undefined` before any registration, returns the registered callable after `registerOrchestratorEmitShim(emit)`, returns `undefined` after `unregisterOrchestratorEmitShim()`, throws `OrchestratorEmitShimReentryError` on register-while-registered (and the active shim is unchanged), and `unregisterOrchestratorEmitShim()` is idempotent. (`tests/research-plan-orchestrator.spec.ts` — `orchestrator emit shim — single-slot invariants` describe block, 5 tests.)

INVARIANT (4-6.5) `createResearchPlanRunChild(driver)` builds a roster `runChild` callback whose returned `RunChildHandle` carries a per-child `AbortController` so `roster.cancelActive(subagentId, reason)` aborts an in-flight child without disturbing the parent dispatch. Child task ids follow the Stage 4-4 format `${parentTaskId}.sub-${subagentId}` (4-4.4), exposed publicly via `formatChildTaskId(parentTaskId, subagentId)`. (`src/runtime/research-plan-roster-helpers.ts:96`-`:189`, `:199`-`:204`.)

INVARIANT (4-6.6) The research-plan CLI runner exposes `--use-subagent-roster`. When set, the runner constructs a single dispatch-scoped roster shared across every sub-task and the synthesis, with its `runChild` from `createResearchPlanRunChild(driver)` and policy from `resolveSubagentPolicyFromEnv(process.env)`. When unset, the runner uses the legacy `driver.run(...)` path. (`scripts/research-plan-runner.mjs:178`-`:210`.)

INVARIANT (4-6.7) The Discord `/research-plan` handler accepts BOTH `researchPlanSubagentPolicyEnforcer?: SubagentPolicyEnforcer` AND `researchPlanUseSubagentRoster?: boolean`. When BOTH are supplied (and the boolean is `true`), the handler builds a fresh per-dispatch `SubagentRoster` for each `/research-plan` invocation — keyed off the plan's resource envelope and runtime settings — and passes it through to `runResearchPlan(driver, plan, {subagentRoster, onEvent})`. When either is omitted, the legacy `runResearchPlan(driver, plan, {onEvent})` path is preserved bit-for-bit. (`src/discord/discord-command-handlers.ts:454`-`:470`, `:2768`-`:2796`.)

INVARIANT (4-6.8) `discord-service-bootstrap.ts` resolves the env flag `AUTO_ARCHIVE_DISCORD_RESEARCH_PLAN_USE_SUBAGENT_ROSTER` (case-insensitive `'on'`) and constructs a `SubagentPolicyEnforcer` from `resolveSubagentPolicyFromEnv(serviceEnv)`. Both are threaded through `startDiscordFirstSliceBot(...)` to `DiscordCommandHandlers`. The default is OFF — when the env var is unset or any value other than `'on'`, the handler keeps the legacy bit-for-bit path. (`src/discord/discord-service-bootstrap.ts` `AUTO_ARCHIVE_DISCORD_RESEARCH_PLAN_USE_SUBAGENT_ROSTER` constant + bootstrap composition.)

INVARIANT (4-6.9) Concurrent `/research-plan` invocations remain isolated by construction. Each Discord dispatch calls `createSubagentRoster(...)` with a fresh `taskId`/`instanceId`/envelope/runtime-settings tuple, so per-dispatch state never crosses invocations. The `OrchestratorEmitShimReentryError` is the safety net: if a future code path were to invoke `runResearchPlan` twice concurrently in-process, the second call's `registerOrchestratorEmitShim(...)` would fail closed before any silent shim overwrite can corrupt event accounting. (`src/discord/discord-command-handlers.ts:2768`-`:2796`; failure case observable via `tests/research-plan-orchestrator.spec.ts` `throws OrchestratorEmitShimReentryError on register-while-registered`.)

INVARIANT (4-6.10) The Discord opt-in path is verified by integration test: when `researchPlanUseSubagentRoster: true` AND a policy enforcer are supplied, every observed sub-task driver invocation sees a child task id containing `.sub-` (matching the Stage 4-4 format). When either option is omitted, sub-task driver invocations see the plan's bare sub-task taskIds without `.sub-` — the legacy bit-for-bit path. (`tests/discord-handle-research-plan.spec.ts` — `routes sub-tasks through roster.spawnAndRun when researchPlanUseSubagentRoster is true` and `keeps legacy driver.run path when researchPlanUseSubagentRoster is omitted`.)

OBSERVATION (4-6.O1) Stage 4-6 closes the §7 production-caller gap for the CLI runner unconditionally and for the Discord handler conditionally (env-gated, default OFF). The §7 grade lift to A-tier requires a live regression on the Discord opt-in path — code path is fully unit + integration tested but the live regression is the sensor that promotes B → A.

OBSERVATION (4-6.O2) The single-slot emit-shim was the root cause of the v1 PHASE-C live regression telemetry gap (commit 234d5d2). The pre-fix helper looked up the shim by parent-context taskId (constant across sub-tasks because the roster carries the parent's taskId) while the orchestrator registered by per-sub-task request taskId — every map lookup missed and every child event was silently dropped. The single-slot replacement plus the fail-closed re-entry guard close that bug class. The DT Audit Ultra-Team v3.1 PHASE 1 review (2026-05-09) corroborated the code-path fix and surfaced the absence of the test pin and re-entry guard as the residual risk; INVARIANTs 4-6.3 and 4-6.4 close those.
