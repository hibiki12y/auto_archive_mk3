/**
 * WU-I ComputeNode conformance harness — per-backend wiring.
 *
 * Runs the shared `runComputeNodeConformanceSuite` harness (WU-I §CC-1…CC-7)
 * against every registered ComputeNode implementation:
 *
 *   ✓  InProcessComputeNode      — test double backed by AgentRuntime
 *   ✓  LocalComputeNode          — test double with injected executor
 *   ✓  GitLabCloneComputeNode    — direct production git-clone path with
 *                                  synthetic allocation semantics
 *   ✓  SlurmApptainerComputeNode — production composing impl, exercised
 *                                  through a mocked SubprocessRunner that
 *                                  emulates `salloc` / `apptainer` /
 *                                  `scancel` at the subprocess boundary
 *                                  (WU-I Stage 2; real-CLI integration
 *                                  paths remain gated behind opt-in
 *                                  external test wiring).
 *
 * Consolidation decision (WU-I task §4):
 *   The existing `tests/core/compute-node.spec.ts` covers the WU-P Stage A
 *   surface lock (structural guard, skeleton NotImplemented assertions, and
 *   the LocalComputeNode.wasCancelled introspection helper).  Those tests are
 *   intentionally kept; this file adds the deeper WU-I invariant set on top.
 *   The net test count grows; nothing is deleted.
 *
 * Explicit registration (BC-6): backends are named here — no filesystem scan
 * or reflection.  This file is the single audit point for "which ComputeNode
 * impls are under WU-I conformance."
 */

import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, describe, it, vi } from 'vitest';

import { AgentRuntime, createExecutionCheckpoint } from '../../src/index.js';
import { CurrentNodeComputeNode } from '../../src/core/current-node-compute-node.js';
import { GitLabCloneComputeNode } from '../../src/core/gitlab-clone-compute-node.js';
import {
  InProcessComputeNode,
  LocalComputeNode,
  type LocalComputeExecutor,
} from '../../src/core/__test__/compute-node-test-doubles.js';
import {
  SlurmApptainerComputeNode,
  type SlurmAllocator,
  type ApptainerRuntime,
  type CapabilityResolver,
  type SubprocessRequest,
  type SubprocessResult,
  type SubprocessRunner,
} from '../../src/core/compute-node-slurm-apptainer.js';
import type {
  ExecutionCheckpointPublisher,
  GitClient,
} from '../../src/index.js';
import {
  makeStubAgentRuntime,
  runComputeNodeConformanceSuite,
} from '../helpers/compute-node-conformance.js';

// ---------------------------------------------------------------------------
// Fixture factories (BC-6: explicit, not reflected)
// ---------------------------------------------------------------------------

/**
 * InProcessComputeNode: wraps AgentRuntime; uses the harness stub driver to
 * produce deterministic terminal evidence without network or filesystem I/O.
 */
function makeInProcess(): InProcessComputeNode {
  return new InProcessComputeNode({ runtime: makeStubAgentRuntime() });
}

/**
 * LocalComputeNode: uses an injected executor that emits one lifecycle phase
 * and returns well-formed terminal evidence.  The executor signature matches
 * LocalComputeExecutor exactly.
 */
function makeLocal(): LocalComputeNode {
  const executor: LocalComputeExecutor = async (allocation, plan, _plana, _cb, observer) => {
    observer?.({
      phase: 'runtime-running',
      taskId: plan.taskId,
      instanceId: `local-${allocation.allocationId}`,
      observedAt: new Date().toISOString(),
    });
    return {
      taskId: plan.taskId,
      runtimeInstanceId: `local-${allocation.allocationId}`,
      outcome: 'success' as const,
      reason: 'local executor completed in conformance harness',
      provenance: 'compute-node-conformance-spec-local',
      executionContext: {
        planCreatedAt: plan.createdAt,
        runtimeSettings: plan.runtimeSettings,
      },
      resourceEnvelope: {
        requested: { ...plan.resourceEnvelope.requested },
        effective: { ...plan.resourceEnvelope.effective },
      },
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      artifactLocation: plan.artifactLocation,
      cause: {
        kind: 'success',
        taskId: plan.taskId,
        runtimeInstanceId: `local-${allocation.allocationId}`,
        observedAt: new Date().toISOString(),
        provenance: 'compute-node-conformance-spec-local',
      },
    };
  };
  return new LocalComputeNode({ executor });
}

// ---------------------------------------------------------------------------
// Harness runs (BC-6: explicit registration — InProcessComputeNode first,
// then LocalComputeNode)
// ---------------------------------------------------------------------------

runComputeNodeConformanceSuite('InProcessComputeNode', makeInProcess);
runComputeNodeConformanceSuite('LocalComputeNode', makeLocal);

const createdCloneRoots = new Set<string>();

function freshCloneRoot(label: string): string {
  const cloneRoot = path.join(
    process.cwd(),
    'results',
    `wu-i-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  );
  createdCloneRoots.add(cloneRoot);
  return cloneRoot;
}

function makeGitClone(): GitLabCloneComputeNode {
  const gitClient: GitClient = {
    getRepoTopLevel: vi.fn(async () => process.cwd()),
    getHeadRevision: vi.fn(async () => 'deadbeefcafebabe'),
    getOriginUrl: vi.fn(
      async () => 'https://gitlab.example.com/wu-i/conformance.git',
    ),
    clone: vi.fn(async (_repo, destination) => {
      await mkdir(destination, { recursive: true });
    }),
    checkoutDetach: vi.fn(async () => undefined),
  };
  const checkpointDriver: ExecutionCheckpointPublisher = {
    publish: vi.fn(async () =>
      createExecutionCheckpoint({
        source: 'gitlab',
        repositoryUrl: 'https://gitlab.example.com/wu-i/conformance.git',
        revision: 'deadbeefcafebabe',
        publishedAt: '2026-04-23T00:00:00.000Z',
      }),
    ),
  };
  return new GitLabCloneComputeNode({
    runtime: new AgentRuntime({
      run: async (context) => ({
        reason: 'git-clone conformance harness completed',
        provenance: 'compute-node-conformance-git-clone',
        cause: {
          kind: 'success',
          taskId: context.plan.taskId,
          runtimeInstanceId: context.instance.instanceId,
          observedAt: new Date().toISOString(),
          provenance: 'compute-node-conformance-git-clone',
        },
      }),
    }),
    gitClient,
    checkpointDriver,
    cloneRoot: freshCloneRoot('git-clone'),
  });
}

function makeCurrentNode(): CurrentNodeComputeNode {
  return new CurrentNodeComputeNode({
    runtime: new AgentRuntime({
      run: async (context) => ({
        reason: 'current-node conformance harness completed',
        provenance: 'compute-node-conformance-current-node',
        cause: {
          kind: 'success',
          taskId: context.plan.taskId,
          runtimeInstanceId: context.instance.instanceId,
          observedAt: new Date().toISOString(),
          provenance: 'compute-node-conformance-current-node',
        },
      }),
    }),
    gitClient: {
      getRepoTopLevel: async () => process.cwd(),
      getHeadRevision: async () => 'deadbeefcafebabe',
      getOriginUrl: async () => 'https://gitlab.example.com/wu-i/conformance.git',
      clone: async () => undefined,
      checkoutDetach: async () => undefined,
    },
  });
}

afterAll(async () => {
  await Promise.all(
    [...createdCloneRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  createdCloneRoots.clear();
});

runComputeNodeConformanceSuite('GitLabCloneComputeNode', makeGitClone);
runComputeNodeConformanceSuite('CurrentNodeComputeNode', makeCurrentNode);

// ---------------------------------------------------------------------------
// SlurmApptainerComputeNode (WU-I Stage 2)
//
// Exercises the production composing impl against a fully mocked subprocess
// boundary.  No real `salloc` / `apptainer` / `scancel` invocation occurs;
// the mock returns deterministic exit codes and a synthetic SLURM job id so
// the conformance harness can assert lifecycle, evidence, and cancel
// semantics without standing up a SLURM cluster.
//
// Real-CLI integration paths (e.g. `child_process.spawn`-backed runner gated
// behind `SLURM_INTEGRATION=1`) live outside this unit test surface and are
// composed in dedicated integration test suites.
// ---------------------------------------------------------------------------

class MockSlurmApptainerRunner implements SubprocessRunner {
  private jobCounter = 0;
  readonly calls: SubprocessRequest[] = [];

  async run(request: SubprocessRequest): Promise<SubprocessResult> {
    this.calls.push(request);
    switch (request.command) {
      case 'salloc': {
        this.jobCounter += 1;
        const jobId = 1_000_000 + this.jobCounter;
        return {
          exitCode: 0,
          stdout: `salloc: Granted job allocation ${jobId}\n`,
          stderr: '',
        };
      }
      case 'apptainer': {
        return {
          exitCode: 0,
          stdout: 'apptainer-mock: ok\n',
          stderr: '',
        };
      }
      case 'scancel': {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      default: {
        // Exhaustive: SubprocessRequest.command is a fixed string union.
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    }
  }
}

const SLURM_ALLOCATOR_STUB: SlurmAllocator = { kind: 'slurm-allocator' };
const APPTAINER_RUNTIME_STUB: ApptainerRuntime = { kind: 'apptainer-runtime' };

const STATIC_CAPABILITY_RESOLVER: CapabilityResolver = {
  surface: () => ({
    kind: 'slurm-apptainer' as const,
    execution: {
      hasNetwork: false,
      hasFilesystemWrite: false,
      rootless: true,
    },
    capabilityFlags: [],
  }),
};

function makeSlurmApptainer(): SlurmApptainerComputeNode {
  return new SlurmApptainerComputeNode({
    allocator: SLURM_ALLOCATOR_STUB,
    runtime: APPTAINER_RUNTIME_STUB,
    capabilityResolver: STATIC_CAPABILITY_RESOLVER,
    subprocessRunner: new MockSlurmApptainerRunner(),
  });
}

runComputeNodeConformanceSuite('SlurmApptainerComputeNode', makeSlurmApptainer);

// Retain the unused-symbol hooks so the dead-import lint stays happy if the
// describe.skip block is re-introduced for ad-hoc gating in the future.
void describe;
void it;
