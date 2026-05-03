import type { RosterEvent } from '../contracts/subagent-roster-event.js';

export interface RosterEventStreamOptions {
  readonly signal?: AbortSignal;
}

export interface RosterEventStream {
  readonly events: AsyncIterable<RosterEvent>;
  push(event: RosterEvent): Promise<void>;
  close(): void;
  onTeardown(handler: () => void | Promise<void>): void;
  readonly closed: boolean;
}

interface PendingPush {
  readonly event: RosterEvent;
  readonly ack: () => void;
}

interface PendingPull {
  readonly resolve: (result: IteratorResult<RosterEvent>) => void;
}

export function createRosterEventStream(
  options: RosterEventStreamOptions = {},
): RosterEventStream {
  const teardownHandlers: Array<() => void | Promise<void>> = [];
  const pendingPushes: PendingPush[] = [];
  const pendingPulls: PendingPull[] = [];

  let teardownStarted = false;
  let closed = false;
  let preAbortedDeferred = false;
  let abortListenerAttached = false;
  let pendingAck: (() => void) | null = null;

  const signal = options.signal;

  const fireAck = (): void => {
    if (pendingAck === null) {
      return;
    }
    const ack = pendingAck;
    pendingAck = null;
    ack();
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
        // teardown is best effort
      }
    }
  };

  const onAbort = (): void => {
    void runTeardown();
  };

  if (signal !== undefined) {
    if (signal.aborted) {
      preAbortedDeferred = true;
      closed = true;
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
      abortListenerAttached = true;
    }
  }

  const push = (event: RosterEvent): Promise<void> => {
    if (closed || teardownStarted) {
      return Promise.resolve();
    }
    const pull = pendingPulls.shift();
    if (pull !== undefined) {
      pull.resolve({ value: event, done: false });
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
    while (pendingPushes.length > 0 && pendingPulls.length > 0) {
      const queued = pendingPushes.shift();
      const pull = pendingPulls.shift();
      if (queued === undefined || pull === undefined) {
        break;
      }
      pull.resolve({ value: queued.event, done: false });
      fireAck();
      pendingAck = queued.ack;
    }
    for (const pull of pendingPulls.splice(0)) {
      pull.resolve({ value: undefined, done: true });
    }
    for (const push of pendingPushes.splice(0)) {
      push.ack();
    }
    void runTeardown();
  };

  const iterator: AsyncIterator<RosterEvent, undefined, undefined> = {
    next(): Promise<IteratorResult<RosterEvent>> {
      fireAck();
      if (preAbortedDeferred && !teardownStarted) {
        return runTeardown().then(() => ({ value: undefined, done: true }));
      }
      if (teardownStarted) {
        return Promise.resolve({ value: undefined, done: true });
      }
      const queued = pendingPushes.shift();
      if (queued !== undefined) {
        pendingAck = queued.ack;
        return Promise.resolve({ value: queued.event, done: false });
      }
      if (closed) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise<IteratorResult<RosterEvent>>((resolve) => {
        pendingPulls.push({ resolve });
      });
    },
    async return(): Promise<IteratorResult<RosterEvent>> {
      await runTeardown();
      return { value: undefined, done: true };
    },
    async throw(error?: unknown): Promise<IteratorResult<RosterEvent>> {
      await runTeardown();
      throw error;
    },
  };

  const events: AsyncIterable<RosterEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<RosterEvent> {
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
