/**
 * M6 — InsightsEngine unit tests.
 *
 * Validates that the engine aggregates control-plane ledger events into a
 * coherent operational snapshot:
 *   - totalTasks counts unique task.requested events in window
 *   - causeBreakdown classifies task.terminal events by cause.kind
 *   - successRate = successCount / totalTasks (NaN if no tasks)
 *   - averageDurationMs only when both requested+terminal are in window
 *   - topFailureReasons aggregates by reason text, top 3
 *   - window filtering ('1d', '7d', '30d', 'all') respected
 */
import { describe, expect, it } from 'vitest';

import {
  InMemoryControlPlaneLedger,
  type ControlPlaneEventInput,
} from '../src/control/control-plane-ledger.js';
import { InsightsEngine } from '../src/runtime/insights-engine.js';

function buildRequestedEvent(
  taskId: string,
  timestamp: string,
): ControlPlaneEventInput {
  return {
    type: 'task.requested',
    actor: { kind: 'discord-user', userId: 'tester' },
    channel: { kind: 'discord' },
    taskId,
    trust: { source: 'discord', inputTrust: 'untrusted' },
    payload: { instruction: `instruction for ${taskId}` },
    timestamp,
  };
}

function buildTerminalEvent(
  taskId: string,
  timestamp: string,
  cause: Record<string, unknown>,
): ControlPlaneEventInput {
  return {
    type: 'task.terminal',
    actor: { kind: 'system' },
    channel: { kind: 'system' },
    taskId,
    trust: { source: 'system', inputTrust: 'trusted' },
    payload: { cause },
    timestamp,
  };
}

function freshLedger(events: ControlPlaneEventInput[]): InMemoryControlPlaneLedger {
  const ledger = new InMemoryControlPlaneLedger();
  for (const event of events) {
    ledger.append(event);
  }
  return ledger;
}

const FIXED_NOW = new Date('2026-05-01T12:00:00.000Z');

function fixedClock(): Date {
  return FIXED_NOW;
}

describe('InsightsEngine.snapshot()', () => {
  it('returns a zero-task snapshot when the ledger is empty', () => {
    const engine = new InsightsEngine(freshLedger([]), { clock: fixedClock });
    const snap = engine.snapshot('7d');

    expect(snap.totalTasks).toBe(0);
    expect(Number.isNaN(snap.successRate)).toBe(true);
    expect(snap.averageDurationMs).toBeUndefined();
    expect(snap.topFailureReasons).toEqual([]);
    expect(Object.values(snap.causeBreakdown).every((v) => v === 0)).toBe(true);
  });

  it('counts unique task.requested events in window', () => {
    const ledger = freshLedger([
      buildRequestedEvent('task-A', '2026-04-29T12:00:00.000Z'),
      buildRequestedEvent('task-B', '2026-04-30T12:00:00.000Z'),
      buildRequestedEvent('task-C', '2026-05-01T11:00:00.000Z'),
    ]);
    const snap = new InsightsEngine(ledger, { clock: fixedClock }).snapshot('7d');
    expect(snap.totalTasks).toBe(3);
  });

  it('classifies terminal events by cause.kind', () => {
    const ledger = freshLedger([
      buildRequestedEvent('task-1', '2026-05-01T10:00:00.000Z'),
      buildTerminalEvent('task-1', '2026-05-01T10:01:00.000Z', {
        kind: 'success',
        taskId: 'task-1',
      }),
      buildRequestedEvent('task-2', '2026-05-01T10:00:00.000Z'),
      buildTerminalEvent('task-2', '2026-05-01T10:02:00.000Z', {
        kind: 'provider-failure',
        taskId: 'task-2',
        reason: 'rate limited',
      }),
      buildRequestedEvent('task-3', '2026-05-01T10:00:00.000Z'),
      buildTerminalEvent('task-3', '2026-05-01T10:03:00.000Z', {
        kind: 'timeout',
        taskId: 'task-3',
        reason: 'deadline exceeded',
      }),
    ]);
    const snap = new InsightsEngine(ledger, { clock: fixedClock }).snapshot('7d');
    expect(snap.totalTasks).toBe(3);
    expect(snap.causeBreakdown.success).toBe(1);
    expect(snap.causeBreakdown['provider-failure']).toBe(1);
    expect(snap.causeBreakdown.timeout).toBe(1);
    expect(snap.successRate).toBeCloseTo(1 / 3, 5);
  });

  it('computes averageDurationMs from requested→terminal deltas', () => {
    const ledger = freshLedger([
      buildRequestedEvent('task-A', '2026-05-01T10:00:00.000Z'),
      buildTerminalEvent('task-A', '2026-05-01T10:00:10.000Z', {
        kind: 'success',
        taskId: 'task-A',
      }),
      buildRequestedEvent('task-B', '2026-05-01T10:00:00.000Z'),
      buildTerminalEvent('task-B', '2026-05-01T10:00:30.000Z', {
        kind: 'success',
        taskId: 'task-B',
      }),
    ]);
    const snap = new InsightsEngine(ledger, { clock: fixedClock }).snapshot('7d');
    expect(snap.averageDurationMs).toBe((10_000 + 30_000) / 2);
  });

  it('aggregates top 3 failure reasons by occurrence count', () => {
    const events: ControlPlaneEventInput[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(
        buildRequestedEvent(`a-${i}`, '2026-05-01T10:00:00.000Z'),
        buildTerminalEvent(`a-${i}`, '2026-05-01T10:00:01.000Z', {
          kind: 'provider-failure',
          taskId: `a-${i}`,
          reason: 'Rate limited',
        }),
      );
    }
    for (let i = 0; i < 3; i++) {
      events.push(
        buildRequestedEvent(`b-${i}`, '2026-05-01T10:00:00.000Z'),
        buildTerminalEvent(`b-${i}`, '2026-05-01T10:00:01.000Z', {
          kind: 'timeout',
          taskId: `b-${i}`,
          reason: 'deadline exceeded',
        }),
      );
    }
    for (let i = 0; i < 2; i++) {
      events.push(
        buildRequestedEvent(`c-${i}`, '2026-05-01T10:00:00.000Z'),
        buildTerminalEvent(`c-${i}`, '2026-05-01T10:00:01.000Z', {
          kind: 'driver-failure',
          taskId: `c-${i}`,
          reason: 'driver crashed',
        }),
      );
    }
    for (let i = 0; i < 1; i++) {
      events.push(
        buildRequestedEvent(`d-${i}`, '2026-05-01T10:00:00.000Z'),
        buildTerminalEvent(`d-${i}`, '2026-05-01T10:00:01.000Z', {
          kind: 'runtime-veto',
          taskId: `d-${i}`,
          reason: 'observer veto',
        }),
      );
    }

    const snap = new InsightsEngine(freshLedger(events), {
      clock: fixedClock,
    }).snapshot('7d');

    expect(snap.topFailureReasons).toHaveLength(3);
    expect(snap.topFailureReasons[0]).toEqual({
      reason: 'rate limited',
      count: 5,
    });
    expect(snap.topFailureReasons[1]).toEqual({
      reason: 'deadline exceeded',
      count: 3,
    });
    expect(snap.topFailureReasons[2]).toEqual({
      reason: 'driver crashed',
      count: 2,
    });
  });

  it('respects 1d window filtering — older events are excluded', () => {
    const ledger = freshLedger([
      buildRequestedEvent('task-old', '2026-04-25T10:00:00.000Z'),
      buildTerminalEvent('task-old', '2026-04-25T10:00:01.000Z', {
        kind: 'success',
        taskId: 'task-old',
      }),
      buildRequestedEvent('task-recent', '2026-05-01T11:00:00.000Z'),
      buildTerminalEvent('task-recent', '2026-05-01T11:00:01.000Z', {
        kind: 'success',
        taskId: 'task-recent',
      }),
    ]);
    const engine = new InsightsEngine(ledger, { clock: fixedClock });
    const oneDay = engine.snapshot('1d');
    const sevenDay = engine.snapshot('7d');
    const all = engine.snapshot('all');
    expect(oneDay.totalTasks).toBe(1);
    expect(sevenDay.totalTasks).toBe(2);
    expect(all.totalTasks).toBe(2);
  });

  it('returns ISO window bounds aligned with the clock', () => {
    const ledger = freshLedger([]);
    const snap = new InsightsEngine(ledger, { clock: fixedClock }).snapshot('1d');
    expect(snap.windowEnd).toBe('2026-05-01T12:00:00.000Z');
    expect(new Date(snap.windowStart).getTime()).toBe(
      FIXED_NOW.getTime() - 24 * 60 * 60 * 1000,
    );
  });
});
