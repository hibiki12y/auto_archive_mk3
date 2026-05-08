import { resolve } from 'node:path';

import {
  assertSubagentRole,
  DEFAULT_PER_ROLE_CAPS,
  DEFAULT_ROSTER_MAX_CONCURRENCY,
  freezeDescriptorEnvelope,
  type RosterConfig,
  type SpawnOptions,
  type SubagentCorrelationKey,
  type SubagentDescriptor,
  type SubagentRole,
  type SubagentRunResult,
  type SubagentState,
} from '../contracts/subagent-roster.js';
import type {
  RosterEvent,
  RosterProgressEvent,
} from '../contracts/subagent-roster-event.js';
import type { ResourceEnvelope } from '../contracts/resource-envelope.js';
import type { RuntimeDriverResult } from '../contracts/runtime-driver.js';
import type {
  RuntimeSandboxMode,
  RuntimeSettingsBundle,
} from '../contracts/runtime-settings.js';
import type {
  TerminalCause,
  TerminalCauseProviderFailure,
  TerminalCauseRuntimeVeto,
} from '../contracts/terminal-cause.js';
import { createVetoPath } from '../contracts/veto.js';
import {
  createRosterEventStream,
  type RosterEventStream,
} from './subagent-roster-event-stream.js';

export interface CreateSubagentRosterParentContext {
  readonly taskId: string;
  readonly instanceId: string;
  readonly envelope: ResourceEnvelope;
  readonly runtimeSettings?: RuntimeSettingsBundle;
  readonly spawnAuthority?: 'root' | 'subagent';
  readonly parentTerminationSignal?: AbortSignal;
  /**
   * M4 — Optional policy enforcer consulted before the roster's existing
   * cap checks on every spawn. The enforcer adds role-allowlist gating,
   * a depth cap, and an evidence-only 80% utilization warning channel.
   * Existing roster behavior is unchanged when omitted.
   *
   * @see src/runtime/subagent-policy-enforcer.ts
   */
  readonly policyEnforcer?: import('./subagent-policy-enforcer.js').SubagentPolicyEnforcer;
  /**
   * M4 — Depth of this roster's parent in the subagent tree. The root
   * task is depth 0; depth-1 subagents (the only kind currently spawned)
   * have parents at depth 0. The policy enforcer is consulted with
   * `depth = parentDepth + 1` so the cap applies to the *child* about
   * to spawn.
   */
  readonly parentDepth?: number;
  /**
   * M5b — Tier-2 subagent lifecycle hooks. Each binding fires once per
   * spawn (after the descriptor is created) and once per terminal state
   * change. Hooks are observation-only and error-contained.
   */
  readonly subagentLifecycleHooks?: ReadonlyArray<{
    readonly moduleId: string;
    readonly moduleVersion: string;
    readonly subagentSpawn?: import('../contracts/trait-runtime-hook.js').TraitSubagentSpawnHook;
    readonly subagentTerminal?: import('../contracts/trait-runtime-hook.js').TraitSubagentTerminalHook;
  }>;
  /**
   * P4 Stage 4-4 — child-launch callback.
   *
   * When supplied, `roster.spawnAndRun(...)` is enabled: the roster admits
   * the descriptor via the existing `spawn(...)` flow, then calls this
   * callback with the admitted descriptor and the child instruction. The
   * callback is responsible for:
   *   - constructing a child `DispatchPlan` with the narrowed envelope and
   *     `runtimeSettings` (sandboxed by the descriptor's overrides)
   *   - building a child `RuntimeExecutionContext`
   *   - calling the parent's `RuntimeDriver.run(childContext)`
   *   - returning the `RuntimeDriverResult` for the child (Stage 4-4
   *     legacy shape) OR a `RunChildHandle` exposing both the child
   *     result promise AND a `cancel(reason)` hook (Stage 4-5+).
   *
   * The roster handles the post-run `terminate(...)` mapping based on
   * the returned cause (success path), or synthesizes a
   * `provider-failure` cause and rethrows if the callback throws (error
   * path). When this callback is undefined, `spawnAndRun(...)` throws a
   * clear error directing callers to wire the callback.
   *
   * P4 Stage 4-5 — return a `RunChildHandle` (rather than a bare
   * `RuntimeDriverResult`) so the operator surface can reach into an
   * in-flight child dispatch and abort it via `roster.cancelActive(...)`
   * without aborting the parent. The legacy bare-result shape is still
   * accepted for backward compatibility with Stage 4-4 callers and
   * tests; in that mode `cancelActive(...)` returns false because no
   * cancel hook was registered.
   *
   * The roster does NOT recursively allow children to spawn grandchildren
   * (depth cap enforced by `SubagentPolicyEnforcer`).
   *
   * @see src/runtime/agent-runtime.ts (Stage 4-4 caller plumbing)
   * @see RunChildHandle (Stage 4-5)
   */
  readonly runChild?: (input: {
    readonly descriptor: SubagentDescriptor;
    readonly instruction: string;
    readonly parentContext: {
      readonly taskId: string;
      readonly instanceId: string;
    };
  }) => Promise<RuntimeDriverResult> | Promise<RunChildHandle>;
}

/**
 * P4 Stage 4-5 — handle returned from `runChild` when the caller wants
 * the operator surface to be able to cancel an in-flight child without
 * aborting the parent. `result` resolves with the child's
 * `RuntimeDriverResult`; `cancel(reason)` is the side-channel that the
 * roster invokes from `cancelActive(subagentId, reason)` and from
 * `terminateAll(...)` so any active child stops promptly.
 *
 * Stage 4-4 callers MAY continue to return a bare
 * `Promise<RuntimeDriverResult>` from `runChild`. The roster wraps such
 * a return in a stub handle whose `cancel` is a no-op; in that mode
 * operator-driven cancel reports `false` because there is no real
 * cancel signal to invoke.
 */
export interface RunChildHandle {
  readonly result: Promise<RuntimeDriverResult>;
  readonly cancel: (reason: string) => void;
}

function isRunChildHandle(
  value: RuntimeDriverResult | RunChildHandle,
): value is RunChildHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'result' in value &&
    typeof (value as { result?: unknown }).result === 'object' &&
    typeof (value as { cancel?: unknown }).cancel === 'function'
  );
}

export interface RuntimeVetoErrorOptions {
  readonly cause: TerminalCauseRuntimeVeto;
}

export class RuntimeVetoError extends Error {
  override readonly name = 'RuntimeVetoError';
  readonly cause: TerminalCauseRuntimeVeto;

  constructor(options: RuntimeVetoErrorOptions) {
    super(options.cause.reason);
    this.cause = options.cause;
  }
}

interface InternalSubagentDescriptor {
  readonly subagentId: string;
  readonly role: SubagentRole;
  readonly parent: {
    readonly taskId: string;
    readonly instanceId: string;
  };
  readonly createdAt: string;
  state: SubagentState;
  readonly envelope: Readonly<ResourceEnvelope>;
  slotReleased: boolean;
}

const SANDBOX_MODE_RANK = Object.freeze({
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
} satisfies Record<RuntimeSandboxMode, number>);

function isRuntimeSandboxMode(value: unknown): value is RuntimeSandboxMode {
  return (
    value === 'read-only' ||
    value === 'workspace-write' ||
    value === 'danger-full-access'
  );
}

export interface SubagentRoster {
  spawn(options: SpawnOptions): Promise<SubagentDescriptor>;
  /**
   * P4 Stage 4-4 — admit a descriptor (via `spawn(...)`) and launch a
   * child runtime via the parent context's `runChild` callback.
   *
   * This method is enabled only when `runChild` was supplied at roster
   * construction time. When omitted, this throws a clear error so
   * callers know to wire the parent context properly. On success, the
   * descriptor's slot is released and a `subagent.completed` /
   * `subagent.failed` / `subagent.aborted` event is emitted (mapped
   * from the child's terminal cause). On runChild thrown error, the
   * roster synthesizes a `provider-failure` terminal cause, terminates
   * the slot, then rethrows so the caller observes the failure.
   *
   * @see CreateSubagentRosterParentContext.runChild
   */
  spawnAndRun(input: {
    readonly options: SpawnOptions;
    readonly instruction: string;
  }): Promise<SubagentRunResult>;
  terminate(
    subagentId: string,
    cause: TerminalCause,
    terminalData?: {
      artifact?: unknown;
      partialArtifact?: { digest?: string; ref?: string } | null;
    },
  ): Promise<void>;
  terminateAll(cause: TerminalCause): Promise<void>;
  /**
   * P4 Stage 4-5 — operator-driven per-child cancellation. Look up the
   * `RunChildHandle` registered for `subagentId` (only present when the
   * `runChild` callback opted into Stage 4-5's handle-returning shape)
   * and invoke its `cancel(reason)` so the in-flight child runtime
   * short-circuits without affecting the parent dispatch. Returns
   * `true` when a handle was found and cancel was invoked; returns
   * `false` when:
   *   - the subagentId is unknown
   *   - the subagentId is known but already terminated
   *   - the runChild callback returned the legacy bare
   *     `RuntimeDriverResult` (no cancel hook to invoke)
   *
   * The boolean return is what the operator surface uses to decide
   * between `{ status: 'ok' }` and a `{ status: 'denied' }` response on
   * `/subagents kill`.
   *
   * `cancelActive(...)` does NOT itself call `terminate(...)`: the
   * runChild path is responsible for completing with a terminal cause
   * (the cancel propagates through the child runtime and surfaces as
   * a runtime-veto / external-cancel cause on the result), at which
   * point `spawnAndRun(...)`'s post-run terminate maps the cause and
   * releases the slot. If the child does not honor cancellation and
   * eventually completes some other way, `terminate(...)` still runs
   * with the late cause.
   */
  cancelActive(subagentId: string, reason: string): boolean;
  readonly events: AsyncIterable<RosterEvent>;
  snapshot(): readonly SubagentDescriptor[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toCorrelationKey(
  descriptor: InternalSubagentDescriptor,
): SubagentCorrelationKey {
  return {
    taskId: descriptor.parent.taskId,
    instanceId: descriptor.parent.instanceId,
    subagentId: descriptor.subagentId,
  };
}

function toSnapshot(descriptor: InternalSubagentDescriptor): SubagentDescriptor {
  return Object.freeze({
    subagentId: descriptor.subagentId,
    role: descriptor.role,
    parent: Object.freeze({
      taskId: descriptor.parent.taskId,
      instanceId: descriptor.parent.instanceId,
    }),
    createdAt: descriptor.createdAt,
    state: descriptor.state,
    envelope: descriptor.envelope,
  });
}

function buildRuntimeVetoCause(params: {
  taskId: string;
  instanceId: string;
  reason: string;
  provenance: string;
  vetoSource?: 'admission' | 'runtime';
}): TerminalCauseRuntimeVeto {
  const observedAt = new Date().toISOString();
  return {
    kind: 'runtime-veto',
    taskId: params.taskId,
    runtimeInstanceId: params.instanceId,
    observedAt,
    provenance: params.provenance,
    reason: params.reason,
    veto: createVetoPath('runtime', params.reason, params.provenance),
    ...(params.vetoSource === undefined ? {} : { vetoSource: params.vetoSource }),
    cancellation: {
      requestedAt: observedAt,
      cancelMode: 'preemptive',
      cancelDetail: { originPort: 'roster-saturation-latch' },
    },
  };
}

export function createSubagentRoster(
  parentContext: CreateSubagentRosterParentContext,
  config: RosterConfig = {},
): SubagentRoster {
  const eventStream: RosterEventStream = createRosterEventStream();
  const descriptors = new Map<string, InternalSubagentDescriptor>();
  const usedSubagentIds = new Set<string>();
  const roleCounters = new Map<SubagentRole, number>();
  /**
   * P4 Stage 4-5 — per-subagent in-flight cancel hooks. Populated only
   * when the `runChild` callback opts into Stage 4-5's handle-returning
   * shape; cleaned up in `spawnAndRun(...)` after the child resolves
   * (success or thrown), and in `terminateAll(...)` so a parent abort
   * also drains the table.
   */
  const activeHandles = new Map<string, RunChildHandle>();

  let sequence = 0;
  let reservedCount = 0;
  let completedCount = 0;
  let abortedCount = 0;
  let failedCount = 0;
  let totalNonRootAdmitted = 0;
  let parentTerminationApplied = false;

  const maxConcurrent = config.maxConcurrent ?? DEFAULT_ROSTER_MAX_CONCURRENCY;
  const perRoleCaps: Partial<Record<SubagentRole, number>> = {
    ...DEFAULT_PER_ROLE_CAPS,
    ...(config.perRoleCaps ?? {}),
  };
  const inheritedEnvelope = freezeDescriptorEnvelope(parentContext.envelope);
  const spawnAuthority = parentContext.spawnAuthority ?? 'root';

  const releaseSlot = (descriptor: InternalSubagentDescriptor): void => {
    if (descriptor.slotReleased) {
      return;
    }
    descriptor.slotReleased = true;
    reservedCount = Math.max(0, reservedCount - 1);
    const roleCount = roleCounters.get(descriptor.role) ?? 0;
    if (roleCount <= 1) {
      roleCounters.delete(descriptor.role);
      return;
    }
    roleCounters.set(descriptor.role, roleCount - 1);
  };

  const createRuntimeVetoError = (
    reason: string,
    provenance: string,
    vetoSource?: 'admission' | 'runtime',
  ): RuntimeVetoError =>
    new RuntimeVetoError({
      cause: buildRuntimeVetoCause({
        taskId: parentContext.taskId,
        instanceId: parentContext.instanceId,
        reason,
        provenance,
        vetoSource,
      }),
    });

  const policyEnforcer = parentContext.policyEnforcer;
  const childDepth = (parentContext.parentDepth ?? 0) + 1;
  const subagentLifecycleHooks = parentContext.subagentLifecycleHooks ?? [];

  const validateRequestedToolNames = (
    requestedToolNames: unknown,
  ): readonly string[] | undefined => {
    if (requestedToolNames === undefined) {
      return undefined;
    }
    if (!Array.isArray(requestedToolNames)) {
      throw new TypeError(
        'spawn options requestedToolNames must be an array of strings when provided',
      );
    }
    const validated = requestedToolNames.map((toolName) => {
      if (
        typeof toolName !== 'string' ||
        toolName.length === 0 ||
        toolName.trim().length === 0
      ) {
        throw new TypeError(
          'spawn options requestedToolNames entries must be non-empty non-blank strings',
        );
      }
      return toolName;
    });
    return Object.freeze(validated);
  };

  const reserveSlot = (
    role: SubagentRole,
    requestedToolNames?: readonly string[],
  ): void => {
    if (policyEnforcer !== undefined) {
      const decision = policyEnforcer.evaluate({
        role,
        depth: childDepth,
        currentConcurrent: reservedCount,
        currentPerRole: roleCounters.get(role) ?? 0,
        ...(requestedToolNames === undefined ? {} : { requestedToolNames }),
      });
      if (decision.status === 'denied') {
        throw createRuntimeVetoError(
          decision.reason ?? 'subagent-policy-denied',
          `subagent-policy:${role}`,
          'admission',
        );
      }
    }
    if (reservedCount >= maxConcurrent) {
      throw createRuntimeVetoError(
        'roster-saturation',
        'roster-cap:per-roster',
        'admission',
      );
    }
    const roleCap = perRoleCaps[role];
    if (roleCap !== undefined && (roleCounters.get(role) ?? 0) >= roleCap) {
      throw createRuntimeVetoError(
        'roster-saturation',
        `roster-cap:per-role:${role}`,
        'admission',
      );
    }
    reservedCount += 1;
    roleCounters.set(role, (roleCounters.get(role) ?? 0) + 1);
  };

  const validateWorkingDirectory = (workingDirectory: unknown): void => {
    if (workingDirectory === undefined) {
      return;
    }
    if (typeof workingDirectory !== 'string') {
      throw new TypeError('spawn options workingDirectory must be a string when provided');
    }
    if (parentContext.runtimeSettings?.workingDirectory === undefined) {
      return;
    }
    const parentDir = resolve(parentContext.runtimeSettings.workingDirectory);
    const childDir = resolve(workingDirectory);
    if (!(childDir === parentDir || childDir.startsWith(`${parentDir}/`))) {
      throw new TypeError('spawn options workingDirectory must narrow to a parent subdirectory');
    }
  };

  const validateSandboxOverride = (sandboxOverride: unknown): void => {
    if (sandboxOverride === undefined) {
      return;
    }
    if (!isObject(sandboxOverride)) {
      throw new TypeError('spawn options sandboxOverride must be an object when provided');
    }
    const parentSettings = parentContext.runtimeSettings;
    if (parentSettings === undefined) {
      throw new TypeError(
        'spawn options sandboxOverride cannot be supplied when parent runtimeSettings are unavailable',
      );
    }
    if (
      sandboxOverride.sandboxMode !== undefined &&
      !isRuntimeSandboxMode(sandboxOverride.sandboxMode)
    ) {
      throw new TypeError('sandboxOverride.sandboxMode is invalid');
    }
    if (
      sandboxOverride.approvalPolicy !== undefined &&
      sandboxOverride.approvalPolicy !== 'never' &&
      sandboxOverride.approvalPolicy !== 'on-request'
    ) {
      throw new TypeError('sandboxOverride.approvalPolicy is invalid');
    }
    if (
      sandboxOverride.networkAccessEnabled !== undefined &&
      typeof sandboxOverride.networkAccessEnabled !== 'boolean'
    ) {
      throw new TypeError('sandboxOverride.networkAccessEnabled must be boolean when provided');
    }
    if (
      sandboxOverride.sandboxMode !== undefined &&
      SANDBOX_MODE_RANK[sandboxOverride.sandboxMode] >
        SANDBOX_MODE_RANK[parentSettings.sandboxMode]
    ) {
      throw new TypeError('sandboxOverride.sandboxMode cannot widen parent sandboxMode');
    }
    if (
      sandboxOverride.approvalPolicy === 'on-request' &&
      parentSettings.approvalPolicy === 'never'
    ) {
      throw new TypeError('sandboxOverride.approvalPolicy cannot widen parent approvalPolicy');
    }
    const parentNetworkAccess =
      parentSettings.networkProjection.networkAccessEnabled;
    if (
      sandboxOverride.networkAccessEnabled === true &&
      parentNetworkAccess === false
    ) {
      throw new TypeError(
        'sandboxOverride.networkAccessEnabled cannot widen parent network access',
      );
    }
  };

  const validateSpawnOptions = (options: SpawnOptions): void => {
    if (spawnAuthority !== 'root') {
      throw createRuntimeVetoError(
        'root-only-spawn',
        'roster-authority:subagent',
        'runtime',
      );
    }

    const raw = options as unknown as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(raw, 'envelope')) {
      throw new TypeError('spawn options must not provide envelope; envelope is runtime-derived');
    }

    const role = assertSubagentRole(options.role);
    if (role === 'root-orchestrator') {
      throw new TypeError('spawn options role must not be root-orchestrator');
    }
    validateWorkingDirectory(options.workingDirectory);
    validateSandboxOverride(options.sandboxOverride);
  };

  const createInternalDescriptor = (role: SubagentRole): InternalSubagentDescriptor => {
    let subagentId: string;
    do {
      sequence += 1;
      subagentId = `subagent-${sequence}`;
    } while (usedSubagentIds.has(subagentId));
    usedSubagentIds.add(subagentId);
    return {
      subagentId,
      role,
      parent: {
        taskId: parentContext.taskId,
        instanceId: parentContext.instanceId,
      },
      createdAt: new Date().toISOString(),
      state: 'reserved',
      envelope: inheritedEnvelope,
      slotReleased: false,
    };
  };

  const emitProgress = (correlationKey: SubagentCorrelationKey): void => {
    const progress: RosterProgressEvent = {
      kind: 'roster.progress',
      correlationKey,
      timestamp: new Date().toISOString(),
      completed: completedCount,
      aborted: abortedCount,
      failed: failedCount,
      total: totalNonRootAdmitted,
      inFlight: Math.max(
        0,
        totalNonRootAdmitted - completedCount - abortedCount - failedCount,
      ),
    };
    void eventStream.push(progress);
  };

  const terminate = async (
    subagentId: string,
    cause: TerminalCause,
    terminalData?: {
      artifact?: unknown;
      partialArtifact?: { digest?: string; ref?: string } | null;
    },
  ): Promise<void> => {
    const found = descriptors.get(subagentId);
    if (found === undefined) {
      throw createRuntimeVetoError(
        'forged-subagent-id',
        `roster-subagent-id:${subagentId}`,
        'runtime',
      );
    }
    const descriptor = found;
    if (descriptor.state !== 'active') {
      throw createRuntimeVetoError(
        'forged-subagent-id',
        `roster-subagent-id:${subagentId}`,
        'runtime',
      );
    }

    descriptor.state = 'terminating';
    const correlationKey = toCorrelationKey(descriptor);
    const timestamp = new Date().toISOString();

    let terminalEvent: RosterEvent;
    switch (cause.kind) {
      case 'success':
        descriptor.state = 'terminated';
        completedCount += 1;
        terminalEvent = {
          kind: 'subagent.completed',
          correlationKey,
          timestamp,
          artifact: terminalData?.artifact ?? cause.artifactLocation,
          cause,
        };
        break;
      case 'external-cancel':
      case 'runtime-veto':
        descriptor.state = 'terminated';
        abortedCount += 1;
        terminalEvent = {
          kind: 'subagent.aborted',
          correlationKey,
          timestamp,
          partialArtifact: terminalData?.partialArtifact ?? null,
          cause,
        };
        break;
      case 'timeout':
      case 'driver-failure':
      case 'provider-failure':
        descriptor.state = 'failed';
        failedCount += 1;
        terminalEvent = {
          kind: 'subagent.failed',
          correlationKey,
          timestamp,
          cause,
        };
        break;
      default: {
        const _exhaustive: never = cause;
        terminalEvent = _exhaustive;
      }
    }

    releaseSlot(descriptor);
    void eventStream.push(terminalEvent);

    // M5b — subagentTerminal hooks. Each chain stays .catch()-contained
    // so a throwing hook still cannot abort terminate(), but terminate()
    // now awaits all pending hook chains before resolving so callers do
    // not race a stale hook from a sibling termination on the same
    // roster (audit 2026-05-03 / F6).
    const terminalObservedAt = new Date().toISOString();
    const pendingTerminalHooks: Promise<void>[] = [];
    for (const binding of subagentLifecycleHooks) {
      const subagentTerminal = binding.subagentTerminal;
      if (subagentTerminal === undefined) continue;
      pendingTerminalHooks.push(
        Promise.resolve()
          .then(() =>
            subagentTerminal(
              {
                moduleId: binding.moduleId as never,
                moduleVersion: binding.moduleVersion,
                observedAt: terminalObservedAt,
              },
              {
                parentTaskId: parentContext.taskId,
                parentInstanceId: parentContext.instanceId,
                subagentId: descriptor.subagentId,
                state: descriptor.state,
                ...(cause.kind === 'success'
                  ? {}
                  : { reason: 'reason' in cause ? cause.reason : cause.kind }),
              },
            ),
          )
          .catch((error: unknown) => {
            console.warn(
              'trait-runtime-hook-threw',
              JSON.stringify({
                hook: 'subagentTerminal',
                moduleId: binding.moduleId,
                subagentId: descriptor.subagentId,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          }),
      );
    }
    if (pendingTerminalHooks.length > 0) {
      await Promise.allSettled(pendingTerminalHooks);
    }
    emitProgress(correlationKey);
  };

  const terminateAll = async (cause: TerminalCause): Promise<void> => {
    if (parentTerminationApplied) {
      return;
    }
    parentTerminationApplied = true;
    // P4 Stage 4-5 — drain the active-handle table BEFORE terminating
    // so any in-flight child driver gets the cancel signal and has a
    // chance to surface a runtime-veto cause cleanly (the subsequent
    // terminate(...) call will fail-closed on a re-cancel, but the
    // cancel hook itself is best-effort and idempotent on the runtime
    // side). We collect (then iterate) a snapshot to avoid mutating
    // the map mid-iteration when the spawnAndRun finally-block also
    // calls activeHandles.delete on resolution.
    const handlesSnapshot = [...activeHandles.entries()];
    activeHandles.clear();
    for (const [, handle] of handlesSnapshot) {
      try {
        handle.cancel('parent terminating');
      } catch (cancelError) {
        try {
          console.warn(
            `subagent-roster.terminate-all-cancel-threw ${JSON.stringify({
              event: 'subagent-roster.terminate-all-cancel-threw',
              taskId: parentContext.taskId,
              runtimeInstanceId: parentContext.instanceId,
              error:
                cancelError instanceof Error
                  ? cancelError.message
                  : String(cancelError),
            })}`,
          );
        } catch {
          // Stringification must never break shutdown.
        }
      }
    }
    const activeIds = [...descriptors.values()]
      .filter((descriptor) => descriptor.state === 'active')
      .map((descriptor) => descriptor.subagentId);
    for (const id of activeIds) {
      await terminate(id, cause);
    }
  };

  /**
   * P4 Stage 4-5 — operator-driven per-child cancellation. Returns
   * `true` when a `RunChildHandle` was registered for `subagentId` and
   * `cancel(reason)` was invoked; `false` otherwise. See the interface
   * docstring on `SubagentRoster.cancelActive` for the full contract.
   */
  const cancelActive = (subagentId: string, reason: string): boolean => {
    const handle = activeHandles.get(subagentId);
    if (handle === undefined) {
      return false;
    }
    activeHandles.delete(subagentId);
    try {
      handle.cancel(reason);
    } catch (cancelError) {
      try {
        console.warn(
          `subagent-roster.cancel-active-threw ${JSON.stringify({
            event: 'subagent-roster.cancel-active-threw',
            taskId: parentContext.taskId,
            runtimeInstanceId: parentContext.instanceId,
            subagentId,
            error:
              cancelError instanceof Error
                ? cancelError.message
                : String(cancelError),
          })}`,
        );
      } catch {
        // Stringification must never break the operator surface.
      }
    }
    return true;
  };

  parentContext.parentTerminationSignal?.addEventListener(
    'abort',
    () => {
      // Audit 2026-05-03 follow-up (G1): `terminate()` may throw a
      // `runtime-veto` error when a descriptor is in an unexpected
      // state (forged-subagent-id), which would propagate into
      // `terminateAll` and surface as an unhandled promise rejection
      // here because the abort listener cannot be async. We swallow
      // with a structured warn line so the failure is visible without
      // crashing the host process. The parent abort path itself is
      // best-effort cleanup, not authoritative cancellation — the
      // authoritative cause was already latched upstream of the
      // signal.
      terminateAll({
        kind: 'external-cancel',
        taskId: parentContext.taskId,
        runtimeInstanceId: parentContext.instanceId,
        observedAt: new Date().toISOString(),
        provenance: 'parent-termination-signal',
        reason: 'parent terminated',
        requestedAt: new Date().toISOString(),
      }).catch((error: unknown) => {
        try {
          console.warn(
            `subagent-roster.parent-abort-terminate-all-threw ${JSON.stringify({
              event: 'subagent-roster.parent-abort-terminate-all-threw',
              taskId: parentContext.taskId,
              runtimeInstanceId: parentContext.instanceId,
              error: error instanceof Error ? error.message : String(error),
            })}`,
          );
        } catch {
          // Stringification must never break shutdown.
        }
      });
    },
    { once: true },
  );

  /**
   * P4 Stage 4-4 — derive a `TerminalCause` from a child's
   * `RuntimeDriverResult` so the roster's existing `terminate(...)`
   * cause-mapping (success → completed, runtime-veto/external-cancel →
   * aborted, timeout/provider-failure → failed) can be reused without
   * extending the descriptor's lifecycle vocabulary.
   *
   * The cause is re-stamped with the parent's identity fields so the
   * roster event keys correctly off the parent (even when the child
   * runtime carried its own child-task-id through the
   * `RuntimeDriverResult.cause` payload).
   */
  const childResultToTerminalCause = (
    result: RuntimeDriverResult,
  ): TerminalCause => {
    return {
      ...result.cause,
      taskId: parentContext.taskId,
      runtimeInstanceId: parentContext.instanceId,
    };
  };

  /**
   * P4 Stage 4-4 — synthesize a `provider-failure` terminal cause when
   * the `runChild` callback throws an error that escaped the child's
   * terminal-evidence boundary entirely. Classification is `'unknown'`:
   * the spec defers a more granular classification to a follow-up WU
   * because the throw could originate anywhere from the dispatch-plan
   * builder to the driver itself, and we cannot reliably attribute it
   * to a single F-class without inspecting the underlying error shape.
   */
  const synthesizeRunChildFailureCause = (
    error: unknown,
  ): TerminalCauseProviderFailure => {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'runChild callback threw an unrecognized error';
    return {
      kind: 'provider-failure',
      taskId: parentContext.taskId,
      runtimeInstanceId: parentContext.instanceId,
      observedAt: new Date().toISOString(),
      provenance: 'subagent-roster.spawn-and-run',
      provider: 'codex',
      classification: 'unknown',
      retryable: false,
      message: `subagent runChild threw: ${message}`,
    };
  };

  const spawn = async (options: SpawnOptions): Promise<SubagentDescriptor> => {
    const role = assertSubagentRole(options.role);
    const requestedToolNames = validateRequestedToolNames(
      options.requestedToolNames,
    );
    reserveSlot(role, requestedToolNames);
    let descriptor: InternalSubagentDescriptor | undefined;
    try {
      validateSpawnOptions(options);
      descriptor = createInternalDescriptor(role);
      descriptor.state = 'spawning';
      descriptors.set(descriptor.subagentId, descriptor);
      if (descriptor.role !== 'root-orchestrator') {
        totalNonRootAdmitted += 1;
      }
      void eventStream.push({
        kind: 'subagent.spawned',
        correlationKey: toCorrelationKey(descriptor),
        timestamp: new Date().toISOString(),
        descriptor: toSnapshot(descriptor),
      });
      descriptor.state = 'active';
      // M5b — Fire subagentSpawn hooks. Each binding's exception is
      // contained so a misbehaving hook cannot poison the spawn path.
      const spawnObservedAt = new Date().toISOString();
      for (const binding of subagentLifecycleHooks) {
        if (binding.subagentSpawn === undefined) continue;
        try {
          await binding.subagentSpawn(
            {
              moduleId: binding.moduleId as never,
              moduleVersion: binding.moduleVersion,
              observedAt: spawnObservedAt,
            },
            {
              parentTaskId: parentContext.taskId,
              parentInstanceId: parentContext.instanceId,
              subagentId: descriptor.subagentId,
              role: descriptor.role,
            },
          );
        } catch (error) {
          console.warn(
            'trait-runtime-hook-threw',
            JSON.stringify({
              hook: 'subagentSpawn',
              moduleId: binding.moduleId,
              subagentId: descriptor.subagentId,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      return toSnapshot(descriptor);
    } catch (error) {
      if (descriptor !== undefined) {
        descriptors.delete(descriptor.subagentId);
        releaseSlot(descriptor);
      } else {
        reservedCount = Math.max(0, reservedCount - 1);
        const currentRole = roleCounters.get(role) ?? 0;
        if (currentRole <= 1) {
          roleCounters.delete(role);
        } else {
          roleCounters.set(role, currentRole - 1);
        }
      }
      throw error;
    }
  };

  const runChildCallback = parentContext.runChild;

  /**
   * P4 Stage 4-4 — admit + launch a child runtime via the parent
   * context's `runChild` callback. The flow is:
   *
   *   1. Call `spawn(options)` so admission validation (envelope
   *      narrowing, sandbox/approval/network override checks, role
   *      and depth/concurrent caps) gates the child before we even
   *      reach the runChild callback.
   *   2. Invoke `runChild` with the admitted descriptor + the child
   *      instruction. The callback is responsible for building a
   *      child DispatchPlan and calling the parent's RuntimeDriver.
   *   3. On a returned `RuntimeDriverResult`: derive a `TerminalCause`
   *      from `result.cause`, call `terminate(...)` to release the
   *      slot and emit the matching subagent.{completed|aborted|
   *      failed} lifecycle event, and return `{descriptor, result}`.
   *   4. On a thrown error: synthesize a `provider-failure` cause
   *      with `classification: 'unknown'`, call `terminate(...)` to
   *      release the slot, then rethrow so the caller observes the
   *      failure cleanly.
   */
  const spawnAndRun = async (input: {
    readonly options: SpawnOptions;
    readonly instruction: string;
  }): Promise<SubagentRunResult> => {
    if (runChildCallback === undefined) {
      throw new Error(
        'subagent.spawnAndRun is not enabled: parent context did not provide a runChild callback (Stage 4-4)',
      );
    }
    const descriptor = await spawn(input.options);
    let result: RuntimeDriverResult;
    try {
      // The callback may return either a bare `RuntimeDriverResult`
      // (Stage 4-4 legacy) or a `RunChildHandle` (Stage 4-5). The
      // returned value is the pre-resolution shape; we await it then
      // discriminate. When a handle is returned, register its cancel
      // hook in `activeHandles` so the operator surface can reach it
      // mid-flight via `cancelActive(...)`. The handle is removed
      // before we call `terminate(...)` so a late cancel after the
      // child resolved cannot trigger a stale callback.
      const callbackOutcome = await runChildCallback({
        descriptor,
        instruction: input.instruction,
        parentContext: {
          taskId: parentContext.taskId,
          instanceId: parentContext.instanceId,
        },
      });
      if (isRunChildHandle(callbackOutcome)) {
        activeHandles.set(descriptor.subagentId, callbackOutcome);
        try {
          result = await callbackOutcome.result;
        } finally {
          activeHandles.delete(descriptor.subagentId);
        }
      } else {
        result = callbackOutcome;
      }
    } catch (error) {
      // Defensive: clear any handle that may have been registered
      // before the throw escaped the try-block (rare race when the
      // handle's `result` rejects synchronously after registration).
      activeHandles.delete(descriptor.subagentId);
      const synthCause = synthesizeRunChildFailureCause(error);
      try {
        await terminate(descriptor.subagentId, synthCause);
      } catch (terminateError) {
        // terminate() may itself throw a runtime-veto if the descriptor
        // was already removed (e.g., parent abort raced with us). Fold
        // the secondary error into a structured warn so the original
        // runChild failure still surfaces as the rethrown cause.
        try {
          console.warn(
            `subagent-roster.spawn-and-run.terminate-after-throw-failed ${JSON.stringify({
              event: 'subagent-roster.spawn-and-run.terminate-after-throw-failed',
              taskId: parentContext.taskId,
              runtimeInstanceId: parentContext.instanceId,
              subagentId: descriptor.subagentId,
              error:
                terminateError instanceof Error
                  ? terminateError.message
                  : String(terminateError),
            })}`,
          );
        } catch {
          // Stringification must never break failure propagation.
        }
      }
      throw error;
    }
    const cause = childResultToTerminalCause(result);
    await terminate(descriptor.subagentId, cause, {
      ...(cause.kind === 'success' && result.artifactLocation !== undefined
        ? { artifact: result.artifactLocation }
        : {}),
    });
    return { descriptor, result };
  };

  return {
    spawn,
    spawnAndRun,
    terminate,
    terminateAll,
    cancelActive,
    events: eventStream.events,
    snapshot(): readonly SubagentDescriptor[] {
      return Object.freeze([...descriptors.values()].map((descriptor) => toSnapshot(descriptor)));
    },
  };
}
