import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TRAIT_SCHEDULER_STATE_SCHEMA_VERSION,
  type TraitSchedulerJobRecord,
  type TraitSchedulerState,
} from '../src/core/trait-module-loader.js';
import {
  buildTraitSchedulerRunId,
  planTraitSchedulerTick,
} from '../src/cron/trait-scheduler-tick.js';
import {
  applyTraitSchedulerDispatchCheckpoint,
  buildTraitSchedulerTickEvidenceReport,
  InProcessTraitSchedulerTickOnceRunner,
  InMemoryTraitSchedulerTickEvidenceLedger,
  JsonFileTraitSchedulerTickLease,
  JsonlTraitSchedulerTickEvidenceLedger,
  JsonFileTraitSchedulerCursorStore,
  filterTraitSchedulerTickEvidenceRecords,
  runTraitSchedulerDueJobs,
  runTraitSchedulerTickOnce,
  runTraitSchedulerTickOnceFromStores,
  runTraitSchedulerTickOnceWithLeaseAndEvidence,
  runTraitSchedulerTickOnceWithLease,
  TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
  TRAIT_SCHEDULER_TICK_EVIDENCE_MIN_RECORDS_FOR_TREND,
  TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_RUBRIC_VERSION,
  type RunTraitSchedulerTickOnceFromStoresOptions,
  type TraitSchedulerTickEvidenceLedger,
  type TraitSchedulerTickEvidenceRecord,
  type TraitSchedulerTickEvidenceReplayAudit,
  type TraitSchedulerTickCursorState,
} from '../src/cron/trait-scheduler-dispatch-runner.js';

function job(overrides: Partial<TraitSchedulerJobRecord> = {}): TraitSchedulerJobRecord {
  return {
    schemaVersion: TRAIT_SCHEDULER_STATE_SCHEMA_VERSION,
    jobId: 'trait.test.example.v1:1.0.0:daily',
    moduleId: 'trait.test.example.v1',
    moduleVersion: '1.0.0',
    scheduleId: 'daily',
    cron: '0 9 * * *',
    timezone: 'UTC',
    delivery: 'main-session',
    deliveryTarget: { kind: 'main-session', sessionId: 'main-session' },
    summary: 'daily review',
    state: 'scheduled',
    maxRetries: 3,
    retentionDays: 30,
    createdAt: '2026-05-05T00:00:00.000Z',
    updatedAt: '2026-05-05T00:00:00.000Z',
    ...overrides,
  };
}

function state(jobs: readonly TraitSchedulerJobRecord[]): TraitSchedulerState {
  return {
    schemaVersion: TRAIT_SCHEDULER_STATE_SCHEMA_VERSION,
    updatedAt: '2026-05-05T00:00:00.000Z',
    jobs,
  };
}

function tickEvidenceRecord(
  overrides: Partial<TraitSchedulerTickEvidenceRecord> = {},
): TraitSchedulerTickEvidenceRecord {
  return {
    schemaVersion: 1,
    recordId: 'tick-record',
    recordedAt: '2026-05-05T09:00:32.000Z',
    source: 'unit-test',
    status: 'ran',
    lease: {
      status: 'acquired',
      leasePath: '/tmp/auto-archive/tick.lock',
      ownerId: 'runner',
      acquiredAt: '2026-05-05T09:00:00.000Z',
      expiresAt: '2026-05-05T09:01:00.000Z',
    },
    batch: {
      planTickedAt: '2026-05-05T09:00:30.000Z',
      windowStartExclusive: '2026-05-05T08:59:00.000Z',
      windowEndInclusive: '2026-05-05T09:00:00.000Z',
      attemptedCount: 1,
      dispatchedCount: 1,
      failedCount: 0,
      skippedPlannedCount: 0,
      truncated: false,
      checkpointStatus: 'advance',
      checkpointLastTickAt: '2026-05-05T09:00:00.000Z',
    },
    ...overrides,
  };
}

function expectReplayAuditInvariant(
  replayAudit: TraitSchedulerTickEvidenceReplayAudit,
): void {
  expect(replayAudit.totalLineCount).toBe(
    replayAudit.emptyLineCount +
      replayAudit.parsedRecordCount +
      replayAudit.skippedMalformedLineCount,
  );
}

const TRAIT_SCHEDULER_TICK_EVIDENCE_REPLAY_TEST_CHUNK_BYTES = 64 * 1024;

function tickEvidenceJsonWithPaddedSource(
  targetByteLength: number,
  recordId: string,
  sourcePrefix: string,
  sourceSuffix = '',
): {
  readonly record: TraitSchedulerTickEvidenceRecord;
  readonly json: string;
} {
  const baseRecord = tickEvidenceRecord({
    recordId,
    source: `${sourcePrefix}${sourceSuffix}`,
  });
  const baseJson = JSON.stringify(baseRecord);
  const paddingBytes = targetByteLength - Buffer.byteLength(baseJson, 'utf8');
  if (paddingBytes < 0) {
    throw new Error('targetByteLength is too small for padded tick evidence');
  }
  const record = tickEvidenceRecord({
    recordId,
    source: `${sourcePrefix}${'x'.repeat(paddingBytes)}${sourceSuffix}`,
  });
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json, 'utf8') !== targetByteLength) {
    throw new Error('padded tick evidence length mismatch');
  }
  return { record, json };
}

function tickEvidenceJsonWithUtf8MarkerAtByteIndex(
  targetByteIndex: number,
): {
  readonly marker: string;
  readonly record: TraitSchedulerTickEvidenceRecord;
  readonly json: string;
} {
  const marker = '界';
  const markerBytes = Buffer.from(marker, 'utf8');
  const baseRecord = tickEvidenceRecord({
    recordId: 'utf8-split-record',
    source: `utf8-${marker}`,
  });
  const baseMarkerByteIndex = Buffer.from(
    JSON.stringify(baseRecord),
    'utf8',
  ).indexOf(markerBytes);
  const paddingBytes = targetByteIndex - baseMarkerByteIndex;
  if (paddingBytes < 0) {
    throw new Error('targetByteIndex is too small for UTF-8 marker evidence');
  }
  const record = tickEvidenceRecord({
    recordId: 'utf8-split-record',
    source: `utf8-${'x'.repeat(paddingBytes)}${marker}`,
  });
  const json = JSON.stringify(record);
  const markerByteIndex = Buffer.from(json, 'utf8').indexOf(markerBytes);
  if (markerByteIndex !== targetByteIndex) {
    throw new Error('UTF-8 marker byte index mismatch');
  }
  return { marker, record, json };
}

function fixedClock(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    if (value === undefined) throw new Error('fixed clock requires values');
    return value;
  };
}

describe('TraitModule scheduler one-shot tick planner', () => {
  it('selects a UTC cron job due within the exclusive/inclusive tick window', () => {
    const scheduledJob = job();
    const plan = planTraitSchedulerTick({
      state: state([scheduledJob]),
      lastTickAt: '2026-05-05T08:59:00.000Z',
      now: '2026-05-05T09:00:30.000Z',
    });

    expect(plan).toMatchObject({
      tickedAt: '2026-05-05T09:00:30.000Z',
      windowStartExclusive: '2026-05-05T08:59:00.000Z',
      windowEndInclusive: '2026-05-05T09:00:00.000Z',
      truncated: false,
      skippedJobs: [],
    });
    expect(plan.dueJobs).toHaveLength(1);
    expect(plan.dueJobs[0]).toMatchObject({
      dueAt: '2026-05-05T09:00:00.000Z',
      runId: buildTraitSchedulerRunId(scheduledJob, '2026-05-05T09:00:00.000Z'),
      summary: 'daily review',
      deliveryTarget: { kind: 'main-session', sessionId: 'main-session' },
    });
  });

  it('does not duplicate a run when lastTickAt is already the due minute', () => {
    const plan = planTraitSchedulerTick({
      state: state([job()]),
      lastTickAt: '2026-05-05T09:00:00.000Z',
      now: '2026-05-05T09:00:30.000Z',
    });

    expect(plan.dueJobs).toEqual([]);
    expect(plan.truncated).toBe(false);
  });

  it('supports loader-accepted steps, lists, and ranges with deterministic ordering', () => {
    const everyQuarter = job({
      jobId: 'trait.test.example.v1:1.0.0:quarter',
      scheduleId: 'quarter',
      cron: '*/15 * * * *',
      summary: 'quarter-hour check',
    });
    const weekdayOffice = job({
      jobId: 'trait.test.example.v1:1.0.0:office',
      scheduleId: 'office',
      cron: '0,30 9-10 * * 1-5',
      summary: 'weekday office check',
    });

    const plan = planTraitSchedulerTick({
      state: state([everyQuarter, weekdayOffice]),
      lastTickAt: '2026-05-05T08:45:00.000Z',
      now: '2026-05-05T10:00:00.000Z',
    });

    expect(plan.dueJobs.map((due) => `${due.job.scheduleId}@${due.dueAt}`)).toEqual([
      'quarter@2026-05-05T09:00:00.000Z',
      'office@2026-05-05T09:00:00.000Z',
      'quarter@2026-05-05T09:15:00.000Z',
      'quarter@2026-05-05T09:30:00.000Z',
      'office@2026-05-05T09:30:00.000Z',
      'quarter@2026-05-05T09:45:00.000Z',
      'quarter@2026-05-05T10:00:00.000Z',
      'office@2026-05-05T10:00:00.000Z',
    ]);
  });

  it('uses standard cron OR semantics when day-of-month and day-of-week are both restricted', () => {
    const tuesdayOrFirst = job({
      cron: '0 9 1 * 2',
      scheduleId: 'tuesday-or-first',
    });
    const firstOnly = job({
      cron: '0 9 1 * *',
      scheduleId: 'first-only',
    });

    const plan = planTraitSchedulerTick({
      state: state([tuesdayOrFirst, firstOnly]),
      lastTickAt: '2026-05-05T08:59:00.000Z',
      now: '2026-05-05T09:00:00.000Z',
    });

    expect(plan.dueJobs.map((due) => due.job.scheduleId)).toEqual([
      'tuesday-or-first',
    ]);
  });

  it('skips non-UTC schedules and tampered invalid cron strings without dispatching', () => {
    const plan = planTraitSchedulerTick({
      state: state([
        job({
          jobId: 'trait.test.example.v1:1.0.0:tokyo',
          scheduleId: 'tokyo',
          timezone: 'Asia/Tokyo',
        }),
        job({
          jobId: 'trait.test.example.v1:1.0.0:bad',
          scheduleId: 'bad',
          cron: 'not a cron',
        }),
      ]),
      lastTickAt: '2026-05-05T08:59:00.000Z',
      now: '2026-05-05T09:00:00.000Z',
    });

    expect(plan.dueJobs).toEqual([]);
    expect(plan.skippedJobs.map((entry) => [entry.scheduleId, entry.reason])).toEqual([
      ['tokyo', 'unsupported-timezone'],
      ['bad', 'invalid-cron'],
    ]);
  });

  it('bounds catch-up windows and due result cardinality explicitly', () => {
    const everyMinute = job({ cron: '* * * * *' });
    const lookbackPlan = planTraitSchedulerTick({
      state: state([everyMinute]),
      lastTickAt: '2026-05-03T10:00:00.000Z',
      now: '2026-05-05T10:00:00.000Z',
      maxLookbackMinutes: 2,
    });

    expect(lookbackPlan.truncated).toBe(true);
    expect(lookbackPlan.windowStartExclusive).toBe('2026-05-05T09:58:00.000Z');
    expect(lookbackPlan.dueJobs.map((due) => due.dueAt)).toEqual([
      '2026-05-05T09:59:00.000Z',
      '2026-05-05T10:00:00.000Z',
    ]);

    const cardinalityPlan = planTraitSchedulerTick({
      state: state([everyMinute]),
      lastTickAt: '2026-05-05T09:55:00.000Z',
      now: '2026-05-05T10:00:00.000Z',
      maxDueJobs: 3,
    });

    expect(cardinalityPlan.truncated).toBe(true);
    expect(cardinalityPlan.dueJobs.map((due) => due.dueAt)).toEqual([
      '2026-05-05T09:56:00.000Z',
      '2026-05-05T09:57:00.000Z',
      '2026-05-05T09:58:00.000Z',
    ]);
  });

  it('returns snapshots so callers cannot mutate scheduler state through due jobs', () => {
    const scheduledJob = job();
    const schedulerState = state([scheduledJob]);
    const plan = planTraitSchedulerTick({
      state: schedulerState,
      lastTickAt: '2026-05-05T08:59:00.000Z',
      now: '2026-05-05T09:00:00.000Z',
    });

    const due = plan.dueJobs[0];
    if (due === undefined) throw new Error('expected a due job');
    (due.job as { summary: string }).summary = 'mutated';
    (due.deliveryTarget as { sessionId: string }).sessionId = 'mutated-session';

    expect(schedulerState.jobs[0]?.summary).toBe('daily review');
    expect(schedulerState.jobs[0]?.deliveryTarget).toEqual({
      kind: 'main-session',
      sessionId: 'main-session',
    });
  });

  it('rejects ambiguous tick instants and reversed windows', () => {
    expect(() =>
      planTraitSchedulerTick({
        state: state([job()]),
        lastTickAt: '2026-05-05T08:59:00.000Z',
        now: '2026-05-05 09:00:00',
      }),
    ).toThrow(/now must be an ISO-8601 instant with timezone/);

    expect(() =>
      planTraitSchedulerTick({
        state: state([job()]),
        lastTickAt: '2026-05-05T09:01:00.000Z',
        now: '2026-05-05T09:00:00.000Z',
      }),
    ).toThrow(/lastTickAt must be <= now/);
  });
});

describe('TraitModule scheduler host-callback dispatch runner', () => {
  it('dispatches due jobs sequentially and returns an advance checkpoint', async () => {
    const first = job();
    const second = job({
      jobId: 'trait.test.example.v1:1.0.0:second',
      scheduleId: 'second',
      summary: 'second review',
      deliveryTarget: {
        kind: 'isolated-session',
        sessionKey: 'trait-schedule:trait.test.example.v1:second',
      },
      delivery: 'isolated-session',
    });
    const plan = planTraitSchedulerTick({
      state: state([first, second]),
      lastTickAt: '2026-05-05T08:59:00.000Z',
      now: '2026-05-05T09:00:00.000Z',
    });
    const observed: string[] = [];

    const result = await runTraitSchedulerDueJobs({
      plan,
      now: fixedClock([
        '2026-05-05T09:00:01.000Z',
        '2026-05-05T09:00:02.000Z',
        '2026-05-05T09:00:03.000Z',
        '2026-05-05T09:00:04.000Z',
      ]),
      dispatch: (due) => {
        observed.push(`${due.job.scheduleId}@${due.dueAt}`);
        return {
          taskId: `task-${due.job.scheduleId}`,
          detail: `queued ${due.runId}`,
        };
      },
    });

    expect(observed).toEqual([
      'daily@2026-05-05T09:00:00.000Z',
      'second@2026-05-05T09:00:00.000Z',
    ]);
    expect(result).toMatchObject({
      planTickedAt: '2026-05-05T09:00:00.000Z',
      attemptedCount: 2,
      dispatchedCount: 2,
      failedCount: 0,
      skippedPlannedCount: 0,
      checkpoint: {
        status: 'advance',
        lastTickAt: '2026-05-05T09:00:00.000Z',
      },
    });
    expect(result.results.map((entry) => entry.status)).toEqual([
      'dispatched',
      'dispatched',
    ]);
    expect(result.results[0]).toMatchObject({
      taskId: 'task-daily',
      observedAt: '2026-05-05T09:00:02.000Z',
    });
  });

  it('contains per-job dispatch failures and continues later due jobs', async () => {
    const first = job();
    const second = job({
      jobId: 'trait.test.example.v1:1.0.0:second',
      scheduleId: 'second',
      summary: 'second review',
    });
    const third = job({
      jobId: 'trait.test.example.v1:1.0.0:third',
      scheduleId: 'third',
      summary: 'third review',
    });
    const plan = planTraitSchedulerTick({
      state: state([first, second, third]),
      lastTickAt: '2026-05-05T08:59:00.000Z',
      now: '2026-05-05T09:00:00.000Z',
    });
    const attempted: string[] = [];

    const result = await runTraitSchedulerDueJobs({
      plan,
      now: () => '2026-05-05T09:00:01.000Z',
      dispatch: (due) => {
        attempted.push(due.job.scheduleId);
        if (due.job.scheduleId === 'second') {
          throw new Error('dispatcher unavailable');
        }
      },
    });

    expect(attempted).toEqual(['daily', 'second', 'third']);
    expect(result).toMatchObject({
      attemptedCount: 3,
      dispatchedCount: 2,
      failedCount: 1,
      checkpoint: {
        status: 'hold',
        reason: 'dispatch-failed',
        reasons: ['dispatch-failed'],
      },
    });
    expect(result.results.map((entry) => entry.status)).toEqual([
      'dispatched',
      'failed',
      'dispatched',
    ]);
    expect(result.results[1]).toMatchObject({
      scheduleId: 'second',
      error: 'dispatcher unavailable',
    });
  });

  it('holds the checkpoint for truncated plans even when dispatch succeeds', async () => {
    const plan = planTraitSchedulerTick({
      state: state([job({ cron: '* * * * *' })]),
      lastTickAt: '2026-05-05T08:55:00.000Z',
      now: '2026-05-05T09:00:00.000Z',
      maxDueJobs: 2,
    });

    const result = await runTraitSchedulerDueJobs({
      plan,
      now: () => '2026-05-05T09:00:01.000Z',
      dispatch: () => undefined,
    });

    expect(plan.truncated).toBe(true);
    expect(result).toMatchObject({
      attemptedCount: 2,
      dispatchedCount: 2,
      failedCount: 0,
      checkpoint: {
        status: 'hold',
        reason: 'plan-truncated',
        reasons: ['plan-truncated'],
      },
    });
  });

  it('reports both hold reasons when a truncated plan also has dispatch failures', async () => {
    const plan = planTraitSchedulerTick({
      state: state([job({ cron: '* * * * *' })]),
      lastTickAt: '2026-05-05T08:55:00.000Z',
      now: '2026-05-05T09:00:00.000Z',
      maxDueJobs: 2,
    });

    const result = await runTraitSchedulerDueJobs({
      plan,
      now: () => '2026-05-05T09:00:01.000Z',
      dispatch: () => Promise.reject(new Error('async dispatch failed')),
    });

    expect(result.failedCount).toBe(2);
    expect(result.checkpoint).toEqual({
      status: 'hold',
      reason: 'dispatch-failed',
      reasons: ['dispatch-failed', 'plan-truncated'],
    });
  });

  it('awaits async dispatch callbacks sequentially before starting the next due job', async () => {
    const second = job({
      jobId: 'trait.test.example.v1:1.0.0:second',
      scheduleId: 'second',
      summary: 'second review',
    });
    const plan = planTraitSchedulerTick({
      state: state([job(), second]),
      lastTickAt: '2026-05-05T08:59:00.000Z',
      now: '2026-05-05T09:00:00.000Z',
    });
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const run = runTraitSchedulerDueJobs({
      plan,
      now: () => '2026-05-05T09:00:01.000Z',
      dispatch: async (due) => {
        order.push(`start:${due.job.scheduleId}`);
        if (due.job.scheduleId === 'daily') {
          await firstGate;
        }
        order.push(`end:${due.job.scheduleId}`);
      },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(['start:daily']);
    releaseFirst?.();
    const result = await run;
    expect(order).toEqual([
      'start:daily',
      'end:daily',
      'start:second',
      'end:second',
    ]);
    expect(result.failedCount).toBe(0);
  });

  it('reports planner-skipped jobs but does not hold the checkpoint for them alone', async () => {
    const plan = planTraitSchedulerTick({
      state: state([
        job(),
        job({
          jobId: 'trait.test.example.v1:1.0.0:tokyo',
          scheduleId: 'tokyo',
          timezone: 'Asia/Tokyo',
        }),
      ]),
      lastTickAt: '2026-05-05T08:59:00.000Z',
      now: '2026-05-05T09:00:00.000Z',
    });

    const result = await runTraitSchedulerDueJobs({
      plan,
      now: () => '2026-05-05T09:00:01.000Z',
      dispatch: () => undefined,
    });

    expect(result).toMatchObject({
      attemptedCount: 1,
      dispatchedCount: 1,
      failedCount: 0,
      skippedPlannedCount: 1,
      checkpoint: {
        status: 'advance',
        lastTickAt: '2026-05-05T09:00:00.000Z',
      },
    });
    expect(result.skippedJobs[0]).toMatchObject({
      scheduleId: 'tokyo',
      reason: 'unsupported-timezone',
    });
  });

  it('passes cloned due-job snapshots to the dispatcher', async () => {
    const scheduledJob = job();
    const schedulerState = state([scheduledJob]);
    const plan = planTraitSchedulerTick({
      state: schedulerState,
      lastTickAt: '2026-05-05T08:59:00.000Z',
      now: '2026-05-05T09:00:00.000Z',
    });

    await runTraitSchedulerDueJobs({
      plan,
      now: () => '2026-05-05T09:00:01.000Z',
      dispatch: (due) => {
        (due.job as { summary: string }).summary = 'mutated in dispatcher';
        (due.deliveryTarget as { sessionId: string }).sessionId = 'mutated';
      },
    });

    expect(plan.dueJobs[0]?.job.summary).toBe('daily review');
    expect(plan.dueJobs[0]?.deliveryTarget).toEqual({
      kind: 'main-session',
      sessionId: 'main-session',
    });
    expect(schedulerState.jobs[0]?.summary).toBe('daily review');
  });
});

describe('TraitModule scheduler checkpoint cursor', () => {
  it('advances lastTickAt only when dispatch checkpoint says advance', async () => {
    const previous: TraitSchedulerTickCursorState = {
      schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
      updatedAt: '2026-05-05T08:59:00.000Z',
      lastTickAt: '2026-05-05T08:59:00.000Z',
      lastHoldReasons: ['dispatch-failed'],
    };
    Object.freeze(previous);
    const plan = planTraitSchedulerTick({
      state: state([job()]),
      lastTickAt: previous.lastTickAt,
      now: '2026-05-05T09:00:00.000Z',
    });
    const batch = await runTraitSchedulerDueJobs({
      plan,
      now: () => '2026-05-05T09:00:01.000Z',
      dispatch: () => undefined,
    });

    const next = applyTraitSchedulerDispatchCheckpoint(previous, batch);

    expect(next).not.toBe(previous);
    expect(previous.lastTickAt).toBe('2026-05-05T08:59:00.000Z');
    expect(previous.lastHoldReasons).toEqual(['dispatch-failed']);
    expect(next).toEqual({
      schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
      updatedAt: '2026-05-05T09:00:01.000Z',
      lastTickAt: '2026-05-05T09:00:00.000Z',
      lastBatch: {
        planTickedAt: '2026-05-05T09:00:00.000Z',
        attemptedCount: 1,
        dispatchedCount: 1,
        failedCount: 0,
        skippedPlannedCount: 0,
        truncated: false,
      },
    });
  });

  it('keeps lastTickAt on hold and records hold reasons', async () => {
    const previous: TraitSchedulerTickCursorState = {
      schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
      updatedAt: '2026-05-05T08:55:00.000Z',
      lastTickAt: '2026-05-05T08:55:00.000Z',
    };
    const plan = planTraitSchedulerTick({
      state: state([job({ cron: '* * * * *' })]),
      lastTickAt: previous.lastTickAt,
      now: '2026-05-05T09:00:00.000Z',
      maxDueJobs: 2,
    });
    const batch = await runTraitSchedulerDueJobs({
      plan,
      now: () => '2026-05-05T09:00:01.000Z',
      dispatch: () => Promise.reject(new Error('still down')),
    });

    const next = applyTraitSchedulerDispatchCheckpoint(previous, batch);

    expect(next).toMatchObject({
      updatedAt: '2026-05-05T09:00:01.000Z',
      lastTickAt: '2026-05-05T08:55:00.000Z',
      lastHoldReasons: ['dispatch-failed', 'plan-truncated'],
      lastBatch: {
        attemptedCount: 2,
        dispatchedCount: 0,
        failedCount: 2,
        truncated: true,
      },
    });
  });

  it('persists and validates cursor state through the JSON file store', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-cursor-'));
    try {
      const filePath = join(workspace, 'state', 'cursor.json');
      const store = new JsonFileTraitSchedulerCursorStore(filePath);
      expect(store.load()).toEqual({
        schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
        updatedAt: new Date(0).toISOString(),
      });

      const saved: TraitSchedulerTickCursorState = {
        schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
        updatedAt: '2026-05-05T09:00:01.000Z',
        lastTickAt: '2026-05-05T09:00:00.000Z',
        lastBatch: {
          planTickedAt: '2026-05-05T09:00:00.000Z',
          attemptedCount: 1,
          dispatchedCount: 1,
          failedCount: 0,
          skippedPlannedCount: 0,
          truncated: false,
        },
      };
      store.save(saved);

      expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({
        schemaVersion: 1,
        lastTickAt: '2026-05-05T09:00:00.000Z',
      });
      expect(store.load()).toEqual(saved);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('rejects cursor schema drift fail-closed at load time', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-cursor-schema-'));
    try {
      const filePath = join(workspace, 'cursor.json');
      writeFileSync(
        filePath,
        JSON.stringify({
          schemaVersion: 2,
          updatedAt: '2026-05-05T09:00:01.000Z',
        }),
        'utf8',
      );
      const store = new JsonFileTraitSchedulerCursorStore(filePath);
      expect(() => store.load()).toThrow(/cursor schemaVersion must be 1/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('rejects malformed cursor files fail-closed at load time', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-cursor-bad-'));
    try {
      const filePath = join(workspace, 'cursor.json');
      writeFileSync(
        filePath,
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: 'not an instant',
          lastHoldReasons: ['unexpected'],
        }),
        'utf8',
      );
      const store = new JsonFileTraitSchedulerCursorStore(filePath);
      expect(() => store.load()).toThrow(/updatedAt must be an ISO-8601 instant/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('TraitModule scheduler one-shot coordinator', () => {
  it('advances the cursor for an empty non-truncated due set without dispatching', async () => {
    const cursor: TraitSchedulerTickCursorState = {
      schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
      updatedAt: '2026-05-05T08:59:00.000Z',
      lastTickAt: '2026-05-05T08:59:00.000Z',
    };
    let dispatchCount = 0;

    const result = await runTraitSchedulerTickOnce({
      state: state([]),
      cursor,
      now: '2026-05-05T09:00:30.000Z',
      dispatchClock: fixedClock([
        '2026-05-05T09:00:31.000Z',
        '2026-05-05T09:00:32.000Z',
      ]),
      dispatch: () => {
        dispatchCount += 1;
      },
    });

    expect(dispatchCount).toBe(0);
    expect(result.plan.dueJobs).toEqual([]);
    expect(result.batch).toMatchObject({
      attemptedCount: 0,
      dispatchedCount: 0,
      failedCount: 0,
      truncated: false,
      checkpoint: {
        status: 'advance',
        lastTickAt: '2026-05-05T09:00:00.000Z',
      },
    });
    expect(result.nextCursor).toMatchObject({
      updatedAt: '2026-05-05T09:00:32.000Z',
      lastTickAt: '2026-05-05T09:00:00.000Z',
      lastBatch: {
        attemptedCount: 0,
        dispatchedCount: 0,
        failedCount: 0,
        truncated: false,
      },
    });
  });

  it('plans from cursor.lastTickAt, dispatches due jobs, and returns the next cursor', async () => {
    const cursor: TraitSchedulerTickCursorState = {
      schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
      updatedAt: '2026-05-05T08:59:00.000Z',
      lastTickAt: '2026-05-05T08:59:00.000Z',
    };
    const observed: string[] = [];

    const result = await runTraitSchedulerTickOnce({
      state: state([job()]),
      cursor,
      now: '2026-05-05T09:00:30.000Z',
      dispatchClock: fixedClock([
        '2026-05-05T09:00:31.000Z',
        '2026-05-05T09:00:32.000Z',
        '2026-05-05T09:00:33.000Z',
      ]),
      dispatch: (due) => {
        observed.push(`${due.job.scheduleId}@${due.dueAt}`);
      },
    });

    expect(observed).toEqual(['daily@2026-05-05T09:00:00.000Z']);
    expect(result.previousCursor).toBe(cursor);
    expect(result.plan).toMatchObject({
      windowStartExclusive: '2026-05-05T08:59:00.000Z',
      windowEndInclusive: '2026-05-05T09:00:00.000Z',
    });
    expect(result.batch).toMatchObject({
      attemptedCount: 1,
      dispatchedCount: 1,
      failedCount: 0,
      checkpoint: {
        status: 'advance',
        lastTickAt: '2026-05-05T09:00:00.000Z',
      },
    });
    expect(result.nextCursor).toEqual({
      schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
      updatedAt: '2026-05-05T09:00:33.000Z',
      lastTickAt: '2026-05-05T09:00:00.000Z',
      lastBatch: {
        planTickedAt: '2026-05-05T09:00:30.000Z',
        attemptedCount: 1,
        dispatchedCount: 1,
        failedCount: 0,
        skippedPlannedCount: 0,
        truncated: false,
      },
    });
  });

  it('loads state/cursor from stores and saves a held cursor after failed truncated dispatch', async () => {
    const initialCursor: TraitSchedulerTickCursorState = {
      schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
      updatedAt: '2026-05-05T08:55:00.000Z',
      lastTickAt: '2026-05-05T08:55:00.000Z',
    };
    let savedCursor: TraitSchedulerTickCursorState | undefined;
    const schedulerStore = {
      load: () => state([job({ cron: '* * * * *' })]),
    };
    const cursorStore = {
      load: () => initialCursor,
      save: (next: TraitSchedulerTickCursorState) => {
        savedCursor = next;
      },
    };

    const result = await runTraitSchedulerTickOnceFromStores({
      schedulerStore,
      cursorStore,
      now: '2026-05-05T09:00:00.000Z',
      maxDueJobs: 1,
      dispatchClock: () => '2026-05-05T09:00:01.000Z',
      dispatch: () => Promise.reject(new Error('host dispatcher unavailable')),
    });

    expect(result.batch).toMatchObject({
      attemptedCount: 1,
      dispatchedCount: 0,
      failedCount: 1,
      truncated: true,
      checkpoint: {
        status: 'hold',
        reason: 'dispatch-failed',
        reasons: ['dispatch-failed', 'plan-truncated'],
      },
    });
    expect(result.nextCursor).toMatchObject({
      updatedAt: '2026-05-05T09:00:01.000Z',
      lastTickAt: '2026-05-05T08:55:00.000Z',
      lastHoldReasons: ['dispatch-failed', 'plan-truncated'],
      lastBatch: {
        attemptedCount: 1,
        dispatchedCount: 0,
        failedCount: 1,
        truncated: true,
      },
    });
    expect(savedCursor).toBe(result.nextCursor);
  });
});

describe('TraitModule scheduler in-process tick serialization', () => {
  it('serializes concurrent store-backed ticks so the second call reloads the advanced cursor', async () => {
    const runner = new InProcessTraitSchedulerTickOnceRunner();
    let cursorState: TraitSchedulerTickCursorState = {
      schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
      updatedAt: '2026-05-05T08:59:00.000Z',
      lastTickAt: '2026-05-05T08:59:00.000Z',
    };
    let cursorLoads = 0;
    let releaseFirstDispatch: (() => void) | undefined;
    const firstDispatchStarted = new Promise<void>((resolve) => {
      releaseFirstDispatch = () => {
        resolve();
      };
    });
    let unblockFirstDispatch: (() => void) | undefined;
    const firstDispatchGate = new Promise<void>((resolve) => {
      unblockFirstDispatch = resolve;
    });
    const dispatched: string[] = [];
    const options: RunTraitSchedulerTickOnceFromStoresOptions = {
      schedulerStore: {
        load: () => state([job()]),
      },
      cursorStore: {
        load: () => {
          cursorLoads += 1;
          return cursorState;
        },
        save: (next: TraitSchedulerTickCursorState) => {
          cursorState = next;
        },
      },
      now: '2026-05-05T09:00:30.000Z',
      dispatchClock: () => '2026-05-05T09:00:31.000Z',
      dispatch: async (due) => {
        dispatched.push(`${due.job.scheduleId}@${due.dueAt}`);
        releaseFirstDispatch?.();
        await firstDispatchGate;
      },
    };

    const first = runner.run(options);
    await firstDispatchStarted;
    const second = runner.run(options);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cursorLoads).toBe(1);

    unblockFirstDispatch?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(dispatched).toEqual(['daily@2026-05-05T09:00:00.000Z']);
    expect(cursorLoads).toBe(2);
    expect(firstResult.batch.attemptedCount).toBe(1);
    expect(secondResult.previousCursor.lastTickAt).toBe('2026-05-05T09:00:00.000Z');
    expect(secondResult.batch).toMatchObject({
      attemptedCount: 0,
      dispatchedCount: 0,
      failedCount: 0,
      checkpoint: {
        status: 'advance',
        lastTickAt: '2026-05-05T09:00:00.000Z',
      },
    });
    expect(cursorState.lastTickAt).toBe('2026-05-05T09:00:00.000Z');
  });

  it('releases the in-process queue when a store-backed tick throws', async () => {
    const runner = new InProcessTraitSchedulerTickOnceRunner();
    let schedulerLoads = 0;
    const cursorState: TraitSchedulerTickCursorState = {
      schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
      updatedAt: '2026-05-05T09:00:00.000Z',
      lastTickAt: '2026-05-05T09:00:00.000Z',
    };
    const options: RunTraitSchedulerTickOnceFromStoresOptions = {
      schedulerStore: {
        load: () => {
          schedulerLoads += 1;
          if (schedulerLoads === 1) {
            throw new Error('scheduler store unavailable');
          }
          return state([]);
        },
      },
      cursorStore: {
        load: () => cursorState,
        save: () => undefined,
      },
      now: '2026-05-05T09:01:00.000Z',
      dispatchClock: () => '2026-05-05T09:01:01.000Z',
      dispatch: () => undefined,
    };

    const first = runner.run(options);
    const second = runner.run(options);

    await expect(first).rejects.toThrow(/scheduler store unavailable/);
    const secondResult = await second;

    expect(schedulerLoads).toBe(2);
    expect(secondResult.batch).toMatchObject({
      attemptedCount: 0,
      dispatchedCount: 0,
      failedCount: 0,
    });
  });
});

describe('TraitModule scheduler filesystem tick lease', () => {
  it('skips without dispatching while a non-expired lease is held', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-lease-held-'));
    try {
      const leasePath = join(workspace, 'tick.lock');
      const holder = new JsonFileTraitSchedulerTickLease(leasePath, {
        ownerId: 'holder',
        ttlMs: 60_000,
        now: () => '2026-05-05T09:00:00.000Z',
      });
      const held = holder.acquire();
      if (held.status !== 'acquired') throw new Error('expected initial lease');
      const contender = new JsonFileTraitSchedulerTickLease(leasePath, {
        ownerId: 'contender',
        ttlMs: 60_000,
        now: () => '2026-05-05T09:00:01.000Z',
      });
      let schedulerLoads = 0;
      let dispatchCount = 0;

      const result = await runTraitSchedulerTickOnceWithLease({
        lease: contender,
        schedulerStore: {
          load: () => {
            schedulerLoads += 1;
            return state([job()]);
          },
        },
        cursorStore: {
          load: () => ({
            schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
            updatedAt: '2026-05-05T08:59:00.000Z',
            lastTickAt: '2026-05-05T08:59:00.000Z',
          }),
          save: () => undefined,
        },
        now: '2026-05-05T09:00:30.000Z',
        dispatchClock: () => '2026-05-05T09:00:31.000Z',
        dispatch: () => {
          dispatchCount += 1;
        },
      });

      expect(result).toMatchObject({
        status: 'skipped',
        reason: 'lease-held',
        lease: {
          existingLease: {
            ownerId: 'holder',
          },
        },
      });
      expect(schedulerLoads).toBe(0);
      expect(dispatchCount).toBe(0);
      holder.release(held);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('releases an acquired lease when the store-backed tick throws', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-lease-throw-'));
    try {
      const leasePath = join(workspace, 'tick.lock');
      const lease = new JsonFileTraitSchedulerTickLease(leasePath, {
        ownerId: 'throwing-runner',
        ttlMs: 60_000,
        now: () => '2026-05-05T09:00:00.000Z',
      });

      await expect(
        runTraitSchedulerTickOnceWithLease({
          lease,
          schedulerStore: {
            load: () => {
              throw new Error('scheduler store unavailable');
            },
          },
          cursorStore: {
            load: () => ({
              schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
              updatedAt: '2026-05-05T08:59:00.000Z',
              lastTickAt: '2026-05-05T08:59:00.000Z',
            }),
            save: () => undefined,
          },
          now: '2026-05-05T09:00:30.000Z',
          dispatchClock: () => '2026-05-05T09:00:31.000Z',
          dispatch: () => undefined,
        }),
      ).rejects.toThrow(/scheduler store unavailable/);

      expect(existsSync(leasePath)).toBe(false);
      const reacquired = lease.acquire();
      expect(reacquired.status).toBe('acquired');
      if (reacquired.status === 'acquired') {
        lease.release(reacquired);
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('takes over an expired lease before running one tick', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-lease-stale-'));
    try {
      const leasePath = join(workspace, 'tick.lock');
      const staleHolder = new JsonFileTraitSchedulerTickLease(leasePath, {
        ownerId: 'stale-holder',
        ttlMs: 1_000,
        now: () => '2026-05-05T09:00:00.000Z',
      });
      const stale = staleHolder.acquire();
      if (stale.status !== 'acquired') throw new Error('expected stale lease setup');
      const contender = new JsonFileTraitSchedulerTickLease(leasePath, {
        ownerId: 'contender',
        ttlMs: 60_000,
        now: () => '2026-05-05T09:00:02.000Z',
      });
      let cursorState: TraitSchedulerTickCursorState = {
        schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
        updatedAt: '2026-05-05T08:59:00.000Z',
        lastTickAt: '2026-05-05T08:59:00.000Z',
      };

      const result = await runTraitSchedulerTickOnceWithLease({
        lease: contender,
        schedulerStore: {
          load: () => state([job()]),
        },
        cursorStore: {
          load: () => cursorState,
          save: (next) => {
            cursorState = next;
          },
        },
        now: '2026-05-05T09:00:30.000Z',
        dispatchClock: () => '2026-05-05T09:00:31.000Z',
        dispatch: () => undefined,
      });

      expect(result.status).toBe('ran');
      if (result.status !== 'ran') throw new Error('expected lease takeover run');
      expect(result.lease.lease.ownerId).toBe('contender');
      expect(result.result.batch.attemptedCount).toBe(1);
      expect(cursorState.lastTickAt).toBe('2026-05-05T09:00:00.000Z');
      expect(existsSync(leasePath)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('TraitModule scheduler tick evidence ledger', () => {
  it('records ran tick evidence to JSONL and skips malformed replay lines', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-evidence-ran-'));
    try {
      const filePath = join(workspace, 'tick-evidence.jsonl');
      const evidenceLedger = new JsonlTraitSchedulerTickEvidenceLedger(filePath);
      const lease = new JsonFileTraitSchedulerTickLease(join(workspace, 'tick.lock'), {
        ownerId: 'evidence-runner',
        ttlMs: 60_000,
        now: () => '2026-05-05T09:00:00.000Z',
      });

      const result = await runTraitSchedulerTickOnceWithLeaseAndEvidence({
        lease,
        evidenceLedger,
        evidence: {
          recordId: 'tick-record-1',
          recordedAt: '2026-05-05T09:00:32.000Z',
          source: 'unit-test',
        },
        schedulerStore: {
          load: () => state([job()]),
        },
        cursorStore: {
          load: () => ({
            schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
            updatedAt: '2026-05-05T08:59:00.000Z',
            lastTickAt: '2026-05-05T08:59:00.000Z',
          }),
          save: () => undefined,
        },
        now: '2026-05-05T09:00:30.000Z',
        dispatchClock: () => '2026-05-05T09:00:31.000Z',
        dispatch: () => undefined,
      });

      expect(result.tick.status).toBe('ran');
      expect(result.evidence).toMatchObject({
        status: 'recorded',
        record: {
          schemaVersion: 1,
          recordId: 'tick-record-1',
          status: 'ran',
          source: 'unit-test',
          lease: {
            status: 'acquired',
            ownerId: 'evidence-runner',
          },
          batch: {
            attemptedCount: 1,
            dispatchedCount: 1,
            failedCount: 0,
            checkpointStatus: 'advance',
            checkpointLastTickAt: '2026-05-05T09:00:00.000Z',
          },
        },
      });
      expect(JSON.stringify(result.evidence)).not.toContain('"token"');

      const malformedBatchRecord = JSON.stringify({
        schemaVersion: 1,
        recordId: 'malformed-batch',
        recordedAt: '2026-05-05T09:00:33.000Z',
        status: 'ran',
        batch: {
          planTickedAt: '2026-05-05T09:00:30.000Z',
          windowStartExclusive: '2026-05-05T08:59:00.000Z',
          windowEndInclusive: '2026-05-05T09:00:00.000Z',
          attemptedCount: 1,
          dispatchedCount: 1,
          failedCount: 0,
          skippedPlannedCount: 0,
          truncated: false,
          checkpointStatus: 'hold',
          checkpointHoldReasons: ['unexpected'],
        },
      });
      writeFileSync(
        filePath,
        `${readFileSync(filePath, 'utf8')}${malformedBatchRecord}\n{"schemaVersion":1,"recordId":"broken"`,
        'utf8',
      );
      if (result.evidence.status !== 'recorded') {
        throw new Error('expected evidence record');
      }
      const replayedLedger = new JsonlTraitSchedulerTickEvidenceLedger(filePath);
      expect(replayedLedger.loadAll()).toEqual([result.evidence.record]);
      const replay = replayedLedger.loadWithAudit();
      expect(replay).toEqual({
        records: [result.evidence.record],
        replayAudit: {
          source: 'jsonl',
          totalLineCount: 3,
          emptyLineCount: 0,
          parsedRecordCount: 1,
          skippedMalformedLineCount: 2,
        },
      });
      expectReplayAuditInvariant(replay.replayAudit);
      expect(replay.replayAudit.parsedRecordCount).toBe(replay.records.length);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('pins replay audit line counts for empty, trailing-newline, and CRLF ledgers', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-evidence-audit-'));
    try {
      const validRecord = JSON.stringify(tickEvidenceRecord());
      const cases = [
        {
          name: 'zero-byte',
          content: '',
          expected: {
            totalLineCount: 0,
            emptyLineCount: 0,
            parsedRecordCount: 0,
            skippedMalformedLineCount: 0,
          },
        },
        {
          name: 'trailing-newline',
          content: `${validRecord}\n`,
          expected: {
            totalLineCount: 1,
            emptyLineCount: 0,
            parsedRecordCount: 1,
            skippedMalformedLineCount: 0,
          },
        },
        {
          name: 'newline-only',
          content: '\n',
          expected: {
            totalLineCount: 1,
            emptyLineCount: 1,
            parsedRecordCount: 0,
            skippedMalformedLineCount: 0,
          },
        },
        {
          name: 'crlf-mixed',
          content: `${validRecord}\r\n  \r\n{"schemaVersion":1,"recordId":"invalid-shape"}\r\n{"schemaVersion":1,"recordId":"torn"`,
          expected: {
            totalLineCount: 4,
            emptyLineCount: 1,
            parsedRecordCount: 1,
            skippedMalformedLineCount: 2,
          },
        },
      ] as const;

      for (const testCase of cases) {
        const filePath = join(workspace, `${testCase.name}.jsonl`);
        writeFileSync(filePath, testCase.content, 'utf8');
        const ledger = new JsonlTraitSchedulerTickEvidenceLedger(filePath);
        const replays = [
          ledger.loadWithAudit(),
          ledger.loadWithAudit({
            maxBytes: Math.max(1, Buffer.byteLength(testCase.content, 'utf8')),
          }),
        ];

        for (const replay of replays) {
          expect(replay.replayAudit).toEqual({
            source: 'jsonl',
            ...testCase.expected,
          });
          expectReplayAuditInvariant(replay.replayAudit);
          expect(replay.replayAudit.parsedRecordCount).toBe(replay.records.length);
        }
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps loadAll best-effort compatible for malformed-only JSONL ledgers', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-evidence-malformed-'));
    try {
      const filePath = join(workspace, 'malformed-only.jsonl');
      writeFileSync(
        filePath,
        '{"schemaVersion":1,"recordId":"invalid-shape"}\n{"schemaVersion":1,"recordId":"torn"',
        'utf8',
      );

      expect(new JsonlTraitSchedulerTickEvidenceLedger(filePath).loadAll()).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('optionally compacts JSONL evidence to the latest valid records after append', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-evidence-retention-'));
    try {
      const filePath = join(workspace, 'retained.jsonl');
      writeFileSync(
        filePath,
        `${JSON.stringify(tickEvidenceRecord({
          recordId: 'old-valid',
          recordedAt: '2026-05-05T08:58:00.000Z',
        }))}\nnot-json\n`,
        'utf8',
      );
      const ledger = new JsonlTraitSchedulerTickEvidenceLedger(filePath, {
        retentionRecords: 2,
      });

      for (const [index, recordId] of ['new-1', 'new-2', 'new-3'].entries()) {
        const tick = await runTraitSchedulerTickOnce({
          state: state([job()]),
          cursor: {
            schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
            updatedAt: '2026-05-05T08:59:00.000Z',
            lastTickAt: '2026-05-05T08:59:00.000Z',
          },
          now: '2026-05-05T09:00:30.000Z',
          dispatchClock: () => '2026-05-05T09:00:31.000Z',
          dispatch: () => undefined,
        });
        ledger.append({
          recordId,
          recordedAt: `2026-05-05T09:00:3${String(index)}.000Z`,
          source: 'retention-test',
          tick,
        });
      }

      expect(ledger.loadAll().map((record) => record.recordId)).toEqual([
        'new-2',
        'new-3',
      ]);
      expect(readFileSync(filePath, 'utf8')).not.toContain('not-json');
      expect(readFileSync(filePath, 'utf8')).not.toContain('old-valid');
      const replay = ledger.loadWithAudit();
      expect(replay.replayAudit).toEqual({
        source: 'jsonl',
        totalLineCount: 2,
        emptyLineCount: 0,
        parsedRecordCount: 2,
        skippedMalformedLineCount: 0,
      });
      expectReplayAuditInvariant(replay.replayAudit);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('handles append-time retention edge counts without mutating read-only replay semantics', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-evidence-retention-edge-'));
    try {
      const tick = await runTraitSchedulerTickOnce({
        state: state([job()]),
        cursor: {
          schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
          updatedAt: '2026-05-05T08:59:00.000Z',
          lastTickAt: '2026-05-05T08:59:00.000Z',
        },
        now: '2026-05-05T09:00:30.000Z',
        dispatchClock: () => '2026-05-05T09:00:31.000Z',
        dispatch: () => undefined,
      });

      const keepOnePath = join(workspace, 'keep-one.jsonl');
      writeFileSync(
        keepOnePath,
        `${JSON.stringify(tickEvidenceRecord({ recordId: 'old-valid' }))}\n`,
        'utf8',
      );
      const keepOneLedger = new JsonlTraitSchedulerTickEvidenceLedger(keepOnePath, {
        retentionRecords: 1,
      });
      keepOneLedger.append({
        recordId: 'new-only',
        recordedAt: '2026-05-05T09:00:30.000Z',
        tick,
      });
      expect(keepOneLedger.loadAll().map((record) => record.recordId)).toEqual([
        'new-only',
      ]);

      const keepWidePath = join(workspace, 'keep-wide.jsonl');
      writeFileSync(
        keepWidePath,
        `${JSON.stringify(tickEvidenceRecord({ recordId: 'old-valid' }))}\nnot-json\n`,
        'utf8',
      );
      const keepWideLedger = new JsonlTraitSchedulerTickEvidenceLedger(keepWidePath, {
        retentionRecords: 10,
      });
      keepWideLedger.append({
        recordId: 'new-valid',
        recordedAt: '2026-05-05T09:00:31.000Z',
        tick,
      });
      expect(keepWideLedger.loadAll().map((record) => record.recordId)).toEqual([
        'old-valid',
        'new-valid',
      ]);
      expect(readFileSync(keepWidePath, 'utf8')).not.toContain('not-json');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('rejects invalid append-time JSONL evidence retention limits', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-evidence-retention-invalid-'));
    try {
      for (const retentionRecords of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(
          () =>
            new JsonlTraitSchedulerTickEvidenceLedger(
              join(workspace, `${String(retentionRecords)}.jsonl`),
              { retentionRecords },
            ),
        ).toThrow(/retentionRecords must be a positive safe integer/);
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails during bounded JSONL replay when the byte guard is exceeded', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-evidence-max-'));
    try {
      const filePath = join(workspace, 'oversized.jsonl');
      writeFileSync(filePath, `${JSON.stringify(tickEvidenceRecord())}\n`, 'utf8');
      const ledgerByteSize = Buffer.byteLength(readFileSync(filePath, 'utf8'), 'utf8');

      expect(
        new JsonlTraitSchedulerTickEvidenceLedger(filePath).loadWithAudit({
          maxBytes: ledgerByteSize,
        }).replayAudit.parsedRecordCount,
      ).toBe(1);

      expect(() =>
        new JsonlTraitSchedulerTickEvidenceLedger(filePath).loadWithAudit({
          maxBytes: 1,
        }),
      ).toThrow(/exceeds maxBytes/);
      expect(() =>
        new JsonlTraitSchedulerTickEvidenceLedger(filePath).loadWithAudit({
          maxBytes: 0,
        }),
      ).toThrow(/maxBytes must be a positive safe integer/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('preserves replay audit semantics for maxBytes-guarded large JSONL records', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-evidence-chunk-'));
    try {
      const filePath = join(workspace, 'large-record.jsonl');
      const largeRecord = tickEvidenceRecord({
        recordId: 'large-record',
        source: `chunk-boundary-${'x'.repeat(70_000)}`,
      });
      const content = `${JSON.stringify(largeRecord)}\n{"schemaVersion":1,"recordId":"invalid-shape"}\n`;
      writeFileSync(filePath, content, 'utf8');
      const ledgerByteSize = Buffer.byteLength(content, 'utf8');
      const ledger = new JsonlTraitSchedulerTickEvidenceLedger(filePath);

      const replay = ledger.loadWithAudit({ maxBytes: ledgerByteSize });

      expect(replay.records).toEqual([largeRecord]);
      expect(replay.replayAudit).toEqual({
        source: 'jsonl',
        totalLineCount: 2,
        emptyLineCount: 0,
        parsedRecordCount: 1,
        skippedMalformedLineCount: 1,
      });
      expectReplayAuditInvariant(replay.replayAudit);
      expect(() =>
        ledger.loadWithAudit({
          maxBytes: ledgerByteSize - 1,
        }),
      ).toThrow(/exceeds maxBytes/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('handles CRLF and UTF-8 code points split across JSONL replay chunks', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-evidence-split-'));
    try {
      const crlfPath = join(workspace, 'split-crlf.jsonl');
      const crlf = tickEvidenceJsonWithPaddedSource(
        TRAIT_SCHEDULER_TICK_EVIDENCE_REPLAY_TEST_CHUNK_BYTES - 1,
        'crlf-split-record',
        'crlf-',
      );
      const secondRecord = tickEvidenceRecord({
        recordId: 'after-crlf-split-record',
        source: 'after-crlf',
      });
      const crlfContent = `${crlf.json}\r\n${JSON.stringify(secondRecord)}\n`;
      writeFileSync(crlfPath, crlfContent, 'utf8');

      const crlfReplay = new JsonlTraitSchedulerTickEvidenceLedger(
        crlfPath,
      ).loadWithAudit({ maxBytes: Buffer.byteLength(crlfContent, 'utf8') });

      expect(crlfReplay.records).toEqual([crlf.record, secondRecord]);
      expect(crlfReplay.replayAudit).toEqual({
        source: 'jsonl',
        totalLineCount: 2,
        emptyLineCount: 0,
        parsedRecordCount: 2,
        skippedMalformedLineCount: 0,
      });
      expectReplayAuditInvariant(crlfReplay.replayAudit);

      const utf8Path = join(workspace, 'split-utf8.jsonl');
      const utf8 = tickEvidenceJsonWithUtf8MarkerAtByteIndex(
        TRAIT_SCHEDULER_TICK_EVIDENCE_REPLAY_TEST_CHUNK_BYTES - 1,
      );
      const utf8Content = `${utf8.json}\n`;
      writeFileSync(utf8Path, utf8Content, 'utf8');

      const utf8Replay = new JsonlTraitSchedulerTickEvidenceLedger(
        utf8Path,
      ).loadWithAudit({ maxBytes: Buffer.byteLength(utf8Content, 'utf8') });

      expect(utf8Replay.records).toEqual([utf8.record]);
      expect(utf8Replay.records[0]?.source?.endsWith(utf8.marker)).toBe(true);
      expect(utf8Replay.replayAudit).toEqual({
        source: 'jsonl',
        totalLineCount: 1,
        emptyLineCount: 0,
        parsedRecordCount: 1,
        skippedMalformedLineCount: 0,
      });
      expectReplayAuditInvariant(utf8Replay.replayAudit);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('pins maxBytes behavior at the JSONL replay chunk-size boundary', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-evidence-boundary-'));
    try {
      const filePath = join(workspace, 'chunk-sized-record.jsonl');
      const chunkSized = tickEvidenceJsonWithPaddedSource(
        TRAIT_SCHEDULER_TICK_EVIDENCE_REPLAY_TEST_CHUNK_BYTES,
        'chunk-sized-record',
        'chunk-sized-',
      );
      writeFileSync(filePath, chunkSized.json, 'utf8');
      const ledger = new JsonlTraitSchedulerTickEvidenceLedger(filePath);

      expect(
        ledger.loadWithAudit({
          maxBytes: TRAIT_SCHEDULER_TICK_EVIDENCE_REPLAY_TEST_CHUNK_BYTES,
        }).records,
      ).toEqual([chunkSized.record]);
      expect(
        ledger.loadWithAudit({
          maxBytes: TRAIT_SCHEDULER_TICK_EVIDENCE_REPLAY_TEST_CHUNK_BYTES + 1,
        }).records,
      ).toEqual([chunkSized.record]);
      expect(() =>
        ledger.loadWithAudit({
          maxBytes: TRAIT_SCHEDULER_TICK_EVIDENCE_REPLAY_TEST_CHUNK_BYTES - 1,
        }),
      ).toThrow(/exceeds maxBytes/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('records skipped lease-held evidence before stores or dispatch are invoked', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-evidence-skip-'));
    try {
      const leasePath = join(workspace, 'tick.lock');
      const holder = new JsonFileTraitSchedulerTickLease(leasePath, {
        ownerId: 'holder',
        ttlMs: 60_000,
        now: () => '2026-05-05T09:00:00.000Z',
      });
      const held = holder.acquire();
      if (held.status !== 'acquired') throw new Error('expected held setup');
      const contender = new JsonFileTraitSchedulerTickLease(leasePath, {
        ownerId: 'contender',
        ttlMs: 60_000,
        now: () => '2026-05-05T09:00:01.000Z',
      });
      const evidenceLedger = new InMemoryTraitSchedulerTickEvidenceLedger();
      let storeLoads = 0;
      let dispatchCount = 0;

      const result = await runTraitSchedulerTickOnceWithLeaseAndEvidence({
        lease: contender,
        evidenceLedger,
        evidence: {
          recordId: 'tick-record-skip',
          recordedAt: '2026-05-05T09:00:02.000Z',
          source: 'unit-test',
        },
        schedulerStore: {
          load: () => {
            storeLoads += 1;
            return state([job()]);
          },
        },
        cursorStore: {
          load: () => {
            storeLoads += 1;
            return {
              schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
              updatedAt: '2026-05-05T08:59:00.000Z',
              lastTickAt: '2026-05-05T08:59:00.000Z',
            };
          },
          save: () => undefined,
        },
        now: '2026-05-05T09:00:30.000Z',
        dispatchClock: () => '2026-05-05T09:00:31.000Z',
        dispatch: () => {
          dispatchCount += 1;
        },
      });

      expect(result.tick).toMatchObject({
        status: 'skipped',
        reason: 'lease-held',
      });
      expect(result.evidence).toMatchObject({
        status: 'recorded',
        record: {
          status: 'skipped',
          reason: 'lease-held',
          lease: {
            status: 'held',
            ownerId: 'holder',
          },
        },
      });
      expect(storeLoads).toBe(0);
      expect(dispatchCount).toBe(0);
      expect(
        filterTraitSchedulerTickEvidenceRecords(evidenceLedger.loadAll(), {
          status: 'skipped',
          source: 'unit-test',
          limit: 1,
        }),
      ).toHaveLength(1);
      holder.release(held);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('reports evidence write failure beside the tick result without changing tick semantics', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-evidence-fail-'));
    try {
      const throwingLedger: TraitSchedulerTickEvidenceLedger = {
        append: () => {
          throw new Error('evidence disk unavailable');
        },
        loadAll: () => [],
      };
      const lease = new JsonFileTraitSchedulerTickLease(join(workspace, 'tick.lock'), {
        ownerId: 'evidence-failure-runner',
        ttlMs: 60_000,
        now: () => '2026-05-05T09:00:00.000Z',
      });

      const result = await runTraitSchedulerTickOnceWithLeaseAndEvidence({
        lease,
        evidenceLedger: throwingLedger,
        schedulerStore: {
          load: () => state([job()]),
        },
        cursorStore: {
          load: () => ({
            schemaVersion: TRAIT_SCHEDULER_TICK_CURSOR_SCHEMA_VERSION,
            updatedAt: '2026-05-05T08:59:00.000Z',
            lastTickAt: '2026-05-05T08:59:00.000Z',
          }),
          save: () => undefined,
        },
        now: '2026-05-05T09:00:30.000Z',
        dispatchClock: () => '2026-05-05T09:00:31.000Z',
        dispatch: () => undefined,
      });

      expect(result.tick).toMatchObject({
        status: 'ran',
        result: {
          batch: {
            attemptedCount: 1,
            dispatchedCount: 1,
          },
        },
      });
      expect(result.evidence).toEqual({
        status: 'failed',
        error: 'evidence disk unavailable',
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('TraitModule scheduler tick evidence report', () => {
  it('builds a read-only reliability scorecard over ran and skipped tick evidence', () => {
    const failedBatch = tickEvidenceRecord({
      recordId: 'tick-record-failed',
      recordedAt: '2026-05-05T09:05:32.000Z',
      batch: {
        planTickedAt: '2026-05-05T09:05:30.000Z',
        windowStartExclusive: '2026-05-05T09:00:00.000Z',
        windowEndInclusive: '2026-05-05T09:05:00.000Z',
        attemptedCount: 2,
        dispatchedCount: 1,
        failedCount: 1,
        skippedPlannedCount: 1,
        truncated: false,
        checkpointStatus: 'hold',
        checkpointHoldReasons: ['dispatch-failed'],
      },
    });
    const skippedLeaseHeld: TraitSchedulerTickEvidenceRecord = {
      schemaVersion: 1,
      recordId: 'tick-record-skip',
      recordedAt: '2026-05-05T09:06:00.000Z',
      source: 'unit-test',
      status: 'skipped',
      reason: 'lease-held',
      lease: {
        status: 'held',
        leasePath: '/tmp/auto-archive/tick.lock',
        ownerId: 'holder',
        observedAt: '2026-05-05T09:06:00.000Z',
      },
    };

    const report = buildTraitSchedulerTickEvidenceReport({
      generatedAt: '2026-05-05T09:10:00.000Z',
      filter: { source: 'unit-test' },
      records: [
        tickEvidenceRecord({ recordId: 'tick-record-ran' }),
        failedBatch,
        skippedLeaseHeld,
      ],
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-05T09:10:00.000Z',
      filter: { source: 'unit-test' },
      scorecard: {
        schemaVersion: 1,
        recordCount: 3,
        sourceCounts: {
          'unit-test': 3,
        },
        statusCounts: {
          ran: 2,
          skipped: 1,
        },
        leaseCounts: {
          acquired: 2,
          held: 1,
          missing: 0,
        },
        checkpointCounts: {
          advance: 1,
          hold: 1,
          missing: 1,
        },
        dispatchTotals: {
          attempted: 3,
          dispatched: 2,
          failed: 1,
          skippedPlanned: 1,
        },
        rates: {
          ran: {
            numerator: 2,
            denominator: 3,
            rate: 0.6667,
          },
          leaseHeldSkip: {
            numerator: 1,
            denominator: 3,
            rate: 0.3333,
          },
          dispatchSuccess: {
            numerator: 2,
            denominator: 3,
            rate: 0.6667,
          },
          dispatchFailureFreeBatch: {
            numerator: 1,
            denominator: 2,
            rate: 0.5,
          },
          checkpointAdvance: {
            numerator: 1,
            denominator: 2,
            rate: 0.5,
          },
        },
        recency: {
          firstRecordedAt: '2026-05-05T09:00:32.000Z',
          lastRecordedAt: '2026-05-05T09:06:00.000Z',
          lastRanRecordedAt: '2026-05-05T09:05:32.000Z',
          lastSkippedRecordedAt: '2026-05-05T09:06:00.000Z',
        },
        confidence: {
          sampleSize: 3,
          minimumRecommendedRecords: TRAIT_SCHEDULER_TICK_EVIDENCE_MIN_RECORDS_FOR_TREND,
          sufficientForTrend: false,
        },
      },
    });
    expect(report.scorecard.qualityScore).toMatchObject({
      rubricVersion: TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_RUBRIC_VERSION,
      max: 100,
    });
    expect(report.scorecard.qualityScore.value).toBeCloseTo(58.667, 3);
    expect(report.scorecard.recommendations).toEqual([
      'Collect at least 5 tick evidence records before treating scheduler reliability trends as stable.',
      'Investigate dispatcher failures before advancing scheduler reliability claims.',
      'Review checkpoint hold reasons; held batches keep the prior cursor by design.',
      'Lease-held skips are frequent; reduce overlapping tick sources or share an in-process runner where possible.',
    ]);
  });

  it('applies report filters before scoring and preserves bounded tail semantics', () => {
    const report = buildTraitSchedulerTickEvidenceReport({
      filter: { source: 'target', limit: 2 },
      records: [
        tickEvidenceRecord({
          recordId: 'other-source',
          source: 'other',
          recordedAt: '2026-05-05T09:00:00.000Z',
        }),
        tickEvidenceRecord({
          recordId: 'target-1',
          source: 'target',
          recordedAt: '2026-05-05T09:01:00.000Z',
        }),
        tickEvidenceRecord({
          recordId: 'target-2',
          source: 'target',
          recordedAt: '2026-05-05T09:02:00.000Z',
        }),
        tickEvidenceRecord({
          recordId: 'target-3',
          source: 'target',
          recordedAt: '2026-05-05T09:03:00.000Z',
        }),
      ],
    });

    expect(report.scorecard.recordCount).toBe(2);
    expect(report.scorecard.sourceCounts).toEqual({ target: 2 });
    expect(report.scorecard.recency).toMatchObject({
      firstRecordedAt: '2026-05-05T09:02:00.000Z',
      lastRecordedAt: '2026-05-05T09:03:00.000Z',
    });
  });

  it('surfaces replay audit counters without letting malformed JSONL lines affect scoring', () => {
    const report = buildTraitSchedulerTickEvidenceReport({
      replayAudit: {
        source: 'jsonl',
        totalLineCount: 4,
        emptyLineCount: 1,
        parsedRecordCount: 2,
        skippedMalformedLineCount: 1,
      },
      records: [
        tickEvidenceRecord({
          recordId: 'target-1',
          source: 'target',
          recordedAt: '2026-05-05T09:01:00.000Z',
        }),
        tickEvidenceRecord({
          recordId: 'target-2',
          source: 'target',
          recordedAt: '2026-05-05T09:02:00.000Z',
        }),
      ],
    });

    expect(report.replayAudit).toEqual({
      source: 'jsonl',
      totalLineCount: 4,
      emptyLineCount: 1,
      parsedRecordCount: 2,
      skippedMalformedLineCount: 1,
    });
    if (report.replayAudit !== undefined) {
      expectReplayAuditInvariant(report.replayAudit);
      expect(report.replayAudit.parsedRecordCount).toBe(report.scorecard.recordCount);
    }
    expect(report.scorecard.recordCount).toBe(2);
    expect(report.scorecard.recommendations[0]).toBe(
      'Review 1 malformed/torn JSONL line(s); they were excluded from scoring.',
    );
  });

  it('scores a non-empty input filtered to zero records as no evidence', () => {
    const report = buildTraitSchedulerTickEvidenceReport({
      filter: { source: 'missing-source' },
      records: [
        tickEvidenceRecord({
          recordId: 'target-1',
          source: 'target',
          recordedAt: '2026-05-05T09:01:00.000Z',
        }),
      ],
    });

    expect(report.scorecard).toMatchObject({
      recordCount: 0,
      sourceCounts: {},
      statusCounts: {
        ran: 0,
        skipped: 0,
      },
      confidence: {
        sufficientForTrend: false,
      },
    });
    expect(report.scorecard.recommendations).toContain(
      'No scheduler tick evidence records are available; run explicit host-invoked ticks with evidence enabled.',
    );
  });

  it('gates trend confidence at the documented minimum record count boundary', () => {
    const almostEnough = Array.from(
      { length: TRAIT_SCHEDULER_TICK_EVIDENCE_MIN_RECORDS_FOR_TREND - 1 },
      (_, index) =>
        tickEvidenceRecord({
          recordId: `almost-${String(index)}`,
          recordedAt: `2026-05-05T09:0${String(index)}:00.000Z`,
        }),
    );
    const enough = [
      ...almostEnough,
      tickEvidenceRecord({
        recordId: 'enough-boundary',
        recordedAt: '2026-05-05T09:04:00.000Z',
      }),
    ];

    expect(
      buildTraitSchedulerTickEvidenceReport({ records: almostEnough }).scorecard.confidence,
    ).toMatchObject({
      sampleSize: 4,
      sufficientForTrend: false,
    });
    expect(
      buildTraitSchedulerTickEvidenceReport({ records: enough }).scorecard.confidence,
    ).toMatchObject({
      sampleSize: 5,
      sufficientForTrend: true,
    });
  });

  it('returns an explicit empty-report recommendation without live-readiness overclaim', () => {
    const report = buildTraitSchedulerTickEvidenceReport({
      records: [],
    });

    expect(report.scorecard).toMatchObject({
      recordCount: 0,
      dispatchTotals: {
        attempted: 0,
        dispatched: 0,
        failed: 0,
      },
      qualityScore: {
        value: 70,
        summary: 'No TraitModule scheduler tick evidence records were available for scoring.',
      },
    });
    expect(report.scorecard.recommendations).toContain(
      'No scheduler tick evidence records are available; run explicit host-invoked ticks with evidence enabled.',
    );
    expect(report.method.promotionRule).toContain('trend evidence');
    expect(report.replayAudit).toBeUndefined();
  });
});
