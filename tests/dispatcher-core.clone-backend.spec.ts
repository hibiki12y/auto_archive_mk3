import { synthesizeDriverCause, UNUSED_IDENTITY } from './helpers/wu-v-cause.js';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveOutcomeFromCause } from '../src/core/derive-outcome.js';

import {
  AUTO_ARCHIVE_COMPUTE_NODE,
  AUTO_ARCHIVE_DISPATCH_CLONE_ROOT,
  AgentRuntime,
  Arona,
  Dispatcher,
  GitLabCloneComputeNode,
  Plana,
  createDefaultComputeNode,
  createDispatchPlan,
  createExecutionCheckpoint,
  type ExecutionCheckpointPublisher,
  type GitClient,
  type RuntimeCancellationBoundary,
  type RuntimeDriver,
  type RuntimeDriverResult,
  type RuntimeTerminalCause,
} from '../src/index.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

function createNeutralBoundary(taskId: string): RuntimeCancellationBoundary {
  return {
    cancel: () => ({
      taskId,
      reason: 'unexpected cancel',
      provenance: 'test-boundary',
      requestedAt: new Date().toISOString(),
    }),
    currentTerminalCause: () => undefined,
    whenTerminalCause: () => new Promise<RuntimeTerminalCause>(() => undefined),
  };
}

function createExternalCancelBoundary(taskId: string): {
  boundary: RuntimeCancellationBoundary;
  trigger: (reason?: string, provenance?: string) => void;
} {
  let terminalCause: RuntimeTerminalCause | undefined;
  let resolveTerminalCause: ((cause: RuntimeTerminalCause) => void) | undefined;
  const terminalCausePromise = new Promise<RuntimeTerminalCause>((resolve) => {
    resolveTerminalCause = resolve;
  });

  return {
    boundary: {
      cancel: () => ({
        taskId,
        reason: 'unexpected runtime cancel',
        provenance: 'test-boundary',
        requestedAt: new Date().toISOString(),
      }),
      currentTerminalCause: () => terminalCause,
      whenTerminalCause: () => terminalCausePromise,
    },
    trigger: (reason = 'operator requested stop', provenance = 'dispatcher') => {
      terminalCause = {
        kind: 'external-cancel',
        taskId,
        reason,
        provenance,
        requestedAt: new Date().toISOString(),
      };
      resolveTerminalCause?.(terminalCause);
    },
  };
}

function createCheckpointPublisher(): ExecutionCheckpointPublisher {
  return {
    publish: vi.fn(async () =>
      createExecutionCheckpoint({
        source: 'gitlab',
        repositoryUrl: 'https://gitlab.example.com/auto-archive/repo.git',
        revision: 'deadbeefcafebabe',
        publishedAt: '2025-01-01T00:00:00.000Z',
      })),
  };
}

describe('git clone compute node', () => {
  const createdCloneRoots = new Set<string>();

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env[AUTO_ARCHIVE_COMPUTE_NODE];
    delete process.env[AUTO_ARCHIVE_DISPATCH_CLONE_ROOT];
    await Promise.all(
      [...createdCloneRoots].map(async (cloneRoot) => {
        await rm(cloneRoot, { recursive: true, force: true });
      }),
    );
    createdCloneRoots.clear();
  });

  it('rewrites clone-scoped paths and propagates execution checkpoint into terminal evidence', async () => {
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
        reason: 'clone-backed runtime completed',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'clone-backed runtime completed', provenance: 'test-driver' }),
      })),
    };
    const runtime = new AgentRuntime(runtimeDriver);
    let cloneDestination: string | undefined;
    const gitClient: GitClient = {
      getRepoTopLevel: vi.fn(async () => process.cwd()),
      getHeadRevision: vi.fn(async () => 'deadbeefcafebabe'),
      getOriginUrl: vi.fn(async () => 'https://gitlab.example.com/auto-archive/repo.git'),
      clone: vi.fn(async (_repositoryUrl, destination) => {
        cloneDestination = destination;
        await mkdir(destination, { recursive: true });
      }),
      checkoutDetach: vi.fn(async () => undefined),
    };
    const checkpointDriver = createCheckpointPublisher();
    const cloneRoot = path.join(process.cwd(), 'results', 'dispatch-clones-test');
    createdCloneRoots.add(cloneRoot);
    const node = new GitLabCloneComputeNode({
      runtime,
      gitClient,
      checkpointDriver,
      cloneRoot,
    });
    const plan = createDispatchPlan(createTaskRequest('task-clone-backed'));
    const allocation = await node.allocate(plan);

    const evidence = await node.dispatch(
      allocation,
      plan,
      new Plana(),
      createNeutralBoundary(plan.taskId),
    );

    expect(runtimeDriver.run).toHaveBeenCalledTimes(1);
    const runtimeContext = vi.mocked(runtimeDriver.run).mock.calls[0][0];
    expect(cloneDestination).toBeDefined();
    expect(runtimeContext.plan.runtimeSettings.workingDirectory).toBe(
      path.join(cloneDestination!, 'results/task-artifacts'),
    );
    expect(runtimeContext.plan.artifactLocation).toBe(
      path.join(cloneDestination!, 'results/task-artifacts'),
    );
    expect(runtimeContext.plan.executionCheckpoint).toEqual({
      source: 'gitlab',
      repositoryUrl: 'https://gitlab.example.com/auto-archive/repo.git',
      revision: 'deadbeefcafebabe',
      publishedAt: '2025-01-01T00:00:00.000Z',
    });
    expect(evidence.executionContext.executionCheckpoint).toEqual(
      runtimeContext.plan.executionCheckpoint,
    );
    expect(vi.mocked(gitClient.clone)).toHaveBeenCalledWith(
      'https://gitlab.example.com/auto-archive/repo.git',
      expect.any(String),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(vi.mocked(gitClient.checkoutDetach)).toHaveBeenCalledWith(
      'deadbeefcafebabe',
      expect.objectContaining({
        cwd: cloneDestination,
      }),
    );
  });

  it('routes the canonical dispatch path through the configured compute-node abstraction', async () => {
    process.env[AUTO_ARCHIVE_COMPUTE_NODE] = 'git-clone';

    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
        reason: 'clone-backed runtime completed through dispatcher',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'clone-backed runtime completed through dispatcher', provenance: 'test-driver' }),
      })),
    };
    let cloneDestination: string | undefined;
    const gitClient: GitClient = {
      getRepoTopLevel: vi.fn(async () => process.cwd()),
      getHeadRevision: vi.fn(async () => 'deadbeefcafebabe'),
      getOriginUrl: vi.fn(async () => 'https://gitlab.example.com/auto-archive/repo.git'),
      clone: vi.fn(async (_repositoryUrl, destination) => {
        cloneDestination = destination;
        await mkdir(destination, { recursive: true });
      }),
      checkoutDetach: vi.fn(async () => undefined),
    };
    const checkpointDriver = createCheckpointPublisher();
    const cloneRoot = path.join(
      process.cwd(),
      'results',
      'dispatch-clones-dispatcher-test',
    );
    createdCloneRoots.add(cloneRoot);
    const dispatcher = new Dispatcher(
      createDefaultComputeNode({
        runtime: new AgentRuntime(runtimeDriver),
        gitClient,
        checkpointDriver,
        cloneRoot,
      }),
    );

    const result = await new Arona(new Plana(), dispatcher).requestDispatch(
      createTaskRequest('task-dispatcher-clone-backed'),
    );

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
      expect(evidence.reason).toBe('clone-backed runtime completed through dispatcher');
      expect(evidence.provenance).toBe('test-driver');
    }

    expect(runtimeDriver.run).toHaveBeenCalledTimes(1);
    const runtimeContext = vi.mocked(runtimeDriver.run).mock.calls[0][0];
    expect(cloneDestination).toBeDefined();
    expect(runtimeContext.plan.runtimeSettings.workingDirectory).toBe(
      path.join(cloneDestination!, 'results/task-artifacts'),
    );
    expect(runtimeContext.plan.artifactLocation).toBe(
      path.join(cloneDestination!, 'results/task-artifacts'),
    );
  });

  it('activates the git clone compute node only when explicitly env-gated', () => {
    expect(createDefaultComputeNode()).not.toBeInstanceOf(GitLabCloneComputeNode);

    process.env[AUTO_ARCHIVE_COMPUTE_NODE] = 'git-clone';

    expect(
      createDefaultComputeNode({
        runtime: new AgentRuntime({
          run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
            reason: 'unused',
            provenance: 'test-driver',
            cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'unused', provenance: 'test-driver' }),
          })),
        }),
        gitClient: {
          getRepoTopLevel: vi.fn(),
          getHeadRevision: vi.fn(),
          getOriginUrl: vi.fn(),
          clone: vi.fn(),
          checkoutDetach: vi.fn(),
        } as unknown as GitClient,
        checkpointDriver: createCheckpointPublisher(),
      }),
    ).toBeInstanceOf(GitLabCloneComputeNode);
  });

  it('fans the expected lifecycle phase sequence to inline and attached observers', async () => {
    const node = new GitLabCloneComputeNode({
      runtime: new AgentRuntime({
        run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
          reason: 'clone-backed runtime completed',
          provenance: 'test-driver',
          cause: synthesizeDriverCause(UNUSED_IDENTITY, {
            outcome: 'success',
            reason: 'clone-backed runtime completed',
            provenance: 'test-driver',
          }),
        })),
      }),
      gitClient: {
        getRepoTopLevel: vi.fn(async () => process.cwd()),
        getHeadRevision: vi.fn(async () => 'deadbeefcafebabe'),
        getOriginUrl: vi.fn(
          async () => 'https://gitlab.example.com/auto-archive/repo.git',
        ),
        clone: vi.fn(async (_repositoryUrl, destination) => {
          await mkdir(destination, { recursive: true });
        }),
        checkoutDetach: vi.fn(async () => undefined),
      },
      checkpointDriver: createCheckpointPublisher(),
      cloneRoot: path.join(process.cwd(), 'results', 'dispatch-clones-observer-test'),
    });
    createdCloneRoots.add(
      path.join(process.cwd(), 'results', 'dispatch-clones-observer-test'),
    );
    const plan = createDispatchPlan(createTaskRequest('task-clone-observer'));
    const allocation = await node.allocate(plan);
    const attached: string[] = [];
    const inline: string[] = [];
    node.observe(allocation, (observation) => {
      attached.push(observation.phase);
    });

    await node.dispatch(
      allocation,
      plan,
      new Plana(),
      createNeutralBoundary(plan.taskId),
      (observation) => {
        inline.push(observation.phase);
      },
    );

    expect(inline).toEqual([
      'accepted',
      'runtime-entering',
      'runtime-running',
      'settling',
      'terminal',
    ]);
    expect(attached).toEqual(inline);
  });

  it('fails closed when rewritten clone paths escape outside the clone root', async () => {
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
        reason: 'unexpected success',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'unexpected success', provenance: 'test-driver' }),
      })),
    };
    const cloneRoot = path.join(process.cwd(), 'results', 'dispatch-clones-escape-test');
    createdCloneRoots.add(cloneRoot);
    const node = new GitLabCloneComputeNode({
      runtime: new AgentRuntime(runtimeDriver),
      gitClient: {
        getRepoTopLevel: vi.fn(async () => process.cwd()),
        getHeadRevision: vi.fn(async () => 'deadbeefcafebabe'),
        getOriginUrl: vi.fn(async () => 'https://gitlab.example.com/auto-archive/repo.git'),
        clone: vi.fn(async (_repositoryUrl, destination) => {
          await mkdir(destination, { recursive: true });
        }),
        checkoutDetach: vi.fn(async () => undefined),
      },
      checkpointDriver: createCheckpointPublisher(),
      cloneRoot,
    });
    const baseRequest = createTaskRequest('task-clone-escape');
    const plan = createDispatchPlan({
      ...baseRequest,
      runtimeSettings: {
        ...baseRequest.runtimeSettings,
        workingDirectory: '/outside-clone-root',
      },
    });

    const allocation = await node.allocate(plan);
    const evidence = await node.dispatch(
      allocation,
      plan,
      new Plana(),
      createNeutralBoundary(plan.taskId),
    );

    expect(deriveOutcomeFromCause(evidence.cause)).toBe('failure');
    expect(evidence.provenance).toBe('gitlab-clone-compute-node');
    expect(evidence.reason).toContain(
      'workingDirectory must resolve inside the cloned repository.',
    );
    expect(runtimeDriver.run).not.toHaveBeenCalled();
  });

  it('fails closed when a relative clone root override escapes outside the repository root', async () => {
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
        reason: 'unexpected success',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'unexpected success', provenance: 'test-driver' }),
      })),
    };
    const gitClient: GitClient = {
      getRepoTopLevel: vi.fn(async () => process.cwd()),
      getHeadRevision: vi.fn(async () => 'deadbeefcafebabe'),
      getOriginUrl: vi.fn(async () => 'https://gitlab.example.com/auto-archive/repo.git'),
      clone: vi.fn(async (_repositoryUrl, destination) => {
        await mkdir(destination, { recursive: true });
      }),
      checkoutDetach: vi.fn(async () => undefined),
    };
    const node = new GitLabCloneComputeNode({
      runtime: new AgentRuntime(runtimeDriver),
      gitClient,
      checkpointDriver: createCheckpointPublisher(),
      cloneRoot: '../dispatch-clones-escape-attempt',
    });
    const plan = createDispatchPlan(createTaskRequest('task-clone-root-escape'));

    const allocation = await node.allocate(plan);
    const evidence = await node.dispatch(
      allocation,
      plan,
      new Plana(),
      createNeutralBoundary(plan.taskId),
    );

    expect(deriveOutcomeFromCause(evidence.cause)).toBe('failure');
    expect(evidence.provenance).toBe('gitlab-clone-compute-node');
    expect(evidence.reason).toContain(
      'cloneRoot must resolve inside the repository root.',
    );
    expect(vi.mocked(gitClient.clone)).not.toHaveBeenCalled();
    expect(runtimeDriver.run).not.toHaveBeenCalled();
  });

  it('honors external cancellation that arrives during clone staging before runtime starts', async () => {
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
        reason: 'unexpected success',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'unexpected success', provenance: 'test-driver' }),
      })),
    };
    const checkpointDriver = createCheckpointPublisher();
    const cloneRoot = path.join(process.cwd(), 'results', 'dispatch-clones-cancel-test');
    createdCloneRoots.add(cloneRoot);
    let notifyCloneStarted: (() => void) | undefined;
    const cloneStarted = new Promise<void>((resolve) => {
      notifyCloneStarted = resolve;
    });
    const gitClient: GitClient = {
      getRepoTopLevel: vi.fn(async () => process.cwd()),
      getHeadRevision: vi.fn(async () => 'deadbeefcafebabe'),
      getOriginUrl: vi.fn(async () => 'https://gitlab.example.com/auto-archive/repo.git'),
      clone: vi.fn(
        async (_repositoryUrl, destination, options): Promise<void> => {
          await mkdir(destination, { recursive: true });
          notifyCloneStarted?.();
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => {
                const abortError = new Error('clone aborted');
                abortError.name = 'AbortError';
                reject(abortError);
              },
              { once: true },
            );
          });
        },
      ),
      checkoutDetach: vi.fn(async () => undefined),
    };
    const node = new GitLabCloneComputeNode({
      runtime: new AgentRuntime(runtimeDriver),
      gitClient,
      checkpointDriver,
      cloneRoot,
    });
    const plan = createDispatchPlan(createTaskRequest('task-clone-cancel'));
    const cancellation = createExternalCancelBoundary(plan.taskId);
    const allocation = await node.allocate(plan);

    const completion = node.dispatch(
      allocation,
      plan,
      new Plana(),
      cancellation.boundary,
    );
    await cloneStarted;
    cancellation.trigger('operator requested stop during clone');

    const evidence = await completion;

    expect(deriveOutcomeFromCause(evidence.cause)).toBe('operator-cancel');
    expect(evidence.reason).toBe('operator requested stop during clone');
    expect(evidence.provenance).toBe('dispatcher');
    expect(runtimeDriver.run).not.toHaveBeenCalled();
    expect(vi.mocked(gitClient.checkoutDetach)).not.toHaveBeenCalled();
  });

  it('starts deadline accounting only after clone staging hands off to the runtime', async () => {
    vi.useFakeTimers();

    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(
        async (): Promise<RuntimeDriverResult> =>
          await new Promise<RuntimeDriverResult>((resolve) => {
            setTimeout(() => {
              resolve({
                reason: 'runtime finished after clone staging',
                provenance: 'test-driver',
                cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'runtime finished after clone staging', provenance: 'test-driver' }),
              });
            }, 75);
          }),
      ),
    };
    const cloneRoot = path.join(process.cwd(), 'results', 'dispatch-clones-deadline-test');
    createdCloneRoots.add(cloneRoot);
    let notifyCloneStarted: (() => void) | undefined;
    const cloneStarted = new Promise<void>((resolve) => {
      notifyCloneStarted = resolve;
    });
    const gitClient: GitClient = {
      getRepoTopLevel: vi.fn(async () => process.cwd()),
      getHeadRevision: vi.fn(async () => 'deadbeefcafebabe'),
      getOriginUrl: vi.fn(async () => 'https://gitlab.example.com/auto-archive/repo.git'),
      clone: vi.fn(async (_repositoryUrl, destination) => {
        await mkdir(destination, { recursive: true });
        notifyCloneStarted?.();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });
      }),
      checkoutDetach: vi.fn(async () => undefined),
    };
    const node = new GitLabCloneComputeNode({
      runtime: new AgentRuntime(runtimeDriver),
      gitClient,
      checkpointDriver: createCheckpointPublisher(),
      cloneRoot,
    });
    const baseRequest = createTaskRequest('task-clone-runtime-deadline');
    const plan = createDispatchPlan({
      ...baseRequest,
      runtimeSettings: {
        ...baseRequest.runtimeSettings,
        deadlineMs: 50,
      },
    });
    const allocation = await node.allocate(plan);

    let settled = false;
    const completion = node.dispatch(
      allocation,
      plan,
      new Plana(),
      createNeutralBoundary(plan.taskId),
    );
    void completion.then(() => {
      settled = true;
    });

    await cloneStarted;
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.mocked(runtimeDriver.run)).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const evidence = await completion;

    expect(deriveOutcomeFromCause(evidence.cause)).toBe('timeout');
    expect(evidence.reason).toBe('agent runtime deadline of 50ms exceeded');
    expect(evidence.provenance).toBe('agent-runtime-deadline');
  });
});
