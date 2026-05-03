/**
 * DiscordDeliveryQueue — at-least-once delivery with idempotency, exponential
 * backoff, circuit breaker, DLQ, and a metrics surface. Replaces the
 * silent-swallow `safelySend` helper that previously discarded terminal
 * follow-up failures.
 *
 * Spec: specs/wu-disc-discord-delivery-reliability.md
 *
 * Observability:
 *   - DLQ ring buffer + optional JSONL persistence (`runtime-state/discord-dlq.jsonl`).
 *   - Optional delivered-key append-log persistence
 *     (`runtime-state/discord-delivered-keys.log`) for best-effort dedup
 *     recovery across restart (§5).
 *   - Optional `DiscordDeliveryMetrics` facade exposing the §2 counters,
 *     gauges, and histogram (`discord.delivery.attempted`,
 *     `discord.delivery.deduped`, `discord.delivery.dlq.size`,
 *     `discord.delivery.attempt.latency_ms`, `discord.delivery.circuit.state`).
 */

import {
  classifyDiscordDeliveryError,
  type DiscordClassificationResult,
} from './discord-delivery-classifier.js';
import {
  DiscordCircuitBreaker,
  type DiscordCircuitBreakerOptions,
} from './discord-delivery-circuit-breaker.js';
import {
  DiscordDeliveryDlq,
  type DiscordDeliveryDlqOptions,
} from './discord-delivery-dlq.js';
import { DiscordDeliveryMetrics } from './discord-delivery-metrics.js';
import type { DiscordDeliveredKeyPersistence } from './discord-delivery-persistence.js';
import type {
  DiscordDeliveryFailureClass,
  DiscordDeliveryRequest,
  DiscordDeliveryResult,
} from './discord-delivery-types.js';
import type { AdmissionGate } from '../../core/admission-gate.js';
import { AdmissionDeniedError } from '../../core/admission-denied-error.js';

export type DiscordDeliveryFn = (
  request: DiscordDeliveryRequest,
) => Promise<unknown>;

export interface DiscordDeliveryQueueOptions {
  /** Backoff schedule in milliseconds. Length implies max attempts. */
  readonly backoffScheduleMs?: readonly number[];
  /** ±jitter fraction, e.g. 0.2 = ±20%. Set 0 in tests for determinism. */
  readonly jitterFraction?: number;
  /** LRU capacity for the delivered-key set. */
  readonly idempotencyCapacity?: number;
  readonly circuit?: DiscordCircuitBreakerOptions;
  readonly dlq?: DiscordDeliveryDlqOptions | DiscordDeliveryDlq;
  /** Sleep injection for deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** RNG injection for deterministic jitter in tests. */
  readonly random?: () => number;
  /**
   * Optional metrics sink (spec §2 signals). When omitted, an internal
   * instance is created and exposed via `metrics`.
   */
  readonly metrics?: DiscordDeliveryMetrics;
  /**
   * Optional durable persistence for the delivered-key set (spec §5).
   * Hydrated into the LRU on construction; appended on every confirmed
   * success.
   */
  readonly deliveredKeyPersistence?: DiscordDeliveredKeyPersistence;
  /**
   * Monotonic clock injection for the attempt-latency histogram. Defaults to
   * `() => Date.now()`. Tests may inject a virtual clock.
   */
  readonly clock?: () => number;
  /**
   * WU-L Step D — optional admission gate evaluated at the T2
   * `delivery` chokepoint (just before each `deliveryFn(request)`
   * attempt). On `verdict === 'deny'` the attempt throws an
   * {@link AdmissionDeniedError} which propagates through the existing
   * retry/circuit-breaker classifier path; the error is NOT swallowed.
   *
   * Omitted in production until rules are wired; behavior is identical
   * to pre-WU-L when undefined.
   *
   * @see specs/wu-l-admission-rule-evaluator.md §4
   */
  readonly admissionGate?: AdmissionGate;
}

const DEFAULT_BACKOFF_MS: readonly number[] = [
  250, 500, 1000, 2000, 4000, 8000,
];
const DEFAULT_JITTER_FRACTION = 0.2;
const DEFAULT_IDEMPOTENCY_CAPACITY = 1024;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Bounded LRU set keyed by string. Insertion-order eviction. */
class LruStringSet {
  private readonly capacity: number;
  private readonly map = new Map<string, true>();

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  has(key: string): boolean {
    if (!this.map.has(key)) {
      return false;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, true);
    return true;
  }

  add(key: string): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, true);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.map.delete(oldest);
    }
  }

  size(): number {
    return this.map.size;
  }
}

export class DiscordDeliveryQueue {
  private readonly backoff: readonly number[];
  private readonly jitter: number;
  private readonly delivered: LruStringSet;
  private readonly circuit: DiscordCircuitBreaker;
  private readonly dlqStore: DiscordDeliveryDlq;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly metricsImpl: DiscordDeliveryMetrics;
  private readonly deliveredKeyPersistence:
    | DiscordDeliveredKeyPersistence
    | undefined;
  private readonly clock: () => number;
  private readonly admissionGate: AdmissionGate | undefined;

  constructor(options: DiscordDeliveryQueueOptions = {}) {
    this.backoff =
      options.backoffScheduleMs && options.backoffScheduleMs.length > 0
        ? [...options.backoffScheduleMs]
        : DEFAULT_BACKOFF_MS;
    this.jitter = options.jitterFraction ?? DEFAULT_JITTER_FRACTION;
    this.delivered = new LruStringSet(
      options.idempotencyCapacity ?? DEFAULT_IDEMPOTENCY_CAPACITY,
    );
    this.circuit = new DiscordCircuitBreaker(options.circuit);
    this.dlqStore =
      options.dlq instanceof DiscordDeliveryDlq
        ? options.dlq
        : new DiscordDeliveryDlq(options.dlq);
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.metricsImpl = options.metrics ?? new DiscordDeliveryMetrics();
    this.deliveredKeyPersistence = options.deliveredKeyPersistence;
    this.clock = options.clock ?? Date.now;
    this.admissionGate = options.admissionGate;

    // Hydrate dedup LRU from persisted delivered-key log (spec §5).
    if (this.deliveredKeyPersistence) {
      for (const key of this.deliveredKeyPersistence.loadAll()) {
        this.delivered.add(key);
      }
    }

    // Seed gauges so the metrics surface is well-defined even before the
    // first enqueue.
    this.metricsImpl.setDlqSize(this.dlqStore.size());
    this.metricsImpl.setCircuitState(this.circuit.getState());
  }

  /** Read API for tests/observability. */
  get dlq(): DiscordDeliveryDlq {
    return this.dlqStore;
  }

  /** Read API for tests/observability. */
  get circuitBreaker(): DiscordCircuitBreaker {
    return this.circuit;
  }

  /** Spec §2 metrics surface. */
  get metrics(): DiscordDeliveryMetrics {
    return this.metricsImpl;
  }

  /** Number of distinct idempotency keys currently retained in the LRU. */
  deliveredKeysSize(): number {
    return this.delivered.size();
  }

  /**
   * Maximum number of delivery attempts (initial + retries) per request.
   */
  get maxAttempts(): number {
    return this.backoff.length;
  }

  /**
   * Attempt to deliver `request` with retry + circuit-breaker semantics.
   * Always resolves; never rejects. Failures terminate in the DLQ.
   */
  async enqueue(
    request: DiscordDeliveryRequest,
    deliveryFn: DiscordDeliveryFn,
  ): Promise<DiscordDeliveryResult> {
    if (this.delivered.has(request.idempotencyKey)) {
      this.metricsImpl.recordDedup();
      return {
        outcome: 'success',
        idempotencyKey: request.idempotencyKey,
        attempts: 0,
        deduped: true,
      };
    }

    const admit = this.circuit.acquire();
    this.metricsImpl.setCircuitState(this.circuit.getState());
    if (!admit.admit) {
      return this.recordDlq(request, 0, 'circuit-open', {
        name: 'CircuitOpenError',
        message: 'Discord delivery circuit is open',
      });
    }

    let attempt = 0;
    let lastClassification: DiscordClassificationResult | undefined;
    let lastError: { name: string; message: string; status?: number } = {
      name: 'UnknownError',
      message: 'no attempt produced an error',
    };

    while (attempt < this.backoff.length) {
      attempt += 1;
      const startMs = this.clock();
      try {
        // WU-L Step D — T2 `delivery` chokepoint, evaluated per
        // attempt so per-attempt context (e.g. attempt index) is
        // visible to predicates. Skipped entirely when no gate is
        // injected.
        if (this.admissionGate !== undefined) {
          const { decision, trace } =
            this.admissionGate.evaluateAndCaptureTrace({
              taskId: request.context?.taskId ?? request.idempotencyKey,
              trigger: 'T2_ChokepointCrossing',
              chokepoint: 'delivery',
              attempt,
              traits: [],
              metadata: {
                idempotencyKey: request.idempotencyKey,
                operation: request.operation,
                ...(request.context?.channelId === undefined
                  ? {}
                  : { channelId: request.context.channelId }),
              },
            });
          if (decision.verdict === 'deny') {
            throw new AdmissionDeniedError(decision, trace);
          }
        }
        await deliveryFn(request);
        this.metricsImpl.observeAttemptLatency(
          attempt,
          Math.max(0, this.clock() - startMs),
        );
        this.delivered.add(request.idempotencyKey);
        if (this.deliveredKeyPersistence) {
          try {
            this.deliveredKeyPersistence.append(request.idempotencyKey);
          } catch {
            // Best-effort per spec §5 ("hint, not source of truth"). A
            // delivered-key log write failure must not fail the send.
          }
        }
        this.circuit.recordSuccess();
        this.metricsImpl.setCircuitState(this.circuit.getState());
        this.metricsImpl.recordAttempt('success');
        return {
          outcome: 'success',
          idempotencyKey: request.idempotencyKey,
          attempts: attempt,
          deduped: false,
        };
      } catch (rawError) {
        this.metricsImpl.observeAttemptLatency(
          attempt,
          Math.max(0, this.clock() - startMs),
        );
        lastClassification = classifyDiscordDeliveryError(rawError);
        lastError = extractErrorShape(rawError, lastClassification.status);

        if (!lastClassification.retryable) {
          this.circuit.recordFailure();
          this.metricsImpl.setCircuitState(this.circuit.getState());
          return this.recordDlq(
            request,
            attempt,
            lastClassification.failureClass,
            lastError,
          );
        }

        if (admit.probe) {
          // Half-open probe failed → re-open circuit; do not retry within this
          // call. The request goes to DLQ so the operator sees the failure.
          this.circuit.recordFailure();
          this.metricsImpl.setCircuitState(this.circuit.getState());
          return this.recordDlq(
            request,
            attempt,
            lastClassification.failureClass,
            lastError,
          );
        }

        if (attempt >= this.backoff.length) {
          this.circuit.recordFailure();
          this.metricsImpl.setCircuitState(this.circuit.getState());
          break;
        }

        // A retry will follow — record under `outcome=retry`.
        this.metricsImpl.recordAttempt('retry');

        const baseDelay = this.backoff[attempt - 1] ?? 0;
        const waitMs =
          lastClassification.retryAfterMs !== undefined
            ? lastClassification.retryAfterMs
            : this.applyJitter(baseDelay);
        if (waitMs > 0) {
          await this.sleep(waitMs);
        }
      }
    }

    return this.recordDlq(
      request,
      attempt,
      lastClassification?.failureClass ?? 'transient',
      lastError,
    );
  }

  private applyJitter(baseMs: number): number {
    if (this.jitter <= 0) {
      return baseMs;
    }
    const span = baseMs * this.jitter;
    const offset = (this.random() * 2 - 1) * span;
    return Math.max(0, Math.round(baseMs + offset));
  }

  private recordDlq(
    request: DiscordDeliveryRequest,
    attempts: number,
    failureClass: DiscordDeliveryFailureClass,
    lastError: { name: string; message: string; status?: number },
  ): DiscordDeliveryResult {
    this.dlqStore.record({
      request,
      attempts,
      failureClass,
      lastError,
    });
    this.metricsImpl.setDlqSize(this.dlqStore.size());
    this.metricsImpl.recordAttempt('dlq');
    return {
      outcome: 'dlq',
      idempotencyKey: request.idempotencyKey,
      attempts,
      failureClass,
      lastError,
    };
  }
}

function extractErrorShape(
  raw: unknown,
  status?: number,
): { name: string; message: string; status?: number } {
  if (raw instanceof Error) {
    return {
      name: raw.name,
      message: raw.message,
      ...(status === undefined ? {} : { status }),
    };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as { name?: unknown; message?: unknown };
    return {
      name: typeof obj.name === 'string' ? obj.name : 'NonErrorThrown',
      message:
        typeof obj.message === 'string' ? obj.message : JSON.stringify(raw),
      ...(status === undefined ? {} : { status }),
    };
  }
  return {
    name: 'NonErrorThrown',
    message: String(raw),
    ...(status === undefined ? {} : { status }),
  };
}
