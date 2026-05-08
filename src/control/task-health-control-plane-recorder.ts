import type { RuntimeStallSignal } from '../contracts/runtime-mid-cycle-observer.js';
import type {
  ControlPlaneEvent,
  ControlPlaneEventInput,
  ControlPlaneLedgerPort,
} from './control-plane-ledger.js';

export const TASK_HEALTH_STALL_CONTROL_PLANE_PHASE = 'stalled' as const;
export const TASK_HEALTH_STALL_CONTROL_PLANE_SCOPE = 'task-health' as const;
export const TASK_HEALTH_STALL_CONTROL_PLANE_PROVENANCE =
  'task-health-control-plane-recorder' as const;

export interface TaskHealthStallSignalSource {
  tick(nowMs: number): readonly RuntimeStallSignal[];
}

export interface TaskHealthControlPlaneRecorderOptions {
  /**
   * Optional diagnostic logger. Receives a stable event label and a small
   * structured context object (`taskId`, `observedAt`, `error`) so append
   * failures remain greppable without carrying raw task instructions or
   * Discord content.
   */
  readonly logger?: (
    event: 'task-health-control-plane-append-failed',
    details: Record<string, unknown>,
  ) => void;
}

export function taskHealthStallSignalToControlPlaneEventInput(
  signal: RuntimeStallSignal,
): ControlPlaneEventInput {
  return {
    type: 'task.health_stalled',
    timestamp: signal.observedAt,
    actor: { kind: 'system' },
    channel: { kind: 'system' },
    taskId: signal.taskId,
    // Runtime instance ids are the correlation surface used by terminal
    // evidence. Keep taskId as the primary task scope and instanceId as the
    // secondary correlation id instead of copying Discord/user/channel data.
    correlationId: signal.instanceId,
    trust: {
      source: 'system',
      inputTrust: 'trusted',
    },
    payload: {
      phase: TASK_HEALTH_STALL_CONTROL_PLANE_PHASE,
      scope: TASK_HEALTH_STALL_CONTROL_PLANE_SCOPE,
      provenance: TASK_HEALTH_STALL_CONTROL_PLANE_PROVENANCE,
      lastProgressAt: signal.lastProgressAt,
      thresholdMs: signal.thresholdMs,
      lastEventKind: signal.lastEventKind,
    },
  };
}

export function appendTaskHealthStallSignalsToControlPlaneLedger(
  ledger: ControlPlaneLedgerPort,
  signals: readonly RuntimeStallSignal[],
  options: TaskHealthControlPlaneRecorderOptions = {},
): readonly ControlPlaneEvent[] {
  const events: ControlPlaneEvent[] = [];
  for (const signal of signals) {
    try {
      events.push(
        ledger.append(taskHealthStallSignalToControlPlaneEventInput(signal)),
      );
    } catch (error) {
      options.logger?.('task-health-control-plane-append-failed', {
        taskId: signal.taskId,
        observedAt: signal.observedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return events;
}

export function recordTaskHealthStallsToControlPlaneLedger(
  source: TaskHealthStallSignalSource,
  ledger: ControlPlaneLedgerPort,
  nowMs: number,
  options: TaskHealthControlPlaneRecorderOptions = {},
): readonly ControlPlaneEvent[] {
  return appendTaskHealthStallSignalsToControlPlaneLedger(
    ledger,
    source.tick(nowMs),
    options,
  );
}
