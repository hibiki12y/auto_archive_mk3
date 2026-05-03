import { describe, expect, it } from 'vitest';

import { createDispatchPlan } from '../src/core/task.js';
import type {
  RuntimeApprovalRequest,
  RuntimeEventInput,
} from '../src/contracts/runtime-event.js';
import type {
  RuntimeDriverResult,
  RuntimeExecutionContext,
} from '../src/contracts/runtime-driver.js';
import {
  CLAUDE_AGENT_PROVIDER_LABEL,
  ClaudeAgentRuntimeDriver,
  classifyClaudeAgentMessage,
  type ClaudeAgentQueryFactory,
  type ClaudeAgentSDKMessage,
} from '../src/runtime/claude-agent-runtime-adapter.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

interface RecordedApproval {
  request: RuntimeApprovalRequest;
}

function createContextHarness(overrides: {
  approvalDecision?: 'approved' | { status: 'rejected'; reason: string };
  isAborted?: () => boolean;
} = {}): {
  context: RuntimeExecutionContext;
  emitted: RuntimeEventInput[];
  approvals: RecordedApproval[];
} {
  const plan = createDispatchPlan(createTaskRequest('task-claude-agent-driver'));
  const emitted: RuntimeEventInput[] = [];
  const approvals: RecordedApproval[] = [];
  const context: RuntimeExecutionContext = {
    plan,
    instance: {
      taskId: plan.taskId,
      instanceId: 'agent-task-claude-agent-driver',
      createdAt: '2026-04-30T00:00:00.000Z',
      runtimeSettings: plan.runtimeSettings,
    },
    emit: async (event) => {
      emitted.push(event);
    },
    requestApproval: async ({ request }) => {
      approvals.push({ request });
      const decision = overrides.approvalDecision ?? 'approved';
      if (decision === 'approved') {
        return { status: 'approved' };
      }
      return { status: 'rejected', reason: decision.reason };
    },
    isAborted: overrides.isAborted ?? (() => false),
  };
  return { context, emitted, approvals };
}

function syntheticHandle(
  messages: ClaudeAgentSDKMessage[],
): AsyncIterable<ClaudeAgentSDKMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message;
      }
    },
  };
}

describe('claude-agent runtime driver', () => {
  it('maps a successful result message to a TerminalCauseSuccess', async () => {
    const factory: ClaudeAgentQueryFactory = () =>
      syntheticHandle([
        { type: 'system', subtype: 'init', session_id: 'sess-1' },
        {
          type: 'assistant',
          uuid: 'msg-1',
          message: {
            content: [{ type: 'text', text: 'task complete' }],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          result: 'final summary',
          total_cost_usd: 0.1,
        },
      ]);
    const driver = new ClaudeAgentRuntimeDriver({ queryFactory: factory });
    const { context, emitted } = createContextHarness();

    const result: RuntimeDriverResult = await driver.run(context);

    expect(result.cause.kind).toBe('success');
    expect(result.provenance).toBe('claude-agent-runtime-driver');
    expect(result.reason).toBe('final summary');
    const turnStarted = emitted.find((e) => e.kind === 'turn.started');
    expect(turnStarted).toBeDefined();
    const itemCompleted = emitted.find((e) => e.kind === 'item.completed');
    expect(itemCompleted).toBeDefined();
  });

  it('maps a non-success result message to a provider-failure cause with anthropic provider label', async () => {
    const factory: ClaudeAgentQueryFactory = () =>
      syntheticHandle([
        { type: 'system', subtype: 'init', session_id: 'sess-2' },
        {
          type: 'result',
          subtype: 'error_max_turns',
          error: { message: 'rate limit exceeded' },
        },
      ]);
    const driver = new ClaudeAgentRuntimeDriver({ queryFactory: factory });
    const { context } = createContextHarness();

    const result = await driver.run(context);

    expect(result.cause.kind).toBe('provider-failure');
    if (result.cause.kind === 'provider-failure') {
      expect(result.cause.provider).toBe(CLAUDE_AGENT_PROVIDER_LABEL);
      expect(result.cause.classification).toBe('rate-limit');
      expect(result.cause.retryable).toBe(true);
    }
  });

  it('bridges plana approval through canUseTool and translates rejections to deny', async () => {
    let observedDecision:
      | { behavior: 'allow' }
      | { behavior: 'deny'; message: string }
      | undefined;
    const factory: ClaudeAgentQueryFactory = (args) => {
      const canUseTool = args.options.canUseTool;
      return {
        async *[Symbol.asyncIterator]() {
          if (canUseTool) {
            observedDecision = await canUseTool(
              'shell.run',
              { command: 'echo hello' },
              {
                toolUseID: 'tool-1',
                signal: new AbortController().signal,
              },
            );
          }
          yield {
            type: 'result',
            subtype: 'success',
            result: 'done',
          } as ClaudeAgentSDKMessage;
        },
      };
    };
    const driver = new ClaudeAgentRuntimeDriver({ queryFactory: factory });
    const { context, approvals } = createContextHarness({
      approvalDecision: { status: 'rejected', reason: 'blocked by plana' },
    });

    const result = await driver.run(context);

    expect(result.cause.kind).toBe('success');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.request.kind).toBe('mcp_tool_call');
    expect(observedDecision).toBeDefined();
    expect(observedDecision?.behavior).toBe('deny');
  });

  it('returns a provider-failure result when the stream ends without a result message', async () => {
    const factory: ClaudeAgentQueryFactory = () =>
      syntheticHandle([
        { type: 'system', subtype: 'init', session_id: 'sess-3' },
      ]);
    const driver = new ClaudeAgentRuntimeDriver({ queryFactory: factory });
    const { context } = createContextHarness();

    await expect(driver.run(context)).rejects.toThrow(/result message/i);
  });

  it('classifies anthropic error messages into the shared 4-axis vocabulary', () => {
    expect(classifyClaudeAgentMessage('429 too many requests').classification).toBe(
      'rate-limit',
    );
    expect(classifyClaudeAgentMessage('quota exceeded').classification).toBe(
      'quota-exhausted',
    );
    expect(classifyClaudeAgentMessage('401 unauthorized').classification).toBe(
      'permanent-auth',
    );
    expect(classifyClaudeAgentMessage('500 internal server error').classification).toBe(
      'transient-server',
    );
    expect(classifyClaudeAgentMessage('econnreset during stream').classification).toBe(
      'transient-network',
    );
    expect(classifyClaudeAgentMessage('something weird').classification).toBe(
      'unknown',
    );
  });
});
