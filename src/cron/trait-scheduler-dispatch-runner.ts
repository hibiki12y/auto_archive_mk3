import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { TextDecoder } from 'node:util';

import type {
  TraitScheduleDeliveryTarget,
  TraitSchedulerJobRecord,
  TraitSchedulerState,
} from '../core/trait-module-loader.js';
import type {
  PlanTraitSchedulerTickOptions,
  TraitSchedulerDueJob,
  TraitSchedulerSkippedJob,
  TraitSchedulerTickPlan,
  TraitSchedulerTickObserveHookBinding,
} from './trait-scheduler-tick.js';
import { planTraitSchedulerTick } from './trait-scheduler-tick.js';

/**
 * M9 — bounded host-callback runner for TraitModule scheduler due jobs.
 *
 * This module deliberately does not create a daemon, acquire a cross-process
 * lock, reload environment variables, or deliver Discord messages. Its core
 * runner is a deterministic bridge from a finalized `TraitSchedulerTickPlan`
 * to a caller-owned dispatch callback. Optional lease/evidence helpers below
 * are explicit host-invoked wrappers, not background authority.
 */

export interface TraitSchedulerDispatchAck {
  /** Optional task id returned by the host dispatcher. */
  readonly taskId?: string;
  /** Optional short host-authored note for audit logs. */
  readonly detail?: string;
}

export type TraitSchedulerDueJobDispatcher = (
  dueJob: TraitSchedulerDueJob,
) => TraitSchedulerDispatchAck | void | Promise<TraitSchedulerDispatchAck | void>;

export interface RunTraitSchedulerDueJobsOptions {
  readonly plan: TraitSchedulerTickPlan;
  readonly dispatch: TraitSchedulerDueJobDispatcher;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => string;
}

interface TraitSchedulerDispatchOutcomeBase {
  readonly runId: string;
  readonly jobId: string;
  readonly moduleId: string;
  readonly moduleVersion: string;
  readonly scheduleId: string;
  readonly dueAt: string;
  readonly summary: string;
  readonly deliveryTarget: TraitScheduleDeliveryTarget;
  readonly observedAt: string;
}

export interface TraitSchedulerDispatchSuccess
  extends TraitSchedulerDispatchOutcomeBase {
  readonly status: 'dispatched';
  readonly taskId?: string;
  readonly detail?: string;
}

export interface TraitSchedulerDispatchFailure
  extends TraitSchedulerDispatchOutcomeBase {
  readonly status: 'failed';
  readonly error: string;
}

export type TraitSchedulerDispatchOutcome =
  | TraitSchedulerDispatchSuccess
  | TraitSchedulerDispatchFailure;

export type TraitSchedulerDispatchCheckpoint =
  | {
      readonly status: 'advance';
      readonly lastTickAt: string;
    }
  | {
      readonly status: 'hold';
      readonly reason: 'dispatch-failed' | 'plan-truncated';
      readonly reasons: readonly ('dispatch-failed' | 'plan-truncated')[];
    };

export interface TraitSchedulerDispatchBatchResult {
  readonly planTickedAt: string;
  readonly windowStartExclusive: string;
  readonly windowEndInclusive: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly attemptedCount: number;
  readonly dispatchedCount: number;
  readonly failedCount: number;
  /**
   * Count of jobs the planner skipped before this runner was invoked
   * (currently invalid cron / unsupported timezone). Planner-skipped jobs are
   * reported for audit but do not by themselves hold the checkpoint.
   */
  readonly skippedPlannedCount: number;
  readonly truncated: boolean;
  readonly checkpoint: TraitSchedulerDispatchCheckpoint;
  readonly results: readonly TraitSchedulerDispatchOutcome[];
  readonly skippedJobs: readonly TraitSchedulerSkippedJob[];
}

export const TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION = 1 as const;

export type TraitSchedulerCursorHoldReason =
  | 'dispatch-failed'
  | 'plan-truncated';

export interface TraitSchedulerCursorBatchSummary {
  readonly planTickedAt: string;
  readonly attemptedCount: number;
  readonly dispatchedCount: number;
  readonly failedCount: number;
  readonly skippedPlannedCount: number;
  readonly truncated: boolean;
}

export interface TraitSchedulerTickCursorState {
  readonly schemaVersion: typeof TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly lastTickAt?: string;
  readonly lastHoldReasons?: readonly TraitSchedulerCursorHoldReason[];
  readonly lastBatch?: TraitSchedulerCursorBatchSummary;
}

/**
 * Sequentially dispatches due jobs in the exact order selected by
 * `planTraitSchedulerTick()`. The callback receives a clone of each due job so
 * accidental mutation cannot alter the plan snapshot used for audit evidence.
 *
 * Dispatcher failures are contained per job and do not prevent later due jobs
 * from being attempted. The checkpoint is conservative: callers should only
 * advance their stored `lastTickAt` when status is `advance`.
 */
export async function runTraitSchedulerDueJobs(
  options: RunTraitSchedulerDueJobsOptions,
): Promise<TraitSchedulerDispatchBatchResult> {
  const clock = options.now ?? (() => new Date().toISOString());
  const startedAt = clock();
  const results: TraitSchedulerDispatchOutcome[] = [];

  for (const dueJob of options.plan.dueJobs) {
    const snapshot = cloneDueJob(dueJob);
    const base = outcomeBase(snapshot, clock());
    try {
      const ack = await options.dispatch(snapshot);
      results.push({
        ...base,
        status: 'dispatched',
        ...(ack?.taskId === undefined ? {} : { taskId: ack.taskId }),
        ...(ack?.detail === undefined ? {} : { detail: ack.detail }),
      });
    } catch (error) {
      results.push({
        ...base,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const failedCount = results.filter((result) => result.status === 'failed').length;
  const checkpoint = buildCheckpoint(options.plan, failedCount);
  return {
    planTickedAt: options.plan.tickedAt,
    windowStartExclusive: options.plan.windowStartExclusive,
    windowEndInclusive: options.plan.windowEndInclusive,
    startedAt,
    completedAt: clock(),
    attemptedCount: options.plan.dueJobs.length,
    dispatchedCount: results.length - failedCount,
    failedCount,
    skippedPlannedCount: options.plan.skippedJobs.length,
    truncated: options.plan.truncated,
    checkpoint,
    results,
    skippedJobs: options.plan.skippedJobs.map((job) => ({ ...job })),
  };
}

/**
 * Applies conservative checkpoint advice to a cursor snapshot. The function
 * is pure: it never mutates the previous cursor or writes to disk.
 */
export function applyTraitSchedulerDispatchCheckpoint(
  previous: TraitSchedulerTickCursorState,
  batch: TraitSchedulerDispatchBatchResult,
): TraitSchedulerTickCursorState {
  const lastBatch = summarizeBatch(batch);
  if (batch.checkpoint.status === 'advance') {
    return {
      schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
      updatedAt: batch.completedAt,
      lastTickAt: batch.checkpoint.lastTickAt,
      lastBatch,
    };
  }

  return {
    schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
    updatedAt: batch.completedAt,
    ...(previous.lastTickAt === undefined
      ? {}
      : { lastTickAt: previous.lastTickAt }),
    lastHoldReasons: batch.checkpoint.reasons,
    lastBatch,
  };
}

export class JsonFileTraitSchedulerCursorStore {
  constructor(private readonly filePath: string) {}

  load(): TraitSchedulerTickCursorState {
    if (!existsSync(this.filePath)) {
      return {
        schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
        updatedAt: new Date(0).toISOString(),
      };
    }
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
    return parseTraitSchedulerTickCursorState(parsed, this.filePath);
  }

  save(state: TraitSchedulerTickCursorState): void {
    const parsed = parseTraitSchedulerTickCursorState(state, this.filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, this.filePath);
  }
}

export interface RunTraitSchedulerTickOnceOptions {
  readonly state: TraitSchedulerState;
  readonly cursor: TraitSchedulerTickCursorState;
  readonly dispatch: TraitSchedulerDueJobDispatcher;
  /** Inclusive upper bound for planning. Defaults to the planner wall clock. */
  readonly now?: string;
  readonly maxDueJobs?: number;
  readonly maxLookbackMinutes?: number;
  readonly observeHooks?: ReadonlyArray<TraitSchedulerTickObserveHookBinding>;
  /** Injectable clock for dispatch batch timestamps. */
  readonly dispatchClock?: () => string;
}

export interface TraitSchedulerTickOnceResult {
  readonly plan: TraitSchedulerTickPlan;
  readonly batch: TraitSchedulerDispatchBatchResult;
  readonly previousCursor: TraitSchedulerTickCursorState;
  readonly nextCursor: TraitSchedulerTickCursorState;
}

export interface TraitSchedulerStateReader {
  load(): TraitSchedulerState;
}

export interface TraitSchedulerCursorStore {
  load(): TraitSchedulerTickCursorState;
  save(state: TraitSchedulerTickCursorState): void;
}

export interface RunTraitSchedulerTickOnceFromStoresOptions
  extends Omit<RunTraitSchedulerTickOnceOptions, 'state' | 'cursor'> {
  readonly schedulerStore: TraitSchedulerStateReader;
  readonly cursorStore: TraitSchedulerCursorStore;
}

export const TRAIT_SCHEDULER_TICK_LEASE_SCHEMA_VERSION = 1 as const;

export interface TraitSchedulerTickLeaseMetadata {
  readonly schemaVersion: typeof TRAIT_SCHEDULER_TICK_LEASE_SCHEMA_VERSION;
  readonly token: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export type TraitSchedulerTickLeaseAcquireResult =
  | {
      readonly status: 'acquired';
      readonly leasePath: string;
      readonly lease: TraitSchedulerTickLeaseMetadata;
    }
  | {
      readonly status: 'held';
      readonly leasePath: string;
      readonly observedAt: string;
      readonly existingLease?: TraitSchedulerTickLeaseMetadata;
    };

export interface TraitSchedulerTickLease {
  acquire(): TraitSchedulerTickLeaseAcquireResult;
  release(acquired: Extract<TraitSchedulerTickLeaseAcquireResult, { status: 'acquired' }>): void;
}

export interface JsonFileTraitSchedulerTickLeaseOptions {
  readonly ownerId?: string;
  readonly ttlMs?: number;
  readonly now?: () => string;
}

export interface RunTraitSchedulerTickOnceWithLeaseOptions
  extends RunTraitSchedulerTickOnceFromStoresOptions {
  readonly lease: TraitSchedulerTickLease;
}

export type TraitSchedulerTickOnceWithLeaseResult =
  | {
      readonly status: 'ran';
      readonly lease: Extract<TraitSchedulerTickLeaseAcquireResult, { status: 'acquired' }>;
      readonly result: TraitSchedulerTickOnceResult;
    }
  | {
      readonly status: 'skipped';
      readonly reason: 'lease-held';
      readonly lease: Extract<TraitSchedulerTickLeaseAcquireResult, { status: 'held' }>;
    };

export const TRAIT_SCHEDULER_TICK_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_SCHEMA_VERSION = 1 as const;
export const TRAIT_SCHEDULER_TICK_EVIDENCE_MIN_RECORDS_FOR_TREND = 5 as const;
export const TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_RUBRIC_VERSION =
  '2026-05-05.scheduler-tick-evidence-v1' as const;

export interface TraitSchedulerTickEvidenceLeaseSummary {
  readonly status: 'acquired' | 'held';
  readonly leasePath: string;
  readonly ownerId?: string;
  readonly acquiredAt?: string;
  readonly expiresAt?: string;
  readonly observedAt?: string;
}

export interface TraitSchedulerTickEvidenceBatchSummary
  extends TraitSchedulerCursorBatchSummary {
  readonly windowStartExclusive: string;
  readonly windowEndInclusive: string;
  readonly checkpointStatus: TraitSchedulerDispatchCheckpoint['status'];
  readonly checkpointLastTickAt?: string;
  readonly checkpointHoldReasons?: readonly TraitSchedulerCursorHoldReason[];
}

export interface TraitSchedulerTickEvidenceRecord {
  readonly schemaVersion: typeof TRAIT_SCHEDULER_TICK_EVIDENCE_SCHEMA_VERSION;
  readonly recordId: string;
  readonly recordedAt: string;
  readonly source?: string;
  readonly status: 'ran' | 'skipped';
  readonly reason?: 'lease-held';
  readonly lease?: TraitSchedulerTickEvidenceLeaseSummary;
  readonly batch?: TraitSchedulerTickEvidenceBatchSummary;
}

export interface TraitSchedulerTickEvidenceRecordInput {
  readonly recordId?: string;
  readonly recordedAt?: string;
  readonly source?: string;
  readonly tick: TraitSchedulerTickOnceWithLeaseResult | TraitSchedulerTickOnceResult;
}

export interface TraitSchedulerTickEvidenceLedger {
  append(input: TraitSchedulerTickEvidenceRecordInput): TraitSchedulerTickEvidenceRecord;
  loadAll(): TraitSchedulerTickEvidenceRecord[];
}

export interface TraitSchedulerTickEvidenceReplayAudit {
  readonly source: 'jsonl';
  readonly totalLineCount: number;
  readonly emptyLineCount: number;
  readonly parsedRecordCount: number;
  readonly skippedMalformedLineCount: number;
}

export interface TraitSchedulerTickEvidenceReplayResult {
  readonly records: readonly TraitSchedulerTickEvidenceRecord[];
  readonly replayAudit: TraitSchedulerTickEvidenceReplayAudit;
}

export interface TraitSchedulerTickEvidenceReplayOptions {
  /**
   * Optional read guard for operator-facing report surfaces. When set, replay
   * fails during bounded chunked replay before accepting bytes beyond this
   * bound.
   */
  readonly maxBytes?: number;
}

export interface JsonlTraitSchedulerTickEvidenceLedgerOptions {
  /**
   * Optional append-time retention guard. When set, each successful append
   * compacts the JSONL file to the latest N valid evidence records using
   * atomic tmp+rename. Malformed/torn historical lines are excluded from the
   * compacted file. Unset means append-only. This is a single-writer helper:
   * cross-process append serialization and backup rotation remain host-owned.
   */
  readonly retentionRecords?: number;
}

export interface TraitSchedulerTickEvidenceFilter {
  readonly status?: TraitSchedulerTickEvidenceRecord['status'];
  readonly source?: string;
  readonly limit?: number;
}

export interface TraitSchedulerTickEvidenceRate {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number;
}

export interface TraitSchedulerTickEvidenceScorecard {
  readonly schemaVersion: typeof TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_SCHEMA_VERSION;
  readonly recordCount: number;
  readonly sourceCounts: Readonly<Record<string, number>>;
  readonly statusCounts: {
    readonly ran: number;
    readonly skipped: number;
  };
  readonly leaseCounts: {
    readonly acquired: number;
    readonly held: number;
    readonly missing: number;
  };
  readonly checkpointCounts: {
    readonly advance: number;
    readonly hold: number;
    readonly missing: number;
  };
  readonly dispatchTotals: {
    readonly attempted: number;
    readonly dispatched: number;
    readonly failed: number;
    readonly skippedPlanned: number;
  };
  readonly rates: {
    readonly ran: TraitSchedulerTickEvidenceRate;
    readonly leaseHeldSkip: TraitSchedulerTickEvidenceRate;
    readonly dispatchSuccess: TraitSchedulerTickEvidenceRate;
    readonly dispatchFailureFreeBatch: TraitSchedulerTickEvidenceRate;
    readonly checkpointAdvance: TraitSchedulerTickEvidenceRate;
  };
  readonly recency: {
    readonly firstRecordedAt?: string;
    readonly lastRecordedAt?: string;
    readonly lastRanRecordedAt?: string;
    readonly lastSkippedRecordedAt?: string;
  };
  readonly confidence: {
    readonly sampleSize: number;
    readonly minimumRecommendedRecords: typeof TRAIT_SCHEDULER_TICK_EVIDENCE_MIN_RECORDS_FOR_TREND;
    readonly sufficientForTrend: boolean;
    readonly summary: string;
  };
  readonly qualityScore: {
    readonly rubricVersion: typeof TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_RUBRIC_VERSION;
    readonly value: number;
    readonly max: 100;
    readonly summary: string;
    readonly components: readonly {
      readonly id: string;
      readonly weight: number;
      readonly rate: number;
      readonly contribution: number;
    }[];
  };
  readonly recommendations: readonly string[];
}

export interface TraitSchedulerTickEvidenceReport {
  readonly schemaVersion: typeof TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_SCHEMA_VERSION;
  readonly generatedAt?: string;
  readonly filter: TraitSchedulerTickEvidenceFilter;
  readonly replayAudit?: TraitSchedulerTickEvidenceReplayAudit;
  readonly method: {
    readonly primaryMetric: string;
    readonly guardrailMetrics: readonly string[];
    readonly minimumSampleGuidance: string;
    readonly scoringRubricVersion: typeof TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_RUBRIC_VERSION;
    readonly iterationLoop: readonly string[];
    readonly promotionRule: string;
  };
  readonly scorecard: TraitSchedulerTickEvidenceScorecard;
}

export interface TraitSchedulerTickEvidenceReportInput {
  readonly records: readonly TraitSchedulerTickEvidenceRecord[];
  readonly filter?: TraitSchedulerTickEvidenceFilter;
  readonly generatedAt?: string;
  readonly replayAudit?: TraitSchedulerTickEvidenceReplayAudit;
}

export type TraitSchedulerTickEvidenceWriteResult =
  | {
      readonly status: 'recorded';
      readonly record: TraitSchedulerTickEvidenceRecord;
    }
  | {
      readonly status: 'failed';
      readonly error: string;
    };

export interface RunTraitSchedulerTickOnceWithLeaseAndEvidenceOptions
  extends RunTraitSchedulerTickOnceWithLeaseOptions {
  readonly evidenceLedger: TraitSchedulerTickEvidenceLedger;
  readonly evidence?: Omit<TraitSchedulerTickEvidenceRecordInput, 'tick'>;
}

export interface TraitSchedulerTickOnceWithLeaseAndEvidenceResult {
  readonly tick: TraitSchedulerTickOnceWithLeaseResult;
  readonly evidence: TraitSchedulerTickEvidenceWriteResult;
}

const TRAIT_SCHEDULER_TICK_EVIDENCE_REPLAY_CHUNK_BYTES = 64 * 1024;

/**
 * Optional cross-process lease for host-invoked scheduler ticks.
 *
 * The lease is an atomic directory claim with a small JSON metadata file. It is
 * not a daemon and does not dispatch, reload environment variables, or deliver
 * Discord messages. Hosts choose the lease path and TTL. Evidence appends are
 * handled by the explicit ledger wrapper below, not by the lease itself.
 */
export class JsonFileTraitSchedulerTickLease implements TraitSchedulerTickLease {
  private readonly ownerId: string;
  private readonly ttlMs: number;
  private readonly clock: () => string;

  constructor(
    private readonly leasePath: string,
    options: JsonFileTraitSchedulerTickLeaseOptions = {},
  ) {
    this.ownerId = options.ownerId ?? `pid:${String(process.pid)}`;
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.clock = options.now ?? (() => new Date().toISOString());
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('Trait scheduler tick lease ttlMs must be a positive finite number.');
    }
  }

  acquire(): TraitSchedulerTickLeaseAcquireResult {
    const acquiredAt = requireLeaseInstantValue(this.clock(), 'lease acquiredAt');
    mkdirSync(dirname(this.leasePath), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        mkdirSync(this.leasePath);
        const lease = this.buildLease(acquiredAt);
        try {
          writeFileSync(this.metadataPath(), `${JSON.stringify(lease, null, 2)}\n`, 'utf8');
        } catch (error) {
          rmSync(this.leasePath, { recursive: true, force: true });
          throw error;
        }
        return {
          status: 'acquired',
          leasePath: this.leasePath,
          lease,
        };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          throw error;
        }
      }

      const existingLease = this.readExistingLease();
      if (existingLease !== undefined && leaseExpired(existingLease, acquiredAt)) {
        rmSync(this.leasePath, { recursive: true, force: true });
        continue;
      }
      return {
        status: 'held',
        leasePath: this.leasePath,
        observedAt: acquiredAt,
        ...(existingLease === undefined ? {} : { existingLease }),
      };
    }

    const existingLease = this.readExistingLease();
    return {
      status: 'held',
      leasePath: this.leasePath,
      observedAt: acquiredAt,
      ...(existingLease === undefined ? {} : { existingLease }),
    };
  }

  release(
    acquired: Extract<TraitSchedulerTickLeaseAcquireResult, { status: 'acquired' }>,
  ): void {
    const existingLease = this.readExistingLease();
    if (existingLease?.token !== acquired.lease.token) {
      return;
    }
    rmSync(this.leasePath, { recursive: true, force: true });
  }

  private buildLease(acquiredAt: string): TraitSchedulerTickLeaseMetadata {
    return {
      schemaVersion: TRAIT_SCHEDULER_TICK_LEASE_SCHEMA_VERSION,
      token: `${this.ownerId}:${String(process.pid)}:${String(Date.parse(acquiredAt))}:${Math.random()
        .toString(36)
        .slice(2)}`,
      ownerId: this.ownerId,
      acquiredAt,
      expiresAt: new Date(Date.parse(acquiredAt) + this.ttlMs).toISOString(),
    };
  }

  private metadataPath(): string {
    return join(this.leasePath, 'lease.json');
  }

  private readExistingLease(): TraitSchedulerTickLeaseMetadata | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.metadataPath(), 'utf8')) as unknown;
      return parseTraitSchedulerTickLeaseMetadata(parsed, this.metadataPath());
    } catch {
      return undefined;
    }
  }
}

/**
 * Runs one store-backed tick only after acquiring the caller-provided lease.
 * When the lease is held, no planner, dispatcher, or store write is invoked.
 */
export async function runTraitSchedulerTickOnceWithLease(
  options: RunTraitSchedulerTickOnceWithLeaseOptions,
): Promise<TraitSchedulerTickOnceWithLeaseResult> {
  const { lease, ...tickOptions } = options;
  const acquired = lease.acquire();
  if (acquired.status === 'held') {
    return {
      status: 'skipped',
      reason: 'lease-held',
      lease: acquired,
    };
  }

  try {
    return {
      status: 'ran',
      lease: acquired,
      result: await runTraitSchedulerTickOnceFromStores(tickOptions),
    };
  } finally {
    lease.release(acquired);
  }
}

/**
 * Host-facing helper that records one tick outcome to a caller-owned evidence
 * ledger. Evidence writes are best-effort: a ledger failure is reported beside
 * the tick result and never changes ran/skipped tick semantics.
 */
export async function runTraitSchedulerTickOnceWithLeaseAndEvidence(
  options: RunTraitSchedulerTickOnceWithLeaseAndEvidenceOptions,
): Promise<TraitSchedulerTickOnceWithLeaseAndEvidenceResult> {
  const { evidenceLedger, evidence, ...tickOptions } = options;
  const tick = await runTraitSchedulerTickOnceWithLease(tickOptions);
  try {
    return {
      tick,
      evidence: {
        status: 'recorded',
        record: evidenceLedger.append({
          ...(evidence ?? {}),
          tick,
        }),
      },
    };
  } catch (error) {
    return {
      tick,
      evidence: {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function createTraitSchedulerTickEvidenceRecord(
  input: TraitSchedulerTickEvidenceRecordInput,
): TraitSchedulerTickEvidenceRecord {
  const recordedAt =
    input.recordedAt === undefined
      ? new Date().toISOString()
      : requireLeaseInstantValue(input.recordedAt, 'evidence recordedAt');
  const recordBase = {
    schemaVersion: TRAIT_SCHEDULER_TICK_EVIDENCE_SCHEMA_VERSION,
    recordId: input.recordId ?? randomUUID(),
    recordedAt,
    ...(input.source === undefined ? {} : { source: input.source }),
  };

  if (isLeaseWrappedTickResult(input.tick)) {
    if (input.tick.status === 'skipped') {
      return {
        ...recordBase,
        status: 'skipped',
        reason: input.tick.reason,
        lease: summarizeLease(input.tick.lease),
      };
    }
    return {
      ...recordBase,
      status: 'ran',
      lease: summarizeLease(input.tick.lease),
      batch: summarizeTickEvidenceBatch(input.tick.result.batch),
    };
  }

  return {
    ...recordBase,
    status: 'ran',
    batch: summarizeTickEvidenceBatch(input.tick.batch),
  };
}

export function parseTraitSchedulerTickEvidenceRecord(
  raw: unknown,
): TraitSchedulerTickEvidenceRecord | undefined {
  if (!isPlainRecord(raw)) {
    return undefined;
  }
  if (raw['schemaVersion'] !== TRAIT_SCHEDULER_TICK_EVIDENCE_SCHEMA_VERSION) {
    return undefined;
  }
  const recordId = optionalNonEmptyString(raw['recordId']);
  const recordedAt = optionalInstant(raw['recordedAt']);
  const status = raw['status'];
  if (
    recordId === undefined ||
    recordedAt === undefined ||
    (status !== 'ran' && status !== 'skipped')
  ) {
    return undefined;
  }
  const source = optionalNonEmptyString(raw['source']);
  const reason = raw['reason'];
  const lease = parseTickEvidenceLease(raw['lease']);
  const batch = parseTickEvidenceBatch(raw['batch']);
  if (status === 'skipped' && reason !== 'lease-held') {
    return undefined;
  }
  if (status === 'ran' && batch === undefined) {
    return undefined;
  }
  return {
    schemaVersion: TRAIT_SCHEDULER_TICK_EVIDENCE_SCHEMA_VERSION,
    recordId,
    recordedAt,
    ...(source === undefined ? {} : { source }),
    status,
    ...(status === 'skipped' ? { reason: 'lease-held' } : {}),
    ...(lease === undefined ? {} : { lease }),
    ...(batch === undefined ? {} : { batch }),
  };
}

export class InMemoryTraitSchedulerTickEvidenceLedger
  implements TraitSchedulerTickEvidenceLedger {
  private readonly records: TraitSchedulerTickEvidenceRecord[] = [];

  append(input: TraitSchedulerTickEvidenceRecordInput): TraitSchedulerTickEvidenceRecord {
    const record = createTraitSchedulerTickEvidenceRecord(input);
    this.records.push(record);
    return record;
  }

  loadAll(): TraitSchedulerTickEvidenceRecord[] {
    return this.records.map((record) => cloneTickEvidenceRecord(record));
  }
}

export class JsonlTraitSchedulerTickEvidenceLedger
  implements TraitSchedulerTickEvidenceLedger {
  private readonly retentionRecords: number | undefined;

  constructor(
    private readonly filePath: string,
    options: JsonlTraitSchedulerTickEvidenceLedgerOptions = {},
  ) {
    this.retentionRecords = normalizeTickEvidenceRetentionRecords(
      options.retentionRecords,
    );
  }

  append(input: TraitSchedulerTickEvidenceRecordInput): TraitSchedulerTickEvidenceRecord {
    const record = createTraitSchedulerTickEvidenceRecord(input);
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    this.compactAfterAppend();
    return record;
  }

  loadAll(): TraitSchedulerTickEvidenceRecord[] {
    return [...this.loadWithAudit().records];
  }

  loadWithAudit(
    options: TraitSchedulerTickEvidenceReplayOptions = {},
  ): TraitSchedulerTickEvidenceReplayResult {
    if (!existsSync(this.filePath)) {
      return emptyTraitSchedulerTickEvidenceReplayResult();
    }
    const maxBytes = options.maxBytes;
    if (
      maxBytes !== undefined &&
      (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    ) {
      throw new Error(
        'Trait scheduler tick evidence replay maxBytes must be a positive safe integer.',
      );
    }
    return replayTraitSchedulerTickEvidenceJsonlFile(this.filePath, maxBytes);
  }

  private compactAfterAppend(): void {
    if (this.retentionRecords === undefined) {
      return;
    }
    const replay = this.loadWithAudit();
    const retainedRecords = replay.records.slice(-this.retentionRecords);
    const tmpPath = `${this.filePath}.tmp.${String(process.pid)}.${randomUUID()}`;
    const content =
      retainedRecords.length === 0
        ? ''
        : `${retainedRecords.map((record) => JSON.stringify(record)).join('\n')}\n`;
    try {
      writeFileSync(tmpPath, content, 'utf8');
      renameSync(tmpPath, this.filePath);
    } catch (error) {
      rmSync(tmpPath, { force: true });
      throw error;
    }
  }
}

function normalizeTickEvidenceRetentionRecords(
  value: number | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      'Trait scheduler tick evidence retentionRecords must be a positive safe integer.',
    );
  }
  return value;
}

export function filterTraitSchedulerTickEvidenceRecords(
  records: readonly TraitSchedulerTickEvidenceRecord[],
  filter: TraitSchedulerTickEvidenceFilter = {},
): TraitSchedulerTickEvidenceRecord[] {
  const filtered = records.filter((record) => {
    if (filter.status !== undefined && record.status !== filter.status) {
      return false;
    }
    if (filter.source !== undefined && record.source !== filter.source) {
      return false;
    }
    return true;
  });
  if (filter.limit === undefined) {
    return filtered;
  }
  return filtered.slice(Math.max(0, filtered.length - Math.max(0, filter.limit)));
}

export function buildTraitSchedulerTickEvidenceScorecard(
  records: readonly TraitSchedulerTickEvidenceRecord[],
): TraitSchedulerTickEvidenceScorecard {
  const parsedRecords = records.map((record) => cloneTickEvidenceRecord(record));
  const sourceCounts = buildTickEvidenceSourceCounts(parsedRecords);
  const recordCount = parsedRecords.length;
  const statusCounts = {
    ran: 0,
    skipped: 0,
  };
  const leaseCounts = {
    acquired: 0,
    held: 0,
    missing: 0,
  };
  const checkpointCounts = {
    advance: 0,
    hold: 0,
    missing: 0,
  };
  const dispatchTotals = {
    attempted: 0,
    dispatched: 0,
    failed: 0,
    skippedPlanned: 0,
  };
  let ranBatchCount = 0;
  let dispatchFailureFreeBatchCount = 0;
  let firstRecordedAt: string | undefined;
  let lastRecordedAt: string | undefined;
  let lastRanRecordedAt: string | undefined;
  let lastSkippedRecordedAt: string | undefined;

  for (const record of parsedRecords) {
    statusCounts[record.status] += 1;
    const leaseStatus = record.lease?.status;
    if (leaseStatus === 'acquired') {
      leaseCounts.acquired += 1;
    } else if (leaseStatus === 'held') {
      leaseCounts.held += 1;
    } else {
      leaseCounts.missing += 1;
    }

    firstRecordedAt = earliestInstant(firstRecordedAt, record.recordedAt);
    lastRecordedAt = latestInstant(lastRecordedAt, record.recordedAt);
    if (record.status === 'ran') {
      lastRanRecordedAt = latestInstant(lastRanRecordedAt, record.recordedAt);
    } else {
      lastSkippedRecordedAt = latestInstant(lastSkippedRecordedAt, record.recordedAt);
    }

    const batch = record.batch;
    if (batch === undefined) {
      checkpointCounts.missing += 1;
      continue;
    }
    ranBatchCount += 1;
    dispatchTotals.attempted += batch.attemptedCount;
    dispatchTotals.dispatched += batch.dispatchedCount;
    dispatchTotals.failed += batch.failedCount;
    dispatchTotals.skippedPlanned += batch.skippedPlannedCount;
    if (batch.failedCount === 0) {
      dispatchFailureFreeBatchCount += 1;
    }
    checkpointCounts[batch.checkpointStatus] += 1;
  }

  const rates = {
    ran: tickEvidenceRate(statusCounts.ran, recordCount),
    leaseHeldSkip: tickEvidenceRate(statusCounts.skipped, recordCount),
    dispatchSuccess: tickEvidenceRate(
      dispatchTotals.dispatched,
      dispatchTotals.attempted,
    ),
    dispatchFailureFreeBatch: tickEvidenceRate(
      dispatchFailureFreeBatchCount,
      ranBatchCount,
    ),
    checkpointAdvance: tickEvidenceRate(checkpointCounts.advance, ranBatchCount),
  };
  const evidenceVolumeRate = tickEvidenceRate(
    Math.min(
      recordCount,
      TRAIT_SCHEDULER_TICK_EVIDENCE_MIN_RECORDS_FOR_TREND,
    ),
    TRAIT_SCHEDULER_TICK_EVIDENCE_MIN_RECORDS_FOR_TREND,
  );
  const components = [
    {
      id: 'dispatch-failure-free-batch-rate',
      weight: 35,
      rate: ranBatchCount === 0 ? 1 : rates.dispatchFailureFreeBatch.rate,
      contribution: roundTickEvidenceScore(
        35 * (ranBatchCount === 0 ? 1 : rates.dispatchFailureFreeBatch.rate),
      ),
    },
    {
      id: 'checkpoint-advance-rate',
      weight: 25,
      rate: ranBatchCount === 0 ? 1 : rates.checkpointAdvance.rate,
      contribution: roundTickEvidenceScore(
        25 * (ranBatchCount === 0 ? 1 : rates.checkpointAdvance.rate),
      ),
    },
    {
      id: 'evidence-volume-rate',
      weight: 20,
      rate: evidenceVolumeRate.rate,
      contribution: roundTickEvidenceScore(20 * evidenceVolumeRate.rate),
    },
    {
      id: 'lease-contention-avoidance-rate',
      weight: 10,
      rate: roundTickEvidenceScore(1 - rates.leaseHeldSkip.rate),
      contribution: roundTickEvidenceScore(10 * (1 - rates.leaseHeldSkip.rate)),
    },
    {
      id: 'record-shape-completeness-rate',
      weight: 10,
      rate: tickEvidenceRecordShapeCompletenessRate(parsedRecords).rate,
      contribution: roundTickEvidenceScore(
        10 * tickEvidenceRecordShapeCompletenessRate(parsedRecords).rate,
      ),
    },
  ] as const;
  const qualityScoreValue = roundTickEvidenceScore(
    components.reduce((total, component) => total + component.contribution, 0),
  );
  const sufficientForTrend =
    recordCount >= TRAIT_SCHEDULER_TICK_EVIDENCE_MIN_RECORDS_FOR_TREND;

  return {
    schemaVersion: TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_SCHEMA_VERSION,
    recordCount,
    sourceCounts,
    statusCounts,
    leaseCounts,
    checkpointCounts,
    dispatchTotals,
    rates,
    recency: {
      ...(firstRecordedAt === undefined ? {} : { firstRecordedAt }),
      ...(lastRecordedAt === undefined ? {} : { lastRecordedAt }),
      ...(lastRanRecordedAt === undefined ? {} : { lastRanRecordedAt }),
      ...(lastSkippedRecordedAt === undefined ? {} : { lastSkippedRecordedAt }),
    },
    confidence: {
      sampleSize: recordCount,
      minimumRecommendedRecords: TRAIT_SCHEDULER_TICK_EVIDENCE_MIN_RECORDS_FOR_TREND,
      sufficientForTrend,
      summary: sufficientForTrend
        ? `Sample has ${String(recordCount)} tick evidence record(s), meeting the minimum recommendation for trend review.`
        : `Sample has ${String(recordCount)} tick evidence record(s); collect at least ${String(TRAIT_SCHEDULER_TICK_EVIDENCE_MIN_RECORDS_FOR_TREND)} before treating scheduler reliability trends as stable.`,
    },
    qualityScore: {
      rubricVersion: TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_RUBRIC_VERSION,
      value: qualityScoreValue,
      max: 100,
      summary:
        recordCount === 0
          ? 'No TraitModule scheduler tick evidence records were available for scoring.'
          : `Weighted TraitModule scheduler tick evidence score ${String(qualityScoreValue)}/100 over ${String(recordCount)} record(s).`,
      components,
    },
    recommendations: buildTickEvidenceRecommendations({
      recordCount,
      dispatchTotals,
      checkpointCounts,
      rates,
      sufficientForTrend,
    }),
  };
}

export function buildTraitSchedulerTickEvidenceReport(
  input: TraitSchedulerTickEvidenceReportInput,
): TraitSchedulerTickEvidenceReport {
  const filter = input.filter ?? {};
  const scopedRecords = filterTraitSchedulerTickEvidenceRecords(input.records, filter);
  const scorecard = buildTraitSchedulerTickEvidenceScorecard(scopedRecords);
  return {
    schemaVersion: TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_SCHEMA_VERSION,
    ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
    filter,
    ...(input.replayAudit === undefined ? {} : { replayAudit: input.replayAudit }),
    method: {
      primaryMetric:
        'weighted qualityScore: dispatch failure-free batch 35 + checkpoint advance 25 + evidence volume 20 + low lease contention 10 + record shape completeness 10',
      guardrailMetrics: [
        'dispatch failed count should remain zero',
        'checkpoint hold count should be investigated before advancing reliability claims',
        'lease-held skip rate should stay low for single-host scheduler loops',
        'sample size should be at least 5 tick evidence records before trend claims',
      ],
      minimumSampleGuidance:
        `Use at least ${String(TRAIT_SCHEDULER_TICK_EVIDENCE_MIN_RECORDS_FOR_TREND)} recorded ticks before treating score changes as stable; smaller samples are reported but marked insufficient for trend review.`,
      scoringRubricVersion: TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_RUBRIC_VERSION,
      iterationLoop: [
        'Run explicit host-invoked scheduler ticks with the optional lease wrapper.',
        'Append each ran/skipped tick to the caller-owned JSONL evidence ledger.',
        'Generate this read-only report over the ledger after bounded batches.',
        'Investigate dispatch failures, checkpoint holds, or lease contention before promoting a scheduler configuration.',
      ],
      promotionRule:
        'treat qualityScore as trend evidence only when sample size is sufficient, dispatch failures are zero, checkpoint holds are explained, and lease contention does not indicate overlapping tick sources.',
    },
    scorecard:
      input.replayAudit === undefined ||
      input.replayAudit.skippedMalformedLineCount === 0
        ? scorecard
        : {
            ...scorecard,
            recommendations: [
              `Review ${String(input.replayAudit.skippedMalformedLineCount)} malformed/torn JSONL line(s); they were excluded from scoring.`,
              ...scorecard.recommendations,
            ],
          },
  };
}

interface TraitSchedulerTickEvidenceReplayAccumulator {
  readonly records: TraitSchedulerTickEvidenceRecord[];
  totalLineCount: number;
  emptyLineCount: number;
  skippedMalformedLineCount: number;
}

function emptyTraitSchedulerTickEvidenceReplayResult(): TraitSchedulerTickEvidenceReplayResult {
  return {
    records: [],
    replayAudit: {
      source: 'jsonl',
      totalLineCount: 0,
      emptyLineCount: 0,
      parsedRecordCount: 0,
      skippedMalformedLineCount: 0,
    },
  };
}

function replayTraitSchedulerTickEvidenceJsonlFile(
  filePath: string,
  maxBytes: number | undefined,
): TraitSchedulerTickEvidenceReplayResult {
  const fileDescriptor = openSync(filePath, 'r');
  const buffer = Buffer.alloc(
    TRAIT_SCHEDULER_TICK_EVIDENCE_REPLAY_CHUNK_BYTES,
  );
  const decoder = new TextDecoder('utf-8');
  const accumulator: TraitSchedulerTickEvidenceReplayAccumulator = {
    records: [],
    totalLineCount: 0,
    emptyLineCount: 0,
    skippedMalformedLineCount: 0,
  };
  let bytesReadTotal = 0;
  let pendingLine = '';

  try {
    for (;;) {
      const bytesToRead = replayBytesToRead(
        buffer.byteLength,
        bytesReadTotal,
        maxBytes,
      );
      const bytesRead = readSync(fileDescriptor, buffer, 0, bytesToRead, null);
      if (bytesRead === 0) {
        break;
      }
      bytesReadTotal += bytesRead;
      if (maxBytes !== undefined && bytesReadTotal > maxBytes) {
        throw new Error(
          `Trait scheduler tick evidence ledger exceeds maxBytes: ${String(bytesReadTotal)} > ${String(maxBytes)}.`,
        );
      }
      pendingLine = replayTraitSchedulerTickEvidenceTextChunk(
        accumulator,
        `${pendingLine}${decoder.decode(buffer.subarray(0, bytesRead), {
          stream: true,
        })}`,
      );
    }

    const finalDecodedText = decoder.decode();
    if (finalDecodedText.length > 0) {
      pendingLine = replayTraitSchedulerTickEvidenceTextChunk(
        accumulator,
        `${pendingLine}${finalDecodedText}`,
      );
    }
    if (pendingLine.length > 0) {
      replayTraitSchedulerTickEvidenceLine(accumulator, pendingLine);
    }

    return {
      records: accumulator.records,
      replayAudit: {
        source: 'jsonl',
        totalLineCount: accumulator.totalLineCount,
        emptyLineCount: accumulator.emptyLineCount,
        parsedRecordCount: accumulator.records.length,
        skippedMalformedLineCount: accumulator.skippedMalformedLineCount,
      },
    };
  } finally {
    closeSync(fileDescriptor);
  }
}

function replayBytesToRead(
  bufferBytes: number,
  bytesReadTotal: number,
  maxBytes: number | undefined,
): number {
  if (maxBytes === undefined) {
    return bufferBytes;
  }
  const remainingAllowedBytes = maxBytes - bytesReadTotal;
  return Math.min(bufferBytes, remainingAllowedBytes + 1);
}

function replayTraitSchedulerTickEvidenceTextChunk(
  accumulator: TraitSchedulerTickEvidenceReplayAccumulator,
  text: string,
): string {
  const physicalLines = text.split('\n');
  const pendingLine = physicalLines[physicalLines.length - 1] ?? '';
  for (const physicalLine of physicalLines.slice(0, -1)) {
    replayTraitSchedulerTickEvidenceLine(
      accumulator,
      stripJsonlLineFeedCarriageReturn(physicalLine),
    );
  }
  return pendingLine;
}

function stripJsonlLineFeedCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function replayTraitSchedulerTickEvidenceLine(
  accumulator: TraitSchedulerTickEvidenceReplayAccumulator,
  line: string,
): void {
  accumulator.totalLineCount += 1;
  if (line.trim().length === 0) {
    accumulator.emptyLineCount += 1;
    return;
  }
  try {
    const parsed = parseTraitSchedulerTickEvidenceRecord(JSON.parse(line));
    if (parsed !== undefined) {
      accumulator.records.push(parsed);
    } else {
      accumulator.skippedMalformedLineCount += 1;
    }
  } catch {
    accumulator.skippedMalformedLineCount += 1;
    // Skip torn or malformed JSONL records during replay.
  }
}

/**
 * Serializes explicit one-shot ticks inside a single Node.js process.
 *
 * This is intentionally not a daemon and not a cross-process lock. It only
 * prevents overlapping calls made through the same runner instance, so the next
 * tick reloads the cursor after the prior tick has saved its checkpoint advice.
 */
export class InProcessTraitSchedulerTickOnceRunner {
  /**
   * Release-sentinel chain only. It is deliberately not assigned to a tick's
   * result promise, so one rejected tick does not poison the next queued tick.
   */
  private tail: Promise<void> = Promise.resolve();

  async run(
    options: RunTraitSchedulerTickOnceFromStoresOptions,
  ): Promise<TraitSchedulerTickOnceResult> {
    const previous = this.tail;
    let releaseNext: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });

    await previous;
    try {
      return await runTraitSchedulerTickOnceFromStores(options);
    } finally {
      releaseNext();
    }
  }
}

/**
 * One explicit operator-owned scheduler tick. This composes planning,
 * host-callback dispatch, and conservative cursor application without creating
 * a daemon, lock, environment reload, ledger writer, or Discord delivery path.
 */
export async function runTraitSchedulerTickOnce(
  options: RunTraitSchedulerTickOnceOptions,
): Promise<TraitSchedulerTickOnceResult> {
  const planOptions: PlanTraitSchedulerTickOptions = {
    state: options.state,
    ...(options.cursor.lastTickAt === undefined
      ? {}
      : { lastTickAt: options.cursor.lastTickAt }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxDueJobs === undefined ? {} : { maxDueJobs: options.maxDueJobs }),
    ...(options.maxLookbackMinutes === undefined
      ? {}
      : { maxLookbackMinutes: options.maxLookbackMinutes }),
    ...(options.observeHooks === undefined ? {} : { observeHooks: options.observeHooks }),
  };
  const plan = planTraitSchedulerTick(planOptions);
  const batch = await runTraitSchedulerDueJobs({
    plan,
    dispatch: options.dispatch,
    ...(options.dispatchClock === undefined ? {} : { now: options.dispatchClock }),
  });
  const nextCursor = applyTraitSchedulerDispatchCheckpoint(options.cursor, batch);
  return {
    plan,
    batch,
    previousCursor: options.cursor,
    nextCursor,
  };
}

/**
 * Store-backed one-shot tick. The caller still owns when this function is
 * invoked; this helper only loads state/cursor, runs one tick, and saves the
 * resulting cursor advice.
 */
export async function runTraitSchedulerTickOnceFromStores(
  options: RunTraitSchedulerTickOnceFromStoresOptions,
): Promise<TraitSchedulerTickOnceResult> {
  const cursor = options.cursorStore.load();
  const state = options.schedulerStore.load();
  const result = await runTraitSchedulerTickOnce({
    state,
    cursor,
    dispatch: options.dispatch,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxDueJobs === undefined ? {} : { maxDueJobs: options.maxDueJobs }),
    ...(options.maxLookbackMinutes === undefined
      ? {}
      : { maxLookbackMinutes: options.maxLookbackMinutes }),
    ...(options.observeHooks === undefined ? {} : { observeHooks: options.observeHooks }),
    ...(options.dispatchClock === undefined
      ? {}
      : { dispatchClock: options.dispatchClock }),
  });
  options.cursorStore.save(result.nextCursor);
  return result;
}

function buildCheckpoint(
  plan: TraitSchedulerTickPlan,
  failedCount: number,
): TraitSchedulerDispatchCheckpoint {
  const reasons: ('dispatch-failed' | 'plan-truncated')[] = [];
  if (failedCount > 0) {
    reasons.push('dispatch-failed');
  }
  if (plan.truncated) {
    reasons.push('plan-truncated');
  }
  if (reasons.length > 0) {
    return { status: 'hold', reason: reasons[0] ?? 'dispatch-failed', reasons };
  }
  return { status: 'advance', lastTickAt: plan.windowEndInclusive };
}

function summarizeBatch(
  batch: TraitSchedulerDispatchBatchResult,
): TraitSchedulerCursorBatchSummary {
  return {
    planTickedAt: batch.planTickedAt,
    attemptedCount: batch.attemptedCount,
    dispatchedCount: batch.dispatchedCount,
    failedCount: batch.failedCount,
    skippedPlannedCount: batch.skippedPlannedCount,
    truncated: batch.truncated,
  };
}

function outcomeBase(
  dueJob: TraitSchedulerDueJob,
  observedAt: string,
): TraitSchedulerDispatchOutcomeBase {
  return {
    runId: dueJob.runId,
    jobId: dueJob.job.jobId,
    moduleId: dueJob.job.moduleId,
    moduleVersion: dueJob.job.moduleVersion,
    scheduleId: dueJob.job.scheduleId,
    dueAt: dueJob.dueAt,
    summary: dueJob.summary,
    deliveryTarget: cloneDeliveryTarget(dueJob.deliveryTarget),
    observedAt,
  };
}

function cloneDueJob(dueJob: TraitSchedulerDueJob): TraitSchedulerDueJob {
  return {
    job: cloneJob(dueJob.job),
    dueAt: dueJob.dueAt,
    runId: dueJob.runId,
    deliveryTarget: cloneDeliveryTarget(dueJob.deliveryTarget),
    summary: dueJob.summary,
  };
}

function cloneJob(job: TraitSchedulerJobRecord): TraitSchedulerJobRecord {
  return {
    ...job,
    deliveryTarget: cloneDeliveryTarget(job.deliveryTarget),
  };
}

function cloneDeliveryTarget(
  target: TraitScheduleDeliveryTarget,
): TraitScheduleDeliveryTarget {
  switch (target.kind) {
    case 'main-session':
    case 'current-session':
      return { kind: target.kind, sessionId: target.sessionId };
    case 'isolated-session':
      return { kind: 'isolated-session', sessionKey: target.sessionKey };
    default: {
      const exhausted: never = target;
      return exhausted;
    }
  }
}

function parseTraitSchedulerTickCursorState(
  value: unknown,
  filePath: string,
): TraitSchedulerTickCursorState {
  const record = requireCursorRecord(value, 'cursor state', filePath);
  if (record['schemaVersion'] !== TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION) {
    throw new Error(
      `Trait scheduler cursor schemaVersion must be 1 at ${filePath}.`,
    );
  }
  const updatedAt = requireCursorInstant(record, 'updatedAt', filePath);
  const lastTickAt =
    record['lastTickAt'] === undefined
      ? undefined
      : requireCursorInstant(record, 'lastTickAt', filePath);
  const lastHoldReasons =
    record['lastHoldReasons'] === undefined
      ? undefined
      : parseHoldReasons(record['lastHoldReasons'], filePath);
  const lastBatch =
    record['lastBatch'] === undefined
      ? undefined
      : parseCursorBatchSummary(record['lastBatch'], filePath);
  return {
    schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
    updatedAt,
    ...(lastTickAt === undefined ? {} : { lastTickAt }),
    ...(lastHoldReasons === undefined ? {} : { lastHoldReasons }),
    ...(lastBatch === undefined ? {} : { lastBatch }),
  };
}

function parseCursorBatchSummary(
  value: unknown,
  filePath: string,
): TraitSchedulerCursorBatchSummary {
  const record = requireCursorRecord(value, 'lastBatch', filePath);
  return {
    planTickedAt: requireCursorInstant(record, 'planTickedAt', `${filePath} lastBatch`),
    attemptedCount: requireCursorNonNegativeInteger(
      record,
      'attemptedCount',
      `${filePath} lastBatch`,
    ),
    dispatchedCount: requireCursorNonNegativeInteger(
      record,
      'dispatchedCount',
      `${filePath} lastBatch`,
    ),
    failedCount: requireCursorNonNegativeInteger(
      record,
      'failedCount',
      `${filePath} lastBatch`,
    ),
    skippedPlannedCount: requireCursorNonNegativeInteger(
      record,
      'skippedPlannedCount',
      `${filePath} lastBatch`,
    ),
    truncated: requireCursorBoolean(record, 'truncated', `${filePath} lastBatch`),
  };
}

function parseHoldReasons(
  value: unknown,
  filePath: string,
): readonly TraitSchedulerCursorHoldReason[] {
  if (!Array.isArray(value)) {
    throw new Error(`Trait scheduler cursor lastHoldReasons must be an array at ${filePath}.`);
  }
  const parsed: TraitSchedulerCursorHoldReason[] = [];
  for (const [index, entry] of (value as unknown[]).entries()) {
    if (entry === 'dispatch-failed' || entry === 'plan-truncated') {
      parsed.push(entry);
      continue;
    }
    throw new Error(
      `Trait scheduler cursor lastHoldReasons[${String(index)}] is invalid at ${filePath}.`,
    );
  }
  return parsed;
}

function requireCursorRecord(
  value: unknown,
  label: string,
  filePath: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Trait scheduler cursor ${label} must be an object at ${filePath}.`);
  }
  return value as Record<string, unknown>;
}

function requireCursorInstant(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || !ISO_INSTANT_WITH_ZONE_PATTERN.test(value)) {
    throw new Error(
      `Trait scheduler cursor ${key} must be an ISO-8601 instant with timezone at ${context}.`,
    );
  }
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(
      `Trait scheduler cursor ${key} must be a valid ISO-8601 instant at ${context}.`,
    );
  }
  return value;
}

function requireCursorNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  context: string,
): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`Trait scheduler cursor ${key} must be a non-negative integer at ${context}.`);
  }
  return value as number;
}

function requireCursorBoolean(
  record: Record<string, unknown>,
  key: string,
  context: string,
): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new Error(`Trait scheduler cursor ${key} must be a boolean at ${context}.`);
  }
  return value;
}

function tickEvidenceRate(
  numerator: number,
  denominator: number,
): TraitSchedulerTickEvidenceRate {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? 0 : roundTickEvidenceScore(numerator / denominator),
  };
}

function roundTickEvidenceScore(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function buildTickEvidenceSourceCounts(
  records: readonly TraitSchedulerTickEvidenceRecord[],
): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const source = record.source ?? '(unspecified)';
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function earliestInstant(current: string | undefined, candidate: string): string {
  if (current === undefined) {
    return candidate;
  }
  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

function latestInstant(
  current: string | undefined,
  candidate: string,
): string {
  if (current === undefined) {
    return candidate;
  }
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

function tickEvidenceRecordShapeCompletenessRate(
  records: readonly TraitSchedulerTickEvidenceRecord[],
): TraitSchedulerTickEvidenceRate {
  const completeCount = records.filter((record) => {
    if (record.status === 'ran') {
      return record.batch !== undefined;
    }
    return record.reason === 'lease-held' && record.lease?.status === 'held';
  }).length;
  return tickEvidenceRate(completeCount, records.length);
}

function buildTickEvidenceRecommendations(input: {
  readonly recordCount: number;
  readonly dispatchTotals: TraitSchedulerTickEvidenceScorecard['dispatchTotals'];
  readonly checkpointCounts: TraitSchedulerTickEvidenceScorecard['checkpointCounts'];
  readonly rates: TraitSchedulerTickEvidenceScorecard['rates'];
  readonly sufficientForTrend: boolean;
}): readonly string[] {
  const recommendations: string[] = [];
  if (!input.sufficientForTrend) {
    recommendations.push(
      `Collect at least ${String(TRAIT_SCHEDULER_TICK_EVIDENCE_MIN_RECORDS_FOR_TREND)} tick evidence records before treating scheduler reliability trends as stable.`,
    );
  }
  if (input.dispatchTotals.failed > 0) {
    recommendations.push(
      'Investigate dispatcher failures before advancing scheduler reliability claims.',
    );
  }
  if (input.checkpointCounts.hold > 0) {
    recommendations.push(
      'Review checkpoint hold reasons; held batches keep the prior cursor by design.',
    );
  }
  if (input.rates.leaseHeldSkip.rate > 0.2) {
    recommendations.push(
      'Lease-held skips are frequent; reduce overlapping tick sources or share an in-process runner where possible.',
    );
  }
  if (input.recordCount === 0) {
    recommendations.push(
      'No scheduler tick evidence records are available; run explicit host-invoked ticks with evidence enabled.',
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      'Evidence quality is sufficient for read-only trend review; keep daemon, delivery, and backup-rotation decisions operator-owned.',
    );
  }
  return recommendations;
}

function isLeaseWrappedTickResult(
  tick: TraitSchedulerTickOnceWithLeaseResult | TraitSchedulerTickOnceResult,
): tick is TraitSchedulerTickOnceWithLeaseResult {
  return (
    typeof tick === 'object' &&
    tick !== null &&
    'status' in tick &&
    ((tick as { readonly status?: unknown }).status === 'ran' ||
      (tick as { readonly status?: unknown }).status === 'skipped')
  );
}

function summarizeLease(
  lease: TraitSchedulerTickLeaseAcquireResult,
): TraitSchedulerTickEvidenceLeaseSummary {
  if (lease.status === 'acquired') {
    return {
      status: 'acquired',
      leasePath: lease.leasePath,
      ownerId: lease.lease.ownerId,
      acquiredAt: lease.lease.acquiredAt,
      expiresAt: lease.lease.expiresAt,
    };
  }

  return {
    status: 'held',
    leasePath: lease.leasePath,
    observedAt: lease.observedAt,
    ...(lease.existingLease === undefined
      ? {}
      : {
          ownerId: lease.existingLease.ownerId,
          acquiredAt: lease.existingLease.acquiredAt,
          expiresAt: lease.existingLease.expiresAt,
        }),
  };
}

function summarizeTickEvidenceBatch(
  batch: TraitSchedulerDispatchBatchResult,
): TraitSchedulerTickEvidenceBatchSummary {
  return {
    planTickedAt: batch.planTickedAt,
    windowStartExclusive: batch.windowStartExclusive,
    windowEndInclusive: batch.windowEndInclusive,
    attemptedCount: batch.attemptedCount,
    dispatchedCount: batch.dispatchedCount,
    failedCount: batch.failedCount,
    skippedPlannedCount: batch.skippedPlannedCount,
    truncated: batch.truncated,
    checkpointStatus: batch.checkpoint.status,
    ...(batch.checkpoint.status === 'advance'
      ? { checkpointLastTickAt: batch.checkpoint.lastTickAt }
      : { checkpointHoldReasons: batch.checkpoint.reasons }),
  };
}

function parseTickEvidenceLease(
  value: unknown,
): TraitSchedulerTickEvidenceLeaseSummary | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const status = value['status'];
  const leasePath = optionalNonEmptyString(value['leasePath']);
  if ((status !== 'acquired' && status !== 'held') || leasePath === undefined) {
    return undefined;
  }
  const ownerId = optionalNonEmptyString(value['ownerId']);
  const acquiredAt = optionalInstant(value['acquiredAt']);
  const expiresAt = optionalInstant(value['expiresAt']);
  const observedAt = optionalInstant(value['observedAt']);
  return {
    status,
    leasePath,
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(acquiredAt === undefined ? {} : { acquiredAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(observedAt === undefined ? {} : { observedAt }),
  };
}

function parseTickEvidenceBatch(
  value: unknown,
): TraitSchedulerTickEvidenceBatchSummary | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const planTickedAt = optionalInstant(value['planTickedAt']);
  const windowStartExclusive = optionalInstant(value['windowStartExclusive']);
  const windowEndInclusive = optionalInstant(value['windowEndInclusive']);
  const attemptedCount = optionalNonNegativeInteger(value['attemptedCount']);
  const dispatchedCount = optionalNonNegativeInteger(value['dispatchedCount']);
  const failedCount = optionalNonNegativeInteger(value['failedCount']);
  const skippedPlannedCount = optionalNonNegativeInteger(value['skippedPlannedCount']);
  const truncated = value['truncated'];
  const checkpointStatus = value['checkpointStatus'];
  if (
    planTickedAt === undefined ||
    windowStartExclusive === undefined ||
    windowEndInclusive === undefined ||
    attemptedCount === undefined ||
    dispatchedCount === undefined ||
    failedCount === undefined ||
    skippedPlannedCount === undefined ||
    typeof truncated !== 'boolean' ||
    (checkpointStatus !== 'advance' && checkpointStatus !== 'hold')
  ) {
    return undefined;
  }
  const checkpointLastTickAt = optionalInstant(value['checkpointLastTickAt']);
  let checkpointHoldReasons: readonly TraitSchedulerCursorHoldReason[] | undefined;
  try {
    checkpointHoldReasons =
      value['checkpointHoldReasons'] === undefined
        ? undefined
        : parseHoldReasons(value['checkpointHoldReasons'], 'tick evidence');
  } catch {
    return undefined;
  }
  if (checkpointStatus === 'advance' && checkpointLastTickAt === undefined) {
    return undefined;
  }
  if (
    checkpointStatus === 'hold' &&
    (checkpointHoldReasons === undefined || checkpointHoldReasons.length === 0)
  ) {
    return undefined;
  }
  return {
    planTickedAt,
    windowStartExclusive,
    windowEndInclusive,
    attemptedCount,
    dispatchedCount,
    failedCount,
    skippedPlannedCount,
    truncated,
    checkpointStatus,
    ...(checkpointLastTickAt === undefined ? {} : { checkpointLastTickAt }),
    ...(checkpointHoldReasons === undefined ? {} : { checkpointHoldReasons }),
  };
}

function cloneTickEvidenceRecord(
  record: TraitSchedulerTickEvidenceRecord,
): TraitSchedulerTickEvidenceRecord {
  return JSON.parse(JSON.stringify(record)) as TraitSchedulerTickEvidenceRecord;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalInstant(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (!ISO_INSTANT_WITH_ZONE_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    return undefined;
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function parseTraitSchedulerTickLeaseMetadata(
  value: unknown,
  filePath: string,
): TraitSchedulerTickLeaseMetadata {
  const record = requireCursorRecord(value, 'lease metadata', filePath);
  if (record['schemaVersion'] !== TRAIT_SCHEDULER_TICK_LEASE_SCHEMA_VERSION) {
    throw new Error(
      `Trait scheduler tick lease schemaVersion must be 1 at ${filePath}.`,
    );
  }
  const token = requireLeaseString(record, 'token', filePath);
  const ownerId = requireLeaseString(record, 'ownerId', filePath);
  return {
    schemaVersion: TRAIT_SCHEDULER_TICK_LEASE_SCHEMA_VERSION,
    token,
    ownerId,
    acquiredAt: requireLeaseInstant(record, 'acquiredAt', filePath),
    expiresAt: requireLeaseInstant(record, 'expiresAt', filePath),
  };
}

function requireLeaseString(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Trait scheduler tick lease ${key} must be a non-empty string at ${context}.`);
  }
  return value;
}

function requireLeaseInstant(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`Trait scheduler tick lease ${key} must be a string at ${context}.`);
  }
  return requireLeaseInstantValue(value, `lease ${key} at ${context}`);
}

function requireLeaseInstantValue(value: string, context: string): string {
  if (!ISO_INSTANT_WITH_ZONE_PATTERN.test(value)) {
    throw new Error(
      `Trait scheduler tick ${context} must be an ISO-8601 instant with timezone.`,
    );
  }
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Trait scheduler tick ${context} must be a valid ISO-8601 instant.`);
  }
  return value;
}

function leaseExpired(
  lease: TraitSchedulerTickLeaseMetadata,
  observedAt: string,
): boolean {
  return Date.parse(lease.expiresAt) <= Date.parse(observedAt);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

const ISO_INSTANT_WITH_ZONE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
