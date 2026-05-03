/**
 * WU-L Step D — typed error thrown by chokepoints (T2: compute-submit,
 * tool-invoke, delivery) when the injected `AdmissionGate` returns a
 * `deny` verdict.
 *
 * T1 (dispatcher entry) does NOT throw this — the dispatcher owns a
 * `SubmissionCancellationState` and translates a deny into a runtime
 * veto + abort terminal evidence directly. Chokepoints downstream of
 * the dispatcher do not have direct access to that state, so they
 * surface the deny as a typed exception which the surrounding
 * lifecycle (cancellation boundary, retry wrapper, circuit breaker)
 * is expected to translate.
 *
 * @see specs/wu-l-admission-rule-evaluator.md §3.5
 * @see specs/wu-l-admission-rule-evaluator.md §4
 */

import type {
  AdmissionDecision,
  AdmissionTrace,
} from '../contracts/admission-rule.js';

export class AdmissionDeniedError extends Error {
  override readonly name = 'AdmissionDeniedError';

  constructor(
    public readonly decision: AdmissionDecision,
    public readonly trace: AdmissionTrace,
  ) {
    super(
      `Admission denied by rule '${decision.ruleId}' at ${decision.triggerId}: ${decision.reason ?? '(no reason)'}`,
    );
  }
}
