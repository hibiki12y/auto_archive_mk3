import { withSynthesizedCause, synthesizeDriverCause, UNUSED_IDENTITY } from './helpers/wu-v-cause.js';
import { describe, expect, it, vi } from 'vitest';
import { deriveOutcomeFromCause } from '../src/core/derive-outcome.js';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  Plana,
  createDispatchPlan,
  vetoRuntime,
  vetoRuntimeSettings,
  type RuntimeCancellationBoundary,
  type RuntimeDriver,
  type RuntimeDriverResult,
  type RuntimeTerminalCause,
  type VetoPath,
} from '../src/index.js';
import {
  createControlledPromise,
  createTaskRequest,
} from './helpers/dispatcher-core.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';

function createExternalCancelOnlyBoundary(
  taskId: string,
): RuntimeCancellationBoundary {
  let terminalCause: RuntimeTerminalCause | undefined;

  return {
    cancel(veto) {
      const receipt = {
        taskId,
        reason: veto.reason,
        provenance: 'legacy-boundary-cancel',
        requestedAt: new Date().toISOString(),
      };
      terminalCause ??= {
        kind: 'external-cancel',
        ...receipt,
      };
      return receipt;
    },
    currentTerminalCause: () =>
      terminalCause ? { ...terminalCause } : undefined,
  };
}

describe('dispatcher core runtime veto behavior', () => {
  it('runtime veto results in abort terminal evidence with provenance', async () => {
    const runtimeDriver: RuntimeDriver = {
      async run(context) {
        await context.emit({
          kind: 'tool-invocation',
          toolName: 'filesystem',
          detail: 'attempted destructive filesystem operation',
          observedSummary: {
            cpuCoresPeak: 1,
            memoryMiBPeak: 256,
            wallTimeSec: 5,
            extra: 'discarded-before-runtime-state',
          },
        } as unknown as Parameters<typeof context.emit>[0]);

        if (context.isAborted()) {
          return withSynthesizedCause(context, {
            outcome: 'failure',
            reason: 'driver stopped after veto',
            provenance: 'test-driver',
          });
        }

        return withSynthesizedCause(context, {
          outcome: 'success',
          reason: 'unexpected success',
          provenance: 'test-driver',
        });
      },
    };

    const result = await new Arona(
      new Plana({
        runtime: ({ event }) =>
          event.kind === 'tool-invocation' && event.toolName === 'filesystem'
            ? vetoRuntime('destructive runtime action denied', 'runtime-policy')
            : undefined,
      }),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-veto-runtime'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      expect(deriveOutcomeFromCause(evidence.cause)).toBe('abort');
      expect(evidence.reason).toBe('destructive runtime action denied');
      expect(evidence.provenance).toBe('runtime-policy');
      expect(evidence.abort).toMatchObject({
        kind: 'veto',
        veto: {
          origin: 'runtime',
          provenance: 'runtime-policy',
          propagation: {
            blocksSubmission: false,
            requestsCancellation: true,
            requestsTermination: true,
          },
        },
        cancellation: {
          taskId: 'task-veto-runtime',
          reason: 'destructive runtime action denied',
          provenance: 'dispatcher-runtime-veto',
          boundary: 'dispatcher',
        },
      });
      expect(evidence.executionContext).toMatchObject({
        planCreatedAt: result.plan.createdAt,
        runtimeSettings: result.plan.runtimeSettings,
      });
      expect(evidence.executionContext.executionStartedAt).toBeDefined();
      expect(evidence.executionContext.settingsReview).toEqual({
        status: 'approved',
        reviewedAt: expect.any(String),
      });
      expect(evidence.observedSummary).toEqual({
        cpuCoresPeak: 1,
        memoryMiBPeak: 256,
        wallTimeSec: 5,
      });
      expect(evidence.transcript).toMatchObject({
        droppedCount: 0,
        events: [
          {
            kind: 'runtime-initialized',
            message: 'agent instance created',
          },
          {
            kind: 'tool-invocation',
            toolName: 'filesystem',
            detail: 'attempted destructive filesystem operation',
            observedSummary: {
              cpuCoresPeak: 1,
              memoryMiBPeak: 256,
              wallTimeSec: 5,
            },
          },
        ],
      });
      expect(evidence.cause).toMatchObject({
        kind: 'runtime-veto',
        taskId: 'task-veto-runtime',
        provenance: 'runtime-policy',
        reason: 'destructive runtime action denied',
        veto: { origin: 'runtime', provenance: 'runtime-policy' },
      });
    }
  });

  it('runtime veto settles completion before a pending driver rejects', async () => {
    const driverExecution = createControlledPromise<RuntimeDriverResult>();
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(async (context) => {
        await context.emit({
          kind: 'tool-invocation',
          toolName: 'filesystem',
          detail: 'attempted destructive filesystem operation',
        });
        expect(context.isAborted()).toBe(true);

        return driverExecution.promise;
      }),
    };

    const result = await new Arona(
      new Plana({
        runtime: ({ event }) =>
          event.kind === 'tool-invocation'
            ? vetoRuntime('destructive runtime action denied', 'runtime-policy')
            : undefined,
      }),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-veto-pending-driver'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      const completionObserver = vi.fn();
      void result.submission.completion.then(completionObserver);
      await Promise.resolve();
      expect(completionObserver).not.toHaveBeenCalled();

      await expect(result.submission.completion).resolves.toMatchObject({
        taskId: 'task-veto-pending-driver',
        reason: 'destructive runtime action denied',
        provenance: 'runtime-policy',
        abort: {
          kind: 'veto',
          veto: {
            origin: 'runtime',
          },
        },
      });

      driverExecution.reject(new Error('late driver rejection after veto settlement'));
      await Promise.resolve();
    }
  });

  it('runtime cancellation veto remains effectful without termination request', async () => {
    const runtimeDriver: RuntimeDriver = {
      async run(context) {
        await context.emit({
          kind: 'tool-invocation',
          toolName: 'filesystem',
          detail: 'attempted advisory-cancel operation',
        });

        return withSynthesizedCause(context, {
          outcome: 'success',
          reason: 'driver finished after advisory cancel',
          provenance: 'test-driver',
        });
      },
    };

    const result = await new Arona(
      new Plana({
        runtime: ({ event }) =>
          event.kind === 'tool-invocation'
            ? {
                ...vetoRuntime('cancel-only runtime veto', 'runtime-cancel-only'),
                propagation: {
                  blocksSubmission: false,
                  requestsCancellation: true,
                  requestsTermination: false,
                },
              }
            : undefined,
      }),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-veto-cancel-only'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      await expect(result.submission.completion).resolves.toMatchObject({
        taskId: 'task-veto-cancel-only',
        reason: 'cancel-only runtime veto',
        provenance: 'runtime-cancel-only',
        abort: {
          kind: 'veto',
          veto: {
            origin: 'runtime',
            propagation: {
              blocksSubmission: false,
              requestsCancellation: true,
              requestsTermination: false,
            },
          },
          cancellation: {
            taskId: 'task-veto-cancel-only',
            reason: 'cancel-only runtime veto',
            provenance: 'dispatcher-runtime-veto',
            boundary: 'dispatcher',
          },
        },
      });
    }
  });

  it('first latched terminal veto is not overwritten by a later driver rejection', async () => {
    const runtimeDriver: RuntimeDriver = {
      async run(context) {
        await context.emit({
          kind: 'tool-invocation',
          toolName: 'filesystem',
          detail: 'attempted destructive filesystem operation',
        });

        throw new Error('late driver rejection after veto');
      },
    };

    const result = await new Arona(
      new Plana({
        runtime: ({ event }) =>
          event.kind === 'tool-invocation'
            ? vetoRuntime('destructive runtime action denied', 'runtime-policy')
            : undefined,
      }),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-veto-reject-race'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      await expect(result.submission.completion).resolves.toMatchObject({
        taskId: 'task-veto-reject-race',
        reason: 'destructive runtime action denied',
        provenance: 'runtime-policy',
      });
    }
  });

  it('runtime termination veto latches the first terminating veto', async () => {
    const firstVeto = vetoRuntime('first terminating veto wins', 'first-runtime-policy');
    const secondVeto = vetoRuntime(
      'second terminating veto should not replace first',
      'second-runtime-policy',
    );

    const runtimeDriver: RuntimeDriver = {
      async run(context) {
        await context.emit({
          kind: 'tool-invocation',
          toolName: 'filesystem',
          detail: 'first terminating action',
        });
        await context.emit({
          kind: 'tool-invocation',
          toolName: 'network',
          detail: 'later terminating action',
        });

        return withSynthesizedCause(context, {
          outcome: 'failure',
          reason: 'driver saw multiple terminating vetoes',
          provenance: 'test-driver',
        });
      },
    };

    const result = await new Arona(
      new Plana({
        runtime: ({ event }) => {
          if (event.kind !== 'tool-invocation') {
            return undefined;
          }

          return event.toolName === 'filesystem' ? firstVeto : secondVeto;
        },
      }),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-latched-runtime-veto'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      await expect(result.submission.completion).resolves.toMatchObject({
        reason: 'first terminating veto wins',
        provenance: 'first-runtime-policy',
        abort: {
          veto: {
            reason: 'first terminating veto wins',
            provenance: 'first-runtime-policy',
          },
          cancellation: {
            reason: 'first terminating veto wins',
            provenance: 'dispatcher-runtime-veto',
          },
        },
      });
    }
  });

  it('early runtime veto aborts before driver progress begins', async () => {
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
        reason: 'unexpected success',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'unexpected success', provenance: 'test-driver' }),
      })),
    };

    const result = await new Arona(
      new Plana({
        runtime: ({ event }) =>
          event.kind === 'runtime-initialized'
            ? vetoRuntime(
                'runtime blocked before driver progress',
                'runtime-bootstrap-policy',
              )
            : undefined,
      }),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-early-runtime-veto'));

    expect(result.kind).toBe('dispatched');
    expect(runtimeDriver.run).not.toHaveBeenCalled();
    if (result.kind === 'dispatched') {
      await expect(result.submission.completion).resolves.toMatchObject({
        taskId: 'task-early-runtime-veto',
        reason: 'runtime blocked before driver progress',
        provenance: 'runtime-bootstrap-policy',
        abort: {
          kind: 'veto',
          veto: {
            origin: 'runtime',
            reason: 'runtime blocked before driver progress',
            provenance: 'runtime-bootstrap-policy',
          },
          cancellation: {
            taskId: 'task-early-runtime-veto',
            reason: 'runtime blocked before driver progress',
            provenance: 'dispatcher-runtime-veto',
            boundary: 'dispatcher',
          },
        },
      });
    }
  });

  it('runtime veto skips dispatcher cancellation when propagation does not request it', async () => {
    const runtimeDriver: RuntimeDriver = {
      async run(context) {
        await context.emit({
          kind: 'tool-invocation',
          toolName: 'secrets-store',
          detail: 'attempted sensitive operation without cancellation request',
        });

        return context.isAborted()
          ? {
              outcome: 'failure',
              reason: 'driver stopped after veto without dispatcher cancellation',
              provenance: 'test-driver',
              cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'failure', reason: 'driver stopped after veto without dispatcher cancellation', provenance: 'test-driver' }),
            }
          : {
              outcome: 'success',
              reason: 'unexpected success',
              provenance: 'test-driver',
              cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'unexpected success', provenance: 'test-driver' }),
            };
      },
    };

    const runtimeVeto: VetoPath = {
      origin: 'runtime',
      reason: 'runtime veto without dispatcher cancellation',
      provenance: 'runtime-policy',
      propagation: {
        blocksSubmission: false,
        requestsCancellation: false,
        requestsTermination: true,
      },
    };

    const result = await new Arona(
      new Plana({
        runtime: ({ event }) => (event.kind === 'tool-invocation' ? runtimeVeto : undefined),
      }),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-veto-runtime-no-cancel'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      expect(deriveOutcomeFromCause(evidence.cause)).toBe('abort');
      expect(evidence.reason).toBe('runtime veto without dispatcher cancellation');
      expect(evidence.provenance).toBe('runtime-policy');
      expect(evidence.abort).toMatchObject({
        kind: 'veto',
        veto: {
          origin: 'runtime',
          provenance: 'runtime-policy',
          propagation: {
            blocksSubmission: false,
            requestsCancellation: false,
            requestsTermination: true,
          },
        },
      });
      expect(evidence.abort?.cancellation).toBeUndefined();
    }
  });

  it('runtime veto without termination still latches terminal abort semantics', async () => {
    let vetoSeenByDriver = false;
    let abortedAfterVeto: boolean | undefined;

    const runtimeDriver: RuntimeDriver = {
      async run(context) {
        await context.emit({
          kind: 'tool-invocation',
          toolName: 'filesystem',
          detail: 'runtime policy signals cancellation without terminal abort',
        });
        vetoSeenByDriver = context.isAborted();
        abortedAfterVeto = context.isAborted();

        return withSynthesizedCause(context, {
          outcome: 'failure',
          reason: vetoSeenByDriver
            ? 'driver handled veto: runtime veto without terminal abort'
            : 'unexpected missing veto',
          provenance: vetoSeenByDriver ? 'runtime-policy' : 'test-driver',
        });
      },
    };

    const runtimeVeto: VetoPath = {
      origin: 'runtime',
      reason: 'runtime veto without terminal abort',
      provenance: 'runtime-policy',
      propagation: {
        blocksSubmission: false,
        requestsCancellation: true,
        requestsTermination: false,
      },
    };

    const result = await new Arona(
      new Plana({
        runtime: ({ event }) => (event.kind === 'tool-invocation' ? runtimeVeto : undefined),
      }),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-veto-runtime-no-terminate'));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      expect(deriveOutcomeFromCause(evidence.cause)).toBe('abort');
      expect(evidence.reason).toBe('runtime veto without terminal abort');
      expect(evidence.provenance).toBe('runtime-policy');
      expect(evidence.abort).toMatchObject({
        kind: 'veto',
        veto: {
          origin: 'runtime',
          reason: 'runtime veto without terminal abort',
          provenance: 'runtime-policy',
          propagation: {
            blocksSubmission: false,
            requestsCancellation: true,
            requestsTermination: false,
          },
        },
        cancellation: {
          taskId: 'task-veto-runtime-no-terminate',
          reason: 'runtime veto without terminal abort',
          provenance: 'dispatcher-runtime-veto',
          boundary: 'dispatcher',
        },
      });
    }
  });

  it('preserves runtime-veto abort evidence when boundary only reports external cancel', async () => {
    const runtimeDriver: RuntimeDriver = {
      async run(context) {
        await context.emit({
          kind: 'tool-invocation',
          toolName: 'filesystem',
          detail: 'attempted destructive filesystem operation',
        });

        return withSynthesizedCause(context, {
          outcome: 'failure',
          reason: 'driver stopped after veto',
          provenance: 'test-driver',
        });
      },
    };

    const plan = createDispatchPlan(
      createTaskRequest('task-veto-runtime-legacy-boundary'),
    );
    const evidence = await new AgentRuntime(runtimeDriver).execute(
      plan,
      new Plana({
        runtime: ({ event }) =>
          event.kind === 'tool-invocation'
            ? vetoRuntime('destructive runtime action denied', 'runtime-policy')
            : undefined,
      }),
      createExternalCancelOnlyBoundary(plan.taskId),
    );

    expect(evidence).toMatchObject({
      taskId: 'task-veto-runtime-legacy-boundary',
      reason: 'destructive runtime action denied',
      provenance: 'legacy-boundary-cancel',
      abort: undefined,
    });
  });

  it('preserves settings-veto abort evidence when boundary only reports external cancel', async () => {
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
        reason: 'unexpected success',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'unexpected success', provenance: 'test-driver' }),
      })),
    };

    const plan = createDispatchPlan(
      createTaskRequest('task-settings-veto-legacy-boundary'),
    );
    const evidence = await new AgentRuntime(runtimeDriver).execute(
      plan,
      new Plana({
        runtimeSettings: () =>
          vetoRuntimeSettings('settings denied by policy', 'runtime-settings-policy'),
      }),
      createExternalCancelOnlyBoundary(plan.taskId),
    );

    expect(runtimeDriver.run).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      taskId: 'task-settings-veto-legacy-boundary',
      reason: 'settings denied by policy',
      provenance: 'runtime-settings-policy',
      abort: {
        kind: 'veto',
        veto: {
          origin: 'runtime',
          reason: 'settings denied by policy',
          provenance: 'runtime-settings-policy',
        },
        cancellation: {
          taskId: 'task-settings-veto-legacy-boundary',
          reason: 'settings denied by policy',
          provenance: 'legacy-boundary-cancel',
          boundary: 'dispatcher',
        },
      },
    });
  });
});
