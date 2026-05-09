import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DiscordFollowController,
  renderFollowEventBatch,
  renderFollowIdleTimeout,
  renderFollowTerminal,
  type DiscordFollowSchedulerHandle,
  type DiscordFollowSchedulerPort,
} from '../src/discord/discord-follow-controller.js';
import { InMemoryControlPlaneLedger } from '../src/control/control-plane-ledger.js';
import type { DiscordMessagePayload } from '../src/discord/discord-result-renderer.js';

// UX-15 (cycle 7) — `/follow task_id:<id>` controller invariants.
// All tests use a fake scheduler so `tick(...)` is driven directly.

class FakeScheduler implements DiscordFollowSchedulerPort {
  public nowMs = 1_000_000_000_000;
  public callbacks: Array<() => void | Promise<void>> = [];
  public clearedHandles = 0;

  setInterval(callback: () => void | Promise<void>): DiscordFollowSchedulerHandle {
    this.callbacks.push(callback);
    return {
      clear: () => {
        this.clearedHandles += 1;
      },
    };
  }
  now(): number {
    return this.nowMs;
  }
  advance(ms: number): void {
    this.nowMs += ms;
  }
}

class CapturingDeliver {
  public payloads: DiscordMessagePayload[] = [];
  public throwNext = false;
  followUp(payload: DiscordMessagePayload): Promise<unknown> {
    if (this.throwNext) {
      this.throwNext = false;
      return Promise.reject(new Error('discord 5xx'));
    }
    this.payloads.push(payload);
    return Promise.resolve({});
  }
}

describe('DiscordFollowController.start', () => {
  let scheduler: FakeScheduler;
  let ledger: InMemoryControlPlaneLedger;

  beforeEach(() => {
    scheduler = new FakeScheduler();
    ledger = new InMemoryControlPlaneLedger();
  });

  it('returns started for a fresh subscription and registers a scheduler handle', () => {
    const controller = new DiscordFollowController({ ledger, scheduler });
    const result = controller.start({
      taskId: 'task-A',
      userId: 'user-1',
      deliver: new CapturingDeliver(),
    });
    expect(result.status).toBe('started');
    expect(scheduler.callbacks.length).toBe(1);
    expect(controller.list()).toHaveLength(1);
  });

  it('returns already-following when the same taskId is started twice', () => {
    const controller = new DiscordFollowController({ ledger, scheduler });
    controller.start({
      taskId: 'task-A',
      userId: 'user-1',
      deliver: new CapturingDeliver(),
    });
    const second = controller.start({
      taskId: 'task-A',
      userId: 'user-1',
      deliver: new CapturingDeliver(),
    });
    expect(second.status).toBe('already-following');
    expect(controller.list()).toHaveLength(1);
  });

  it('enforces per-user cap (default 3) without affecting other users', () => {
    const controller = new DiscordFollowController({
      ledger,
      scheduler,
      perUserCap: 2,
    });
    controller.start({ taskId: 't1', userId: 'user-1', deliver: new CapturingDeliver() });
    controller.start({ taskId: 't2', userId: 'user-1', deliver: new CapturingDeliver() });
    const third = controller.start({
      taskId: 't3',
      userId: 'user-1',
      deliver: new CapturingDeliver(),
    });
    expect(third).toEqual({ status: 'cap-reached', cap: 2 });
    // Different user is unaffected.
    const otherUser = controller.start({
      taskId: 't4',
      userId: 'user-2',
      deliver: new CapturingDeliver(),
    });
    expect(otherUser.status).toBe('started');
  });
});

describe('DiscordFollowController.tick', () => {
  let scheduler: FakeScheduler;
  let ledger: InMemoryControlPlaneLedger;

  beforeEach(() => {
    scheduler = new FakeScheduler();
    ledger = new InMemoryControlPlaneLedger();
  });

  function append(taskId: string, type: 'task.lifecycle_observed' | 'task.terminal', extra: Record<string, unknown> = {}): void {
    scheduler.advance(1);
    ledger.append({
      type,
      actor: { kind: 'system' },
      trust: { source: 'system', inputTrust: 'trusted' },
      taskId,
      payload: extra,
      timestamp: new Date(scheduler.nowMs).toISOString(),
    });
  }

  it('delivers a one-line-per-event batch when new events appear', async () => {
    const controller = new DiscordFollowController({ ledger, scheduler });
    const deliver = new CapturingDeliver();
    controller.start({ taskId: 'task-A', userId: 'user-1', deliver });
    append('task-A', 'task.lifecycle_observed', { phase: 'starting' });
    append('task-A', 'task.lifecycle_observed', { phase: 'running' });
    await controller.tick('task-A');
    expect(deliver.payloads).toHaveLength(1);
    expect(deliver.payloads[0]!.content).toContain('task-A');
    expect(deliver.payloads[0]!.content).toContain('phase=starting');
    expect(deliver.payloads[0]!.content).toContain('phase=running');
  });

  it('does not re-deliver the same event on the next tick (loadSince inclusive shift)', async () => {
    const controller = new DiscordFollowController({ ledger, scheduler });
    const deliver = new CapturingDeliver();
    controller.start({ taskId: 'task-A', userId: 'user-1', deliver });
    append('task-A', 'task.lifecycle_observed', { phase: 'starting' });
    await controller.tick('task-A');
    expect(deliver.payloads).toHaveLength(1);
    // No new events between ticks.
    await controller.tick('task-A');
    expect(deliver.payloads).toHaveLength(1);
  });

  it('skips events for other taskIds (per-task isolation)', async () => {
    const controller = new DiscordFollowController({ ledger, scheduler });
    const deliver = new CapturingDeliver();
    controller.start({ taskId: 'task-A', userId: 'user-1', deliver });
    append('task-B', 'task.lifecycle_observed', { phase: 'running' });
    await controller.tick('task-A');
    expect(deliver.payloads).toHaveLength(0);
  });

  it('posts a terminal message and unsubscribes on task.terminal', async () => {
    const controller = new DiscordFollowController({ ledger, scheduler });
    const deliver = new CapturingDeliver();
    controller.start({ taskId: 'task-A', userId: 'user-1', deliver });
    append('task-A', 'task.terminal', { cause: { kind: 'success' } });
    await controller.tick('task-A');
    expect(deliver.payloads).toHaveLength(2);
    // First payload is the batch summary (📡), second is the terminal (✅/⛔).
    expect(deliver.payloads[0]!.content).toMatch(/📡/);
    expect(deliver.payloads[1]!.content).toMatch(/✅/);
    expect(deliver.payloads[1]!.content).toContain('cause: success');
    expect(controller.list()).toHaveLength(0);
    expect(scheduler.clearedHandles).toBe(1);
  });

  it('counts deliver errors but keeps the subscription alive (transient 5xx tolerance)', async () => {
    const controller = new DiscordFollowController({ ledger, scheduler });
    const deliver = new CapturingDeliver();
    controller.start({ taskId: 'task-A', userId: 'user-1', deliver });
    append('task-A', 'task.lifecycle_observed', { phase: 'starting' });
    deliver.throwNext = true;
    await controller.tick('task-A');
    const snapshot = controller.list()[0]!;
    expect(snapshot.deliverErrorCount).toBe(1);
    // Subscription is still alive; another event + tick still delivers.
    append('task-A', 'task.lifecycle_observed', { phase: 'running' });
    await controller.tick('task-A');
    expect(deliver.payloads).toHaveLength(1);
  });

  it('triggers idle-stop after idleTimeoutMs of silence and unsubscribes', async () => {
    const controller = new DiscordFollowController({
      ledger,
      scheduler,
      idleTimeoutMs: 1_000,
    });
    const deliver = new CapturingDeliver();
    controller.start({ taskId: 'task-A', userId: 'user-1', deliver });
    expect(controller.list()).toHaveLength(1);
    // Advance past idle threshold without any new events.
    scheduler.advance(2_000);
    await controller.tick('task-A');
    expect(deliver.payloads).toHaveLength(1);
    expect(deliver.payloads[0]!.content).toMatch(/⏸️/);
    expect(deliver.payloads[0]!.content).toContain('follow stopped');
    expect(controller.list()).toHaveLength(0);
    expect(scheduler.clearedHandles).toBe(1);
  });
});

describe('DiscordFollowController.stop', () => {
  it('clears the scheduler handle and removes the subscription', () => {
    const scheduler = new FakeScheduler();
    const controller = new DiscordFollowController({
      ledger: new InMemoryControlPlaneLedger(),
      scheduler,
    });
    controller.start({ taskId: 'task-A', userId: 'user-1', deliver: new CapturingDeliver() });
    expect(controller.stop('task-A')).toBe(true);
    expect(scheduler.clearedHandles).toBe(1);
    expect(controller.list()).toHaveLength(0);
    // Stopping again is a no-op.
    expect(controller.stop('task-A')).toBe(false);
  });
});

describe('Follow renderer helpers', () => {
  it('renderFollowEventBatch produces a 📡 header + one bullet per event', () => {
    const payload = renderFollowEventBatch({
      taskId: 'task-A',
      events: [
        {
          schemaVersion: 1,
          eventId: 'e1',
          timestamp: '2026-05-09T00:00:00.000Z',
          type: 'task.lifecycle_observed',
          actor: { kind: 'system' },
          trust: { source: 'system', inputTrust: 'trusted' },
          taskId: 'task-A',
          payload: { phase: 'starting' },
        },
      ],
    });
    expect(payload.content).toContain('📡');
    expect(payload.content).toContain('1 new event');
    expect(payload.content).toContain('phase=starting');
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it('renderFollowTerminal labels success vs non-success and includes a /status hint', () => {
    const success = renderFollowTerminal({
      taskId: 'task-A',
      terminalEvent: {
        schemaVersion: 1,
        eventId: 'e1',
        timestamp: '2026-05-09T00:00:00.000Z',
        type: 'task.terminal',
        actor: { kind: 'system' },
        trust: { source: 'system', inputTrust: 'trusted' },
        taskId: 'task-A',
        payload: { cause: { kind: 'success' } },
      },
    });
    expect(success.content).toMatch(/✅/);
    expect(success.content).toContain('cause: success');
    expect(success.content).toContain('/status task_id:<id>');
    const failed = renderFollowTerminal({
      taskId: 'task-A',
      terminalEvent: {
        schemaVersion: 1,
        eventId: 'e2',
        timestamp: '2026-05-09T00:00:00.000Z',
        type: 'task.terminal',
        actor: { kind: 'system' },
        trust: { source: 'system', inputTrust: 'trusted' },
        taskId: 'task-A',
        payload: { cause: { kind: 'provider-failure' } },
      },
    });
    expect(failed.content).toMatch(/⛔/);
    expect(failed.content).toContain('cause: provider-failure');
  });

  it('renderFollowIdleTimeout reports approximate idle minutes + reopen hint', () => {
    const payload = renderFollowIdleTimeout({
      taskId: 'task-A',
      idleForMs: 5 * 60 * 1_000,
    });
    expect(payload.content).toContain('~5 min');
    expect(payload.content).toContain('/follow task_id:<id>');
  });
});

// Suppress unused-imports lint when CI runs a strict no-unused-vars rule.
void vi;
