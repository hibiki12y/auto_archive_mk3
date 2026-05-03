import { synthesizeDriverCause, UNUSED_IDENTITY } from './helpers/wu-v-cause.js';
import { describe, expect, it, vi } from 'vitest';
import { deriveOutcomeFromCause } from '../src/core/derive-outcome.js';

import {
  AgentRuntime,
  Arona,
  createDispatchPlan,
  Dispatcher,
  Plana,
  vetoRuntime,
  vetoRuntimeSettings,
  type LifecycleObserver,
  type LifecyclePhaseObservation,
  type RuntimeDriver,
  type RuntimeDriverResult,
  type VetoPath,
} from '../src/index.js';
import {
  createControlledPromise,
  createTaskRequest,
} from './helpers/dispatcher-core.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';

describe('dispatcher core lifecycle settings-review fail-closed coverage', () => {
  it('fail-closed when runtimeSettings hook throws before driver runs or runtime-initialized is emitted', async () => {
    const runtimeSpy = vi.fn();
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
        reason: 'unexpected success',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'unexpected success', provenance: 'test-driver' }),
      })),
    };

    const result = await new Arona(
      new Plana({
        runtimeSettings: () => {
          throw new Error('settings-review-explosion');
        },
        runtime: runtimeSpy,
      }),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-settings-review-throws'));

    expect(result.kind).toBe('dispatched');
    expect(runtimeDriver.run).not.toHaveBeenCalled();
    expect(runtimeSpy).not.toHaveBeenCalled();
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      expect(deriveOutcomeFromCause(evidence.cause)).toBe('failure');
      expect(evidence.provenance).toBe('agent-runtime-fail-closed');
      expect(evidence.reason).toContain('runtime settings review');
      expect(evidence.reason).toContain('settings-review-explosion');
      expect(evidence.abort).toBeUndefined();
    }
  });
});

describe('dispatcher core lifecycle early-init veto coverage', () => {
  it('runtime hook veto on the very first runtime-initialized event aborts before driver runs', async () => {
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
                'init blocked at first emit',
                'lifecycle-init-policy',
              )
            : undefined,
      }),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-init-veto-with-cancel'));

    expect(result.kind).toBe('dispatched');
    expect(runtimeDriver.run).not.toHaveBeenCalled();
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      expect(deriveOutcomeFromCause(evidence.cause)).toBe('abort');
      expect(evidence.reason).toBe('init blocked at first emit');
      expect(evidence.provenance).toBe('lifecycle-init-policy');
      expect(evidence.abort).toMatchObject({
        kind: 'veto',
        veto: {
          origin: 'runtime',
          reason: 'init blocked at first emit',
          provenance: 'lifecycle-init-policy',
        },
        cancellation: {
          taskId: 'task-init-veto-with-cancel',
          reason: 'init blocked at first emit',
          provenance: 'dispatcher-runtime-veto',
          boundary: 'dispatcher',
        },
      });
    }
  });

  it('runtime hook veto on init with termination only (no cancellation) aborts without a cancellation receipt', async () => {
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
        reason: 'unexpected success',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'unexpected success', provenance: 'test-driver' }),
      })),
    };

    const initVeto: VetoPath = {
      origin: 'runtime',
      reason: 'init blocked terminate-only',
      provenance: 'lifecycle-init-terminate-only',
      propagation: {
        blocksSubmission: false,
        requestsCancellation: false,
        requestsTermination: true,
      },
    };

    const result = await new Arona(
      new Plana({
        runtime: ({ event }) =>
          event.kind === 'runtime-initialized' ? initVeto : undefined,
      }),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver))),
    ).requestDispatch(createTaskRequest('task-init-veto-terminate-only'));

    expect(result.kind).toBe('dispatched');
    expect(runtimeDriver.run).not.toHaveBeenCalled();
    if (result.kind === 'dispatched') {
      const evidence = await result.submission.completion;
      expect(deriveOutcomeFromCause(evidence.cause)).toBe('abort');
      expect(evidence.reason).toBe('init blocked terminate-only');
      expect(evidence.provenance).toBe('lifecycle-init-terminate-only');
      expect(evidence.abort).toMatchObject({
        kind: 'veto',
        veto: {
          origin: 'runtime',
          provenance: 'lifecycle-init-terminate-only',
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
});

describe('execution context enrichment', () => {
  const successfulDriver = (): RuntimeDriver => ({
    run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
      reason: 'driver done',
      provenance: 'test-driver',
      cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'driver done', provenance: 'test-driver' }),
    })),
  });

  const isoLte = (a: string, b: string): boolean =>
    Date.parse(a) <= Date.parse(b);

  it('records executionStartedAt and approved settingsReview when no runtimeSettings hook is configured', async () => {
    const testStartedAt = new Date().toISOString();
    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(successfulDriver()))),
    ).requestDispatch(createTaskRequest('task-ctx-no-hook'));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
    const ctx = evidence.executionContext;
    expect(ctx.executionStartedAt).toBeDefined();
    expect(isoLte(testStartedAt, ctx.executionStartedAt!)).toBe(true);
    expect(isoLte(ctx.executionStartedAt!, evidence.endedAt)).toBe(true);
    expect(ctx.settingsReview).toBeDefined();
    expect(ctx.settingsReview!.status).toBe('approved');
    expect(ctx.settingsReview!.provenance).toBeUndefined();
    expect(typeof ctx.settingsReview!.reviewedAt).toBe('string');
    expect(Number.isNaN(Date.parse(ctx.settingsReview!.reviewedAt))).toBe(false);
  });

  it('records approved settingsReview when runtimeSettings hook explicitly approves', async () => {
    const hook = vi.fn(() => undefined);
    const result = await new Arona(
      new Plana({ runtimeSettings: hook }),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(successfulDriver()))),
    ).requestDispatch(createTaskRequest('task-ctx-hook-approves'));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;
    expect(hook).toHaveBeenCalledTimes(1);
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
    const review = evidence.executionContext.settingsReview;
    expect(review).toEqual({
      status: 'approved',
      reviewedAt: expect.any(String),
    });
    expect(evidence.executionContext.executionStartedAt).toBeDefined();
  });

  it('records vetoed settingsReview with provenance when runtimeSettings hook vetoes', async () => {
    const result = await new Arona(
      new Plana({
        runtimeSettings: () =>
          vetoRuntimeSettings('settings denied by policy'),
      }),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(successfulDriver()))),
    ).requestDispatch(createTaskRequest('task-ctx-hook-vetoes'));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('abort');
    const review = evidence.executionContext.settingsReview;
    expect(review).toBeDefined();
    expect(review!.status).toBe('vetoed');
    expect(review!.provenance).toBe('plana-runtime-settings');
    expect(typeof review!.reviewedAt).toBe('string');
    expect(Number.isNaN(Date.parse(review!.reviewedAt))).toBe(false);
    expect(evidence.executionContext.executionStartedAt).toBeDefined();
  });

  it('omits settingsReview but keeps executionStartedAt when runtimeSettings hook throws', async () => {
    const result = await new Arona(
      new Plana({
        runtimeSettings: () => {
          throw new Error('boom');
        },
      }),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(successfulDriver()))),
    ).requestDispatch(createTaskRequest('task-ctx-hook-throws'));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('failure');
    expect(evidence.provenance).toBe('agent-runtime-fail-closed');
    expect(evidence.executionContext.settingsReview).toBeUndefined();
    expect(evidence.executionContext.executionStartedAt).toBeDefined();
    expect(
      isoLte(evidence.executionContext.executionStartedAt!, evidence.endedAt),
    ).toBe(true);
  });
});

describe('lifecycle observer', () => {
  const successfulDriver = (): RuntimeDriver => ({
    run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
      reason: 'driver done',
      provenance: 'test-driver',
      cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'driver done', provenance: 'test-driver' }),
    })),
  });

  const isoLte = (a: string, b: string): boolean =>
    Date.parse(a) <= Date.parse(b);

  it('preserves existing behavior when no observer is supplied (success path)', async () => {
    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(successfulDriver()))),
    ).requestDispatch(createTaskRequest('task-observer-absent'));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
  });

  it('emits all five phases in order with monotonic timestamps on a success path', async () => {
    const observations: LifecyclePhaseObservation[] = [];
    const observer: LifecycleObserver = (obs) => {
      observations.push(obs);
    };

    const dispatcher = new Dispatcher(new InProcessComputeNode(new AgentRuntime(successfulDriver())));
    const plana = new Plana();
    const plan = createDispatchPlan(createTaskRequest('task-observer-success'));

    const submission = dispatcher.submit(plan, plana, {
      lifecycleObserver: observer,
    });
    const evidence = await submission.completion;

    expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
    expect(observations.map((o) => o.phase)).toEqual([
      'accepted',
      'runtime-entering',
      'runtime-running',
      'settling',
      'terminal',
    ]);
    for (let i = 1; i < observations.length; i++) {
      expect(isoLte(observations[i - 1].observedAt, observations[i].observedAt)).toBe(true);
    }
    for (const obs of observations) {
      expect(obs.taskId).toBe('task-observer-success');
    }
    for (const obs of observations.slice(1)) {
      expect(obs.instanceId).toBeDefined();
      expect(typeof obs.instanceId).toBe('string');
    }
    expect(observations[0].instanceId).toBeUndefined();
    const terminalObs = observations[observations.length - 1];
    expect(((terminalObs.cause && deriveOutcomeFromCause(terminalObs.cause)) ?? undefined)).toBe('success');
  });

  it('skips runtime-running when settings veto aborts before driver runs', async () => {
    const observations: LifecyclePhaseObservation[] = [];
    const dispatcher = new Dispatcher(new InProcessComputeNode(new AgentRuntime(successfulDriver())));
    const plana = new Plana({
      runtimeSettings: () => vetoRuntimeSettings('settings denied'),
    });
    const plan = createDispatchPlan(
      createTaskRequest('task-observer-settings-veto'),
    );

    const submission = dispatcher.submit(plan, plana, {
      lifecycleObserver: (obs) => observations.push(obs),
    });
    const evidence = await submission.completion;

    expect(deriveOutcomeFromCause(evidence.cause)).toBe('abort');
    expect(observations.map((o) => o.phase)).toEqual([
      'accepted',
      'runtime-entering',
      'settling',
      'terminal',
    ]);
    expect((observations[observations.length - 1].cause && deriveOutcomeFromCause(observations[observations.length - 1].cause!))).toBe('abort');
  });

  it('skips runtime-running when runtime-initialized review veto aborts before driver runs', async () => {
    const observations: LifecyclePhaseObservation[] = [];
    const dispatcher = new Dispatcher(new InProcessComputeNode(new AgentRuntime(successfulDriver())));
    const plana = new Plana({
      runtime: ({ event }) =>
        event.kind === 'runtime-initialized'
          ? vetoRuntime('init veto blocks driver', 'lifecycle-init-veto-policy')
          : undefined,
    });
    const plan = createDispatchPlan(
      createTaskRequest('task-observer-init-veto'),
    );

    const submission = dispatcher.submit(plan, plana, {
      lifecycleObserver: (obs) => observations.push(obs),
    });
    const evidence = await submission.completion;

    expect(deriveOutcomeFromCause(evidence.cause)).toBe('abort');
    expect(evidence.reason).toBe('init veto blocks driver');
    expect(evidence.provenance).toBe('lifecycle-init-veto-policy');
    expect(observations.map((o) => o.phase)).toEqual([
      'accepted',
      'runtime-entering',
      'settling',
      'terminal',
    ]);
    expect((observations[observations.length - 1].cause && deriveOutcomeFromCause(observations[observations.length - 1].cause!))).toBe('abort');
    // Verify settings review is approved (no settings hook configured)
    expect(evidence.executionContext.settingsReview).toBeDefined();
    expect(evidence.executionContext.settingsReview!.status).toBe('approved');
    expect(evidence.executionContext.settingsReview!.provenance).toBeUndefined();
  });

  it('emits runtime-running, settling, and terminal with timeout outcome on deadline', async () => {
    const driverExecution = createControlledPromise<RuntimeDriverResult>();
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(() => driverExecution.promise),
    };
    const observations: LifecyclePhaseObservation[] = [];
    const dispatcher = new Dispatcher(new InProcessComputeNode(new AgentRuntime(runtimeDriver)));
    const plana = new Plana();
    const baseRequest = createTaskRequest('task-observer-timeout');
    const plan = createDispatchPlan({
      ...baseRequest,
      runtimeSettings: { ...baseRequest.runtimeSettings, deadlineMs: 5 },
    });

    const submission = dispatcher.submit(plan, plana, {
      lifecycleObserver: (obs) => observations.push(obs),
    });
    const evidence = await submission.completion;

    // Resolve the controlled driver to avoid dangling promises.
    driverExecution.resolve({
      reason: 'late',
      provenance: 'test-driver',
      cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'late', provenance: 'test-driver' }),
    });

    expect(deriveOutcomeFromCause(evidence.cause)).toBe('timeout');
    const phases = observations.map((o) => o.phase);
    expect(phases).toEqual([
      'accepted',
      'runtime-entering',
      'runtime-running',
      'settling',
      'terminal',
    ]);
    expect((observations[observations.length - 1].cause && deriveOutcomeFromCause(observations[observations.length - 1].cause!))).toBe('timeout');
  });

  it('continues firing all subsequent phases when an observer call throws', async () => {
    const observations: LifecyclePhaseObservation[] = [];
    const observer: LifecycleObserver = (obs) => {
      observations.push(obs);
      if (obs.phase === 'runtime-entering') {
        throw new Error('observer-explosion');
      }
    };

    const dispatcher = new Dispatcher(new InProcessComputeNode(new AgentRuntime(successfulDriver())));
    const plana = new Plana();
    const plan = createDispatchPlan(createTaskRequest('task-observer-throws'));

    const submission = dispatcher.submit(plan, plana, {
      lifecycleObserver: observer,
    });
    const evidence = await submission.completion;

    expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
    expect(observations.map((o) => o.phase)).toEqual([
      'accepted',
      'runtime-entering',
      'runtime-running',
      'settling',
      'terminal',
    ]);
  });
});

describe('settings veto fail-safe', () => {
  it('fails closed when settings veto application throws', async () => {
    const runtimeDriver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
        reason: 'unexpected success',
        provenance: 'test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'unexpected success', provenance: 'test-driver' }),
      })),
    };

    // Subclass AgentRuntime so the cancellationBoundary handed in by the
    // Dispatcher gets its `cancel` swapped for one that throws. This exercises
    // the new try/catch around the settings-veto application block without
    // requiring helper-level seams.
    class ThrowingCancelAgentRuntime extends AgentRuntime {
      override execute(
        plan: Parameters<AgentRuntime['execute']>[0],
        plana: Parameters<AgentRuntime['execute']>[1],
        cancellationBoundary: Parameters<AgentRuntime['execute']>[2],
        observer: Parameters<AgentRuntime['execute']>[3],
      ): ReturnType<AgentRuntime['execute']> {
        const wrapped: typeof cancellationBoundary = {
          ...cancellationBoundary,
          cancel: () => {
            throw new Error('cancel-explosion');
          },
        };
        return super.execute(plan, plana, wrapped, observer);
      }
    }

    const observations: LifecyclePhaseObservation[] = [];
    const observer: LifecycleObserver = (obs) => {
      observations.push(obs);
    };

    const dispatcher = new Dispatcher(new InProcessComputeNode(new ThrowingCancelAgentRuntime(runtimeDriver)),);
    const plana = new Plana({
      runtimeSettings: () => vetoRuntimeSettings('settings denied by policy'),
    });
    const plan = createDispatchPlan(
      createTaskRequest('task-settings-veto-cancel-throws'),
    );

    const submission = dispatcher.submit(plan, plana, {
      lifecycleObserver: observer,
    });
    const evidence = await submission.completion;

    expect(runtimeDriver.run).not.toHaveBeenCalled();
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('failure');
    expect(evidence.provenance).toBe('agent-runtime-fail-closed');
    expect(evidence.reason).toContain('settings veto application');
    expect(evidence.reason).toContain('cancel-explosion');
    expect(evidence.abort).toBeUndefined();

    const review = evidence.executionContext.settingsReview;
    expect(review).toBeDefined();
    expect(review!.status).toBe('vetoed');
    expect(review!.provenance).toBe('plana-runtime-settings');

    const phases = observations.map((o) => o.phase);
    expect(phases).toContain('settling');
    expect(phases).toContain('terminal');
  });
});
