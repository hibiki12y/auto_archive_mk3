/**
 * File-based JSONL persistence for the Discord delivery DLQ and the
 * delivered-key dedup log.
 *
 * Spec: specs/wu-disc-discord-delivery-reliability.md §2.3, §5, §6
 *
 * Design notes:
 *   - Append-only. Each `record()` writes one line via `fs.appendFileSync`
 *     so a process crash mid-write at worst drops the in-flight line; prior
 *     entries remain intact.
 *   - Synchronous I/O is used deliberately: the queue's success-path
 *     critical section never touches persistence, and DLQ writes happen
 *     only on terminal failure where ordering and durability outweigh the
 *     few-ms cost. Spec §7.6 (success-path < 5ms overhead) is unaffected.
 *   - No external dependency (e.g. better-sqlite3) is required — Node's
 *     built-in `fs` is sufficient at the spec's stated scale (single
 *     orchestrator instance, file-based JSONL, §8 out-of-scope durable Q).
 *   - The directory is auto-created on first write so the caller does not
 *     need to pre-provision `runtime-state/`.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type {
  DiscordDeliveryDlqEntry,
  DiscordDeliveryFailureClass,
  DiscordDeliveryOperation,
} from './discord-delivery-types.js';

const DELIVERY_OPERATIONS: readonly DiscordDeliveryOperation[] = [
  'editReply',
  'followUp',
];

const DELIVERY_FAILURE_CLASSES: readonly DiscordDeliveryFailureClass[] = [
  'rate-limit',
  'quota-exhausted',
  'transient',
  'permanent',
  'circuit-open',
];

/**
 * DLQ persistence interface. The default implementation appends JSONL to disk;
 * tests / alternative storage backends can substitute their own.
 */
export interface DiscordDeliveryDlqPersistence {
  append(entry: DiscordDeliveryDlqEntry): void;
  loadAll(): DiscordDeliveryDlqEntry[];
}

/**
 * Default JSONL-on-disk implementation (spec §6 — `runtime-state/discord-dlq.jsonl`).
 */
export class JsonlDiscordDeliveryDlqPersistence
  implements DiscordDeliveryDlqPersistence
{
  constructor(private readonly filePath: string) {}

  append(entry: DiscordDeliveryDlqEntry): void {
    ensureDirFor(this.filePath);
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  loadAll(): DiscordDeliveryDlqEntry[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const raw = readFileSync(this.filePath, 'utf8');
    const out: DiscordDeliveryDlqEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Spec §5: persisted records are a hint, not a source of truth.
        // A torn final line is silently skipped rather than crashing the
        // orchestrator on restart.
        continue;
      }
      const entry = parseDlqEntry(parsed);
      if (entry !== undefined) {
        out.push(entry);
      }
      // Shape-mismatched lines (schema drift, partial writes, alien
      // entries) are dropped on the same best-effort principle as torn
      // JSON. Casting unchecked would let malformed entries propagate
      // back into the runtime ring buffer with the wrong type.
    }
    return out;
  }
}

/**
 * Validates a JSON-decoded line against the {@link DiscordDeliveryDlqEntry}
 * contract. Returns `undefined` (best-effort skip) rather than throwing,
 * matching the surrounding policy that DLQ persistence is a hint and the
 * orchestrator must tolerate corruption on restart.
 */
export function parseDlqEntry(value: unknown): DiscordDeliveryDlqEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record['idempotencyKey'] !== 'string') return undefined;
  if (
    typeof record['operation'] !== 'string' ||
    !DELIVERY_OPERATIONS.includes(record['operation'] as DiscordDeliveryOperation)
  ) {
    return undefined;
  }
  if (
    typeof record['payload'] !== 'object' ||
    record['payload'] === null ||
    Array.isArray(record['payload'])
  ) {
    return undefined;
  }
  if (typeof record['attempts'] !== 'number' || !Number.isInteger(record['attempts'])) {
    return undefined;
  }
  if (
    typeof record['failureClass'] !== 'string' ||
    !DELIVERY_FAILURE_CLASSES.includes(
      record['failureClass'] as DiscordDeliveryFailureClass,
    )
  ) {
    return undefined;
  }
  const lastError = record['lastError'];
  if (typeof lastError !== 'object' || lastError === null || Array.isArray(lastError)) {
    return undefined;
  }
  const lastErrorRecord = lastError as Record<string, unknown>;
  if (
    typeof lastErrorRecord['name'] !== 'string' ||
    typeof lastErrorRecord['message'] !== 'string'
  ) {
    return undefined;
  }
  if (
    lastErrorRecord['status'] !== undefined &&
    typeof lastErrorRecord['status'] !== 'number'
  ) {
    return undefined;
  }
  if (typeof record['recordedAtMs'] !== 'number') {
    return undefined;
  }
  if (
    record['context'] !== undefined &&
    (typeof record['context'] !== 'object' ||
      record['context'] === null ||
      Array.isArray(record['context']))
  ) {
    return undefined;
  }
  return value as DiscordDeliveryDlqEntry;
}

/**
 * Delivered-key persistence interface. One line per idempotency key; load
 * returns the full set on restart for best-effort dedup recovery (§5).
 */
export interface DiscordDeliveredKeyPersistence {
  append(key: string): void;
  loadAll(): string[];
}

/**
 * Default append-only file implementation (spec §6 —
 * `runtime-state/discord-delivered-keys.log`).
 */
export class FileDiscordDeliveredKeyPersistence
  implements DiscordDeliveredKeyPersistence
{
  constructor(private readonly filePath: string) {}

  append(key: string): void {
    ensureDirFor(this.filePath);
    appendFileSync(this.filePath, `${key}\n`, 'utf8');
  }

  loadAll(): string[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const raw = readFileSync(this.filePath, 'utf8');
    const out: string[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        out.push(trimmed);
      }
    }
    return out;
  }
}

function ensureDirFor(filePath: string): void {
  const dir = dirname(filePath);
  if (dir.length > 0 && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
