import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DiscordAuthScope =
  | 'allowed-guild'
  | 'allowed-user'
  | 'allowed-channel'
  | 'admin-user';

export interface DiscordAuthDatabaseSeed {
  readonly allowedGuildIds?: readonly string[];
  readonly allowedUserIds?: readonly string[];
  readonly allowedChannelIds?: readonly string[];
  readonly adminUserIds?: readonly string[];
}

export interface DiscordAuthDatabaseCounts {
  readonly allowedGuildCount: number;
  readonly allowedUserCount: number;
  readonly allowedChannelCount: number;
  readonly adminUserCount: number;
}

export interface DiscordAuthDatabase {
  list(scope: DiscordAuthScope): readonly string[];
  add(scope: DiscordAuthScope, subjectId: string): void;
  remove(scope: DiscordAuthScope, subjectId: string): void;
  hasAllowedGuilds(): boolean;
  isGuildAllowed(guildId: string): boolean;
  hasAllowedUsers(): boolean;
  isUserAllowed(userId: string): boolean;
  hasAllowedChannels(): boolean;
  isChannelAllowed(channelId: string): boolean;
  hasAdminUsers(): boolean;
  isAdminUser(userId: string): boolean;
  describe(): DiscordAuthDatabaseCounts;
}

export type DiscordAuthDatabaseMode = 'sqlite' | 'memory';

export type SqliteDiscordAuthDatabaseDriver = 'python' | 'sqlite3';

export interface SqliteDiscordAuthDatabaseRunnerInput {
  readonly dbPath: string;
  readonly sql: string;
  readonly returnsRows: boolean;
  readonly driver: SqliteDiscordAuthDatabaseDriver;
  readonly pythonBinaryPath: string;
  readonly sqliteBinaryPath: string;
}

export type SqliteDiscordAuthDatabaseRunner = (
  input: SqliteDiscordAuthDatabaseRunnerInput,
) => string;

export interface SqliteDiscordAuthDatabaseOptions {
  readonly dbPath: string;
  readonly seed?: DiscordAuthDatabaseSeed;
  readonly driver?: SqliteDiscordAuthDatabaseDriver;
  readonly pythonBinaryPath?: string;
  readonly sqliteBinaryPath?: string;
  readonly runSql?: SqliteDiscordAuthDatabaseRunner;
}

const SQLITE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS discord_auth_entries (
  scope TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (scope, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_discord_auth_entries_scope
  ON discord_auth_entries (scope);
`;

function normalizeIds(ids: readonly string[] | undefined): readonly string[] {
  return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function countSql(scope: DiscordAuthScope): string {
  return [
    'SELECT COUNT(*)',
    'FROM discord_auth_entries',
    `WHERE scope = ${quoteSqlString(scope)};`,
  ].join(' ');
}

function containsSql(scope: DiscordAuthScope, subjectId: string): string {
  return [
    'SELECT 1',
    'FROM discord_auth_entries',
    `WHERE scope = ${quoteSqlString(scope)}`,
    `AND subject_id = ${quoteSqlString(subjectId)}`,
    'LIMIT 1;',
  ].join(' ');
}

function listSql(scope: DiscordAuthScope): string {
  return [
    'SELECT subject_id',
    'FROM discord_auth_entries',
    `WHERE scope = ${quoteSqlString(scope)}`,
    'ORDER BY subject_id;',
  ].join(' ');
}

function addSql(scope: DiscordAuthScope, subjectId: string): string {
  return `INSERT OR IGNORE INTO discord_auth_entries (scope, subject_id) VALUES (${quoteSqlString(scope)}, ${quoteSqlString(subjectId)});`;
}

function removeSql(scope: DiscordAuthScope, subjectId: string): string {
  return [
    'DELETE FROM discord_auth_entries',
    `WHERE scope = ${quoteSqlString(scope)}`,
    `AND subject_id = ${quoteSqlString(subjectId)};`,
  ].join(' ');
}

function seedSql(seed: DiscordAuthDatabaseSeed | undefined): string {
  const entries: Array<{ scope: DiscordAuthScope; ids: readonly string[] }> = [
    { scope: 'allowed-guild', ids: normalizeIds(seed?.allowedGuildIds) },
    { scope: 'allowed-user', ids: normalizeIds(seed?.allowedUserIds) },
    { scope: 'allowed-channel', ids: normalizeIds(seed?.allowedChannelIds) },
    { scope: 'admin-user', ids: normalizeIds(seed?.adminUserIds) },
  ];
  const inserts = entries.flatMap((entry) =>
    entry.ids.map(
      (id) =>
        `INSERT OR IGNORE INTO discord_auth_entries (scope, subject_id) VALUES (${quoteSqlString(entry.scope)}, ${quoteSqlString(id)});`,
    ),
  );
  if (inserts.length === 0) {
    return '';
  }
  return ['BEGIN;', ...inserts, 'COMMIT;'].join('\n');
}

function runWithPythonSqlite(input: SqliteDiscordAuthDatabaseRunnerInput): string {
  const script = input.returnsRows
    ? [
        'import sqlite3, sys',
        'db_path = sys.argv[1]',
        'sql = sys.argv[2]',
        'connection = sqlite3.connect(db_path)',
        'try:',
        '    cursor = connection.execute(sql)',
        "    print('\\n'.join('|'.join('' if value is None else str(value) for value in row) for row in cursor.fetchall()))",
        'finally:',
        '    connection.close()',
      ].join('\n')
    : [
        'import sqlite3, sys',
        'db_path = sys.argv[1]',
        'sql = sys.argv[2]',
        'connection = sqlite3.connect(db_path)',
        'try:',
        '    connection.executescript(sql)',
        '    connection.commit()',
        'finally:',
        '    connection.close()',
      ].join('\n');

  return execFileSync(input.pythonBinaryPath, ['-c', script, input.dbPath, input.sql], {
    encoding: 'utf8',
  });
}

function runWithSqliteCli(input: SqliteDiscordAuthDatabaseRunnerInput): string {
  const args = input.returnsRows
    ? ['-batch', '-noheader', input.dbPath, input.sql]
    : ['-batch', input.dbPath, input.sql];
  return execFileSync(input.sqliteBinaryPath, args, { encoding: 'utf8' });
}

function defaultSqliteRunner(input: SqliteDiscordAuthDatabaseRunnerInput): string {
  return input.driver === 'sqlite3'
    ? runWithSqliteCli(input)
    : runWithPythonSqlite(input);
}

function parseCount(rawValue: string): number {
  const parsed = Number(rawValue.trim() || '0');
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeId(subjectId: string): string {
  const normalized = subjectId.trim();
  if (normalized.length === 0) {
    throw new TypeError('Discord auth subject id must be non-empty.');
  }
  return normalized;
}

function parseRows(rawValue: string): readonly string[] {
  return rawValue
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean);
}

export class SeededDiscordAuthDatabase implements DiscordAuthDatabase {
  private readonly allowedGuildIds: Set<string>;
  private readonly allowedUserIds: Set<string>;
  private readonly allowedChannelIds: Set<string>;
  private readonly adminUserIds: Set<string>;

  constructor(seed: DiscordAuthDatabaseSeed = {}) {
    this.allowedGuildIds = new Set(normalizeIds(seed.allowedGuildIds));
    this.allowedUserIds = new Set(normalizeIds(seed.allowedUserIds));
    this.allowedChannelIds = new Set(normalizeIds(seed.allowedChannelIds));
    this.adminUserIds = new Set(normalizeIds(seed.adminUserIds));
  }

  list(scope: DiscordAuthScope): readonly string[] {
    return [...this.setForScope(scope)].sort();
  }

  add(scope: DiscordAuthScope, subjectId: string): void {
    this.setForScope(scope).add(normalizeId(subjectId));
  }

  remove(scope: DiscordAuthScope, subjectId: string): void {
    this.setForScope(scope).delete(normalizeId(subjectId));
  }

  hasAllowedGuilds(): boolean {
    return this.allowedGuildIds.size > 0;
  }

  isGuildAllowed(guildId: string): boolean {
    return this.allowedGuildIds.has(guildId);
  }

  hasAllowedUsers(): boolean {
    return this.allowedUserIds.size > 0;
  }

  isUserAllowed(userId: string): boolean {
    return this.allowedUserIds.has(userId);
  }

  hasAllowedChannels(): boolean {
    return this.allowedChannelIds.size > 0;
  }

  isChannelAllowed(channelId: string): boolean {
    return this.allowedChannelIds.has(channelId);
  }

  hasAdminUsers(): boolean {
    return this.adminUserIds.size > 0;
  }

  isAdminUser(userId: string): boolean {
    return this.adminUserIds.has(userId);
  }

  describe(): DiscordAuthDatabaseCounts {
    return {
      allowedGuildCount: this.allowedGuildIds.size,
      allowedUserCount: this.allowedUserIds.size,
      allowedChannelCount: this.allowedChannelIds.size,
      adminUserCount: this.adminUserIds.size,
    };
  }

  private setForScope(scope: DiscordAuthScope): Set<string> {
    switch (scope) {
      case 'allowed-guild':
        return this.allowedGuildIds;
      case 'allowed-user':
        return this.allowedUserIds;
      case 'allowed-channel':
        return this.allowedChannelIds;
      case 'admin-user':
        return this.adminUserIds;
    }
  }
}

export class SqliteDiscordAuthDatabase implements DiscordAuthDatabase {
  private readonly dbPath: string;
  private readonly driver: SqliteDiscordAuthDatabaseDriver;
  private readonly pythonBinaryPath: string;
  private readonly sqliteBinaryPath: string;
  private readonly runSql: SqliteDiscordAuthDatabaseRunner;

  constructor(options: SqliteDiscordAuthDatabaseOptions) {
    this.dbPath = options.dbPath;
    this.driver = options.driver ?? 'python';
    this.pythonBinaryPath = options.pythonBinaryPath ?? 'python3';
    this.sqliteBinaryPath = options.sqliteBinaryPath ?? 'sqlite3';
    this.runSql = options.runSql ?? defaultSqliteRunner;

    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.execute(SQLITE_SCHEMA_SQL);
    const sql = seedSql(options.seed);
    if (sql.length > 0) {
      this.execute(sql);
    }
  }

  list(scope: DiscordAuthScope): readonly string[] {
    return parseRows(this.query(listSql(scope)));
  }

  add(scope: DiscordAuthScope, subjectId: string): void {
    this.execute(addSql(scope, normalizeId(subjectId)));
  }

  remove(scope: DiscordAuthScope, subjectId: string): void {
    this.execute(removeSql(scope, normalizeId(subjectId)));
  }

  hasAllowedGuilds(): boolean {
    return this.count('allowed-guild') > 0;
  }

  isGuildAllowed(guildId: string): boolean {
    return this.contains('allowed-guild', guildId);
  }

  hasAllowedUsers(): boolean {
    return this.count('allowed-user') > 0;
  }

  isUserAllowed(userId: string): boolean {
    return this.contains('allowed-user', userId);
  }

  hasAllowedChannels(): boolean {
    return this.count('allowed-channel') > 0;
  }

  isChannelAllowed(channelId: string): boolean {
    return this.contains('allowed-channel', channelId);
  }

  hasAdminUsers(): boolean {
    return this.count('admin-user') > 0;
  }

  isAdminUser(userId: string): boolean {
    return this.contains('admin-user', userId);
  }

  describe(): DiscordAuthDatabaseCounts {
    return {
      allowedGuildCount: this.count('allowed-guild'),
      allowedUserCount: this.count('allowed-user'),
      allowedChannelCount: this.count('allowed-channel'),
      adminUserCount: this.count('admin-user'),
    };
  }

  private count(scope: DiscordAuthScope): number {
    return parseCount(this.query(countSql(scope)));
  }

  private contains(scope: DiscordAuthScope, subjectId: string): boolean {
    return this.query(containsSql(scope, subjectId)).trim() === '1';
  }

  private execute(sql: string): void {
    this.runSql({
      dbPath: this.dbPath,
      sql,
      returnsRows: false,
      driver: this.driver,
      pythonBinaryPath: this.pythonBinaryPath,
      sqliteBinaryPath: this.sqliteBinaryPath,
    });
  }

  private query(sql: string): string {
    return this.runSql({
      dbPath: this.dbPath,
      sql,
      returnsRows: true,
      driver: this.driver,
      pythonBinaryPath: this.pythonBinaryPath,
      sqliteBinaryPath: this.sqliteBinaryPath,
    });
  }
}
