import { describe, expect, it } from 'vitest';

import {
  DiscordSessionBindingManager,
  InMemoryControlPlaneLedger,
  SubagentOperatorSurface,
  createRuntimeSettingsBundle,
  createResourceEnvelope,
  createSubagentRoster,
} from '../src/index.js';

function parentContext() {
    return {
      taskId: 'task-subagent-operator',
      instanceId: 'runtime-subagent-operator',
    envelope: createResourceEnvelope({
      requested: { cpuCores: 2, memoryMiB: 1024, wallTimeSec: 300, gpuCards: 0 },
    }),
      runtimeSettings: {
        ...createRuntimeSettingsBundle({
          networkProfile: 'offline',
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
          workingDirectory: '/workspace/project',
        }),
      },
    };
  }

describe('OC-2 subagent operator and session binding surfaces', () => {
  it('caps logs map at maxLogSubagents and evicts the least-recently-logged subagent', async () => {
    const roster = createSubagentRoster(parentContext(), { maxConcurrent: 5 });
    const a = await roster.spawn({ role: 'coder' });
    const b = await roster.spawn({ role: 'coder' });
    const c = await roster.spawn({ role: 'coder' });
    const d = await roster.spawn({ role: 'coder' });
    const operator = new SubagentOperatorSurface({
      roster,
      maxLogSubagents: 3,
    });

    operator.send(a.subagentId, 'first');
    operator.send(b.subagentId, 'second');
    operator.send(c.subagentId, 'third');
    operator.send(d.subagentId, 'fourth');

    // a is the oldest by recency, evicted first.
    const aLog = operator.log(a.subagentId);
    expect(aLog).toMatchObject({ status: 'ok' });
    expect(aLog.status === 'ok' ? aLog.message : '').toContain(
      'no bounded operator log entries',
    );
    for (const live of [b, c, d]) {
      const liveLog = operator.log(live.subagentId);
      expect(liveLog.status === 'ok' ? liveLog.message : '').not.toContain(
        'no bounded operator log entries',
      );
    }

    // Touching b moves it to the most-recent slot. A new send to a fifth
    // subagent (e) should evict c (now the oldest), not b.
    const e = await roster.spawn({ role: 'coder' });
    operator.send(b.subagentId, 'b again');
    operator.send(e.subagentId, 'fifth');
    const cLog = operator.log(c.subagentId);
    expect(cLog.status === 'ok' ? cLog.message : '').toContain(
      'no bounded operator log entries',
    );
    const bLog = operator.log(b.subagentId);
    expect(bLog.status === 'ok' ? bLog.message : '').toContain('b again');
  });

  it('lists, logs, steers, redacts, and kills active depth-1 subagents', async () => {
    const roster = createSubagentRoster(parentContext(), { maxConcurrent: 2 });
    const descriptor = await roster.spawn({ role: 'coder' });
    const operator = new SubagentOperatorSurface({ roster, maxLogChars: 500 });

    expect(operator.list()).toMatchObject({ status: 'ok' });
    expect(operator.info(descriptor.subagentId)).toMatchObject({
      status: 'ok',
      descriptor: { subagentId: descriptor.subagentId, state: 'active' },
    });
    expect(operator.send(descriptor.subagentId, 'token sk-secret1234567890')).toMatchObject({ status: 'ok' });
    expect(operator.steer(descriptor.subagentId, 'continue safely')).toMatchObject({ status: 'ok' });
    const log = operator.log(descriptor.subagentId);
    expect(log).toMatchObject({ status: 'ok' });
    expect(log.status === 'ok' ? log.message : '').toContain('[REDACTED_SECRET]');

    await expect(operator.kill(descriptor.subagentId, 'operator test kill')).resolves.toMatchObject({ status: 'ok' });
    expect(roster.snapshot()[0]?.state).toBe('terminated');
    expect(operator.send(descriptor.subagentId, 'late message')).toMatchObject({ status: 'denied' });
  });

  it('creates focus, blocks non-owner release, releases owner focus, and records ledger events', () => {
    const ledger = new InMemoryControlPlaneLedger();
    const manager = new DiscordSessionBindingManager({
      ledger,
      idFactory: () => 'binding-1',
      idleTimeoutMs: 30 * 60 * 1000,
      maxAgeMs: 6 * 60 * 60 * 1000,
    });
    const binding = manager.focus({
      guildId: 'guild',
      channelId: 'channel',
      taskId: 'task-1',
      ownerUserId: 'user-1',
      now: new Date('2026-04-27T00:00:00.000Z'),
    });
    expect(binding).toMatchObject({ bindingId: 'binding-1', status: 'active' });
    expect(manager.active({ channelId: 'channel', ownerUserId: 'user-1', now: new Date('2026-04-27T00:05:00.000Z') })).toMatchObject({ taskId: 'task-1' });
    expect(
      manager.release({ channelId: 'channel', ownerUserId: 'user-2', now: new Date('2026-04-27T00:06:00.000Z') }),
    ).toMatchObject({ status: 'denied' });
    expect(
      manager.release({ channelId: 'channel', ownerUserId: 'user-1', now: new Date('2026-04-27T00:07:00.000Z') }),
    ).toMatchObject({ status: 'ok' });
    expect(manager.active({ channelId: 'channel', ownerUserId: 'user-1', now: new Date('2026-04-27T00:08:00.000Z') })).toBeUndefined();
    expect(ledger.loadAll().map((event) => event.type)).toEqual([
      'session.binding_created',
      'session.binding_released',
    ]);
  });

  it('expires idle bindings and releases terminal task bindings', () => {
    const manager = new DiscordSessionBindingManager({ idFactory: () => 'binding-expire' });
    manager.focus({
      channelId: 'channel',
      taskId: 'task-expire',
      ownerUserId: 'user',
      now: new Date('2026-04-27T00:00:00.000Z'),
    });
    expect(manager.expire(new Date('2026-04-27T00:31:00.000Z'))[0]).toMatchObject({ status: 'expired' });
    manager.focus({
      channelId: 'channel',
      taskId: 'task-terminal',
      ownerUserId: 'user',
      now: new Date('2026-04-27T01:00:00.000Z'),
    });
    expect(manager.releaseTask('task-terminal')[0]).toMatchObject({ status: 'released' });
  });
});
