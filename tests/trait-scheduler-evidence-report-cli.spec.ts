import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildTraitSchedulerTickEvidenceReportFromCliOptions,
  parseTraitSchedulerTickEvidenceRecord,
  parseTraitSchedulerTickEvidenceReportCliArgs,
  runTraitSchedulerTickEvidenceReportCli,
  TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
  TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_RUBRIC_VERSION,
} from '../src/index.js';

function validTickEvidenceJson(recordId: string, source: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    recordId,
    recordedAt: '2026-05-05T09:00:32.000Z',
    source,
    status: 'ran',
    lease: {
      status: 'acquired',
      leasePath: '/tmp/auto-archive/tick.lock',
      ownerId: 'cli-runner',
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
  });
}

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

function expectReplayAuditInvariant(replayAudit: {
  readonly totalLineCount: number;
  readonly emptyLineCount: number;
  readonly parsedRecordCount: number;
  readonly skippedMalformedLineCount: number;
}): void {
  expect(replayAudit.totalLineCount).toBe(
    replayAudit.emptyLineCount +
      replayAudit.parsedRecordCount +
      replayAudit.skippedMalformedLineCount,
  );
}

describe('TraitModule scheduler tick evidence report CLI', () => {
  it('builds a read-only JSON report from a JSONL ledger with filters', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-report-cli-'));
    try {
      const ledgerPath = join(workspace, 'tick-evidence.jsonl');
      writeFileSync(
        ledgerPath,
        `${validTickEvidenceJson('other-record', 'other')}\n${validTickEvidenceJson('cli-record-1', 'cli-test')}\n${validTickEvidenceJson('cli-record-2', 'cli-test')}\n{"schemaVersion":1,"recordId":"invalid-shape"}\n{"schemaVersion":1,"recordId":"torn"`,
        'utf8',
      );
      const originalLedgerContent = readFileSync(ledgerPath, 'utf8');
      const originalWorkspaceEntries = readdirSync(workspace).sort();
      const argv = [
        '--',
        '--ledger',
        ledgerPath,
        '--source',
        'cli-test',
        '--max-ledger-bytes',
        '10000',
        '--limit',
        '1',
        '--generated-at',
        '2026-05-05T09:10:00.000Z',
        '--pretty',
      ] as const;
      const io = makeIo();

      const exitCode = runTraitSchedulerTickEvidenceReportCli(argv, io);

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe('');
      const report = JSON.parse(io.stdoutText()) as {
        readonly generatedAt: string;
        readonly filter: { readonly source?: string; readonly limit?: number };
        readonly replayAudit: {
          readonly totalLineCount: number;
          readonly emptyLineCount: number;
          readonly parsedRecordCount: number;
          readonly skippedMalformedLineCount: number;
        };
        readonly scorecard: {
          readonly recordCount: number;
          readonly sourceCounts: Record<string, number>;
          readonly qualityScore: { readonly rubricVersion: string };
          readonly recommendations: readonly string[];
        };
      };
      expect(report.generatedAt).toBe('2026-05-05T09:10:00.000Z');
      expect(report.filter).toEqual({ source: 'cli-test', limit: 1 });
      expect(report.replayAudit).toEqual({
        source: 'jsonl',
        totalLineCount: 5,
        emptyLineCount: 0,
        parsedRecordCount: 3,
        skippedMalformedLineCount: 2,
      });
      expectReplayAuditInvariant(report.replayAudit);
      expect(report.scorecard.recordCount).toBe(1);
      expect(report.scorecard.sourceCounts).toEqual({ 'cli-test': 1 });
      expect(report.scorecard.qualityScore.rubricVersion).toBe(
        TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_RUBRIC_VERSION,
      );
      expect(report.scorecard.recommendations[0]).toBe(
        'Review 2 malformed/torn JSONL line(s); they were excluded from scoring.',
      );
      expect(readFileSync(ledgerPath, 'utf8')).toBe(originalLedgerContent);
      expect(readdirSync(workspace).sort()).toEqual(originalWorkspaceEntries);

      const secondIo = makeIo();
      const secondExitCode = runTraitSchedulerTickEvidenceReportCli(argv, secondIo);

      expect(secondExitCode).toBe(0);
      expect(secondIo.stderrText()).toBe('');
      expect(secondIo.stdoutText()).toBe(io.stdoutText());
      expect(readFileSync(ledgerPath, 'utf8')).toBe(originalLedgerContent);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });


  it('prints a compact non-promoting JSONL evidence template', () => {
    const io = makeIo();

    const exitCode = runTraitSchedulerTickEvidenceReportCli(
      [
        '--print-template',
        '--generated-at',
        '2026-05-05T09:10:00.000Z',
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    expect(io.stdoutText().split('\n')).toHaveLength(2);
    const [line, trailing] = io.stdoutText().split('\n');
    expect(trailing).toBe('');
    expect(line).toBe(JSON.stringify(JSON.parse(line ?? '{}')));
    const rawRecord = JSON.parse(io.stdoutText()) as unknown;
    const record = parseTraitSchedulerTickEvidenceRecord(rawRecord);
    const expectedRecord = {
      schemaVersion: 1,
      recordId: 'trait-scheduler-tick-evidence-template',
      recordedAt: '2026-05-05T09:10:00.000Z',
      source: 'trait-scheduler-evidence-template',
      status: 'ran',
      lease: {
        status: 'acquired',
        leasePath: 'replace-with-operator-owned-lease-path',
        ownerId: 'template-operator',
        acquiredAt: '2026-05-05T09:10:00.000Z',
        expiresAt: '2026-05-05T09:11:00.000Z',
      },
      batch: {
        planTickedAt: '2026-05-05T09:10:00.000Z',
        windowStartExclusive: '2026-05-05T09:09:00.000Z',
        windowEndInclusive: '2026-05-05T09:10:00.000Z',
        attemptedCount: 1,
        dispatchedCount: 0,
        failedCount: 1,
        skippedPlannedCount: 0,
        truncated: false,
        checkpointStatus: 'hold',
        checkpointHoldReasons: ['dispatch-failed'],
      },
    } as const;
    expect(record).toEqual(expectedRecord);
    expect(io.stdoutText()).toBe(`${JSON.stringify(expectedRecord)}\n`);
    expect(io.stdoutText()).not.toContain('SECRET');
    expect(io.stdoutText()).not.toContain('raw prompt');

    const secondIo = makeIo();
    expect(
      runTraitSchedulerTickEvidenceReportCli(
        [
          '--print-template',
          '--generated-at',
          '2026-05-05T09:10:00.000Z',
        ],
        secondIo,
      ),
    ).toBe(0);
    expect(secondIo.stderrText()).toBe('');
    expect(secondIo.stdoutText()).toBe(io.stdoutText());

    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-template-cli-'));
    try {
      const ledgerPath = join(workspace, 'tick-evidence.jsonl');
      writeFileSync(ledgerPath, io.stdoutText(), 'utf8');
      const reportIo = makeIo();

      const reportExitCode = runTraitSchedulerTickEvidenceReportCli(
        [
          '--ledger',
          ledgerPath,
          '--generated-at',
          '2026-05-05T09:12:00.000Z',
        ],
        reportIo,
      );

      expect(reportExitCode).toBe(0);
      const report = JSON.parse(reportIo.stdoutText()) as {
        readonly replayAudit: { readonly parsedRecordCount: number };
        readonly scorecard: {
          readonly recordCount: number;
          readonly sourceCounts: Record<string, number>;
          readonly dispatchTotals: { readonly failed: number };
          readonly checkpointCounts: { readonly hold: number };
          readonly confidence: { readonly sufficientForTrend: boolean };
          readonly qualityScore: { readonly value: number };
          readonly recommendations: readonly string[];
        };
      };
      expect(report.replayAudit.parsedRecordCount).toBe(1);
      expect(report.scorecard.recordCount).toBe(1);
      expect(report.scorecard.sourceCounts).toEqual({
        'trait-scheduler-evidence-template': 1,
      });
      expect(report.scorecard.dispatchTotals.failed).toBe(1);
      expect(report.scorecard.checkpointCounts.hold).toBe(1);
      expect(report.scorecard.confidence.sufficientForTrend).toBe(false);
      expect(report.scorecard.qualityScore.value).toBeLessThan(100);
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'dispatcher failures',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('prints a now-based non-promoting template when generatedAt is omitted', () => {
    const io = makeIo();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T09:15:00.000Z'));
    try {
      const exitCode = runTraitSchedulerTickEvidenceReportCli(
        ['--print-template'],
        io,
      );

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe('');
      const [line, trailing] = io.stdoutText().split('\n');
      expect(trailing).toBe('');
      expect(line).toBe(JSON.stringify(JSON.parse(line ?? '{}')));
      const record = parseTraitSchedulerTickEvidenceRecord(
        JSON.parse(io.stdoutText()) as unknown,
      );
      if (
        record === undefined ||
        record.lease === undefined ||
        record.batch === undefined
      ) {
        throw new Error('expected a schema-valid Trait scheduler evidence template');
      }
      expect(record.recordedAt).toBe('2026-05-05T09:15:00.000Z');
      expect(record.lease.acquiredAt).toBe('2026-05-05T09:15:00.000Z');
      expect(record.lease.expiresAt).toBe('2026-05-05T09:16:00.000Z');
      expect(record.batch.windowStartExclusive).toBe(
        '2026-05-05T09:14:00.000Z',
      );
      expect(record.batch.checkpointStatus).toBe('hold');
      expect(record.batch.failedCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed for template/report mode conflicts and report builder misuse', () => {
    const ledgerConflictIo = makeIo();
    expect(
      runTraitSchedulerTickEvidenceReportCli(
        ['--print-template', '--ledger', 'tick-evidence.jsonl'],
        ledgerConflictIo,
      ),
    ).toBe(1);
    expect(ledgerConflictIo.stderrText()).toContain(
      '--print-template cannot be combined with --ledger',
    );

    const prettyConflictIo = makeIo();
    expect(
      runTraitSchedulerTickEvidenceReportCli(['--print-template', '--pretty'], prettyConflictIo),
    ).toBe(1);
    expect(prettyConflictIo.stderrText()).toContain(
      '--print-template cannot be combined with report-only options',
    );

    expect(() =>
      parseTraitSchedulerTickEvidenceReportCliArgs([
        '--print-template',
        '--generated-at',
        'not-iso',
      ]),
    ).toThrow(/--generated-at must be a valid ISO-8601 UTC timestamp/);
    for (const invalidGeneratedAt of [
      '2026-05-05',
      'now',
      '1777972200000',
      '2026-05-05T09:10:00.000+09:00',
    ]) {
      expect(() =>
        parseTraitSchedulerTickEvidenceReportCliArgs([
          '--print-template',
          '--generated-at',
          invalidGeneratedAt,
        ]),
      ).toThrow(/--generated-at must be a valid ISO-8601 UTC timestamp/);
    }

    expect(() =>
      buildTraitSchedulerTickEvidenceReportFromCliOptions({
        filter: {},
        maxLedgerBytes:
          TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
        pretty: false,
        printTemplate: true,
      }),
    ).toThrow(
      /Cannot build a Trait scheduler tick evidence report from --print-template options/,
    );
  });

  it('prints help without requiring a ledger path', () => {
    const io = makeIo();

    const exitCode = runTraitSchedulerTickEvidenceReportCli(['--help'], io);

    expect(exitCode).toBe(0);
    expect(io.stdoutText()).toContain('Usage: pnpm trait:scheduler:evidence:report');
    expect(io.stdoutText()).toContain('--print-template');
    expect(io.stdoutText()).toContain('This command is read-only.');
    expect(io.stdoutText()).toContain('malformed or torn JSONL');
    expect(io.stdoutText()).toContain(
      `--max-ledger-bytes <n> Fail closed during bounded replay beyond this many bytes (default: ${String(TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES)}).`,
    );
    expect(io.stderrText()).toBe('');
  });

  it('fails closed for missing required arguments and invalid filter values', () => {
    expect(() => parseTraitSchedulerTickEvidenceReportCliArgs([])).toThrow(
      /--ledger is required/,
    );
    expect(() =>
      parseTraitSchedulerTickEvidenceReportCliArgs([
        '--print-template',
        '--ledger',
        'ledger.jsonl',
      ]),
    ).toThrow(/--print-template cannot be combined with --ledger/);
    expect(() =>
      parseTraitSchedulerTickEvidenceReportCliArgs([
        '--print-template',
        '--source',
        'template',
      ]),
    ).toThrow(/--print-template cannot be combined with report-only options/);
    expect(() =>
      parseTraitSchedulerTickEvidenceReportCliArgs([
        '--ledger',
        'ledger.jsonl',
        '--statuts',
        'ran',
      ]),
    ).toThrow(/Unknown argument: --statuts/);
    expect(() =>
      parseTraitSchedulerTickEvidenceReportCliArgs([
        '--ledger',
        'ledger.jsonl',
        '--status',
        'unknown',
      ]),
    ).toThrow(/--status must be one of/);
    expect(() =>
      parseTraitSchedulerTickEvidenceReportCliArgs([
        '--ledger',
        'ledger.jsonl',
        '--limit',
        '-1',
      ]),
    ).toThrow(/--limit must be a non-negative integer/);
    for (const invalidMaxLedgerBytes of [
      '0',
      '-1',
      '1.5',
      'abc',
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      expect(() =>
        parseTraitSchedulerTickEvidenceReportCliArgs([
          '--ledger',
          'ledger.jsonl',
          '--max-ledger-bytes',
          invalidMaxLedgerBytes,
        ]),
      ).toThrow(/--max-ledger-bytes must be a positive safe integer/);
    }
    expect(() =>
      parseTraitSchedulerTickEvidenceReportCliArgs([
        '--ledger',
        'ledger.jsonl',
        '--generated-at',
        'not-an-iso-instant',
      ]),
    ).toThrow(/--generated-at must be a valid ISO-8601 UTC timestamp/);
    expect(() =>
      parseTraitSchedulerTickEvidenceReportCliArgs([
        '--ledger',
        'ledger.jsonl',
        '--generated-at',
        '2026-02-30T00:00:00Z',
      ]),
    ).toThrow(/--generated-at must be a valid ISO-8601 UTC timestamp/);
    expect(() =>
      parseTraitSchedulerTickEvidenceReportCliArgs([
        '--ledger',
        'ledger.jsonl',
        '--generated-at',
        '2026-05-05T00:00:00+09:00',
      ]),
    ).toThrow(/--generated-at must be a valid ISO-8601 UTC timestamp/);

    const io = makeIo();
    const exitCode = runTraitSchedulerTickEvidenceReportCli([], io);

    expect(exitCode).toBe(1);
    expect(io.stdoutText()).toBe('');
    expect(io.stderrText()).toContain('--ledger is required');
  });

  it('uses a default ledger byte guard and lets operators override it', () => {
    expect(
      parseTraitSchedulerTickEvidenceReportCliArgs([
        '--ledger',
        'ledger.jsonl',
      ]),
    ).toMatchObject({
      maxLedgerBytes: TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
    });
    expect(
      parseTraitSchedulerTickEvidenceReportCliArgs([
        '--ledger',
        'ledger.jsonl',
        '--max-ledger-bytes',
        '42',
      ]),
    ).toMatchObject({
      maxLedgerBytes: 42,
    });
  });

  it('pins empty limit and missing ledger path behavior for operator trust', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-report-cli-edge-'));
    try {
      const ledgerPath = join(workspace, 'tick-evidence.jsonl');
      writeFileSync(ledgerPath, `${validTickEvidenceJson('cli-record-1', 'cli-test')}\n`, 'utf8');
      const zeroLimitIo = makeIo();

      const zeroLimitExitCode = runTraitSchedulerTickEvidenceReportCli(
        ['--ledger', ledgerPath, '--limit', '0'],
        zeroLimitIo,
      );

      expect(zeroLimitExitCode).toBe(0);
      expect(zeroLimitIo.stderrText()).toBe('');
      const zeroLimitReport = JSON.parse(zeroLimitIo.stdoutText()) as {
        readonly filter: { readonly limit?: number };
        readonly scorecard: { readonly recordCount: number };
      };
      expect(zeroLimitReport.filter).toEqual({ limit: 0 });
      expect(zeroLimitReport.scorecard.recordCount).toBe(0);

      const missingLedgerIo = makeIo();
      const missingLedgerExitCode = runTraitSchedulerTickEvidenceReportCli(
        ['--ledger', join(workspace, 'missing.jsonl')],
        missingLedgerIo,
      );

      expect(missingLedgerExitCode).toBe(1);
      expect(missingLedgerIo.stdoutText()).toBe('');
      expect(missingLedgerIo.stderrText()).toContain('--ledger path does not exist');

      const directoryLedgerIo = makeIo();
      const directoryLedgerExitCode = runTraitSchedulerTickEvidenceReportCli(
        ['--ledger', workspace],
        directoryLedgerIo,
      );

      expect(directoryLedgerExitCode).toBe(1);
      expect(directoryLedgerIo.stdoutText()).toBe('');
      expect(directoryLedgerIo.stderrText()).toContain('--ledger path is not a file');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails closed during bounded replay when a ledger exceeds the byte guard', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'trait-tick-report-cli-max-'));
    try {
      const ledgerPath = join(workspace, 'tick-evidence.jsonl');
      writeFileSync(ledgerPath, `${validTickEvidenceJson('cli-record-1', 'cli-test')}\n`, 'utf8');
      const originalLedgerContent = readFileSync(ledgerPath, 'utf8');
      const exactBoundaryIo = makeIo();

      const exactBoundaryExitCode = runTraitSchedulerTickEvidenceReportCli(
        [
          '--ledger',
          ledgerPath,
          '--max-ledger-bytes',
          String(Buffer.byteLength(originalLedgerContent, 'utf8')),
        ],
        exactBoundaryIo,
      );

      expect(exactBoundaryExitCode).toBe(0);
      expect(exactBoundaryIo.stderrText()).toBe('');
      expect(JSON.parse(exactBoundaryIo.stdoutText()) as unknown).toMatchObject({
        replayAudit: {
          parsedRecordCount: 1,
        },
      });

      const io = makeIo();

      const exitCode = runTraitSchedulerTickEvidenceReportCli(
        ['--ledger', ledgerPath, '--max-ledger-bytes', '1'],
        io,
      );

      expect(exitCode).toBe(1);
      expect(io.stdoutText()).toBe('');
      expect(io.stderrText()).toContain('Trait scheduler tick evidence ledger exceeds maxBytes');
      expect(readFileSync(ledgerPath, 'utf8')).toBe(originalLedgerContent);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
