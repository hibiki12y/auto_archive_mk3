import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DiscordAccessPolicy,
  SeededDiscordAuthDatabase,
  SqliteDiscordAuthDatabase,
  type SqliteDiscordAuthDatabaseRunnerInput,
} from '../src/index.js';

const TEST_ADMIN_USER_ID = 'admin-1';

describe('Discord auth database', () => {
  it('seeds the configured admin and allow lists into the in-memory database', () => {
    const database = new SeededDiscordAuthDatabase({
      allowedGuildIds: ['guild-1'],
      allowedUserIds: ['user-1'],
      allowedChannelIds: ['channel-1'],
      adminUserIds: [TEST_ADMIN_USER_ID],
    });

    expect(database.hasAllowedGuilds()).toBe(true);
    expect(database.isGuildAllowed('guild-1')).toBe(true);
    expect(database.hasAllowedUsers()).toBe(true);
    expect(database.isUserAllowed('user-1')).toBe(true);
    expect(database.hasAllowedChannels()).toBe(true);
    expect(database.isChannelAllowed('channel-1')).toBe(true);
    expect(database.hasAdminUsers()).toBe(true);
    expect(database.isAdminUser(TEST_ADMIN_USER_ID)).toBe(true);
    database.add('allowed-user', 'user-2');
    database.remove('allowed-user', 'user-1');
    expect(database.list('allowed-user')).toEqual(['user-2']);
    expect(database.describe()).toEqual({
      allowedGuildCount: 1,
      allowedUserCount: 1,
      allowedChannelCount: 1,
      adminUserCount: 1,
    });
  });

  it('lets DiscordAccessPolicy consume database-backed authorization state', () => {
    const policy = new DiscordAccessPolicy({
      authDatabase: new SeededDiscordAuthDatabase({
        allowedGuildIds: ['guild-1'],
        allowedUserIds: ['user-1'],
        adminUserIds: [TEST_ADMIN_USER_ID],
      }),
    });

    expect(
      policy.check({
        action: 'ask',
        userId: 'user-1',
        guildId: 'guild-1',
      }),
    ).toEqual({ status: 'allowed' });
    expect(
      policy.check({
        action: 'approve',
        userId: TEST_ADMIN_USER_ID,
        guildId: 'guild-1',
      }),
    ).toEqual({ status: 'allowed' });
    expect(
      policy.check({
        action: 'approve',
        userId: 'user-1',
        guildId: 'guild-1',
      }),
    ).toEqual({ status: 'denied', reason: 'admin-required' });
    expect(
      policy.check({
        action: 'ask',
        userId: 'blocked-user',
        guildId: 'guild-1',
      }),
    ).toEqual({ status: 'denied', reason: 'user-not-allowed' });
  });

  it('requires an explicit admin for admin-only Discord actions', () => {
    const policy = new DiscordAccessPolicy({
      allowedGuildIds: ['guild-1'],
      allowedUserIds: ['user-1'],
    });

    expect(
      policy.check({
        action: 'ask',
        userId: 'user-1',
        guildId: 'guild-1',
      }),
    ).toEqual({ status: 'allowed' });
    expect(
      policy.check({
        action: 'approve',
        userId: 'user-1',
        guildId: 'guild-1',
      }),
    ).toEqual({ status: 'denied', reason: 'admin-required' });
  });

  it('initializes and seeds SQLite through an injectable runner', () => {
    const calls: SqliteDiscordAuthDatabaseRunnerInput[] = [];
    const database = new SqliteDiscordAuthDatabase({
      dbPath: join(mkdtempSync(join(tmpdir(), 'discord-auth-')), 'auth.sqlite'),
      seed: {
        allowedGuildIds: ['guild-1'],
        adminUserIds: [TEST_ADMIN_USER_ID],
      },
      runSql: (input) => {
        calls.push(input);
        if (input.sql.includes('COUNT(*)')) {
          return '1\n';
        }
        if (input.sql.includes('SELECT subject_id')) {
          return `${TEST_ADMIN_USER_ID}\n`;
        }
        if (
          input.sql.includes("scope = 'admin-user'") &&
          input.sql.includes(TEST_ADMIN_USER_ID)
        ) {
          return '1\n';
        }
        return '';
      },
    });

    expect(calls[0]?.sql).toContain('CREATE TABLE IF NOT EXISTS discord_auth_entries');
    expect(calls[1]?.sql).toContain("INSERT OR IGNORE INTO discord_auth_entries");
    expect(calls[1]?.sql).toContain(TEST_ADMIN_USER_ID);
    expect(database.hasAdminUsers()).toBe(true);
    expect(database.isAdminUser(TEST_ADMIN_USER_ID)).toBe(true);
    expect(database.list('admin-user')).toEqual([TEST_ADMIN_USER_ID]);

    database.add('allowed-user', 'user-2');
    database.remove('allowed-user', 'user-2');
    expect(calls.at(-2)?.sql).toContain('INSERT OR IGNORE');
    expect(calls.at(-1)?.sql).toContain('DELETE FROM discord_auth_entries');
  });
});
