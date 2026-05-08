import { describe, expect, it } from 'vitest';

import {
  Plana,
  createDispatchPlan,
  createRuntimeEvent,
  createRuntimeEventStream,
  type RuntimeEventStream,
  type RuntimeMidCycleObserver,
} from '../src/index.js';
import type {
  RuntimeCancellationBoundary,
  RuntimeTerminalCause,
} from '../src/contracts/runtime-driver.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

function createBoundary(taskId: string): RuntimeCancellationBoundary {
  const vetoes: RuntimeTerminalCause[] = [];
  return {
    cancel(veto) {
      const receipt = {
        taskId,
        reason: veto.reason,
        provenance: veto.provenance,
        requestedAt: new Date().toISOString(),
      };
      vetoes.push({
        kind: 'runtime-veto',
        taskId,
        reason: veto.reason,
        provenance: veto.provenance,
        requestedAt: receipt.requestedAt,
        veto,
        cancellation: receipt,
      });
      return receipt;
    },
    latchRuntimeVeto(veto) {
      vetoes.push({
        kind: 'runtime-veto',
        taskId,
        reason: veto.reason,
        provenance: veto.provenance,
        requestedAt: new Date().toISOString(),
        veto,
      });
      return vetoes[vetoes.length - 1];
    },
  };
}

function runtimeEvent() {
  return createRuntimeEvent({
    kind: 'turn.started',
    instanceId: 'instance-mid-cycle',
    timestamp: '2026-05-05T00:00:00.000Z',
    turnSequence: 1,
    provenance: {
      producer: 'codex-runtime-driver',
      sdkEventType: 'turn.started',
      threadId: 'thread-mid-cycle',
    },
  });
}

describe('RuntimeMidCycleObserver contract', () => {
  it('fans out in registration order, contains observer throws, and releases task state', async () => {
    const calls: string[] = [];
    const observerA: RuntimeMidCycleObserver = {
      id: 'throws-first',
      observe(observation) {
        calls.push(`observe:throws-first:${observation.taskId}`);
        throw new Error('observer A failed');
      },
      release(taskId) {
        calls.push(`release:throws-first:${taskId}`);
      },
    };
    const observerB: RuntimeMidCycleObserver = {
      id: 'records-second',
      observe(observation) {
        calls.push(
          `observe:records-second:${observation.taskId}:${observation.event.kind}`,
        );
      },
      release(taskId) {
        calls.push(`release:records-second:${taskId}`);
      },
    };
    const plana = new Plana({
      midCycleObservers: [observerA, observerB],
    });
    const plan = createDispatchPlan(createTaskRequest('task-mid-cycle-1'));
    const stream = createRuntimeEventStream();
    const consumer = plana.consumeRuntimeStream(stream, {
      plan,
      instance: {
        taskId: plan.taskId,
        instanceId: 'instance-mid-cycle',
        createdAt: '2026-05-05T00:00:00.000Z',
        runtimeSettings: plan.runtimeSettings,
      },
      cancellationBoundary: createBoundary(plan.taskId),
      approvalResponsePort: {
        async respond() {},
      },
    });

    await stream.push(runtimeEvent());
    stream.close();
    const report = await consumer;

    expect(report.terminalCause).toBe('stream-closed');
    expect(calls).toEqual([
      'observe:throws-first:task-mid-cycle-1',
      'observe:records-second:task-mid-cycle-1:turn.started',
      'release:throws-first:task-mid-cycle-1',
      'release:records-second:task-mid-cycle-1',
    ]);
  });

  it('releases task state when stream iteration throws after an observed event', async () => {
    const calls: string[] = [];
    const plana = new Plana({
      midCycleObservers: [
        {
          id: 'records-release-on-error',
          observe(observation) {
            calls.push(`observe:${observation.taskId}:${observation.event.kind}`);
          },
          release(taskId) {
            calls.push(`release:${taskId}`);
          },
        },
      ],
    });
    const plan = createDispatchPlan(createTaskRequest('task-mid-cycle-throws'));
    const event = runtimeEvent();
    const stream: RuntimeEventStream = {
      get closed() {
        return false;
      },
      async push() {},
      close() {},
      onTeardown() {},
      events: {
        async *[Symbol.asyncIterator]() {
          yield event;
          throw new Error('stream read failed');
        },
      },
    };

    const report = await plana.consumeRuntimeStream(stream, {
      plan,
      instance: {
        taskId: plan.taskId,
        instanceId: 'instance-mid-cycle',
        createdAt: '2026-05-05T00:00:00.000Z',
        runtimeSettings: plan.runtimeSettings,
      },
      cancellationBoundary: createBoundary(plan.taskId),
      approvalResponsePort: {
        async respond() {},
      },
    });

    expect(report.terminalCause).toBe('consumer-threw');
    expect(calls).toEqual([
      'observe:task-mid-cycle-throws:turn.started',
      'release:task-mid-cycle-throws',
    ]);
  });
});
