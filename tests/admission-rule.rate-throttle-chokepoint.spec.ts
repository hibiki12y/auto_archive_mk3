/**
 * PR5 — `'rate-throttle'` chokepoint admission rule 단위 테스트.
 *
 * 책임 범위:
 *   - `ChokepointKind` enum이 `'rate-throttle'` 값을 받아들임 (compile-time + runtime).
 *   - `createRateThrottleAdmissionRule()` defer/admit/deny 분기.
 *   - 다른 trigger / chokepoint에서는 항상 defer (격리).
 *   - `metadata` pre-fetch 누락 시 defer (caller 의무).
 *
 * Spec: `specs/CURRENT/dispatcher-rate-throttle.md`.
 *
 * 회귀 보호: `tests/admission-gate.spec.ts`의 기존 chokepoint 동작은 별도 보존.
 */

import { describe, expect, it } from 'vitest';

import {
  AdmissionGate,
  type DispatchCtx,
} from '../src/core/admission-gate.js';
import {
  createRateThrottleAdmissionRule,
  RATE_THROTTLE_QUOTA_AVAILABLE_KEY,
  RATE_THROTTLE_RULE_ID,
} from '../src/core/rate-throttle-rule.js';
import type { ChokepointKind } from '../src/contracts/admission-rule.js';

const makeCtx = (overrides: Partial<DispatchCtx>): DispatchCtx => ({
  taskId: 'task-rt-001',
  trigger: 'T1_DispatcherEntry',
  attempt: 1,
  traits: [],
  metadata: {},
  ...overrides,
});

describe('ChokepointKind widening — rate-throttle', () => {
  it('accepts the new literal at the type level', () => {
    const c: ChokepointKind = 'rate-throttle';
    expect(c).toBe('rate-throttle');
  });

  it('preserves the three pre-existing chokepoint values', () => {
    const a: ChokepointKind = 'compute-submit';
    const b: ChokepointKind = 'tool-invoke';
    const d: ChokepointKind = 'delivery';
    expect([a, b, d]).toEqual(['compute-submit', 'tool-invoke', 'delivery']);
  });
});

describe('createRateThrottleAdmissionRule — id and defaults', () => {
  it('defaults rule id to "rate-throttle"', () => {
    const rule = createRateThrottleAdmissionRule();
    expect(rule.id).toBe(RATE_THROTTLE_RULE_ID);
  });

  it('honors override rule id', () => {
    const rule = createRateThrottleAdmissionRule({ id: 'rate-throttle-test' });
    expect(rule.id).toBe('rate-throttle-test');
  });
});

describe('createRateThrottleAdmissionRule — chokepoint scope (격리)', () => {
  const rule = createRateThrottleAdmissionRule();

  it('defers when trigger is not T2_ChokepointCrossing', () => {
    const decision = rule.evaluate(
      makeCtx({
        trigger: 'T1_DispatcherEntry',
        chokepoint: undefined,
        metadata: { [RATE_THROTTLE_QUOTA_AVAILABLE_KEY]: false },
      }),
    );
    expect(decision.verdict).toBe('defer');
    expect(decision.ruleId).toBe(RATE_THROTTLE_RULE_ID);
  });

  it('defers on T4 (operator escalation) regardless of metadata', () => {
    const decision = rule.evaluate(
      makeCtx({
        trigger: 'T4_ExplicitReevaluation',
        chokepoint: undefined,
        metadata: { [RATE_THROTTLE_QUOTA_AVAILABLE_KEY]: false },
      }),
    );
    expect(decision.verdict).toBe('defer');
  });

  it('defers when T2 fires for a different chokepoint kind', () => {
    const decision = rule.evaluate(
      makeCtx({
        trigger: 'T2_ChokepointCrossing',
        chokepoint: 'compute-submit',
        metadata: { [RATE_THROTTLE_QUOTA_AVAILABLE_KEY]: false },
      }),
    );
    expect(decision.verdict).toBe('defer');
  });
});

describe('createRateThrottleAdmissionRule — verdict on rate-throttle chokepoint', () => {
  const rule = createRateThrottleAdmissionRule();

  it('admits when metadata.quotaAvailable === true', () => {
    const decision = rule.evaluate(
      makeCtx({
        trigger: 'T2_ChokepointCrossing',
        chokepoint: 'rate-throttle',
        metadata: { [RATE_THROTTLE_QUOTA_AVAILABLE_KEY]: true },
      }),
    );
    expect(decision.verdict).toBe('admit');
    expect(decision.ruleId).toBe(RATE_THROTTLE_RULE_ID);
    expect(decision.triggerId).toBe('T2_ChokepointCrossing');
  });

  it('denies when metadata.quotaAvailable === false with explicit reason', () => {
    const decision = rule.evaluate(
      makeCtx({
        trigger: 'T2_ChokepointCrossing',
        chokepoint: 'rate-throttle',
        metadata: { [RATE_THROTTLE_QUOTA_AVAILABLE_KEY]: false },
      }),
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.reason).toBe('rate-throttle quota exhausted');
  });

  it('defers when metadata.quotaAvailable is missing (caller pre-fetch obligation)', () => {
    const decision = rule.evaluate(
      makeCtx({
        trigger: 'T2_ChokepointCrossing',
        chokepoint: 'rate-throttle',
        metadata: {},
      }),
    );
    expect(decision.verdict).toBe('defer');
    expect(decision.reason).toBe(
      'rate-throttle quotaAvailable metadata absent',
    );
  });

  it('defers when metadata.quotaAvailable is non-boolean (strict typing guard)', () => {
    const decision = rule.evaluate(
      makeCtx({
        trigger: 'T2_ChokepointCrossing',
        chokepoint: 'rate-throttle',
        metadata: { [RATE_THROTTLE_QUOTA_AVAILABLE_KEY]: 'true' },
      }),
    );
    expect(decision.verdict).toBe('defer');
  });
});

describe('rate-throttle rule composes with AdmissionGate (1:1:1 보존)', () => {
  it('end-to-end deny path emits a single trace via the gate', () => {
    const traces: Array<unknown> = [];
    const rule = createRateThrottleAdmissionRule();
    const gate = new AdmissionGate({
      stack: { layers: [{ id: 'throttle-layer', rules: [rule] }] },
      emitTrace: (trace) => traces.push(trace),
    });
    const decision = gate.evaluate(
      makeCtx({
        trigger: 'T2_ChokepointCrossing',
        chokepoint: 'rate-throttle',
        metadata: { [RATE_THROTTLE_QUOTA_AVAILABLE_KEY]: false },
      }),
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.ruleId).toBe(RATE_THROTTLE_RULE_ID);
    expect(traces.length).toBe(1);
  });

  it('end-to-end admit path on T2 rate-throttle chokepoint', () => {
    const rule = createRateThrottleAdmissionRule();
    const gate = new AdmissionGate({
      stack: { layers: [{ id: 'throttle-layer', rules: [rule] }] },
    });
    const decision = gate.evaluate(
      makeCtx({
        trigger: 'T2_ChokepointCrossing',
        chokepoint: 'rate-throttle',
        metadata: { [RATE_THROTTLE_QUOTA_AVAILABLE_KEY]: true },
      }),
    );
    expect(decision.verdict).toBe('admit');
  });

  it('does not interfere with other chokepoints — gate falls through to deny when only rate-throttle rule defers', () => {
    const rule = createRateThrottleAdmissionRule();
    const gate = new AdmissionGate({
      stack: { layers: [{ id: 'throttle-layer', rules: [rule] }] },
    });
    // T2 with compute-submit chokepoint: rule defers → stack fall-through → security-conservative deny
    const decision = gate.evaluate(
      makeCtx({
        trigger: 'T2_ChokepointCrossing',
        chokepoint: 'compute-submit',
        metadata: {},
      }),
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.ruleId).toBe('__fall_through__');
  });
});
