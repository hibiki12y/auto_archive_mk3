import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  InMemoryControlPlaneLedger,
  JsonlControlPlaneLedger,
  filterControlPlaneEvents,
} from '../src/index.js';

describe('control-plane ledger', () => {
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
});
