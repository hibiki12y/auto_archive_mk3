import { describe, expect, it, vi } from 'vitest';

import {
  buildDiscordIdempotencyKey,
  classifyDiscordDeliveryError,
  DiscordCircuitBreaker,
  DiscordDeliveryDlq,
  DiscordDeliveryQueue,
  type DiscordDeliveryRequest,
} from '../../src/discord/delivery/index.js';

function buildRequest(
  overrides: Partial<DiscordDeliveryRequest> = {},
): DiscordDeliveryRequest {
  return {
    idempotencyKey:
      overrides.idempotencyKey ??
      buildDiscordIdempotencyKey({
        taskId: 'task-1',
        eventType: 'terminal-result',
        sequence: 0,
      }),
    operation: overrides.operation ?? 'followUp',
    payload: overrides.payload ?? { content: 'hello' },
    context: overrides.context,
  };
}

function silentLogger() {
  return { warn: vi.fn() };
}

describe('DiscordDeliveryQueue — idempotency', () => {
  it('builds deterministic idempotency keys from (taskId, eventType, sequence)', () => {
    expect(
      buildDiscordIdempotencyKey({
        taskId: 'task-A',
        eventType: 'running-update',
        sequence: 3,
      }),
    ).toBe('task-A:running-update:3');
  });

  it('dedupes a re-enqueue of the same idempotency key after a successful send', async () => {
    const queue = new DiscordDeliveryQueue({
      jitterFraction: 0,
      sleep: async () => undefined,
      dlq: { logger: silentLogger() },
    });
    const deliveryFn = vi.fn(async () => undefined);
    const req = buildRequest();

    const first = await queue.enqueue(req, deliveryFn);
    const second = await queue.enqueue(req, deliveryFn);

    expect(deliveryFn).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      attempts: 1,
      deduped: false,
    });
    expect(second).toMatchObject({
      attempts: 0,
      deduped: true,
    });
  });

  it('re-attempts after a transient failure (single retry succeeds)', async () => {
    const queue = new DiscordDeliveryQueue({
      backoffScheduleMs: [1, 2, 4],
      jitterFraction: 0,
      sleep: async () => undefined,
      dlq: { logger: silentLogger() },
    });
    let calls = 0;
    const deliveryFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('boom'), { status: 503 });
      }
    });

    const result = await queue.enqueue(buildRequest(), deliveryFn);
    expect(result).toMatchObject({ outcome: 'success', attempts: 2 });
    expect(deliveryFn).toHaveBeenCalledTimes(2);
  });
});

describe('DiscordDeliveryQueue — backoff and max attempts', () => {
  it('honors the backoff schedule and stops after maxAttempts', async () => {
    const sleep = vi.fn(async () => undefined);
    const queue = new DiscordDeliveryQueue({
      backoffScheduleMs: [10, 20, 40],
      jitterFraction: 0,
      sleep,
      dlq: { logger: silentLogger() },
    });
    const deliveryFn = vi.fn(async () => {
      throw Object.assign(new Error('fail'), { status: 500 });
    });

    const result = await queue.enqueue(buildRequest(), deliveryFn);

    expect(result.outcome).toBe('dlq');
    expect(deliveryFn).toHaveBeenCalledTimes(3);
    // sleep is called between attempts, so attempts-1 times.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
    expect(queue.dlq.size()).toBe(1);
    expect(queue.dlq.list()[0]).toMatchObject({
      attempts: 3,
      failureClass: 'transient',
    });
  });

  it('honors Retry-After header on rate-limit errors', async () => {
    const sleep = vi.fn(async () => undefined);
    const queue = new DiscordDeliveryQueue({
      backoffScheduleMs: [1000, 2000],
      jitterFraction: 0,
      sleep,
      dlq: { logger: silentLogger() },
    });
    let calls = 0;
    const deliveryFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const err = Object.assign(new Error('429'), {
          status: 429,
          headers: { 'retry-after': '0.05' },
        });
        throw err;
      }
    });

    await queue.enqueue(buildRequest(), deliveryFn);

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(50); // 0.05s → 50ms from header
  });

  it('routes permanent (4xx non-429) failures straight to DLQ without retry', async () => {
    const queue = new DiscordDeliveryQueue({
      backoffScheduleMs: [1, 2, 4],
      jitterFraction: 0,
      sleep: async () => undefined,
      dlq: { logger: silentLogger() },
    });
    const deliveryFn = vi.fn(async () => {
      throw Object.assign(new Error('forbidden'), { status: 403 });
    });

    const result = await queue.enqueue(buildRequest(), deliveryFn);
    expect(result).toMatchObject({
      attempts: 1,
      failureClass: 'permanent',
    });
    expect(deliveryFn).toHaveBeenCalledTimes(1);
  });
});

describe('DiscordDeliveryQueue — circuit breaker', () => {
  it('opens after the configured consecutive-failure threshold; subsequent sends route directly to DLQ', async () => {
    const queue = new DiscordDeliveryQueue({
      backoffScheduleMs: [0],
      jitterFraction: 0,
      sleep: async () => undefined,
      circuit: { consecutiveFailureThreshold: 3, cooldownMs: 1000 },
      dlq: { logger: silentLogger() },
    });
    const deliveryFn = vi.fn(async () => {
      throw Object.assign(new Error('nope'), { status: 500 });
    });

    for (let i = 0; i < 3; i += 1) {
      await queue.enqueue(
        buildRequest({
          idempotencyKey: buildDiscordIdempotencyKey({
            taskId: 't',
            eventType: 'running-update',
            sequence: i,
          }),
        }),
        deliveryFn,
      );
    }
    expect(queue.circuitBreaker.getState()).toBe('open');
    const callsAfterTrip = deliveryFn.mock.calls.length;

    const result = await queue.enqueue(
      buildRequest({
        idempotencyKey: 'fresh:running-update:0',
      }),
      deliveryFn,
    );

    expect(result).toMatchObject({
      failureClass: 'circuit-open',
      attempts: 0,
    });
    expect(deliveryFn).toHaveBeenCalledTimes(callsAfterTrip);
  });

  it('half-opens after cooldown and admits a single probe; success closes the circuit', async () => {
    let now = 0;
    const breaker = new DiscordCircuitBreaker({
      consecutiveFailureThreshold: 2,
      cooldownMs: 1000,
      now: () => now,
    });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');

    // Before cooldown: still open.
    now = 500;
    expect(breaker.acquire()).toEqual({ admit: false, reason: 'circuit-open' });

    // After cooldown: half-open with probe.
    now = 1500;
    expect(breaker.acquire()).toEqual({ admit: true, probe: true });
    // Second call while probe in-flight: rejected.
    expect(breaker.acquire()).toEqual({ admit: false, reason: 'circuit-open' });

    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.acquire()).toEqual({ admit: true, probe: false });
  });

  it('half-open probe failure re-opens with doubled cooldown', async () => {
    let now = 0;
    const breaker = new DiscordCircuitBreaker({
      consecutiveFailureThreshold: 1,
      cooldownMs: 100,
      maxCooldownMs: 10_000,
      now: () => now,
    });
    breaker.recordFailure();
    expect(breaker.currentCooldown()).toBe(100);

    now = 200;
    expect(breaker.acquire()).toEqual({ admit: true, probe: true });
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
    expect(breaker.currentCooldown()).toBe(200);
  });
});

describe('DiscordDeliveryDlq — read API and ring-buffer eviction', () => {
  it('records DLQ entries with full request context', async () => {
    const dlq = new DiscordDeliveryDlq({
      capacity: 8,
      logger: silentLogger(),
      now: () => 1234,
    });
    const queue = new DiscordDeliveryQueue({
      backoffScheduleMs: [0],
      jitterFraction: 0,
      sleep: async () => undefined,
      dlq,
    });
    await queue.enqueue(
      buildRequest({
        idempotencyKey: 'task-X:terminal-result:0',
        operation: 'followUp',
        payload: { content: 'terminal text' },
        context: {
          taskId: 'task-X',
          userId: 'user-1',
          channelId: 'channel-1',
          eventType: 'terminal-result',
        },
      }),
      async () => {
        throw Object.assign(new Error('gone'), { status: 404 });
      },
    );

    const entries = dlq.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      idempotencyKey: 'task-X:terminal-result:0',
      operation: 'followUp',
      payload: { content: 'terminal text' },
      context: {
        taskId: 'task-X',
        userId: 'user-1',
        channelId: 'channel-1',
        eventType: 'terminal-result',
      },
      attempts: 1,
      failureClass: 'permanent',
      lastError: { message: 'gone', status: 404 },
      recordedAtMs: 1234,
    });
  });

  it('evicts oldest entries beyond capacity', () => {
    const dlq = new DiscordDeliveryDlq({
      capacity: 2,
      logger: silentLogger(),
    });
    for (let i = 0; i < 5; i += 1) {
      dlq.record({
        request: buildRequest({
          idempotencyKey: `k:${i}`,
        }),
        attempts: 1,
        failureClass: 'transient',
        lastError: { name: 'E', message: 'm' },
      });
    }
    expect(dlq.size()).toBe(2);
    expect(dlq.list().map((e) => e.idempotencyKey)).toEqual(['k:3', 'k:4']);
    expect(dlq.droppedDueToOverflow()).toBe(3);
  });

  it('emits a structured warn line on each DLQ append', () => {
    const logger = { warn: vi.fn() };
    const dlq = new DiscordDeliveryDlq({ capacity: 4, logger });
    dlq.record({
      request: buildRequest({ idempotencyKey: 'logged:1' }),
      attempts: 6,
      failureClass: 'transient',
      lastError: { name: 'BoomError', message: 'kaboom', status: 502 },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'discord.delivery.dlq',
      expect.objectContaining({
        idempotencyKey: 'logged:1',
        attempts: 6,
        failureClass: 'transient',
        lastError: { name: 'BoomError', message: 'kaboom', status: 502 },
      }),
    );
  });
});

describe('classifyDiscordDeliveryError', () => {
  it('classifies 429 with Retry-After header as rate-limit', () => {
    const result = classifyDiscordDeliveryError(
      Object.assign(new Error('rate'), {
        status: 429,
        headers: { 'retry-after': '2.0' },
      }),
    );
    expect(result).toMatchObject({
      failureClass: 'rate-limit',
      retryable: true,
      retryAfterMs: 2000,
    });
  });

  it('classifies 429 without Retry-After as quota-exhausted', () => {
    const result = classifyDiscordDeliveryError(
      Object.assign(new Error('quota'), { status: 429 }),
    );
    expect(result).toMatchObject({
      failureClass: 'quota-exhausted',
      retryable: true,
    });
  });

  it('classifies 5xx as transient retryable', () => {
    expect(
      classifyDiscordDeliveryError(
        Object.assign(new Error('s'), { status: 502 }),
      ),
    ).toMatchObject({ failureClass: 'transient', retryable: true });
  });

  it('classifies 4xx (non-429) as permanent', () => {
    expect(
      classifyDiscordDeliveryError(
        Object.assign(new Error('p'), { status: 400 }),
      ),
    ).toMatchObject({ failureClass: 'permanent', retryable: false });
  });

  it('classifies network errors with known codes as transient', () => {
    expect(
      classifyDiscordDeliveryError(
        Object.assign(new Error('net'), { code: 'ECONNRESET' }),
      ),
    ).toMatchObject({ failureClass: 'transient', retryable: true });
  });
});
