/**
 * Dead-Letter buffer for failed Discord deliveries.
 *
 * Spec: specs/wu-disc-discord-delivery-reliability.md §2.3
 *
 * Storage: an in-memory ring buffer (bounded capacity, oldest-first eviction)
 * is the source of truth for the live process. An optional pluggable
 * `DiscordDeliveryDlqPersistence` hook provides durable JSONL append at
 * `runtime-state/discord-dlq.jsonl` per spec §6. Persisted entries are
 * loaded back into the ring buffer at startup via `restoreFromPersistence()`
 * so the operator-visible read API (`list()`, `size()`) survives restart.
 */

import type { DiscordDeliveryDlqPersistence } from './discord-delivery-persistence.js';
import type {
  DiscordDeliveryDlqEntry,
  DiscordDeliveryFailureClass,
  DiscordDeliveryRequest,
} from './discord-delivery-types.js';

export interface DiscordDeliveryDlqRecordInput {
  readonly request: DiscordDeliveryRequest;
  readonly attempts: number;
  readonly failureClass: DiscordDeliveryFailureClass;
  readonly lastError: DiscordDeliveryDlqEntry['lastError'];
}

export interface DiscordDeliveryDlqLogger {
  warn(message: string, fields: Record<string, unknown>): void;
}

export interface DiscordDeliveryDlqOptions {
  /** Ring buffer capacity. Oldest entries are evicted on overflow. */
  readonly capacity?: number;
  /** Optional logger for the structured per-entry warn line. */
  readonly logger?: DiscordDeliveryDlqLogger;
  /** Clock injection for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number;
  /**
   * Optional durable persistence sink (spec §2.3). When supplied, every
   * `record()` is appended to the sink in addition to the in-memory buffer.
   */
  readonly persistence?: DiscordDeliveryDlqPersistence;
}

const DEFAULT_CAPACITY = 256;

const DEFAULT_LOGGER: DiscordDeliveryDlqLogger = {
  warn(message, fields) {
    // Single structured line so downstream log scrapers can pick it up.
    // We intentionally avoid console.error to preserve the existing
    // observability surface (warnings only; no stderr noise).
     
    console.warn(message, JSON.stringify(fields));
  },
};

export class DiscordDeliveryDlq {
  private readonly capacity: number;
  private readonly logger: DiscordDeliveryDlqLogger;
  private readonly now: () => number;
  private readonly persistence: DiscordDeliveryDlqPersistence | undefined;
  private readonly entries: DiscordDeliveryDlqEntry[] = [];
  private droppedCount = 0;

  constructor(options: DiscordDeliveryDlqOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.logger = options.logger ?? DEFAULT_LOGGER;
    this.now = options.now ?? Date.now;
    this.persistence = options.persistence;
  }

  record(input: DiscordDeliveryDlqRecordInput): DiscordDeliveryDlqEntry {
    const entry: DiscordDeliveryDlqEntry = {
      idempotencyKey: input.request.idempotencyKey,
      operation: input.request.operation,
      payload: input.request.payload,
      ...(input.request.context === undefined
        ? {}
        : { context: input.request.context }),
      attempts: input.attempts,
      failureClass: input.failureClass,
      lastError: input.lastError,
      recordedAtMs: this.now(),
    };

    this.entries.push(entry);
    while (this.entries.length > this.capacity) {
      this.entries.shift();
      this.droppedCount += 1;
    }

    if (this.persistence) {
      try {
        this.persistence.append(entry);
      } catch (err) {
        // Persistence failure must NOT abort the in-memory record path.
        // Surface it via the existing logger so operators see the gap.
        this.logger.warn('discord.delivery.dlq.persistence_failure', {
          idempotencyKey: entry.idempotencyKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.warn('discord.delivery.dlq', {
      idempotencyKey: entry.idempotencyKey,
      operation: entry.operation,
      attempts: entry.attempts,
      failureClass: entry.failureClass,
      lastError: entry.lastError,
      context: entry.context,
      recordedAtMs: entry.recordedAtMs,
    });

    return entry;
  }

  /**
   * Restore in-memory ring buffer from persisted entries (spec §6 — DLQ
   * survives orchestrator restart). Respects capacity by keeping only the
   * most recent `capacity` entries; older entries are counted as dropped.
   */
  restoreFromPersistence(): number {
    if (!this.persistence) {
      return 0;
    }
    const loaded = this.persistence.loadAll();
    if (loaded.length === 0) {
      return 0;
    }
    const keep =
      loaded.length > this.capacity ? loaded.slice(-this.capacity) : loaded;
    this.droppedCount += loaded.length - keep.length;
    this.entries.splice(0, this.entries.length, ...keep);
    return keep.length;
  }

  list(): readonly DiscordDeliveryDlqEntry[] {
    return [...this.entries];
  }

  size(): number {
    return this.entries.length;
  }

  droppedDueToOverflow(): number {
    return this.droppedCount;
  }

  clear(): void {
    this.entries.length = 0;
    this.droppedCount = 0;
  }
}
