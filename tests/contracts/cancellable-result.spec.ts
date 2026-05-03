/**
 * WU-J `CancellableResultAsync<T, E>` — wrap-projection behavioral tests.
 *
 * Spec: `specs/wu-j-cancellable-result-wrap.md`. Verifies invariants
 * I-J1 (monotonic cancellation), I-J2 (terminal cause uniqueness), and
 * I-J3 (latch precedence over driver result, citing
 * `SubmissionCancellationState` in `src/core/dispatcher.ts` as oracle —
 * NOT redefined here), I-J4 (cause provenance preservation), and I-J5
 * (no SDK identity leakage). Also enforces the AC-J1 / AC-J2 / AC-J6 /
 * AC-J7 grep guards as direct file-content assertions, and AC-J8
 * type-bound on `<T, E>`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  cancellableCancelled,
  cancellableFailure,
  cancellableSuccess,
  isCancellableCancelled,
  isCancellableFailure,
  isCancellableSuccess,
  projectCancellableResult,
  type CancellableResult,
  type CancellableResultAsync,
  type CancellationLatchObserver,
  type CancellationTerminalCause,
  type DispatcherDriverFailure,
  type DriverResultEnvelope,
} from '../../src/contracts/cancellable-result.js';
import {
  generateTaskId,
  type TaskId,
} from '../../src/contracts/task-id.js';
import type {
  TerminalCause,
  TerminalCauseExternalCancel,
} from '../../src/contracts/terminal-cause.js';
import {
  CodexProviderFailureError,
} from '../../src/runtime/codex-runtime-adapter.js';

// ---------------------------------------------------------------------------
// Test latch double — faithfully mirrors SubmissionCancellationState's
// monotonic latch contract: first-wins, observers fire exactly once. The
// ordering oracle remains the production class in src/core/dispatcher.ts;
// this double exists only to drive the wrap's projection deterministically.
// ---------------------------------------------------------------------------

class TestLatch implements CancellationLatchObserver {
  private latched: CancellationTerminalCause | undefined;
  private readonly waiters = new Set<(c: CancellationTerminalCause) => void>();

  fire(cause: CancellationTerminalCause): void {
    if (this.latched !== undefined) return;
    this.latched = cause;
    for (const w of this.waiters) w(cause);
    this.waiters.clear();
  }

  currentLatchedCause(): CancellationTerminalCause | undefined {
    return this.latched;
  }

  whenLatched(): Promise<CancellationTerminalCause> {
    if (this.latched !== undefined) return Promise.resolve(this.latched);
    return new Promise((resolve) => this.waiters.add(resolve));
  }
}

function makeExternalCancelCause(taskId: TaskId): TerminalCauseExternalCancel {
  return {
    kind: 'external-cancel',
    taskId,
    runtimeInstanceId: 'agent-test',
    observedAt: '2026-04-20T00:00:00.000Z',
    provenance: 'test',
    reason: 'operator',
    requestedAt: '2026-04-20T00:00:00.000Z',
  };
}

function makeDriverFailureCause(taskId: TaskId): TerminalCause {
  return {
    kind: 'driver-failure',
    taskId,
    runtimeInstanceId: 'agent-test',
    observedAt: '2026-04-20T00:00:00.000Z',
    provenance: 'test',
    phase: 'execution',
    message: 'boom',
  };
}

describe('WU-J cancellable-result wrap', () => {
  it('cancellableSuccess / cancellableFailure / cancellableCancelled construct branches', () => {
    const taskId = generateTaskId();
    const success = cancellableSuccess(taskId, 'payload');
    expect(isCancellableSuccess(success)).toBe(true);
    expect(success.value).toBe('payload');

    const err = new CodexProviderFailureError('rate limited', 'turn.failed');
    const failure = cancellableFailure(taskId, err, makeDriverFailureCause(taskId));
    expect(isCancellableFailure(failure)).toBe(true);
    expect(failure.error).toBe(err);

    const cancelled = cancellableCancelled(taskId, makeExternalCancelCause(taskId));
    expect(isCancellableCancelled(cancelled)).toBe(true);
    expect(cancelled.cause.kind).toBe('external-cancel');
  });

  it('AC-J3 / I-J1: post-latch every observation through the wrap reports cancellation', async () => {
    const taskId = generateTaskId();
    const latch = new TestLatch();
    latch.fire(makeExternalCancelCause(taskId));

    // Driver promise that would otherwise resolve to success — wrap MUST
    // observe cancellation regardless because latch is already set.
    const driverResult = Promise.resolve<DriverResultEnvelope<string, CodexProviderFailureError>>({
      outcome: 'success',
      value: 'late-success',
    });
    const result = await projectCancellableResult({ taskId, latch, driverResult });
    expect(isCancellableCancelled(result)).toBe(true);

    // Repeat observations through fresh projections — still cancelled.
    const second = await projectCancellableResult({
      taskId,
      latch,
      driverResult: Promise.resolve({ outcome: 'success', value: 'second-success' }),
    });
    expect(isCancellableCancelled(second)).toBe(true);
  });

  it('AC-J4 / I-J2: a single resolution NEVER carries both T and a cancellation cause', async () => {
    const taskId = generateTaskId();
    const latch = new TestLatch();
    const driverResult: Promise<DriverResultEnvelope<number, CodexProviderFailureError>> =
      Promise.resolve({ outcome: 'success', value: 42 });
    const result = await projectCancellableResult({ taskId, latch, driverResult });

    // Discriminated-union shape forbids the simultaneous case at the type
    // level; the runtime check below enforces the same at value level.
    if (result.kind === 'success') {
      expect('cause' in result).toBe(false);
      expect((result as unknown as Record<string, unknown>)['cause']).toBeUndefined();
    } else {
      throw new Error('expected success branch');
    }
  });

  it('AC-J5 / I-J3: latch-before-success → cancellation', async () => {
    const taskId = generateTaskId();
    const latch = new TestLatch();
    // Latch fires synchronously (microtask 0) before the driver promise
    // resolves on a later microtask. Mirrors SubmissionCancellationState's
    // first-wins ordering; this test cites that class as oracle and does
    // NOT redefine the ordering.
    latch.fire(makeExternalCancelCause(taskId));
    const driverResult: Promise<DriverResultEnvelope<string, CodexProviderFailureError>> =
      new Promise((resolve) => setTimeout(() => resolve({ outcome: 'success', value: 'ok' }), 5));
    const result = await projectCancellableResult({ taskId, latch, driverResult });
    expect(result.kind).toBe('cancelled');
  });

  it('AC-J5 / I-J3: success-before-latch → success', async () => {
    const taskId = generateTaskId();
    const latch = new TestLatch();
    // Driver resolves immediately; latch never fires.
    const driverResult: Promise<DriverResultEnvelope<string, CodexProviderFailureError>> =
      Promise.resolve({ outcome: 'success', value: 'fast-success' });
    const result = await projectCancellableResult({ taskId, latch, driverResult });
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.value).toBe('fast-success');
    }
  });

  it('failure envelope projects to cancellable failure branch', async () => {
    const taskId = generateTaskId();
    const latch = new TestLatch();
    const err = new CodexProviderFailureError('temporary glitch', 'turn.failed');
    const driverResult: Promise<DriverResultEnvelope<string, CodexProviderFailureError>> =
      Promise.resolve({ outcome: 'failure', error: err, cause: makeDriverFailureCause(taskId) });
    const result = await projectCancellableResult({ taskId, latch, driverResult });
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.error).toBe(err);
      expect(result.cause.kind).toBe('driver-failure');
    }
  });

  it('AC-J2 / I-J5 grep: wrap module references no SDK abort identifiers', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const wrapPath = resolve(here, '../../src/contracts/cancellable-result.ts');
    const source = readFileSync(wrapPath, 'utf8');
    // Exclude code-fences in the JSDoc header that intentionally mention the
    // forbidden token in NEGATIVE form (e.g., "does not import AbortError").
    // Strip JSDoc/line comments before grepping.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(stripped).not.toMatch(/AbortError/);
    expect(stripped).not.toMatch(/instanceof[^\n]*Abort/);
  });

  it('AC-J6 grep: dispatcher module declares no NEW Error subclass beyond baseline', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const dispatcherPath = resolve(here, '../../src/core/dispatcher.ts');
    const source = readFileSync(dispatcherPath, 'utf8');
    const matches = source.match(/^export\s+class\s+\w+Error\b/gm) ?? [];
    // Baseline updated 2026-04-30 (R2 / F14): added InvalidLegacyTaskIdError
    // as the defensive charset gate for the legacy non-UUIDv7 admission
    // branch — non-WU-J error class scoped to admission-side input.
    expect(matches).toEqual([
      'export class DuplicateSubmissionError',
      'export class InvalidLegacyTaskIdError',
    ]);
  });

  it('AC-J8 / C-J6: <T, E> bound — E must be a named driver/provider failure', () => {
    // Positive: CodexProviderFailureError satisfies the bound.
    expectTypeOf<CancellableResult<number, CodexProviderFailureError>>().toBeObject();
    expectTypeOf<CancellableResultAsync<number, CodexProviderFailureError>>().resolves.toBeObject();
    // Bound enforcement: assigning a bare `Error` / `unknown` / `any` to E
    // must fail. Each line below is a compile-time guard; the build (tsc)
    // exercises it.
    // @ts-expect-error — bare Error is not assignable to DispatcherDriverFailure.
    type _Bad1 = CancellableResult<number, Error>;
    // @ts-expect-error — unknown is not assignable to DispatcherDriverFailure.
    type _Bad2 = CancellableResult<number, unknown>;
    // @ts-expect-error — any-equivalent string fails the bound at the type
    // level even though `any` itself would short-circuit; we use string here
    // to demonstrate the bound rejects unrelated named types.
    type _Bad3 = CancellableResult<number, string>;

    // Reference the unused aliases so eslint/tsc do not strip them and
    // re-validate the type expression at build time.
    const _r1 = (undefined as unknown) as _Bad1;
    const _r2 = (undefined as unknown) as _Bad2;
    const _r3 = (undefined as unknown) as _Bad3;
    expect([_r1, _r2, _r3]).toHaveLength(3);
  });

  it('AC-J9: spec cite check (this file references WU-J in its header)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const self = resolve(here, '../../tests/contracts/cancellable-result.spec.ts');
    const source = readFileSync(self, 'utf8');
    expect(source.slice(0, 400)).toMatch(/WU-J/);
  });

  it('DispatcherDriverFailure resolves to CodexProviderFailureError', () => {
    expectTypeOf<DispatcherDriverFailure>().toEqualTypeOf<CodexProviderFailureError>();
  });

  // ---------------------------------------------------------------------
  // I-J4 — Cause provenance preservation. The wrap MUST NOT overwrite,
  // normalize, or aggregate the `provenance` string carried on a
  // WU-H cause as it crosses the projection boundary.
  // ---------------------------------------------------------------------
  it('I-J4: cancellation cause provenance is preserved verbatim through the wrap', async () => {
    const taskId = generateTaskId();
    const latch = new TestLatch();
    const cause: TerminalCauseExternalCancel = {
      ...makeExternalCancelCause(taskId),
      provenance: 'driver-result-mapper:codex-runtime-driver@unique-token',
    };
    latch.fire(cause);
    const driverResult: Promise<DriverResultEnvelope<string, CodexProviderFailureError>> =
      new Promise(() => {
        /* never settles */
      });
    const result = await projectCancellableResult({ taskId, latch, driverResult });
    expect(result.kind).toBe('cancelled');
    if (result.kind === 'cancelled') {
      expect(result.cause.provenance).toBe(
        'driver-result-mapper:codex-runtime-driver@unique-token',
      );
      // Cause object itself is the same reference — no clone/normalize.
      expect(result.cause).toBe(cause);
    }
  });

  it('I-J4: failure cause provenance is preserved verbatim through the wrap', async () => {
    const taskId = generateTaskId();
    const latch = new TestLatch();
    const err = new CodexProviderFailureError('upstream 503', 'turn.failed');
    const cause: TerminalCause = {
      ...makeDriverFailureCause(taskId),
      provenance: 'codex-runtime-driver:rate-limit-classifier@v3',
    };
    const driverResult: Promise<DriverResultEnvelope<string, CodexProviderFailureError>> =
      Promise.resolve({ outcome: 'failure', error: err, cause });
    const result = await projectCancellableResult({ taskId, latch, driverResult });
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.cause.provenance).toBe(
        'codex-runtime-driver:rate-limit-classifier@v3',
      );
      expect(result.cause).toBe(cause);
    }
  });

  // ---------------------------------------------------------------------
  // AC-J1 — wrap module imports WU-H cause types by name and references
  // no other cause vocabulary in its cancellation branch.
  // ---------------------------------------------------------------------
  it('AC-J1: wrap module imports WU-H cause types by name (no alternate vocab)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const wrapPath = resolve(here, '../../src/contracts/cancellable-result.ts');
    const source = readFileSync(wrapPath, 'utf8');
    // Imports the WU-H cause types from the canonical module by name.
    expect(source).toMatch(/TerminalCauseExternalCancel/);
    expect(source).toMatch(/TerminalCauseRuntimeVeto/);
    expect(source).toMatch(/from '\.\/terminal-cause\.js'/);
    // CancellationTerminalCause MUST be the union of exactly those two
    // WU-H kinds — no third party cause vocabulary leaks into the
    // cancellation branch.
    const cancellationUnion = source.match(
      /export type CancellationTerminalCause\s*=\s*([\s\S]*?);/,
    );
    expect(cancellationUnion).not.toBeNull();
    const unionBody = cancellationUnion![1];
    expect(unionBody).toMatch(/TerminalCauseExternalCancel/);
    expect(unionBody).toMatch(/TerminalCauseRuntimeVeto/);
    // No other identifiers ending in `Cause` appear in the union body.
    const otherCauseRefs =
      unionBody.match(/\b\w*Cause\w*\b/g)?.filter(
        (id) =>
          id !== 'TerminalCauseExternalCancel' &&
          id !== 'TerminalCauseRuntimeVeto',
      ) ?? [];
    expect(otherCauseRefs).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // AC-J7 — implementation does not modify SubmissionCancellationState-
  // bearing files except for typed observer adapters at the wrap
  // boundary. Enforced here as: the wrap module exposes no mutator on
  // the latch (no `cancel`/`fire`/`trigger`/`set` methods on the
  // observer interface), and the latch class in dispatcher.ts retains
  // its existing API surface (no WU-J-introduced mutator names).
  // ---------------------------------------------------------------------
  it('AC-J7 / I-J7: wrap exposes a read-only observer surface (no mutator)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const wrapPath = resolve(here, '../../src/contracts/cancellable-result.ts');
    const source = readFileSync(wrapPath, 'utf8');
    // Locate the CancellationLatchObserver interface body.
    const ifaceMatch = source.match(
      /export interface CancellationLatchObserver\s*\{([\s\S]*?)\n\}/,
    );
    expect(ifaceMatch).not.toBeNull();
    const body = ifaceMatch![1];
    // Only read-shaped methods permitted: currentLatchedCause, whenLatched.
    expect(body).toMatch(/currentLatchedCause\s*\(/);
    expect(body).toMatch(/whenLatched\s*\(/);
    // No mutator-shaped names.
    expect(body).not.toMatch(/\b(cancel|fire|trigger|latch|set)\s*\(/);
  });

  it('AC-J7: dispatcher latch file untouched by WU-J (no wrap-import / no new mutator)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const dispatcherPath = resolve(here, '../../src/core/dispatcher.ts');
    const source = readFileSync(dispatcherPath, 'utf8');
    // Dispatcher must not import from the WU-J wrap module — the wrap
    // is consumed driver-side, not at the latch site (C-J1).
    expect(source).not.toMatch(
      /from\s+['"][^'"]*contracts\/cancellable-result(\.js)?['"]/,
    );
    // SubmissionCancellationState's public mutator surface remains the
    // pre-WU-J shape — exactly one cancel-trigger method (`requestCancel`)
    // and the existing observation accessors. We assert by naming: no
    // method named `wrapCancel`, `latchFromWrap`, etc. was introduced.
    expect(source).not.toMatch(/wrapCancel|latchFromWrap|fromCancellableResult/);
  });
});
