import type { RuntimeEvent, RuntimeEventKind } from './runtime-event.js';

export interface RuntimeMidCycleObservation {
  readonly taskId: string;
  readonly instanceId: string;
  readonly event: RuntimeEvent;
}

export interface RuntimeStallSignal {
  readonly taskId: string;
  readonly instanceId: string;
  readonly observedAt: string;
  readonly lastProgressAt: string;
  readonly thresholdMs: number;
  readonly lastEventKind: RuntimeEventKind;
}

/**
 * Observe-only runtime health hook.
 *
 * Implementations are advisory and MUST NOT throw; hosts still wrap each
 * observer to keep a faulty observer from blocking sibling observers or task
 * execution. `release(taskId)` is mandatory so task-bound state is cleared on
 * every terminal stream path.
 */
export interface RuntimeMidCycleObserver {
  readonly id: string;
  observe(observation: RuntimeMidCycleObservation): void;
  tick?(nowMs: number): readonly RuntimeStallSignal[];
  release(taskId: string): void;
}
