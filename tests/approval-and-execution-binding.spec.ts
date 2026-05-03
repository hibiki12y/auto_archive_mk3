import { describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  InMemoryExecutionApprovalStore,
  InMemoryRuntimeApprovalRegistry,
  Plana,
  createRegistryBackedApprovalHook,
  type ExecutionApprovalRecord,
  type RuntimeDriver,
  type RuntimeDriverResult,
} from '../src/index.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

async function waitForPending(registry: InMemoryRuntimeApprovalRegistry) {
  for (let i = 0; i < 50; i += 1) {
    const pending = registry.snapshot().pending[0];
    if (pending !== undefined) return pending;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('pending approval was not registered');
}

describe('OC-1B runtime approval registry and execution binding', () => {
  it('resolves a pending runtime approval through the registry-backed Plana hook', async () => {
    const registry = new InMemoryRuntimeApprovalRegistry();
    const taskId = 'task-approval-live';
    let observedDecision = 'unset';
    const driver: RuntimeDriver = {
      async run(context): Promise<RuntimeDriverResult> {
        const approval = context.requestApproval({
          request: {
            kind: 'command_execution',
            reason: 'run approval-gated command',
            command: 'echo approved',
            workingDirectory: '/workspace',
          },
          deadline: new Date(Date.now() + 5_000).toISOString(),
        });
        const pending = await waitForPending(registry);
        expect(pending.taskId).toBe(taskId);
        registry.resolve({
          approvalId: pending.approvalId,
          decision: 'approved',
          provenance: 'discord-slash',
          resolvedByUserId: 'operator-1',
        });
        const decision = await approval;
        observedDecision = decision.status;
        return {
          reason: 'approval path complete',
          provenance: 'approval-test',
          cause: {
            kind: 'success',
            taskId,
            runtimeInstanceId: context.instance.instanceId,
            observedAt: new Date().toISOString(),
            provenance: 'approval-test',
          },
        };
      },
    };

    const result = await new Arona(
      new Plana({ approval: createRegistryBackedApprovalHook(registry) }),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
    ).requestDispatch(createTaskRequest(taskId));
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    await expect(result.submission.completion).resolves.toMatchObject({ taskId });
    expect(observedDecision).toBe('approved');
    expect(registry.snapshot().resolved[0]).toMatchObject({ status: 'approved' });
  });

  it('preserves unknown, duplicate, and late/expired approval semantics', () => {
    const registry = new InMemoryRuntimeApprovalRegistry();
    expect(
      registry.resolve({ approvalId: 'missing', decision: 'approved', provenance: 'discord-slash' }),
    ).toMatchObject({ status: 'unknown' });
    registry.register({
      approvalId: 'approval-1',
      taskId: 'task',
      runtimeInstanceId: 'runtime',
      turnSequence: 1,
      commandKind: 'shell',
      canonicalCwd: '/workspace',
      envDigest: 'env',
      requestedAt: '2026-04-27T00:00:00.000Z',
      expiresAt: '2099-04-27T00:10:00.000Z',
      reason: 'test',
    });
    expect(
      registry.resolve({ approvalId: 'approval-1', decision: 'denied', provenance: 'discord-slash' }),
    ).toMatchObject({ status: 'resolved' });
    expect(
      registry.resolve({ approvalId: 'approval-1', decision: 'approved', provenance: 'discord-slash' }),
    ).toMatchObject({ status: 'duplicate' });
    registry.register({
      approvalId: 'approval-2',
      taskId: 'task',
      runtimeInstanceId: 'runtime',
      turnSequence: 1,
      commandKind: 'shell',
      canonicalCwd: '/workspace',
      envDigest: 'env',
      requestedAt: '2026-04-27T00:00:00.000Z',
      expiresAt: '2026-04-27T00:00:01.000Z',
      reason: 'test',
    });
    expect(registry.expire(new Date('2026-04-27T00:00:02.000Z'))).toHaveLength(1);
    expect(
      registry.resolve({ approvalId: 'approval-2', decision: 'approved', provenance: 'discord-slash' }),
    ).toMatchObject({ status: 'expired' });
  });

  it('denies execution approval replay, drift, expiry, and allow-always', () => {
    const store = new InMemoryExecutionApprovalStore();
    const base: ExecutionApprovalRecord = {
      approvalId: 'exec-approval-1',
      taskId: 'task',
      runtimeInstanceId: 'runtime',
      turnSequence: 1,
      commandKind: 'shell',
      rawCommandDigest: 'cmd',
      canonicalCwd: '/workspace',
      envDigest: 'env',
      requestedAt: '2026-04-27T00:00:00.000Z',
      expiresAt: '2099-04-27T01:00:00.000Z',
      status: 'approved',
      decisionProvenance: 'discord-slash',
    };
    store.create(base);
    expect(
      store.consume({
        approvalId: 'exec-approval-1',
        taskId: 'task',
        runtimeInstanceId: 'runtime',
        commandKind: 'shell',
        rawCommandDigest: 'cmd',
        canonicalCwd: '/workspace',
        envDigest: 'env',
        now: '2026-04-27T00:01:00.000Z',
      }),
    ).toMatchObject({ status: 'allowed' });
    expect(
      store.consume({
        approvalId: 'exec-approval-1',
        taskId: 'task',
        runtimeInstanceId: 'runtime',
        commandKind: 'shell',
        rawCommandDigest: 'cmd',
        canonicalCwd: '/workspace',
        envDigest: 'env',
      }),
    ).toMatchObject({ status: 'denied', reason: 'approval already consumed' });
    store.create({ ...base, approvalId: 'exec-approval-2' });
    expect(
      store.consume({
        approvalId: 'exec-approval-2',
        taskId: 'task',
        runtimeInstanceId: 'runtime',
        commandKind: 'shell',
        rawCommandDigest: 'different',
        canonicalCwd: '/workspace',
        envDigest: 'env',
        now: '2026-04-27T00:01:00.000Z',
      }),
    ).toMatchObject({ status: 'denied', reason: 'raw command digest drift' });
    store.create({ ...base, approvalId: 'exec-approval-3', expiresAt: '2026-04-27T00:00:01.000Z' });
    expect(
      store.consume({
        approvalId: 'exec-approval-3',
        taskId: 'task',
        runtimeInstanceId: 'runtime',
        commandKind: 'shell',
        rawCommandDigest: 'cmd',
        canonicalCwd: '/workspace',
        envDigest: 'env',
        now: '2026-04-27T00:00:02.000Z',
      }),
    ).toMatchObject({ status: 'denied', reason: 'approval expired' });
    expect(
      store.consume({
        approvalId: 'exec-approval-2',
        taskId: 'task',
        runtimeInstanceId: 'runtime',
        commandKind: 'shell',
        canonicalCwd: '/workspace',
        envDigest: 'env',
        requestedPersistence: 'allow-always',
      }),
    ).toMatchObject({ status: 'unsupported' });
  });
});
