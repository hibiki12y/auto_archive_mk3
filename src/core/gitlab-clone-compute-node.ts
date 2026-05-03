import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type {
  LifecycleObserver,
  LifecyclePhaseObservation,
} from '../contracts/dispatch-lifecycle.js';
import type { ObservedResourceSummary } from '../contracts/resource-envelope.js';
import {
  createTerminalEvidence,
  type TerminalEvidence,
  type TerminalExecutionContextSnapshot,
} from '../contracts/terminal-evidence.js';
import type { AgentRuntimePort } from '../contracts/agent-runtime-port.js';
import type {
  RuntimeCancellationBoundary,
  RuntimeTerminalCause,
} from '../contracts/runtime-driver.js';
import { createRuntimeSettingsBundle } from '../contracts/runtime-settings.js';
import type { CapabilityFlag } from '../contracts/capability-flag.js';
import type { ComputeCapabilitySurface } from './compute-capability.js';
import type { ComputeAllocation, ComputeNode } from './compute-node.js';
import {
  GitCommandClient,
  type GitClient,
  type GitCommandOptions,
} from './git-command-client.js';
import {
  GitLabCheckpointDriver,
  type ExecutionCheckpointPublisher,
} from './gitlab-checkpoint-publisher.js';
import type { Plana } from './plana.js';
import type { DispatchPlan } from './task.js';
import { createTerminalEvidenceFromTerminalCause } from './terminal-cause-evidence.js';

export const AUTO_ARCHIVE_DISPATCH_CLONE_ROOT =
  'AUTO_ARCHIVE_DISPATCH_CLONE_ROOT';

const GIT_CLONE_CAPABILITIES: ComputeCapabilitySurface = Object.freeze({
  kind: 'git-clone' as const,
  execution: Object.freeze({
    hasNetwork: true,
    hasFilesystemWrite: true,
    rootless: true,
  }),
  capabilityFlags: Object.freeze([] as CapabilityFlag[]),
});

export interface GitLabCloneComputeNodeOptions {
  readonly runtime: AgentRuntimePort;
  readonly gitClient?: GitClient;
  readonly checkpointDriver?: ExecutionCheckpointPublisher;
  readonly cloneRoot?: string;
}

interface AllocationRecord {
  readonly observers: LifecycleObserver[];
  cancelled: boolean;
  terminal: boolean;
  cancelReason?: string;
  cancelRequestedAt?: string;
  controller?: AbortController;
}

function stringifyFailureValue(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '<uninspectable thrown value>';
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return `non-Error rejection: ${stringifyFailureValue(error)}`;
}

/**
 * Mirrors current-node-compute-node's `observer.advisory-throw` upgrade
 * (audit 2026-05-03 / F8 parity). Observer errors at the compute-node
 * fan-out remain advisory — they MUST NOT abort dispatch — but they are
 * now surfaced as a structured `console.warn` so a misbehaving observer
 * is not silently lost.
 */
function warnObserverThrow(
  observerKind: 'primary' | 'extra',
  observation: LifecyclePhaseObservation,
  error: unknown,
): void {
  try {
    console.warn(
      `gitlab-clone-compute-node.observer.advisory-throw ${JSON.stringify({
        observerKind,
        phase: observation.phase,
        taskId: observation.taskId,
        error: describeFailure(error),
      })}`,
    );
  } catch {
    // Stringification must never break dispatch.
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function sanitizePathSegment(segment: string): string {
  const sanitized = segment
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (sanitized.length === 0) {
    throw new Error('taskId must produce a non-empty clone directory name.');
  }
  return sanitized;
}

function ensurePathWithinRoot(
  root: string,
  candidate: string,
  label: string,
  rootDescription = 'the cloned repository',
): string {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);

  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must resolve inside ${rootDescription}.`);
  }

  return normalizedCandidate;
}

function resolveCloneRoot(
  repositoryRoot: string,
  configuredCloneRoot: string | undefined,
): string {
  if (configuredCloneRoot === undefined) {
    return ensurePathWithinRoot(
      repositoryRoot,
      path.join(repositoryRoot, 'results', 'dispatch-clones'),
      'cloneRoot',
      'the repository root',
    );
  }

  if (path.isAbsolute(configuredCloneRoot)) {
    return path.resolve(configuredCloneRoot);
  }

  return ensurePathWithinRoot(
    repositoryRoot,
    path.resolve(repositoryRoot, configuredCloneRoot),
    'cloneRoot',
    'the repository root',
  );
}

function resolveCloneScopedPath(
  cloneDirectory: string,
  candidate: string | undefined,
  label: 'workingDirectory' | 'artifactLocation',
): string | undefined {
  if (candidate === undefined) {
    return undefined;
  }

  const resolvedCandidate = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(cloneDirectory, candidate);

  return ensurePathWithinRoot(cloneDirectory, resolvedCandidate, label);
}

function createExecutionContext(
  plan: DispatchPlan,
  executionCheckpoint: DispatchPlan['executionCheckpoint'],
): TerminalExecutionContextSnapshot {
  return {
    planCreatedAt: plan.createdAt,
    runtimeSettings: plan.runtimeSettings,
    ...(executionCheckpoint === undefined ? {} : { executionCheckpoint }),
  };
}

function createFailureEvidence(params: {
  plan: DispatchPlan;
  runtimeInstanceId: string;
  executionContext: TerminalExecutionContextSnapshot;
  startedAt: string;
  endedAt: string;
  artifactLocation?: string;
  observedSummary?: ObservedResourceSummary;
  error: unknown;
  phase: string;
}): TerminalEvidence {
  const reason = `git clone compute node fail-closed during ${params.phase}: ${describeFailure(params.error)}`;
  return createTerminalEvidence({
    taskId: params.plan.taskId,
    runtimeInstanceId: params.runtimeInstanceId,
    reason,
    provenance: 'gitlab-clone-compute-node',
    executionContext: params.executionContext,
    resourceEnvelope: params.plan.resourceEnvelope,
    observedSummary: params.observedSummary,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    artifactLocation: params.artifactLocation,
    cause: {
      kind: 'driver-failure',
      taskId: params.plan.taskId,
      runtimeInstanceId: params.runtimeInstanceId,
      observedAt: params.endedAt,
      provenance: 'gitlab-clone-compute-node',
      phase: params.phase,
      message: reason,
    },
  });
}

export class GitLabCloneComputeNode implements ComputeNode {
  private readonly runtime: AgentRuntimePort;
  private readonly gitClient: GitClient;
  private readonly checkpointDriver: ExecutionCheckpointPublisher;
  private readonly cloneRootOverride: string | undefined;
  private allocationCounter = 0;
  private readonly allocations = new Map<string, AllocationRecord>();

  readonly capabilities: ComputeCapabilitySurface = GIT_CLONE_CAPABILITIES;

  constructor(options: GitLabCloneComputeNodeOptions) {
    this.runtime = options.runtime;
    this.gitClient = options.gitClient ?? new GitCommandClient();
    this.checkpointDriver =
      options.checkpointDriver ??
      new GitLabCheckpointDriver({ gitClient: this.gitClient });
    this.cloneRootOverride = options.cloneRoot;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- ComputeNode contract requires Promise<ComputeAllocation>; the body is sync (clone happens at dispatch).
  async allocate(plan: DispatchPlan): Promise<ComputeAllocation> {
    this.allocationCounter += 1;
    const allocationId = `git-clone-${plan.taskId}-${this.allocationCounter}`;
    this.allocations.set(allocationId, {
      observers: [],
      cancelled: false,
      terminal: false,
    });
    return {
      allocationId,
      capability: this.capabilities,
    };
  }

  async dispatch(
    allocation: ComputeAllocation,
    plan: DispatchPlan,
    plana: Plana,
    cancellationBoundary: RuntimeCancellationBoundary,
    observer?: LifecycleObserver,
  ): Promise<TerminalEvidence> {
    const record = this.allocations.get(allocation.allocationId);
    if (record === undefined) {
      throw new Error(
        `GitLabCloneComputeNode.dispatch: unknown allocation ${allocation.allocationId}`,
      );
    }

    const startedAt = new Date().toISOString();
    const runtimeInstanceId = `agent-${plan.taskId}-${startedAt}`;
    const controller = new AbortController();
    record.controller = controller;
    if (record.cancelled && !controller.signal.aborted) {
      controller.abort();
    }

    const emit = (
      phase: LifecyclePhaseObservation['phase'],
      cause?: import('../contracts/terminal-cause.js').TerminalCause,
    ): void => {
      const observation: LifecyclePhaseObservation = {
        phase,
        taskId: plan.taskId,
        instanceId: runtimeInstanceId,
        observedAt: new Date().toISOString(),
        ...(cause === undefined ? {} : { cause }),
      };

      if (observer !== undefined) {
        try {
          observer(observation);
        } catch (error) {
          warnObserverThrow('primary', observation, error);
        }
      }
      for (const extra of record.observers) {
        try {
          extra(observation);
        } catch (error) {
          warnObserverThrow('extra', observation, error);
        }
      }
    };

    const currentTerminalCause = (): RuntimeTerminalCause | undefined =>
      cancellationBoundary.currentTerminalCause?.() ??
      (record.cancelled
        ? {
            kind: 'external-cancel',
            taskId: plan.taskId,
            reason:
              record.cancelReason ?? 'cooperative cancel observed before terminal',
            provenance: 'gitlab-clone-compute-node',
            requestedAt: record.cancelRequestedAt ?? startedAt,
          }
        : undefined);

    const boundaryAwaiter = cancellationBoundary.whenTerminalCause?.().then(
      (cause) => {
        if (!controller.signal.aborted) {
          controller.abort();
        }
        return cause;
      },
    );

    let checkpoint = plan.executionCheckpoint;
    let effectivePlan = plan;
    let artifactLocation = plan.artifactLocation;
    let executionContext = createExecutionContext(plan, checkpoint);
    let sawSettling = false;
    let sawTerminal = false;

    const closeExternalCancellation = (): void => {
      cancellationBoundary.closeExternalCancellation?.();
    };

    const settleTerminalCause = (
      terminalCause: RuntimeTerminalCause,
      currentPlan: DispatchPlan,
    ): TerminalEvidence => {
      closeExternalCancellation();
      return createTerminalEvidenceFromTerminalCause({
        taskId: currentPlan.taskId,
        runtimeInstanceId,
        terminalCause,
        executionContext,
        resourceEnvelope: currentPlan.resourceEnvelope,
        startedAt,
        endedAt: new Date().toISOString(),
        artifactLocation,
      });
    };

    const settle = (evidence: TerminalEvidence): TerminalEvidence => {
      if (!sawSettling) {
        emit('settling');
      }
      if (!sawTerminal) {
        emit('terminal', evidence.cause);
      }
      record.terminal = true;
      record.controller = undefined;
      record.observers.length = 0;
      return evidence;
    };

    const runtimeObserver: LifecycleObserver = (observation) => {
      if (
        observation.phase === 'runtime-entering' ||
        observation.phase === 'runtime-running'
      ) {
        return;
      }
      if (observation.phase === 'settling') {
        sawSettling = true;
      }
      if (observation.phase === 'terminal') {
        sawTerminal = true;
      }
      emit(observation.phase, observation.cause);
    };

    emit('accepted');
    emit('runtime-entering');
    emit('runtime-running');

    try {
      const earlyTerminalCause = currentTerminalCause();
      if (earlyTerminalCause) {
        return settle(settleTerminalCause(earlyTerminalCause, effectivePlan));
      }

      checkpoint =
        checkpoint ??
        (await this.checkpointDriver.publish(plan, {
          signal: controller.signal,
        }));
      executionContext = createExecutionContext(plan, checkpoint);

      const publishedTerminalCause = currentTerminalCause();
      if (publishedTerminalCause) {
        return settle(settleTerminalCause(publishedTerminalCause, effectivePlan));
      }

      const configuredCloneRoot =
        this.cloneRootOverride ?? process.env[AUTO_ARCHIVE_DISPATCH_CLONE_ROOT];
      const repositoryRoot =
        configuredCloneRoot === undefined || !path.isAbsolute(configuredCloneRoot)
          ? await this.gitClient.getRepoTopLevel({
              signal: controller.signal,
            })
          : undefined;
      const cloneRoot =
        repositoryRoot === undefined
          ? path.resolve(configuredCloneRoot!)
          : resolveCloneRoot(repositoryRoot, configuredCloneRoot);
      await mkdir(cloneRoot, { recursive: true });

      const cloneDirectory = ensurePathWithinRoot(
        cloneRoot,
        path.join(
          cloneRoot,
          `${sanitizePathSegment(plan.taskId)}-${sanitizePathSegment(
            checkpoint.revision.slice(0, 12),
          )}-${Date.parse(startedAt)}`,
        ),
        'cloneDirectory',
      );
      const gitOptions: GitCommandOptions = {
        signal: controller.signal,
      };
      await this.gitClient.clone(checkpoint.repositoryUrl, cloneDirectory, gitOptions);

      const clonedTerminalCause = currentTerminalCause();
      if (clonedTerminalCause) {
        artifactLocation = resolveCloneScopedPath(
          cloneDirectory,
          plan.artifactLocation,
          'artifactLocation',
        );
        return settle(settleTerminalCause(clonedTerminalCause, effectivePlan));
      }

      await this.gitClient.checkoutDetach(checkpoint.revision, {
        ...gitOptions,
        cwd: cloneDirectory,
      });

      const rewrittenWorkingDirectory = resolveCloneScopedPath(
        cloneDirectory,
        plan.runtimeSettings.workingDirectory,
        'workingDirectory',
      );
      artifactLocation = resolveCloneScopedPath(
        cloneDirectory,
        plan.artifactLocation,
        'artifactLocation',
      );

      effectivePlan = {
        ...plan,
        runtimeSettings: createRuntimeSettingsBundle({
          networkProfile: plan.runtimeSettings.networkProfile,
          sandboxMode: plan.runtimeSettings.sandboxMode,
          approvalPolicy: plan.runtimeSettings.approvalPolicy,
          ...(rewrittenWorkingDirectory === undefined
            ? {}
            : { workingDirectory: rewrittenWorkingDirectory }),
          ...(plan.runtimeSettings.deadlineMs === undefined
            ? {}
            : { deadlineMs: plan.runtimeSettings.deadlineMs }),
        }),
        artifactLocation,
        executionCheckpoint: checkpoint,
      };
      executionContext = createExecutionContext(effectivePlan, checkpoint);

      const preRuntimeTerminalCause = currentTerminalCause();
      if (preRuntimeTerminalCause) {
        return settle(settleTerminalCause(preRuntimeTerminalCause, effectivePlan));
      }

      const evidence = await this.runtime.execute(
        effectivePlan,
        plana,
        cancellationBoundary,
        runtimeObserver,
      );
      return settle(evidence);
    } catch (error) {
      const terminalCause = currentTerminalCause();
      if (terminalCause && isAbortError(error)) {
        return settle(settleTerminalCause(terminalCause, effectivePlan));
      }

      if (terminalCause) {
        return settle(settleTerminalCause(terminalCause, effectivePlan));
      }

      closeExternalCancellation();
      return settle(
        createFailureEvidence({
          plan: effectivePlan,
          runtimeInstanceId,
          executionContext,
          startedAt,
          endedAt: new Date().toISOString(),
          artifactLocation,
          error,
          phase: checkpoint === undefined ? 'checkpoint publication' : 'clone staging',
        }),
      );
    } finally {
      void boundaryAwaiter;
    }
  }

  observe(allocation: ComputeAllocation, observer: LifecycleObserver): void {
    const record = this.allocations.get(allocation.allocationId);
    if (record === undefined || record.terminal) {
      return;
    }
    record.observers.push(observer);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- ComputeNode contract requires Promise<void>; cooperative cancel is fully sync.
  async cancel(allocation: ComputeAllocation, reason: string): Promise<void> {
    const record = this.allocations.get(allocation.allocationId);
    if (record === undefined || record.terminal || record.cancelled) {
      return;
    }

    record.cancelled = true;
    record.cancelReason = reason;
    record.cancelRequestedAt = new Date().toISOString();
    if (record.controller && !record.controller.signal.aborted) {
      record.controller.abort();
    }
  }
}
