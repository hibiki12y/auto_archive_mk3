import { describe, expect, it } from 'vitest';

import { createDispatchPlan } from '../src/core/task.js';
import type {
  RuntimeEventInput,
} from '../src/contracts/runtime-event.js';
import type { RuntimeExecutionContext } from '../src/contracts/runtime-driver.js';
import {
  ClaudeAgentRuntimeDriver,
  type ClaudeAgentQueryArgs,
  type ClaudeAgentQueryFactory,
  type ClaudeAgentSDKMessage,
  type ClaudeAgentSettingsProvider,
} from '../src/runtime/claude-agent-runtime-adapter.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

function trivialContext(): RuntimeExecutionContext {
  const plan = createDispatchPlan(createTaskRequest('task-hot-swap'));
  const emitted: RuntimeEventInput[] = [];
  return {
    plan,
    instance: {
      taskId: plan.taskId,
      instanceId: 'agent-task-hot-swap',
      createdAt: '2026-05-07T00:00:00.000Z',
      runtimeSettings: plan.runtimeSettings,
    },
    emit: async (event) => {
      emitted.push(event);
    },
    requestApproval: async () => ({ status: 'approved' }),
    isAborted: () => false,
  };
}

function syntheticHandle(): AsyncIterable<ClaudeAgentSDKMessage> {
  const messages: ClaudeAgentSDKMessage[] = [
    { type: 'system', subtype: 'init', session_id: 'sess' },
    {
      type: 'result',
      subtype: 'success',
      result: 'ok',
    },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message;
      }
    },
  };
}

describe('claude-agent driver hot-swap (multi-provider-scope.md §1.3.0)', () => {
  it('reads settings from the provider on every run() and overlays onto query options', async () => {
    const observed: ClaudeAgentQueryArgs[] = [];
    const factory: ClaudeAgentQueryFactory = (args) => {
      observed.push(args);
      return syntheticHandle();
    };
    let model: string | undefined = 'claude-opus-4-7';
    const provider: ClaudeAgentSettingsProvider = {
      readSettings: () => (model === undefined ? {} : { model }),
    };
    const driver = new ClaudeAgentRuntimeDriver({
      queryFactory: factory,
      model: 'claude-opus-4-6',
      settingsProvider: provider,
    });

    await driver.run(trivialContext());
    model = 'claude-haiku-4-5';
    await driver.run(trivialContext());
    model = undefined;
    await driver.run(trivialContext());

    expect(observed.length).toBe(3);
    expect(observed[0]?.options.model).toBe('claude-opus-4-7');
    expect(observed[1]?.options.model).toBe('claude-haiku-4-5');
    // When the provider returns no override, the bootstrap default kicks in.
    expect(observed[2]?.options.model).toBe('claude-opus-4-6');
  });

  it('falls back to bootstrap settings when the provider throws', async () => {
    const observed: ClaudeAgentQueryArgs[] = [];
    const factory: ClaudeAgentQueryFactory = (args) => {
      observed.push(args);
      return syntheticHandle();
    };
    const provider: ClaudeAgentSettingsProvider = {
      readSettings: () => {
        throw new Error('provider broken');
      },
    };
    const driver = new ClaudeAgentRuntimeDriver({
      queryFactory: factory,
      model: 'claude-opus-4-6',
      settingsProvider: provider,
    });

    const result = await driver.run(trivialContext());

    expect(result.cause.kind).toBe('success');
    expect(observed[0]?.options.model).toBe('claude-opus-4-6');
  });

  it('also overlays effort and maxTurns when the provider supplies them', async () => {
    const observed: ClaudeAgentQueryArgs[] = [];
    const factory: ClaudeAgentQueryFactory = (args) => {
      observed.push(args);
      return syntheticHandle();
    };
    const provider: ClaudeAgentSettingsProvider = {
      readSettings: () => ({ effort: 'high', maxTurns: 9 }),
    };
    const driver = new ClaudeAgentRuntimeDriver({
      queryFactory: factory,
      effort: 'low',
      maxTurns: 2,
      settingsProvider: provider,
    });

    await driver.run(trivialContext());

    expect(observed[0]?.options.effort).toBe('high');
    expect(observed[0]?.options.maxTurns).toBe(9);
  });
});
