/**
 * WU-W Phase 2 — Driver-side fail-closed origination (driver wrapper).
 *
 * Spec: specs/wu-w-driver-fail-closed-origination.md §3 Phase 2,
 *       §5 AC-W3, AC-W5(a..e, g, h).
 *
 * Scope of this file:
 *   - The codex driver wraps unstructured throws in
 *     `CodexDriverFailureError`, attaching a pre-built
 *     `TerminalCauseDriverFailure` whose provenance is `'driver-adapter'`
 *     and whose `requestContext` carries at minimum `{ taskId, phase }`.
 *   - `agent-runtime.buildFailClosedCause` extracts the driver-originated
 *     cause verbatim (driver-originated wins over fallback synthesis).
 *   - Pre-turn abort still emits the F9 provider-failure cause unchanged.
 *   - Runtime-veto via `emit()` still wins over driver-failure.
 *   - AbortError from external cancellation propagates verbatim — agent-
 *     runtime resolves the authoritative cause from the cancellation
 *     boundary (external-cancel wins over driver-failure).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  Plana,
  type RuntimeDriver,
  type RuntimeDriverResult,
  type RuntimeExecutionContext,
} from '../src/index.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import {
  CodexDriverFailureError,
  CodexRuntimeDriver,
  type CodexRuntimeDriverOptions,
} from '../src/runtime/codex-runtime-adapter.js';
import { createDispatchPlan } from '../src/core/task.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function createRuntimeContext(
  overrides: Partial<RuntimeExecutionContext> = {},
): RuntimeExecutionContext {
  const plan =
    overrides.plan ??
    createDispatchPlan(createTaskRequest('task-wu-w-phase-2'));
  return {
    plan,
    instance:
      overrides.instance ?? {
        taskId: plan.taskId,
        instanceId: 'agent-task-wu-w-phase-2',
        createdAt: '2026-04-22T00:00:00.000Z',
        runtimeSettings: plan.runtimeSettings,
      },
    emit: overrides.emit ?? (async () => {}),
    requestApproval:
      overrides.requestApproval ?? (async () => ({ status: 'approved' })),
    isAborted: overrides.isAborted ?? (() => false),
  };
}

describe('WU-W Phase 2 — codex driver wraps unstructured throws', () => {
  it('AC-W5.a / AC-W5.g / AC-W5.h: synchronous throw inside runStreamed → CodexDriverFailureError with driver-originated cause (stack + requestContext populated)', async () => {
    const sentinel = new Error('codex sdk imploded synchronously');
    const sdkFactory = (() => ({
      startThread: () => ({
        id: 'thread-sync-throw',
         
        async runStreamed() {
          throw sentinel;
        },
      }),
    })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({ sdkFactory });

    const observed = await driver
      .run(createRuntimeContext())
      .catch((e: unknown) => e);

    expect(observed).toBeInstanceOf(CodexDriverFailureError);
    const wrapped = observed as CodexDriverFailureError;
    expect(wrapped.name).toBe('CodexDriverFailureError');
    expect(wrapped.message).toBe('codex sdk imploded synchronously');

    const cause = wrapped.driverFailureCause;
    expect(cause.kind).toBe('driver-failure');
    expect(cause.provenance).toBe('driver-adapter');
    expect(cause.taskId).toBe('task-wu-w-phase-2');
    expect(cause.runtimeInstanceId).toBe('agent-task-wu-w-phase-2');
    expect(cause.message).toBe('codex sdk imploded synchronously');
    // AC-W5.g — stack populated when error.stack is present.
    expect(typeof cause.stack).toBe('string');
    expect(cause.stack ?? '').toContain('codex sdk imploded synchronously');
    // AC-W5.h — requestContext carries at least { taskId, phase }.
    expect(cause.requestContext).toEqual({
      taskId: 'task-wu-w-phase-2',
      phase: 'codex-run',
    });
    expect(cause.phase).toBe('codex-run');
  });

  it('AC-W5.b: async throw (rejected runStreamed promise) → CodexDriverFailureError with driver-originated cause', async () => {
    const sdkFactory = (() => ({
      startThread: () => ({
        id: 'thread-async-throw',
        runStreamed: () =>
          Promise.reject(new Error('async transport rejected')),
      }),
    })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({ sdkFactory });

    const observed = await driver
      .run(createRuntimeContext())
      .catch((e: unknown) => e);

    expect(observed).toBeInstanceOf(CodexDriverFailureError);
    const wrapped = observed as CodexDriverFailureError;
    expect(wrapped.driverFailureCause.kind).toBe('driver-failure');
    expect(wrapped.driverFailureCause.provenance).toBe('driver-adapter');
    expect(wrapped.driverFailureCause.message).toBe('async transport rejected');
    expect(wrapped.driverFailureCause.phase).toBe('codex-run');
  });

  it('AC-W5.c: pre-turn abort short-circuit still emits F9 provider-failure (NOT driver-failure)', async () => {
    const startThread = vi.fn();
    const sdkFactory = (() => ({
      startThread,
    })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({ sdkFactory });

    const result = await driver.run(
      createRuntimeContext({ isAborted: () => true }),
    );

    // Pre-turn abort returns a structured RuntimeDriverResult; it does
    // NOT throw, so the WU-W wrapper never sees this path. The cause
    // remains the §6.12 F9 provider-failure (classification 'unknown').
    expect(result.cause.kind).toBe('provider-failure');
    expect(startThread).not.toHaveBeenCalled();
  });

  it('AC-W5.d: cooperative abort via context.isAborted wins over driver-failure wrapping', async () => {
    let delivered = false;
    const sdkFactory = (() => ({
      startThread: () => ({
        id: 'thread-veto-then-throw',
        async runStreamed(
          _input: string,
          options: { signal?: AbortSignal } | undefined,
        ) {
          const signal = options?.signal;
          const events = {
            [Symbol.asyncIterator]() {
              return this;
            },
            async next() {
              if (delivered) {
                return { done: true, value: undefined };
              }
              delivered = true;
                return {
                  done: false,
                  value: {
                    type: 'item.completed',
                    item: {
                      id: 'wu-w-veto-item',
                      type: 'command_execution',
                      status: 'in_progress',
                      command: 'rm -rf /',
                  },
                },
              };
            },
            async return() {
              // Simulate the SDK throwing AbortError after the controller
              // is aborted by the veto path. The existing `veto !==
              // undefined && isAbortError(error)` branch must catch it
              // and return a runtime-veto cause — NOT a driver-failure.
              if (signal?.aborted) {
                throw createAbortError('aborted after veto');
              }
              return { done: true, value: undefined };
            },
          };
          return { events };
        },
      }),
    })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({ sdkFactory });

    let aborted = false;
    const observed = await driver.run(
      createRuntimeContext({
        emit: async () => {
          aborted = true;
        },
        isAborted: () => aborted,
      }),
    ).catch((error: unknown) => error);

    expect(observed).toMatchObject({ name: 'AbortError' });
  });

  it('AC-W5.e: AbortError from external cancellation propagates verbatim (NOT wrapped) so external-cancel can win at agent-runtime', async () => {
    vi.useFakeTimers();

    let runSignal: AbortSignal | undefined;
    let aborted = false;

    const sdkFactory = (() => ({
      startThread: () => ({
        id: 'thread-external-cancel',
        async runStreamed(
          _input: string,
          options: { signal?: AbortSignal } | undefined,
        ) {
          runSignal = options?.signal;
          const events = {
            [Symbol.asyncIterator]() {
              return this;
            },
            next(): Promise<IteratorResult<unknown>> {
              return new Promise<IteratorResult<unknown>>((_r, reject) => {
                const fail = (): void =>
                  reject(createAbortError('stream aborted'));
                if (runSignal?.aborted) {
                  fail();
                  return;
                }
                runSignal?.addEventListener('abort', fail, { once: true });
              });
            },
            async return() {
              return { done: true, value: undefined };
            },
          };
          return { events };
        },
      }),
    })) as unknown as CodexRuntimeDriverOptions['sdkFactory'];
    const driver = new CodexRuntimeDriver({
      abortPollIntervalMs: 1,
      sdkFactory,
    });

    const execution = driver.run(
      createRuntimeContext({ isAborted: () => aborted }),
    );
    const observedRejection = execution.catch((e: unknown) => e);

    aborted = true;
    await vi.advanceTimersByTimeAsync(5);

    const observed = await observedRejection;
    expect(observed).toBeInstanceOf(Error);
    // Critical: AbortError name preserved (NOT wrapped into
    // CodexDriverFailureError). Agent-runtime's cancellation-boundary
    // path resolves the authoritative external-cancel cause.
    expect((observed as Error).name).toBe('AbortError');
    expect(observed).not.toBeInstanceOf(CodexDriverFailureError);

    vi.useRealTimers();
  });
});

describe('WU-W Phase 2 — agent-runtime trusts driver-originated driver-failure cause', () => {
  it('AC-W3 + AC-W5.a (integration): generic throw from driver surfaces as driver-failure with provenance="driver-adapter" in TerminalEvidence.cause', async () => {
    /**
     * Drive the full agent-runtime → buildFailClosedCause path with a
     * mock RuntimeDriver that throws a CodexDriverFailureError directly
     * (simulating the wrapper output). Asserts that the new
     * `instanceof CodexDriverFailureError` branch in
     * `buildFailClosedCause` returns the driver-originated cause
     * verbatim instead of synthesizing one.
     */
    const driverCause = {
      kind: 'driver-failure' as const,
      taskId: 'task-wu-w-integration',
      runtimeInstanceId: 'sentinel-driver-instance',
      observedAt: '2099-09-09T00:00:00.000Z',
      provenance: 'driver-adapter',
      phase: 'codex-run',
      message: 'sentinel driver-originated failure',
      stack: 'Error: sentinel driver-originated failure\n    at <test>',
      requestContext: {
        taskId: 'task-wu-w-integration',
        phase: 'codex-run',
      },
    };

    const driver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => {
        throw new CodexDriverFailureError(
          'sentinel driver-originated failure',
          driverCause,
        );
      }),
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
    ).requestDispatch(createTaskRequest('task-wu-w-integration'));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;

    expect(evidence.cause).toBeDefined();
    expect(evidence.cause.kind).toBe('driver-failure');
    // Driver-originated cause is threaded verbatim — provenance stays
    // 'driver-adapter' (NOT 'agent-runtime-fail-closed' synthesis).
    expect(evidence.cause.provenance).toBe('driver-adapter');
    if (evidence.cause.kind === 'driver-failure') {
      expect(evidence.cause.message).toBe('sentinel driver-originated failure');
      expect(evidence.cause.phase).toBe('codex-run');
      expect(evidence.cause.stack).toBe(driverCause.stack);
      expect(evidence.cause.requestContext).toEqual(driverCause.requestContext);
    }
  });
});
