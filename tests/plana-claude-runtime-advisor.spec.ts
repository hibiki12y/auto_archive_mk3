import { describe, expect, it } from 'vitest';

import {
  PlanaClaudeRuntimeAdvisor,
  PLANA_CLAUDE_ADVISOR_PROVENANCE,
} from '../src/core/plana-claude-runtime-advisor.js';
import { createDispatchPlan } from '../src/core/task.js';
import type {
  ClaudeAgentQueryFactory,
  ClaudeAgentSDKMessage,
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
      } as ClaudeAgentSDKMessage;
      yield {
        type: 'result',
        subtype: 'success',
        result: text,
      } as ClaudeAgentSDKMessage;
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
          } as ClaudeAgentSDKMessage;
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
});
