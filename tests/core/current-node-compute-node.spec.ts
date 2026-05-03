import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { deriveOutcomeFromCause } from '../../src/core/derive-outcome.js';
import {
  AgentRuntime,
  CurrentNodeComputeNode,
  Plana,
  createDispatchPlan,
  type GitClient,
  type RuntimeCancellationBoundary,
  type RuntimeDriver,
  type RuntimeDriverResult,
  type RuntimeTerminalCause,
} from '../../src/index.js';
import { createTaskRequest } from '../helpers/dispatcher-core.js';
import { synthesizeDriverCause, UNUSED_IDENTITY } from '../helpers/wu-v-cause.js';

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

function successfulRuntimeDriver(
  reason = 'current-node runtime completed',
): RuntimeDriver {
  return {
    run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
      reason,
      provenance: 'current-node-test-driver',
      cause: synthesizeDriverCause(UNUSED_IDENTITY, {
        outcome: 'success',
        reason,
        provenance: 'current-node-test-driver',
      }),
    })),
  };
}

function createGitClient(repositoryRoot: string): GitClient {
  return {
    getRepoTopLevel: vi.fn(async () => repositoryRoot),
    getHeadRevision: vi.fn(),
    getOriginUrl: vi.fn(),
    clone: vi.fn(),
    checkoutDetach: vi.fn(),
  };
}

async function createSandboxPaths(name: string): Promise<{
  baseDirectory: string;
  repositoryRoot: string;
  outsideDirectory: string;
}> {
  const baseDirectory = path.join(
    process.cwd(),
    'results',
    'current-node-compute-node-spec',
    `${name}-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`,
  );
  const repositoryRoot = path.join(baseDirectory, 'repository-root');
  const outsideDirectory = path.join(baseDirectory, 'outside-root');
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(outsideDirectory, { recursive: true });
  return { baseDirectory, repositoryRoot, outsideDirectory };
}

describe('current node compute node', () => {
  it('rewrites repository-scoped workingDirectory and artifactLocation', async () => {
    const sandbox = await createSandboxPaths('happy-path');

    try {
      const runtimeDriver = successfulRuntimeDriver();
      const node = new CurrentNodeComputeNode({
        runtime: new AgentRuntime(runtimeDriver),
        gitClient: createGitClient(sandbox.repositoryRoot),
      });
      const plan = createDispatchPlan(createTaskRequest('task-current-node-paths'));
      const allocation = await node.allocate(plan);

      const evidence = await node.dispatch(
        allocation,
        plan,
        new Plana(),
        createNeutralBoundary(plan.taskId),
      );

      expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
      expect(runtimeDriver.run).toHaveBeenCalledTimes(1);
      const runtimeContext = vi.mocked(runtimeDriver.run).mock.calls[0][0];
      expect(runtimeContext.plan.runtimeSettings.workingDirectory).toMatch(
        new RegExp(`^/proc/${process.pid}/fd/\\d+$`),
      );
      expect(evidence.executionContext.runtimeSettings.workingDirectory).toBe(
        path.join(sandbox.repositoryRoot, 'results', 'task-artifacts'),
      );
      expect(runtimeContext.plan.artifactLocation).toBe(
        path.join(sandbox.repositoryRoot, 'results', 'task-artifacts'),
      );
    } finally {
      await rm(sandbox.baseDirectory, { recursive: true, force: true });
    }
  });

  it('discovers the repository root from an absolute configured workingDirectory', async () => {
    const sandbox = await createSandboxPaths('absolute-working-directory-probe');

    try {
      const runtimeDriver = successfulRuntimeDriver();
      const gitClient = createGitClient(sandbox.repositoryRoot);
      const node = new CurrentNodeComputeNode({
        runtime: new AgentRuntime(runtimeDriver),
        gitClient,
      });
      const taskArtifacts = path.join(
        sandbox.repositoryRoot,
        'results',
        'task-artifacts',
      );
      const baseRequest = createTaskRequest(
        'task-current-node-absolute-working-directory',
      );
      const plan = createDispatchPlan({
        ...baseRequest,
        runtimeSettings: {
          ...baseRequest.runtimeSettings,
          workingDirectory: taskArtifacts,
        },
        artifactLocation: taskArtifacts,
      });
      const allocation = await node.allocate(plan);

      const evidence = await node.dispatch(
        allocation,
        plan,
        new Plana(),
        createNeutralBoundary(plan.taskId),
      );

      expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
      expect(gitClient.getRepoTopLevel).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: sandbox.repositoryRoot,
          signal: expect.any(AbortSignal),
        }),
      );
      expect(runtimeDriver.run).toHaveBeenCalledTimes(1);
      expect(evidence.executionContext.runtimeSettings.workingDirectory).toBe(
        taskArtifacts,
      );
      expect(evidence.artifactLocation).toBe(taskArtifacts);
    } finally {
      await rm(sandbox.baseDirectory, { recursive: true, force: true });
    }
  });

  it('pins workingDirectory to the validated directory across a post-validation symlink swap', async () => {
    const sandbox = await createSandboxPaths('working-directory-pin');
    const repositoryResults = path.join(sandbox.repositoryRoot, 'results');
    const repositoryTaskArtifacts = path.join(repositoryResults, 'task-artifacts');
    const outsideTaskArtifacts = path.join(
      sandbox.outsideDirectory,
      'task-artifacts',
    );
    await mkdir(repositoryTaskArtifacts, { recursive: true });
    await mkdir(outsideTaskArtifacts, { recursive: true });
    await writeFile(
      path.join(repositoryTaskArtifacts, 'sentinel.txt'),
      'inside',
      'utf8',
    );
    await writeFile(
      path.join(outsideTaskArtifacts, 'sentinel.txt'),
      'outside',
      'utf8',
    );

    try {
      const runtimeDriver: RuntimeDriver = {
        run: vi.fn(async (context): Promise<RuntimeDriverResult> => {
          const pinnedWorkingDirectory =
            context.plan.runtimeSettings.workingDirectory;
          expect(pinnedWorkingDirectory).toMatch(
            new RegExp(`^/proc/${process.pid}/fd/\\d+$`),
          );

          await rename(repositoryResults, path.join(sandbox.repositoryRoot, 'results-parked'));
          await symlink(sandbox.outsideDirectory, repositoryResults);

          await expect(
            readFile(path.join(pinnedWorkingDirectory, 'sentinel.txt'), 'utf8'),
          ).resolves.toBe('inside');
          await expect(
            readFile(
              path.join(repositoryTaskArtifacts, 'sentinel.txt'),
              'utf8',
            ),
          ).resolves.toBe('outside');

          return {
            reason: 'current-node runtime completed',
            provenance: 'current-node-test-driver',
            cause: synthesizeDriverCause(UNUSED_IDENTITY, {
              outcome: 'success',
              reason: 'current-node runtime completed',
              provenance: 'current-node-test-driver',
            }),
          };
        }),
      };
      const node = new CurrentNodeComputeNode({
        runtime: new AgentRuntime(runtimeDriver),
        gitClient: createGitClient(sandbox.repositoryRoot),
      });
      const baseRequest = createTaskRequest('task-current-node-working-directory-pin');
      const plan = createDispatchPlan({
        ...baseRequest,
        runtimeSettings: {
          ...baseRequest.runtimeSettings,
          workingDirectory: path.join('results', 'task-artifacts'),
        },
      });
      const allocation = await node.allocate(plan);

      const evidence = await node.dispatch(
        allocation,
        plan,
        new Plana(),
        createNeutralBoundary(plan.taskId),
      );

      expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
      expect(runtimeDriver.run).toHaveBeenCalledTimes(1);
    } finally {
      await rm(sandbox.baseDirectory, { recursive: true, force: true });
    }
  });

  it('fails closed when a repository-scoped workingDirectory escapes the repository root', async () => {
    const runtimeDriver = successfulRuntimeDriver('unexpected success');
    const node = new CurrentNodeComputeNode({
      runtime: new AgentRuntime(runtimeDriver),
      gitClient: createGitClient(process.cwd()),
    });
    const baseRequest = createTaskRequest('task-current-node-escape');
    const plan = createDispatchPlan({
      ...baseRequest,
      runtimeSettings: {
        ...baseRequest.runtimeSettings,
        workingDirectory: '/outside-repository-root',
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
    expect(evidence.provenance).toBe('current-node-compute-node');
    expect(evidence.reason).toContain(
      'workingDirectory must resolve inside the repository root.',
    );
    expect(runtimeDriver.run).not.toHaveBeenCalled();
  });

  it('rejects symlink-based workingDirectory escapes', async () => {
    const sandbox = await createSandboxPaths('working-directory-symlink-escape');
    await symlink(sandbox.outsideDirectory, path.join(sandbox.repositoryRoot, 'escape'));

    try {
      const runtimeDriver = successfulRuntimeDriver('unexpected success');
      const node = new CurrentNodeComputeNode({
        runtime: new AgentRuntime(runtimeDriver),
        gitClient: createGitClient(sandbox.repositoryRoot),
      });
      const baseRequest = createTaskRequest('task-current-node-symlink-escape');
      const plan = createDispatchPlan({
        ...baseRequest,
        runtimeSettings: {
          ...baseRequest.runtimeSettings,
          workingDirectory: path.join('escape', 'nested'),
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
      expect(evidence.reason).toContain(
        'workingDirectory must resolve inside the repository root.',
      );
      expect(runtimeDriver.run).not.toHaveBeenCalled();
    } finally {
      await rm(sandbox.baseDirectory, { recursive: true, force: true });
    }
  });

  it('rejects symlink-based artifactLocation escapes', async () => {
    const sandbox = await createSandboxPaths('artifact-location-symlink-escape');
    await symlink(sandbox.outsideDirectory, path.join(sandbox.repositoryRoot, 'escape'));

    try {
      const runtimeDriver = successfulRuntimeDriver('unexpected success');
      const node = new CurrentNodeComputeNode({
        runtime: new AgentRuntime(runtimeDriver),
        gitClient: createGitClient(sandbox.repositoryRoot),
      });
      const baseRequest = createTaskRequest('task-current-node-artifact-escape');
      const plan = createDispatchPlan({
        ...baseRequest,
        artifactLocation: path.join('escape', 'artifacts'),
      });
      const allocation = await node.allocate(plan);

      const evidence = await node.dispatch(
        allocation,
        plan,
        new Plana(),
        createNeutralBoundary(plan.taskId),
      );

      expect(deriveOutcomeFromCause(evidence.cause)).toBe('failure');
      expect(evidence.reason).toContain(
        'artifactLocation must resolve inside the repository root.',
      );
      expect(runtimeDriver.run).not.toHaveBeenCalled();
    } finally {
      await rm(sandbox.baseDirectory, { recursive: true, force: true });
    }
  });

  it('drops the allocation entry from its internal Map after dispatch settles', async () => {
    const sandbox = await createSandboxPaths('allocations-map-cleanup');

    try {
      const runtimeDriver = successfulRuntimeDriver();
      const node = new CurrentNodeComputeNode({
        runtime: new AgentRuntime(runtimeDriver),
        gitClient: createGitClient(sandbox.repositoryRoot),
      });
      // The `allocations` Map is private; cast for the regression check.
      const internalAllocations = (node as unknown as {
        allocations: Map<string, unknown>;
      }).allocations;

      for (let i = 0; i < 3; i += 1) {
        const plan = createDispatchPlan(
          createTaskRequest(`task-current-node-cleanup-${i}`),
        );
        const allocation = await node.allocate(plan);
        expect(internalAllocations.has(allocation.allocationId)).toBe(true);
        const evidence = await node.dispatch(
          allocation,
          plan,
          new Plana(),
          createNeutralBoundary(plan.taskId),
        );
        expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
        expect(internalAllocations.has(allocation.allocationId)).toBe(false);
      }
      expect(internalAllocations.size).toBe(0);
    } finally {
      await rm(sandbox.baseDirectory, { recursive: true, force: true });
    }
  });
});
