import type {
  TraitScheduleDeliveryTarget,
  TraitSchedulerJobRecord,
  TraitSchedulerState,
} from '../core/trait-module-loader.js';
import type {
  TraitCronTickObserveHook,
  TraitCronTickPayload,
  TraitCronTickSkipReason,
} from '../contracts/trait-runtime-hook.js';

/**
 * M9 — deterministic one-shot tick planner for TraitModule cron schedules.
 *
 * This module deliberately stops at planning due runs. It does not create a
 * daemon, acquire cross-process locks, execute agents, append ledgers, reload
 * environment variables, or deliver Discord messages. Hosts can call this
 * bounded selector from an operator-owned loop and then dispatch the returned
 * due jobs through their existing task pipeline.
 *
 * Current support is intentionally conservative:
 *   - five-field cron expressions using the same simple subset accepted by
 *     the TraitModule manifest loader (wildcards, step expressions, literals, lists, ranges)
 *   - UTC schedule evaluation only
 *   - standard cron day-of-month/day-of-week matching: when both fields are
 *     restricted, either field may match; otherwise all non-wildcard fields
 *     must match
 *   - deterministic bounded catch-up windows with oldest-to-newest ordering
 */

export const TRAIT_SCHEDULER_TICK_DEFAULT_MAX_DUE_JOBS = 64 as const;
export const TRAIT_SCHEDULER_TICK_DEFAULT_MAX_LOOKBACK_MINUTES = 24 * 60;
export const TRAIT_SCHEDULER_TICK_SUPPORTED_TIMEZONE = 'UTC' as const;

const MINUTE_MS = 60_000;
const ISO_INSTANT_WITH_ZONE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

export type TraitSchedulerTickSkipReason =
  TraitCronTickSkipReason;

export interface TraitSchedulerTickObserveHookBinding {
  readonly moduleId: string;
  readonly moduleVersion: string;
  readonly cronTickObserve: TraitCronTickObserveHook;
}

export interface PlanTraitSchedulerTickOptions {
  /** Scheduler state produced by buildTraitSchedulerDryRun/store load. */
  readonly state: TraitSchedulerState;
  /** Exclusive lower bound. Defaults to the minute immediately before `now`. */
  readonly lastTickAt?: string;
  /** Inclusive upper bound. Defaults to the current wall-clock instant. */
  readonly now?: string;
  /** Maximum due runs returned by one planning call. Defaults to 64. */
  readonly maxDueJobs?: number;
  /** Maximum catch-up horizon in minutes. Defaults to 24h. */
  readonly maxLookbackMinutes?: number;
  /** M5c observe-only hooks fired after the tick plan is finalized. */
  readonly observeHooks?: ReadonlyArray<TraitSchedulerTickObserveHookBinding>;
}

export interface TraitSchedulerDueJob {
  /** Scheduler job snapshot. Mutating this value does not mutate input state. */
  readonly job: TraitSchedulerJobRecord;
  /** UTC minute at which this run is due. */
  readonly dueAt: string;
  /** Deterministic opaque run id suitable for JobOutput.runId. */
  readonly runId: string;
  /** Delivery target copied from the scheduler job for dispatch handoff. */
  readonly deliveryTarget: TraitScheduleDeliveryTarget;
  /** Human-readable summary copied from the schedule declaration. */
  readonly summary: string;
}

export interface TraitSchedulerSkippedJob {
  readonly jobId: string;
  readonly scheduleId: string;
  readonly reason: TraitSchedulerTickSkipReason;
  readonly detail: string;
}

export interface TraitSchedulerTickPlan {
  readonly tickedAt: string;
  readonly windowStartExclusive: string;
  readonly windowEndInclusive: string;
  readonly dueJobs: readonly TraitSchedulerDueJob[];
  readonly skippedJobs: readonly TraitSchedulerSkippedJob[];
  /** True when maxLookbackMinutes or maxDueJobs truncated the result. */
  readonly truncated: boolean;
}

interface CronFieldBounds {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

interface ParsedCronExpression {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

interface CronField {
  readonly values: ReadonlySet<number>;
  readonly wildcard: boolean;
}

const CRON_FIELD_BOUNDS: readonly CronFieldBounds[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 6 },
];

const pendingCronTickObserveHooks = new Set<Promise<void>>();

export function planTraitSchedulerTick(
  options: PlanTraitSchedulerTickOptions,
): TraitSchedulerTickPlan {
  const now = parseInstant(options.now ?? new Date().toISOString(), 'now');
  const endMinuteMs = floorToMinuteMs(now.getTime());
  let startExclusiveMs = options.lastTickAt === undefined
    ? endMinuteMs - MINUTE_MS
    : parseInstant(options.lastTickAt, 'lastTickAt').getTime();

  if (startExclusiveMs > now.getTime()) {
    throw new Error('lastTickAt must be <= now.');
  }

  const maxDueJobs = normalizePositiveInteger(
    options.maxDueJobs,
    TRAIT_SCHEDULER_TICK_DEFAULT_MAX_DUE_JOBS,
    'maxDueJobs',
  );
  const maxLookbackMinutes = normalizePositiveInteger(
    options.maxLookbackMinutes,
    TRAIT_SCHEDULER_TICK_DEFAULT_MAX_LOOKBACK_MINUTES,
    'maxLookbackMinutes',
  );

  let truncated = false;
  const oldestAllowedStartMs = endMinuteMs - maxLookbackMinutes * MINUTE_MS;
  if (startExclusiveMs < oldestAllowedStartMs) {
    startExclusiveMs = oldestAllowedStartMs;
    truncated = true;
  }

  const prepared = prepareJobs(options.state.jobs);
  const dueJobs: TraitSchedulerDueJob[] = [];
  const firstMinuteMs = floorToMinuteMs(startExclusiveMs) + MINUTE_MS;

  for (let minuteMs = firstMinuteMs; minuteMs <= endMinuteMs; minuteMs += MINUTE_MS) {
    const instant = new Date(minuteMs);
    for (const candidate of prepared.runnable) {
      if (!cronMatches(candidate.cron, instant)) {
        continue;
      }
      const dueAt = instant.toISOString();
      dueJobs.push({
        job: cloneJob(candidate.job),
        dueAt,
        runId: buildTraitSchedulerRunId(candidate.job, dueAt),
        deliveryTarget: cloneDeliveryTarget(candidate.job.deliveryTarget),
        summary: candidate.job.summary,
      });
      if (dueJobs.length >= maxDueJobs) {
        truncated = true;
        return finalizeTickPlan(options.observeHooks ?? [], {
          tickedAt: now.toISOString(),
          windowStartExclusive: new Date(startExclusiveMs).toISOString(),
          windowEndInclusive: new Date(endMinuteMs).toISOString(),
          dueJobs,
          skippedJobs: prepared.skipped,
          truncated,
        });
      }
    }
  }

  return finalizeTickPlan(options.observeHooks ?? [], {
    tickedAt: now.toISOString(),
    windowStartExclusive: new Date(startExclusiveMs).toISOString(),
    windowEndInclusive: new Date(endMinuteMs).toISOString(),
    dueJobs,
    skippedJobs: prepared.skipped,
    truncated,
  });
}

export function buildTraitSchedulerRunId(
  job: Pick<TraitSchedulerJobRecord, 'jobId'>,
  dueAt: string,
): string {
  return `${job.jobId}@${dueAt}`;
}

export async function drainPendingCronTickObserveHooks(): Promise<void> {
  if (pendingCronTickObserveHooks.size === 0) return;
  await Promise.allSettled(Array.from(pendingCronTickObserveHooks));
}

function finalizeTickPlan(
  hooks: ReadonlyArray<TraitSchedulerTickObserveHookBinding>,
  plan: TraitSchedulerTickPlan,
): TraitSchedulerTickPlan {
  fireCronTickObserveHooks(hooks, plan);
  return plan;
}

function fireCronTickObserveHooks(
  hooks: ReadonlyArray<TraitSchedulerTickObserveHookBinding>,
  plan: TraitSchedulerTickPlan,
): void {
  if (hooks.length === 0) return;
  const payload = toCronTickObservePayload(plan);
  for (const binding of hooks) {
    const chain: Promise<void> = Promise.resolve()
      .then(() =>
        binding.cronTickObserve(
          {
            moduleId: binding.moduleId as never,
            moduleVersion: binding.moduleVersion,
            observedAt: plan.tickedAt,
          },
          payload,
        ),
      )
      .catch((error: unknown) => {
        console.warn(
          'trait-runtime-hook-threw',
          JSON.stringify({
            hook: 'cronTickObserve',
            moduleId: binding.moduleId,
            tickedAt: plan.tickedAt,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      })
      .finally(() => {
        pendingCronTickObserveHooks.delete(chain);
      });
    pendingCronTickObserveHooks.add(chain);
  }
}

function toCronTickObservePayload(
  plan: TraitSchedulerTickPlan,
): TraitCronTickPayload {
  return {
    tickedAt: plan.tickedAt,
    windowStartExclusive: plan.windowStartExclusive,
    windowEndInclusive: plan.windowEndInclusive,
    dueJobCount: plan.dueJobs.length,
    skippedJobCount: plan.skippedJobs.length,
    truncated: plan.truncated,
    dueRunIds: plan.dueJobs.map((due) => due.runId),
    skippedReasons: summarizeSkippedReasons(plan.skippedJobs),
  };
}

function summarizeSkippedReasons(
  skippedJobs: readonly TraitSchedulerSkippedJob[],
): TraitCronTickPayload['skippedReasons'] {
  const counts = new Map<TraitSchedulerTickSkipReason, number>();
  for (const job of skippedJobs) {
    counts.set(job.reason, (counts.get(job.reason) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => ({ reason, count }));
}

function prepareJobs(jobs: readonly TraitSchedulerJobRecord[]): {
  readonly runnable: readonly {
    readonly job: TraitSchedulerJobRecord;
    readonly cron: ParsedCronExpression;
  }[];
  readonly skipped: readonly TraitSchedulerSkippedJob[];
} {
  const runnable: {
    readonly job: TraitSchedulerJobRecord;
    readonly cron: ParsedCronExpression;
  }[] = [];
  const skipped: TraitSchedulerSkippedJob[] = [];

  for (const job of jobs) {
    if (job.timezone !== TRAIT_SCHEDULER_TICK_SUPPORTED_TIMEZONE) {
      skipped.push({
        jobId: job.jobId,
        scheduleId: job.scheduleId,
        reason: 'unsupported-timezone',
        detail: `timezone '${job.timezone}' is not supported by the one-shot tick planner; only UTC is supported.`,
      });
      continue;
    }
    try {
      runnable.push({ job, cron: parseCronExpression(job.cron) });
    } catch (error) {
      skipped.push({
        jobId: job.jobId,
        scheduleId: job.scheduleId,
        reason: 'invalid-cron',
        detail: error instanceof Error ? error.message : 'cron expression is invalid.',
      });
    }
  }

  return { runnable, skipped };
}

function parseCronExpression(cron: string): ParsedCronExpression {
  const parts = cron.trim().split(/\s+/u);
  if (parts.length !== 5) {
    throw new Error(`cron must have five fields: ${cron}`);
  }
  return {
    minute: parseCronField(parts[0] ?? '', CRON_FIELD_BOUNDS[0]),
    hour: parseCronField(parts[1] ?? '', CRON_FIELD_BOUNDS[1]),
    dayOfMonth: parseCronField(parts[2] ?? '', CRON_FIELD_BOUNDS[2]),
    month: parseCronField(parts[3] ?? '', CRON_FIELD_BOUNDS[3]),
    dayOfWeek: parseCronField(parts[4] ?? '', CRON_FIELD_BOUNDS[4]),
  };
}

function parseCronField(part: string, bounds: CronFieldBounds): CronField {
  if (part === '*') {
    return { values: range(bounds.min, bounds.max), wildcard: true };
  }
  const values = expandCronField(part, bounds);
  return { values, wildcard: false };
}

function expandCronField(part: string, bounds: CronFieldBounds): ReadonlySet<number> {
  const reject = (reason: string): never => {
    throw new Error(
      `cron ${bounds.name} field '${part}' ${reason} (allowed: ${bounds.min}-${bounds.max}).`,
    );
  };

  if (part.startsWith('*/')) {
    const stepRaw = part.slice(2);
    if (!/^\d+$/u.test(stepRaw)) {
      reject('has a malformed step expression');
    }
    const step = Number.parseInt(stepRaw, 10);
    if (!Number.isFinite(step) || step <= 0) {
      reject('has step <= 0');
    }
    if (step > bounds.max) {
      reject('has step exceeding the field range');
    }
    const values = new Set<number>();
    for (let value = bounds.min; value <= bounds.max; value += step) {
      values.add(value);
    }
    return values;
  }

  if (part.includes(',')) {
    const items = part.split(',');
    if (items.length === 0 || items.some((item) => item.length === 0)) {
      reject('has an empty list element');
    }
    const values = new Set<number>();
    for (const item of items) {
      for (const value of expandCronField(item, bounds)) {
        values.add(value);
      }
    }
    return values;
  }

  if (part.includes('-')) {
    const rangeParts = part.split('-');
    if (rangeParts.length !== 2 || rangeParts.some((p) => p.length === 0)) {
      reject('is not a well-formed range');
    }
    const lo = Number.parseInt(rangeParts[0] ?? '', 10);
    const hi = Number.parseInt(rangeParts[1] ?? '', 10);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      reject('has non-numeric range bounds');
    }
    if (lo < bounds.min || hi > bounds.max) {
      reject('range is outside the allowed bounds');
    }
    if (lo > hi) {
      reject('has a reversed range (lo > hi)');
    }
    return range(lo, hi);
  }

  if (!/^\d+$/u.test(part)) {
    reject('is not a recognized cron expression');
  }
  const literal = Number.parseInt(part, 10);
  if (!Number.isFinite(literal)) {
    reject('is not numeric');
  }
  if (literal < bounds.min || literal > bounds.max) {
    reject('is out of range');
  }
  return new Set([literal]);
}

function cronMatches(cron: ParsedCronExpression, instant: Date): boolean {
  if (!cron.minute.values.has(instant.getUTCMinutes())) return false;
  if (!cron.hour.values.has(instant.getUTCHours())) return false;
  if (!cron.month.values.has(instant.getUTCMonth() + 1)) return false;

  const dayOfMonthMatches = cron.dayOfMonth.values.has(instant.getUTCDate());
  const dayOfWeekMatches = cron.dayOfWeek.values.has(instant.getUTCDay());

  if (!cron.dayOfMonth.wildcard && !cron.dayOfWeek.wildcard) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  return dayOfMonthMatches && dayOfWeekMatches;
}

function range(min: number, max: number): ReadonlySet<number> {
  const values = new Set<number>();
  for (let value = min; value <= max; value += 1) {
    values.add(value);
  }
  return values;
}

function parseInstant(value: string, fieldName: string): Date {
  if (!ISO_INSTANT_WITH_ZONE_PATTERN.test(value)) {
    throw new Error(`${fieldName} must be an ISO-8601 instant with timezone.`);
  }
  const parsedMs = Date.parse(value);
  if (!Number.isFinite(parsedMs)) {
    throw new Error(`${fieldName} must be a valid ISO-8601 instant.`);
  }
  return new Date(parsedMs);
}

function floorToMinuteMs(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

function normalizePositiveInteger(
  value: number | undefined,
  defaultValue: number,
  fieldName: string,
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return value;
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
