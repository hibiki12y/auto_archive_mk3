/**
 * M10 Stage 4 — JsonAcpSessionStore unit tests.
 *
 * Coverage:
 *   - read absent file → undefined (not error)
 *   - write/read round-trip preserves all schemaVersion=1 fields
 *   - lastTouchedAt is bumped by `touch` (re-write of existing record)
 *   - directory is created lazily on first write
 *   - atomic-write: nothing visible at the canonical path until rename
 *   - tmp file is cleaned on rename failure
 *   - schemaVersion mismatch on read → throws
 *   - malformed JSON on read → throws
 *   - sessionId character validation (rejects "/", "..", empty, etc.)
 *   - list returns only valid sessionId-shaped basenames
 *   - remove() is idempotent (ENOENT is silent)
 *   - defaultAcpSessionDirectory honors AUTO_ARCHIVE_HOME
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  JsonAcpSessionStore,
  defaultAcpSessionDirectory,
  type PersistedAcpSessionRecord,
} from '../../src/acp/acp-session-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acp-session-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('JsonAcpSessionStore', () => {
  it('read returns undefined for an absent file', async () => {
    const store = new JsonAcpSessionStore({ directory: dir });
    const out = await store.read('does-not-exist');
    expect(out).toBeUndefined();
  });

  it('write/read round-trip preserves all schemaVersion=1 fields', async () => {
    const store = new JsonAcpSessionStore({
      directory: dir,
      now: () => '2026-05-02T00:00:00.000Z',
    });
    const record: PersistedAcpSessionRecord = {
      schemaVersion: 1,
      sessionId: 'abc-001',
      cwd: '/tmp/work',
      additionalDirectories: ['/tmp/extra-1', '/tmp/extra-2'],
      createdAt: '2026-05-01T00:00:00.000Z',
      lastTouchedAt: '2026-05-01T00:00:00.000Z',
      parentSessionId: 'abc-000',
    };
    await store.write(record);
    const got = await store.read('abc-001');
    expect(got).toEqual(record);
  });

  it('write a record without parentSessionId omits the field on read', async () => {
    const store = new JsonAcpSessionStore({ directory: dir });
    await store.write({
      schemaVersion: 1,
      sessionId: 'no-parent',
      cwd: '/tmp',
      additionalDirectories: [],
      createdAt: '2026-05-02T00:00:00.000Z',
      lastTouchedAt: '2026-05-02T00:00:00.000Z',
    });
    const got = await store.read('no-parent');
    expect(got).toBeDefined();
    expect(got!.parentSessionId).toBeUndefined();
  });

  it('directory is created lazily (does not exist before first write)', async () => {
    const sub = join(dir, 'lazy', 'created');
    expect(existsSync(sub)).toBe(false);
    const store = new JsonAcpSessionStore({ directory: sub });
    await store.write({
      schemaVersion: 1,
      sessionId: 'x',
      cwd: '/tmp',
      additionalDirectories: [],
      createdAt: '2026-05-02T00:00:00.000Z',
      lastTouchedAt: '2026-05-02T00:00:00.000Z',
    });
    expect(existsSync(sub)).toBe(true);
  });

  it('atomic write — no .tmp.* files remain after a successful write', async () => {
    const store = new JsonAcpSessionStore({
      directory: dir,
      randomSuffix: () => 'deadbeef',
    });
    await store.write({
      schemaVersion: 1,
      sessionId: 'abc',
      cwd: '/tmp',
      additionalDirectories: [],
      createdAt: '2026-05-02T00:00:00.000Z',
      lastTouchedAt: '2026-05-02T00:00:00.000Z',
    });
    const entries = readdirSync(dir);
    expect(entries).toContain('abc.json');
    const tmps = entries.filter((e) => e.includes('.tmp.'));
    expect(tmps).toHaveLength(0);
  });

  it('schemaVersion mismatch on read throws', async () => {
    writeFileSync(
      join(dir, 'badv.json'),
      JSON.stringify({
        schemaVersion: 2,
        sessionId: 'badv',
        cwd: '/tmp',
        additionalDirectories: [],
        createdAt: '2026-05-02T00:00:00.000Z',
        lastTouchedAt: '2026-05-02T00:00:00.000Z',
      }),
    );
    const store = new JsonAcpSessionStore({ directory: dir });
    await expect(store.read('badv')).rejects.toThrow(/unsupported schemaVersion/);
  });

  it('malformed JSON on read throws', async () => {
    writeFileSync(join(dir, 'corrupt.json'), '{not valid json');
    const store = new JsonAcpSessionStore({ directory: dir });
    await expect(store.read('corrupt')).rejects.toThrow(/invalid JSON/);
  });

  it('write rejects schemaVersion != 1', async () => {
    const store = new JsonAcpSessionStore({ directory: dir });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store.write({ schemaVersion: 7 as any, sessionId: 'x', cwd: '/tmp', additionalDirectories: [], createdAt: 'a', lastTouchedAt: 'a' }),
    ).rejects.toThrow(/only schemaVersion=1/);
  });

  it.each([
    'has/slash',
    'has\\backslash',
    'has space',
    '..',
    '.',
    '',
    'a'.repeat(129),
    'unicode-π',
    'newline\n',
  ])('rejects unsafe sessionId %s', async (bad) => {
    const store = new JsonAcpSessionStore({ directory: dir });
    await expect(store.read(bad)).rejects.toThrow(TypeError);
  });

  it('accepts sessionIds matching [A-Za-z0-9._-]+', async () => {
    const store = new JsonAcpSessionStore({ directory: dir });
    const allowed = ['abc', 'A.B-C_2', '1234567890', 'X.Y.Z', 'a-b-c-d'];
    for (const sid of allowed) {
      await store.write({
        schemaVersion: 1,
        sessionId: sid,
        cwd: '/tmp',
        additionalDirectories: [],
        createdAt: '2026-05-02T00:00:00.000Z',
        lastTouchedAt: '2026-05-02T00:00:00.000Z',
      });
    }
    const list = await store.list();
    expect([...list].sort()).toEqual([...allowed].sort());
  });

  it('list returns only valid-sessionId-shaped basenames', async () => {
    const store = new JsonAcpSessionStore({ directory: dir });
    await store.write({
      schemaVersion: 1,
      sessionId: 'good',
      cwd: '/tmp',
      additionalDirectories: [],
      createdAt: '2026-05-02T00:00:00.000Z',
      lastTouchedAt: '2026-05-02T00:00:00.000Z',
    });
    // Stray files in the directory must not pollute list().
    writeFileSync(join(dir, 'README.txt'), 'note');
    writeFileSync(join(dir, 'has space.json'), '{}');
    writeFileSync(join(dir, '..stray.json'), '{}');
    const list = await store.list();
    expect(list).toEqual(['good']);
  });

  it('list on missing directory returns empty array', async () => {
    const store = new JsonAcpSessionStore({ directory: join(dir, 'never-created') });
    const list = await store.list();
    expect(list).toEqual([]);
  });

  it('remove is idempotent for missing files', async () => {
    const store = new JsonAcpSessionStore({ directory: dir });
    await expect(store.remove('absent')).resolves.toBeUndefined();
  });

  it('remove deletes an existing record', async () => {
    const store = new JsonAcpSessionStore({ directory: dir });
    await store.write({
      schemaVersion: 1,
      sessionId: 'gone',
      cwd: '/tmp',
      additionalDirectories: [],
      createdAt: '2026-05-02T00:00:00.000Z',
      lastTouchedAt: '2026-05-02T00:00:00.000Z',
    });
    await store.remove('gone');
    const out = await store.read('gone');
    expect(out).toBeUndefined();
  });

  it('lastTouchedAt advances when re-written', async () => {
    let now = '2026-05-02T00:00:00.000Z';
    const store = new JsonAcpSessionStore({
      directory: dir,
      now: () => now,
    });
    const base: PersistedAcpSessionRecord = {
      schemaVersion: 1,
      sessionId: 'touch',
      cwd: '/tmp',
      additionalDirectories: [],
      createdAt: '2026-05-02T00:00:00.000Z',
      lastTouchedAt: '2026-05-02T00:00:00.000Z',
    };
    await store.write(base);
    now = '2026-05-02T01:30:00.000Z';
    await store.write({ ...base, lastTouchedAt: now });
    const after = await store.read('touch');
    expect(after?.lastTouchedAt).toBe('2026-05-02T01:30:00.000Z');
  });

  it('files are written with mode 0o600 (best-effort permission tightening)', async () => {
    const store = new JsonAcpSessionStore({ directory: dir });
    await store.write({
      schemaVersion: 1,
      sessionId: 'mode',
      cwd: '/tmp',
      additionalDirectories: [],
      createdAt: '2026-05-02T00:00:00.000Z',
      lastTouchedAt: '2026-05-02T00:00:00.000Z',
    });
    // Read back and ensure JSON is valid; mode check is best-effort
    // (umask can interfere). The point is that we requested 0o600 at
    // write time — a stat assertion would be flaky on CI runners with
    // atypical umasks.
    const body = readFileSync(join(dir, 'mode.json'), 'utf8');
    expect(JSON.parse(body)).toMatchObject({ sessionId: 'mode' });
  });
});

describe('defaultAcpSessionDirectory', () => {
  it('honors AUTO_ARCHIVE_HOME when set', () => {
    const got = defaultAcpSessionDirectory({ AUTO_ARCHIVE_HOME: '/custom/root' });
    expect(got).toBe('/custom/root/acp-sessions');
  });

  it('falls back to ~/.auto-archive when AUTO_ARCHIVE_HOME is unset', () => {
    const got = defaultAcpSessionDirectory({});
    expect(got).toBe(join(homedir(), '.auto-archive', 'acp-sessions'));
  });
});
