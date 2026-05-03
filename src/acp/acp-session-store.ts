/**
 * M10 Stage 4 — ACP session persistence store.
 *
 * Per-session JSON snapshot at
 *   `${AUTO_ARCHIVE_HOME:-${HOME}/.auto-archive}/acp-sessions/<sessionId>.json`
 *
 * Each session is one file. NOT a JSONL append-only log — the
 * canonical event trail lives in `control-plane-ledger`. The store
 * holds only what's needed to reconstruct an `AcpSessionState` after
 * a process restart so `session/load` and `session/resume` work.
 *
 * Atomic write: write to `<sessionId>.json.tmp.<pid>.<rand>` then
 * `rename` to `<sessionId>.json`. A crash mid-write leaves the
 * previous file intact (either the old valid snapshot or no file
 * at all if this was the first write).
 *
 * Read returns `undefined` for a missing file — callers treat absence
 * as "no such session" rather than an error.
 *
 * Schema versioning: every record carries `schemaVersion: 1`. Future
 * schema bumps validate this on read and either upgrade in-place or
 * reject loudly. Stage 4 ships v1 and accepts only v1.
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { AcpSessionId } from '../contracts/acp-session.js';

/** Persisted shape — superset of in-memory `AcpSessionState`. */
export interface PersistedAcpSessionRecord {
  readonly schemaVersion: 1;
  readonly sessionId: AcpSessionId;
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly createdAt: string;
  readonly lastTouchedAt: string;
  readonly parentSessionId?: AcpSessionId;
}

export interface AcpSessionStore {
  read(sessionId: AcpSessionId): Promise<PersistedAcpSessionRecord | undefined>;
  write(record: PersistedAcpSessionRecord): Promise<void>;
  remove(sessionId: AcpSessionId): Promise<void>;
  list(): Promise<readonly AcpSessionId[]>;
}

export interface JsonAcpSessionStoreOptions {
  /**
   * Directory that will hold per-session JSON files. The directory
   * is created lazily on first write. When omitted, defaults to
   * `${AUTO_ARCHIVE_HOME:-${HOME}/.auto-archive}/acp-sessions`.
   */
  readonly directory?: string;
  /**
   * Test seam for `now`. Defaults to `() => new Date().toISOString()`.
   */
  readonly now?: () => string;
  /**
   * Test seam for the random suffix on the temp filename. Defaults
   * to a 16-hex random string.
   */
  readonly randomSuffix?: () => string;
}

const DIRECTORY_BASENAME = 'acp-sessions';

/** Resolve the default storage directory honoring `AUTO_ARCHIVE_HOME`. */
export function defaultAcpSessionDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.AUTO_ARCHIVE_HOME ?? join(homedir(), '.auto-archive');
  return join(root, DIRECTORY_BASENAME);
}

/**
 * Validate that a sessionId can safely become a file basename. Allow
 * only alphanumerics + `-` + `_` + `.` (no `..`, no path separators).
 * Throws TypeError on bad input — file IO must NEVER follow operator
 * input across directories.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeSessionId(sessionId: string): void {
  if (sessionId.length === 0 || sessionId.length > 128) {
    throw new TypeError(`acp-session-store: sessionId must be 1-128 chars`);
  }
  // Pattern requires the first char to be alphanumeric so leading
  // dots (which would otherwise produce hidden files like `..stray`)
  // are rejected. Path-traversal sentinels (`.` / `..`) are caught
  // by the leading-alphanumeric requirement; explicit checks left in
  // place for defense-in-depth in case the pattern is later relaxed.
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new TypeError(
      `acp-session-store: sessionId contains illegal characters: ${JSON.stringify(sessionId)}`,
    );
  }
  if (sessionId === '.' || sessionId === '..') {
    throw new TypeError(
      `acp-session-store: sessionId must not be "." or ".."`,
    );
  }
}

function defaultRandomSuffix(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

export class JsonAcpSessionStore implements AcpSessionStore {
  private readonly directory: string;
  private readonly now: () => string;
  private readonly randomSuffix: () => string;
  private dirEnsured = false;

  constructor(options: JsonAcpSessionStoreOptions = {}) {
    this.directory = resolve(options.directory ?? defaultAcpSessionDirectory());
    this.now = options.now ?? (() => new Date().toISOString());
    this.randomSuffix = options.randomSuffix ?? defaultRandomSuffix;
  }

  /** Exposed for tests / runbook. */
  resolvedDirectory(): string {
    return this.directory;
  }

  async read(sessionId: AcpSessionId): Promise<PersistedAcpSessionRecord | undefined> {
    assertSafeSessionId(sessionId);
    const path = this.pathFor(sessionId);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
    return parseRecord(raw, path);
  }

  async write(record: PersistedAcpSessionRecord): Promise<void> {
    assertSafeSessionId(record.sessionId);
    if (record.schemaVersion !== 1) {
      throw new TypeError(
        `acp-session-store: only schemaVersion=1 is supported; got ${record.schemaVersion}`,
      );
    }
    await this.ensureDir();
    const finalPath = this.pathFor(record.sessionId);
    const tmpPath = `${finalPath}.tmp.${process.pid}.${this.randomSuffix()}`;
    const stamped: PersistedAcpSessionRecord = {
      ...record,
      lastTouchedAt: record.lastTouchedAt ?? this.now(),
    };
    const body = `${JSON.stringify(stamped, null, 2)}\n`;
    await writeFile(tmpPath, body, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(tmpPath, finalPath);
    } catch (err) {
      // Best-effort cleanup of the tmp file on rename failure.
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }

  async remove(sessionId: AcpSessionId): Promise<void> {
    assertSafeSessionId(sessionId);
    const path = this.pathFor(sessionId);
    try {
      await unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }

  async list(): Promise<readonly AcpSessionId[]> {
    let entries: readonly string[];
    try {
      entries = await readdir(this.directory);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
    const out: AcpSessionId[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const sessionId = entry.slice(0, -'.json'.length);
      // Defensive — skip anything that would not round-trip via
      // assertSafeSessionId, so a stray file in the directory cannot
      // produce a SessionId we could not later read back.
      if (SESSION_ID_PATTERN.test(sessionId)) {
        out.push(sessionId);
      }
    }
    return out;
  }

  private pathFor(sessionId: AcpSessionId): string {
    return join(this.directory, `${sessionId}.json`);
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Defensive: also guarantee the parent exists if the user pointed
    // `directory` at a path with non-existent ancestors. `recursive:
    // true` already handles this, but documenting the invariant.
    this.dirEnsured = true;
  }
}

function parseRecord(raw: string, path: string): PersistedAcpSessionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `acp-session-store: invalid JSON at ${path}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`acp-session-store: record at ${path} is not an object`);
  }
  const r = parsed as Record<string, unknown>;
  if (r.schemaVersion !== 1) {
    throw new Error(
      `acp-session-store: unsupported schemaVersion at ${path}: ${String(r.schemaVersion)}`,
    );
  }
  if (typeof r.sessionId !== 'string' || typeof r.cwd !== 'string') {
    throw new Error(`acp-session-store: missing sessionId/cwd at ${path}`);
  }
  if (typeof r.createdAt !== 'string' || typeof r.lastTouchedAt !== 'string') {
    throw new Error(`acp-session-store: missing createdAt/lastTouchedAt at ${path}`);
  }
  const additionalDirectories = Array.isArray(r.additionalDirectories)
    ? r.additionalDirectories.filter((x): x is string => typeof x === 'string')
    : [];
  const out: PersistedAcpSessionRecord = {
    schemaVersion: 1,
    sessionId: r.sessionId,
    cwd: r.cwd,
    additionalDirectories,
    createdAt: r.createdAt,
    lastTouchedAt: r.lastTouchedAt,
    ...(typeof r.parentSessionId === 'string'
      ? { parentSessionId: r.parentSessionId }
      : {}),
  };
  return out;
}

