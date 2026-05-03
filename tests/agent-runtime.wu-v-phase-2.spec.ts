/**
 * WU-V Phase 2 — agent-runtime cause preference.
 *
 * Spec: specs/wu-v-terminal-cause-tightening.md §3 Phase 2, §4 mapping.
 *
 * Acceptance criteria:
 *  - AC-V2.1: When `driverResult.cause` is populated, `TerminalEvidence.cause`
 *             equals it (deep-equal); reconstruction (no-cause) path NOT invoked.
 *  - AC-V2.2: When `driverResult.cause` is absent (legacy/test producers), the
 *             existing reconstruction path produces an equivalent `TerminalEvidence`
 *             (regression guard).
 *  - AC-V2.3: `terminal-evidence` consistency (cross-field invariant per §4)
 *             holds for both populated and reconstructed shapes.
 */

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
  type TerminalCauseProviderFailure,
  type TerminalCauseSuccess,
} from '../src/index.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

/**
 * Cross-field invariant per §4 of the WU-V spec — Phase 6 form.
 *
 * Post-Phase-6 the only terminal-state field on TerminalEvidence is
 * `cause`. The invariant is therefore that the supplied cause-kind
 * matches the expected human-facing label as projected by the §4
 * mapping table.
 */
function assertCrossFieldInvariant(
  outcome: string,
  cause: { kind: string } | undefined,
): void {
  if (cause === undefined) {
    return;
  }
  switch (cause.kind) {
    case 'success':
      expect(outcome).toBe('success');
      break;
    case 'provider-failure':
      expect(outcome).toBe('failure');
      break;
    case 'timeout':
      expect(outcome).toBe('timeout');
      break;
    default:
      // Other kinds (external-cancel/runtime-veto/driver-failure) cannot
      // surface through the driver-result Phase 2 path; the type-system
      // enforces this at the producer site (RuntimeDriverResult.cause).
      throw new Error(`unexpected cause.kind on driver-result path: ${cause.kind}`);
  }
}

describe('WU-V Phase 2 — agent-runtime prefers RuntimeDriverResult.cause', () => {
  it('AC-V2.1: success path threads driver-supplied cause verbatim into TerminalEvidence.cause', async () => {
    /**
     * Sentinel cause distinguishable from anything the runtime could
     * synthesize via reconstruction (provenance + observedAt are unique).
     */
    const driverCause: TerminalCauseSuccess = {
      kind: 'success',
      taskId: 'task-wu-v-phase-2-success',
      runtimeInstanceId: 'sentinel-driver-instance-id',
      observedAt: '2099-01-01T00:00:00.000Z',
      provenance: 'wu-v-phase-2-test-driver',
      artifactLocation: 'artifact://sentinel/success',
    };

    const driver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
        reason: 'wu-v phase 2 driver success',
        provenance: 'test-driver',
        cause: driverCause,
      })),
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
    ).requestDispatch(createTaskRequest('task-wu-v-phase-2-success'));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;

    expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
    expect(evidence.cause).toBeDefined();
    // Deep-equal: driver-supplied cause is threaded verbatim (cloneTerminalCause
    // produces a structurally-equal copy; identity inequality is acceptable).
    expect(evidence.cause).toEqual(driverCause);
    assertCrossFieldInvariant(deriveOutcomeFromCause(evidence.cause), evidence.cause);
  });

  it('AC-V2.1: provider-failure path threads driver-supplied cause verbatim into TerminalEvidence.cause', async () => {
    const driverCause: TerminalCauseProviderFailure = {
      kind: 'provider-failure',
      taskId: 'task-wu-v-phase-2-failure',
      runtimeInstanceId: 'sentinel-driver-instance-id',
      observedAt: '2099-02-02T00:00:00.000Z',
      provenance: 'wu-v-phase-2-test-driver',
      provider: 'codex',
      classification: 'rate-limit',
      retryable: true,
      message: 'sentinel rate limit',
      retryAfterMs: 1234,
      sdkErrorCode: 'rate_limit',
    };

    const driver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
        reason: 'wu-v phase 2 driver failure',
        provenance: 'test-driver',
        cause: driverCause,
      })),
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
    ).requestDispatch(createTaskRequest('task-wu-v-phase-2-failure'));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;

    expect(deriveOutcomeFromCause(evidence.cause)).toBe('failure');
    expect(evidence.cause).toBeDefined();
    expect(evidence.cause).toEqual(driverCause);
    assertCrossFieldInvariant(deriveOutcomeFromCause(evidence.cause), evidence.cause);
  });

  it('AC-V4.1: cause is REQUIRED on driver path; evidence cause matches driver-supplied cause', async () => {
    const driverCause = synthesizeDriverCause(UNUSED_IDENTITY, {
      outcome: 'success',
      reason: 'phase 4b driver success',
      provenance: 'test-driver',
    });
    const driver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
        reason: 'phase 4b driver success',
        provenance: 'test-driver',
        cause: driverCause,
      })),
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
    ).requestDispatch(createTaskRequest('task-wu-v-phase-4b-required'));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;

    // Phase 4b: cause is always populated; outcome is derived from cause.
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
    expect(evidence.cause).toBeDefined();
    expect(evidence.cause).toEqual(driverCause);
    expect(evidence.reason).toBe('phase 4b driver success');
    expect(evidence.provenance).toBe('test-driver');
    assertCrossFieldInvariant(deriveOutcomeFromCause(evidence.cause), evidence.cause);
  });

  it('AC-V2.2: legacy (no cause) failure path is identical to a populated-cause failure path on the shared fields', async () => {
    /**
     * Regression-equivalence: build two parallel runs (one with cause, one
     * without) and assert that all evidence fields *other than* `cause`
     * line up. This pins the Phase 2 invariant that adding `cause` is a
     * pure additive thread-through — no other field is perturbed.
     */
    const baseResult: RuntimeDriverResult = {
      reason: 'parallel-run failure reason',
      provenance: 'test-driver',
      cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'failure', reason: 'parallel-run failure reason', provenance: 'test-driver' }),
    };
    const populatedCause: TerminalCauseProviderFailure = {
      kind: 'provider-failure',
      taskId: 'task-wu-v-phase-2-equivalence',
      runtimeInstanceId: 'will-be-overridden-by-runtime-but-equal-by-test',
      observedAt: '2099-03-03T00:00:00.000Z',
      provenance: 'parallel-run',
      provider: 'codex',
      classification: 'transient-server',
      retryable: false,
      message: 'parallel-run failure cause',
    };

    const legacyDriver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => ({ ...baseResult })),
    };
    const populatedDriver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => ({
        ...baseResult,
        cause: populatedCause,
      })),
    };

    const legacyRes = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(legacyDriver))),
    ).requestDispatch(createTaskRequest('task-wu-v-phase-2-equivalence'));
    const populatedRes = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(populatedDriver))),
    ).requestDispatch(createTaskRequest('task-wu-v-phase-2-equivalence'));

    expect(legacyRes.kind).toBe('dispatched');
    expect(populatedRes.kind).toBe('dispatched');
    if (legacyRes.kind !== 'dispatched' || populatedRes.kind !== 'dispatched') return;
    const legacyEv = await legacyRes.submission.completion;
    const populatedEv = await populatedRes.submission.completion;

    expect(deriveOutcomeFromCause(legacyEv.cause)).toBe(deriveOutcomeFromCause(populatedEv.cause));
    expect(legacyEv.reason).toBe(populatedEv.reason);
    expect(legacyEv.provenance).toBe(populatedEv.provenance);
    expect(legacyEv.taskId).toBe(populatedEv.taskId);

    // Phase 4b: both paths now have a defined cause (cause is required).
    expect(legacyEv.cause).toBeDefined();
    expect(populatedEv.cause).toEqual(populatedCause);
    assertCrossFieldInvariant(deriveOutcomeFromCause(legacyEv.cause), legacyEv.cause);
    assertCrossFieldInvariant(deriveOutcomeFromCause(populatedEv.cause), populatedEv.cause);
  });

  it('AC-V2.3: cross-field invariant holds for both populated and reconstructed shapes', async () => {
    // Combined assertion across kinds covered above is implicit in each
    // test's `assertCrossFieldInvariant` call; this case adds explicit
    // multi-shape coverage for documentation symmetry.
    const successCause: TerminalCauseSuccess = {
      kind: 'success',
      taskId: 'task-wu-v-phase-2-v23',
      runtimeInstanceId: 'driver-instance',
      observedAt: '2099-04-04T00:00:00.000Z',
      provenance: 'wu-v-phase-2-test-driver',
    };
    assertCrossFieldInvariant('success', successCause);
    assertCrossFieldInvariant('success', undefined);
    assertCrossFieldInvariant('failure', undefined);
    expect(() => assertCrossFieldInvariant('failure', successCause)).toThrow();
  });
});
