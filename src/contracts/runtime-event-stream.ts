/**
 * WU-Q — `AsyncIterable<RuntimeEvent>` transport promotion.
 *
 * Spec: `specs/wu-q-async-iterable-event-transport.md`.
 *
 * This module promotes the `RuntimeEvent` callback fan-out into an
 * `AsyncIterable<RuntimeEvent>` consumer surface, governed by an
 * explicit consumer-cancellation contract (ST-13). It is ADDITIVE: the
 * existing callback-shape consumer surface (`createRuntimeEvent` /
 * `RuntimeEventInput` in `runtime-event.ts`) remains available during
 * the migration window (C-Q1).
 *
 * Binding constraints honored here:
 *
 *   C-Q1 ADDITIVE — this module ADDS a transport. It does NOT remove,
 *                   replace, or mutate the existing callback shape in
 *                   `runtime-event.ts`. The callback consumer surface
 *                   continues to function unchanged (AC-Q8).
 *   C-Q2 NO SDK iterator-type leakage — this module imports nothing
 *                   from `@openai/codex-sdk`, references no Codex SDK
 *                   stream class names, and brands no value with a
 *                   vendor `Symbol.asyncIterator` tag. The only
 *                   `Symbol.asyncIterator` use is the platform-standard
 *                   well-known symbol used to satisfy the
 *                   `AsyncIterable<RuntimeEvent>` shape (AC-Q1, AC-Q6,
 *                   I-Q5).
 *   C-Q3 EXPLICIT consumer-cancel — three paths are implemented:
 *                   (a) `return()` from the iterator (invoked by
 *                       `for await...of` on `break`/`throw`/`return`),
 *                   (b) `AbortSignal` supplied at construction time,
 *                       both pre-aborted and aborted-mid-iteration,
 *                   (c) producer-side `close()` for orderly drain.
 *                   See I-Q1, I-Q2, I-Q3, AC-Q2, AC-Q3.
 *   C-Q4 NO terminal cause vocabulary — this module does NOT import
 *                   `terminal-cause.ts` and contains no reference to
 *                   `TerminalCause*` identifiers. Terminal events
 *                   transit as opaque `RuntimeEvent` payloads (I-Q7,
 *                   AC-Q7).
 *   C-Q5 NO new event kinds — `RuntimeEvent` is consumed unchanged
 *                   from `runtime-event.ts`. This module declares no
 *                   new event union members (AC-Q9, NG-Q1).
 *   C-Q6 NO multi-consumer / fan-out — each `RuntimeEventStream`
 *                   instance services a single primary consumer. A
 *                   second concurrent consumer of the same stream's
 *                   `events` iterable is unsupported and may starve.
 *                   Tracked as OQ-Q2 (NG-Q2).
 *   C-Q7 BACKPRESSURE policy is named — see "Backpressure" below
 *                   (AC-Q5).
 *
 * Backpressure (OQ-Q3 default, recommended by spec): the named policy
 * is PRODUCER-SUSPEND ON CONSUMER-PAUSE. The transport holds NO
 * internal buffer. A
 * `push(event)` call returns a `Promise<void>` that resolves only when
 * a consumer has accepted the event via `next()` (i.e. the next
 * iteration of `for await...of`). When the consumer pauses between
 * `next()` calls, the producer naturally suspends on its push
 * promise. When the stream is closed or torn down before a pending
 * push is consumed, that push's ack promise resolves (the event is
 * discarded) so the producer is never permanently stranded. There is
 * no event loss for an active consumer; the only loss path is
 * "stream closed before consumer accepted" — by definition the
 * consumer was no longer interested.
 *
 * I-Q4 ordering note: because `push()` resolves only on consumer
 * acceptance, a producer that awaits its push promises cannot resolve
 * the dispatcher result chain (WU-J `CancellableResultAsync`) before
 * the consumer has observed the event. Producers that wish to honor
 * I-Q4 MUST `await` the push promise before resolving downstream
 * terminal evidence. This module provides the mechanism; the
 * call-site discipline is the producer's responsibility.
 */

import type { RuntimeEvent } from './runtime-event.js';

/**
 * Construction options for `createRuntimeEventStream`.
 *
 * - `signal` (optional) — an `AbortSignal` whose `aborted` transition
 *   triggers the same teardown path as iterator `return()` (I-Q2).
 *   If the signal is already `aborted` at construction time, the
 *   resulting iterator yields zero events and runs teardown
 *   synchronously on its first `next()` call (AC-Q3 second clause).
 */
export interface RuntimeEventStreamOptions {
  readonly signal?: AbortSignal;
}

/**
 * Producer-side handle returned by `createRuntimeEventStream`.
 *
 * - `events` is the public consumer surface: a single-shot
 *   `AsyncIterable<RuntimeEvent>` intended to be driven by a
 *   `for await...of` loop. The iterable's `[Symbol.asyncIterator]()`
 *   returns the same internal `AsyncIterator` instance on each call
 *   (single-consumer per C-Q6).
 * - `push(event)` enqueues an event for the consumer; the returned
 *   promise resolves once the consumer accepts the event (or once the
 *   stream is torn down, in which case the event is discarded).
 * - `close()` signals end-of-stream cooperatively: any pending pushes
 *   are flushed to pending pulls, remaining pulls receive
 *   `{done: true}`, and teardown handlers run.
 * - `onTeardown(fn)` registers a callback invoked exactly once when
 *   teardown runs (I-Q3). Handlers run in registration order; thrown
 *   errors are swallowed (teardown is best-effort).
 * - `closed` becomes `true` once teardown has begun.
 */
export interface RuntimeEventStream {
  readonly events: AsyncIterable<RuntimeEvent>;
  push(event: RuntimeEvent): Promise<void>;
  close(): void;
  onTeardown(handler: () => void | Promise<void>): void;
  readonly closed: boolean;
}

interface PendingPush {
  readonly event: RuntimeEvent;
  readonly ack: () => void;
}

interface PendingPull {
  readonly resolve: (result: IteratorResult<RuntimeEvent>) => void;
}

/**
 * Construct a producer-side `RuntimeEventStream`.
 *
 * See module doc for backpressure policy and cancellation semantics.
 */
export function createRuntimeEventStream(
  options: RuntimeEventStreamOptions = {},
): RuntimeEventStream {
  const teardownHandlers: Array<() => void | Promise<void>> = [];
  const pendingPushes: PendingPush[] = [];
  const pendingPulls: PendingPull[] = [];

  let teardownStarted = false;
  let closed = false;
  let preAbortedDeferred = false;
  let abortListenerAttached = false;
  // Credit-based ack: when an event is delivered to a consumer's
  // next() call, the producer's push() promise does NOT resolve
  // immediately. Instead we hold the ack and fire it on the
  // consumer's NEXT call to next() — which is observable proof that
  // the consumer has fully processed the previous event and yielded
  // back to its event loop. This preserves I-Q4 ordering: a producer
  // awaiting push() cannot resolve downstream terminal evidence
  // (WU-J `CancellableResultAsync`) until the consumer body has run.
  let pendingAck: (() => void) | null = null;

  const signal = options.signal;

  const fireAck = (): void => {
    if (pendingAck !== null) {
      const ack = pendingAck;
      pendingAck = null;
      ack();
    }
  };

  const drainPending = (): void => {
    fireAck();
    for (const push of pendingPushes.splice(0)) {
      push.ack();
    }
    for (const pull of pendingPulls.splice(0)) {
      pull.resolve({ value: undefined, done: true });
    }
  };

  const runTeardown = async (): Promise<void> => {
    if (teardownStarted) {
      return;
    }
    teardownStarted = true;
    closed = true;
    drainPending();
    if (signal !== undefined && abortListenerAttached) {
      signal.removeEventListener('abort', onAbort);
      abortListenerAttached = false;
    }
    for (const handler of teardownHandlers) {
      try {
        await handler();
      } catch {
        // Teardown is best-effort; swallow handler errors so a single
        // misbehaving handler cannot block remaining teardown work
        // or leave the stream in a half-torn-down state (I-Q3).
      }
    }
  };

  function onAbort(): void {
    void runTeardown();
  }

  if (signal !== undefined) {
    if (signal.aborted) {
      // Defer teardown until the first `next()` call so the
      // consumer's first observation is `{done: true}` from a fully
      // torn-down stream, per AC-Q3 second clause.
      preAbortedDeferred = true;
      closed = true;
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
      abortListenerAttached = true;
    }
  }

  const push = (event: RuntimeEvent): Promise<void> => {
    if (closed || teardownStarted) {
      return Promise.resolve();
    }
    const pull = pendingPulls.shift();
    if (pull !== undefined) {
      pull.resolve({ value: event, done: false });
      // Held until consumer's NEXT next() call (credit-based ack).
      return new Promise<void>((resolve) => {
        pendingAck = resolve;
      });
    }
    return new Promise<void>((resolve) => {
      pendingPushes.push({ event, ack: resolve });
    });
  };

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    // Flush already-queued pushes to any waiting pulls before
    // signaling end-of-stream (preserves emission order). For each
    // delivered event the ack is held under credit-based semantics.
    while (pendingPushes.length > 0 && pendingPulls.length > 0) {
      const queued = pendingPushes.shift();
      const pull = pendingPulls.shift();
      if (queued === undefined || pull === undefined) {
        break;
      }
      pull.resolve({ value: queued.event, done: false });
      // Replace any prior held ack (consumer never called next()
      // again before we drained), then hold the new one.
      fireAck();
      pendingAck = queued.ack;
    }
    // Remaining pulls finish; remaining pushes ack-and-discard.
    for (const pull of pendingPulls.splice(0)) {
      pull.resolve({ value: undefined, done: true });
    }
    for (const push of pendingPushes.splice(0)) {
      push.ack();
    }
    void runTeardown();
  };

  const iterator: AsyncIterator<RuntimeEvent, undefined, undefined> = {
    next(): Promise<IteratorResult<RuntimeEvent>> {
      // The consumer asking for another event is the observable
      // signal that the previous one has been fully processed.
      fireAck();
      if (preAbortedDeferred && !teardownStarted) {
        return runTeardown().then(() => ({ value: undefined, done: true }));
      }
      if (teardownStarted) {
        return Promise.resolve({ value: undefined, done: true });
      }
      const queued = pendingPushes.shift();
      if (queued !== undefined) {
        // Hold the ack; it will fire on the consumer's NEXT next().
        pendingAck = queued.ack;
        return Promise.resolve({ value: queued.event, done: false });
      }
      if (closed) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise<IteratorResult<RuntimeEvent>>((resolve) => {
        pendingPulls.push({ resolve });
      });
    },
    async return(): Promise<IteratorResult<RuntimeEvent>> {
      await runTeardown();
      return { value: undefined, done: true };
    },
    async throw(error?: unknown): Promise<IteratorResult<RuntimeEvent>> {
      await runTeardown();
      // Re-surface the error so `for await...of` semantics propagate
      // it to the consumer rather than swallowing it silently.
      throw error;
    },
  };

  const events: AsyncIterable<RuntimeEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
      return iterator;
    },
  };

  return {
    events,
    push,
    close,
    onTeardown(handler): void {
      teardownHandlers.push(handler);
    },
    get closed(): boolean {
      return teardownStarted;
    },
  };
}
