/**
 * Metadata-only ledger for Claude token offload turns.
 *
 * The ledger stores one JSONL record per Claude offload consultation,
 * with the strict invariant that **no raw prompt or raw response text**
 * is retained. The retained record is a positive-allowlist projection of
 * `ClaudeOffloadResult` plus identity and provenance fields, so the
 * stored shape is auditable and stable across schema versions.
 *
 * Forbidden retained fields:
 *   - rawPrompt, rawResponse, rawInstruction
 *   - any banned key from the bundle contract
 *   - section bodies (only counts are retained at the ledger layer)
 *
 * Replay rejects any line that:
 *   - is not a JSON object,
 *   - has the wrong schema version,
 *   - contains an unsafe banned key anywhere in its object graph,
 *   - exceeds the per-record byte cap,
 *   - exceeds the optional aggregate byte cap.
 *
 * Replay tolerates torn/malformed JSONL lines and counts them as
 * `skippedMalformedLineCount` (mirrors the Plana advisor pattern).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { CLAUDE_OFFLOAD_BUNDLE_BANNED_FIELDS } from '../contracts/claude-token-offload.js';
import type {
  ClaudeOffloadErrorCategory,
  ClaudeOffloadResult,
  ClaudeOffloadRouteStatus,
} from './claude-token-offload-result.js';
import type { ClaudeOffloadPurpose } from '../contracts/claude-token-offload.js';

export const CLAUDE_OFFLOAD_LEDGER_SCHEMA_VERSION = 1 as const;
export const CLAUDE_OFFLOAD_LEDGER_PROVENANCE = 'claude-token-offload' as const;
export const CLAUDE_OFFLOAD_LEDGER_DECISION_ROLE = 'advisory-only' as const;

export const CLAUDE_OFFLOAD_LEDGER_MAX_RECORD_BYTES = 4 * 1024;
export const CLAUDE_OFFLOAD_LEDGER_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export const CLAUDE_OFFLOAD_LEDGER_RECORD_FIELDS = Object.freeze([
  'schemaVersion',
  'recordId',
  'createdAt',
  'purpose',
  'sourceRefCount',
  'acceptanceCheckCount',
  'routeStatus',
  'errorCategory',
  'degradedReason',
  'blockingGapCount',
  'memoryCandidateCount',
  'model',
  'latencyMs',
  'costUsd',
  'inputTokens',
  'cachedInputTokens',
  'outputTokens',
  'provenance',
  'decisionRole',
] as const);

export interface ClaudeOffloadLedgerRecord {
  readonly schemaVersion: typeof CLAUDE_OFFLOAD_LEDGER_SCHEMA_VERSION;
  readonly recordId: string;
  readonly createdAt: string;
  readonly purpose: ClaudeOffloadPurpose;
  readonly sourceRefCount: number;
  readonly acceptanceCheckCount: number;
  readonly routeStatus: ClaudeOffloadRouteStatus;
  readonly errorCategory: ClaudeOffloadErrorCategory;
  readonly degradedReason?: string;
  readonly blockingGapCount: number;
  readonly memoryCandidateCount: number;
  readonly model?: string;
  readonly latencyMs?: number;
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly provenance: typeof CLAUDE_OFFLOAD_LEDGER_PROVENANCE;
  readonly decisionRole: typeof CLAUDE_OFFLOAD_LEDGER_DECISION_ROLE;
}

export interface ClaudeOffloadLedgerInput {
  readonly result: ClaudeOffloadResult;
  readonly sourceRefCount: number;
  readonly acceptanceCheckCount: number;
  readonly recordId?: string;
  readonly createdAt?: string;
}

export interface ClaudeOffloadLedgerReplayAudit {
  readonly source: 'jsonl';
  readonly totalLineCount: number;
  readonly emptyLineCount: number;
  readonly parsedRecordCount: number;
  readonly skippedMalformedLineCount: number;
  readonly skippedUnsafeLineCount: number;
}

export interface ClaudeOffloadLedgerReplayResult {
  readonly records: readonly ClaudeOffloadLedgerRecord[];
  readonly replayAudit: ClaudeOffloadLedgerReplayAudit;
}

export interface ClaudeOffloadLedgerReplayOptions {
  readonly maxBytes?: number;
}

export interface ClaudeOffloadLedger {
  append(input: ClaudeOffloadLedgerInput): ClaudeOffloadLedgerRecord;
}

export class ClaudeOffloadLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeOffloadLedgerError';
  }
}

const BANNED_LOWER = new Set<string>(
  CLAUDE_OFFLOAD_BUNDLE_BANNED_FIELDS.map((field) => field.toLowerCase()),
);

const ALLOWED_FIELDS = new Set<string>(CLAUDE_OFFLOAD_LEDGER_RECORD_FIELDS);

/**
 * Strict plain-object check used by `validateRecordShape` for parsed
 * ledger lines. JSONL records always come back from `JSON.parse` with
 * `Object.prototype` as their prototype, so this check is correct for
 * record-shape validation.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * Permissive object-shape check used **only** by `containsBannedKey`.
 * If a future caller (or a poorly-written gateway adapter) hands us an
 * envelope built via `Object.create(null)`, in another realm, or as a
 * class instance, we still want to walk its keys looking for banned
 * names rather than skip it because the prototype is unfamiliar.
 */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsBannedKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsBannedKey);
  }
  if (!isObjectLike(value)) {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (BANNED_LOWER.has(key.toLowerCase())) {
      return true;
    }
    if (containsBannedKey(value[key])) {
      return true;
    }
  }
  return false;
}

function buildRecord(input: ClaudeOffloadLedgerInput): ClaudeOffloadLedgerRecord {
  const result = input.result;
  if (!Number.isInteger(input.sourceRefCount) || input.sourceRefCount < 0) {
    throw new ClaudeOffloadLedgerError(
      'sourceRefCount must be a non-negative integer',
    );
  }
  if (
    !Number.isInteger(input.acceptanceCheckCount) ||
    input.acceptanceCheckCount < 0
  ) {
    throw new ClaudeOffloadLedgerError(
      'acceptanceCheckCount must be a non-negative integer',
    );
  }
  const record: ClaudeOffloadLedgerRecord = Object.freeze({
    schemaVersion: CLAUDE_OFFLOAD_LEDGER_SCHEMA_VERSION,
    recordId: input.recordId ?? randomUUID(),
    createdAt: input.createdAt ?? new Date().toISOString(),
    purpose: result.purpose,
    sourceRefCount: input.sourceRefCount,
    acceptanceCheckCount: input.acceptanceCheckCount,
    routeStatus: result.routeStatus,
    errorCategory: result.errorCategory,
    ...(result.degradedReason === undefined
      ? {}
      : { degradedReason: result.degradedReason }),
    blockingGapCount: result.blockingGapCount,
    memoryCandidateCount: result.memoryCandidateCount,
    ...(result.model === undefined ? {} : { model: result.model }),
    ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
    ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    ...(result.tokenUsage === undefined
      ? {}
      : {
          inputTokens: result.tokenUsage.inputTokens,
          cachedInputTokens: result.tokenUsage.cachedInputTokens,
          outputTokens: result.tokenUsage.outputTokens,
        }),
    provenance: CLAUDE_OFFLOAD_LEDGER_PROVENANCE,
    decisionRole: CLAUDE_OFFLOAD_LEDGER_DECISION_ROLE,
  });
  return record;
}

const VALID_ROUTE_STATUSES = new Set<ClaudeOffloadRouteStatus>([
  'offload-route-ok',
  'offload-route-warn',
  'offload-route-fail',
]);

function validateRecordShape(value: unknown): value is ClaudeOffloadLedgerRecord {
  if (!isPlainObject(value)) return false;
  if (value.schemaVersion !== CLAUDE_OFFLOAD_LEDGER_SCHEMA_VERSION) return false;
  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(key)) return false;
  }
  if (typeof value.recordId !== 'string' || value.recordId.length === 0) return false;
  if (typeof value.createdAt !== 'string') return false;
  if (typeof value.purpose !== 'string') return false;
  if (typeof value.sourceRefCount !== 'number') return false;
  if (typeof value.acceptanceCheckCount !== 'number') return false;
  if (
    typeof value.routeStatus !== 'string' ||
    !VALID_ROUTE_STATUSES.has(value.routeStatus as ClaudeOffloadRouteStatus)
  ) {
    return false;
  }
  if (typeof value.errorCategory !== 'string') return false;
  if (typeof value.blockingGapCount !== 'number') return false;
  if (typeof value.memoryCandidateCount !== 'number') return false;
  if (value.provenance !== CLAUDE_OFFLOAD_LEDGER_PROVENANCE) return false;
  if (value.decisionRole !== CLAUDE_OFFLOAD_LEDGER_DECISION_ROLE) return false;
  return true;
}

export function projectClaudeOffloadResultToLedgerRecord(
  input: ClaudeOffloadLedgerInput,
): ClaudeOffloadLedgerRecord {
  const record = buildRecord(input);
  // Defense in depth: serialize and re-validate, ensuring no banned key
  // ever appears in the on-disk JSONL line.
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized, 'utf8') > CLAUDE_OFFLOAD_LEDGER_MAX_RECORD_BYTES) {
    throw new ClaudeOffloadLedgerError(
      `record exceeds max bytes ${CLAUDE_OFFLOAD_LEDGER_MAX_RECORD_BYTES}`,
    );
  }
  const reparsed = JSON.parse(serialized) as unknown;
  if (containsBannedKey(reparsed)) {
    throw new ClaudeOffloadLedgerError('record contains banned key after serialization');
  }
  if (!validateRecordShape(reparsed)) {
    throw new ClaudeOffloadLedgerError('record failed shape validation');
  }
  return record;
}

export class JsonlClaudeOffloadLedger implements ClaudeOffloadLedger {
  constructor(private readonly filePath: string) {}

  append(input: ClaudeOffloadLedgerInput): ClaudeOffloadLedgerRecord {
    const record = projectClaudeOffloadResultToLedgerRecord(input);
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  loadAll(): readonly ClaudeOffloadLedgerRecord[] {
    return this.loadWithAudit().records;
  }

  loadWithAudit(
    options: ClaudeOffloadLedgerReplayOptions = {},
  ): ClaudeOffloadLedgerReplayResult {
    if (!existsSync(this.filePath)) {
      return Object.freeze({
        records: Object.freeze<ClaudeOffloadLedgerRecord[]>([]),
        replayAudit: Object.freeze({
          source: 'jsonl' as const,
          totalLineCount: 0,
          emptyLineCount: 0,
          parsedRecordCount: 0,
          skippedMalformedLineCount: 0,
          skippedUnsafeLineCount: 0,
        }),
      });
    }
    const maxBytes = options.maxBytes;
    if (
      maxBytes !== undefined &&
      (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    ) {
      throw new ClaudeOffloadLedgerError(
        'maxBytes must be a positive safe integer',
      );
    }
    const buffer = readFileSync(this.filePath);
    if (
      maxBytes !== undefined &&
      buffer.byteLength > maxBytes
    ) {
      throw new ClaudeOffloadLedgerError(
        `ledger file ${this.filePath} exceeds maxBytes ${maxBytes}`,
      );
    }
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    // The split produces an empty trailing element when the file ends in
    // '\n'. Strip it so that interstitial empty lines are still counted
    // accurately while the trailing newline is not.
    const meaningfulLines =
      lines.length > 0 && lines[lines.length - 1] === ''
        ? lines.slice(0, -1)
        : lines;
    let totalLineCount = 0;
    let emptyLineCount = 0;
    let parsedRecordCount = 0;
    let skippedMalformedLineCount = 0;
    let skippedUnsafeLineCount = 0;
    const records: ClaudeOffloadLedgerRecord[] = [];

    for (const rawLine of meaningfulLines) {
      totalLineCount += 1;
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) {
        emptyLineCount += 1;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        skippedMalformedLineCount += 1;
        continue;
      }
      if (containsBannedKey(parsed)) {
        skippedUnsafeLineCount += 1;
        continue;
      }
      if (!validateRecordShape(parsed)) {
        skippedMalformedLineCount += 1;
        continue;
      }
      records.push(Object.freeze(parsed));
      parsedRecordCount += 1;
    }

    return Object.freeze({
      records: Object.freeze<ClaudeOffloadLedgerRecord[]>(records),
      replayAudit: Object.freeze({
        source: 'jsonl' as const,
        totalLineCount,
        emptyLineCount,
        parsedRecordCount,
        skippedMalformedLineCount,
        skippedUnsafeLineCount,
      }),
    });
  }
}

export interface ClaudeOffloadLedgerScorecard {
  readonly schemaVersion: typeof CLAUDE_OFFLOAD_LEDGER_SCHEMA_VERSION;
  readonly recordCount: number;
  readonly statusCounts: Readonly<Record<ClaudeOffloadRouteStatus, number>>;
  readonly errorCategoryCounts: Readonly<
    Record<ClaudeOffloadErrorCategory, number>
  >;
  readonly purposeCounts: Readonly<Record<ClaudeOffloadPurpose, number>>;
  readonly totalBlockingGaps: number;
  readonly totalMemoryCandidates: number;
  readonly recency: {
    readonly firstRecordedAt?: string;
    readonly lastRecordedAt?: string;
  };
}

const ROUTE_STATUSES: readonly ClaudeOffloadRouteStatus[] = [
  'offload-route-ok',
  'offload-route-warn',
  'offload-route-fail',
];
const ERROR_CATEGORIES: readonly ClaudeOffloadErrorCategory[] = [
  'none',
  'quota-exhausted',
  'auth-failed',
  'model-unavailable',
  'timeout',
  'network',
  'partial-result',
  'tool-use-degraded',
  'parse-failure',
  'unknown',
];
const PURPOSES: readonly ClaudeOffloadPurpose[] = [
  'checkpoint-synthesis',
  'live-proof-triage',
  'implementation-plan-critique',
  'memory-compaction-draft',
];

export function buildClaudeOffloadLedgerScorecard(
  records: readonly ClaudeOffloadLedgerRecord[],
): ClaudeOffloadLedgerScorecard {
  const statusCounts: Record<ClaudeOffloadRouteStatus, number> = {
    'offload-route-ok': 0,
    'offload-route-warn': 0,
    'offload-route-fail': 0,
  };
  const errorCategoryCounts: Record<ClaudeOffloadErrorCategory, number> = {
    none: 0,
    'quota-exhausted': 0,
    'auth-failed': 0,
    'model-unavailable': 0,
    timeout: 0,
    network: 0,
    'partial-result': 0,
    'tool-use-degraded': 0,
    'parse-failure': 0,
    unknown: 0,
  };
  const purposeCounts: Record<ClaudeOffloadPurpose, number> = {
    'checkpoint-synthesis': 0,
    'live-proof-triage': 0,
    'implementation-plan-critique': 0,
    'memory-compaction-draft': 0,
  };
  let totalBlockingGaps = 0;
  let totalMemoryCandidates = 0;
  let firstRecordedAt: string | undefined;
  let lastRecordedAt: string | undefined;
  for (const record of records) {
    if (ROUTE_STATUSES.includes(record.routeStatus)) {
      statusCounts[record.routeStatus] += 1;
    }
    if (ERROR_CATEGORIES.includes(record.errorCategory)) {
      errorCategoryCounts[record.errorCategory] += 1;
    }
    if (PURPOSES.includes(record.purpose)) {
      purposeCounts[record.purpose] += 1;
    }
    totalBlockingGaps += record.blockingGapCount;
    totalMemoryCandidates += record.memoryCandidateCount;
    if (firstRecordedAt === undefined || record.createdAt < firstRecordedAt) {
      firstRecordedAt = record.createdAt;
    }
    if (lastRecordedAt === undefined || record.createdAt > lastRecordedAt) {
      lastRecordedAt = record.createdAt;
    }
  }
  return Object.freeze({
    schemaVersion: CLAUDE_OFFLOAD_LEDGER_SCHEMA_VERSION,
    recordCount: records.length,
    statusCounts: Object.freeze(statusCounts),
    errorCategoryCounts: Object.freeze(errorCategoryCounts),
    purposeCounts: Object.freeze(purposeCounts),
    totalBlockingGaps,
    totalMemoryCandidates,
    recency: Object.freeze({
      ...(firstRecordedAt === undefined ? {} : { firstRecordedAt }),
      ...(lastRecordedAt === undefined ? {} : { lastRecordedAt }),
    }),
  });
}
