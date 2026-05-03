/**
 * PR5 — `'rate-throttle'` chokepoint용 admission rule factory.
 *
 * Spec: `specs/CURRENT/dispatcher-rate-throttle.md`.
 *
 * 본 rule은 다음 조건일 때만 의미 있는 verdict를 반환:
 *   - `ctx.trigger === 'T2_ChokepointCrossing'`
 *   - `ctx.chokepoint === 'rate-throttle'`
 *
 * 그 외에는 항상 `defer` — 다른 chokepoint(compute-submit/tool-invoke/delivery)
 * 평가 사이클이나 다른 trigger(T1/T3/T4/T5) 평가에 끼지 않도록 격리.
 *
 * AdmissionRule §3.4 (PURE) 계약 준수:
 *   - 외부 closure state 읽지 않음.
 *   - `ctx.metadata['quotaAvailable']`만 사용 (caller가 dispatch 직전 pre-fetch).
 *   - boolean 외 raw inflight count는 metadata에 흘리지 말 것 (DT Audit ATTACK-3 가드).
 */

import type {
  AdmissionDecision,
  AdmissionRule,
  DispatchCtx,
} from '../contracts/admission-rule.js';

export const RATE_THROTTLE_RULE_ID = 'rate-throttle';
export const RATE_THROTTLE_QUOTA_AVAILABLE_KEY = 'quotaAvailable';

export interface RateThrottleAdmissionRuleOptions {
  /** Override the rule id (test/composition flexibility). Default `'rate-throttle'`. */
  readonly id?: string;
}

export function createRateThrottleAdmissionRule(
  options: RateThrottleAdmissionRuleOptions = {},
): AdmissionRule {
  const ruleId = options.id ?? RATE_THROTTLE_RULE_ID;
  return {
    id: ruleId,
    evaluate(ctx: DispatchCtx): AdmissionDecision {
      if (
        ctx.trigger !== 'T2_ChokepointCrossing' ||
        ctx.chokepoint !== 'rate-throttle'
      ) {
        return {
          verdict: 'defer',
          ruleId,
          triggerId: ctx.trigger,
        };
      }
      const available = ctx.metadata[RATE_THROTTLE_QUOTA_AVAILABLE_KEY];
      if (available === true) {
        return {
          verdict: 'admit',
          ruleId,
          triggerId: ctx.trigger,
          reason: 'rate-throttle quota available',
        };
      }
      if (available === false) {
        return {
          verdict: 'deny',
          ruleId,
          triggerId: ctx.trigger,
          reason: 'rate-throttle quota exhausted',
        };
      }
      return {
        verdict: 'defer',
        ruleId,
        triggerId: ctx.trigger,
        reason: 'rate-throttle quotaAvailable metadata absent',
      };
    },
  };
}
