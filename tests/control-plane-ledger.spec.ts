import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  CONTROL_PLANE_LEDGER_LOAD_SINCE_MAX_BYTES,
  ControlPlaneLedgerTooLargeError,
  InMemoryControlPlaneLedger,
  JsonlControlPlaneLedger,
  filterControlPlaneEvents,
  parseControlPlaneEvent,
} from '../src/index.js';

describe('control-plane ledger', () => {
  it('rejects unknown control-plane event type strings during parse', () => {
    expect(
      parseControlPlaneEvent({
        schemaVersion: 1,
        eventId: 'event-1',
        timestamp: '2026-05-05T00:00:00.000Z',
        type: 'task.unregistered_future_event',
        actor: { kind: 'system' },
        trust: { source: 'system', inputTrust: 'trusted' },
        payload: {},
      }),
    ).toBeUndefined();
  });

  it('notifies generic observers after append and contains observer failures', async () => {
    const observed: string[] = [];
    const ledger = new InMemoryControlPlaneLedger(
      [],
      [],
      [
        {
          observe: (event) => {
            observed.push(event.eventId);
          },
        },
        {
          observe: () => {
            throw new Error('observer boom');
          },
        },
      ],
    );

    const event = ledger.append({
      eventId: 'event-observed',
      type: 'task.requested',
      actor: { kind: 'system' },
      trust: { source: 'system', inputTrust: 'trusted' },
      payload: {},
    });

    await Promise.resolve();

    expect(event.eventId).toBe('event-observed');
    expect(ledger.loadAll()).toHaveLength(1);
    expect(observed).toEqual(['event-observed']);
  });

  it('appends JSONL records and skips torn or invalid lines on replay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-control-ledger-'));
    try {
      const filePath = join(dir, 'events.jsonl');
      const ledger = new JsonlControlPlaneLedger(filePath);

      const event = ledger.append({
        type: 'task.requested',
        actor: { kind: 'discord-user', userId: 'user-1' },
        channel: { kind: 'discord', guildId: 'guild-1', channelId: 'chan-1' },
        conversationId: 'chan-1',
        taskId: 'discord-task-1',
        trust: { source: 'discord', inputTrust: 'untrusted' },
        payload: { instruction: 'research safely' },
      });
      writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}not-json\n`, 'utf8');

      expect(new JsonlControlPlaneLedger(filePath).loadAll()).toEqual([event]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filters in-memory events by task, channel, and bounded limit', () => {
    const ledger = new InMemoryControlPlaneLedger();
    ledger.append({
      type: 'conversation.message_observed',
      actor: { kind: 'discord-user', userId: 'user-1' },
      channel: { kind: 'discord', channelId: 'chan-1' },
      conversationId: 'chan-1',
      trust: { source: 'discord', inputTrust: 'untrusted' },
      payload: { content: 'context only' },
    });
    ledger.append({
      type: 'task.accepted',
      actor: { kind: 'discord-user', userId: 'user-1' },
      channel: { kind: 'discord', channelId: 'chan-1' },
      conversationId: 'chan-1',
      taskId: 'discord-task-1',
      trust: { source: 'discord', inputTrust: 'trusted' },
      payload: { record: {} },
    });

    expect(filterControlPlaneEvents(ledger.loadAll(), { channelId: 'chan-1' })).toHaveLength(2);
    expect(filterControlPlaneEvents(ledger.loadAll(), { taskId: 'discord-task-1' })).toHaveLength(1);
    expect(filterControlPlaneEvents(ledger.loadAll(), { channelId: 'chan-1', limit: 1 })[0]?.type).toBe('task.accepted');
  });

  it('loads bounded events since a timestamp without replaying old entries', () => {
    const ledger = new InMemoryControlPlaneLedger();
    ledger.append({
      type: 'task.accepted',
      timestamp: '2026-05-05T00:00:00.000Z',
      actor: { kind: 'discord-user', userId: 'user-1' },
      trust: { source: 'discord', inputTrust: 'trusted' },
      payload: {},
    });
    ledger.append({
      type: 'task.terminal',
      timestamp: '2026-05-05T00:02:00.000Z',
      actor: { kind: 'system' },
      trust: { source: 'system', inputTrust: 'trusted' },
      payload: {},
    });
    ledger.append({
      type: 'approval.resolved',
      timestamp: '2026-05-05T00:03:00.000Z',
      actor: { kind: 'discord-user', userId: 'user-2' },
      trust: { source: 'discord', inputTrust: 'operator-approved' },
      payload: {},
    });

    expect(
      ledger.loadSince('2026-05-05T00:01:00.000Z', 1).map((event) => event.type),
    ).toEqual(['approval.resolved']);
    expect(
      ledger
        .loadSince('2026-05-05T00:00:00.000Z', 2, { typePrefix: 'task.' })
        .map((event) => event.type),
    ).toEqual(['task.accepted', 'task.terminal']);
  });

  it('fails fast for JSONL loadSince when the ledger is too large for bounded feed reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-control-ledger-large-'));
    try {
      const filePath = join(dir, 'events.jsonl');
      writeFileSync(
        filePath,
        `${'x'.repeat(CONTROL_PLANE_LEDGER_LOAD_SINCE_MAX_BYTES + 1)}\n`,
        'utf8',
      );

      expect(() =>
        new JsonlControlPlaneLedger(filePath).loadSince(
          '2026-05-05T00:00:00.000Z',
          50,
        ),
      ).toThrow(ControlPlaneLedgerTooLargeError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
