import { describe, expect, it } from 'vitest';

import {
  DiscordTaskRegistry,
  InMemoryControlPlaneLedger,
  type TerminalEvidence,
} from '../src/index.js';

const acceptance = {
  taskId: 'discord-task-1' as never,
  acceptedAt: '2026-04-26T00:00:00.000Z',
  boundary: 'dispatcher' as const,
};

const terminalEvidence: TerminalEvidence = {
  taskId: 'discord-task-1',
  runtimeInstanceId: 'runtime-1',
  reason: 'done',
  provenance: 'test',
  executionContext: {
    planCreatedAt: '2026-04-26T00:00:00.000Z',
    runtimeSettings: {
      networkProfile: 'provider-only',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkProjection: { networkAccessEnabled: true, webSearchMode: 'provider' },
    },
  },
  resourceEnvelope: {
    requested: { cpuCores: 1, memoryMiB: 128, wallTimeSec: 60, gpuCards: 0 },
    effective: { cpuCores: 1, memoryMiB: 128, wallTimeSec: 60, gpuCards: 0 },
  },
  startedAt: '2026-04-26T00:00:00.000Z',
  endedAt: '2026-04-26T00:00:01.000Z',
  cause: {
    kind: 'success',
    taskId: 'discord-task-1',
    runtimeInstanceId: 'runtime-1',
    observedAt: '2026-04-26T00:00:01.000Z',
    provenance: 'test',
  },
};

describe('discord task registry marker audit', () => {
  it('archives tasks durably and hides them from default lists', () => {
    const ledger = new InMemoryControlPlaneLedger();
    const registry = new DiscordTaskRegistry({ ledger });
    registry.registerTask({
      taskId: 'discord-task-1',
      instruction: 'archive old result',
      userId: 'user-1',
      channelId: 'chan-1',
      acceptance,
    });
    registry.markTerminal('discord-task-1', terminalEvidence);

    const archived = registry.archiveTask({
      taskId: 'discord-task-1',
      archivedAt: '2026-04-26T00:00:05.000Z',
      archivedBy: 'user-1',
      reason: 'superseded by later run',
    });

    expect(archived?.archive).toEqual({
      archivedAt: '2026-04-26T00:00:05.000Z',
      archivedBy: 'user-1',
      reason: 'superseded by later run',
    });
    expect(registry.list({ state: 'all' })).toHaveLength(0);
    expect(registry.list({ state: 'archived' })).toHaveLength(1);
    expect(
      registry.list({ state: 'archived', channelId: 'other-channel' }),
    ).toHaveLength(0);
    const eventCountAfterFirstArchive = ledger.loadAll().length;
    registry.archiveTask({
      taskId: 'discord-task-1',
      archivedAt: '2026-04-26T00:00:06.000Z',
      archivedBy: 'user-1',
      reason: 'duplicate archive attempt',
    });
    expect(ledger.loadAll()).toHaveLength(eventCountAfterFirstArchive);
    expect(ledger.loadAll().at(-1)).toMatchObject({
      type: 'task.archived',
      taskId: 'discord-task-1',
      payload: {
        archiveAudit: {
          schemaVersion: 1,
          action: 'archive',
          status: 'archived',
          retained: true,
          actorPresent: true,
          reasonPresent: true,
        },
      },
    });

    const replayed = new DiscordTaskRegistry({ ledger });
    expect(replayed.get('discord-task-1')?.archive).toMatchObject({
      archivedBy: expect.stringMatching(/^sha256:/u),
    });
    expect(replayed.list({ state: 'archived' })).toHaveLength(1);
    expect(replayed.list({ state: 'all' })).toHaveLength(0);
  });



  it('emits archive control-plane evidence without raw actor or reason content', () => {
    const ledger = new InMemoryControlPlaneLedger();
    const registry = new DiscordTaskRegistry({ ledger });
    registry.registerTask({
      taskId: 'discord-task-1',
      instruction: 'SECRET raw instruction stays outside archive audit',
      userId: 'user-1',
      channelId: 'chan-1',
      acceptance,
    });

    registry.archiveTask({
      taskId: 'discord-task-1',
      archivedAt: '2026-04-26T00:00:05.000Z',
      archivedBy: 'SECRET-user-archive',
      reason: 'SECRET archive reason',
      requestId: 'SECRET-request-id',
    });
    registry.unarchiveTask({
      taskId: 'discord-task-1',
      unarchivedAt: '2026-04-26T00:00:06.000Z',
      unarchivedBy: 'SECRET-user-unarchive',
      reason: 'SECRET unarchive reason',
    });

    const archiveEvents = ledger
      .loadAll()
      .filter((event) => event.type === 'task.archived' || event.type === 'task.unarchived');
    expect(archiveEvents).toHaveLength(2);
    const serialized = JSON.stringify(archiveEvents.map((event) => event.payload));
    expect(serialized).toContain('archiveAudit');
    expect(serialized).toContain('sha256:');
    expect(serialized).not.toContain('SECRET-user');
    expect(serialized).not.toContain('SECRET archive reason');
    expect(serialized).not.toContain('SECRET unarchive reason');
    expect(serialized).not.toContain('SECRET-request-id');
    expect(serialized).not.toContain('SECRET raw instruction');
    expect(archiveEvents[0]?.payload).toMatchObject({
      archiveAudit: {
        schemaVersion: 1,
        action: 'archive',
        legacyEventType: 'task.archived',
        status: 'archived',
        retained: true,
        taskIdPresent: true,
        actorPresent: true,
        reasonPresent: true,
        requestIdPresent: true,
      },
    });
    expect(archiveEvents[1]?.payload).toMatchObject({
      archiveAudit: {
        schemaVersion: 1,
        action: 'unarchive',
        legacyEventType: 'task.unarchived',
        status: 'unarchived',
        retained: true,
        taskIdPresent: true,
        actorPresent: true,
        reasonPresent: true,
        requestIdPresent: false,
      },
    });
    const archiveAudit = archiveEvents[0]?.payload['archiveAudit'];
    const unarchiveAudit = archiveEvents[1]?.payload['archiveAudit'];
    expect(archiveAudit).toMatchObject({
      taskHash: expect.stringMatching(/^sha256:[0-9a-f]{16}$/u),
      actorHash: expect.stringMatching(/^sha256:[0-9a-f]{16}$/u),
      reasonHash: expect.stringMatching(/^sha256:[0-9a-f]{16}$/u),
      requestIdHash: expect.stringMatching(/^sha256:[0-9a-f]{16}$/u),
    });
    expect(unarchiveAudit).toMatchObject({
      taskHash: expect.stringMatching(/^sha256:[0-9a-f]{16}$/u),
      actorHash: expect.stringMatching(/^sha256:[0-9a-f]{16}$/u),
      reasonHash: expect.stringMatching(/^sha256:[0-9a-f]{16}$/u),
    });
  });

  it('replays requested instruction and rerun source metadata', () => {
    const ledger = new InMemoryControlPlaneLedger();
    const registry = new DiscordTaskRegistry({ ledger });
    registry.registerTask({
      taskId: 'discord-task-1',
      instruction: 'rerun managed instruction',
      requestedInstruction: 'rerun source instruction',
      rerunOfTaskId: 'discord-task-source',
      userId: 'user-1',
      channelId: 'chan-1',
      acceptance,
    });

    const replayed = new DiscordTaskRegistry({ ledger });
    expect(replayed.get('discord-task-1')).toMatchObject({
      requestedInstruction: 'rerun source instruction',
      rerunOfTaskId: 'discord-task-source',
    });
  });

  it('unarchives tasks durably and restores them to default lists', () => {
    const ledger = new InMemoryControlPlaneLedger();
    const registry = new DiscordTaskRegistry({ ledger });
    registry.registerTask({
      taskId: 'discord-task-1',
      instruction: 'restore archived result',
      userId: 'user-1',
      channelId: 'chan-1',
      acceptance,
    });
    registry.markTerminal('discord-task-1', terminalEvidence);
    registry.archiveTask({
      taskId: 'discord-task-1',
      archivedAt: '2026-04-26T00:00:05.000Z',
      archivedBy: 'user-1',
    });

    const restored = registry.unarchiveTask({
      taskId: 'discord-task-1',
      unarchivedAt: '2026-04-26T00:00:06.000Z',
      unarchivedBy: 'user-1',
      reason: 'needed for comparison board',
    });

    expect(restored?.archive).toBeUndefined();
    expect(registry.list({ state: 'all' })).toHaveLength(1);
    expect(registry.list({ state: 'archived' })).toHaveLength(0);
    expect(ledger.loadAll().at(-1)).toMatchObject({
      type: 'task.unarchived',
      taskId: 'discord-task-1',
      payload: {
        archiveAudit: {
          action: 'unarchive',
          status: 'unarchived',
          retained: true,
          actorPresent: true,
          reasonPresent: true,
        },
      },
    });

    const eventCountAfterFirstRestore = ledger.loadAll().length;
    registry.unarchiveTask({
      taskId: 'discord-task-1',
      unarchivedAt: '2026-04-26T00:00:07.000Z',
      unarchivedBy: 'user-1',
      reason: 'duplicate restore attempt',
    });
    expect(ledger.loadAll()).toHaveLength(eventCountAfterFirstRestore);

    const replayed = new DiscordTaskRegistry({ ledger });
    expect(replayed.get('discord-task-1')?.archive).toBeUndefined();
    expect(replayed.list({ state: 'all' })).toHaveLength(1);
    expect(replayed.list({ state: 'archived' })).toHaveLength(0);
  });

  it('keeps archived tasks hidden when late lifecycle observations replay after archive', () => {
    const ledger = new InMemoryControlPlaneLedger();
    const registry = new DiscordTaskRegistry({ ledger });
    registry.registerTask({
      taskId: 'discord-task-1',
      instruction: 'archive then late event',
      userId: 'user-1',
      channelId: 'chan-1',
      acceptance,
    });
    registry.markTerminal('discord-task-1', terminalEvidence);
    registry.archiveTask({
      taskId: 'discord-task-1',
      archivedAt: '2026-04-26T00:00:05.000Z',
      archivedBy: 'user-1',
    });

    const lateUpdate = registry.observeLifecycle({
      taskId: 'discord-task-1',
      phase: 'runtime-running',
      observedAt: '2026-04-26T00:00:06.000Z',
    });

    expect(lateUpdate?.record.coarseState).toBe('terminal');
    expect(lateUpdate?.coarseStateChanged).toBe(false);
    expect(registry.list({ state: 'active' })).toHaveLength(0);
    expect(registry.list({ state: 'archived' })).toHaveLength(1);

    const replayed = new DiscordTaskRegistry({ ledger });
    expect(replayed.get('discord-task-1')?.coarseState).toBe('terminal');
    expect(replayed.list({ state: 'active' })).toHaveLength(0);
    expect(replayed.list({ state: 'archived' })).toHaveLength(1);
  });

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
