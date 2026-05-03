/**
 * Failure classifier for Discord delivery errors. Implements §3 taxonomy.
 *
 * discord.js raises `DiscordAPIError` with `.status` and `.code` fields, and
 * `HTTPError` for transport-level failures. We deliberately avoid importing
 * those classes directly to keep this module test-doublable without pulling
 * the whole REST stack — instead we duck-type on the well-known shape.
 */

import type { DiscordDeliveryFailureClass } from './discord-delivery-types.js';

export interface DiscordClassificationResult {
  readonly failureClass: DiscordDeliveryFailureClass;
  readonly retryable: boolean;
  /** Server-directed wait, in milliseconds, when present (e.g. Retry-After). */
  readonly retryAfterMs?: number;
  readonly status?: number;
}

interface ErrorLike {
  readonly name?: string;
  readonly message?: string;
  readonly code?: string | number;
  readonly status?: number;
  readonly httpStatus?: number;
  readonly retryAfter?: number;
  readonly retry_after?: number;
  readonly headers?: Record<string, string | string[] | undefined>;
}

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
]);

function readStatus(err: ErrorLike): number | undefined {
  if (typeof err.status === 'number') {
    return err.status;
  }
  if (typeof err.httpStatus === 'number') {
    return err.httpStatus;
  }
  return undefined;
}

function readRetryAfterMs(err: ErrorLike): number | undefined {
  // discord.js exposes retryAfter in seconds (sometimes ms).
  if (typeof err.retryAfter === 'number') {
    return err.retryAfter < 1000 ? err.retryAfter * 1000 : err.retryAfter;
  }
  if (typeof err.retry_after === 'number') {
    return err.retry_after < 1000 ? err.retry_after * 1000 : err.retry_after;
  }
  const headers = err.headers;
  if (headers) {
    const raw = headers['retry-after'] ?? headers['Retry-After'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed * 1000;
      }
    }
  }
  return undefined;
}

export function classifyDiscordDeliveryError(
  raw: unknown,
): DiscordClassificationResult {
  if (raw === null || typeof raw !== 'object') {
    return { failureClass: 'transient', retryable: true };
  }
  const err = raw as ErrorLike;
  const status = readStatus(err);
  const retryAfterMs = readRetryAfterMs(err);

  if (status === 429) {
    if (retryAfterMs !== undefined) {
      return {
        failureClass: 'rate-limit',
        retryable: true,
        retryAfterMs,
        status,
      };
    }
    return { failureClass: 'quota-exhausted', retryable: true, status };
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return { failureClass: 'transient', retryable: true, status };
  }

  if (status !== undefined && status >= 400 && status < 500) {
    return { failureClass: 'permanent', retryable: false, status };
  }

  // Network-level — no HTTP status.
  const code = err.code;
  if (typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)) {
    return { failureClass: 'transient', retryable: true };
  }

  // Unknown error — be conservative and treat as transient (will be capped by
  // the retry budget). Permanent classification requires explicit signal.
  return { failureClass: 'transient', retryable: true };
}
