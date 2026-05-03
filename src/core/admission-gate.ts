/**
 * WU-L AdmissionGate — pure-evaluator wrapper around an AdmissionStack.
 *
 * Binding contract per specs/wu-l-admission-rule-evaluator.md (active).
 * This module is the runtime entry point for admission evaluation; it
 * performs NO I/O of its own (the `emitTrace` callback is supplied by
 * the caller and is the only sink), and it does NOT wire itself into
 * any chokepoint — wiring is the responsibility of WU-L Step D.
 *
 * Precedence: see {@link AdmissionGate.evaluate} for the first-deny-wins
 * algorithm derived from spec §3.2.
 *
 * @see specs/wu-l-admission-rule-evaluator.md §3
 * @see specs/wu-l-admission-rule-evaluator.md §6.9
 */

import type {
  AdmissionDecision,
  AdmissionStack,
  AdmissionTrace,
  AdmissionTrigger,
  AdmissionVerdict,
  DispatchCtx,
} from '../contracts/admission-rule.js';

/**
 * Construction options for {@link AdmissionGate}.
 *
 * @see specs/wu-l-admission-rule-evaluator.md §3.4
 * @see specs/wu-l-admission-rule-evaluator.md §3.6
 */
export interface AdmissionGateOptions {
  readonly stack: AdmissionStack;
  /** Audit sink; defaults to a no-op. The gate performs no other I/O. */
  readonly emitTrace?: (trace: AdmissionTrace) => void;
  /** Clock source for trace timestamps; defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Override the deterministic context-hasher used for §3.4 idempotency. */
  readonly hashCtx?: (ctx: DispatchCtx) => string;
}

/**
 * Operator (T4) re-evaluation request envelope.
 *
 * @see specs/wu-l-admission-rule-evaluator.md §3.1.1 (T4)
 */
export interface ReevaluationRequest {
  readonly taskId: string;
  readonly reason: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** No-op default for `emitTrace`. */
const NOOP_EMIT = (_trace: AdmissionTrace): void => {
  /* intentionally empty */
};

/**
 * Default deterministic context hash. Includes only decision-relevant
 * fields; `reason` is intentionally excluded per §3.4 (informational).
 */
function defaultHashCtx(ctx: DispatchCtx): string {
  const sortedTraits = [...ctx.traits].sort();
  const sortedMetadata = Object.keys(ctx.metadata)
    .sort()
    .map((key) => [key, ctx.metadata[key]] as const);
  const payload = {
    taskId: ctx.taskId,
    trigger: ctx.trigger,
    chokepoint: ctx.chokepoint ?? null,
    attempt: ctx.attempt,
    traits: sortedTraits,
    metadata: sortedMetadata,
  };
  return JSON.stringify(payload);
}

/**
 * AdmissionGate — evaluates a {@link DispatchCtx} against the configured
 * stack and emits an audit trace per §3.6.
 *
 * The gate is stateless beyond its construction-time configuration;
 * idempotency (§3.4) is a property of the deterministic stack + pure
 * predicates + deterministic context hash, not of internal caching.
 */
export class AdmissionGate {
  private readonly stack: AdmissionStack;
  private emitTrace: (trace: AdmissionTrace) => void;
  private readonly clock: () => number;
  private readonly hashCtx: (ctx: DispatchCtx) => string;

  public constructor(options: AdmissionGateOptions) {
    this.stack = options.stack;
    this.emitTrace = options.emitTrace ?? NOOP_EMIT;
    this.clock = options.clock ?? Date.now;
    this.hashCtx = options.hashCtx ?? defaultHashCtx;
  }

  /**
   * Evaluate the supplied dispatch context against the stack and emit a
   * trace.
   *
   * Algorithm (derived from spec §3.2 — "first-deny-wins" with
   * security-conservative fall-through):
   *
   * 1. Walk every rule in stack-flattened order
   *    (`layers[0].rules ++ layers[1].rules ++ ...`).
   * 2. The **first** rule returning `deny` short-circuits — the verdict
   *    is `deny`. Subsequent rules are not evaluated.
   * 3. Otherwise, the **first** rule returning `admit` is remembered as
   *    the candidate verdict, but evaluation continues so a later `deny`
   *    can still win (per the strict reading of §3.2 within-layer
   *    short-circuit-on-deny + cross-layer continuation).
   * 4. If evaluation completes with a remembered admit and no deny, the
   *    verdict is `admit`.
   * 5. If every rule returned `defer` (or the stack is empty), the
   *    verdict is `deny` (full fall-through, security-conservative,
   *    per §3.2 / §6.9 §3.5).
   *
   * @see specs/wu-l-admission-rule-evaluator.md §3.2
   * @see specs/wu-l-admission-rule-evaluator.md §3.6
   */
  /**
   * Evaluate plus capture the audit trace that was emitted. The
   * configured `emitTrace` sink still fires for audit; the captured
   * trace is additionally returned so callers (e.g. WU-L Step D
   * chokepoints) can attach it to a thrown `AdmissionDeniedError`
   * without subscribing to the global audit channel.
   */
  public evaluateAndCaptureTrace(
    ctx: DispatchCtx,
  ): { decision: AdmissionDecision; trace: AdmissionTrace } {
    let captured: AdmissionTrace | undefined;
    const userEmit = this.emitTrace;
    this.emitTrace = (trace: AdmissionTrace) => {
      captured = trace;
      userEmit(trace);
    };
    let decision: AdmissionDecision;
    try {
      decision = this.evaluate(ctx);
    } finally {
      this.emitTrace = userEmit;
    }
    // `evaluate` always emits exactly one trace per call (admit, deny,
    // or fall-through), so `captured` is guaranteed defined here.
    return { decision, trace: captured as AdmissionTrace };
  }

  public evaluate(ctx: DispatchCtx): AdmissionDecision {
    const evaluatedRuleIds: string[] = [];
    let firstAdmit: AdmissionDecision | undefined;

    for (const layer of this.stack.layers) {
      for (const rule of layer.rules) {
        const decision = rule.evaluate(ctx);
        evaluatedRuleIds.push(rule.id);

        if (decision.verdict === 'deny') {
          this.emit(ctx, decision.verdict, rule.id, evaluatedRuleIds, decision.reason);
          return this.normalize(decision, ctx.trigger, rule.id);
        }
        if (decision.verdict === 'admit' && firstAdmit === undefined) {
          firstAdmit = this.normalize(decision, ctx.trigger, rule.id);
        }
        // 'defer' → continue
      }
    }

    if (firstAdmit !== undefined) {
      this.emit(
        ctx,
        'admit',
        firstAdmit.ruleId,
        evaluatedRuleIds,
        firstAdmit.reason,
      );
      return firstAdmit;
    }

    // Full fall-through → security-conservative deny.
    const fallThrough: AdmissionDecision = {
      verdict: 'deny',
      ruleId: '__fall_through__',
      triggerId: ctx.trigger,
      reason: 'admission stack fell through with no non-defer decision',
    };
    this.emit(ctx, 'deny', undefined, evaluatedRuleIds, fallThrough.reason);
    return fallThrough;
  }

  /**
   * Synthesize a `DispatchCtx` for an operator (T4) re-evaluation
   * signal. The caller is expected to merge plan-derived fields
   * (notably `traits` and any pre-fetched `metadata` snapshots) onto the
   * returned context before passing it to {@link evaluate}.
   *
   * The returned context carries `attempt: 0` because re-evaluation is
   * not an attempt-count increment (T3 owns retry semantics, when wired
   * by WU-V).
   *
   * @see specs/wu-l-admission-rule-evaluator.md §3.1.1 (T4)
   */
  public requestReevaluation(req: ReevaluationRequest): DispatchCtx {
    return {
      taskId: req.taskId,
      trigger: 'T4_ExplicitReevaluation',
      attempt: 0,
      traits: [],
      metadata: req.metadata ?? {},
      reason: req.reason,
    };
  }

  /** Force-stamp `triggerId` and `ruleId` from the rule's identity. */
  private normalize(
    decision: AdmissionDecision,
    trigger: AdmissionTrigger,
    ruleId: string,
  ): AdmissionDecision {
    return {
      verdict: decision.verdict,
      ruleId,
      triggerId: trigger,
      reason: decision.reason,
      metadata: decision.metadata,
    };
  }

  /** Emit an audit trace (§3.6). */
  private emit(
    ctx: DispatchCtx,
    verdict: AdmissionVerdict,
    decidingRuleId: string | undefined,
    evaluatedRuleIds: ReadonlyArray<string>,
    reason: string | undefined,
  ): void {
    const trace: AdmissionTrace = {
      taskId: ctx.taskId,
      trigger: ctx.trigger,
      chokepoint: ctx.chokepoint,
      attempt: ctx.attempt,
      ctxHash: this.hashCtx(ctx),
      verdict,
      decidingRuleId,
      evaluatedRuleIds: [...evaluatedRuleIds],
      timestamp: this.clock(),
      reason,
    };
    this.emitTrace(trace);
  }
}

// Re-export helper for tests / advanced callers that wish to derive the
// same hash the gate uses internally for §3.4 dedup keys.
export { defaultHashCtx };

// Re-export the typed deny error so chokepoint authors only need to
// import from the gate module.
export { AdmissionDeniedError } from './admission-denied-error.js';

// Type-only re-exports so consumers importing the gate need not reach
// into `../contracts/admission-rule.js` for the companion shapes.
export type {
  AdmissionDecision,
  AdmissionRule,
  AdmissionStack,
  AdmissionTrace,
  AdmissionTrigger,
  AdmissionVerdict,
  DispatchCtx,
} from '../contracts/admission-rule.js';
