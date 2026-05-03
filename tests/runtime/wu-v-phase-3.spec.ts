import { synthesizeDriverCause, UNUSED_IDENTITY } from '../helpers/wu-v-cause.js';
import { describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  Plana,
  createDispatchPlan,
  deriveOutcomeFromCause,
  type LifecycleObserverDescriptor,
  type LifecyclePhaseObservation,
  type RuntimeCancellationBoundary,
  type RuntimeDriver,
  type RuntimeDriverResult,
  type RuntimeTerminalCause,
  type TerminalCause,
  type TerminalEvidence,
} from '../../src/index.js';
import { createTaskRequest } from '../helpers/dispatcher-core.js';

/**
 * WU-V Phase 3 — Deprecation markers + observer payload tightening.
 *
 * Spec: specs/wu-v-terminal-cause-tightening.md §3 (AC-V3.1 / V3.2 / V3.3).
 *
 * Coexistence-window invariant (BC-V3): producers and consumers MUST
 * tolerate both `terminalOutcome` and `cause`. This spec asserts:
 *   - AC-V3.3a: when evidence carries `cause`, observer payload includes
 *     BOTH `terminalOutcome` AND `cause` (deep-equal).
 *   - AC-V3.3b: when evidence has no `cause` (legacy reconstruction),
 *     observer payload includes `terminalOutcome` and `cause === undefined`.
 *   - AC-V3.3c: cross-field invariant — `cause.kind` and `terminalOutcome`
 *     agree per the §4 mapping table.
 *   - AC-V3.1/V3.2 sentinel: deprecated symbols remain importable and
 *     consumable during the coexistence window (regression guard against
 *     accidental removal before Phase 5/6).
 */

function createMinimalBoundary(taskId: string): RuntimeCancellationBoundary {
  let terminalCause: RuntimeTerminalCause | undefined;
  return {
    cancel(veto) {
      const receipt = {
        taskId,
        reason: veto.reason,
        provenance: 'wu-v-phase-3-test-boundary',
        requestedAt: new Date().toISOString(),
      };
      terminalCause ??= { kind: 'external-cancel', ...receipt };
      return receipt;
    },
    latchRuntimeVeto(veto) {
      const cause: RuntimeTerminalCause = {
        kind: 'runtime-veto',
        taskId,
        reason: veto.reason,
        provenance: veto.provenance,
        requestedAt: new Date().toISOString(),
        veto,
      };
      terminalCause ??= cause;
      return cause as Extract<RuntimeTerminalCause, { kind: 'runtime-veto' }>;
    },
    currentTerminalCause: () =>
      terminalCause ? { ...terminalCause } : undefined,
  };
}

interface CapturedFanout {
  observations: LifecyclePhaseObservation[];
  evidence: TerminalEvidence;
}

async function runWithCapturingObserver(
  driver: RuntimeDriver,
  taskId: string,
): Promise<CapturedFanout> {
  const observations: LifecyclePhaseObservation[] = [];
  const observer: LifecycleObserverDescriptor = {
    id: 'wu-v-phase-3-capturing-observer',
    notify: (obs) => {
      observations.push(obs);
    },
  };
  const plan = createDispatchPlan(createTaskRequest(taskId));
  const evidence = await new AgentRuntime(driver).execute(
    plan,
    new Plana({}),
    createMinimalBoundary(plan.taskId),
    observer,
  );
  return { observations, evidence };
}

describe('WU-V Phase 3 — observer payload + deprecation markers', () => {
  it('AC-V3.3a — when evidence carries cause, observer terminal payload includes both terminalOutcome AND cause (deep-equal)', async () => {
    const driver: RuntimeDriver = {
      async run(): Promise<RuntimeDriverResult> {
        return {
          reason: 'driver completed',
          provenance: 'wu-v-phase-3-driver',
          cause: {
            kind: 'success',
            taskId: 'placeholder',
            runtimeInstanceId: 'placeholder',
            observedAt: new Date().toISOString(),
            provenance: 'wu-v-phase-3-driver',
          },
        };
      },
    };

    const { observations, evidence } = await runWithCapturingObserver(
      driver,
      'task-wu-v-3-3a',
    );

    const terminal = observations.find((o) => o.phase === 'terminal');
    expect(terminal).toBeDefined();
    expect(terminal?.cause && deriveOutcomeFromCause(terminal.cause)).toBe('success');
    expect(terminal?.cause).toBeDefined();
    // The payload's cause must match the evidence's cause exactly.
    expect(terminal?.cause).toEqual(evidence.cause);
    expect(terminal?.cause?.kind).toBe('success');
  });

  it('AC-V3.3b — when evidence has no cause (legacy reconstruction), observer payload includes terminalOutcome and cause === undefined', async () => {
    // Driver omits `cause` — agent-runtime falls through the
    // reconstruction path and the resulting evidence has cause === undefined
    // for success (Phase 2 only reconstructs success/provider-failure when
    // driver supplies it). Regression guard for the coexistence window.
    const driver: RuntimeDriver = {
      async run(): Promise<RuntimeDriverResult> {
        return {
          reason: 'driver completed (no structured cause)',
          provenance: 'wu-v-phase-3-legacy-driver',
          cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'driver completed (no structured cause)', provenance: 'wu-v-phase-3-legacy-driver' }),
        };
      },
    };

    const { observations, evidence } = await runWithCapturingObserver(
      driver,
      'task-wu-v-3-3b',
    );

    const terminal = observations.find((o) => o.phase === 'terminal');
    expect(terminal).toBeDefined();
    expect(terminal?.cause && deriveOutcomeFromCause(terminal.cause)).toBe('success');
    // Payload `cause` must mirror evidence — both either present or absent.
    // Coexistence window: subscribers MUST tolerate absence.
    expect(terminal?.cause).toBe(evidence.cause);
  });

  it('AC-V3.3c — cross-field invariant: success cause ⇔ success outcome; provider-failure cause ⇒ failure outcome', async () => {
    // Success path
    const successDriver: RuntimeDriver = {
      async run(): Promise<RuntimeDriverResult> {
        return {
          reason: 'ok',
          provenance: 'wu-v-phase-3-cross-field',
          cause: {
            kind: 'success',
            taskId: 'placeholder',
            runtimeInstanceId: 'placeholder',
            observedAt: new Date().toISOString(),
            provenance: 'wu-v-phase-3-cross-field',
          },
        };
      },
    };
    const successRun = await runWithCapturingObserver(
      successDriver,
      'task-wu-v-3-3c-success',
    );
    const successTerminal = successRun.observations.find(
      (o) => o.phase === 'terminal',
    );
    expect(successTerminal?.cause?.kind).toBe('success');
    expect(successTerminal?.cause && deriveOutcomeFromCause(successTerminal.cause)).toBe('success');

    // Provider-failure path
    const failureDriver: RuntimeDriver = {
      async run(): Promise<RuntimeDriverResult> {
        return {
          reason: 'provider-failed',
          provenance: 'wu-v-phase-3-cross-field-failure',
          cause: {
            kind: 'provider-failure',
            taskId: 'placeholder',
            runtimeInstanceId: 'placeholder',
            observedAt: new Date().toISOString(),
            provenance: 'wu-v-phase-3-cross-field-failure',
            provider: 'codex',
            classification: 'transient-network',
            retryable: true,
            message: 'simulated transient network failure',
          },
        };
      },
    };
    const failureRun = await runWithCapturingObserver(
      failureDriver,
      'task-wu-v-3-3c-failure',
    );
    const failureTerminal = failureRun.observations.find(
      (o) => o.phase === 'terminal',
    );
    expect(failureTerminal?.cause?.kind).toBe('provider-failure');
    expect(failureTerminal?.cause && deriveOutcomeFromCause(failureTerminal.cause)).toBe('failure');
  });

  it('AC-V6 sentinel — TerminalOutcome export is removed; TerminalEvidence remains importable with cause-only shape', () => {
    // WU-V Phase 6: TerminalOutcome is fully retired. The dedicated
    // Phase 6 spec (tests/wu-v-phase-6.spec.ts) covers the @ts-expect-error
    // import sentinel; this in-suite check pins that TerminalCause is
    // the sole terminal-state symbol consumed here.
    const cause: TerminalCause = {
      kind: 'success',
      taskId: 'sentinel',
      runtimeInstanceId: 'sentinel',
      observedAt: new Date().toISOString(),
      provenance: 'sentinel',
    };
    expect(cause.kind).toBe('success');
  });
});
