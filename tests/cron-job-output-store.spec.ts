/**
 * M9 — Cron job output store + context_from chaining (data plane).
 *
 * Tests cover:
 *   - SILENT_MARKER stripping (with and without leading whitespace)
 *   - InMemoryJobOutputStore record/latest/history bounds
 *   - JsonlJobOutputStore round-trip via the on-disk file
 *   - resolveContextFrom: single and array refs, silent inclusion default,
 *     `includeSilent: false` skipping, missing-ref `absent` status,
 *     deterministic block ordering and merge formatting.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  InMemoryJobOutputStore,
  JsonlJobOutputStore,
  resolveContextFrom,
  SILENT_MARKER,
  stripSilentMarker,
  type JobOutput,
} from '../src/cron/job-output-store.js';

function mkDir(): string {
  return mkdtempSync(join(tmpdir(), 'aa-cron-store-'));
}

function output(
  jobId: string,
  runId: string,
  content: string,
  silent = false,
  observedAt = '2026-05-01T00:00:00.000Z',
): JobOutput {
  return { jobId, runId, content, silent, observedAt };
}

describe('M9 — stripSilentMarker', () => {
  it('strips a leading SILENT_MARKER and reports silent=true', () => {
    const result = stripSilentMarker(`${SILENT_MARKER}\nhello world`);
    expect(result.silent).toBe(true);
    expect(result.stripped).toBe('hello world');
  });

  it('handles whitespace before the marker', () => {
    const result = stripSilentMarker(`   \n${SILENT_MARKER}\nbody`);
    expect(result.silent).toBe(true);
    expect(result.stripped).toBe('body');
  });

  it('passes through content without the marker unchanged', () => {
    const result = stripSilentMarker('plain output');
    expect(result.silent).toBe(false);
    expect(result.stripped).toBe('plain output');
  });

  it('only matches the marker at the start, not mid-content', () => {
    const result = stripSilentMarker(`hello ${SILENT_MARKER}`);
    expect(result.silent).toBe(false);
    expect(result.stripped).toBe(`hello ${SILENT_MARKER}`);
  });
});

describe('M9 — InMemoryJobOutputStore', () => {
  it('returns undefined for an absent jobId', () => {
    const store = new InMemoryJobOutputStore();
    expect(store.latest('no-such-job')).toBeUndefined();
    expect(store.history('no-such-job')).toEqual([]);
  });

  it('latest returns the most-recent record', () => {
    const store = new InMemoryJobOutputStore();
    store.record(output('job-A', 'run-1', 'first', false, '2026-05-01T00:00:00.000Z'));
    store.record(output('job-A', 'run-2', 'second', false, '2026-05-01T01:00:00.000Z'));
    expect(store.latest('job-A')).toMatchObject({ runId: 'run-2', content: 'second' });
  });

  it('history is bounded by retentionPerJob', () => {
    const store = new InMemoryJobOutputStore({ retentionPerJob: 2 });
    store.record(output('job-A', 'r1', 'first'));
    store.record(output('job-A', 'r2', 'second'));
    store.record(output('job-A', 'r3', 'third'));
    const hist = store.history('job-A');
    expect(hist.map((h) => h.runId)).toEqual(['r3', 'r2']);
  });

  it('returns shallow copies — caller mutation does not leak', () => {
    const store = new InMemoryJobOutputStore();
    store.record(output('job-A', 'r1', 'one'));
    const copy = store.latest('job-A');
    if (copy === undefined) throw new Error('expected output');
    // mutate the copy
    (copy as { content: string }).content = 'tampered';
    expect(store.latest('job-A')?.content).toBe('one');
  });
});

describe('M9 — JsonlJobOutputStore', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('round-trips records via the JSONL file', () => {
    dir = mkDir();
    const path = join(dir, 'sub', 'job-outputs.jsonl');
    const store = new JsonlJobOutputStore(path, 4);
    store.record(output('job-X', 'run-A', 'alpha', false, '2026-05-01T00:00:00.000Z'));
    store.record(output('job-X', 'run-B', 'beta', false, '2026-05-01T01:00:00.000Z'));
    expect(store.latest('job-X')).toMatchObject({ runId: 'run-B', content: 'beta' });
    expect(store.history('job-X').map((h) => h.runId)).toEqual(['run-B', 'run-A']);
  });

  it('returns empty results when the file does not exist', () => {
    dir = mkDir();
    const store = new JsonlJobOutputStore(join(dir, 'never-written.jsonl'));
    expect(store.latest('job-Y')).toBeUndefined();
    expect(store.history('job-Y')).toEqual([]);
  });

  it('skips malformed lines without crashing', () => {
    dir = mkDir();
    const path = join(dir, 'mixed.jsonl');
    const store = new JsonlJobOutputStore(path);
    store.record(output('job-Z', 'r1', 'good'));
    // append a corrupted line manually
    appendFileSync(path, 'not-json\n', 'utf8');
    expect(store.history('job-Z').length).toBe(1);
  });
});

describe('M9 — resolveContextFrom', () => {
  it('returns undefined context when no refs resolve', () => {
    const store = new InMemoryJobOutputStore();
    const result = resolveContextFrom({
      contextFrom: ['job-missing-1', 'job-missing-2'],
      store,
    });
    expect(result.context).toBeUndefined();
    expect(result.entries.map((e) => e.status)).toEqual(['absent', 'absent']);
  });

  it('resolves a single string ref', () => {
    const store = new InMemoryJobOutputStore();
    store.record(output('news', 'r1', 'todays news', false, '2026-05-01T00:00:00.000Z'));
    const result = resolveContextFrom({
      contextFrom: 'news',
      store,
    });
    expect(result.context).toContain('todays news');
    expect(result.context).toContain('[from news @ 2026-05-01T00:00:00.000Z]');
    expect(result.entries[0]?.status).toBe('resolved');
  });

  it('merges array refs in order with separator blocks', () => {
    const store = new InMemoryJobOutputStore();
    store.record(output('a', 'ra', 'AAAA', false, '2026-05-01T00:00:00.000Z'));
    store.record(output('b', 'rb', 'BBBB', false, '2026-05-01T01:00:00.000Z'));
    const result = resolveContextFrom({
      contextFrom: ['a', 'b'],
      store,
    });
    expect(result.context).not.toBeUndefined();
    const idxA = result.context!.indexOf('AAAA');
    const idxB = result.context!.indexOf('BBBB');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThan(idxA);
  });

  it('default includeSilent=true: silent outputs ARE included', () => {
    const store = new InMemoryJobOutputStore();
    store.record(output('s', 'r1', 'silent payload', true));
    const result = resolveContextFrom({ contextFrom: 's', store });
    expect(result.context).toContain('silent payload');
    expect(result.entries[0]?.status).toBe('resolved');
  });

  it('includeSilent=false: silent outputs are skipped with status silent-skipped', () => {
    const store = new InMemoryJobOutputStore();
    store.record(output('s', 'r1', 'silent payload', true));
    const result = resolveContextFrom({
      contextFrom: 's',
      store,
      includeSilent: false,
    });
    expect(result.context).toBeUndefined();
    expect(result.entries[0]?.status).toBe('silent-skipped');
  });

  it('handles a mix of resolved + absent + silent-skipped entries', () => {
    const store = new InMemoryJobOutputStore();
    store.record(output('present', 'rp', 'visible'));
    store.record(output('quiet', 'rq', 'hidden', true));
    const result = resolveContextFrom({
      contextFrom: ['missing', 'present', 'quiet'],
      store,
      includeSilent: false,
    });
    expect(result.entries.map((e) => e.status)).toEqual([
      'absent',
      'resolved',
      'silent-skipped',
    ]);
    expect(result.context).toContain('visible');
    expect(result.context).not.toContain('hidden');
  });
});
