/**
 * Test helpers for WU-V: synthesize the required
 * `RuntimeDriverResult.cause` field for legacy test doubles.
 *
 * The mappings here mirror specs/wu-v-terminal-cause-tightening.md §4
 * for the producer column "driver". They are intentionally minimal —
 * tests that exercise cause-specific behavior should construct their
 * own causes inline; this helper is for tests where the cause is
 * incidental to the assertion.
 *
 * Phase 5 note: `RuntimeDriverResult.outcome` has been retired. Callers
 * still pass `outcome` here as a *helper-input discriminator only* — it
 * tells the synthesizer which cause kind to build and is then dropped
 * (never threaded into the returned `RuntimeDriverResult`).
 */

import type {
  RuntimeDriverResult,
  RuntimeExecutionContext,
} from '../../src/index.js';
import type { ObservedResourceSummary } from '../../src/contracts/resource-envelope.js';
import type {
  TerminalCauseProviderFailure,
  TerminalCauseSuccess,
  TerminalCauseTimeout,
} from '../../src/contracts/terminal-cause.js';

/**
 * Helper-input shape: keeps the legacy `outcome` literal as a
 * discriminator for cause synthesis. NOT a `RuntimeDriverResult` —
 * `outcome` is stripped before returning the merged driver result.
 */
export interface CauseSynthesisInput {
  outcome: 'success' | 'failure' | 'timeout' | 'operator-cancel';
  reason: string;
  provenance: string;
  artifactLocation?: string;
  observedSummary?: ObservedResourceSummary;
}

export interface CauseIdentity {
  taskId: string;
  runtimeInstanceId: string;
}

function identityFromContext(ctx: RuntimeExecutionContext): CauseIdentity {
  return {
    taskId: ctx.plan.taskId,
    runtimeInstanceId: ctx.instance.instanceId,
  };
}

/**
 * Synthesize a cause matching the helper-input `outcome` discriminator
 * and merge it into a `RuntimeDriverResult`. The `outcome` field is
 * dropped (Phase 5 — outcome is no longer a `RuntimeDriverResult`
 * field). Identity is taken from the execution context.
 */
export function withSynthesizedCause(
  ctx: RuntimeExecutionContext,
  input: CauseSynthesisInput,
): RuntimeDriverResult {
  const { outcome: _outcome, ...rest } = input;
  void _outcome;
  return {
    ...rest,
    cause: synthesizeDriverCause(identityFromContext(ctx), input),
  };
}

/**
 * Identity-form synthesizer for tests that build the result outside of a
 * driver `run` (e.g. precomputed return values for `vi.fn`).
 */
export function synthesizeDriverCause(
  identity: CauseIdentity,
  input: CauseSynthesisInput,
): RuntimeDriverResult['cause'] {
  const observedAt = new Date().toISOString();
  const provenance = input.provenance;
  switch (input.outcome) {
    case 'success': {
      const cause: TerminalCauseSuccess = {
        kind: 'success',
        taskId: identity.taskId,
        runtimeInstanceId: identity.runtimeInstanceId,
        observedAt,
        provenance,
      };
      return cause;
    }
    case 'timeout': {
      const cause: TerminalCauseTimeout = {
        kind: 'timeout',
        taskId: identity.taskId,
        runtimeInstanceId: identity.runtimeInstanceId,
        observedAt,
        provenance,
        deadlineMs: 1000,
        firedAt: observedAt,
      };
      return cause;
    }
    case 'failure': {
      const cause: TerminalCauseProviderFailure = {
        kind: 'provider-failure',
        taskId: identity.taskId,
        runtimeInstanceId: identity.runtimeInstanceId,
        observedAt,
        provenance,
        provider: 'codex',
        classification: 'unknown',
        retryable: false,
        message: input.reason,
      };
      return cause;
    }
    case 'operator-cancel': {
      // Symmetry preserved from Phase 4b: direct-from-driver operator
      // cancellation surfaces an `external-cancel` cause.
      const cause: import('../../src/contracts/terminal-cause.js').TerminalCauseExternalCancel = {
        kind: 'external-cancel',
        taskId: identity.taskId,
        runtimeInstanceId: identity.runtimeInstanceId,
        observedAt,
        provenance,
        reason: input.reason,
        requestedAt: observedAt,
      };
      return cause;
    }
  }
}

/**
 * Sentinel placeholder identity for vi.fn driver results that the test
 * asserts will never be invoked (so cause content is irrelevant).
 */
export const UNUSED_IDENTITY: CauseIdentity = {
  taskId: 'unused-task',
  runtimeInstanceId: 'unused-instance',
};

/** @deprecated Phase 5 — alias retained for any external imports. */
export type DriverResultWithoutCause = CauseSynthesisInput;
