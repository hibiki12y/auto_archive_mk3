import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseTraitSchedulerPlanCliArgs,
  runTraitSchedulerPlanCli,
  TRAIT_SCHEDULER_PLAN_CLI_DEFAULT_MAX_CURSOR_BYTES,
  TRAIT_SCHEDULER_PLAN_CLI_DEFAULT_MAX_STATE_BYTES,
  TRAIT_SCHEDULER_TICK_DEFAULT_MAX_DUE_JOBS,
  TRAIT_SCHEDULER_TICK_DEFAULT_MAX_LOOKBACK_MINUTES,
} from '../src/index.js';

function makeIo(): {
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
  stdoutText(): string;
  stderrText(): string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: {
      write: (chunk: string) => {
        stdout.push(chunk);
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr.push(chunk);
      },
    },
    stdoutText: () => stdout.join(''),
    stderrText: () => stderr.join(''),
  };
}

function schedulerStateJson(): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      updatedAt: '2026-05-05T08:58:00.000Z',
      jobs: [
        {
          schemaVersion: 1,
          jobId: 'trait.research.autonomous-goal-loop.v1:1.0.0:heartbeat',
          moduleId: 'trait.research.autonomous-goal-loop.v1',
          moduleVersion: '1.0.0',
          scheduleId: 'heartbeat',
          cron: '* * * * *',
          timezone: 'UTC',
          delivery: 'isolated-session',
          deliveryTarget: {
            kind: 'isolated-session',
            sessionKey:
              'trait-schedule:trait.research.autonomous-goal-loop.v1:heartbeat',
          },
          summary: 'Autonomous research heartbeat preview',
          state: 'scheduled',
          maxRetries: 3,
          retentionDays: 30,
          createdAt: '2026-05-05T08:58:00.000Z',
          updatedAt: '2026-05-05T08:58:00.000Z',
        },
      ],
    },
    null,
    2,
  );
}

function cursorJson(): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      updatedAt: '2026-05-05T08:59:10.000Z',
      lastTickAt: '2026-05-05T08:59:00.000Z',
    },
    null,
    2,
  );
}

describe('TraitModule scheduler plan CLI', () => {
  it('previews a bounded due-job plan without mutating state or cursor files', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-scheduler-plan-cli-'));
    try {
      const statePath = join(workspace, 'scheduler-state.json');
      const cursorPath = join(workspace, 'scheduler-cursor.json');
      writeFileSync(statePath, schedulerStateJson(), 'utf8');
      writeFileSync(cursorPath, cursorJson(), 'utf8');
      const originalState = readFileSync(statePath, 'utf8');
      const originalCursor = readFileSync(cursorPath, 'utf8');
      const originalEntries = readdirSync(workspace).sort();
      const io = makeIo();

      const exitCode = runTraitSchedulerPlanCli(
        [
          '--state',
          statePath,
          '--cursor',
          cursorPath,
          '--now',
          '2026-05-05T09:00:30.000Z',
          '--max-due-jobs',
          '4',
          '--max-lookback-minutes',
          '5',
          '--pretty',
        ],
        io,
      );

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe('');
      const plan = JSON.parse(io.stdoutText()) as {
        readonly tickedAt: string;
        readonly windowStartExclusive: string;
        readonly windowEndInclusive: string;
        readonly dueJobs: readonly { readonly runId: string; readonly dueAt: string }[];
        readonly skippedJobs: readonly unknown[];
        readonly truncated: boolean;
      };
      expect(plan).toMatchObject({
        tickedAt: '2026-05-05T09:00:30.000Z',
        windowStartExclusive: '2026-05-05T08:59:00.000Z',
        windowEndInclusive: '2026-05-05T09:00:00.000Z',
        truncated: false,
      });
      expect(plan.dueJobs).toHaveLength(1);
      expect(plan.dueJobs[0]?.dueAt).toBe('2026-05-05T09:00:00.000Z');
      expect(plan.dueJobs[0]?.runId).toContain('@2026-05-05T09:00:00.000Z');
      expect(plan.skippedJobs).toEqual([]);
      expect(readFileSync(statePath, 'utf8')).toBe(originalState);
      expect(readFileSync(cursorPath, 'utf8')).toBe(originalCursor);
      expect(readdirSync(workspace).sort()).toEqual(originalEntries);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('prints help and default bounded planning options', () => {
    const io = makeIo();

    const exitCode = runTraitSchedulerPlanCli(['--help'], io);

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    expect(io.stdoutText()).toContain('Usage: pnpm trait:scheduler:plan');
    expect(io.stdoutText()).toContain('This command is read-only.');
    expect(io.stdoutText()).toContain(
      `--max-due-jobs <n>             Maximum due jobs to include (default: ${String(TRAIT_SCHEDULER_TICK_DEFAULT_MAX_DUE_JOBS)}).`,
    );
    expect(io.stdoutText()).toContain(
      `--max-lookback-minutes <n>     Maximum catch-up horizon in minutes (default: ${String(TRAIT_SCHEDULER_TICK_DEFAULT_MAX_LOOKBACK_MINUTES)}).`,
    );
  });

  it('fails closed for invalid arguments and file byte guards', () => {
    expect(() => parseTraitSchedulerPlanCliArgs([])).toThrow(/--state is required/);
    expect(() =>
      parseTraitSchedulerPlanCliArgs(['--state', 'state.json', '--unknown']),
    ).toThrow(/Unknown argument: --unknown/);
    expect(() =>
      parseTraitSchedulerPlanCliArgs(['--state', 'state.json', '--now', '2026-05-05T09:00:00+09:00']),
    ).toThrow(/--now must be a valid ISO-8601 UTC timestamp/);
    for (const invalid of ['0', '-1', '1.5', 'abc', String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() =>
        parseTraitSchedulerPlanCliArgs(['--state', 'state.json', '--max-due-jobs', invalid]),
      ).toThrow(/--max-due-jobs must be a positive safe integer/);
      expect(() =>
        parseTraitSchedulerPlanCliArgs(['--state', 'state.json', '--max-state-bytes', invalid]),
      ).toThrow(/--max-state-bytes must be a positive safe integer/);
      expect(() =>
        parseTraitSchedulerPlanCliArgs(['--state', 'state.json', '--max-cursor-bytes', invalid]),
      ).toThrow(/--max-cursor-bytes must be a positive safe integer/);
    }

    expect(parseTraitSchedulerPlanCliArgs(['--state', 'state.json'])).toMatchObject({
      maxStateBytes: TRAIT_SCHEDULER_PLAN_CLI_DEFAULT_MAX_STATE_BYTES,
      maxCursorBytes: TRAIT_SCHEDULER_PLAN_CLI_DEFAULT_MAX_CURSOR_BYTES,
    });

    const workspace = mkdtempSync(join(tmpdir(), 'trait-scheduler-plan-cli-guard-'));
    try {
      const statePath = join(workspace, 'scheduler-state.json');
      writeFileSync(statePath, schedulerStateJson(), 'utf8');
      const missingIo = makeIo();

      const missingExit = runTraitSchedulerPlanCli(
        ['--state', join(workspace, 'missing.json')],
        missingIo,
      );

      expect(missingExit).toBe(1);
      expect(missingIo.stdoutText()).toBe('');
      expect(missingIo.stderrText()).toContain('--state path does not exist');

      const directoryIo = makeIo();
      const directoryExit = runTraitSchedulerPlanCli(['--state', workspace], directoryIo);

      expect(directoryExit).toBe(1);
      expect(directoryIo.stdoutText()).toBe('');
      expect(directoryIo.stderrText()).toContain('--state path is not a file');

      const guardIo = makeIo();
      const guardExit = runTraitSchedulerPlanCli(
        ['--state', statePath, '--max-state-bytes', '1'],
        guardIo,
      );

      expect(guardExit).toBe(1);
      expect(guardIo.stdoutText()).toBe('');
      expect(guardIo.stderrText()).toContain('--state path exceeds byte guard');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
