/**
 * Plana runtime advisor port.
 *
 * The advisor is a *read-only* second-opinion component invoked by Plana
 * during `consumeRuntimeStream`. It receives sampled `RuntimeEvent`s for the
 * dispatched task and may issue a `veto` verdict that Plana lifts into a
 * `VetoPath` to halt dispatch.
 *
 * Invariants per `specs/CLARIFICATIONS/multi-provider-scope.md` §Advisor 패턴:
 *   - The advisor MUST NOT spawn its own dispatch.
 *   - The advisor MUST NOT call tools, write files, or invoke MCP servers.
 *   - The advisor MUST NOT recurse (an advisor cannot consult another advisor).
 *   - Advisor failures MUST fail-open ('approve' verdict). The advisor must
 *     not be able to block dispatched task progress through its own outage.
 *   - Cost is bounded: the advisor implementation is responsible for its own
 *     per-dispatch call cap; Plana does not enforce a separate cap.
 */

import type { AgentInstance } from '../contracts/runtime-driver.js';
import type { RuntimeEvent } from '../contracts/runtime-event.js';
import type { DispatchPlan } from './task.js';

export interface PlanaAdvisorInput {
  readonly plan: DispatchPlan;
  readonly instance: AgentInstance;
  readonly event: RuntimeEvent;
}

export interface PlanaAdvisorVerdictApprove {
  readonly status: 'approve';
}

export interface PlanaAdvisorVerdictVeto {
  readonly status: 'veto';
  readonly reason: string;
  readonly provenance: string;
}

export interface PlanaAdvisorVerdictSkip {
  readonly status: 'skip';
}

export type PlanaAdvisorVerdict =
  | PlanaAdvisorVerdictApprove
  | PlanaAdvisorVerdictVeto
  | PlanaAdvisorVerdictSkip;

export interface PlanaRuntimeAdvisor {
  /**
   * Review one runtime event. Implementations decide whether the event is
   * worth advising on (sampling) and return `'skip'` to indicate the event
   * was not consulted. `'approve'` means the event was consulted and the
   * advisor's verdict is to allow dispatch to continue.
   */
  review(input: PlanaAdvisorInput): Promise<PlanaAdvisorVerdict>;
}

/**
 * No-op advisor. Returns `'skip'` for every event. Used as a default when no
 * advisor is configured so consumer code can stay unconditional.
 */
export const NULL_PLANA_RUNTIME_ADVISOR: PlanaRuntimeAdvisor = {
  // eslint-disable-next-line @typescript-eslint/require-await -- PlanaRuntimeAdvisor.review must be Promise<PlanaAdvisorVerdict>; this null implementation has no async work.
  async review(): Promise<PlanaAdvisorVerdict> {
    return { status: 'skip' };
  },
};
