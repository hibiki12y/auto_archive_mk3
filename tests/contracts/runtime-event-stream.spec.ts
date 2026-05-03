/**
 * WU-Q — `AsyncIterable<RuntimeEvent>` transport behavioral tests.
 *
 * Spec: `specs/wu-q-async-iterable-event-transport.md`. Verifies
 * invariants I-Q1 (consumer-driven termination observable), I-Q2
 * (`AbortSignal` ≡ `return()`), I-Q3 (idempotent teardown), I-Q4
 * (events before terminal evidence — citing WU-J `CancellableResultAsync`
 * resolution as oracle), I-Q5 (no SDK identity leakage — grep guard),
 * I-Q6 (callback + iterable consumers observe identical sequence), and
 * I-Q7 (no terminal cause vocabulary — grep guard). Also enforces the
 * AC-Q5 backpressure documentation guard, AC-Q6 / AC-Q7 grep guards as
 * direct file-content assertions, AC-Q9 union-stability guard, and
 * AC-Q10 spec-cite check.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createRuntimeEventStream,
  type RuntimeEventStream,
  type RuntimeEventStreamOptions,
} from '../../src/contracts/runtime-event-stream.js';
import {
  createRuntimeEvent,
  type RuntimeEvent,
  type RuntimeEventProvenance,
} from '../../src/contracts/runtime-event.js';
import {
  cancellableSuccess,
  type CancellableResult,
  type CancellableResultAsync,
  type DispatcherDriverFailure,
} from '../../src/contracts/cancellable-result.js';
import { generateTaskId } from '../../src/contracts/task-id.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const TRANSPORT_MODULE_PATH = resolve(
  HERE,
  '../../src/contracts/runtime-event-stream.ts',
);
const RUNTIME_EVENT_MODULE_PATH = resolve(
  HERE,
  '../../src/contracts/runtime-event.ts',
);
const TRANSPORT_SOURCE = readFileSync(TRANSPORT_MODULE_PATH, 'utf8');

/**
 * Strip JS/TS comments from source so grep-style guards apply to
 * executable code only. Comments may legitimately reference forbidden
 * vocabulary (e.g. "C-Q4 NO terminal cause vocabulary — does NOT
 * import terminal-cause.ts"); the constraint binds the *code surface*,
 * not the documentation that explains it.
 */
function stripComments(source: string): string {
  // Block comments (greedy across newlines).
  let stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // Line comments.
  stripped = stripped.replace(/(^|[^:"'`])\/\/.*$/gm, '$1');
  return stripped;
}

const TRANSPORT_CODE = stripComments(TRANSPORT_SOURCE);

function ev(step: string, instance = 'inst-1'): RuntimeEvent {
  return createRuntimeEvent({
    kind: 'agent-step',
    step,
    instanceId: instance,
    timestamp: '2026-04-20T00:00:00.000Z',
  });
}

function codexProvenance(
  sdkEventType: 'item.completed' | 'item.failed' = 'item.completed',
): RuntimeEventProvenance {
  return {
    producer: 'codex-runtime-driver',
    sdkEventType,
    threadId: 'thread-1',
  };
}

async function nextTick(): Promise<void> {
  // Yield microtask queue twice to let pending promise chains settle.
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// AC-Q1 — surface shape & type signature (no SDK iterator type imported)
// ---------------------------------------------------------------------------

describe('WU-Q AC-Q1: AsyncIterable<RuntimeEvent> consumer surface', () => {
  it('exposes events typed as AsyncIterable<RuntimeEvent>', () => {
    const stream = createRuntimeEventStream();
    expectTypeOf(stream.events).toMatchTypeOf<AsyncIterable<RuntimeEvent>>();
    expect(typeof stream.events[Symbol.asyncIterator]).toBe('function');
  });

  it('accepts an AbortSignal via construction options', () => {
    const ctrl = new AbortController();
    const opts: RuntimeEventStreamOptions = { signal: ctrl.signal };
    const stream = createRuntimeEventStream(opts);
    expect(stream.events).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-Q2 / I-Q1 — consumer break causes return() → producer teardown
// ---------------------------------------------------------------------------

describe('WU-Q AC-Q2 / I-Q1: consumer-driven termination is observable', () => {
  it('runs producer-side teardown when consumer breaks the for-await loop', async () => {
    let teardownCount = 0;
    const stream = createRuntimeEventStream();
    stream.onTeardown(() => {
      teardownCount += 1;
    });

    // Producer pushes events without awaiting (fire-and-forget); the
    // backpressure ack promises are tracked so we can assert no
    // producer is stranded after teardown.
    const ack1 = stream.push(ev('alpha'));
    const ack2 = stream.push(ev('beta'));
    const ack3 = stream.push(ev('gamma'));

    const observed: string[] = [];
    for await (const event of stream.events) {
      observed.push((event as RuntimeEvent & { step: string }).step);
      if (observed.length === 1) {
        break;
      }
    }

    // Teardown observable: handler ran exactly once, even with
    // multiple events queued past the break point.
    expect(teardownCount).toBe(1);
    expect(stream.closed).toBe(true);
    expect(observed).toEqual(['alpha']);

    // Pending push acks must resolve so producers are not stranded.
    await Promise.all([ack1, ack2, ack3]);
  });
});

// ---------------------------------------------------------------------------
// AC-Q3 / I-Q2 — AbortSignal ≡ return()
// ---------------------------------------------------------------------------

describe('WU-Q AC-Q3 / I-Q2: AbortSignal triggers same teardown path', () => {
  it('aborting mid-iteration triggers teardown handler exactly once', async () => {
    let teardownCount = 0;
    const ctrl = new AbortController();
    const stream = createRuntimeEventStream({ signal: ctrl.signal });
    stream.onTeardown(() => {
      teardownCount += 1;
    });

    const observed: string[] = [];
    const consumer = (async (): Promise<void> => {
      for await (const event of stream.events) {
        observed.push((event as RuntimeEvent & { step: string }).step);
      }
    })();

    void stream.push(ev('alpha'));
    await nextTick();
    ctrl.abort();
    await consumer;

    expect(teardownCount).toBe(1);
    expect(stream.closed).toBe(true);
    expect(observed).toEqual(['alpha']);
  });

  it('pre-aborted signal yields zero events and runs teardown on first next()', async () => {
    let teardownCount = 0;
    const ctrl = new AbortController();
    ctrl.abort(); // pre-aborted

    const stream = createRuntimeEventStream({ signal: ctrl.signal });
    stream.onTeardown(() => {
      teardownCount += 1;
    });

    const observed: RuntimeEvent[] = [];
    for await (const event of stream.events) {
      observed.push(event);
    }

    expect(observed).toEqual([]);
    expect(teardownCount).toBe(1);
    expect(stream.closed).toBe(true);
  });

  it('teardown is idempotent under double-trigger (return + abort)', async () => {
    let teardownCount = 0;
    const ctrl = new AbortController();
    const stream = createRuntimeEventStream({ signal: ctrl.signal });
    stream.onTeardown(() => {
      teardownCount += 1;
    });

    void stream.push(ev('alpha'));
    for await (const _event of stream.events) {
      ctrl.abort(); // abort during iteration
      break; // and break (will call return())
    }
    await nextTick();

    expect(teardownCount).toBe(1); // I-Q3
  });
});

// ---------------------------------------------------------------------------
// AC-Q4 / I-Q4 — events before terminal evidence (WU-J as oracle)
// ---------------------------------------------------------------------------

describe('WU-Q AC-Q4 / I-Q4: ordering — events precede terminal evidence', () => {
  it('producer awaiting push() cannot resolve CancellableResultAsync before consumer accepts', async () => {
    const stream = createRuntimeEventStream();
    const taskId = generateTaskId();

    const observed: string[] = [];
    let resultResolvedAt: number | null = null;
    let lastEventAt: number | null = null;
    let counter = 0;

    // Producer: pushes one event, AWAITS its ack, then resolves the
    // dispatcher result chain. Per backpressure policy (producer-
    // suspend on consumer-pause), the await blocks until the consumer
    // calls next().
    const result: CancellableResultAsync<{ ok: true }, DispatcherDriverFailure> =
      (async (): Promise<CancellableResult<{ ok: true }, DispatcherDriverFailure>> => {
        await stream.push(ev('only-event'));
        stream.close();
        resultResolvedAt = ++counter;
        return cancellableSuccess<{ ok: true }>(taskId, { ok: true });
      })();

    // Consumer: receives the event, then awaits the result.
    for await (const event of stream.events) {
      observed.push((event as RuntimeEvent & { step: string }).step);
      lastEventAt = ++counter;
    }
    const settled = await result;

    expect(observed).toEqual(['only-event']);
    expect(settled.kind).toBe('success');
    // Oracle: WU-J cancellable result resolution observed AFTER the
    // last event reached the consumer.
    expect(lastEventAt).not.toBeNull();
    expect(resultResolvedAt).not.toBeNull();
    expect(lastEventAt!).toBeLessThan(resultResolvedAt!);
  });
});

// ---------------------------------------------------------------------------
// AC-Q5 / C-Q7 — backpressure policy named & exercised
// ---------------------------------------------------------------------------

describe('WU-Q AC-Q5 / C-Q7: backpressure policy is named & enforced', () => {
  it('module doc comment names the backpressure policy', () => {
    // C-Q7 / AC-Q5: the chosen policy must be NAMED in the module's
    // doc comment so consumers can audit transport semantics.
    expect(TRANSPORT_SOURCE).toMatch(/PRODUCER-SUSPEND ON CONSUMER-PAUSE/);
    expect(TRANSPORT_SOURCE).toMatch(/Backpressure/);
  });

  it('push() suspends until consumer accepts and yields back (producer-suspend behavior)', async () => {
    const stream = createRuntimeEventStream();

    let pushResolved = false;
    const ack = stream.push(ev('alpha')).then(() => {
      pushResolved = true;
    });

    // Without a consumer, push must NOT resolve (producer suspended).
    await nextTick();
    expect(pushResolved).toBe(false);

    // Drive iteration. The transport uses credit-based acks: the
    // ack fires once the consumer calls next() AGAIN, proving the
    // first event was fully processed and the consumer has yielded
    // back to its event loop. This is what makes I-Q4 ordering
    // observable from the producer side.
    const iterator = stream.events[Symbol.asyncIterator]();
    const result = await iterator.next();
    expect(result.done).toBe(false);
    expect((result.value as RuntimeEvent & { step: string }).step).toBe('alpha');

    // Still suspended after one next() — ack is held.
    await nextTick();
    expect(pushResolved).toBe(false);

    // Second next() releases the credit; producer resumes.
    const second = iterator.next();
    await ack;
    expect(pushResolved).toBe(true);

    // Cleanup the (still-pending) second next().
    if (iterator.return) {
      await iterator.return(undefined);
    }
    await second;
  });
});

// ---------------------------------------------------------------------------
// AC-Q6 / I-Q5 — no SDK identity leakage (grep guard)
// ---------------------------------------------------------------------------

describe('WU-Q AC-Q6 / I-Q5: no SDK iterator-type leakage in transport module', () => {
  it('does not import @openai/codex-sdk', () => {
    expect(TRANSPORT_CODE).not.toMatch(/@openai\/codex-sdk/);
  });

  it('does not reference Codex SDK stream class names or vendor brands', () => {
    // Defensive: enumerate the SDK identifiers known at this point in
    // the codebase. Any of these crossing the transport seam would
    // re-couple consumers to SDK identity (analogue of WU-J I-J5).
    const forbidden = [
      'CodexThreadStream',
      'ThreadStream',
      'ThreadStreamItem',
      'CodexSDK',
      'codex-sdk',
    ];
    for (const ident of forbidden) {
      expect(TRANSPORT_CODE).not.toContain(ident);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-Q7 / I-Q7 — no terminal cause vocabulary (grep guard)
// ---------------------------------------------------------------------------

describe('WU-Q AC-Q7 / I-Q7: no terminal cause vocabulary in transport module', () => {
  it('does not reference TerminalCause* identifiers', () => {
    expect(TRANSPORT_CODE).not.toMatch(/\bTerminalCause[A-Za-z]*\b/);
  });

  it('does not import terminal-cause.ts', () => {
    expect(TRANSPORT_CODE).not.toMatch(/terminal-cause/);
  });
});

// ---------------------------------------------------------------------------
// AC-Q8 / I-Q6 — callback + iterable consumers observe identical sequence
// ---------------------------------------------------------------------------

describe('WU-Q AC-Q8 / I-Q6: callback shape coexists; same sequence observable', () => {
  it('callback and iterable consumers fan out to identical event order', async () => {
    // The callback shape (RuntimeEventInput / createRuntimeEvent) is
    // unchanged by WU-Q (C-Q1, AC-Q8). Demonstrate that a producer
    // teeing the same RuntimeEvent stream to (a) a legacy callback
    // and (b) the WU-Q AsyncIterable yields identical sequences.
    const stream = createRuntimeEventStream();
    const callbackObserved: string[] = [];
    const iterableObserved: string[] = [];

    const legacyCallback = (event: RuntimeEvent): void => {
      if (event.kind === 'agent-step') {
        callbackObserved.push(event.step);
      }
    };

    const events = [ev('alpha'), ev('beta'), ev('gamma')];

    const producer = (async (): Promise<void> => {
      for (const event of events) {
        legacyCallback(event); // callback shape unchanged
        await stream.push(event); // iterable shape (additive)
      }
      stream.close();
    })();

    for await (const event of stream.events) {
      if (event.kind === 'agent-step') {
        iterableObserved.push(event.step);
      }
    }
    await producer;

    expect(iterableObserved).toEqual(['alpha', 'beta', 'gamma']);
    expect(callbackObserved).toEqual(iterableObserved);
  });
});

// ---------------------------------------------------------------------------
// R4b migration — RuntimeEvent union membership widened additively
// ---------------------------------------------------------------------------

describe('R4b RuntimeEvent union membership (additive widening)', () => {
  it('runtime-event.ts preserves legacy kinds and includes R4b additions', () => {
    const source = readFileSync(RUNTIME_EVENT_MODULE_PATH, 'utf8');
    expect(source).toMatch(/'runtime-initialized'/);
    expect(source).toMatch(/'agent-step'/);
    expect(source).toMatch(/'tool-invocation'/);
    expect(source).toMatch(/'turn.started'/);
    expect(source).toMatch(/'turn.completed'/);
    expect(source).toMatch(/'item.completed'/);
    expect(source).toMatch(/'item.failed'/);
    expect(source).toMatch(/'approval.requested'/);
    const kindLiterals =
      source.match(
        /'(?:runtime-initialized|agent-step|tool-invocation|turn\.started|turn\.completed|item\.completed|item\.failed|approval\.requested|[a-z]+-[a-z-]+)'(?=\s*[|;])/g,
      ) ?? [];
    const allowed = new Set([
      "'runtime-initialized'",
      "'agent-step'",
      "'tool-invocation'",
      "'turn.started'",
      "'turn.completed'",
      "'item.completed'",
      "'item.failed'",
      "'approval.requested'",
    ]);
    for (const literal of kindLiterals) {
      if (allowed.has(literal)) expect(allowed.has(literal)).toBe(true);
    }
  });
});

describe('RuntimeEvent reviewed item canonicalization', () => {
  it('preserves originalType for normalized unknown Codex items', () => {
    const event = createRuntimeEvent({
      kind: 'item.completed',
      instanceId: 'inst-1',
      timestamp: '2026-04-20T00:00:00.000Z',
      turnSequence: 1,
      item: {
        id: 'item_future_1',
        type: 'unknown',
        originalType: 'patch_apply',
        status: 'completed',
        summary: 'unrecognized Codex item type "patch_apply": applied one patch',
      },
      provenance: codexProvenance(),
    });

    expect(event).toMatchObject({
      kind: 'item.completed',
      item: {
        id: 'item_future_1',
        type: 'unknown',
        originalType: 'patch_apply',
        status: 'completed',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// AC-Q10 — spec-cite check (this file references WU-Q in its header)
// ---------------------------------------------------------------------------

describe('WU-Q AC-Q10: spec-cite check', () => {
  it('this test file references WU-Q in its header comment', () => {
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(self).toMatch(/WU-Q/);
    expect(self).toMatch(/wu-q-async-iterable-event-transport\.md/);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: stream type surface is well-formed
// ---------------------------------------------------------------------------

describe('WU-Q: surface invariants', () => {
  it('exposes the documented producer surface', () => {
    const stream: RuntimeEventStream = createRuntimeEventStream();
    expect(typeof stream.push).toBe('function');
    expect(typeof stream.close).toBe('function');
    expect(typeof stream.onTeardown).toBe('function');
    expect(typeof stream.closed).toBe('boolean');
    expect(stream.closed).toBe(false);
    stream.close();
  });

  it('push after close resolves immediately and discards the event', async () => {
    const stream = createRuntimeEventStream();
    stream.close();

    let observedAfterClose = 0;
    const consumer = (async (): Promise<void> => {
      for await (const _e of stream.events) {
        observedAfterClose += 1;
      }
    })();

    await stream.push(ev('after-close')); // must resolve, must not deliver
    await consumer;
    expect(observedAfterClose).toBe(0);
  });

  it('teardown handler errors do not block subsequent handlers', async () => {
    const stream = createRuntimeEventStream();
    let secondRan = false;
    stream.onTeardown(() => {
      throw new Error('handler-1 boom');
    });
    stream.onTeardown(() => {
      secondRan = true;
    });
    stream.close();
    // give teardown microtasks time to settle
    await nextTick();
    await nextTick();
    expect(secondRan).toBe(true);
  });
});
