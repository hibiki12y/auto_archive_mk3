import { describe, expect, it, vi } from 'vitest';

import {
  PLANA_CODEX_ADVISOR_PROVENANCE,
  PlanaCodexRuntimeAdvisor,
  type PlanaCodexAdvisorAuditLedger,
  type PlanaCodexAdvisorAuditRecord,
} from '../src/core/plana-codex-runtime-advisor.js';
import type { PlanaAdvisorInput } from '../src/core/plana-runtime-advisor.js';
import { createDispatchPlan } from '../src/core/task.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

function input(): PlanaAdvisorInput {
  const plan = createDispatchPlan(createTaskRequest('task-codex-advisor'));
  return {
    plan,
    instance: {
      taskId: plan.taskId,
      instanceId: 'instance-codex-advisor',
      createdAt: '2026-05-07T00:00:00.000Z',
      runtimeSettings: plan.runtimeSettings,
    },
    event: {
      kind: 'item.completed',
      timestamp: '2026-05-07T00:00:00.000Z',
      instanceId: 'instance-codex-advisor',
      item: {
        type: 'agent_message',
        summary: 'agent reply text',
      },
    } as unknown as PlanaAdvisorInput['event'],
  };
}

function skipEvent(): PlanaAdvisorInput {
  const plan = createDispatchPlan(createTaskRequest('task-codex-advisor-skip'));
  return {
    plan,
    instance: {
      taskId: plan.taskId,
      instanceId: 'instance-codex-advisor-skip',
      createdAt: '2026-05-07T00:00:00.000Z',
      runtimeSettings: plan.runtimeSettings,
    },
    event: {
      kind: 'turn.started',
      timestamp: '2026-05-07T00:00:00.000Z',
      instanceId: 'instance-codex-advisor-skip',
    } as unknown as PlanaAdvisorInput['event'],
  };
}

function buildSdkStub(responseText: string) {
  async function* generateEvents(): AsyncGenerator<unknown, void, unknown> {
    yield {
      type: 'item.completed',
      item: { type: 'agent_message', text: responseText },
    };
    yield { type: 'turn.completed' };
  }
  const runStreamed = vi.fn().mockResolvedValue({ events: generateEvents() });
  const startThread = vi.fn().mockReturnValue({ id: 'thread-1', runStreamed });
  return { sdkFactory: () => ({ startThread }), startThread, runStreamed };
}

function buildThrowingSdk() {
  const startThread = vi.fn().mockImplementation(() => {
    throw new Error('codex-sdk-down');
  });
  return { sdkFactory: () => ({ startThread }), startThread };
}

describe('PlanaCodexRuntimeAdvisor', () => {
  it('returns approve on a non-veto response', async () => {
    const stub = buildSdkStub('{"verdict":"approve"}');
    const advisor = new PlanaCodexRuntimeAdvisor({
      sdkFactory: stub.sdkFactory,
      maxAdvisorCallsPerInstance: 5,
    });
    const verdict = await advisor.review(input());
    expect(verdict.status).toBe('approve');
    expect(stub.startThread).toHaveBeenCalledTimes(1);
    expect(stub.runStreamed).toHaveBeenCalledTimes(1);
  });

  it('returns veto with codex provenance on a veto response', async () => {
    const stub = buildSdkStub('{"verdict":"veto","reason":"unsafe rm -rf"}');
    const advisor = new PlanaCodexRuntimeAdvisor({
      sdkFactory: stub.sdkFactory,
    });
    const verdict = await advisor.review(input());
    expect(verdict.status).toBe('veto');
    if (verdict.status === 'veto') {
      expect(verdict.provenance).toBe(PLANA_CODEX_ADVISOR_PROVENANCE);
      expect(verdict.reason).toContain('unsafe rm -rf');
    }
  });

  it('skips events that are not in the consult set without calling the SDK', async () => {
    const stub = buildSdkStub('ignored');
    const advisor = new PlanaCodexRuntimeAdvisor({
      sdkFactory: stub.sdkFactory,
    });
    const verdict = await advisor.review(skipEvent());
    expect(verdict.status).toBe('skip');
    expect(stub.startThread).not.toHaveBeenCalled();
  });

  it('fails open with approve when the SDK throws', async () => {
    const stub = buildThrowingSdk();
    const advisor = new PlanaCodexRuntimeAdvisor({
      sdkFactory: stub.sdkFactory,
    });
    const verdict = await advisor.review(input());
    expect(verdict.status).toBe('approve');
  });

  it('throttles past the per-instance call cap', async () => {
    const stub = buildSdkStub('{"verdict":"approve"}');
    const advisor = new PlanaCodexRuntimeAdvisor({
      sdkFactory: stub.sdkFactory,
      maxAdvisorCallsPerInstance: 2,
    });
    expect((await advisor.review(input())).status).toBe('approve');
    expect((await advisor.review(input())).status).toBe('approve');
    expect((await advisor.review(input())).status).toBe('skip');
    expect(stub.startThread).toHaveBeenCalledTimes(2);
  });

  it('writes redacted audit records when an audit ledger is provided', async () => {
    const stub = buildSdkStub('{"verdict":"approve"}');
    const records: PlanaCodexAdvisorAuditRecord[] = [];
    const ledger: PlanaCodexAdvisorAuditLedger = {
      append(record) {
        records.push(record);
      },
    };
    const advisor = new PlanaCodexRuntimeAdvisor({
      sdkFactory: stub.sdkFactory,
      auditLedger: ledger,
      auditClock: () => '2026-05-07T01:02:03.000Z',
      model: 'gpt-5.5',
      modelReasoningEffort: 'low',
    });
    await advisor.review(input());
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.provider).toBe('codex');
    expect(record.provenance).toBe(PLANA_CODEX_ADVISOR_PROVENANCE);
    expect(record.verdictStatus).toBe('approve');
    expect(record.consultationOutcome).toBe('consulted');
    expect(record.model).toBe('gpt-5.5');
    expect(record.modelReasoningEffort).toBe('low');
    expect(record.recordedAt).toBe('2026-05-07T01:02:03.000Z');
  });

  it('records advisor-error-fail-open in the audit ledger when the SDK throws', async () => {
    const stub = buildThrowingSdk();
    const records: PlanaCodexAdvisorAuditRecord[] = [];
    const advisor = new PlanaCodexRuntimeAdvisor({
      sdkFactory: stub.sdkFactory,
      auditLedger: {
        append(record) {
          records.push(record);
        },
      },
    });
    await advisor.review(input());
    expect(records).toHaveLength(1);
    expect(records[0].consultationOutcome).toBe('advisor-error-fail-open');
    expect(records[0].verdictStatus).toBe('approve');
  });
});
