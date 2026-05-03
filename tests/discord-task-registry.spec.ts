import { describe, expect, it } from 'vitest';

import {
  DiscordTaskRegistry,
  InMemoryControlPlaneLedger,
} from '../src/index.js';

const acceptance = {
  taskId: 'discord-task-1' as never,
  acceptedAt: '2026-04-26T00:00:00.000Z',
  boundary: 'dispatcher' as const,
};

describe('discord task registry marker audit', () => {
  it('records marker/task audit snapshots without mutating prior clones', () => {
    const registry = new DiscordTaskRegistry();
    registry.registerTask({
      taskId: 'discord-task-1',
      instruction: 'inspect marker correlation',
      userId: 'user-1',
      channelId: 'chan-1',
      acceptance,
    });

    const updated = registry.recordMarkerAudit('discord-task-1', {
      observedAt: '2026-04-26T00:00:02.000Z',
      marker: 'RUN_T01',
      submit: { status: 'attempted' },
      taskCorrelation: {
        status: 'captured',
        taskId: 'discord-task-1',
        matchedOn: ['task-id'],
      },
      ack: {
        status: 'captured',
        taskId: 'discord-task-1',
        matchedOn: ['task-id', 'author'],
      },
      matchedReply: {
        status: 'weak',
        marker: 'RUN_T01',
        matchedOn: ['marker', 'timing'],
      },
    });

    expect(updated?.markerAudit).toMatchObject({
      marker: 'RUN_T01',
      submit: { status: 'attempted' },
      taskCorrelation: { status: 'captured', taskId: 'discord-task-1' },
      ack: { status: 'captured' },
      matchedReply: { status: 'weak' },
    });

    updated?.markerAudit?.ack.matchedOn?.slice();
    if (updated?.markerAudit?.ack.matchedOn !== undefined) {
      (updated.markerAudit.ack.matchedOn as string[]).push('marker');
    }
    expect(registry.get('discord-task-1')?.markerAudit?.ack.matchedOn).toEqual([
      'task-id',
      'author',
    ]);
  });

  it('replays both legacy and marker-audited accepted records from the ledger', () => {
    const ledger = new InMemoryControlPlaneLedger();
    ledger.append({
      type: 'task.accepted',
      actor: { kind: 'discord-user', userId: 'user-1' },
      channel: { kind: 'discord', channelId: 'chan-1' },
      conversationId: 'chan-1',
      taskId: 'discord-task-legacy',
      trust: { source: 'discord', inputTrust: 'trusted' },
      payload: {
        record: {
          taskId: 'discord-task-legacy',
          instruction: 'legacy record',
          userId: 'user-1',
          channelId: 'chan-1',
          acceptance,
          coarseState: 'accepted',
          lastLifecyclePhase: 'accepted',
          updatedAt: '2026-04-26T00:00:00.000Z',
        },
      },
    });
    ledger.append({
      type: 'task.accepted',
      actor: { kind: 'discord-user', userId: 'user-2' },
      channel: { kind: 'discord', channelId: 'chan-2' },
      conversationId: 'chan-2',
      taskId: 'discord-task-audited',
      trust: { source: 'discord', inputTrust: 'trusted' },
      payload: {
        record: {
          taskId: 'discord-task-audited',
          instruction: 'audited record',
          userId: 'user-2',
          channelId: 'chan-2',
          acceptance: {
            ...acceptance,
            taskId: 'discord-task-audited',
          },
          coarseState: 'accepted',
          lastLifecyclePhase: 'accepted',
          updatedAt: '2026-04-26T00:00:03.000Z',
          markerAudit: {
            marker: 'RUN_T09',
            submit: { status: 'attempted', summary: 'submit attempted' },
            taskCorrelation: {
              status: 'captured',
              summary: 'task correlation captured',
              taskId: 'discord-task-audited',
            },
            ack: {
              status: 'captured',
              summary: 'ack captured',
              matchedOn: ['task-id'],
            },
            matchedReply: {
              status: 'captured',
              summary: 'reply captured',
              matchedOn: ['task-id', 'marker'],
            },
            updatedAt: '2026-04-26T00:00:03.000Z',
          },
        },
      },
    });

    const replayed = new DiscordTaskRegistry({ ledger });

    expect(replayed.get('discord-task-legacy')).toMatchObject({
      taskId: 'discord-task-legacy',
      markerAudit: undefined,
    });
    expect(replayed.get('discord-task-audited')?.markerAudit).toMatchObject({
      marker: 'RUN_T09',
      matchedReply: { status: 'captured' },
    });
  });

  it('appends and replays dedicated marker audit ledger events without duplicating them', () => {
    const ledger = new InMemoryControlPlaneLedger();
    const registry = new DiscordTaskRegistry({ ledger });
    registry.registerTask({
      taskId: 'discord-task-1',
      instruction: 'inspect marker correlation',
      userId: 'user-1',
      channelId: 'chan-1',
      acceptance,
    });

    registry.recordMarkerAudit('discord-task-1', {
      observedAt: '2026-04-26T00:00:04.000Z',
      marker: 'RUN_T11',
      taskCorrelation: {
        status: 'captured',
        taskId: 'discord-task-1',
        matchedOn: ['task-id'],
      },
      ack: {
        status: 'captured',
        matchedOn: ['task-id', 'author'],
      },
    });

    const events = ledger.loadAll();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'task.marker_audit_recorded',
      taskId: 'discord-task-1',
      payload: {
        auditUpdate: {
          observedAt: '2026-04-26T00:00:04.000Z',
          marker: 'RUN_T11',
        },
      },
    });

    const replayed = new DiscordTaskRegistry({ ledger });
    expect(ledger.loadAll()).toHaveLength(2);
    expect(replayed.get('discord-task-1')?.markerAudit).toMatchObject({
      marker: 'RUN_T11',
      taskCorrelation: {
        status: 'captured',
        taskId: 'discord-task-1',
      },
      ack: {
        status: 'captured',
        matchedOn: ['task-id', 'author'],
      },
    });
  });
});
