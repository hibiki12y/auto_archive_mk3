import { describe, expect, it } from 'vitest';

import {
  looksLikeTaskSettleEvent,
  messageMatchesPollMode,
} from '../scripts/agent-node-discord-direct-control.mjs';

const STARTED_AT = Date.parse('2026-05-04T03:25:00.000Z');
const AFTER_START = '2026-05-04T03:25:30.000Z';

const SETTLE_REPLY = {
  bot: true,
  authorId: 'arona-bot',
  content:
    'Task `discord-task-abc` finished with `failure`.\nReason: agent runtime fail-closed.\nProvenance: agent-runtime-fail-closed\nArtifact: /workspace/x',
  timestamp: AFTER_START,
};

const FOCUS_TERMINAL_REPLY = {
  bot: true,
  authorId: 'arona-bot',
  content:
    'Task `discord-task-abc` is already terminal.\nOutcome: failure\nReason: agent runtime fail-closed.',
  timestamp: AFTER_START,
};

const FOCUS_CREATED_REPLY = {
  bot: true,
  authorId: 'arona-bot',
  content:
    'Focused task `discord-task-abc` for this channel/thread.\nBinding: `binding-1234`\nExpires: 2026-05-04T04:25:00.000Z',
  timestamp: AFTER_START,
};

const UNFOCUS_REPLY = {
  bot: true,
  authorId: 'arona-bot',
  content: 'Focus released for task `discord-task-abc`.\nBinding: `binding-1234`',
  timestamp: AFTER_START,
};

describe('looksLikeTaskSettleEvent', () => {
  it('flags messages containing Provenance: as settle-shaped', () => {
    expect(looksLikeTaskSettleEvent(SETTLE_REPLY)).toBe(true);
  });

  it('does not flag the renderAlreadyTerminal reply (no Provenance line)', () => {
    expect(looksLikeTaskSettleEvent(FOCUS_TERMINAL_REPLY)).toBe(false);
  });

  it('does not flag focus-created/unfocus replies', () => {
    expect(looksLikeTaskSettleEvent(FOCUS_CREATED_REPLY)).toBe(false);
    expect(looksLikeTaskSettleEvent(UNFOCUS_REPLY)).toBe(false);
  });
});

describe('messageMatchesPollMode F7 settle-discriminator (slash-focus/unfocus)', () => {
  const baseArgs = { expectTaskId: 'discord-task-abc' };

  it('rejects a settle-shaped message in slash-focus command-response polling', () => {
    expect(
      messageMatchesPollMode(
        SETTLE_REPLY,
        { ...baseArgs, mode: 'slash-focus' },
        'command-response',
        STARTED_AT,
      ),
    ).toBe(false);
  });

  it('accepts a renderAlreadyTerminal focus reply (same task id, no Provenance)', () => {
    expect(
      messageMatchesPollMode(
        FOCUS_TERMINAL_REPLY,
        { ...baseArgs, mode: 'slash-focus' },
        'command-response',
        STARTED_AT,
      ),
    ).toBe(true);
  });

  it('accepts a renderFocusCreated reply', () => {
    expect(
      messageMatchesPollMode(
        FOCUS_CREATED_REPLY,
        { ...baseArgs, mode: 'slash-focus' },
        'command-response',
        STARTED_AT,
      ),
    ).toBe(true);
  });

  it('rejects a settle-shaped message in slash-unfocus command-response polling', () => {
    expect(
      messageMatchesPollMode(
        SETTLE_REPLY,
        { ...baseArgs, mode: 'slash-unfocus' },
        'command-response',
        STARTED_AT,
      ),
    ).toBe(false);
  });

  it('accepts a renderFocusReleased reply for slash-unfocus', () => {
    expect(
      messageMatchesPollMode(
        UNFOCUS_REPLY,
        { ...baseArgs, mode: 'slash-unfocus' },
        'command-response',
        STARTED_AT,
      ),
    ).toBe(true);
  });

  it('still accepts settle-shaped messages for slash-status (settle IS the expected reply)', () => {
    expect(
      messageMatchesPollMode(
        SETTLE_REPLY,
        { ...baseArgs, mode: 'slash-status' },
        'command-response',
        STARTED_AT,
      ),
    ).toBe(true);
  });
});
