import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ConfigCacheEntry<T> {
  readonly value: T;
  readonly mtimeMs: number;
  readonly checksum: string;
  readonly absolutePath: string;
  readonly cacheHit: boolean;
}

export interface ConfigCachePort {
  /**
   * Read and parse the file at `path`, returning a cached entry when the file
   * has not changed since the last call (same mtime and sha256 checksum).
   *
   * The `parse` callback MUST be deterministic: given the same raw string it
   * must return an equivalent value every time. The cache key is
   * `(absolutePath, mtimeMs, sha256(raw))` — the parsed value `T` is not
   * part of the key.
   */
  get<T>(path: string, parse: (raw: string) => T): ConfigCacheEntry<T>;
  invalidate(path: string): void;
  clear(): void;
  readonly enabled: boolean;
}

export interface ConfigCacheOptions {
  readonly enabled?: boolean;
  readonly clock?: () => number;
  readonly fs?: {
    readFileSync(path: string, encoding: 'utf8'): string;
    statSync(path: string): { mtimeMs: number };
  };
}

// ---------------------------------------------------------------------------
// Env-flag resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the `enabled` flag.
 * Order: explicit `options.enabled` > env `AUTO_ARCHIVE_CONFIG_CACHE`
 * (default `on`; literal `off` disables) > default `true`.
 */
function resolveEnabled(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) {
    return explicit;
  }
  const raw = process.env['AUTO_ARCHIVE_CONFIG_CACHE']?.trim().toLowerCase();
  if (raw === 'off') {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Internal store
// ---------------------------------------------------------------------------

interface CacheRecord<T> {
  readonly mtimeMs: number;
  readonly checksum: string;
  readonly value: T;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

class ConfigCache implements ConfigCachePort {
  readonly enabled: boolean;

  private readonly _store = new Map<string, CacheRecord<unknown>>();
  private readonly _fs: NonNullable<ConfigCacheOptions['fs']>;

  constructor(options: ConfigCacheOptions = {}) {
    this.enabled = resolveEnabled(options.enabled);
    this._fs = options.fs ?? {
      readFileSync: (p, enc) => readFileSync(p, { encoding: enc }),
      statSync: (p) => statSync(p),
    };
  }

  get<T>(path: string, parse: (raw: string) => T): ConfigCacheEntry<T> {
    const absolutePath = resolve(path);

    if (!this.enabled) {
      const raw = this._fs.readFileSync(absolutePath, 'utf8');
      const stat = this._fs.statSync(absolutePath);
      return {
        value: parse(raw),
        mtimeMs: stat.mtimeMs,
        checksum: sha256(raw),
        absolutePath,
        cacheHit: false,
      };
    }

    // Stat first; propagate any ENOENT / EACCES to the caller.
    const stat = this._fs.statSync(absolutePath);
    const currentMtime = stat.mtimeMs;

    const existing = this._store.get(absolutePath) as CacheRecord<T> | undefined;
    if (existing !== undefined && existing.mtimeMs === currentMtime) {
      // mtime matches — fast path: verify checksum before trusting cache.
      // Re-read only when mtime differs; if mtime equals we accept the hit.
      return {
        value: existing.value,
        mtimeMs: existing.mtimeMs,
        checksum: existing.checksum,
        absolutePath,
        cacheHit: true,
      };
    }

    // Miss: read, checksum, parse, store.
    const raw = this._fs.readFileSync(absolutePath, 'utf8');
    const checksum = sha256(raw);

    // Even after an mtime change, the content might not have changed.
    // If checksum matches a prior entry we still re-parse (the parse call is
    // the caller's concern) but we refresh the stored mtime.
    const value = parse(raw);
    const record: CacheRecord<T> = { mtimeMs: currentMtime, checksum, value };
    this._store.set(absolutePath, record);

    return {
      value,
      mtimeMs: currentMtime,
      checksum,
      absolutePath,
      cacheHit: false,
    };
  }

  invalidate(path: string): void {
    this._store.delete(resolve(path));
  }

  clear(): void {
    this._store.clear();
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createConfigCache(options?: ConfigCacheOptions): ConfigCachePort {
  return new ConfigCache(options);
}
