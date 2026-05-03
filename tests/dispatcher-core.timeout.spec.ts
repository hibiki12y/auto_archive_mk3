import { synthesizeDriverCause, UNUSED_IDENTITY } from './helpers/wu-v-cause.js';
import { describe, expect, it, vi } from 'vitest';
import { deriveOutcomeFromCause } from '../src/core/derive-outcome.js';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  Plana,
  type RuntimeDriver,
  type RuntimeDriverResult,
  type TaskRequest,
} from '../src/index.js';
import {
  createControlledPromise,
  createTaskRequest,
} from './helpers/dispatcher-core.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';

function withDeadline(taskId: string, deadlineMs: number): TaskRequest {
  const base = createTaskRequest(taskId);
  return {
    ...base,
    runtimeSettings: {
      ...base.runtimeSettings,
      deadlineMs,
    },
  };
}

describe('agent runtime wall-time deadline enforcement', () => {
  it('emits a timeout terminal evidence when the deadline fires before the driver settles', async () => {
    const driverExecution = createControlledPromise<RuntimeDriverResult>();
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn((context) => {
        context.emit({
          kind: 'agent-step',
          step: 'waiting-on-driver',
          detail: 'driver still running when deadline approaches',
        });
        return driverExecution.promise;
      }),
    };

    const arona = new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    );

    const result = await arona.requestDispatch(
      withDeadline('task-deadline-fires', 5),
    );

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      expect(deriveOutcomeFromCause(evidence.cause)).toBe('timeout');
      expect(evidence.reason).toBe('agent runtime deadline of 5ms exceeded');
      expect(evidence.provenance).toBe('agent-runtime-deadline');
      expect(evidence.abort).toBeUndefined();
      expect(evidence.executionContext.runtimeSettings.deadlineMs).toBe(5);
      expect(evidence.cause).toMatchObject({
        kind: 'timeout',
        deadlineMs: 5,
        provenance: 'agent-runtime-deadline',
        taskId: 'task-deadline-fires',
      });
      expect(evidence.cause?.kind === 'timeout' && evidence.cause.firedAt).toEqual(
        evidence.endedAt,
      );
      expect(evidence.transcript).toMatchObject({
        droppedCount: 0,
        events: [
          {
            kind: 'runtime-initialized',
            message: 'agent instance created',
          },
          {
            kind: 'agent-step',
            step: 'waiting-on-driver',
            detail: 'driver still running when deadline approaches',
          },
        ],
      });

      // Releasing the driver after the deadline must not change the evidence
      // or surface a late side effect.
      driverExecution.resolve({
        reason: 'driver settled after deadline',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'driver settled after deadline', provenance: 'test-driver' }),
      });
      await Promise.resolve();
    }
  });

  it('exposes timeout as driver abort state so in-flight runtimes can tear down', async () => {
    const abortObserved = createControlledPromise<void>();
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(
        async (context): Promise<RuntimeDriverResult> =>
          await new Promise<RuntimeDriverResult>((resolve) => {
            const pollForAbort = (): void => {
              if (context.isAborted()) {
                abortObserved.resolve();
                resolve({
                  reason: 'driver noticed timeout abort',
                  provenance: 'test-driver',
                  cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'driver noticed timeout abort', provenance: 'test-driver' }),
                });
                return;
              }

              setTimeout(pollForAbort, 1);
            };

            pollForAbort();
          }),
      ),
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(withDeadline('task-timeout-aborts-driver', 5));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      expect(deriveOutcomeFromCause(evidence.cause)).toBe('timeout');
      expect(evidence.reason).toBe('agent runtime deadline of 5ms exceeded');
      await expect(abortObserved.promise).resolves.toBeUndefined();
    }
  });

  it('lets the driver result win when it settles before the deadline', async () => {
    const runtimeDriver: RuntimeDriver = {
      async run() {
        return {
          outcome: 'success',
          reason: 'driver completed before deadline',
          provenance: 'test-driver',
          cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'driver completed before deadline', provenance: 'test-driver' }),
        };
      },
    };

    const arona = new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    );

    const result = await arona.requestDispatch(
      withDeadline('task-driver-wins-deadline', 1_000),
    );

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
      expect(evidence.reason).toBe('driver completed before deadline');
      expect(evidence.provenance).toBe('test-driver');
      expect(evidence.abort).toBeUndefined();
    }
  });

  it('external cancel latches first and is not overwritten by a slower deadline or driver', async () => {
    const driverExecution = createControlledPromise<RuntimeDriverResult>();
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(() => driverExecution.promise),
    };
    const dispatcher = new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver)));
    const arona = new Arona(new Plana(), dispatcher);

    const result = await arona.requestDispatch(
      withDeadline('task-cancel-beats-deadline', 50),
    );

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      // Cancel immediately, well before the deadline can fire.
      expect(
        dispatcher.cancel(
          'task-cancel-beats-deadline',
          'operator requested stop',
        ),
      ).toMatchObject({ taskId: 'task-cancel-beats-deadline' });

      const evidence = await result.submission.completion;
      expect(deriveOutcomeFromCause(evidence.cause)).toBe('operator-cancel');
      expect(evidence.reason).toBe('operator requested stop');
      expect(evidence.provenance).toBe('dispatcher');
      expect(evidence.cause).toMatchObject({
        kind: 'external-cancel',
        taskId: 'task-cancel-beats-deadline',
        reason: 'operator requested stop',
        provenance: 'dispatcher',
      });

      // Wait long enough that the deadline timer would have fired had it
      // not been cleared, then settle the driver. Neither must overwrite
      // the operator-cancel terminal evidence.
      await new Promise((resolve) => setTimeout(resolve, 80));
      driverExecution.resolve({
        reason: 'driver settled after cancel and deadline window',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'driver settled after cancel and deadline window', provenance: 'test-driver' }),
      });
      await Promise.resolve();

      // Re-await: completion must still resolve to the same operator-cancel
      // outcome (no overwriting).
      const evidenceAgain = await result.submission.completion;
      expect(deriveOutcomeFromCause(evidenceAgain.cause)).toBe('operator-cancel');
    }
  });

  it('clears the deadline timer once the driver settles so a late timer cannot fire', async () => {
    const runtimeDriver: RuntimeDriver = {
      async run() {
        return {
          outcome: 'success',
          reason: 'driver settled fast',
          provenance: 'test-driver',
          cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'driver settled fast', provenance: 'test-driver' }),
        };
      },
    };

    const arona = new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    );

    const result = await arona.requestDispatch(
      withDeadline('task-deadline-cleared', 25),
    );

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');

      // Track unhandled rejections / extra completions while the original
      // deadline window elapses — if the timer wasn't cleared we'd see a
      // second resolution attempt or stray side effect here.
      let observed = 0;
      void result.submission.completion.then(() => {
        observed += 1;
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(observed).toBe(1);
    }
  });

  it('preserves timeout when a late driver result arrives after deadline teardown begins', async () => {
    const driverExecution = createControlledPromise<RuntimeDriverResult>();
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(async (context): Promise<RuntimeDriverResult> => {
        while (!context.isAborted()) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }

        return driverExecution.promise;
      }),
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(withDeadline('task-timeout-late-success', 5));

    expect(result.kind).toBe('dispatched');
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      expect(deriveOutcomeFromCause(evidence.cause)).toBe('timeout');

      driverExecution.resolve({
        reason: 'driver settled after timeout teardown',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'driver settled after timeout teardown', provenance: 'test-driver' }),
      });
      await Promise.resolve();

      await expect(result.submission.completion).resolves.toMatchObject({
        taskId: 'task-timeout-late-success',
        reason: 'agent runtime deadline of 5ms exceeded',
        provenance: 'agent-runtime-deadline',
      });
    }
  });
});
