import { statSync } from 'node:fs';

import {
  JsonFileTraitSchedulerStore,
} from '../core/trait-module-loader.js';
import {
  JsonFileTraitSchedulerCursorStore,
} from './trait-scheduler-dispatch-runner.js';
import {
  planTraitSchedulerTick,
  TRAIT_SCHEDULER_TICK_DEFAULT_MAX_DUE_JOBS,
  TRAIT_SCHEDULER_TICK_DEFAULT_MAX_LOOKBACK_MINUTES,
  type TraitSchedulerTickPlan,
} from './trait-scheduler-tick.js';

export interface TraitSchedulerPlanCliIo {
  readonly stdout: {
    write(chunk: string): void;
  };
  readonly stderr: {
    write(chunk: string): void;
  };
}

export interface TraitSchedulerPlanCliOptions {
  readonly statePath: string;
  readonly cursorPath?: string;
  readonly now?: string;
  readonly maxDueJobs: number;
  readonly maxLookbackMinutes: number;
  readonly maxStateBytes: number;
  readonly maxCursorBytes: number;
  readonly pretty: boolean;
}

export const TRAIT_SCHEDULER_PLAN_CLI_DEFAULT_MAX_STATE_BYTES =
  10 * 1024 * 1024;
export const TRAIT_SCHEDULER_PLAN_CLI_DEFAULT_MAX_CURSOR_BYTES =
  1024 * 1024;

const USAGE = `Usage: pnpm trait:scheduler:plan -- --state <path> [options]

Preview the next TraitModule scheduler tick from a persisted scheduler state file.
The output is the same bounded due-job plan shape used by the host-owned tick
runner, including dueJobs, skippedJobs, truncated, and the planned time window.

Options:
  --state <path>                 Required existing TraitSchedulerState JSON path.
  --cursor <path>                Optional TraitSchedulerTickCursorState JSON path; missing path means no prior cursor.
  --now <iso>                    Optional ISO-8601 UTC timestamp for deterministic planning.
  --max-due-jobs <n>             Maximum due jobs to include (default: ${String(TRAIT_SCHEDULER_TICK_DEFAULT_MAX_DUE_JOBS)}).
  --max-lookback-minutes <n>     Maximum catch-up horizon in minutes (default: ${String(TRAIT_SCHEDULER_TICK_DEFAULT_MAX_LOOKBACK_MINUTES)}).
  --max-state-bytes <n>          Fail closed if the state file exceeds this many bytes (default: ${String(TRAIT_SCHEDULER_PLAN_CLI_DEFAULT_MAX_STATE_BYTES)}).
  --max-cursor-bytes <n>         Fail closed if the cursor file exceeds this many bytes (default: ${String(TRAIT_SCHEDULER_PLAN_CLI_DEFAULT_MAX_CURSOR_BYTES)}).
  --pretty                      Pretty-print JSON output.
  --help                        Show this help text.

Boundary:
  This command is read-only. It does not dispatch jobs, save cursors, acquire
  leases, append evidence, reload environment variables, daemonize, or contact
  Discord/GitLab/provider services.
`;

export function parseTraitSchedulerPlanCliArgs(
  argv: readonly string[],
): TraitSchedulerPlanCliOptions | 'help' {
  let statePath: string | undefined;
  let cursorPath: string | undefined;
  let now: string | undefined;
  let maxDueJobs: number = TRAIT_SCHEDULER_TICK_DEFAULT_MAX_DUE_JOBS;
  let maxLookbackMinutes: number =
    TRAIT_SCHEDULER_TICK_DEFAULT_MAX_LOOKBACK_MINUTES;
  let maxStateBytes = TRAIT_SCHEDULER_PLAN_CLI_DEFAULT_MAX_STATE_BYTES;
  let maxCursorBytes = TRAIT_SCHEDULER_PLAN_CLI_DEFAULT_MAX_CURSOR_BYTES;
  let pretty = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--':
        break;
      case '--help':
      case '-h':
        return 'help';
      case '--pretty':
        pretty = true;
        break;
      case '--state':
        statePath = requireCliValue(argv, index, '--state');
        index += 1;
        break;
      case '--cursor':
        cursorPath = requireCliValue(argv, index, '--cursor');
        index += 1;
        break;
      case '--now':
        now = requireCliValue(argv, index, '--now');
        if (!isIsoInstant(now)) {
          throw new Error('--now must be a valid ISO-8601 UTC timestamp.');
        }
        index += 1;
        break;
      case '--max-due-jobs':
        maxDueJobs = requirePositiveSafeInteger(
          requireCliValue(argv, index, '--max-due-jobs'),
          '--max-due-jobs',
        );
        index += 1;
        break;
      case '--max-lookback-minutes':
        maxLookbackMinutes = requirePositiveSafeInteger(
          requireCliValue(argv, index, '--max-lookback-minutes'),
          '--max-lookback-minutes',
        );
        index += 1;
        break;
      case '--max-state-bytes':
        maxStateBytes = requirePositiveSafeInteger(
          requireCliValue(argv, index, '--max-state-bytes'),
          '--max-state-bytes',
        );
        index += 1;
        break;
      case '--max-cursor-bytes':
        maxCursorBytes = requirePositiveSafeInteger(
          requireCliValue(argv, index, '--max-cursor-bytes'),
          '--max-cursor-bytes',
        );
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg ?? '(missing)'}.`);
    }
  }

  if (statePath === undefined || statePath.length === 0) {
    throw new Error('--state is required.');
  }

  return {
    statePath,
    ...(cursorPath === undefined ? {} : { cursorPath }),
    ...(now === undefined ? {} : { now }),
    maxDueJobs,
    maxLookbackMinutes,
    maxStateBytes,
    maxCursorBytes,
    pretty,
  };
}

export function buildTraitSchedulerPlanFromCliOptions(
  options: TraitSchedulerPlanCliOptions,
): TraitSchedulerTickPlan {
  assertReadableFileWithinByteLimit(
    options.statePath,
    '--state',
    options.maxStateBytes,
  );
  if (options.cursorPath !== undefined) {
    assertReadableFileWithinByteLimit(
      options.cursorPath,
      '--cursor',
      options.maxCursorBytes,
    );
  }

  const state = new JsonFileTraitSchedulerStore(options.statePath).load();
  const cursor = options.cursorPath === undefined
    ? undefined
    : new JsonFileTraitSchedulerCursorStore(options.cursorPath).load();

  return planTraitSchedulerTick({
    state,
    ...(cursor?.lastTickAt === undefined ? {} : { lastTickAt: cursor.lastTickAt }),
    ...(options.now === undefined ? {} : { now: options.now }),
    maxDueJobs: options.maxDueJobs,
    maxLookbackMinutes: options.maxLookbackMinutes,
  });
}

export function runTraitSchedulerPlanCli(
  argv: readonly string[],
  io: TraitSchedulerPlanCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  try {
    const options = parseTraitSchedulerPlanCliArgs(argv);
    if (options === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    const plan = buildTraitSchedulerPlanFromCliOptions(options);
    io.stdout.write(
      `${JSON.stringify(plan, null, options.pretty ? 2 : undefined)}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(
      `trait:scheduler:plan failed: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    );
    return 1;
  }
}

function assertReadableFileWithinByteLimit(
  filePath: string,
  optionName: string,
  maxBytes: number,
): void {
  let stats;
  try {
    stats = statSync(filePath);
  } catch (error) {
    throw new Error(`${optionName} path does not exist: ${filePath}`, {
      cause: error,
    });
  }
  if (!stats.isFile()) {
    throw new Error(`${optionName} path is not a file: ${filePath}`);
  }
  if (stats.size > maxBytes) {
    throw new Error(
      `${optionName} path exceeds byte guard: ${String(stats.size)} > ${String(maxBytes)}.`,
    );
  }
}

function requireCliValue(
  argv: readonly string[],
  index: number,
  optionName: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function requirePositiveSafeInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive safe integer.`);
  }
  return parsed;
}

function isIsoInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    return false;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return false;
  }
  const canonicalInput = value.includes('.') ? value : value.replace(/Z$/u, '.000Z');
  return date.toISOString() === canonicalInput;
}
