import { describe, expect, it } from 'vitest';

import {
  DiscordSessionBindingManager,
  InMemoryControlPlaneLedger,
} from '../src/index.js';

function makeManager(opts: {
  retainTerminalAfterMs?: number;
  nowMs?: () => number;
  ledger?: InMemoryControlPlaneLedger;
}) {
  const ledger = opts.ledger ?? new InMemoryControlPlaneLedger();
  const manager = new DiscordSessionBindingManager({
    ledger,
    idleTimeoutMs: 60_000,
    maxAgeMs: 600_000,
    ...(opts.retainTerminalAfterMs !== undefined
      ? { retainTerminalAfterMs: opts.retainTerminalAfterMs }
      : {}),
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
  });
  return { manager, ledger };
}

describe('DiscordSessionBindingManager retention sweep', () => {
  it('preserves snapshot()-returns-ALL contract when retainTerminalAfterMs is unset', () => {
    const { manager } = makeManager({});
    const created = manager.focus({
      channelId: 'ch-1',
      taskId: 'task-A',
      ownerUserId: 'user-1',
    });
    expect(created.status).toBe('active');

    const releaseResult = manager.release({
      channelId: 'ch-1',
      ownerUserId: 'user-1',
    });
    expect(releaseResult.status).toBe('ok');

    expect(manager.snapshot()).toHaveLength(1);
    expect(manager.snapshot()[0]?.status).toBe('released');
  });

  it('lazily prunes terminal records past expiresAt + retainTerminalAfterMs and emits session.binding_evicted', () => {
    let nowMs = Date.parse('2026-05-04T00:00:00.000Z');
    const ledger = new InMemoryControlPlaneLedger();
    const { manager } = makeManager({
      retainTerminalAfterMs: 1_000,
      nowMs: () => nowMs,
      ledger,
    });

    manager.focus({
      channelId: 'ch-evict',
      taskId: 'task-evict',
      ownerUserId: 'user-1',
    });
    manager.release({ channelId: 'ch-evict', ownerUserId: 'user-1' });

    expect(manager.snapshot()).toHaveLength(1);

    nowMs += 60_000 + 1_001;
    expect(manager.snapshot()).toHaveLength(0);

    const evicted = ledger
      .loadAll()
      .filter((event) => event.type === 'session.binding_evicted');
    expect(evicted).toHaveLength(1);
    expect(evicted[0]?.taskId).toBe('task-evict');
  });

  it('does not prune active records during retention sweep regardless of how much wall time has passed', () => {
    let nowMs = Date.parse('2026-05-04T00:00:00.000Z');
    const ledger = new InMemoryControlPlaneLedger();
    const { manager } = makeManager({
      retainTerminalAfterMs: 500,
      nowMs: () => nowMs,
      ledger,
    });

    manager.focus({
      channelId: 'ch-active',
      taskId: 'task-active',
      ownerUserId: 'user-1',
    });

    nowMs += 24 * 60 * 60 * 1000;

    const snapshot = manager.snapshot();
    expect(snapshot).toHaveLength(1);

    const evicted = ledger
      .loadAll()
      .filter((event) => event.type === 'session.binding_evicted');
    expect(evicted).toHaveLength(0);
  });

  it('does not emit binding_evicted for pre-existing released records when retention is disabled', () => {
    const ledger = new InMemoryControlPlaneLedger();
    const { manager } = makeManager({ ledger });

    manager.focus({
      channelId: 'ch-quiet',
      taskId: 'task-quiet',
      ownerUserId: 'user-1',
    });
    manager.release({ channelId: 'ch-quiet', ownerUserId: 'user-1' });

    manager.snapshot();
    manager.snapshot();

    const evicted = ledger
      .loadAll()
      .filter((event) => event.type === 'session.binding_evicted');
    expect(evicted).toHaveLength(0);
  });
});
