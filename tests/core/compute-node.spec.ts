import { synthesizeDriverCause, UNUSED_IDENTITY } from '../helpers/wu-v-cause.js';
import { describe, expect, it } from 'vitest';
import { deriveOutcomeFromCause } from '../../src/core/derive-outcome.js';

import {
  AgentRuntime,
  Plana,
  createDispatchPlan,
  type RuntimeCancellationBoundary,
  type RuntimeDriver,
  type RuntimeDriverResult,
} from '../../src/index.js';
import { createTaskRequest } from '../helpers/dispatcher-core.js';

import {
  isComputeNode,
  type ComputeNode,
} from '../../src/core/compute-node.js';
import { SlurmApptainerComputeNode } from '../../src/core/compute-node-slurm-apptainer.js';
import {
  InProcessComputeNode,
  LocalComputeNode,
  type LocalComputeExecutor,
} from '../../src/core/__test__/compute-node-test-doubles.js';

/**
 * WU-P Stage A port-conformance contract.
 *
 * Per the spec (§3.3 / §7), test doubles must satisfy the same surface as
 * the production composing impl so test code can later be portable to
 * production wiring unchanged. This file uses `describe.each` to apply
 * the same checks against every test double.
 *
 * NOTE: A full conformance harness lives downstream in WU-I; this file is
 * intentionally narrower and just locks in the Stage A surface.
 */

function noopCancellationBoundary(): RuntimeCancellationBoundary {
  return {
    cancel: () => ({
      taskId: 'noop',
      reason: 'noop',
      provenance: 'test',
      requestedAt: new Date().toISOString(),
    }),
  };
}

function stubDriver(): RuntimeDriver {
  return {
    async run(): Promise<RuntimeDriverResult> {
      return {
        reason: 'stub driver completed',
        provenance: 'compute-node-spec-stub',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'stub driver completed', provenance: 'compute-node-spec-stub' }),
      };
    },
  };
}

function buildInProcess(): InProcessComputeNode {
  return new InProcessComputeNode({
    runtime: new AgentRuntime(stubDriver()),
  });
}

function buildLocal(executor?: LocalComputeExecutor): LocalComputeNode {
  return new LocalComputeNode({
    executor:
      executor ??
      (async (allocation, plan, _plana, _cancellationBoundary, observer) => {
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
        reason: 'local executor completed',
        provenance: 'compute-node-spec-local',
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
          provenance: 'compute-node-spec-local',
        },
      };
      }),
  });
}

describe('SlurmApptainerComputeNode (production skeleton)', () => {
  it('exposes a readable static capability surface before allocate() is called', () => {
    const node = new SlurmApptainerComputeNode();
    expect(isComputeNode(node)).toBe(true);
    expect(node.capabilities.kind).toBe('slurm-apptainer');
    expect(node.capabilities.execution).toMatchObject({
      hasNetwork: false,
      hasFilesystemWrite: false,
      rootless: true,
    });
    expect(node.capabilities.capabilityFlags ?? []).toHaveLength(0);
  });

  it('allocate() rejects with a SubprocessRunner-required configuration error when no runner is injected', async () => {
    // WU-I Stage 2 (35177d1) implemented the production body. Without an
    // injected SubprocessRunner the node has no way to invoke `salloc`, so
    // allocate() must surface a clear configuration error rather than the
    // historical Stage A NotImplemented sentinel.
    const node = new SlurmApptainerComputeNode();
    const plan = createDispatchPlan(createTaskRequest('skeleton-task'));
    await expect(node.allocate(plan)).rejects.toThrow(/SubprocessRunner/i);
  });
});

interface DoubleFactory {
  readonly label: string;
  build(): ComputeNode;
}

const factories: DoubleFactory[] = [
  { label: 'InProcessComputeNode', build: () => buildInProcess() },
  { label: 'LocalComputeNode', build: () => buildLocal() },
];

describe.each(factories)('ComputeNode port contract — $label', ({ build }) => {
  it('passes structural isComputeNode guard', () => {
    expect(isComputeNode(build())).toBe(true);
  });

  it('exposes a test-double capability surface readable before allocate()', () => {
    const node = build();
    expect(node.capabilities.kind).toBe('test-double');
    expect(node.capabilities.execution.rootless).toBe(true);
    expect(node.capabilities.capabilityFlags ?? []).toHaveLength(0);
  });

  it('allocate() returns a stable handle whose capability matches the node surface', async () => {
    const node = build();
    const plan = createDispatchPlan(createTaskRequest('contract-allocate'));
    const allocation = await node.allocate(plan);
    expect(typeof allocation.allocationId).toBe('string');
    expect(allocation.allocationId.length).toBeGreaterThan(0);
    expect(allocation.capability.kind).toBe(node.capabilities.kind);
  });

  it('allocate() returns distinct ids for distinct calls', async () => {
    const node = build();
    const plan = createDispatchPlan(createTaskRequest('contract-distinct'));
    const a = await node.allocate(plan);
    const b = await node.allocate(plan);
    expect(a.allocationId).not.toBe(b.allocationId);
  });

  it('dispatch() returns terminal evidence carrying the plan taskId', async () => {
    const node = build();
    const plan = createDispatchPlan(createTaskRequest('contract-dispatch'));
    const allocation = await node.allocate(plan);
    const evidence = await node.dispatch(
      allocation,
      plan,
      new Plana(),
      noopCancellationBoundary(),
    );
    expect(evidence.taskId).toBe(plan.taskId);
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
  });

  it('observe() fans observations out alongside the dispatch-supplied observer', async () => {
    const node = build();
    const plan = createDispatchPlan(createTaskRequest('contract-observe'));
    const allocation = await node.allocate(plan);

    const direct: string[] = [];
    const attached: string[] = [];
    node.observe(allocation, (observation) => {
      attached.push(observation.phase);
    });

    await node.dispatch(
      allocation,
      plan,
      new Plana(),
      noopCancellationBoundary(),
      (observation) => {
        direct.push(observation.phase);
      },
    );

    // Attached observer must have received at least the same phases as
    // the direct observer (advisory fan-out per WU-N pending semantics).
    expect(attached.length).toBeGreaterThan(0);
    expect(attached).toEqual(direct);
  });

  it('cancel() resolves cooperatively for known and unknown allocations', async () => {
    const node = build();
    const plan = createDispatchPlan(createTaskRequest('contract-cancel'));
    const allocation = await node.allocate(plan);
    await expect(node.cancel(allocation, 'test cleanup')).resolves.toBeUndefined();
    // Cancelling a fictional allocation must not throw — cooperative semantics.
    await expect(
      node.cancel(
        { allocationId: 'never-allocated', capability: node.capabilities },
        'unknown allocation',
      ),
    ).resolves.toBeUndefined();
  });
});

describe('LocalComputeNode test-introspection helpers', () => {
  it('records cancelled allocation ids', async () => {
    const node = buildLocal();
    const plan = createDispatchPlan(createTaskRequest('local-cancel'));
    const allocation = await node.allocate(plan);
    expect(node.wasCancelled(allocation)).toBe(false);
    await node.cancel(allocation, 'shutdown');
    expect(node.wasCancelled(allocation)).toBe(true);
  });
});
