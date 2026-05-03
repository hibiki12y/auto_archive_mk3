import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import type {
  LifecycleObserver,
  LifecyclePhaseObservation,
} from '../contracts/dispatch-lifecycle.js';
import {
  createTerminalEvidence,
  type TerminalEvidence,
  type TerminalExecutionContextSnapshot,
} from '../contracts/terminal-evidence.js';
import type {
  RuntimeCancellationBoundary,
  RuntimeTerminalCause,
} from '../contracts/runtime-driver.js';
import { createRuntimeSettingsBundle } from '../contracts/runtime-settings.js';
import type { CapabilityFlag } from '../contracts/capability-flag.js';
import type { AgentRuntimePort } from '../contracts/agent-runtime-port.js';
import type { ObservedResourceSummary } from '../contracts/resource-envelope.js';
import type { ComputeAllocation, ComputeNode } from './compute-node.js';
import type { ComputeCapabilitySurface } from './compute-capability.js';
import {
  GitCommandClient,
  type GitClient,
} from './git-command-client.js';
import type { Plana } from './plana.js';
import type { DispatchPlan } from './task.js';
import { createTerminalEvidenceFromTerminalCause } from './terminal-cause-evidence.js';

const CURRENT_NODE_CAPABILITIES: ComputeCapabilitySurface = Object.freeze({
  kind: 'current-node' as const,
  execution: Object.freeze({
    hasNetwork: true,
    hasFilesystemWrite: true,
    rootless: true,
  }),
  capabilityFlags: Object.freeze([] as CapabilityFlag[]),
});

export interface CurrentNodeComputeNodeOptions {
  readonly runtime: AgentRuntimePort;
  readonly gitClient?: GitClient;
}

interface AllocationRecord {
  readonly observers: LifecycleObserver[];
  cancelled: boolean;
  terminal: boolean;
  cancelReason?: string;
  cancelRequestedAt?: string;
  controller?: AbortController;
}

interface PinnedWorkingDirectory {
  readonly canonicalPath: string;
  readonly runtimePath: string;
  readonly release: () => Promise<void>;
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
 * Mirrors agent-runtime's `lifecycle.observer.advisory-throw` upgrade
 * (audit 2026-05-03 / F8). Observer errors at the compute-node fan-out
 * remain advisory — they MUST NOT abort dispatch — but they are now
 * surfaced as a structured `console.warn` so a misbehaving observer is
 * not silently lost.
 */
function warnObserverThrow(
  observerKind: 'primary' | 'extra',
  observation: LifecyclePhaseObservation,
  error: unknown,
): void {
  try {

    console.warn(
      `current-node-compute-node.observer.advisory-throw ${JSON.stringify({
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

function hasFileNotFoundCode(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !(
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

async function resolveRepositoryBoundPath(
  repositoryRoot: string,
  candidate: string,
  label: 'workingDirectory' | 'artifactLocation',
): Promise<string> {
  let currentPath = repositoryRoot;

  for (const segment of candidate.split(path.sep)) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }

    if (segment === '..') {
      currentPath = path.dirname(currentPath);
    } else {
      const nextPath = path.join(currentPath, segment);
      try {
        const stats = await lstat(nextPath);
        currentPath = stats.isSymbolicLink()
          ? await realpath(nextPath)
          : nextPath;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        ) {
          throw error;
        }
        currentPath = nextPath;
      }
    }

    if (!isPathWithinRoot(repositoryRoot, currentPath)) {
      throw new Error(`${label} must resolve inside the repository root.`);
    }
  }

  return currentPath;
}

async function ensurePathWithinRepositoryRoot(
  repositoryRoot: string,
  candidate: string,
  label: 'workingDirectory' | 'artifactLocation',
): Promise<string> {
  const normalizedRoot = path.resolve(repositoryRoot);
  const realRepositoryRoot = await realpath(normalizedRoot);
  const repositoryRootPrefix = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : `${normalizedRoot}${path.sep}`;
  const realRepositoryRootPrefix = realRepositoryRoot.endsWith(path.sep)
    ? realRepositoryRoot
    : `${realRepositoryRoot}${path.sep}`;
  const repositoryRelativeCandidate = path.isAbsolute(candidate)
    ? candidate === normalizedRoot
      ? ''
      : candidate.startsWith(repositoryRootPrefix)
        ? candidate.slice(repositoryRootPrefix.length)
        : candidate === realRepositoryRoot
          ? ''
          : candidate.startsWith(realRepositoryRootPrefix)
            ? candidate.slice(realRepositoryRootPrefix.length)
            : undefined
    : candidate;

  if (repositoryRelativeCandidate === undefined) {
    throw new Error(`${label} must resolve inside the repository root.`);
  }

  const resolvedCandidate = await resolveRepositoryBoundPath(
    realRepositoryRoot,
    repositoryRelativeCandidate,
    label,
  );

  if (!isPathWithinRoot(realRepositoryRoot, resolvedCandidate)) {
    throw new Error(`${label} must resolve inside the repository root.`);
  }

  return resolvedCandidate;
}

async function resolveCanonicalRepositoryScopedPath(
  repositoryRoot: string,
  candidate: string | undefined,
  label: 'workingDirectory' | 'artifactLocation',
): Promise<string | undefined> {
  if (candidate === undefined) {
    return undefined;
  }

  const resolvedCandidate = await ensurePathWithinRepositoryRoot(
    repositoryRoot,
    candidate,
    label,
  );

  try {
    const canonicalCandidate = await realpath(resolvedCandidate);
    const realRepositoryRoot = await realpath(path.resolve(repositoryRoot));
    if (!isPathWithinRoot(realRepositoryRoot, canonicalCandidate)) {
      throw new Error(`${label} must resolve inside the repository root.`);
    }
    return canonicalCandidate;
  } catch (error) {
    if (hasFileNotFoundCode(error)) {
      return resolvedCandidate;
    }
    throw error;
  }
}

async function resolveExistingDirectoryForGitProbe(
  candidate: string | undefined,
): Promise<string | undefined> {
  if (candidate === undefined || !path.isAbsolute(candidate)) {
    return undefined;
  }

  let currentPath = path.resolve(candidate);
  while (true) {
    try {
      const canonicalPath = await realpath(currentPath);
      const stats = await lstat(canonicalPath);
      return stats.isDirectory() ? canonicalPath : path.dirname(canonicalPath);
    } catch (error) {
      if (!hasFileNotFoundCode(error)) {
        throw error;
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return undefined;
      }
      currentPath = parentPath;
    }
  }
}

async function resolveRepositoryProbeDirectory(
  plan: DispatchPlan,
): Promise<string | undefined> {
  return (
    (await resolveExistingDirectoryForGitProbe(
      plan.runtimeSettings.workingDirectory,
    )) ?? (await resolveExistingDirectoryForGitProbe(plan.artifactLocation))
  );
}

async function pinWorkingDirectory(
  repositoryRoot: string,
  candidate: string | undefined,
): Promise<PinnedWorkingDirectory | undefined> {
  if (candidate === undefined) {
    return undefined;
  }

  const resolvedCandidate = await ensurePathWithinRepositoryRoot(
    repositoryRoot,
    candidate,
    'workingDirectory',
  );
  await mkdir(resolvedCandidate, { recursive: true });
  const canonicalPath = await realpath(resolvedCandidate);
  const realRepositoryRoot = await realpath(path.resolve(repositoryRoot));
  if (!isPathWithinRoot(realRepositoryRoot, canonicalPath)) {
    throw new Error('workingDirectory must resolve inside the repository root.');
  }

  const handle = await open(canonicalPath, 'r');
  return {
    canonicalPath,
    /**
     * The Codex SDK forwards `workingDirectory` into a spawned codex CLI
     * child. `/proc/self/fd/<n>` would therefore resolve against the child
     * process and fail because the parent's descriptor is not inherited by
     * default. Point at the parent's procfs entry instead so the child can
     * dereference the still-open directory handle safely for the lifetime of
     * the dispatch.
     */
    runtimePath: path.posix.join(
      '/proc',
      String(process.pid),
      'fd',
      String(handle.fd),
    ),
    release: async () => {
      await handle.close();
    },
  };
}

function rewritePlanPaths(
  plan: DispatchPlan,
  workingDirectory: string | undefined,
  artifactLocation: string | undefined,
): DispatchPlan {
  return {
    ...plan,
    runtimeSettings: createRuntimeSettingsBundle({
      networkProfile: plan.runtimeSettings.networkProfile,
      sandboxMode: plan.runtimeSettings.sandboxMode,
      approvalPolicy: plan.runtimeSettings.approvalPolicy,
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      ...(plan.runtimeSettings.deadlineMs === undefined
        ? {}
        : { deadlineMs: plan.runtimeSettings.deadlineMs }),
    }),
    artifactLocation,
  };
}

function rewriteTerminalEvidencePaths(
  evidence: TerminalEvidence,
  plan: DispatchPlan,
): TerminalEvidence {
  return createTerminalEvidence({
    taskId: evidence.taskId,
    runtimeInstanceId: evidence.runtimeInstanceId,
    reason: evidence.reason,
    provenance: evidence.provenance,
    executionContext: {
      ...evidence.executionContext,
      runtimeSettings: plan.runtimeSettings,
    },
    resourceEnvelope: plan.resourceEnvelope,
    observedSummary: evidence.observedSummary,
    transcript: evidence.transcript,
    abort: evidence.abort,
    startedAt: evidence.startedAt,
    endedAt: evidence.endedAt,
    artifactLocation: plan.artifactLocation,
    cause: evidence.cause,
  });
}

function createExecutionContext(
  plan: DispatchPlan,
): TerminalExecutionContextSnapshot {
  return {
    planCreatedAt: plan.createdAt,
    runtimeSettings: plan.runtimeSettings,
    ...(plan.executionCheckpoint === undefined
      ? {}
      : { executionCheckpoint: plan.executionCheckpoint }),
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
  const reason = `current-node compute node fail-closed during ${params.phase}: ${describeFailure(params.error)}`;
  return createTerminalEvidence({
    taskId: params.plan.taskId,
    runtimeInstanceId: params.runtimeInstanceId,
    reason,
    provenance: 'current-node-compute-node',
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
      provenance: 'current-node-compute-node',
      phase: params.phase,
      message: reason,
    },
  });
}

export class CurrentNodeComputeNode implements ComputeNode {
  private readonly runtime: AgentRuntimePort;
  private readonly gitClient: GitClient;
  private allocationCounter = 0;
  private readonly allocations = new Map<string, AllocationRecord>();

  readonly capabilities: ComputeCapabilitySurface = CURRENT_NODE_CAPABILITIES;

  constructor(options: CurrentNodeComputeNodeOptions) {
    this.runtime = options.runtime;
    this.gitClient = options.gitClient ?? new GitCommandClient();
  }

  async allocate(plan: DispatchPlan): Promise<ComputeAllocation> {
    this.allocationCounter += 1;
    const allocationId = `current-node-${plan.taskId}-${this.allocationCounter}`;
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
        `CurrentNodeComputeNode.dispatch: unknown allocation ${allocation.allocationId}`,
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
            provenance: 'current-node-compute-node',
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

    let effectivePlan = plan;
    let artifactLocation = plan.artifactLocation;
    let executionContext = createExecutionContext(plan);
    let sawSettling = false;
    let sawTerminal = false;
    let releasePinnedWorkingDirectory: (() => Promise<void>) | undefined;

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

      const repositoryProbeDirectory =
        await resolveRepositoryProbeDirectory(plan);
      const repositoryRoot = await this.gitClient.getRepoTopLevel({
        ...(repositoryProbeDirectory === undefined
          ? {}
          : { cwd: repositoryProbeDirectory }),
        signal: controller.signal,
      });
      const pinnedWorkingDirectory = await pinWorkingDirectory(
        repositoryRoot,
        plan.runtimeSettings.workingDirectory,
      );
      releasePinnedWorkingDirectory = pinnedWorkingDirectory?.release;
      artifactLocation = await resolveCanonicalRepositoryScopedPath(
        repositoryRoot,
        plan.artifactLocation,
        'artifactLocation',
      );

      effectivePlan = rewritePlanPaths(
        plan,
        pinnedWorkingDirectory?.canonicalPath,
        artifactLocation,
      );
      const runtimePlan = rewritePlanPaths(
        plan,
        pinnedWorkingDirectory?.runtimePath,
        artifactLocation,
      );
      executionContext = createExecutionContext(effectivePlan);

      const preRuntimeTerminalCause = currentTerminalCause();
      if (preRuntimeTerminalCause) {
        return settle(settleTerminalCause(preRuntimeTerminalCause, effectivePlan));
      }

      const evidence = await this.runtime.execute(
        runtimePlan,
        plana,
        cancellationBoundary,
        runtimeObserver,
      );
      return settle(rewriteTerminalEvidencePaths(evidence, effectivePlan));
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
          phase: 'repository-scoped path resolution',
        }),
      );
    } finally {
      if (releasePinnedWorkingDirectory !== undefined) {
        try {
          await releasePinnedWorkingDirectory();
        } catch {
          // best-effort descriptor cleanup only
        }
      }
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
