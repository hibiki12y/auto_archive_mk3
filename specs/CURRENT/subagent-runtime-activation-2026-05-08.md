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
scope: P4 Subagent Runtime Activation — invariants ratified for Stages 4-1 (foundation), 4-2 (operator UI + registry), 4-3 (lifecycle evidence stream), 4-4 (spawn-path activation). Stages 4-5/4-6 are out of scope and amended later.
---

# Subagent Runtime Activation (P4) — Stages 4-1 through 4-4 Invariants

## 1. Status

- Spec status: CURRENT (drafted 2026-05-08)
- Stages ratified by this spec: 4-1, 4-2, 4-3, 4-4
- Stages NOT yet ratified (in flight or future): 4-5 (operator action bridge), 4-6 (research-plan migration)
- Audit baseline: §07 grade F → B (capability landed; no production caller in `src/` yet beyond AgentRuntime infrastructure)
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

### 5.3 Session-log routing (deferred wiring)

INVARIANT (4-3.5) The Discord session-log lifecycle helpers (`buildSubagentLifecycleSessionLogPayload`, `routeSubagentLifecycleEventToSessionLog`, `resolveSubagentLifecycleSessionLogEnabledFromEnv`) exist but production wiring is deferred. The env flag `AUTO_ARCHIVE_DISCORD_SUBAGENT_LIFECYCLE_LOG` defaults off; until wiring lands the helpers are exercised only by tests. (`src/discord/discord-session-log-thread-router.ts:192`-`:279`.)

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

OBSERVATION (P4-cc.1) As of this spec ratification, only `AgentRuntime.execute(...)` constructs rosters, and only via the `subagentPolicyEnforcer` gate wired in `bootstrapDiscordService(...)`. The capability `roster.spawnAndRun(...)` exists and is unit-tested but no production code path invokes it. Stage 4-6 will add the first production caller (research-plan orchestrator).

OBSERVATION (P4-cc.2) `git grep createSubagentRoster -- src/ ':!**/__test__/**'` returns exactly the `agent-runtime.ts` call site plus the contract definition. The Stage 4-1 "no production spawn" regression (Stage 4-1 invariant in test form) pins this. (`tests/runtime/agent-runtime-roster-foundation.spec.ts:174`.)

## 8. Out of Scope (Future Amendments)

- Stage 4-5 operator action bridge (in flight; will amend §6 once landed): `/subagents kill` triggers real `RuntimeCancellationBoundary.cancel(veto)`; `/subagents send`/`steer` return `denied` with the documented reason.
- Stage 4-6 research-plan migration (will amend §7): first production caller of `roster.spawnAndRun(...)`; child evidence routing and child approval forwarding designed at that point.
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
