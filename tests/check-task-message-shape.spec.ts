import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function event(taskId: string, eventType: string, messageId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    timestamp: `2026-05-16T15:00:00.000Z`,
    type: 'task.delivery_observed',
    taskId,
    payload: {
      operation: 'editReply',
      eventType,
      messageId,
    },
  });
}

describe('check-task-message-shape', () => {
  it('ignores separate /status replies for the default task lifecycle proof', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'message-shape-'));
    try {
      const ledger = join(workspace, 'ledger.jsonl');
      writeFileSync(
        ledger,
        [
          event('discord-task-1', 'ask-accepted', 'message-a'),
          event('discord-task-1', 'running-update', 'message-a'),
          event('discord-task-1', 'status-reply', 'message-b'),
          event('discord-task-1', 'terminal-result', 'message-a'),
        ].join('\n') + '\n',
      );

      const result = spawnSync(
        'node',
        ['scripts/check-task-message-shape.mjs', 'discord-task-1', '--ledger', ledger],
        { encoding: 'utf8' },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Ignored separate command replies: 1 of 4 observed events');
      expect(result.stdout).toContain('PASS — cycle 8/10 in-place edit verified');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('can include /status replies for legacy audit reproduction', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'message-shape-'));
    try {
      const ledger = join(workspace, 'ledger.jsonl');
      writeFileSync(
        ledger,
        [
          event('discord-task-1', 'ask-accepted', 'message-a'),
          event('discord-task-1', 'running-update', 'message-a'),
          event('discord-task-1', 'status-reply', 'message-b'),
          event('discord-task-1', 'terminal-result', 'message-a'),
        ].join('\n') + '\n',
      );

      const result = spawnSync(
        'node',
        [
          'scripts/check-task-message-shape.mjs',
          'discord-task-1',
          '--ledger',
          ledger,
          '--include-status-replies',
        ],
        { encoding: 'utf8' },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('FAIL — 4 editReply ops landed on 2 distinct messages');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
