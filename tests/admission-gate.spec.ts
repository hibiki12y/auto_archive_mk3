/**
 * WU-L Step G — comprehensive AdmissionGate test suite.
 *
 * Covers acceptance criteria AC-L1..AC-L5 plus enumerated edge cases
 * derived from `specs/wu-l-admission-rule-evaluator.md` §3 and §10.
 *
 * Style mirrors `tests/plana-trait-consumer.spec.ts` (vitest
 * describe/it/expect, locally-defined helpers, no production helpers
 * imported beyond the public surfaces).
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  AdmissionDeniedError,
  AdmissionGate,
  defaultHashCtx,
  type AdmissionDecision,
  type AdmissionRule,
  type AdmissionStack,
  type AdmissionTrace,
  type AdmissionTrigger,
  type AdmissionVerdict,
  type DispatchCtx,
  type ReevaluationRequest,
} from '../src/core/admission-gate.js';
import type { ChokepointKind } from '../src/contracts/admission-rule.js';

// ---------------------------------------------------------------------------
// Local helpers (per task brief)
// ---------------------------------------------------------------------------

const makeRule = (
  id: string,
  verdict: AdmissionVerdict,
  reason?: string,
): AdmissionRule => ({
  id,
  evaluate: () => ({
    verdict,
    ruleId: id,
    triggerId: 'T1_DispatcherEntry',
    reason,
  }),
});

const makeCtx = (overrides: Partial<DispatchCtx> = {}): DispatchCtx => ({
  taskId: 'task-001',
  trigger: 'T1_DispatcherEntry',
  attempt: 1,
  traits: [],
  metadata: {},
  ...overrides,
});

const makeStack = (...rulesByLayer: AdmissionRule[][]): AdmissionStack => ({
  layers: rulesByLayer.map((rules, i) => ({ id: `layer-${i}`, rules })),
});

const captureTraces = (): {
  traces: AdmissionTrace[];
  emit: (t: AdmissionTrace) => void;
} => {
  const traces: AdmissionTrace[] = [];
  return { traces, emit: (t) => traces.push(t) };
};

const fixedClock = (t: number): (() => number) => () => t;

// A spy rule that records every ctx it sees and returns a configurable
// verdict. Used for evaluation-order and short-circuit assertions.
function spyRule(
  id: string,
  verdict: AdmissionVerdict,
  log: string[],
  reason?: string,
): AdmissionRule {
  return {
    id,
    evaluate: (ctx) => {
      log.push(id);
      return {
        verdict,
        ruleId: id,
        triggerId: ctx.trigger,
        reason,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// AC-L1: layered rule evaluation
// ---------------------------------------------------------------------------

describe('AdmissionGate — AC-L1: layered rule evaluation', () => {
  it('evaluates rules in stack-flatten order (layer 0 then layer 1)', () => {
    const log: string[] = [];
    const stack = makeStack(
      [spyRule('a', 'admit', log), spyRule('b', 'defer', log)],
      [spyRule('c', 'defer', log), spyRule('d', 'admit', log)],
    );
    const gate = new AdmissionGate({ stack });
    gate.evaluate(makeCtx());
    expect(log).toEqual(['a', 'b', 'c', 'd']);
  });

  it('single-layer single-rule admit returns admit', () => {
    const stack = makeStack([makeRule('only', 'admit', 'ok')]);
    const gate = new AdmissionGate({ stack });
    const decision = gate.evaluate(makeCtx());
    expect(decision.verdict).toBe('admit');
    expect(decision.ruleId).toBe('only');
    expect(decision.reason).toBe('ok');
  });

  it('single-layer single-rule deny returns deny', () => {
    const stack = makeStack([makeRule('only', 'deny', 'nope')]);
    const gate = new AdmissionGate({ stack });
    const decision = gate.evaluate(makeCtx());
    expect(decision.verdict).toBe('deny');
    expect(decision.ruleId).toBe('only');
    expect(decision.reason).toBe('nope');
  });

  it('empty stack falls through to deny per §3.5 fall-through rule', () => {
    const stack = makeStack();
    const { traces, emit } = captureTraces();
    const gate = new AdmissionGate({ stack, emitTrace: emit });
    const decision = gate.evaluate(makeCtx());
    expect(decision.verdict).toBe('deny');
    expect(decision.ruleId).toBe('__fall_through__');
    expect(traces).toHaveLength(1);
    expect(traces[0]?.verdict).toBe('deny');
    expect(traces[0]?.decidingRuleId).toBeUndefined();
    expect(traces[0]?.evaluatedRuleIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-L2: first-deny-wins precedence per §3.2
// ---------------------------------------------------------------------------

describe('AdmissionGate — AC-L2: first-deny-wins precedence per §3.2', () => {
  it('first deny across all rules short-circuits the result regardless of preceding admits', () => {
    const log: string[] = [];
    const stack = makeStack([
      spyRule('a1', 'admit', log),
      spyRule('d1', 'deny', log, 'blocked'),
      spyRule('a2', 'admit', log),
    ]);
    const gate = new AdmissionGate({ stack });
    const decision = gate.evaluate(makeCtx());
    expect(decision.verdict).toBe('deny');
    expect(decision.ruleId).toBe('d1');
    // a2 must NOT be evaluated post short-circuit.
    expect(log).toEqual(['a1', 'd1']);
  });

  it('deny in layer 0 prevents layer 1 evaluation', () => {
    const log: string[] = [];
    const stack = makeStack(
      [spyRule('l0-a', 'admit', log), spyRule('l0-d', 'deny', log)],
      [spyRule('l1-a', 'admit', log)],
    );
    const gate = new AdmissionGate({ stack });
    gate.evaluate(makeCtx());
    expect(log).toEqual(['l0-a', 'l0-d']);
  });

  it('admit followed by deny still resolves to deny (the binding rule)', () => {
    const stack = makeStack([
      makeRule('a', 'admit'),
      makeRule('d', 'deny', 'win'),
    ]);
    const gate = new AdmissionGate({ stack });
    const decision = gate.evaluate(makeCtx());
    expect(decision.verdict).toBe('deny');
    expect(decision.ruleId).toBe('d');
  });

  it('deny followed by admit resolves to deny (short-circuit; later admit cannot override)', () => {
    const log: string[] = [];
    const stack = makeStack([
      spyRule('d', 'deny', log, 'first'),
      spyRule('a', 'admit', log),
    ]);
    const gate = new AdmissionGate({ stack });
    const decision = gate.evaluate(makeCtx());
    expect(decision.verdict).toBe('deny');
    expect(decision.ruleId).toBe('d');
    expect(log).toEqual(['d']);
  });

  it('all admits with no deny resolves to admit', () => {
    const stack = makeStack([
      makeRule('a1', 'admit', 'first-admit'),
      makeRule('a2', 'admit', 'second-admit'),
    ]);
    const gate = new AdmissionGate({ stack });
    const decision = gate.evaluate(makeCtx());
    expect(decision.verdict).toBe('admit');
    // Spec §3.2: first admit binds when no later deny appears.
    expect(decision.ruleId).toBe('a1');
    expect(decision.reason).toBe('first-admit');
  });

  it('trace.evaluatedRuleIds includes only rules evaluated up to and including the deciding rule', () => {
    const { traces, emit } = captureTraces();
    const stack = makeStack([
      makeRule('a', 'admit'),
      makeRule('d', 'deny', 'short'),
      makeRule('never', 'admit'),
    ]);
    const gate = new AdmissionGate({ stack, emitTrace: emit });
    gate.evaluate(makeCtx());
    expect(traces).toHaveLength(1);
    expect(traces[0]?.evaluatedRuleIds).toEqual(['a', 'd']);
    expect(traces[0]?.decidingRuleId).toBe('d');
  });
});

// ---------------------------------------------------------------------------
// AC-L3: defer fall-through per §3.5
// ---------------------------------------------------------------------------

describe('AdmissionGate — AC-L3: defer fall-through per §3.5', () => {
  it('all defers fall through to deny', () => {
    const stack = makeStack([
      makeRule('d1', 'defer'),
      makeRule('d2', 'defer'),
    ]);
    const gate = new AdmissionGate({ stack });
    const decision = gate.evaluate(makeCtx());
    expect(decision.verdict).toBe('deny');
    expect(decision.ruleId).toBe('__fall_through__');
  });

  it('defer + admit + defer resolves to admit (defer is non-blocking)', () => {
    const stack = makeStack([
      makeRule('d1', 'defer'),
      makeRule('a', 'admit', 'binds'),
      makeRule('d2', 'defer'),
    ]);
    const gate = new AdmissionGate({ stack });
    const decision = gate.evaluate(makeCtx());
    expect(decision.verdict).toBe('admit');
    expect(decision.ruleId).toBe('a');
  });

  it('defer + deny resolves to deny', () => {
    const stack = makeStack([
      makeRule('d', 'defer'),
      makeRule('x', 'deny', 'blocked'),
    ]);
    const gate = new AdmissionGate({ stack });
    const decision = gate.evaluate(makeCtx());
    expect(decision.verdict).toBe('deny');
    expect(decision.ruleId).toBe('x');
  });

  it('trace records the deciding rule on partial defers', () => {
    const { traces, emit } = captureTraces();
    const stack = makeStack([
      makeRule('d1', 'defer'),
      makeRule('a', 'admit', 'r'),
      makeRule('d2', 'defer'),
    ]);
    const gate = new AdmissionGate({ stack, emitTrace: emit });
    gate.evaluate(makeCtx());
    expect(traces[0]?.decidingRuleId).toBe('a');
    expect(traces[0]?.verdict).toBe('admit');
    // Evaluation continues past the admit so a later deny could win;
    // therefore evaluatedRuleIds includes the trailing defer too.
    expect(traces[0]?.evaluatedRuleIds).toEqual(['d1', 'a', 'd2']);
  });
});

// ---------------------------------------------------------------------------
// AC-L4: pre-side-effect invocation contract — gate is pure
// ---------------------------------------------------------------------------

describe('AdmissionGate — AC-L4: pre-side-effect invocation contract', () => {
  it('evaluate() does not invoke any non-rule callback besides emitTrace', () => {
    const { traces, emit } = captureTraces();
    let hashCalls = 0;
    let clockCalls = 0;
    const stack = makeStack([makeRule('a', 'admit')]);
    const gate = new AdmissionGate({
      stack,
      emitTrace: emit,
      clock: () => {
        clockCalls += 1;
        return 42;
      },
      hashCtx: () => {
        hashCalls += 1;
        return 'h';
      },
    });
    gate.evaluate(makeCtx());
    // Exactly one trace, one clock read (timestamp), one hash.
    expect(traces).toHaveLength(1);
    expect(clockCalls).toBe(1);
    expect(hashCalls).toBe(1);
  });

  it("evaluate() never returns 'defer' as a final verdict (always resolves to admit/deny)", () => {
    const cases: AdmissionStack[] = [
      makeStack([makeRule('d', 'defer')]),
      makeStack([makeRule('d1', 'defer'), makeRule('d2', 'defer')]),
      makeStack(),
      makeStack([makeRule('a', 'admit')]),
      makeStack([makeRule('x', 'deny')]),
    ];
    for (const stack of cases) {
      const gate = new AdmissionGate({ stack });
      const v = gate.evaluate(makeCtx()).verdict;
      expect(v === 'admit' || v === 'deny').toBe(true);
    }
  });

  it('evaluate() returns synchronously (no Promise)', () => {
    const stack = makeStack([makeRule('a', 'admit')]);
    const gate = new AdmissionGate({ stack });
    // Type-level: evaluate returns AdmissionDecision (not Promise).
    expectTypeOf(gate.evaluate).returns.toEqualTypeOf<AdmissionDecision>();
    // Runtime: result is a plain object, not a thenable.
    const result = gate.evaluate(makeCtx()) as unknown;
    expect(typeof (result as { then?: unknown }).then).toBe('undefined');
  });

  it('evaluate() with same ctx hash returns identical decision (idempotency per §3.4)', () => {
    const stack = makeStack([makeRule('a', 'admit', 'because')]);
    const gate = new AdmissionGate({ stack });
    const ctx = makeCtx();
    const a = gate.evaluate(ctx);
    const b = gate.evaluate(ctx);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// AC-L5 / §3.6 audit trace
// ---------------------------------------------------------------------------

describe('AdmissionGate — AC-L5 / §3.6 audit trace', () => {
  it('every evaluate() call emits exactly one AdmissionTrace via emitTrace', () => {
    const { traces, emit } = captureTraces();
    const stack = makeStack([makeRule('a', 'admit')]);
    const gate = new AdmissionGate({ stack, emitTrace: emit });
    gate.evaluate(makeCtx());
    gate.evaluate(makeCtx());
    gate.evaluate(makeCtx());
    expect(traces).toHaveLength(3);
  });

  it('trace.ctxHash matches custom hashCtx output if provided', () => {
    const { traces, emit } = captureTraces();
    const stack = makeStack([makeRule('a', 'admit')]);
    const gate = new AdmissionGate({
      stack,
      emitTrace: emit,
      hashCtx: () => 'CUSTOM-HASH',
    });
    gate.evaluate(makeCtx());
    expect(traces[0]?.ctxHash).toBe('CUSTOM-HASH');
  });

  it('trace.evaluatedRuleIds reflects evaluation order', () => {
    const { traces, emit } = captureTraces();
    const stack = makeStack(
      [makeRule('a', 'defer'), makeRule('b', 'admit')],
      [makeRule('c', 'defer')],
    );
    const gate = new AdmissionGate({ stack, emitTrace: emit });
    gate.evaluate(makeCtx());
    expect(traces[0]?.evaluatedRuleIds).toEqual(['a', 'b', 'c']);
  });

  it('trace.timestamp uses provided clock', () => {
    const { traces, emit } = captureTraces();
    const stack = makeStack([makeRule('a', 'admit')]);
    const gate = new AdmissionGate({
      stack,
      emitTrace: emit,
      clock: fixedClock(1_700_000_000_000),
    });
    gate.evaluate(makeCtx());
    expect(traces[0]?.timestamp).toBe(1_700_000_000_000);
  });

  it('trace.chokepoint is undefined for non-T2 triggers', () => {
    const { traces, emit } = captureTraces();
    const stack = makeStack([makeRule('a', 'admit')]);
    const gate = new AdmissionGate({ stack, emitTrace: emit });
    gate.evaluate(makeCtx({ trigger: 'T1_DispatcherEntry' }));
    expect(traces[0]?.chokepoint).toBeUndefined();
  });

  it('trace.chokepoint is set for T2_ChokepointCrossing triggers', () => {
    const { traces, emit } = captureTraces();
    const stack = makeStack([makeRule('a', 'admit')]);
    const gate = new AdmissionGate({ stack, emitTrace: emit });
    gate.evaluate(
      makeCtx({
        trigger: 'T2_ChokepointCrossing',
        chokepoint: 'tool-invoke',
      }),
    );
    expect(traces[0]?.chokepoint).toBe('tool-invoke');
    expect(traces[0]?.trigger).toBe('T2_ChokepointCrossing');
  });

  it('trace.decidingRuleId is undefined on full fall-through (no rules)', () => {
    const { traces, emit } = captureTraces();
    const stack = makeStack();
    const gate = new AdmissionGate({ stack, emitTrace: emit });
    gate.evaluate(makeCtx());
    expect(traces[0]?.decidingRuleId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// requestReevaluation — T4 API
// ---------------------------------------------------------------------------

describe('AdmissionGate.requestReevaluation — T4 API', () => {
  const gate = new AdmissionGate({ stack: makeStack([makeRule('a', 'admit')]) });

  it("synthesizes a DispatchCtx with trigger='T4_ExplicitReevaluation'", () => {
    const ctx = gate.requestReevaluation({ taskId: 't', reason: 'r' });
    expect(ctx.trigger).toBe('T4_ExplicitReevaluation');
  });

  it('preserves taskId from request', () => {
    const ctx = gate.requestReevaluation({ taskId: 'task-xyz', reason: 'r' });
    expect(ctx.taskId).toBe('task-xyz');
  });

  it('preserves reason from request', () => {
    const ctx = gate.requestReevaluation({
      taskId: 't',
      reason: 'operator override',
    });
    expect(ctx.reason).toBe('operator override');
  });

  it('merges metadata from request (defaults to empty object)', () => {
    const withMeta = gate.requestReevaluation({
      taskId: 't',
      reason: 'r',
      metadata: { ticket: 'OPS-42' },
    });
    expect(withMeta.metadata).toEqual({ ticket: 'OPS-42' });
    const withoutMeta = gate.requestReevaluation({ taskId: 't', reason: 'r' });
    expect(withoutMeta.metadata).toEqual({});
  });

  it('sets attempt=0 and traits=[]', () => {
    const ctx = gate.requestReevaluation({ taskId: 't', reason: 'r' });
    expect(ctx.attempt).toBe(0);
    expect(ctx.traits).toEqual([]);
  });

  it('returned ctx is a valid DispatchCtx (passes through evaluate without throwing)', () => {
    const req: ReevaluationRequest = { taskId: 't', reason: 'r' };
    const ctx = gate.requestReevaluation(req);
    expect(() => gate.evaluate(ctx)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Trigger context coverage — T1, T2(×3 chokepoints), T4, T5
// ---------------------------------------------------------------------------

interface TriggerCase {
  readonly label: string;
  readonly trigger: AdmissionTrigger;
  readonly chokepoint?: ChokepointKind;
}

const TRIGGER_CASES: ReadonlyArray<TriggerCase> = [
  { label: 'T1_DispatcherEntry', trigger: 'T1_DispatcherEntry' },
  {
    label: 'T2_ChokepointCrossing[compute-submit]',
    trigger: 'T2_ChokepointCrossing',
    chokepoint: 'compute-submit',
  },
  {
    label: 'T2_ChokepointCrossing[tool-invoke]',
    trigger: 'T2_ChokepointCrossing',
    chokepoint: 'tool-invoke',
  },
  {
    label: 'T2_ChokepointCrossing[delivery]',
    trigger: 'T2_ChokepointCrossing',
    chokepoint: 'delivery',
  },
  { label: 'T4_ExplicitReevaluation', trigger: 'T4_ExplicitReevaluation' },
  { label: 'T5_ResourceExhaustion', trigger: 'T5_ResourceExhaustion' },
];

describe('AdmissionGate — trigger context coverage', () => {
  for (const tc of TRIGGER_CASES) {
    it(`evaluates with trigger=${tc.label} and the rule sees that trigger value`, () => {
      let observed: AdmissionTrigger | undefined;
      const rule: AdmissionRule = {
        id: 'observer',
        evaluate: (ctx) => {
          observed = ctx.trigger;
          return {
            verdict: 'admit',
            ruleId: 'observer',
            triggerId: ctx.trigger,
          };
        },
      };
      const gate = new AdmissionGate({ stack: makeStack([rule]) });
      const decision = gate.evaluate(
        makeCtx({ trigger: tc.trigger, chokepoint: tc.chokepoint }),
      );
      expect(observed).toBe(tc.trigger);
      expect(decision.triggerId).toBe(tc.trigger);
    });

    it(`trace records trigger=${tc.label}`, () => {
      const { traces, emit } = captureTraces();
      const gate = new AdmissionGate({
        stack: makeStack([makeRule('a', 'admit')]),
        emitTrace: emit,
      });
      gate.evaluate(makeCtx({ trigger: tc.trigger, chokepoint: tc.chokepoint }));
      expect(traces[0]?.trigger).toBe(tc.trigger);
      if (tc.chokepoint !== undefined) {
        expect(traces[0]?.chokepoint).toBe(tc.chokepoint);
      } else {
        expect(traces[0]?.chokepoint).toBeUndefined();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// AdmissionDeniedError — Step D throw payload
// ---------------------------------------------------------------------------

describe('AdmissionDeniedError — Step D throw payload', () => {
  function buildDenyArtifacts(): {
    decision: AdmissionDecision;
    trace: AdmissionTrace;
  } {
    const { traces, emit } = captureTraces();
    const stack = makeStack([makeRule('rule-x', 'deny', 'because policy')]);
    const gate = new AdmissionGate({
      stack,
      emitTrace: emit,
      clock: fixedClock(1234),
    });
    const { decision, trace } = gate.evaluateAndCaptureTrace(
      makeCtx({ trigger: 'T2_ChokepointCrossing', chokepoint: 'tool-invoke' }),
    );
    expect(traces).toHaveLength(1);
    return { decision, trace };
  }

  it('constructs with decision and trace fields preserved', () => {
    const { decision, trace } = buildDenyArtifacts();
    const err = new AdmissionDeniedError(decision, trace);
    expect(err.decision).toBe(decision);
    expect(err.trace).toBe(trace);
  });

  it("name === 'AdmissionDeniedError'", () => {
    const { decision, trace } = buildDenyArtifacts();
    const err = new AdmissionDeniedError(decision, trace);
    expect(err.name).toBe('AdmissionDeniedError');
  });

  it('message includes ruleId, triggerId, and reason', () => {
    const { decision, trace } = buildDenyArtifacts();
    const err = new AdmissionDeniedError(decision, trace);
    expect(err.message).toContain('rule-x');
    expect(err.message).toContain('T2_ChokepointCrossing');
    expect(err.message).toContain('because policy');
  });

  it('instanceof Error and instanceof AdmissionDeniedError', () => {
    const { decision, trace } = buildDenyArtifacts();
    const err = new AdmissionDeniedError(decision, trace);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AdmissionDeniedError);
  });

  it('evaluateAndCaptureTrace returns both decision and trace for caller to wrap', () => {
    const stack = makeStack([makeRule('rule-x', 'deny', 'no')]);
    const gate = new AdmissionGate({ stack });
    const { decision, trace } = gate.evaluateAndCaptureTrace(makeCtx());
    expect(decision.verdict).toBe('deny');
    expect(trace).toEqual(
      expect.objectContaining({
        verdict: 'deny',
        decidingRuleId: 'rule-x',
        evaluatedRuleIds: ['rule-x'],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// admit→deny flip semantics per §3.5 — re-evaluation, not mutation
// ---------------------------------------------------------------------------

describe('AdmissionGate — admit→deny flip semantics per §3.5', () => {
  it('calling evaluate twice with same ctx returns same decision (deterministic)', () => {
    const stack = makeStack([makeRule('a', 'admit', 'ok')]);
    const gate = new AdmissionGate({ stack });
    const ctx = makeCtx({ metadata: { gate: 'open' } });
    expect(gate.evaluate(ctx)).toEqual(gate.evaluate(ctx));
  });

  it('calling evaluate with updated metadata can flip admit→deny', () => {
    // A rule that consults ctx.metadata.gate === 'denied' to flip.
    const flipRule: AdmissionRule = {
      id: 'gate-flag',
      evaluate: (ctx) => ({
        verdict: ctx.metadata.gate === 'denied' ? 'deny' : 'admit',
        ruleId: 'gate-flag',
        triggerId: ctx.trigger,
        reason: ctx.metadata.gate === 'denied' ? 'flag flipped' : 'flag open',
      }),
    };
    const gate = new AdmissionGate({ stack: makeStack([flipRule]) });
    const before = gate.evaluate(makeCtx({ metadata: { gate: 'open' } }));
    const after = gate.evaluate(makeCtx({ metadata: { gate: 'denied' } }));
    expect(before.verdict).toBe('admit');
    expect(after.verdict).toBe('deny');
  });

  it('the gate itself does not retain decision state between calls', () => {
    // The same gate evaluated with two different ctxs must emit two
    // independent traces with the verdict each ctx implies — no
    // observable caching of the prior decision.
    const flipRule: AdmissionRule = {
      id: 'flag',
      evaluate: (ctx) => ({
        verdict: ctx.metadata.x === 'no' ? 'deny' : 'admit',
        ruleId: 'flag',
        triggerId: ctx.trigger,
      }),
    };
    const { traces, emit } = captureTraces();
    const gate = new AdmissionGate({
      stack: makeStack([flipRule]),
      emitTrace: emit,
    });
    gate.evaluate(makeCtx({ metadata: { x: 'yes' } }));
    gate.evaluate(makeCtx({ metadata: { x: 'no' } }));
    gate.evaluate(makeCtx({ metadata: { x: 'yes' } }));
    expect(traces.map((t) => t.verdict)).toEqual(['admit', 'deny', 'admit']);
  });
});

// ---------------------------------------------------------------------------
// Idempotency per §3.4 and ctxHash semantics
// ---------------------------------------------------------------------------

describe('AdmissionGate — idempotency per §3.4 and ctxHash', () => {
  it('default hashCtx produces stable hash for same ctx', () => {
    const ctx = makeCtx({ traits: ['x', 'y'], metadata: { a: 1, b: 2 } });
    expect(defaultHashCtx(ctx)).toBe(defaultHashCtx(ctx));
  });

  it('default hashCtx produces different hash for different traits', () => {
    const a = makeCtx({ traits: ['x'] });
    const b = makeCtx({ traits: ['y'] });
    expect(defaultHashCtx(a)).not.toBe(defaultHashCtx(b));
  });

  it('default hashCtx produces different hash for different metadata values', () => {
    const a = makeCtx({ metadata: { quota: 10 } });
    const b = makeCtx({ metadata: { quota: 11 } });
    expect(defaultHashCtx(a)).not.toBe(defaultHashCtx(b));
  });

  it('default hashCtx is INSENSITIVE to reason field (informational, not a decision input)', () => {
    const a = makeCtx({ reason: 'first' });
    const b = makeCtx({ reason: 'second' });
    expect(defaultHashCtx(a)).toBe(defaultHashCtx(b));
  });

  it('default hashCtx is INSENSITIVE to metadata key ordering (deterministic JSON sort)', () => {
    const a = makeCtx({ metadata: { alpha: 1, beta: 2, gamma: 3 } });
    const b = makeCtx({ metadata: { gamma: 3, beta: 2, alpha: 1 } });
    expect(defaultHashCtx(a)).toBe(defaultHashCtx(b));
  });

  it('default hashCtx is INSENSITIVE to traits array ordering (deterministic sort)', () => {
    const a = makeCtx({ traits: ['z', 'a', 'm'] });
    const b = makeCtx({ traits: ['a', 'm', 'z'] });
    expect(defaultHashCtx(a)).toBe(defaultHashCtx(b));
  });

  it('custom hashCtx is used when provided', () => {
    const { traces, emit } = captureTraces();
    const gate = new AdmissionGate({
      stack: makeStack([makeRule('a', 'admit')]),
      emitTrace: emit,
      hashCtx: (ctx) => `custom:${ctx.taskId}`,
    });
    gate.evaluate(makeCtx({ taskId: 'task-XYZ' }));
    expect(traces[0]?.ctxHash).toBe('custom:task-XYZ');
  });
});

// ---------------------------------------------------------------------------
// Spec-AC traceability — explicit AC-L1..AC-L4 mapping per
// specs/wu-l-admission-rule-evaluator.md §5 (active).
//
// These tests are deliberately labelled with the AC they evidence so
// post-hoc audits can trace spec conformance to a runnable assertion.
// ---------------------------------------------------------------------------

describe('WU-L spec conformance — AC-L1 rule schema (§3.1)', () => {
  it('AC-L1: every decision carries a ruleId, triggerId, verdict, and optional reason', () => {
    const stack = makeStack([makeRule('r-admit', 'admit', 'ok')]);
    const gate = new AdmissionGate({ stack });
    const d = gate.evaluate(makeCtx());
    expect(d.ruleId).toBe('r-admit');
    expect(d.triggerId).toBe('T1_DispatcherEntry');
    expect(d.verdict).toBe('admit');
    expect(d.reason).toBe('ok');
  });

  it('AC-L1: ternary verdict space {admit, deny, defer} is preserved by rules', () => {
    const verdicts: AdmissionVerdict[] = ['admit', 'deny', 'defer'];
    for (const v of verdicts) {
      const rule = makeRule(`r-${v}`, v, `rationale-${v}`);
      const out = rule.evaluate(makeCtx());
      expect(out.verdict).toBe(v);
      expect(out.reason).toBe(`rationale-${v}`);
    }
  });
});

describe('WU-L spec conformance — AC-L2 layering & first-deny-wins (§3.2)', () => {
  it('AC-L2: multi-layer defer precedence — layer0 all-defer falls through to layer1 admit', () => {
    const log: string[] = [];
    const stack = makeStack(
      [spyRule('L0-d1', 'defer', log), spyRule('L0-d2', 'defer', log)],
      [spyRule('L1-a', 'admit', log, 'binds')],
    );
    const gate = new AdmissionGate({ stack });
    const d = gate.evaluate(makeCtx());
    expect(d.verdict).toBe('admit');
    expect(d.ruleId).toBe('L1-a');
    expect(log).toEqual(['L0-d1', 'L0-d2', 'L1-a']);
  });

  it('AC-L2: multi-layer first-deny-wins across layers — layer0 defer, layer1 deny short-circuits layer2', () => {
    const log: string[] = [];
    const stack = makeStack(
      [spyRule('L0-d', 'defer', log)],
      [spyRule('L1-x', 'deny', log, 'blocked')],
      [spyRule('L2-never', 'admit', log)],
    );
    const gate = new AdmissionGate({ stack });
    const d = gate.evaluate(makeCtx());
    expect(d.verdict).toBe('deny');
    expect(d.ruleId).toBe('L1-x');
    expect(d.reason).toBe('blocked');
    // L2 must not be consulted once a deny has short-circuited.
    expect(log).toEqual(['L0-d', 'L1-x']);
  });

  it('AC-L2: security-conservative fall-through — empty stack resolves to deny', () => {
    const gate = new AdmissionGate({ stack: makeStack() });
    const d = gate.evaluate(makeCtx());
    expect(d.verdict).toBe('deny');
  });

  it('AC-L2: admit in layer0 + deny in layer1 — deny still wins (first-deny-wins beats prior admit)', () => {
    const stack = makeStack(
      [makeRule('L0-a', 'admit', 'prelim-ok')],
      [makeRule('L1-x', 'deny', 'final-block')],
    );
    const gate = new AdmissionGate({ stack });
    const d = gate.evaluate(makeCtx());
    expect(d.verdict).toBe('deny');
    expect(d.ruleId).toBe('L1-x');
    expect(d.reason).toBe('final-block');
  });
});

describe('WU-L spec conformance — AC-L3 pre-side-effect callable surface (§4, §6.9)', () => {
  // AC-L3 itself asserts that chokepoints call admission before side
  // effects; those assertions live in dispatcher + compute-node specs
  // (tests/dispatcher-admission-task-id, wu-x, wu-y). Here we pin the
  // gate's callable surface so it remains usable at all five triggers.
  const ALL_TRIGGERS: AdmissionTrigger[] = [
    'T1_DispatcherEntry',
    'T2_ChokepointCrossing',
    'T3_RetryAttempt',
    'T4_ExplicitReevaluation',
    'T5_ResourceExhaustion',
  ];

  for (const trigger of ALL_TRIGGERS) {
    it(`AC-L3: gate.evaluate accepts ${trigger} synchronously and returns a non-defer verdict`, () => {
      const gate = new AdmissionGate({
        stack: makeStack([makeRule('a', 'admit', 'ok')]),
      });
      const chokepoint: ChokepointKind | undefined =
        trigger === 'T2_ChokepointCrossing' ? 'compute-submit' : undefined;
      const d = gate.evaluate(makeCtx({ trigger, chokepoint }));
      expect(d.verdict === 'admit' || d.verdict === 'deny').toBe(true);
      expect(d.triggerId).toBe(trigger);
    });
  }

  it('AC-L3: T3_RetryAttempt callable surface — gate is usable today (caller wiring is WU-V)', () => {
    // Cleanliness: the enum value is accepted, the trace records T3,
    // no special-case branch. Caller wiring at a real retry coordinator
    // is deferred to WU-V per §7 — the gate does not synthesize T3
    // itself.
    const { traces, emit } = captureTraces();
    const gate = new AdmissionGate({
      stack: makeStack([makeRule('a', 'admit', 'retry-ok')]),
      emitTrace: emit,
    });
    const d = gate.evaluate(
      makeCtx({ trigger: 'T3_RetryAttempt', attempt: 2 }),
    );
    expect(d.verdict).toBe('admit');
    expect(d.triggerId).toBe('T3_RetryAttempt');
    expect(traces[0]?.trigger).toBe('T3_RetryAttempt');
    expect(traces[0]?.attempt).toBe(2);
  });
});

describe('WU-L spec conformance — AC-L4 audit trace (§3.3 / §3.6)', () => {
  it('AC-L4: admit path emits a trace with verbatim reason and deciding ruleId', () => {
    const { traces, emit } = captureTraces();
    const stack = makeStack([makeRule('a', 'admit', 'verbatim-admit-reason')]);
    const gate = new AdmissionGate({
      stack,
      emitTrace: emit,
      clock: fixedClock(42),
    });
    gate.evaluate(makeCtx());
    expect(traces).toHaveLength(1);
    expect(traces[0]).toEqual(
      expect.objectContaining({
        verdict: 'admit',
        decidingRuleId: 'a',
        reason: 'verbatim-admit-reason',
        timestamp: 42,
      }),
    );
  });

  it('AC-L4: deny path emits a trace with verbatim reason and deciding ruleId', () => {
    const { traces, emit } = captureTraces();
    const stack = makeStack([
      makeRule('a', 'defer'),
      makeRule('x', 'deny', 'verbatim-deny-reason'),
    ]);
    const gate = new AdmissionGate({ stack, emitTrace: emit });
    gate.evaluate(makeCtx());
    expect(traces[0]).toEqual(
      expect.objectContaining({
        verdict: 'deny',
        decidingRuleId: 'x',
        reason: 'verbatim-deny-reason',
        evaluatedRuleIds: ['a', 'x'],
      }),
    );
  });

  it('AC-L4: full fall-through emits a trace with decidingRuleId undefined and the fall-through reason', () => {
    const { traces, emit } = captureTraces();
    const stack = makeStack([makeRule('d1', 'defer'), makeRule('d2', 'defer')]);
    const gate = new AdmissionGate({ stack, emitTrace: emit });
    gate.evaluate(makeCtx());
    expect(traces).toHaveLength(1);
    expect(traces[0]?.verdict).toBe('deny');
    expect(traces[0]?.decidingRuleId).toBeUndefined();
    expect(traces[0]?.evaluatedRuleIds).toEqual(['d1', 'd2']);
    expect(typeof traces[0]?.reason).toBe('string');
    expect(traces[0]?.reason).toContain('fell through');
  });

  it('AC-L4: trace records every rule consulted up to the deciding rule — multi-layer case', () => {
    const { traces, emit } = captureTraces();
    const stack = makeStack(
      [makeRule('L0-d', 'defer')],
      [makeRule('L1-d', 'defer'), makeRule('L1-x', 'deny', 'stop')],
      [makeRule('L2-never', 'admit')],
    );
    const gate = new AdmissionGate({ stack, emitTrace: emit });
    gate.evaluate(makeCtx());
    // Only rules up to and including L1-x are evaluated.
    expect(traces[0]?.evaluatedRuleIds).toEqual(['L0-d', 'L1-d', 'L1-x']);
    expect(traces[0]?.decidingRuleId).toBe('L1-x');
  });

  it('AC-L4: trace is emitted for every evaluate() — including pure-admit and fall-through paths', () => {
    const { traces, emit } = captureTraces();
    const stacks: AdmissionStack[] = [
      makeStack([makeRule('a', 'admit')]),               // pure admit
      makeStack([makeRule('x', 'deny')]),                // pure deny
      makeStack([makeRule('d', 'defer')]),               // fall-through
      makeStack(),                                       // empty (fall-through)
    ];
    for (const stack of stacks) {
      const gate = new AdmissionGate({ stack, emitTrace: emit });
      gate.evaluate(makeCtx());
    }
    expect(traces).toHaveLength(4);
    expect(traces.map((t) => t.verdict)).toEqual([
      'admit',
      'deny',
      'deny',
      'deny',
    ]);
  });
});
