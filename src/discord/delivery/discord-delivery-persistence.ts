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

import type { DiscordDeliveryDlqEntry } from './discord-delivery-types.js';

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
      try {
        out.push(JSON.parse(trimmed) as DiscordDeliveryDlqEntry);
      } catch {
        // Spec §5: persisted records are a hint, not a source of truth.
        // A torn final line is silently skipped rather than crashing the
        // orchestrator on restart.
      }
    }
    return out;
  }
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
