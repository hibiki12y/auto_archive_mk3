import type {
  RuntimeMidCycleObservation,
  RuntimeMidCycleObserver,
  RuntimeStallSignal,
} from '../contracts/runtime-mid-cycle-observer.js';
import type { RuntimeEventKind } from '../contracts/runtime-event.js';

export const AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS =
  'AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS';

export interface TaskStallObserverOptions {
  readonly thresholdMs: number;
}

export interface TaskStallObserverSnapshotEntry {
  readonly taskId: string;
  readonly instanceId: string;
  readonly lastProgressAt: string;
  readonly lastEventKind: RuntimeEventKind;
}

interface MutableTaskStallState {
  readonly taskId: string;
  readonly instanceId: string;
  lastProgressAtMs: number;
  lastProgressAt: string;
  lastEventKind: RuntimeEventKind;
  signalEmittedForProgressAtMs?: number;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function timestampMs(observation: RuntimeMidCycleObservation): number {
  const parsed = Date.parse(observation.event.timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

export function taskStallThresholdMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  return parsePositiveInteger(env[AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS]);
}

export function isTaskStallObserverEnabledFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return taskStallThresholdMsFromEnv(env) !== undefined;
}

export class TaskStallObserver implements RuntimeMidCycleObserver {
  readonly id = 'task-stall';

  private readonly states = new Map<string, MutableTaskStallState>();

  constructor(private readonly options: TaskStallObserverOptions) {
    if (
      !Number.isInteger(options.thresholdMs) ||
      options.thresholdMs <= 0
    ) {
      throw new Error('TaskStallObserver thresholdMs must be a positive integer.');
    }
  }

  observe(observation: RuntimeMidCycleObservation): void {
    const observedMs = timestampMs(observation);
    const previous = this.states.get(observation.taskId);
    const previousProgressMs = previous?.lastProgressAtMs;
    this.states.set(observation.taskId, {
      taskId: observation.taskId,
      instanceId: observation.instanceId,
      lastProgressAtMs: observedMs,
      lastProgressAt: isoFromMs(observedMs),
      lastEventKind: observation.event.kind,
      ...(previousProgressMs === observedMs &&
      previous?.signalEmittedForProgressAtMs === observedMs
        ? { signalEmittedForProgressAtMs: observedMs }
        : {}),
    });
  }

  tick(nowMs: number): readonly RuntimeStallSignal[] {
    const signals: RuntimeStallSignal[] = [];
    for (const state of this.states.values()) {
      if (nowMs - state.lastProgressAtMs < this.options.thresholdMs) {
        continue;
      }
      if (state.signalEmittedForProgressAtMs === state.lastProgressAtMs) {
        continue;
      }
      state.signalEmittedForProgressAtMs = state.lastProgressAtMs;
      signals.push({
        taskId: state.taskId,
        instanceId: state.instanceId,
        observedAt: isoFromMs(nowMs),
        lastProgressAt: state.lastProgressAt,
        thresholdMs: this.options.thresholdMs,
        lastEventKind: state.lastEventKind,
      });
    }
    return signals;
  }

  currentStalls(nowMs: number): readonly RuntimeStallSignal[] {
    const signals: RuntimeStallSignal[] = [];
    for (const state of this.states.values()) {
      if (nowMs - state.lastProgressAtMs < this.options.thresholdMs) {
        continue;
      }
      signals.push({
        taskId: state.taskId,
        instanceId: state.instanceId,
        observedAt: isoFromMs(nowMs),
        lastProgressAt: state.lastProgressAt,
        thresholdMs: this.options.thresholdMs,
        lastEventKind: state.lastEventKind,
      });
    }
    return signals;
  }

  release(taskId: string): void {
    this.states.delete(taskId);
  }

  snapshot(): readonly TaskStallObserverSnapshotEntry[] {
    return [...this.states.values()].map((state) => ({
      taskId: state.taskId,
      instanceId: state.instanceId,
      lastProgressAt: state.lastProgressAt,
      lastEventKind: state.lastEventKind,
    }));
  }
}

export function createTaskStallObserverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TaskStallObserver | undefined {
  const thresholdMs = taskStallThresholdMsFromEnv(env);
  return thresholdMs === undefined
    ? undefined
    : new TaskStallObserver({ thresholdMs });
}
