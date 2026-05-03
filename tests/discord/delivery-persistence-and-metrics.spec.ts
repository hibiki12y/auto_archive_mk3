/**
 * WU-DISC closure tests — DLQ persistence, delivered-key persistence, and the
 * metrics surface. Complement `tests/discord/delivery.spec.ts` (queue/breaker
 * behaviour) by exercising the durability + observability gaps that the
 * original WU-DISC closure deferred.
 *
 * Spec: specs/wu-disc-discord-delivery-reliability.md §2 (signals), §2.3
 *       (DLQ persistence), §5 (delivered-key log), §6 (file layout), §7
 *       (acceptance: "DLQ JSONL is appendable, line-parseable, and survives
 *       orchestrator restart" + "circuit-breaker state is observable via the
 *       metrics surface").
 */

import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildDiscordIdempotencyKey,
  DiscordDeliveryDlq,
  DiscordDeliveryMetrics,
  DiscordDeliveryQueue,
  FileDiscordDeliveredKeyPersistence,
  JsonlDiscordDeliveryDlqPersistence,
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

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'wu-disc-closure-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('DLQ JSONL persistence (spec §2.3, §6)', () => {
  it('appends one JSON-parseable line per DLQ entry to runtime-state path', () => {
    const dlqPath = join(workDir, 'runtime-state', 'discord-dlq.jsonl');
    const persistence = new JsonlDiscordDeliveryDlqPersistence(dlqPath);
    const dlq = new DiscordDeliveryDlq({
      capacity: 8,
      logger: silentLogger(),
      now: () => 7777,
      persistence,
    });

    dlq.record({
      request: buildRequest({
        idempotencyKey: 'persist:1',
        context: { taskId: 'persist', eventType: 'terminal-result' },
      }),
      attempts: 6,
      failureClass: 'transient',
      lastError: { name: 'E', message: 'boom', status: 502 },
    });
    dlq.record({
      request: buildRequest({ idempotencyKey: 'persist:2' }),
      attempts: 1,
      failureClass: 'permanent',
      lastError: { name: 'E', message: 'gone', status: 404 },
    });

    expect(existsSync(dlqPath)).toBe(true);
    const raw = readFileSync(dlqPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first).toMatchObject({
      idempotencyKey: 'persist:1',
      attempts: 6,
      failureClass: 'transient',
      lastError: { status: 502 },
      recordedAtMs: 7777,
    });
    expect(second).toMatchObject({
      idempotencyKey: 'persist:2',
      failureClass: 'permanent',
    });
  });

  it('survives orchestrator restart: a fresh DLQ instance restores prior entries', () => {
    const dlqPath = join(workDir, 'discord-dlq.jsonl');
    const persistA = new JsonlDiscordDeliveryDlqPersistence(dlqPath);
    const dlqA = new DiscordDeliveryDlq({
      capacity: 4,
      logger: silentLogger(),
      persistence: persistA,
    });
    dlqA.record({
      request: buildRequest({ idempotencyKey: 'survives:1' }),
      attempts: 3,
      failureClass: 'transient',
      lastError: { name: 'E', message: 'm' },
    });
    dlqA.record({
      request: buildRequest({ idempotencyKey: 'survives:2' }),
      attempts: 1,
      failureClass: 'permanent',
      lastError: { name: 'E', message: 'm' },
    });

    // Simulate restart: brand-new DLQ + persistence over the same file.
    const persistB = new JsonlDiscordDeliveryDlqPersistence(dlqPath);
    const dlqB = new DiscordDeliveryDlq({
      capacity: 4,
      logger: silentLogger(),
      persistence: persistB,
    });
    expect(dlqB.size()).toBe(0);
    const restored = dlqB.restoreFromPersistence();
    expect(restored).toBe(2);
    expect(dlqB.list().map((e) => e.idempotencyKey)).toEqual([
      'survives:1',
      'survives:2',
    ]);
  });

  it('skips torn / partially written final lines on restore (best-effort recovery)', () => {
    const dlqPath = join(workDir, 'discord-dlq.jsonl');
    const persist = new JsonlDiscordDeliveryDlqPersistence(dlqPath);
    const dlq = new DiscordDeliveryDlq({
      capacity: 4,
      logger: silentLogger(),
      persistence: persist,
    });
    dlq.record({
      request: buildRequest({ idempotencyKey: 'good:1' }),
      attempts: 1,
      failureClass: 'transient',
      lastError: { name: 'E', message: 'm' },
    });
    // Append a torn line directly.
    appendFileSync(dlqPath, '{not-json\n', 'utf8');

    const dlq2 = new DiscordDeliveryDlq({
      capacity: 4,
      logger: silentLogger(),
      persistence: new JsonlDiscordDeliveryDlqPersistence(dlqPath),
    });
    expect(dlq2.restoreFromPersistence()).toBe(1);
    expect(dlq2.list()[0]?.idempotencyKey).toBe('good:1');
  });

  it('persistence write failures do not abort the in-memory record path', () => {
    const logger = { warn: vi.fn() };
    const failingPersist = {
      append: vi.fn(() => {
        throw new Error('disk full');
      }),
      loadAll: () => [],
    };
    const dlq = new DiscordDeliveryDlq({
      capacity: 4,
      logger,
      persistence: failingPersist,
    });
    const entry = dlq.record({
      request: buildRequest({ idempotencyKey: 'survive-write:1' }),
      attempts: 1,
      failureClass: 'transient',
      lastError: { name: 'E', message: 'm' },
    });
    expect(entry.idempotencyKey).toBe('survive-write:1');
    expect(dlq.size()).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'discord.delivery.dlq.persistence_failure',
      expect.objectContaining({
        idempotencyKey: 'survive-write:1',
        error: 'disk full',
      }),
    );
  });
});

describe('Delivered-key log persistence (spec §5)', () => {
  it('appends a line per confirmed delivery to runtime-state path', async () => {
    const keyPath = join(workDir, 'runtime-state', 'discord-delivered-keys.log');
    const persistence = new FileDiscordDeliveredKeyPersistence(keyPath);
    const queue = new DiscordDeliveryQueue({
      jitterFraction: 0,
      sleep: async () => undefined,
      dlq: { logger: silentLogger() },
      deliveredKeyPersistence: persistence,
    });
    const fn = vi.fn(async () => undefined);

    await queue.enqueue(
      buildRequest({ idempotencyKey: 'k:terminal-result:0' }),
      fn,
    );
    await queue.enqueue(
      buildRequest({ idempotencyKey: 'k:running-update:0' }),
      fn,
    );

    expect(existsSync(keyPath)).toBe(true);
    const lines = readFileSync(keyPath, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toEqual(['k:terminal-result:0', 'k:running-update:0']);
  });

  it('on restart, hydrates the LRU and dedupes already-delivered keys without invoking the deliveryFn', async () => {
    const keyPath = join(workDir, 'discord-delivered-keys.log');
    // First process session — record a delivery.
    const queueA = new DiscordDeliveryQueue({
      jitterFraction: 0,
      sleep: async () => undefined,
      dlq: { logger: silentLogger() },
      deliveredKeyPersistence: new FileDiscordDeliveredKeyPersistence(keyPath),
    });
    await queueA.enqueue(
      buildRequest({ idempotencyKey: 'restart:terminal-result:0' }),
      async () => undefined,
    );

    // Second process session — should pre-populate the LRU from disk and
    // short-circuit the re-enqueue as deduped.
    const queueB = new DiscordDeliveryQueue({
      jitterFraction: 0,
      sleep: async () => undefined,
      dlq: { logger: silentLogger() },
      deliveredKeyPersistence: new FileDiscordDeliveredKeyPersistence(keyPath),
    });
    expect(queueB.deliveredKeysSize()).toBe(1);
    const fn = vi.fn(async () => undefined);
    const result = await queueB.enqueue(
      buildRequest({ idempotencyKey: 'restart:terminal-result:0' }),
      fn,
    );
    expect(result).toMatchObject({
      attempts: 0,
      deduped: true,
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('delivered-key write failure does not fail the send (best-effort hint per §5)', async () => {
    const failingPersist = {
      append: vi.fn(() => {
        throw new Error('disk full');
      }),
      loadAll: () => [],
    };
    const queue = new DiscordDeliveryQueue({
      jitterFraction: 0,
      sleep: async () => undefined,
      dlq: { logger: silentLogger() },
      deliveredKeyPersistence: failingPersist,
    });
    const result = await queue.enqueue(
      buildRequest({ idempotencyKey: 'soft-fail:1' }),
      async () => undefined,
    );
    expect(result.outcome).toBe('success');
    expect(failingPersist.append).toHaveBeenCalledWith('soft-fail:1');
  });
});

describe('DiscordDeliveryMetrics surface (spec §2 signals)', () => {
  it('initializes with zeroed counters and circuit=closed gauge', () => {
    const queue = new DiscordDeliveryQueue({
      dlq: { logger: silentLogger() },
    });
    const snap = queue.metrics.snapshot();
    expect(snap.counters.attempted).toEqual({ success: 0, retry: 0, dlq: 0 });
    expect(snap.counters.deduped).toEqual({ already_delivered: 0 });
    expect(snap.gauges.dlqSize).toBe(0);
    expect(snap.gauges.circuitState).toEqual({
      closed: 1,
      open: 0,
      half_open: 0,
    });
    expect(snap.histograms.attemptLatencyMs).toEqual({});
  });

  it('records attempted{outcome=success} on first-try success', async () => {
    const queue = new DiscordDeliveryQueue({
      jitterFraction: 0,
      sleep: async () => undefined,
      dlq: { logger: silentLogger() },
    });
    await queue.enqueue(buildRequest(), async () => undefined);
    const snap = queue.metrics.snapshot();
    expect(snap.counters.attempted.success).toBe(1);
    expect(snap.counters.attempted.retry).toBe(0);
    expect(snap.counters.attempted.dlq).toBe(0);
  });

  it('records one attempted{retry} per pre-success retry, then attempted{success}', async () => {
    const queue = new DiscordDeliveryQueue({
      backoffScheduleMs: [1, 2, 4],
      jitterFraction: 0,
      sleep: async () => undefined,
      dlq: { logger: silentLogger() },
    });
    let calls = 0;
    await queue.enqueue(buildRequest(), async () => {
      calls += 1;
      if (calls < 3) {
        throw Object.assign(new Error('s'), { status: 503 });
      }
    });
    const snap = queue.metrics.snapshot();
    expect(snap.counters.attempted.success).toBe(1);
    expect(snap.counters.attempted.retry).toBe(2);
    expect(snap.counters.attempted.dlq).toBe(0);
  });

  it('records attempted{dlq} on retry-budget exhaustion and updates dlq.size gauge', async () => {
    const queue = new DiscordDeliveryQueue({
      backoffScheduleMs: [1, 2],
      jitterFraction: 0,
      sleep: async () => undefined,
      dlq: { logger: silentLogger() },
    });
    await queue.enqueue(buildRequest(), async () => {
      throw Object.assign(new Error('boom'), { status: 500 });
    });
    const snap = queue.metrics.snapshot();
    expect(snap.counters.attempted.dlq).toBe(1);
    // First retry counted before the final exhaustion attempt.
    expect(snap.counters.attempted.retry).toBe(1);
    expect(snap.gauges.dlqSize).toBe(1);
  });

  it('records deduped{already_delivered} on idempotent re-enqueue', async () => {
    const queue = new DiscordDeliveryQueue({
      jitterFraction: 0,
      sleep: async () => undefined,
      dlq: { logger: silentLogger() },
    });
    await queue.enqueue(buildRequest(), async () => undefined);
    await queue.enqueue(buildRequest(), async () => undefined);
    const snap = queue.metrics.snapshot();
    expect(snap.counters.deduped.already_delivered).toBe(1);
  });

  it('observes attempt latency histogram bucketed by attempt index', async () => {
    let virtualNow = 1000;
    const queue = new DiscordDeliveryQueue({
      backoffScheduleMs: [0, 0, 0],
      jitterFraction: 0,
      sleep: async () => undefined,
      dlq: { logger: silentLogger() },
      clock: () => virtualNow,
    });
    let calls = 0;
    await queue.enqueue(buildRequest(), async () => {
      calls += 1;
      virtualNow += calls === 1 ? 5 : 7;
      if (calls === 1) {
        throw Object.assign(new Error('s'), { status: 503 });
      }
    });
    const hist = queue.metrics.snapshot().histograms.attemptLatencyMs;
    expect(hist['1']).toMatchObject({ count: 1, sumMs: 5, minMs: 5, maxMs: 5 });
    expect(hist['2']).toMatchObject({ count: 1, sumMs: 7, minMs: 7, maxMs: 7 });
  });

  it('reflects circuit.state transitions on the gauge (closed → open)', async () => {
    const queue = new DiscordDeliveryQueue({
      backoffScheduleMs: [0],
      jitterFraction: 0,
      sleep: async () => undefined,
      circuit: { consecutiveFailureThreshold: 2, cooldownMs: 1000 },
      dlq: { logger: silentLogger() },
    });
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('x'), { status: 500 });
    });
    expect(queue.metrics.snapshot().gauges.circuitState).toEqual({
      closed: 1,
      open: 0,
      half_open: 0,
    });
    await queue.enqueue(
      buildRequest({ idempotencyKey: 'cb:1' }),
      fn,
    );
    await queue.enqueue(
      buildRequest({ idempotencyKey: 'cb:2' }),
      fn,
    );
    expect(queue.circuitBreaker.getState()).toBe('open');
    expect(queue.metrics.snapshot().gauges.circuitState).toEqual({
      closed: 0,
      open: 1,
      half_open: 0,
    });
    // A third send while open: rejected by breaker → DLQ entry counted.
    const result = await queue.enqueue(
      buildRequest({ idempotencyKey: 'cb:3' }),
      fn,
    );
    expect(result).toMatchObject({
      failureClass: 'circuit-open',
    });
  });

  it('reflects half-open transition on the gauge after cooldown', () => {
    const metrics = new DiscordDeliveryMetrics();
    metrics.setCircuitState('half-open');
    expect(metrics.snapshot().gauges.circuitState).toEqual({
      closed: 0,
      open: 0,
      half_open: 1,
    });
  });

  it('shares a metrics instance across multiple delivery queues when injected', async () => {
    const metrics = new DiscordDeliveryMetrics();
    const q1 = new DiscordDeliveryQueue({
      jitterFraction: 0,
      sleep: async () => undefined,
      dlq: { logger: silentLogger() },
      metrics,
    });
    const q2 = new DiscordDeliveryQueue({
      jitterFraction: 0,
      sleep: async () => undefined,
      dlq: { logger: silentLogger() },
      metrics,
    });
    await q1.enqueue(
      buildRequest({ idempotencyKey: 'shared:1' }),
      async () => undefined,
    );
    await q2.enqueue(
      buildRequest({ idempotencyKey: 'shared:2' }),
      async () => undefined,
    );
    expect(metrics.snapshot().counters.attempted.success).toBe(2);
  });
});
