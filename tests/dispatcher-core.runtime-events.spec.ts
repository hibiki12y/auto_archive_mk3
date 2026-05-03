import { withSynthesizedCause, synthesizeDriverCause, UNUSED_IDENTITY } from './helpers/wu-v-cause.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveOutcomeFromCause } from '../src/core/derive-outcome.js';

const codexMockState = vi.hoisted(() => ({
  constructorArgs: [] as unknown[],
  startThreadMock: vi.fn(),
  runStreamedMock: vi.fn(),
}));

vi.mock('@openai/codex-sdk', () => {
  class Codex {
    constructor(options?: unknown) {
      codexMockState.constructorArgs.push(options);
    }

    startThread(options?: unknown): {
      readonly id: string;
      runStreamed: typeof codexMockState.runStreamedMock;
    } {
      codexMockState.startThreadMock(options);
      return {
        id: 'thread-runtime-events-spec',
        runStreamed: codexMockState.runStreamedMock,
      };
    }
  }

  return { Codex };
});

import {
  AGENT_RUNTIME_TERMINAL_TRANSCRIPT_EVENT_LIMIT,
  AgentRuntime,
  Arona,
  Dispatcher,
  Plana,
  createRuntimeEvent,
  type RuntimeDriver,
  type RuntimeDriverResult,
} from '../src/index.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';

function streamEvents(events: unknown[]) {
  return (async function* (): AsyncGenerator<unknown> {
    for (const event of events) {
      yield event;
    }
  })();
}

beforeEach(() => {
  codexMockState.constructorArgs.length = 0;
  codexMockState.startThreadMock.mockReset();
  codexMockState.runStreamedMock.mockReset();
  codexMockState.runStreamedMock.mockResolvedValue({
    events: streamEvents([
      {
        type: 'item.completed',
        item: {
          id: 'command-1',
          type: 'command_execution',
          command: 'echo hello',
          aggregated_output: 'hello',
          exit_code: 0,
          status: 'completed',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'agent-message-1',
          type: 'agent_message',
          text: 'codex runtime final response',
        },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 8,
          cached_input_tokens: 0,
          output_tokens: 6,
        },
      },
    ]),
  });
});

describe('dispatcher core runtime event and fail-closed behavior', () => {
  it('runtime review receives canonical typed runtime events', async () => {
    const events: Array<{ kind: string; marker: string; instanceId: string }> = [];
    const plana = new Plana({
      runtime: ({ event }) => {
        if (event.kind === 'runtime-initialized') {
          events.push({
            kind: event.kind,
            marker: event.message,
            instanceId: event.instanceId,
          });
        } else if (event.kind === 'agent-step') {
          events.push({
            kind: event.kind,
            marker: event.step,
            instanceId: event.instanceId,
          });
        } else if (event.kind === 'tool-invocation') {
          events.push({
            kind: event.kind,
            marker: event.toolName,
            instanceId: event.instanceId,
          });
        } else {
          events.push({
            kind: event.kind,
            marker: event.kind,
            instanceId: event.instanceId,
          });
        }

        return undefined;
      },
    });

    const result = await new Arona(plana, new Dispatcher(new InProcessComputeNode())).requestDispatch(
      createTaskRequest('task-runtime-events'),
    );

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      await expect(result.submission.completion).resolves.toMatchObject({
        provenance: 'codex-runtime-driver',
        reason: 'codex runtime final response',
        transcript: {
          droppedCount: 0,
          events: expect.arrayContaining([
            expect.objectContaining({
              kind: 'runtime-initialized',
              message: 'agent instance created',
            }),
            expect.objectContaining({
              kind: 'item.completed',
              item: expect.objectContaining({
                type: 'command_execution',
              }),
            }),
            expect.objectContaining({
              kind: 'item.completed',
              item: expect.objectContaining({
                type: 'agent_message',
                summary: 'codex runtime final response',
              }),
            }),
            expect.objectContaining({
              kind: 'turn.completed',
            }),
          ]),
        },
      });
    }
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      kind: 'runtime-initialized',
      marker: 'agent instance created',
    });
    expect(events[1]).toMatchObject({
      kind: 'item.completed',
      marker: 'item.completed',
    });
    expect(events[2]).toMatchObject({
      kind: 'item.completed',
      marker: 'item.completed',
    });
    expect(events[3]).toMatchObject({
      kind: 'turn.completed',
      marker: 'turn.completed',
    });
    expect(events[0].instanceId).toMatch(/^agent-task-runtime-events-/);
    expect(events[1].instanceId).toBe(events[0].instanceId);
    expect(events[2].instanceId).toBe(events[0].instanceId);
  });

  it('attaches a bounded canonical transcript to terminal evidence', async () => {
    const runtimeDriver: RuntimeDriver = {
      async run(context) {
        for (let index = 0; index < AGENT_RUNTIME_TERMINAL_TRANSCRIPT_EVENT_LIMIT + 2; index += 1) {
          await context.emit({
            kind: 'agent-step',
            step: `progress-${index}`,
            detail: `detail-${index}`,
          });
        }

        return withSynthesizedCause(context, {
          outcome: 'success',
          reason: 'bounded transcript captured',
          provenance: 'test-driver',
        });
      },
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-bounded-transcript'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      expect(evidence.transcript).toBeDefined();
      expect(evidence.transcript?.events).toHaveLength(
        AGENT_RUNTIME_TERMINAL_TRANSCRIPT_EVENT_LIMIT,
      );
      expect(evidence.transcript?.droppedCount).toBe(3);
      expect(evidence.transcript?.events[0]).toMatchObject({
        kind: 'agent-step',
        step: 'progress-2',
        detail: 'detail-2',
      });
      expect(
        evidence.transcript?.events[
          AGENT_RUNTIME_TERMINAL_TRANSCRIPT_EVENT_LIMIT - 1
        ],
      ).toMatchObject({
        kind: 'agent-step',
        step: `progress-${AGENT_RUNTIME_TERMINAL_TRANSCRIPT_EVENT_LIMIT + 1}`,
        detail: `detail-${AGENT_RUNTIME_TERMINAL_TRANSCRIPT_EVENT_LIMIT + 1}`,
      });
    }
  });

  it('createRuntimeEvent enforces canonical runtime event shape at runtime', () => {
    expect(
      createRuntimeEvent({
        kind: 'agent-step',
        step: 'runtime-progress',
        detail: 'runtime progress observed',
        instanceId: 'test-instance-id',
        timestamp: '2025-01-01T00:00:00.000Z',
        observedSummary: {
          cpuCoresPeak: 2,
          memoryMiBPeak: 512,
          notes: 'steady state',
          extra: 'ignored',
        },
        extra: 'ignored',
      } as unknown as Parameters<typeof createRuntimeEvent>[0]),
    ).toEqual({
      kind: 'agent-step',
      step: 'runtime-progress',
      detail: 'runtime progress observed',
      instanceId: 'test-instance-id',
      timestamp: '2025-01-01T00:00:00.000Z',
      observedSummary: {
        cpuCoresPeak: 2,
        memoryMiBPeak: 512,
        notes: 'steady state',
      },
    });

    expect(
      () =>
        createRuntimeEvent({
          kind: 'tool-invocation',
          detail: 'missing tool name',
          instanceId: 'test-instance-id',
        } as unknown as Parameters<typeof createRuntimeEvent>[0]),
    ).toThrowError('Runtime event field "toolName" must be a string.');

    expect(
      () =>
        createRuntimeEvent({
          kind: 'agent-step',
          step: 'runtime-progress',
          instanceId: 'test-instance-id',
          observedSummary: {
            memoryMiBPeak: '512',
          },
        } as unknown as Parameters<typeof createRuntimeEvent>[0]),
    ).toThrowError(
      'Runtime event field "observedSummary.memoryMiBPeak" must be a finite number.',
    );

    // missing instanceId throws
    expect(
      () =>
        createRuntimeEvent({
          kind: 'agent-step',
          step: 'runtime-progress',
        } as unknown as Parameters<typeof createRuntimeEvent>[0]),
    ).toThrowError('Runtime event field "instanceId" must be a string.');

    // empty instanceId throws
    expect(
      () =>
        createRuntimeEvent({
          kind: 'agent-step',
          step: 'runtime-progress',
          instanceId: '',
        } as unknown as Parameters<typeof createRuntimeEvent>[0]),
    ).toThrowError('Runtime event field "instanceId" must be a non-empty string.');

    // whitespace-only instanceId throws
    expect(
      () =>
        createRuntimeEvent({
          kind: 'agent-step',
          step: 'runtime-progress',
          instanceId: '   ',
        } as unknown as Parameters<typeof createRuntimeEvent>[0]),
    ).toThrowError('Runtime event field "instanceId" must be a non-empty string.');

    // invalid settingsReviewedAt (non-string) throws on runtime-initialized
    expect(
      () =>
        createRuntimeEvent({
          kind: 'runtime-initialized',
          message: 'agent instance created',
          instanceId: 'test-instance-id',
          settingsReviewedAt: 12345,
        } as unknown as Parameters<typeof createRuntimeEvent>[0]),
    ).toThrowError('Runtime event field "settingsReviewedAt" must be a string.');

    // invalid settingsReviewedAt (malformed) throws on runtime-initialized
    expect(
      () =>
        createRuntimeEvent({
          kind: 'runtime-initialized',
          message: 'agent instance created',
          instanceId: 'test-instance-id',
          settingsReviewedAt: 'not-a-date',
        } as unknown as Parameters<typeof createRuntimeEvent>[0]),
    ).toThrowError(
      'Runtime event field "settingsReviewedAt" must be a valid ISO 8601 string.',
    );
  });

  it('runtime-initialized event carries settingsReviewedAt when settings review hook is configured', async () => {
    const captured: Array<{
      kind: string;
      instanceId: string;
      settingsReviewedAt?: string;
    }> = [];
    const plana = new Plana({
      runtimeSettings: () => undefined,
      runtime: ({ event }) => {
        captured.push({
          kind: event.kind,
          instanceId: event.instanceId,
          settingsReviewedAt:
            event.kind === 'runtime-initialized'
              ? event.settingsReviewedAt
              : undefined,
        });
        return undefined;
      },
    });

    const result = await new Arona(plana, new Dispatcher(new InProcessComputeNode())).requestDispatch(
      createTaskRequest('task-runtime-settings-reviewed'),
    );

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      const initialized = captured.find((e) => e.kind === 'runtime-initialized');
      expect(initialized).toBeDefined();
      expect(initialized!.settingsReviewedAt).toBeDefined();
      expect(initialized!.settingsReviewedAt).toBe(
        evidence.executionContext.settingsReview?.reviewedAt,
      );
    }
  });

  it('runtime-initialized event omits settingsReviewedAt when no settings hook is configured', async () => {
    const captured: Array<{ kind: string; settingsReviewedAt?: string }> = [];
    const plana = new Plana({
      runtime: ({ event }) => {
        if (event.kind === 'runtime-initialized') {
          captured.push({
            kind: event.kind,
            settingsReviewedAt: event.settingsReviewedAt,
          });
        }
        return undefined;
      },
    });

    const result = await new Arona(plana, new Dispatcher(new InProcessComputeNode())).requestDispatch(
      createTaskRequest('task-runtime-no-settings-hook'),
    );

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      await result.submission.completion;
    }
    expect(captured).toHaveLength(1);
    expect(captured[0].settingsReviewedAt).toBeUndefined();
  });

  it('instanceId from emit closure cannot be overridden by driver input', async () => {
    let observedInstanceId: string | undefined;
    const plana = new Plana({
      runtime: ({ event, instance }) => {
        if (event.kind === 'tool-invocation') {
          observedInstanceId = event.instanceId;
          expect(event.instanceId).toBe(instance.instanceId);
        }
        return undefined;
      },
    });

    const runtimeDriver: RuntimeDriver = {
      async run(context) {
        await context.emit({
          kind: 'tool-invocation',
          toolName: 'test-tool',
          detail: 'driver attempting override',
          instanceId: 'driver-supplied-bogus-id',
        } as unknown as Parameters<typeof context.emit>[0]);
        return withSynthesizedCause(context, {
          outcome: 'success',
          reason: 'completed',
          provenance: 'test-driver',
        });
      },
    };

    const result = await new Arona(
      plana,
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-instance-id-override'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      await result.submission.completion;
    }
    expect(observedInstanceId).toBeDefined();
    expect(observedInstanceId).not.toBe('driver-supplied-bogus-id');
    expect(observedInstanceId).toMatch(/^agent-task-instance-id-override-/);
  });

  it('runtime driver result observed summary is canonicalized before terminal evidence', async () => {
    const runtimeDriver: RuntimeDriver = {
      async run() {
        return {
          outcome: 'success',
          reason: 'driver completed with observed summary',
          provenance: 'test-driver',
          cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'driver completed with observed summary', provenance: 'test-driver' }),
          observedSummary: {
            cpuCoresPeak: 2,
            memoryMiBPeak: 512,
            notes: 'steady state',
            extra: 'discarded-before-terminal-evidence',
          } as unknown as RuntimeDriverResult['observedSummary'],
        };
      },
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-runtime-driver-observed-summary'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
      expect(evidence.reason).toBe('driver completed with observed summary');
      expect(evidence.provenance).toBe('test-driver');
      expect(evidence.observedSummary).toEqual({
        cpuCoresPeak: 2,
        memoryMiBPeak: 512,
        notes: 'steady state',
      });
    }
  });

  it('runtime driver result observed summary is validated before terminal evidence', async () => {
    const runtimeDriver: RuntimeDriver = {
      async run() {
        return {
          outcome: 'success',
          reason: 'driver returned invalid observed summary',
          provenance: 'test-driver',
          cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'driver returned invalid observed summary', provenance: 'test-driver' }),
          observedSummary: {
            memoryMiBPeak: '512',
          } as unknown as RuntimeDriverResult['observedSummary'],
        };
      },
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(
      createTaskRequest('task-runtime-driver-invalid-observed-summary'),
    );

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      await expect(result.submission.completion).resolves.toMatchObject({
        taskId: 'task-runtime-driver-invalid-observed-summary',
        provenance: 'agent-runtime-fail-closed',
        reason:
          'agent runtime fail-closed during runtime execution: Runtime driver result field "observedSummary.memoryMiBPeak" must be a finite number.',
      });
    }
  });

  it('runtime event validation failures resolve completion to fail-closed terminal evidence', async () => {
    const runtimeDriver: RuntimeDriver = {
      async run(context) {
        await context.emit({
          kind: 'tool-invocation',
          detail: 'missing tool name',
        } as unknown as Parameters<typeof context.emit>[0]);

        return withSynthesizedCause(context, {
          outcome: 'success',
          reason: 'unexpected success',
          provenance: 'test-driver',
        });
      },
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-runtime-invalid-event'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      await expect(result.submission.completion).resolves.toMatchObject({
        taskId: 'task-runtime-invalid-event',
        provenance: 'agent-runtime-fail-closed',
        reason:
          'agent runtime fail-closed during runtime execution: Runtime event field "toolName" must be a string.',
      });
    }
  });

  it('runtime driver rejections resolve completion to fail-closed terminal evidence', async () => {
    const runtimeDriver: RuntimeDriver = {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- testing non-Error rejection path
      run: vi.fn(() => Promise.reject('raw driver rejection')),
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-runtime-driver-reject'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      await expect(result.submission.completion).resolves.toMatchObject({
        taskId: 'task-runtime-driver-reject',
        provenance: 'agent-runtime-fail-closed',
        reason:
          'agent runtime fail-closed during runtime execution: non-Error rejection: raw driver rejection',
      });
    }
  });

  it('runtime driver hostile rejections still resolve completion to fail-closed terminal evidence', async () => {
    const hostileRejection = new Proxy(Object.create(null), {
      getPrototypeOf() {
        throw new Error('prototype trap');
      },
      get(_target, property) {
        if (
          property === Symbol.toPrimitive ||
          property === 'toString' ||
          property === 'valueOf'
        ) {
          throw new Error('string trap');
        }

        return undefined;
      },
    });
    const runtimeDriver: RuntimeDriver = {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- testing hostile-Proxy rejection path
      run: vi.fn(() => Promise.reject(hostileRejection)),
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-runtime-driver-hostile-reject'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      await expect(result.submission.completion).resolves.toMatchObject({
        taskId: 'task-runtime-driver-hostile-reject',
        provenance: 'agent-runtime-fail-closed',
        reason:
          'agent runtime fail-closed during runtime execution: non-Error rejection: <uninspectable thrown value>',
      });
    }
  });

  it('runtime driver throws resolve completion to fail-closed terminal evidence', async () => {
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(() => {
        throw new Error('driver threw synchronously');
      }),
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-runtime-driver-throw'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      await expect(result.submission.completion).resolves.toMatchObject({
        taskId: 'task-runtime-driver-throw',
        provenance: 'agent-runtime-fail-closed',
        reason:
          'agent runtime fail-closed during runtime execution: driver threw synchronously',
      });
    }
  });

  it('runtime driver unreadable Error messages still resolve completion to fail-closed terminal evidence', async () => {
    class UnreadableMessageError extends Error {
      constructor() {
        super();
        Object.defineProperty(this, 'message', {
          configurable: true,
          get() {
            throw new Error('message trap');
          },
        });
      }
    }

    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(() => {
        throw new UnreadableMessageError();
      }),
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-runtime-driver-unreadable-error'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      await expect(result.submission.completion).resolves.toMatchObject({
        taskId: 'task-runtime-driver-unreadable-error',
        provenance: 'agent-runtime-fail-closed',
        reason:
          'agent runtime fail-closed during runtime execution: Error with unreadable message',
      });
    }
  });

  it('terminal evidence construction failures resolve completion to fail-closed terminal evidence', async () => {
    const runtimeDriver: RuntimeDriver = {
      async run() {
        return {
          outcome: 'not-a-terminal-outcome',
          reason: 'driver returned invalid terminal outcome',
          provenance: 'test-driver',
          // Intentionally omit `cause` to force the fail-closed path under
          // Phase 4b — type-cast bypasses the now-required field.
        } as unknown as RuntimeDriverResult;
      },
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-runtime-invalid-terminal-outcome'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      expect(evidence).toMatchObject({
        taskId: 'task-runtime-invalid-terminal-outcome',
        provenance: 'agent-runtime-fail-closed',
      });
      // Phase 4b: missing cause is now the first invariant to fail (was
      // previously the outcome-enum check). The fail-closed reason
      // surfaces the underlying TypeError thrown by the cause→outcome
      // mapper when given `undefined`.
      expect(evidence.reason).toMatch(
        /agent runtime fail-closed during runtime execution: /,
      );
    }
  });
});
