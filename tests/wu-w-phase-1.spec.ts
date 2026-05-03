/**
 * WU-W Phase 1 — Contract amendment + factory tests.
 *
 * Covers AC-W1 (additive contract back-compat + JSON round-trip via clone)
 * and AC-W2 (factory behavior across Error / non-Error / explicit observedAt
 * / requestContext present / requestContext absent).
 *
 * @see specs/wu-w-driver-fail-closed-origination.md §5 AC-W1, AC-W2
 */

import { describe, expect, it, expectTypeOf } from 'vitest';

import {
  assertTerminalCause,
  buildDriverFailureFromError,
  cloneTerminalCause,
  type TerminalCauseDriverFailure,
} from '../src/index.js';

function jsonRoundTrip(cause: TerminalCauseDriverFailure): TerminalCauseDriverFailure {
  const serialized = JSON.stringify(cause);
  const parsed = assertTerminalCause(JSON.parse(serialized));
  if (parsed.kind !== 'driver-failure') {
    throw new Error('expected driver-failure after round-trip');
  }
  return parsed;
}

describe('WU-W Phase 1 — TerminalCauseDriverFailure contract amendments (AC-W1)', () => {
  it('AC-W1.a: existing minimal cause without new fields still typechecks and round-trips', () => {
    const minimal: TerminalCauseDriverFailure = {
      kind: 'driver-failure',
      taskId: 'task-w1a',
      runtimeInstanceId: 'rt-1',
      observedAt: new Date('2026-04-22T00:00:00.000Z').toISOString(),
      provenance: 'legacy',
      phase: 'pre-turn',
      message: 'boom',
    };

    // Type-level: new fields are optional `string | undefined` /
    // `Record<string, unknown> | undefined`.
    expectTypeOf<TerminalCauseDriverFailure['stack']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<TerminalCauseDriverFailure['requestContext']>().toEqualTypeOf<
      Record<string, unknown> | undefined
    >();

    const round = jsonRoundTrip(minimal);
    expect(round.stack).toBeUndefined();
    expect(round.requestContext).toBeUndefined();
    expect(round).toEqual(minimal);

    // cloneTerminalCause preserves shape (and omits absent optional fields).
    const cloned = cloneTerminalCause(minimal);
    expect(cloned).toEqual(minimal);
  });

  it('AC-W1.b: cause with stack populated round-trips through JSON.stringify/parse and clone', () => {
    const withStack: TerminalCauseDriverFailure = {
      kind: 'driver-failure',
      taskId: 'task-w1b',
      runtimeInstanceId: 'rt-1',
      observedAt: new Date('2026-04-22T00:00:01.000Z').toISOString(),
      provenance: 'driver-adapter',
      phase: 'streaming',
      message: 'kaboom',
      stack: 'Error: kaboom\n    at run (driver.ts:42:7)',
    };

    const round = jsonRoundTrip(withStack);
    expect(round.stack).toBe(withStack.stack);
    expect(round).toEqual(withStack);

    const cloned = cloneTerminalCause(withStack) as TerminalCauseDriverFailure;
    expect(cloned.stack).toBe(withStack.stack);
  });

  it('AC-W1.c: cause with requestContext populated round-trips through JSON.stringify/parse and clone', () => {
    const ctx = { taskId: 'task-w1c', phase: 'post-turn', attempt: 2, hint: 'sse-stream' };
    const withCtx: TerminalCauseDriverFailure = {
      kind: 'driver-failure',
      taskId: 'task-w1c',
      runtimeInstanceId: 'rt-1',
      observedAt: new Date('2026-04-22T00:00:02.000Z').toISOString(),
      provenance: 'driver-adapter',
      phase: 'post-turn',
      message: 'context lost',
      requestContext: ctx,
    };

    const round = jsonRoundTrip(withCtx);
    expect(round.requestContext).toEqual(ctx);
    expect(round).toEqual(withCtx);

    const cloned = cloneTerminalCause(withCtx) as TerminalCauseDriverFailure;
    expect(cloned.requestContext).toEqual(ctx);
    // Clone deep-copies the requestContext object (not aliased).
    expect(cloned.requestContext).not.toBe(ctx);
  });
});

describe('WU-W Phase 1 — buildDriverFailureFromError factory (AC-W2)', () => {
  it('AC-W2.a: Error instance produces cause with message + stack, provenance="driver-adapter"', () => {
    const err = new Error('driver exploded');
    // Sanity: Node populates .stack on Error.
    expect(typeof err.stack).toBe('string');

    const cause = buildDriverFailureFromError({
      error: err,
      taskId: 'task-w2a',
      runtimeInstanceId: 'rt-2',
      phase: 'pre-turn',
    });

    expect(cause.kind).toBe('driver-failure');
    expect(cause.message).toBe('driver exploded');
    expect(cause.stack).toBe(err.stack);
    expect(cause.provenance).toBe('driver-adapter');
    expect(cause.taskId).toBe('task-w2a');
    expect(cause.runtimeInstanceId).toBe('rt-2');
    expect(cause.phase).toBe('pre-turn');
    // observedAt defaulted to a valid ISO timestamp.
    expect(() => new Date(cause.observedAt).toISOString()).not.toThrow();
  });

  it('AC-W2.b: non-Error throwables produce stringified message and omit stack', () => {
    const stringCause = buildDriverFailureFromError({
      error: 'oops',
      taskId: 'task-w2b-str',
      runtimeInstanceId: 'rt-2',
      phase: 'streaming',
    });
    expect(stringCause.message).toBe('oops');
    expect(stringCause.stack).toBeUndefined();

    const numberCause = buildDriverFailureFromError({
      error: 42,
      taskId: 'task-w2b-num',
      runtimeInstanceId: 'rt-2',
      phase: 'streaming',
    });
    expect(numberCause.message).toBe('42');
    expect(numberCause.stack).toBeUndefined();

    const objectCause = buildDriverFailureFromError({
      error: { code: 'X' },
      taskId: 'task-w2b-obj',
      runtimeInstanceId: 'rt-2',
      phase: 'streaming',
    });
    expect(objectCause.message).toBe('[object Object]');
    expect(objectCause.stack).toBeUndefined();
  });

  it('AC-W2.c: explicit observedAt is used verbatim', () => {
    const observedAt = new Date('2026-04-22T12:34:56.789Z');
    const cause = buildDriverFailureFromError({
      error: new Error('timed'),
      taskId: 'task-w2c',
      runtimeInstanceId: 'rt-2',
      phase: 'pre-turn',
      observedAt,
    });
    expect(cause.observedAt).toBe(observedAt.toISOString());
  });

  it('AC-W2.d: requestContext is passed through verbatim when supplied', () => {
    const ctx = { taskId: 'task-w2d', phase: 'pre-turn', attempt: 1 };
    const cause = buildDriverFailureFromError({
      error: new Error('ctx'),
      taskId: 'task-w2d',
      runtimeInstanceId: 'rt-2',
      phase: 'pre-turn',
      requestContext: ctx,
    });
    expect(cause.requestContext).toEqual(ctx);
  });

  it('AC-W2.e: requestContext field is omitted when not supplied', () => {
    const cause = buildDriverFailureFromError({
      error: new Error('no ctx'),
      taskId: 'task-w2e',
      runtimeInstanceId: 'rt-2',
      phase: 'pre-turn',
    });
    expect(cause.requestContext).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(cause, 'requestContext')).toBe(false);
  });
});
