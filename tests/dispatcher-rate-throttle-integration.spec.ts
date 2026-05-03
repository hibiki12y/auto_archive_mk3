/**
 * PR5 sub-B — Dispatcher × `'rate-throttle'` chokepoint integration.
 *
 * 책임 범위:
 *   - `DispatcherOptions.rateThrottle` 미주입 시 dispatcher 동작 불변 (BC).
 *   - `port.isQuotaAvailable === false` 시 T2 admission-denied + terminal
 *     lifecycle phase 발화, vetoSource='admission', reason 표면화.
 *   - `port.reserve === undefined` (race-loss) 시 동일 admission-denied
 *     경로 + reason 'rate-throttle quota race'.
 *   - admit 경로에서 lease 정확히 1회 reserve, terminal 경로에서 1회 release.
 *   - per-provider 격리: 한 provider 소진이 다른 provider dispatch 차단 안 함.
 *
 * Spec: `specs/CURRENT/dispatcher-rate-throttle.md`.
 *
 * 회귀 보호:
 *   - `tests/dispatcher-admission-cancel-mode.spec.ts` (T1/T2 cancelMode).
 *   - `tests/admission-rule.rate-throttle-chokepoint.spec.ts` (rule 자체).
 *   - `tests/rate-throttle.spec.ts` (port logic).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  AgentRuntime,
  Dispatcher,
  Plana,
  createDispatchPlan,
  type LifecycleObserver,
  type LifecyclePhaseObservation,
  type RuntimeDriver,
  type RuntimeDriverResult,
} from '../src/index.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import {
  createRateThrottle,
  type RateLease,
  type RateThrottlePort,
  type RuntimeProvider,
} from '../src/core/rate-throttle.js';
import type { TerminalCauseRuntimeVeto } from '../src/contracts/terminal-cause.js';
import {
  synthesizeDriverCause,
  UNUSED_IDENTITY,
} from './helpers/wu-v-cause.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const successfulDriver = (): RuntimeDriver => ({
  run: vi.fn(
    async (): Promise<RuntimeDriverResult> => ({
      reason: 'driver done',
      provenance: 'rate-throttle-it-driver',
      cause: synthesizeDriverCause(UNUSED_IDENTITY, {
        outcome: 'success',
        reason: 'driver done',
        provenance: 'rate-throttle-it-driver',
      }),
    }),
  ),
});

const makeDispatcher = (
  rateThrottle?: { port: RateThrottlePort; provider: RuntimeProvider },
): Dispatcher =>
  new Dispatcher(
    new InProcessComputeNode(new AgentRuntime(successfulDriver())),
    rateThrottle === undefined ? undefined : { rateThrottle },
  );

const captureObserver = (): {
  observer: LifecycleObserver;
  observations: LifecyclePhaseObservation[];
} => {
  const observations: LifecyclePhaseObservation[] = [];
  return {
    observer: (obs) => {
      observations.push(obs);
    },
    observations,
  };
};

// ---------------------------------------------------------------------------
// 1. Backwards compatibility — no throttle option = no behavior change
// ---------------------------------------------------------------------------

describe('Dispatcher × rate-throttle — no option (BC)', () => {
  it('omitting `rateThrottle` preserves pre-PR5 lifecycle (no admission-denied)', async () => {
    const dispatcher = makeDispatcher();
    const { observer, observations } = captureObserver();
    const plan = createDispatchPlan(createTaskRequest('task-rt-bc-1'));

    const evidence = await dispatcher.submit(plan, new Plana(), {
      lifecycleObserver: observer,
    }).completion;

    expect(observations.map((o) => o.phase)).not.toContain('admission-denied');
    expect(observations.map((o) => o.phase)).toEqual([
      'accepted',
      'runtime-entering',
      'runtime-running',
      'settling',
      'terminal',
    ]);
    expect(evidence.cause.kind).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// 2. Quota exhausted — admission-denied lifecycle, distinguishable reason
// ---------------------------------------------------------------------------

describe('Dispatcher × rate-throttle — quota exhausted', () => {
  it('emits admission-denied + terminal with reason "rate-throttle quota exhausted"', async () => {
    // codex 0-cap → isQuotaAvailable always false.
    const port = createRateThrottle({
      codexMaxInflight: 0,
      claudeAgentMaxInflight: -1,
    });
    const dispatcher = makeDispatcher({ port, provider: 'codex' });
    const { observer, observations } = captureObserver();
    const plan = createDispatchPlan(createTaskRequest('task-rt-deny-1'));

    const evidence = await dispatcher.submit(plan, new Plana(), {
      lifecycleObserver: observer,
    }).completion;

    expect(observations.map((o) => o.phase)).toEqual([
      'accepted',
      'admission-denied',
      'terminal',
    ]);
    expect(evidence.cause.kind).toBe('runtime-veto');
    const cause = evidence.cause as TerminalCauseRuntimeVeto;
    expect(cause.vetoSource).toBe('admission');
    expect(cause.runtimeInstanceId).toBe('dispatcher-rate-throttle-denied');
    expect(cause.reason).toBe('rate-throttle quota exhausted');
    expect(cause.cancellation?.cancelMode).toBe('preemptive');
    // Snapshot: counter not incremented since reserve was never called.
    const snap = port.snapshot().find((s) => s.provider === 'codex');
    expect(snap?.inflight).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Race-loss — quotaAvailable=true at gate, reserve returns undefined
// ---------------------------------------------------------------------------

describe('Dispatcher × rate-throttle — race-loss (reserve undefined after admit)', () => {
  it('emits admission-denied + terminal with reason "rate-throttle quota race"', async () => {
    // Spy port: quotaAvailable always true, but reserve always returns undefined
    // (simulates a sibling task draining the slot between pre-fetch and reserve).
    const racingPort: RateThrottlePort = {
      reserve: vi.fn(() => undefined),
      release: vi.fn(),
      isQuotaAvailable: vi.fn(() => true),
      snapshot: () => [],
    };
    const dispatcher = makeDispatcher({ port: racingPort, provider: 'codex' });
    const { observer, observations } = captureObserver();
    const plan = createDispatchPlan(createTaskRequest('task-rt-race-1'));

    const evidence = await dispatcher.submit(plan, new Plana(), {
      lifecycleObserver: observer,
    }).completion;

    expect(observations.map((o) => o.phase)).toEqual([
      'accepted',
      'admission-denied',
      'terminal',
    ]);
    const cause = evidence.cause as TerminalCauseRuntimeVeto;
    expect(cause.vetoSource).toBe('admission');
    expect(cause.reason).toBe('rate-throttle quota race');
    // Reserve attempted exactly once; release MUST NOT fire on a never-held lease.
    expect(racingPort.reserve).toHaveBeenCalledTimes(1);
    expect(racingPort.release).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Admit path — exactly one reserve, exactly one release on terminal
// ---------------------------------------------------------------------------

describe('Dispatcher × rate-throttle — admit + lease lifecycle', () => {
  it('reserves on admit and releases on terminal', async () => {
    const port = createRateThrottle({
      codexMaxInflight: 1,
      claudeAgentMaxInflight: -1,
    });
    const reserveSpy = vi.spyOn(port, 'reserve');
    const releaseSpy = vi.spyOn(port, 'release');
    const dispatcher = makeDispatcher({ port, provider: 'codex' });
    const { observer, observations } = captureObserver();
    const plan = createDispatchPlan(createTaskRequest('task-rt-admit-1'));

    const evidence = await dispatcher.submit(plan, new Plana(), {
      lifecycleObserver: observer,
    }).completion;

    expect(evidence.cause.kind).toBe('success');
    expect(observations.map((o) => o.phase)).not.toContain('admission-denied');
    // Pre-PR5 5 phases preserved (no extra admission-denied insertion).
    expect(observations.map((o) => o.phase)).toEqual([
      'accepted',
      'runtime-entering',
      'runtime-running',
      'settling',
      'terminal',
    ]);
    expect(reserveSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    // Counter is zero post-release (idempotent against second release).
    const snap = port.snapshot().find((s) => s.provider === 'codex');
    expect(snap?.inflight).toBe(0);
  });

  it('next dispatch can reserve immediately after the previous one terminates', async () => {
    // codex cap=1 → second submission must succeed only because the first released.
    const port = createRateThrottle({
      codexMaxInflight: 1,
      claudeAgentMaxInflight: -1,
    });
    const dispatcher = makeDispatcher({ port, provider: 'codex' });
    const ev1 = await dispatcher
      .submit(
        createDispatchPlan(createTaskRequest('task-rt-serial-1')),
        new Plana(),
      )
      .completion;
    expect(ev1.cause.kind).toBe('success');
    const ev2 = await dispatcher
      .submit(
        createDispatchPlan(createTaskRequest('task-rt-serial-2')),
        new Plana(),
      )
      .completion;
    expect(ev2.cause.kind).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// 5. Per-provider isolation
// ---------------------------------------------------------------------------

describe('Dispatcher × rate-throttle — per-provider isolation', () => {
  it('codex saturation does not deny a claude-agent dispatcher with the same shared port', async () => {
    // Shared port, codex saturated, claude-agent unlimited. Two separate
    // dispatchers (one per provider) must not interfere.
    const port = createRateThrottle({
      codexMaxInflight: 0,
      claudeAgentMaxInflight: -1,
    });
    const codexDispatcher = makeDispatcher({ port, provider: 'codex' });
    const claudeDispatcher = makeDispatcher({
      port,
      provider: 'claude-agent',
    });

    const codexEv = await codexDispatcher
      .submit(
        createDispatchPlan(createTaskRequest('task-rt-iso-codex')),
        new Plana(),
      )
      .completion;
    const claudeEv = await claudeDispatcher
      .submit(
        createDispatchPlan(createTaskRequest('task-rt-iso-claude')),
        new Plana(),
      )
      .completion;

    // Codex denied, claude-agent admitted.
    expect(codexEv.cause.kind).toBe('runtime-veto');
    expect((codexEv.cause as TerminalCauseRuntimeVeto).reason).toBe(
      'rate-throttle quota exhausted',
    );
    expect(claudeEv.cause.kind).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// 6. Lease release on driver failure path (defense in depth)
// ---------------------------------------------------------------------------

describe('Dispatcher × rate-throttle — release on non-success terminal', () => {
  it('releases the lease even when the driver throws', async () => {
    const throwingDriver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => {
        throw new Error('driver-explosion');
      }),
    };
    const port = createRateThrottle({
      codexMaxInflight: 1,
      claudeAgentMaxInflight: -1,
    });
    const dispatcher = new Dispatcher(
      new InProcessComputeNode(new AgentRuntime(throwingDriver)),
      { rateThrottle: { port, provider: 'codex' } },
    );
    const plan = createDispatchPlan(createTaskRequest('task-rt-throw-1'));

    // The completion may resolve to an abort evidence or reject —
    // either way the lease MUST be released. Catch + assert
    // post-condition (snapshot inflight=0).
    await dispatcher
      .submit(plan, new Plana())
      .completion.catch(() => undefined);

    const snap = port.snapshot().find((s) => s.provider === 'codex');
    expect(snap?.inflight).toBe(0);
  });
});
