/**
 * In-process metrics surface for the Discord delivery reliability layer.
 *
 * Spec: specs/wu-disc-discord-delivery-reliability.md §2 (signals)
 *
 * Metric inventory (names mirror the spec verbatim):
 *   - counter   `discord.delivery.attempted{outcome=success|retry|dlq}`
 *   - counter   `discord.delivery.deduped{reason=already_delivered}`
 *   - gauge     `discord.delivery.dlq.size`
 *   - histogram `discord.delivery.attempt.latency_ms{attempt=1..N}`
 *   - gauge     `discord.delivery.circuit.state{state=closed|open|half_open}`
 *
 * The exporter (Prometheus, OTLP) is out of scope per spec §8; this surface is
 * purely in-process and intended to be polled or scraped via `snapshot()`.
 */

import type { DiscordCircuitState } from './discord-delivery-types.js';

export type DiscordDeliveryAttemptOutcome = 'success' | 'retry' | 'dlq';

export interface DiscordDeliveryHistogramSample {
  readonly count: number;
  readonly sumMs: number;
  readonly minMs: number;
  readonly maxMs: number;
}

export interface DiscordDeliveryMetricsSnapshot {
  readonly counters: {
    readonly attempted: Record<DiscordDeliveryAttemptOutcome, number>;
    readonly deduped: { readonly already_delivered: number };
  };
  readonly gauges: {
    readonly dlqSize: number;
    /**
     * Spec §2.5 surface uses `closed | open | half_open` (with underscore).
     * We expose all three keys; exactly one is `1`, the others `0`.
     */
    readonly circuitState: {
      readonly closed: 0 | 1;
      readonly open: 0 | 1;
      readonly half_open: 0 | 1;
    };
  };
  readonly histograms: {
    /** Keyed by attempt label (`'1'`, `'2'`, …) per spec `attempt=1..N`. */
    readonly attemptLatencyMs: Record<string, DiscordDeliveryHistogramSample>;
  };
}

/**
 * Spec §2 metric facade. Mutation methods are tightly scoped to keep the
 * delivery queue from accidentally mis-labelling a metric.
 */
export class DiscordDeliveryMetrics {
  private attempted: Record<DiscordDeliveryAttemptOutcome, number> = {
    success: 0,
    retry: 0,
    dlq: 0,
  };
  private deduped = { already_delivered: 0 };
  private dlqSize = 0;
  private circuit: DiscordCircuitState = 'closed';
  private histograms = new Map<string, DiscordDeliveryHistogramSample>();

  /** §2.1 — increment `discord.delivery.attempted{outcome=…}`. */
  recordAttempt(outcome: DiscordDeliveryAttemptOutcome): void {
    this.attempted[outcome] += 1;
  }

  /** §2.2 — increment `discord.delivery.deduped{reason=already_delivered}`. */
  recordDedup(): void {
    this.deduped.already_delivered += 1;
  }

  /** §2.3 — set `discord.delivery.dlq.size`. */
  setDlqSize(size: number): void {
    this.dlqSize = Math.max(0, Math.floor(size));
  }

  /** §2.4 — observe `discord.delivery.attempt.latency_ms{attempt=N}`. */
  observeAttemptLatency(attempt: number, latencyMs: number): void {
    const key = String(attempt);
    const prior = this.histograms.get(key);
    if (prior === undefined) {
      this.histograms.set(key, {
        count: 1,
        sumMs: latencyMs,
        minMs: latencyMs,
        maxMs: latencyMs,
      });
      return;
    }
    this.histograms.set(key, {
      count: prior.count + 1,
      sumMs: prior.sumMs + latencyMs,
      minMs: Math.min(prior.minMs, latencyMs),
      maxMs: Math.max(prior.maxMs, latencyMs),
    });
  }

  /** §2.5 — set `discord.delivery.circuit.state{state=…}`. */
  setCircuitState(state: DiscordCircuitState): void {
    this.circuit = state;
  }

  /** Returns a deeply-frozen snapshot suitable for export. */
  snapshot(): DiscordDeliveryMetricsSnapshot {
    const histogramSnapshot: Record<string, DiscordDeliveryHistogramSample> = {};
    for (const [key, value] of this.histograms) {
      histogramSnapshot[key] = { ...value };
    }
    return {
      counters: {
        attempted: { ...this.attempted },
        deduped: { ...this.deduped },
      },
      gauges: {
        dlqSize: this.dlqSize,
        circuitState: {
          closed: this.circuit === 'closed' ? 1 : 0,
          open: this.circuit === 'open' ? 1 : 0,
          half_open: this.circuit === 'half-open' ? 1 : 0,
        },
      },
      histograms: {
        attemptLatencyMs: histogramSnapshot,
      },
    };
  }

  /** Test helper: zero everything. */
  reset(): void {
    this.attempted = { success: 0, retry: 0, dlq: 0 };
    this.deduped = { already_delivered: 0 };
    this.dlqSize = 0;
    this.circuit = 'closed';
    this.histograms.clear();
  }
}
