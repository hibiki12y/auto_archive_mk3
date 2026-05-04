/**
 * Opt-in retention bound on `InMemoryExecutionApprovalStore.records`
 * (audit 2026-05-04 follow-up).
 *
 * Same audit class as PR #18 (`SubagentOperatorSurface` log map cap),
 * PR #19 (compute-node allocations), PR #21
 * (`PromptCacheInvariant.forgetTask`), PR #22 (`Dispatcher.submittedTaskIds`).
 *
 * The store is `@stability frozen` and the public surface
 * (`create` / `consume` / `get`) does NOT enumerate records, so eviction
 * of terminal records past `expiresAt + grace` is observable only through
 * `get(approvalId)` returning `undefined` — the same `'unknown approval id'`
 * path that already exists for never-known ids.
 */

import { describe, expect, it } from 'vitest';

import { InMemoryExecutionApprovalStore } from '../src/index.js';
import type {
  ExecutionApprovalRecord,
  ExecutionApprovalStatus,
} from '../src/core/execution-approval-store.js';

function buildRecord(
  approvalId: string,
  status: ExecutionApprovalStatus,
  expiresAtIso: string,
): ExecutionApprovalRecord {
  return {
    approvalId,
    taskId: `task-${approvalId}`,
    runtimeInstanceId: `agent-${approvalId}`,
    turnSequence: 0,
    commandKind: 'shell',
    canonicalCwd: '/tmp/test',
    envDigest: 'env-digest',
    requestedAt: '2026-05-04T00:00:00.000Z',
    expiresAt: expiresAtIso,
    status,
  };
}

describe('InMemoryExecutionApprovalStore — terminal record eviction', () => {
  it('omitting evictTerminalAfterExpiryMs preserves pre-PR no-eviction behaviour', () => {
    // Backward compatibility: existing callers (e.g. `new
    // InMemoryExecutionApprovalStore()` with no args at
    // `tests/approval-and-execution-binding.spec.ts:120`) must keep
    // observing the historical contract — terminal records persist
    // for the lifetime of the store.
    const store = new InMemoryExecutionApprovalStore();
    const expired = buildRecord('a-1', 'expired', '2026-05-04T00:00:00.000Z');
    store.create(expired);
    // Even queried millennia after `expiresAt`, the record is still
    // there because no retention policy was opted into.
    expect(store.get('a-1')?.status).toBe('expired');
  });

  it('evicts terminal records past expiresAt + grace on the next operation', () => {
    let nowMs = Date.parse('2026-05-04T00:00:00.000Z');
    const store = new InMemoryExecutionApprovalStore({
      evictTerminalAfterExpiryMs: 60_000, // 60s grace
      nowMs: () => nowMs,
    });

    store.create(buildRecord('keep-1', 'consumed', '2026-05-04T00:00:30.000Z'));
    store.create(buildRecord('keep-2', 'denied', '2026-05-04T00:00:30.000Z'));
    store.create(buildRecord('evict-me', 'expired', '2026-05-04T00:00:00.000Z'));

    // Advance past evict-me's expiresAt + grace (60s) but not past
    // keep-1 / keep-2's expiresAt (still in the future).
    nowMs = Date.parse('2026-05-04T00:01:01.000Z');

    // Trigger lazy prune by calling any public method.
    expect(store.get('evict-me')).toBeUndefined();
    expect(store.get('keep-1')?.status).toBe('consumed');
    expect(store.get('keep-2')?.status).toBe('denied');
  });

  it('does NOT evict non-terminal records even past expiresAt', () => {
    let nowMs = Date.parse('2026-05-04T00:00:00.000Z');
    const store = new InMemoryExecutionApprovalStore({
      evictTerminalAfterExpiryMs: 0, // immediate eviction past expiresAt
      nowMs: () => nowMs,
    });

    // `pending` and `approved` are non-terminal — their `expiresAt` is
    // a contract for the consume-time check, not an eviction signal.
    store.create(buildRecord('pending', 'pending', '2026-05-04T00:00:00.000Z'));
    store.create(buildRecord('approved', 'approved', '2026-05-04T00:00:00.000Z'));

    nowMs = Date.parse('2026-05-04T01:00:00.000Z');
    expect(store.get('pending')?.status).toBe('pending');
    expect(store.get('approved')?.status).toBe('approved');
  });

  it('eviction is observable only as the documented unknown-id path', () => {
    let nowMs = Date.parse('2026-05-04T00:00:00.000Z');
    const store = new InMemoryExecutionApprovalStore({
      evictTerminalAfterExpiryMs: 0,
      nowMs: () => nowMs,
    });
    store.create(buildRecord('approved-evicted', 'approved', '2026-05-04T00:00:00.000Z'));
    // Mark consumed via the consume path so the store sees a real
    // terminal transition (then evict on the next operation).
    const result = store.consume({
      approvalId: 'approved-evicted',
      taskId: 'task-approved-evicted',
      runtimeInstanceId: 'agent-approved-evicted',
      commandKind: 'shell',
      canonicalCwd: '/tmp/test',
      envDigest: 'env-digest',
      now: '2026-05-04T00:00:00.000Z',
    });
    expect(result.status).toBe('allowed');

    nowMs = Date.parse('2026-05-04T01:00:00.000Z');
    // Subsequent consume of the now-evicted id surfaces the documented
    // unknown-id reason — the same path that has always existed for
    // never-known ids.
    const after = store.consume({
      approvalId: 'approved-evicted',
      taskId: 'task-approved-evicted',
      runtimeInstanceId: 'agent-approved-evicted',
      commandKind: 'shell',
      canonicalCwd: '/tmp/test',
      envDigest: 'env-digest',
      now: '2026-05-04T01:00:00.000Z',
    });
    expect(after).toEqual({ status: 'denied', reason: 'unknown approval id' });
  });

  it('reusing an evicted approvalId on create is admitted (no DuplicateError)', () => {
    let nowMs = Date.parse('2026-05-04T00:00:00.000Z');
    const store = new InMemoryExecutionApprovalStore({
      evictTerminalAfterExpiryMs: 0,
      nowMs: () => nowMs,
    });
    store.create(buildRecord('a', 'expired', '2026-05-04T00:00:00.000Z'));
    nowMs = Date.parse('2026-05-04T00:00:01.000Z');
    expect(() =>
      store.create(buildRecord('a', 'pending', '2026-05-04T00:01:00.000Z')),
    ).not.toThrow();
    expect(store.get('a')?.status).toBe('pending');
  });
});
