/**
 * WU-P Stage B verification: `Dispatcher` admits a `ComputeNode` directly
 * via its constructor surface. Uses `InProcessComputeNode` (test-only
 * double from `src/core/__test__/`) as the port-conformant target.
 *
 * Scope: construction seam, admission boundary, observer fan-out, and
 * the single-use submission invariant. Does NOT exercise
 * `SlurmApptainerComputeNode` method bodies — those are NotImplemented
 * skeletons in this stage.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveOutcomeFromCause } from '../src/core/derive-outcome.js';

import {
  AUTO_ARCHIVE_COMPUTE_NODE,
  AgentRuntime,
  CurrentNodeComputeNode,
  Dispatcher,
  DuplicateSubmissionError,
  Plana,
  createDefaultComputeNode,
  createDispatchPlan,
  type LifecyclePhaseObservation,
  type RuntimeDriver,
  type RuntimeDriverResult,
} from '../src/index.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';
import { synthesizeDriverCause, UNUSED_IDENTITY } from './helpers/wu-v-cause.js';

function successfulRuntimeDriver(reason = 'compute-node-construction'): RuntimeDriver {
  const partial = {
    outcome: 'success' as const,
    reason,
    provenance: 'in-process-compute-node-test-driver',
  };
  return {
    run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
      ...partial,
      cause: synthesizeDriverCause(UNUSED_IDENTITY, partial),
    })),
  };
}

describe('Dispatcher × ComputeNode construction seam (WU-P Stage B)', () => {
  afterEach(() => {
    delete process.env[AUTO_ARCHIVE_COMPUTE_NODE];
  });

  it('creates a CurrentNodeComputeNode when the default factory is env-gated to current-node', () => {
    process.env[AUTO_ARCHIVE_COMPUTE_NODE] = 'current-node';

    expect(
      createDefaultComputeNode({
        runtime: new AgentRuntime(successfulRuntimeDriver()),
      }),
    ).toBeInstanceOf(CurrentNodeComputeNode);
  });

  it('parameterless Dispatcher construction honors current-node through the default factory path', () => {
    process.env[AUTO_ARCHIVE_COMPUTE_NODE] = 'current-node';

    const dispatcher = new Dispatcher();
    const internalNode = (
      dispatcher as unknown as { node: unknown }
    ).node;

    expect(internalNode).toBeInstanceOf(CurrentNodeComputeNode);
  });

  it('admits a ComputeNode directly and produces terminal evidence on submit', async () => {
    const node = new InProcessComputeNode({
      runtime: new AgentRuntime(successfulRuntimeDriver()),
    });
    const dispatcher = new Dispatcher(node);
    const plan = createDispatchPlan(createTaskRequest('task-cn-construct-success'));

    const submission = dispatcher.submit(plan, new Plana());

    expect(submission.acceptance.boundary).toBe('dispatcher');
    expect(submission.acceptance.taskId).toBe('task-cn-construct-success');

    const evidence = await submission.completion;
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
    expect(evidence.reason).toBe('compute-node-construction');
  });

  it('fans the lifecycle observer through the ComputeNode dispatch path', async () => {
    const node = new InProcessComputeNode({
      runtime: new AgentRuntime(successfulRuntimeDriver()),
    });
    const dispatcher = new Dispatcher(node);
    const plan = createDispatchPlan(createTaskRequest('task-cn-construct-observer'));

    const observed: LifecyclePhaseObservation[] = [];
    const submission = dispatcher.submit(plan, new Plana(), {
      lifecycleObserver: (obs) => {
        observed.push(obs);
      },
    });
    await submission.completion;

    const phases = observed.map((o) => o.phase);
    expect(phases[0]).toBe('accepted');
    expect(phases).toContain('terminal');
    for (const obs of observed) {
      expect(obs.taskId).toBe('task-cn-construct-observer');
    }
  });

  it('rejects re-submission of the same taskId (single-use invariant)', async () => {
    const node = new InProcessComputeNode({
      runtime: new AgentRuntime(successfulRuntimeDriver()),
    });
    const dispatcher = new Dispatcher(node);
    const plan = createDispatchPlan(createTaskRequest('task-cn-construct-dup'));

    const first = dispatcher.submit(plan, new Plana());
    await first.completion;

    expect(() => dispatcher.submit(plan, new Plana())).toThrow(
      DuplicateSubmissionError,
    );
    expect(dispatcher.submissionCount).toBe(1);
  });
});
