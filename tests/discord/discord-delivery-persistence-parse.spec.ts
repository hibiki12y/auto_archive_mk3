import { describe, expect, it } from 'vitest';

import { parseDlqEntry } from '../../src/discord/delivery/discord-delivery-persistence.js';

function validEntry(): Record<string, unknown> {
  return {
    idempotencyKey: 'task-1:terminal-result:0',
    operation: 'editReply',
    payload: { content: 'final' },
    attempts: 1,
    failureClass: 'transient',
    lastError: { name: 'Error', message: 'boom' },
    recordedAtMs: 1_700_000_000_000,
  };
}

describe('discord-delivery-persistence parseDlqEntry', () => {
  it('accepts a minimally well-formed entry and returns it', () => {
    const entry = validEntry();
    expect(parseDlqEntry(entry)).toBe(entry);
  });

  it('accepts an entry with optional context and lastError.status', () => {
    const entry = {
      ...validEntry(),
      context: { taskId: 'task-1', userId: 'u-1' },
      lastError: { name: 'Error', message: 'boom', status: 503 },
    };
    expect(parseDlqEntry(entry)).toBe(entry);
  });

  it('skips a non-object payload (returns undefined, not throw)', () => {
    expect(parseDlqEntry('not-an-object')).toBeUndefined();
    expect(parseDlqEntry(null)).toBeUndefined();
    expect(parseDlqEntry([validEntry()])).toBeUndefined();
  });

  it('skips an entry missing idempotencyKey', () => {
    const entry = validEntry();
    delete entry.idempotencyKey;
    expect(parseDlqEntry(entry)).toBeUndefined();
  });

  it('skips an entry whose operation is not in the union', () => {
    expect(parseDlqEntry({ ...validEntry(), operation: 'broadcast' })).toBeUndefined();
  });

  it('skips an entry whose failureClass is not in the taxonomy', () => {
    expect(
      parseDlqEntry({ ...validEntry(), failureClass: 'unknown-class' }),
    ).toBeUndefined();
  });

  it('skips an entry whose attempts is non-integer', () => {
    expect(parseDlqEntry({ ...validEntry(), attempts: 1.5 })).toBeUndefined();
  });

  it('skips an entry whose lastError lacks name or message', () => {
    expect(
      parseDlqEntry({ ...validEntry(), lastError: { name: 'Error' } }),
    ).toBeUndefined();
    expect(
      parseDlqEntry({ ...validEntry(), lastError: { message: 'boom' } }),
    ).toBeUndefined();
  });

  it('skips an entry whose lastError.status is provided but not a number', () => {
    expect(
      parseDlqEntry({
        ...validEntry(),
        lastError: { name: 'Error', message: 'boom', status: '503' },
      }),
    ).toBeUndefined();
  });

  it('skips an entry whose recordedAtMs is missing', () => {
    const entry = validEntry();
    delete entry.recordedAtMs;
    expect(parseDlqEntry(entry)).toBeUndefined();
  });

  it('skips an entry whose payload is null', () => {
    expect(parseDlqEntry({ ...validEntry(), payload: null })).toBeUndefined();
  });

  it('skips an entry whose context is provided but not an object', () => {
    expect(parseDlqEntry({ ...validEntry(), context: 'task-1' })).toBeUndefined();
  });
});
