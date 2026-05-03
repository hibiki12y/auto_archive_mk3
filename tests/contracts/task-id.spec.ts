/**
 * WU-M Task Identity Invariant — generator and opacity contract tests.
 *
 * Spec: `specs/wu-m-task-identity-invariant.md`. Verifies BC-1, BC-2 (a/b/c),
 * BC-6 opacity, plus invariant I-M3 (uniqueness across system lifetime,
 * sampled) and I-M6 (round-trip preservation).
 *
 * Anti-scope: this file deliberately does NOT exercise issuance authority
 * (BC-4) or resume-from-checkpoint preservation (BC-5 / I-M2); those are
 * dispatcher-level concerns covered indirectly by the existing dispatcher
 * test suite carrying `taskId` end-to-end.
 */

import { describe, expect, it } from 'vitest';

import {
  assertTaskId,
  generateTaskId,
  isValidTaskId,
  type TaskId,
} from '../../src/contracts/task-id.js';

const UUIDV7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('WU-M task-id contract', () => {
  it('generateTaskId() returns a valid UUIDv7 string', () => {
    const id = generateTaskId();
    expect(typeof id).toBe('string');
    expect(id).toMatch(UUIDV7_REGEX);
    expect(isValidTaskId(id)).toBe(true);
  });

  it('isValidTaskId accepts valid UUIDv7 shapes and rejects others', () => {
    expect(isValidTaskId('019daa1b-0636-73eb-b0e7-d8c41351c25d')).toBe(true);
    // Wrong version nibble
    expect(isValidTaskId('019daa1b-0636-43eb-b0e7-d8c41351c25d')).toBe(false);
    // Wrong variant nibble
    expect(isValidTaskId('019daa1b-0636-73eb-70e7-d8c41351c25d')).toBe(false);
    // Truncated
    expect(isValidTaskId('019daa1b-0636-73eb-b0e7-d8c41351c25')).toBe(false);
    // Uppercase rejected (canonical lowercase only)
    expect(isValidTaskId('019DAA1B-0636-73EB-B0E7-D8C41351C25D')).toBe(false);
    // Wrong shape entirely
    expect(isValidTaskId('task-1')).toBe(false);
    expect(isValidTaskId('')).toBe(false);
    expect(isValidTaskId(null)).toBe(false);
    expect(isValidTaskId(undefined)).toBe(false);
    expect(isValidTaskId(42)).toBe(false);
    expect(isValidTaskId({})).toBe(false);
  });

  it('two consecutive generations differ (BC-2 (b) collision resistance, sampled)', () => {
    const a = generateTaskId();
    const b = generateTaskId();
    expect(a).not.toBe(b);
  });

  it('I-M3 sampled: 256 generations produce 256 distinct ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 256; i++) {
      ids.add(generateTaskId());
    }
    expect(ids.size).toBe(256);
  });

  it('BC-2 (a) monotonic time-ordering across generations', () => {
    // Lexicographic sort of UUIDv7 hex form coincides with millisecond-scale
    // time order; spaced calls must be non-decreasing in lexical order.
    const samples: string[] = [];
    for (let i = 0; i < 8; i++) {
      samples.push(generateTaskId());
      // Busy-wait for ~2ms to advance the millisecond counter without an
      // async boundary that would invite scheduler reordering noise.
      const start = Date.now();
      while (Date.now() - start < 2) {
        /* spin */
      }
    }
    const sorted = [...samples].sort();
    expect(sorted).toEqual(samples);
  });

  it('I-M6 round-trip: JSON serialization preserves the byte-string', () => {
    const id = generateTaskId();
    const wrapped = { taskId: id, payload: 'opaque' };
    const restored = JSON.parse(JSON.stringify(wrapped)) as { taskId: string };
    expect(restored.taskId).toBe(id);
    expect(restored.taskId.length).toBe(36);
  });

  it('BC-6 opacity: module exports no parser/inspector helpers', async () => {
    const mod = await import('../../src/contracts/task-id.js');
    const exported = Object.keys(mod).sort();
    // Whitelist of allowed exports — anything else means someone added a
    // structural inspector and broke BC-6.
    expect(exported).toEqual(
      ['assertTaskId', 'generateTaskId', 'isValidTaskId'].sort(),
    );
  });

  it('assertTaskId throws on shape violation, narrows to TaskId on success', () => {
    expect(() => assertTaskId('not-a-uuid')).toThrow(/UUIDv7/);
    expect(() => assertTaskId(123)).toThrow(/UUIDv7/);
    const fresh = generateTaskId();
    const narrowed: TaskId = assertTaskId(fresh);
    expect(narrowed).toBe(fresh);
  });

  it('TaskId brand prevents accidental misuse (type-level guard)', () => {
    // The brand is structural; a plain string is not assignable to TaskId
    // without going through generateTaskId / assertTaskId. The next line is
    // expected to fail type-checking — vitest does not type-check by default,
    // but `tsc --noEmit` (npm run build) does, so this stays as a comment-
    // bearing runtime assertion that exercises the only sanctioned widening.
    // @ts-expect-error — plain strings are not assignable to TaskId.
    const bad: TaskId = 'plain-string';
    expect(typeof bad).toBe('string');
  });
});
