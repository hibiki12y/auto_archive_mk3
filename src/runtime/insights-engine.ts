import type { ControlPlaneLedgerPort } from '../control/control-plane-ledger.js';
import {
  TERMINAL_CAUSE_KINDS,
  type TerminalCauseKind,
} from '../contracts/terminal-cause.js';

export interface InsightSnapshot {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly totalTasks: number;
  readonly causeBreakdown: Readonly<Record<TerminalCauseKind, number>>;
  readonly successRate: number; // 0..1, or NaN when totalTasks === 0
  readonly averageDurationMs: number | undefined;
  readonly topFailureReasons: ReadonlyArray<{ reason: string; count: number }>;
}

export type InsightWindow = '1d' | '7d' | '30d' | 'all';

export interface InsightsEngineHookBinding {
  readonly moduleId: string;
  readonly moduleVersion: string;
  readonly insightsSnapshotObserve: import('../contracts/trait-runtime-hook.js').TraitInsightsSnapshotObserveHook;
}

export interface InsightsEngineOptions {
  readonly clock?: () => Date;
  /** M5c — fires each time `snapshot()` returns. */
  readonly observeHooks?: ReadonlyArray<InsightsEngineHookBinding>;
}

function zeroCauseBreakdown(): Record<TerminalCauseKind, number> {
  const breakdown = {} as Record<TerminalCauseKind, number>;
  for (const kind of TERMINAL_CAUSE_KINDS) {
    breakdown[kind] = 0;
  }
  return breakdown;
}

function windowMs(window: InsightWindow): number | undefined {
  switch (window) {
    case '1d':
      return 24 * 60 * 60 * 1000;
    case '7d':
      return 7 * 24 * 60 * 60 * 1000;
    case '30d':
      return 30 * 24 * 60 * 60 * 1000;
    case 'all':
      return undefined;
  }
}

/**
 * Extract a failure reason string from the terminal event payload.
 * Supports the `cause.reason`, `cause.message`, or `cause.phase` fields
 * that appear across TerminalCause variants.
 */
function extractFailureReason(payload: Record<string, unknown>): string | undefined {
  const cause = payload['cause'];
  if (!cause || typeof cause !== 'object' || Array.isArray(cause)) {
    return undefined;
  }
  const c = cause as Record<string, unknown>;
  const kind = c['kind'];
  if (kind === 'success') {
    return undefined;
  }
  if (typeof c['reason'] === 'string' && c['reason'].length > 0) {
    return c['reason'];
  }
  if (typeof c['message'] === 'string' && c['message'].length > 0) {
    return c['message'];
  }
  if (typeof c['phase'] === 'string' && c['phase'].length > 0) {
    return c['phase'];
  }
  return undefined;
}

export class InsightsEngine {
  private readonly clock: () => Date;
  private readonly observeHooks: ReadonlyArray<InsightsEngineHookBinding>;

  constructor(
    private readonly ledger: ControlPlaneLedgerPort,
    options?: InsightsEngineOptions,
  ) {
    this.clock = options?.clock ?? (() => new Date());
    this.observeHooks = options?.observeHooks ?? [];
  }

  snapshot(window: InsightWindow = '7d'): InsightSnapshot {
    const now = this.clock();
    const windowEnd = now.toISOString();
    const durationMs = windowMs(window);
    const cutoff =
      durationMs === undefined ? undefined : new Date(now.getTime() - durationMs);
    const windowStart =
      cutoff === undefined ? new Date(0).toISOString() : cutoff.toISOString();

    const events = this.ledger.loadAll();

    // Collect events inside the window.
    const windowedEvents = events.filter((event) => {
      if (cutoff === undefined) return true;
      const ts = new Date(event.timestamp);
      return ts >= cutoff;
    });

    // Collect task.requested events to enumerate tasks and their start times.
    const taskRequestedAt = new Map<string, number>();
    for (const event of windowedEvents) {
      if (event.type === 'task.requested' && event.taskId !== undefined) {
        if (!taskRequestedAt.has(event.taskId)) {
          taskRequestedAt.set(event.taskId, new Date(event.timestamp).getTime());
        }
      }
    }

    // Collect task.terminal events for terminal cause classification.
    // taskId → first terminal event in window.
    const terminalByTask = new Map<string, typeof windowedEvents[number]>();
    for (const event of windowedEvents) {
      if (event.type === 'task.terminal' && event.taskId !== undefined) {
        if (!terminalByTask.has(event.taskId)) {
          terminalByTask.set(event.taskId, event);
        }
      }
    }

    const totalTasks = taskRequestedAt.size;
    const causeBreakdown = zeroCauseBreakdown();
    let successCount = 0;
    let durationSum = 0;
    let durationCount = 0;
    const failureReasonCounts = new Map<string, number>();

    for (const [taskId, terminalEvent] of terminalByTask) {
      const payload = terminalEvent.payload;
      const cause = payload['cause'];
      if (!cause || typeof cause !== 'object' || Array.isArray(cause)) {
        continue;
      }
      const causeRecord = cause as Record<string, unknown>;
      const kind = causeRecord['kind'];
      if (
        typeof kind === 'string' &&
        TERMINAL_CAUSE_KINDS.includes(kind as TerminalCauseKind)
      ) {
        const typedKind = kind as TerminalCauseKind;
        causeBreakdown[typedKind]++;
        if (typedKind === 'success') {
          successCount++;
        } else {
          const reason = extractFailureReason(payload);
          if (reason !== undefined) {
            const normalized = reason.trim().toLowerCase();
            failureReasonCounts.set(
              normalized,
              (failureReasonCounts.get(normalized) ?? 0) + 1,
            );
          }
        }
      }

      // Average duration: only when both task.requested and task.terminal
      // are within the window for the same taskId.
      const requestedAt = taskRequestedAt.get(taskId);
      if (requestedAt !== undefined) {
        const terminalAt = new Date(terminalEvent.timestamp).getTime();
        const delta = terminalAt - requestedAt;
        if (delta >= 0) {
          durationSum += delta;
          durationCount++;
        }
      }
    }

    const successRate = totalTasks === 0 ? NaN : successCount / totalTasks;
    const averageDurationMs =
      durationCount === 0 ? undefined : durationSum / durationCount;

    const topFailureReasons = [...failureReasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, count]) => ({ reason, count }));

    const snapshot: InsightSnapshot = {
      windowStart,
      windowEnd,
      totalTasks,
      causeBreakdown: { ...causeBreakdown },
      successRate,
      averageDurationMs,
      topFailureReasons,
    };

    // M5c — fire observe hooks after the snapshot is finalized.
    for (const binding of this.observeHooks) {
      Promise.resolve()
        .then(() =>
          binding.insightsSnapshotObserve(
            {
              moduleId: binding.moduleId as never,
              moduleVersion: binding.moduleVersion,
              observedAt: now.toISOString(),
            },
            {
              windowStart,
              windowEnd,
              totalTasks,
              successRate,
            },
          ),
        )
        .catch((error: unknown) => {
          console.warn(
            'trait-runtime-hook-threw',
            JSON.stringify({
              hook: 'insightsSnapshotObserve',
              moduleId: binding.moduleId,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        });
    }

    return snapshot;
  }
}
