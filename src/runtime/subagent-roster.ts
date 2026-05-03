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
  type SubagentState,
} from '../contracts/subagent-roster.js';
import type {
  RosterEvent,
  RosterProgressEvent,
} from '../contracts/subagent-roster-event.js';
import type { ResourceEnvelope } from '../contracts/resource-envelope.js';
import type {
  RuntimeSandboxMode,
  RuntimeSettingsBundle,
} from '../contracts/runtime-settings.js';
import type {
  TerminalCause,
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
  terminate(
    subagentId: string,
    cause: TerminalCause,
    terminalData?: {
      artifact?: unknown;
      partialArtifact?: { digest?: string; ref?: string } | null;
    },
  ): Promise<void>;
  terminateAll(cause: TerminalCause): Promise<void>;
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

  const reserveSlot = (role: SubagentRole): void => {
    if (policyEnforcer !== undefined) {
      const decision = policyEnforcer.evaluate({
        role,
        depth: childDepth,
        currentConcurrent: reservedCount,
        currentPerRole: roleCounters.get(role) ?? 0,
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
      if (binding.subagentTerminal === undefined) continue;
      pendingTerminalHooks.push(
        Promise.resolve()
          .then(() =>
            binding.subagentTerminal!(
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
    const activeIds = [...descriptors.values()]
      .filter((descriptor) => descriptor.state === 'active')
      .map((descriptor) => descriptor.subagentId);
    for (const id of activeIds) {
      await terminate(id, cause);
    }
  };

  parentContext.parentTerminationSignal?.addEventListener(
    'abort',
    () => {
      void terminateAll({
        kind: 'external-cancel',
        taskId: parentContext.taskId,
        runtimeInstanceId: parentContext.instanceId,
        observedAt: new Date().toISOString(),
        provenance: 'parent-termination-signal',
        reason: 'parent terminated',
        requestedAt: new Date().toISOString(),
      });
    },
    { once: true },
  );

  return {
    async spawn(options: SpawnOptions): Promise<SubagentDescriptor> {
      const role = assertSubagentRole(options.role);
      reserveSlot(role);
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
    },
    terminate,
    terminateAll,
    events: eventStream.events,
    snapshot(): readonly SubagentDescriptor[] {
      return Object.freeze([...descriptors.values()].map((descriptor) => toSnapshot(descriptor)));
    },
  };
}
