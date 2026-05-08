import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildPlanaClaudeAdvisorAuditReport,
  JsonlPlanaClaudeAdvisorAuditLedger,
  type PlanaClaudeAdvisorAuditRecord,
  PlanaClaudeRuntimeAdvisor,
  PLANA_CLAUDE_ADVISOR_AUDIT_SCHEMA_VERSION,
  PLANA_CLAUDE_ADVISOR_PROVENANCE,
} from '../src/core/plana-claude-runtime-advisor.js';
import { createDispatchPlan } from '../src/core/task.js';
import type {
  ClaudeAgentQueryFactory,
} from '../src/runtime/claude-agent-runtime-adapter.js';
import type { AgentInstance } from '../src/contracts/runtime-driver.js';
import type {
  ItemCompletedEvent,
  ToolInvocationEvent,
} from '../src/contracts/runtime-event.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

function buildItemCompleted(
  itemType: ItemCompletedEvent['item']['type'],
  summary: string,
): ItemCompletedEvent {
  return {
    kind: 'item.completed',
    timestamp: '2026-04-30T00:00:00.000Z',
    instanceId: 'agent-1',
    turnSequence: 1,
    item: {
      id: 'item-1',
      type: itemType,
      summary,
    },
    provenance: {
      producer: 'codex-runtime-driver',
      sdkEventType: 'item.completed',
      threadId: null,
    },
  };
}

function buildToolInvocation(): ToolInvocationEvent {
  return {
    kind: 'tool-invocation',
    timestamp: '2026-04-30T00:00:00.000Z',
    instanceId: 'agent-1',
    toolName: 'shell.run',
    detail: 'echo hello',
  };
}

function makeFactoryReturning(text: string): ClaudeAgentQueryFactory {
  return () => ({
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text }],
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: text,
      };
    },
  });
}

const PLAN = createDispatchPlan(createTaskRequest('task-advisor'));
const INSTANCE: AgentInstance = {
  taskId: PLAN.taskId,
  instanceId: 'agent-task-advisor',
  createdAt: '2026-04-30T00:00:00.000Z',
  runtimeSettings: PLAN.runtimeSettings,
};

function advisorAuditRecord(
  overrides: Partial<PlanaClaudeAdvisorAuditRecord> = {},
): PlanaClaudeAdvisorAuditRecord {
  return {
    schemaVersion: PLANA_CLAUDE_ADVISOR_AUDIT_SCHEMA_VERSION,
    recordId: 'advisor-audit-record-1',
    recordedAt: '2026-05-05T10:00:00.000Z',
    provider: 'claude-agent',
    provenance: PLANA_CLAUDE_ADVISOR_PROVENANCE,
    taskId: PLAN.taskId,
    instanceId: INSTANCE.instanceId,
    eventKind: 'item.completed',
    eventTimestamp: '2026-05-05T09:59:59.000Z',
    eventItemType: 'agent_message',
    verdictStatus: 'approve',
    consultationOutcome: 'consulted',
    ...overrides,
  };
}

describe('PlanaClaudeRuntimeAdvisor', () => {
  it('skips events outside the sampling window without calling the SDK', async () => {
    let invoked = false;
    const factory: ClaudeAgentQueryFactory = () => {
      invoked = true;
      return {
        async *[Symbol.asyncIterator]() {
          /* no yields */
        },
      };
    };
    const advisor = new PlanaClaudeRuntimeAdvisor({ queryFactory: factory });
    const verdict = await advisor.review({
      plan: PLAN,
      instance: INSTANCE,
      event: buildToolInvocation(),
    });
    expect(verdict.status).toBe('skip');
    expect(invoked).toBe(false);
  });

  it('returns approve when the model replies with verdict=approve', async () => {
    const advisor = new PlanaClaudeRuntimeAdvisor({
      queryFactory: makeFactoryReturning('{"verdict":"approve"}'),
    });
    const verdict = await advisor.review({
      plan: PLAN,
      instance: INSTANCE,
      event: buildItemCompleted('agent_message', 'all good'),
    });
    expect(verdict.status).toBe('approve');
  });

  it('returns veto with provenance when the model replies with verdict=veto', async () => {
    const advisor = new PlanaClaudeRuntimeAdvisor({
      queryFactory: makeFactoryReturning(
        '{"verdict":"veto","reason":"hallucinated repository path"}',
      ),
    });
    const verdict = await advisor.review({
      plan: PLAN,
      instance: INSTANCE,
      event: buildItemCompleted('error', 'hallucinated facts visible'),
    });
    expect(verdict.status).toBe('veto');
    if (verdict.status === 'veto') {
      expect(verdict.reason).toContain('hallucinated');
      expect(verdict.provenance).toBe(PLANA_CLAUDE_ADVISOR_PROVENANCE);
    }
  });

  it('fails open (approve) when the SDK throws', async () => {
    const advisor = new PlanaClaudeRuntimeAdvisor({
      queryFactory: () => ({
        // eslint-disable-next-line require-yield -- intentional throwing-only generator simulating SDK error
        async *[Symbol.asyncIterator]() {
          throw new Error('claude unreachable');
        },
      }),
    });
    const verdict = await advisor.review({
      plan: PLAN,
      instance: INSTANCE,
      event: buildItemCompleted('error', 'something failed'),
    });
    expect(verdict.status).toBe('approve');
  });

  it('fails closed (veto) when failClosedOnCatch returns true on the catch path', async () => {
    const records: PlanaClaudeAdvisorAuditRecord[] = [];
    const advisor = new PlanaClaudeRuntimeAdvisor({
      queryFactory: () => ({
        // eslint-disable-next-line require-yield -- intentional throwing-only generator simulating SDK error
        async *[Symbol.asyncIterator]() {
          throw new Error('claude unreachable for high-risk event');
        },
      }),
      failClosedOnCatch: (input) =>
        input.event.kind === 'item.completed' &&
        (input.event).item.type === 'error',
      auditLedger: {
        append(record) {
          records.push(record);
        },
      },
    });
    const verdict = await advisor.review({
      plan: PLAN,
      instance: INSTANCE,
      event: buildItemCompleted('error', 'high-risk event'),
    });
    expect(verdict.status).toBe('veto');
    if (verdict.status === 'veto') {
      expect(verdict.reason).toBe(
        'Advisor failed; risk tier required fail-closed',
      );
      expect(verdict.provenance).toBe(PLANA_CLAUDE_ADVISOR_PROVENANCE);
    }
    expect(records).toHaveLength(1);
    expect(records[0].consultationOutcome).toBe('advisor-error-fail-closed');
    expect(records[0].verdictStatus).toBe('veto');
  });

  it('preserves fail-open behavior when failClosedOnCatch returns false', async () => {
    const records: PlanaClaudeAdvisorAuditRecord[] = [];
    let predicateInvocations = 0;
    const advisor = new PlanaClaudeRuntimeAdvisor({
      queryFactory: () => ({
        // eslint-disable-next-line require-yield -- intentional throwing-only generator simulating SDK error
        async *[Symbol.asyncIterator]() {
          throw new Error('claude unreachable');
        },
      }),
      failClosedOnCatch: () => {
        predicateInvocations += 1;
        return false;
      },
      auditLedger: {
        append(record) {
          records.push(record);
        },
      },
    });
    const verdict = await advisor.review({
      plan: PLAN,
      instance: INSTANCE,
      event: buildItemCompleted('agent_message', 'low-risk event'),
    });
    expect(verdict.status).toBe('approve');
    expect(predicateInvocations).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0].consultationOutcome).toBe('advisor-error-fail-open');
    expect(records[0].verdictStatus).toBe('approve');
  });

  it('fails open when the response cannot be parsed as JSON', async () => {
    const advisor = new PlanaClaudeRuntimeAdvisor({
      queryFactory: makeFactoryReturning('this is not JSON at all'),
    });
    const verdict = await advisor.review({
      plan: PLAN,
      instance: INSTANCE,
      event: buildItemCompleted('agent_message', 'plain text'),
    });
    expect(verdict.status).toBe('approve');
  });

  it('throttles to the per-instance call cap and returns skip beyond it', async () => {
    let invocations = 0;
    const factory: ClaudeAgentQueryFactory = () => {
      invocations += 1;
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'result',
            subtype: 'success',
            result: '{"verdict":"approve"}',
          };
        },
      };
    };
    const advisor = new PlanaClaudeRuntimeAdvisor({
      queryFactory: factory,
      maxAdvisorCallsPerInstance: 2,
    });
    const event = buildItemCompleted('agent_message', 'snippet');
    const v1 = await advisor.review({ plan: PLAN, instance: INSTANCE, event });
    const v2 = await advisor.review({ plan: PLAN, instance: INSTANCE, event });
    const v3 = await advisor.review({ plan: PLAN, instance: INSTANCE, event });
    expect(v1.status).toBe('approve');
    expect(v2.status).toBe('approve');
    expect(v3.status).toBe('skip');
    expect(invocations).toBe(2);
  });

  it('records audit lines through the onAdvise hook', async () => {
    const records: Array<{ verdict: string; eventKind: string }> = [];
    const advisor = new PlanaClaudeRuntimeAdvisor({
      queryFactory: makeFactoryReturning(
        '{"verdict":"veto","reason":"abc"}',
      ),
      onAdvise: (record) => {
        records.push({
          verdict: record.verdict.status,
          eventKind: record.eventKind,
        });
      },
    });
    await advisor.review({
      plan: PLAN,
      instance: INSTANCE,
      event: buildItemCompleted('error', 'bad'),
    });
    expect(records).toEqual([{ verdict: 'veto', eventKind: 'item.completed' }]);
  });

  it('writes redacted JSONL advisor audit records without prompt or response text', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'plana-advisor-audit-'));
    try {
      const filePath = join(workspace, 'advisor-events.jsonl');
      const auditLedger = new JsonlPlanaClaudeAdvisorAuditLedger(filePath);
      const advisor = new PlanaClaudeRuntimeAdvisor({
        queryFactory: makeFactoryReturning(
          '{"verdict":"veto","reason":"MODEL SECRET SHOULD NOT BE COPIED"}',
        ),
        model: 'claude-opus-4-7',
        fallbackModel: 'claude-sonnet-4-5',
        auditClock: () => '2026-05-05T10:00:00.000Z',
        auditLedger,
      });

      const verdict = await advisor.review({
        plan: PLAN,
        instance: INSTANCE,
        event: buildItemCompleted(
          'error',
          'PROMPT SECRET SHOULD NOT BE COPIED',
        ),
      });

      expect(verdict.status).toBe('veto');
      const rawJsonl = readFileSync(filePath, 'utf8');
      expect(rawJsonl).not.toContain('PROMPT SECRET SHOULD NOT BE COPIED');
      expect(rawJsonl).not.toContain('MODEL SECRET SHOULD NOT BE COPIED');
      expect(auditLedger.loadAll()).toHaveLength(1);
      expect(auditLedger.loadAll()[0]).toMatchObject({
        schemaVersion: 1,
        recordedAt: '2026-05-05T10:00:00.000Z',
        provider: 'claude-agent',
        provenance: PLANA_CLAUDE_ADVISOR_PROVENANCE,
        taskId: PLAN.taskId,
        instanceId: INSTANCE.instanceId,
        eventKind: 'item.completed',
        eventItemType: 'error',
        verdictStatus: 'veto',
        consultationOutcome: 'consulted',
        model: 'claude-opus-4-7',
        fallbackModel: 'claude-sonnet-4-5',
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('replays advisor audit JSONL with malformed-line counters and a bounded byte guard', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'plana-advisor-audit-replay-'));
    try {
      const filePath = join(workspace, 'advisor-events.jsonl');
      const ledger = new JsonlPlanaClaudeAdvisorAuditLedger(filePath);
      const validRecord = advisorAuditRecord({
        recordId: 'advisor-audit-valid-1',
        verdictStatus: 'veto',
      });
      writeFileSync(
        filePath,
        `${JSON.stringify(validRecord)}\n{"schemaVersion":1,"recordId":"malformed-shape"}\nnot-json\n\n`,
        'utf8',
      );

      const replay = ledger.loadWithAudit({ maxBytes: 10_000 });

      expect(ledger.loadAll()).toEqual([validRecord]);
      expect(replay.records).toEqual([validRecord]);
      expect(replay.replayAudit).toMatchObject({
        source: 'jsonl',
        totalLineCount: 4,
        emptyLineCount: 1,
        parsedRecordCount: 1,
        skippedMalformedLineCount: 2,
      });
      expect(() => ledger.loadWithAudit({ maxBytes: 1 })).toThrow(
        /exceeds maxBytes/,
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('builds an advisor audit report that surfaces veto and fail-open breadcrumbs', () => {
    const report = buildPlanaClaudeAdvisorAuditReport({
      records: [
        advisorAuditRecord({
          recordId: 'advisor-audit-report-approve',
          recordedAt: '2026-05-05T10:00:00.000Z',
          verdictStatus: 'approve',
        }),
        advisorAuditRecord({
          recordId: 'advisor-audit-report-veto',
          recordedAt: '2026-05-05T10:01:00.000Z',
          verdictStatus: 'veto',
        }),
        advisorAuditRecord({
          recordId: 'advisor-audit-report-fail-open',
          recordedAt: '2026-05-05T10:02:00.000Z',
          consultationOutcome: 'advisor-error-fail-open',
        }),
      ],
      replayAudit: {
        source: 'jsonl',
        totalLineCount: 4,
        emptyLineCount: 0,
        parsedRecordCount: 3,
        skippedMalformedLineCount: 1,
      },
    });

    expect(report.scorecard.recordCount).toBe(3);
    expect(report.scorecard.verdictCounts).toEqual({
      approve: 2,
      veto: 1,
      skip: 0,
    });
    expect(report.scorecard.consultationCounts).toEqual({
      consulted: 2,
      advisorErrorFailOpen: 1,
      advisorErrorFailClosed: 0,
    });
    expect(report.scorecard.confidence.sufficientForTrend).toBe(false);
    expect(report.scorecard.recency.lastRecordedAt).toBe(
      '2026-05-05T10:02:00.000Z',
    );
    expect(report.scorecard.recommendations[0]).toContain(
      'malformed/torn advisor JSONL line',
    );
    expect(report.scorecard.recommendations.join('\n')).toContain(
      'advisor-error-fail-open',
    );
    expect(report.scorecard.recommendations.join('\n')).toContain(
      'advisor veto breadcrumb',
    );
  });

  it('contains advisor audit sink failures so verdicts remain fail-open', async () => {
    const advisor = new PlanaClaudeRuntimeAdvisor({
      queryFactory: makeFactoryReturning('{"verdict":"approve"}'),
      auditLedger: {
        append() {
          throw new Error('audit sink unavailable');
        },
      },
    });

    const verdict = await advisor.review({
      plan: PLAN,
      instance: INSTANCE,
      event: buildItemCompleted('agent_message', 'safe output'),
    });

    expect(verdict.status).toBe('approve');
  });

  it('replays redacted advisor audit JSONL with audit counters and a read-only report', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'plana-advisor-audit-report-'));
    try {
      const filePath = join(workspace, 'advisor-events.jsonl');
      writeFileSync(
        filePath,
        [
          JSON.stringify(advisorAuditRecord({ recordId: 'advisor-audit-record-1' })),
          '',
          '{"schemaVersion":1,"recordId":"malformed-shape"}',
          JSON.stringify(
            advisorAuditRecord({
              recordId: 'advisor-audit-record-2',
              recordedAt: '2026-05-05T10:01:00.000Z',
              verdictStatus: 'veto',
              consultationOutcome: 'advisor-error-fail-open',
              eventKind: 'item.failed',
              eventItemType: 'error',
            }),
          ),
          '',
        ].join('\n'),
        'utf8',
      );

      const replay = new JsonlPlanaClaudeAdvisorAuditLedger(
        filePath,
      ).loadWithAudit({ maxBytes: 10000 });
      expect(replay.replayAudit).toEqual({
        source: 'jsonl',
        totalLineCount: 4,
        emptyLineCount: 1,
        parsedRecordCount: 2,
        skippedMalformedLineCount: 1,
      });

      const report = buildPlanaClaudeAdvisorAuditReport({
        records: replay.records,
        replayAudit: replay.replayAudit,
        generatedAt: '2026-05-05T10:02:00.000Z',
      });

      expect(report.generatedAt).toBe('2026-05-05T10:02:00.000Z');
      expect(report.scorecard.recordCount).toBe(2);
      expect(report.scorecard.verdictCounts).toEqual({
        approve: 1,
        veto: 1,
        skip: 0,
      });
      expect(report.scorecard.consultationCounts).toEqual({
        consulted: 1,
        advisorErrorFailOpen: 1,
        advisorErrorFailClosed: 0,
      });
      expect(report.scorecard.eventKindCounts).toEqual({
        'item.completed': 1,
        'item.failed': 1,
      });
      expect(report.scorecard.recency.lastRecordedAt).toBe(
        '2026-05-05T10:01:00.000Z',
      );
      expect(report.scorecard.recommendations[0]).toBe(
        'Review 1 malformed/torn advisor JSONL line(s); they were excluded from scoring.',
      );
      expect(report.method.promotionRule).toContain('operator-facing diagnostic');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails closed before accepting advisor audit replay bytes beyond the guard', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'plana-advisor-audit-guard-'));
    try {
      const filePath = join(workspace, 'advisor-events.jsonl');
      writeFileSync(
        filePath,
        `${JSON.stringify(advisorAuditRecord())}\n`,
        'utf8',
      );

      expect(() =>
        new JsonlPlanaClaudeAdvisorAuditLedger(filePath).loadWithAudit({
          maxBytes: 1,
        }),
      ).toThrow('Plana Claude advisor audit ledger exceeds maxBytes');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
