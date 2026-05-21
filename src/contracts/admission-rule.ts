/**
 * WU-L Admission Rule Evaluator — Contract Types
 *
 * Binding contract per specs/wu-l-admission-rule-evaluator.md (active).
 * Trigger set T1–T5 is closed per §6.9 Option D-closed; new triggers
 * require a §6.9 amendment.
 *
 * NOTE: T3_RetryAttempt is a stub enum value — no caller is wired in
 * this WU. Production wiring depends on WU-V (Codex Resilience) retry
 * coordinator landing.
 *
 * Field-naming note: spec §3 reserves field names as MAY-rename,
 * MUST-NOT-widen. The descriptive `Tn_Suffix` enum literals here are a
 * conformant rename of the bare `'T1'..'T5'` names used in spec §3.1.1;
 * semantics are unchanged.
 */

/**
 * Closed admission trigger enumeration.
 *
 * Mirrors the five trigger entries enumerated in
 * specs/wu-l-admission-rule-evaluator.md §3.1.1 (which itself binds to
 * specs/architecture-improvement-review-2026-04-20.md §6.9 §3.1).
 *
 * @see specs/wu-l-admission-rule-evaluator.md §3.1.1
 * @see specs/wu-l-admission-rule-evaluator.md §6.9
 */
export type AdmissionTrigger =
  | 'T1_DispatcherEntry'      // always 1× per dispatch (post-dedup, pre-backend.run)
  | 'T2_ChokepointCrossing'   // pre-each-side-effect (compute-submit | tool-invoke | delivery)
  | 'T3_RetryAttempt'         // STUB — caller deferred to WU-V Codex Resilience
  | 'T4_ExplicitReevaluation' // operator kill-switch via AdmissionGate.requestReevaluation
  | 'T5_ResourceExhaustion';  // deferred re-eval signal from SLURM/quota path

/**
 * Discriminator for T2 chokepoints.
 *
 * @see specs/wu-l-admission-rule-evaluator.md §4 (AC-L3 enumerated chokepoints)
 * @see specs/architecture-improvement-review-2026-04-20.md §6.9
 * @see specs/ARCHIVE/dispatcher-rate-throttle.md (PR5 — `'rate-throttle'` widening)
 */
export type ChokepointKind =
  | 'compute-submit'
  | 'tool-invoke'
  | 'delivery'
  | 'rate-throttle';

/**
 * Pure context snapshot passed to admission predicates.
 *
 * Predicates MUST treat this as a frozen snapshot and MUST NOT perform
 * I/O; any data needed by a rule must be pre-fetched into `metadata` by
 * the caller before invoking `AdmissionGate.evaluate`.
 *
 * @see specs/wu-l-admission-rule-evaluator.md §3.2
 * @see specs/wu-l-admission-rule-evaluator.md §3.4
 */
export interface DispatchCtx {
  /** Stable task identifier (WU-* TaskId domain). */
  readonly taskId: string;
  /** Which of the closed T1–T5 triggers fired this evaluation. */
  readonly trigger: AdmissionTrigger;
  /** Present iff `trigger === 'T2_ChokepointCrossing'`. */
  readonly chokepoint?: ChokepointKind;
  /** 1-based attempt index; incremented on T3 once WU-V wires retries. */
  readonly attempt: number;
  /**
   * TraitModule ids or legacy opaque trait labels claimed by the plan.
   *
   * This field remains stringly for admission-rule hash compatibility. New
   * compute/resource grants must use `ComputeCapabilitySurface.capabilityFlags`
   * instead of encoding capability intent here.
   */
  readonly traits: ReadonlyArray<string>;
  /** Pre-fetched snapshots (quota, computeNode hints, etc.). Opaque to the gate. */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Operator-supplied (T4) or system-supplied (T5) reason; informational only. */
  readonly reason?: string;
}

/**
 * Ternary admission verdict per §3.1.
 *
 * @see specs/wu-l-admission-rule-evaluator.md §3.1
 */
export type AdmissionVerdict = 'admit' | 'deny' | 'defer';

/**
 * Decision returned by a single rule (and the aggregate verdict surfaced
 * by `AdmissionGate.evaluate`).
 *
 * @see specs/wu-l-admission-rule-evaluator.md §3.3
 */
export interface AdmissionDecision {
  readonly verdict: AdmissionVerdict;
  /** Stable rule identifier; used in audit trace. */
  readonly ruleId: string;
  /** The trigger that fired the evaluation producing this decision. */
  readonly triggerId: AdmissionTrigger;
  /** Human-readable justification; MUST be stable across builds when present. */
  readonly reason?: string;
  /** Rule-supplied metadata (e.g., quota snapshot the decision relied on). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Audit trace entry — one is emitted per `AdmissionGate.evaluate` call,
 * including pure-admit and full fall-through paths.
 *
 * @see specs/wu-l-admission-rule-evaluator.md §3.6
 */
export interface AdmissionTrace {
  readonly taskId: string;
  readonly trigger: AdmissionTrigger;
  readonly chokepoint?: ChokepointKind;
  readonly attempt: number;
  /** Stable hash of the decision-relevant slice of `DispatchCtx` (per §3.4). */
  readonly ctxHash: string;
  readonly verdict: AdmissionVerdict;
  /** First-deny rule, or first-admit rule, or undefined on full fall-through. */
  readonly decidingRuleId?: string;
  /** Rule ids in the order evaluated, up to and including the deciding rule. */
  readonly evaluatedRuleIds: ReadonlyArray<string>;
  /** Epoch milliseconds (from `AdmissionGateOptions.clock`). */
  readonly timestamp: number;
  /** Verbatim from the deciding decision when present. */
  readonly reason?: string;
}

/**
 * A single admission rule. The `evaluate` predicate is PURE per §3.4 —
 * implementations MUST NOT perform I/O and MUST be referentially
 * transparent over `DispatchCtx`.
 *
 * @see specs/wu-l-admission-rule-evaluator.md §3.1
 * @see specs/wu-l-admission-rule-evaluator.md §3.4
 */
export interface AdmissionRule {
  readonly id: string;
  evaluate(ctx: DispatchCtx): AdmissionDecision;
}

/**
 * Ordered set of rules; first-deny-wins applies within and across layers
 * per §3.2.
 *
 * @see specs/wu-l-admission-rule-evaluator.md §3.2
 */
export interface AdmissionLayer {
  readonly id: string;
  readonly rules: ReadonlyArray<AdmissionRule>;
}

/**
 * Ordered set of layers; evaluated top-down. `defer` falls through to
 * the next rule; full fall-through resolves to `deny`
 * (security-conservative, per §3.2 / §6.9 §3.5).
 *
 * @see specs/wu-l-admission-rule-evaluator.md §3.2
 */
export interface AdmissionStack {
  readonly layers: ReadonlyArray<AdmissionLayer>;
}
