import { describe, expect, it, afterEach } from 'vitest';
import { resolve } from 'node:path';

import {
  createConfigCache,
  type ConfigCacheOptions,
  type ConfigCachePort,
} from '../src/config/config-cache.js';

// ---------------------------------------------------------------------------
// Fake file-system helpers
// ---------------------------------------------------------------------------

interface FakeFile {
  content: string;
  mtimeMs: number;
}

function makeFakeFs(files: Map<string, FakeFile>): NonNullable<ConfigCacheOptions['fs']> {
  return {
    readFileSync(path: string, _encoding: 'utf8'): string {
      const entry = files.get(path);
      if (entry === undefined) {
        const err = Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
          code: 'ENOENT',
        });
        throw err;
      }
      return entry.content;
    },
    statSync(path: string): { mtimeMs: number } {
      const entry = files.get(path);
      if (entry === undefined) {
        const err = Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), {
          code: 'ENOENT',
        });
        throw err;
      }
      return { mtimeMs: entry.mtimeMs };
    },
  };
}

function makeCache(files: Map<string, FakeFile>, extraOptions?: Partial<ConfigCacheOptions>): ConfigCachePort {
  return createConfigCache({ fs: makeFakeFs(files), ...extraOptions });
}

function parseDotenv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    result[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createConfigCache', () => {
  describe('basic cache behaviour (enabled)', () => {
    it('returns parsed value on first call (cache miss)', () => {
      const absPath = resolve('/repo/.env');
      const files = new Map([[absPath, { content: 'TOKEN=abc', mtimeMs: 1000 }]]);
      const cache = makeCache(files);

      const entry = cache.get(absPath, parseDotenv);

      expect(entry.cacheHit).toBe(false);
      expect(entry.value).toEqual({ TOKEN: 'abc' });
      expect(entry.absolutePath).toBe(absPath);
      expect(entry.mtimeMs).toBe(1000);
      expect(entry.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns cache hit on second call with same mtime', () => {
      const absPath = resolve('/repo/.env');
      const files = new Map([[absPath, { content: 'TOKEN=abc', mtimeMs: 1000 }]]);
      const cache = makeCache(files);
      const parseCount = { n: 0 };
      const parse = (raw: string): Record<string, string> => {
        parseCount.n++;
        return parseDotenv(raw);
      };

      cache.get(absPath, parse);
      const second = cache.get(absPath, parse);

      expect(second.cacheHit).toBe(true);
      expect(parseCount.n).toBe(1); // parse only called once
      expect(second.value).toEqual({ TOKEN: 'abc' });
    });

    it('invalidates on mtime change', () => {
      const absPath = resolve('/repo/.env');
      const files = new Map([[absPath, { content: 'TOKEN=abc', mtimeMs: 1000 }]]);
      const cache = makeCache(files);
      const parseCount = { n: 0 };
      const parse = (raw: string): Record<string, string> => {
        parseCount.n++;
        return parseDotenv(raw);
      };

      cache.get(absPath, parse);

      // Simulate file replacement
      files.set(absPath, { content: 'TOKEN=xyz', mtimeMs: 2000 });
      const second = cache.get(absPath, parse);

      expect(second.cacheHit).toBe(false);
      expect(parseCount.n).toBe(2);
      expect(second.value).toEqual({ TOKEN: 'xyz' });
      expect(second.mtimeMs).toBe(2000);
    });

    it('normalizes relative paths to absolute via path.resolve()', () => {
      const absPath = resolve('./some-relative-config.env');
      const files = new Map([[absPath, { content: 'X=1', mtimeMs: 500 }]]);
      const cache = makeCache(files);

      const fromRelative = cache.get('./some-relative-config.env', parseDotenv);
      const fromAbsolute = cache.get(absPath, parseDotenv);

      expect(fromRelative.absolutePath).toBe(absPath);
      expect(fromAbsolute.absolutePath).toBe(absPath);
      // Second call should be a cache hit because both resolve to the same key
      expect(fromAbsolute.cacheHit).toBe(true);
    });

    it('handles zero-length files without throwing', () => {
      const absPath = resolve('/repo/empty.env');
      const files = new Map([[absPath, { content: '', mtimeMs: 100 }]]);
      const cache = makeCache(files);

      const entry = cache.get(absPath, parseDotenv);

      expect(entry.cacheHit).toBe(false);
      expect(entry.value).toEqual({});
    });

    it('propagates ENOENT on missing file', () => {
      const cache = makeCache(new Map());

      expect(() => cache.get('/does/not/exist.env', parseDotenv)).toThrow(/ENOENT/);
    });

    it('supports invalidate() to force re-parse', () => {
      const absPath = resolve('/repo/.env');
      const files = new Map([[absPath, { content: 'A=1', mtimeMs: 1000 }]]);
      const cache = makeCache(files);
      const parseCount = { n: 0 };
      const parse = (raw: string): Record<string, string> => {
        parseCount.n++;
        return parseDotenv(raw);
      };

      cache.get(absPath, parse); // miss
      cache.invalidate(absPath);

      const second = cache.get(absPath, parse); // miss again (entry evicted)
      expect(second.cacheHit).toBe(false);
      expect(parseCount.n).toBe(2);
    });

    it('invalidate() normalizes relative paths', () => {
      const absPath = resolve('/repo/.env');
      const files = new Map([[absPath, { content: 'A=1', mtimeMs: 1000 }]]);
      const cache = makeCache(files);
      const parseCount = { n: 0 };
      const parse = (raw: string): Record<string, string> => {
        parseCount.n++;
        return parseDotenv(raw);
      };

      cache.get(absPath, parse);
      // Invalidate using relative form — should still evict the absolute key
      cache.invalidate('/repo/.env');
      cache.get(absPath, parse);

      expect(parseCount.n).toBe(2);
    });

    it('supports clear() to evict all entries', () => {
      const pathA = resolve('/repo/a.env');
      const pathB = resolve('/repo/b.env');
      const files = new Map([
        [pathA, { content: 'A=1', mtimeMs: 1000 }],
        [pathB, { content: 'B=2', mtimeMs: 2000 }],
      ]);
      const cache = makeCache(files);
      const parseCount = { n: 0 };
      const parse = (raw: string): Record<string, string> => {
        parseCount.n++;
        return parseDotenv(raw);
      };

      cache.get(pathA, parse);
      cache.get(pathB, parse);
      expect(parseCount.n).toBe(2);

      cache.clear();

      cache.get(pathA, parse);
      cache.get(pathB, parse);
      expect(parseCount.n).toBe(4);
    });

    it('stores checksum derived from raw content, not parsed value', () => {
      const absPath = resolve('/repo/.env');
      const files = new Map([[absPath, { content: 'TOKEN=abc', mtimeMs: 1000 }]]);
      const cache = makeCache(files);

      const first = cache.get(absPath, parseDotenv);
      const second = cache.get(absPath, parseDotenv);

      expect(first.checksum).toBe(second.checksum);
      expect(first.checksum).toHaveLength(64); // sha256 hex
    });

    it('does not cache across different absolute paths', () => {
      const pathA = resolve('/repo/a.env');
      const pathB = resolve('/repo/b.env');
      const files = new Map([
        [pathA, { content: 'A=1', mtimeMs: 1000 }],
        [pathB, { content: 'B=2', mtimeMs: 1000 }],
      ]);
      const cache = makeCache(files);

      const a = cache.get(pathA, parseDotenv);
      const b = cache.get(pathB, parseDotenv);

      expect(a.value).toEqual({ A: '1' });
      expect(b.value).toEqual({ B: '2' });
      expect(b.cacheHit).toBe(false);
    });
  });

  describe('disabled cache (AUTO_ARCHIVE_CONFIG_CACHE=off / options.enabled=false)', () => {
    it('always re-parses when explicitly disabled', () => {
      const absPath = resolve('/repo/.env');
      const files = new Map([[absPath, { content: 'TOKEN=abc', mtimeMs: 1000 }]]);
      const cache = makeCache(files, { enabled: false });
      const parseCount = { n: 0 };
      const parse = (raw: string): Record<string, string> => {
        parseCount.n++;
        return parseDotenv(raw);
      };

      cache.get(absPath, parse);
      cache.get(absPath, parse);
      cache.get(absPath, parse);

      expect(parseCount.n).toBe(3);
    });

    it('always returns cacheHit: false when disabled', () => {
      const absPath = resolve('/repo/.env');
      const files = new Map([[absPath, { content: 'X=1', mtimeMs: 100 }]]);
      const cache = makeCache(files, { enabled: false });

      expect(cache.get(absPath, parseDotenv).cacheHit).toBe(false);
      expect(cache.get(absPath, parseDotenv).cacheHit).toBe(false);
    });

    it('still propagates ENOENT when disabled', () => {
      const cache = createConfigCache({ enabled: false, fs: makeFakeFs(new Map()) });
      expect(() => cache.get('/missing.env', parseDotenv)).toThrow(/ENOENT/);
    });

    it('reflects enabled=false on the port property', () => {
      const cache = createConfigCache({ enabled: false });
      expect(cache.enabled).toBe(false);
    });

    it('reflects enabled=true by default', () => {
      const cache = createConfigCache({ fs: makeFakeFs(new Map()) });
      expect(cache.enabled).toBe(true);
    });
  });

  describe('env-flag resolution (AUTO_ARCHIVE_CONFIG_CACHE)', () => {
    const origEnv = process.env['AUTO_ARCHIVE_CONFIG_CACHE'];

    afterEach(() => {
      if (origEnv === undefined) {
        delete process.env['AUTO_ARCHIVE_CONFIG_CACHE'];
      } else {
        process.env['AUTO_ARCHIVE_CONFIG_CACHE'] = origEnv;
      }
    });

    it('disables cache when AUTO_ARCHIVE_CONFIG_CACHE=off', () => {
      process.env['AUTO_ARCHIVE_CONFIG_CACHE'] = 'off';
      const cache = createConfigCache({ fs: makeFakeFs(new Map()) });
      expect(cache.enabled).toBe(false);
    });

    it('enables cache when AUTO_ARCHIVE_CONFIG_CACHE is absent', () => {
      delete process.env['AUTO_ARCHIVE_CONFIG_CACHE'];
      const cache = createConfigCache({ fs: makeFakeFs(new Map()) });
      expect(cache.enabled).toBe(true);
    });

    it('enables cache when AUTO_ARCHIVE_CONFIG_CACHE=on', () => {
      process.env['AUTO_ARCHIVE_CONFIG_CACHE'] = 'on';
      const cache = createConfigCache({ fs: makeFakeFs(new Map()) });
      expect(cache.enabled).toBe(true);
    });

    it('explicit options.enabled=false wins over env AUTO_ARCHIVE_CONFIG_CACHE=on', () => {
      process.env['AUTO_ARCHIVE_CONFIG_CACHE'] = 'on';
      const cache = createConfigCache({ enabled: false, fs: makeFakeFs(new Map()) });
      expect(cache.enabled).toBe(false);
    });

    it('explicit options.enabled=true wins over env AUTO_ARCHIVE_CONFIG_CACHE=off', () => {
      process.env['AUTO_ARCHIVE_CONFIG_CACHE'] = 'off';
      const cache = createConfigCache({ enabled: true, fs: makeFakeFs(new Map()) });
      expect(cache.enabled).toBe(true);
    });
  });
});
