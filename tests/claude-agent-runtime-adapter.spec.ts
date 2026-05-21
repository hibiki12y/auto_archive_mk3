import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

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
  buildClaudeCodePrintCommand,
  classifyClaudeAgentMessage,
  createClaudeCodePrintQueryFactory,
  parseClaudeCodePrintJsonLine,
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
          };
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

describe('Claude Code print-mode query factory', () => {
  it('builds a Claude Code -p stream-json command with safe advisor defaults', () => {
    const command = buildClaudeCodePrintCommand(
      {
        prompt: 'review this event',
        options: {
          pathToClaudeCodeExecutable: '/opt/bin/claude',
          model: 'sonnet',
          fallbackModel: 'opus',
          effort: 'max',
          maxTurns: 1,
          maxBudgetUsd: 0.25,
          permissionMode: 'bypassPermissions',
          includePartialMessages: false,
          cwd: '/repo',
          env: { ANTHROPIC_API_KEY: 'test-key' },
        },
      },
      { bareMode: 'auto', toolPolicy: 'disable-all' },
    );

    expect(command.command).toBe('/opt/bin/claude');
    expect(command.cwd).toBe('/repo');
    expect(command.stdinText).toBe('review this event');
    expect(command.args).toEqual([
      '--bare',
      '--model',
      'sonnet',
      '--fallback-model',
      'opus',
      '--effort',
      'max',
      '-p',
      expect.any(String),
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '1',
      '--max-budget-usd',
      '0.25',
      '--permission-mode',
      'bypassPermissions',
      '--tools',
      '',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--strict-mcp-config',
      '--no-session-persistence',
    ]);
    expect(command.args).not.toContain('review this event');
  });

  it('does not add --bare in auto mode for local Claude Code OAuth CLI calls', () => {
    const command = buildClaudeCodePrintCommand(
      {
        prompt: 'local dev prompt',
        options: {
          pathToClaudeCodeExecutable: 'claude',
          env: {
            ANTHROPIC_API_KEY: undefined,
            ANTHROPIC_AUTH_TOKEN: undefined,
            CLAUDE_CODE_OAUTH_TOKEN: undefined,
          },
        },
      },
      { bareMode: 'auto' },
    );
    expect(command.args).not.toContain('--bare');
    expect(command.args.slice(0, 5)).toEqual([
      '-p',
      expect.any(String),
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(command.stdinText).toBe('local dev prompt');
    expect(command.args).not.toContain('local dev prompt');
  });

  it('parses newline-delimited Claude Code print-mode JSON events', () => {
    expect(parseClaudeCodePrintJsonLine('')).toBeUndefined();
    expect(
      parseClaudeCodePrintJsonLine(
        '{"type":"result","subtype":"success","result":"ok"}',
      ),
    ).toMatchObject({ type: 'result', result: 'ok' });
    expect(() => parseClaudeCodePrintJsonLine('not-json')).toThrow(
      /print-mode JSON line/,
    );
    expect(() => parseClaudeCodePrintJsonLine('{"subtype":"success"}')).toThrow(
      /missing type/,
    );
    expect(() =>
      buildClaudeCodePrintCommand({
        prompt: 'x',
        options: { extraArgs: { allowedTools: 'Bash' } },
      }),
    ).toThrow(/protected flag --allowedTools/);
  });

  it('spawns the configured command and yields parsed stream-json messages', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const spawnProcess = vi.fn((..._args: unknown[]) => child);
    const factory = createClaudeCodePrintQueryFactory({
      bareMode: 'never',
      spawnProcess: spawnProcess as never,
    });
    const handle = factory({
      prompt: 'hello',
      options: {
        pathToClaudeCodeExecutable: 'claude-test',
        permissionMode: 'bypassPermissions',
      },
    });

    const collectedPromise = (async () => {
      const out: ClaudeAgentSDKMessage[] = [];
      for await (const message of handle) {
        out.push(message);
      }
      return out;
    })();

    child.stdout.write('{"type":"system","subtype":"init","session_id"');
    child.stdout.write(':"s1"}\n\n');
    child.stdout.write('{"type":"result","subtype":"success","result":"ok"}');
    child.stdout.end();
    child.emit('close', 0, null);

    await expect(collectedPromise).resolves.toEqual([
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'result', subtype: 'success', result: 'ok' },
    ]);
    expect(spawnProcess).toHaveBeenCalledWith(
      'claude-test',
      [
        '-p',
        expect.any(String),
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'bypassPermissions',
        '--tools',
        '',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--strict-mcp-config',
        '--no-session-persistence',
      ],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    const spawnedArgs = spawnProcess.mock.calls[0]?.[1] as
      | readonly string[]
      | undefined;
    expect(spawnedArgs).not.toContain('hello');
  });
});
