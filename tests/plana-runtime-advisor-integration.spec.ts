import { describe, expect, it } from 'vitest';

import { Plana } from '../src/core/plana.js';
import { createDispatchPlan } from '../src/core/task.js';
import { createRuntimeEvent, createRuntimeEventStream } from '../src/index.js';
import type {
  PlanaAdvisorInput,
  PlanaAdvisorVerdict,
  PlanaRuntimeAdvisor,
} from '../src/core/plana-runtime-advisor.js';
import type {
  RuntimeCancellationBoundary,
  RuntimeTerminalCause,
} from '../src/contracts/runtime-driver.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

function createBoundary(taskId: string): {
  boundary: RuntimeCancellationBoundary;
  vetoes: RuntimeTerminalCause[];
} {
  const vetoes: RuntimeTerminalCause[] = [];
  const boundary: RuntimeCancellationBoundary = {
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
      return vetoes[vetoes.length - 1]!;
    },
  };
  return { boundary, vetoes };
}

class StubAdvisor implements PlanaRuntimeAdvisor {
  public readonly seen: PlanaAdvisorInput[] = [];

  constructor(
    private readonly verdictForKind: (
      kind: string,
    ) => PlanaAdvisorVerdict,
  ) {}

  async review(input: PlanaAdvisorInput): Promise<PlanaAdvisorVerdict> {
    this.seen.push(input);
    return this.verdictForKind(input.event.kind);
  }
}

describe('Plana runtime advisor integration', () => {
  it('lifts a veto verdict from the advisor into a runtime VetoPath', async () => {
    const advisor = new StubAdvisor((kind) =>
      kind === 'item.completed'
        ? {
            status: 'veto',
            reason: 'advisor flagged terminal output',
            provenance: 'plana-claude-runtime-advisor',
          }
        : { status: 'skip' },
    );
    const plana = new Plana({ runtimeAdvisor: advisor });
    const plan = createDispatchPlan(createTaskRequest('task-advisor-int'));
    const stream = createRuntimeEventStream();
    const { boundary, vetoes } = createBoundary(plan.taskId);

    const consumer = plana.consumeRuntimeStream(stream, {
      plan,
      instance: {
        taskId: plan.taskId,
        instanceId: 'agent-advisor-int',
        createdAt: new Date().toISOString(),
        runtimeSettings: plan.runtimeSettings,
      },
      cancellationBoundary: boundary,
      approvalResponsePort: { async respond() {} },
    });

    await stream.push(
      createRuntimeEvent({
        kind: 'item.completed',
        timestamp: '2026-04-30T00:00:00.000Z',
        instanceId: 'agent-advisor-int',
        turnSequence: 1,
        item: {
          id: 'item-1',
          type: 'agent_message',
          summary: 'final answer with possible hallucination',
        },
        provenance: {
          producer: 'codex-runtime-driver',
          sdkEventType: 'item.completed',
          threadId: null,
        },
      }),
    );
    await stream.close();
    const report = await consumer;

    expect(report.vetoesEmitted).toBeGreaterThanOrEqual(1);
    expect(vetoes.length).toBeGreaterThanOrEqual(1);
    expect(vetoes[0]?.kind).toBe('runtime-veto');
    expect(vetoes[0]?.provenance).toBe('plana-claude-runtime-advisor');
    expect(vetoes.every((v) => v.provenance === 'plana-claude-runtime-advisor')).toBe(true);
  });

  it('skips advisor when an existing rule-based veto already fires', async () => {
    const advisor = new StubAdvisor(() => ({
      status: 'veto',
      reason: 'advisor would have vetoed',
      provenance: 'plana-claude-runtime-advisor',
    }));
    const plana = new Plana({
      runtime: () => ({
        origin: 'runtime',
        reason: 'rule-based veto fires first',
        provenance: 'rule-based-test',
        propagation: {
          blocksSubmission: false,
          requestsCancellation: true,
          requestsTermination: true,
        },
      }),
      runtimeAdvisor: advisor,
    });
    const plan = createDispatchPlan(
      createTaskRequest('task-advisor-precedence'),
    );
    const stream = createRuntimeEventStream();
    const { boundary, vetoes } = createBoundary(plan.taskId);
    const consumer = plana.consumeRuntimeStream(stream, {
      plan,
      instance: {
        taskId: plan.taskId,
        instanceId: 'agent-advisor-precedence',
        createdAt: new Date().toISOString(),
        runtimeSettings: plan.runtimeSettings,
      },
      cancellationBoundary: boundary,
      approvalResponsePort: { async respond() {} },
    });

    await stream.push(
      createRuntimeEvent({
        kind: 'item.completed',
        timestamp: '2026-04-30T00:00:00.000Z',
        instanceId: 'agent-advisor-precedence',
        turnSequence: 1,
        item: {
          id: 'item-1',
          type: 'agent_message',
          summary: 'output',
        },
        provenance: {
          producer: 'codex-runtime-driver',
          sdkEventType: 'item.completed',
          threadId: null,
        },
      }),
    );
    await stream.close();
    await consumer;

    expect(advisor.seen).toHaveLength(0);
    expect(vetoes.length).toBeGreaterThanOrEqual(1);
    expect(vetoes.every((v) => v.provenance === 'rule-based-test')).toBe(true);
  });

  it('ignores skip verdicts and lets dispatch continue', async () => {
    const advisor = new StubAdvisor(() => ({ status: 'skip' }));
    const plana = new Plana({ runtimeAdvisor: advisor });
    const plan = createDispatchPlan(createTaskRequest('task-advisor-skip'));
    const stream = createRuntimeEventStream();
    const { boundary, vetoes } = createBoundary(plan.taskId);
    const consumer = plana.consumeRuntimeStream(stream, {
      plan,
      instance: {
        taskId: plan.taskId,
        instanceId: 'agent-advisor-skip',
        createdAt: new Date().toISOString(),
        runtimeSettings: plan.runtimeSettings,
      },
      cancellationBoundary: boundary,
      approvalResponsePort: { async respond() {} },
    });

    await stream.push(
      createRuntimeEvent({
        kind: 'item.completed',
        timestamp: '2026-04-30T00:00:00.000Z',
        instanceId: 'agent-advisor-skip',
        turnSequence: 1,
        item: {
          id: 'item-1',
          type: 'agent_message',
          summary: 'skipped',
        },
        provenance: {
          producer: 'codex-runtime-driver',
          sdkEventType: 'item.completed',
          threadId: null,
        },
      }),
    );
    await stream.close();
    const report = await consumer;

    expect(report.vetoesEmitted).toBe(0);
    expect(vetoes).toHaveLength(0);
  });
});
