import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildPlanaAdvisorEventsReportFromCliOptions,
  parsePlanaAdvisorEventsReportCliArgs,
  PLANA_ADVISOR_EVENTS_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
  runPlanaAdvisorEventsReportCli,
  type PlanaAdvisorEventsTemplateRecord,
} from '../src/index.js';

function validAdvisorEventJson(
  recordId: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    recordId,
    recordedAt: '2026-05-05T10:00:00.000Z',
    provider: 'claude-agent',
    provenance: 'plana-claude-runtime-advisor',
    taskId: 'task-cli-advisor',
    instanceId: 'agent-cli-advisor',
    eventKind: 'item.completed',
    eventTimestamp: '2026-05-05T09:59:59.000Z',
    eventItemType: 'agent_message',
    verdictStatus: 'approve',
    consultationOutcome: 'consulted',
    model: 'claude-opus-4-7',
    ...overrides,
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

describe('Plana advisor events report CLI', () => {
  it('builds a read-only JSON report from a redacted advisor events ledger with filters', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'plana-advisor-report-cli-'));
    try {
      const ledgerPath = join(workspace, 'plana-advisor-events.jsonl');
      writeFileSync(
        ledgerPath,
        [
          validAdvisorEventJson('other-task-record', {
            taskId: 'task-other',
            verdictStatus: 'veto',
          }),
          validAdvisorEventJson('cli-record-1', {
            taskId: 'task-cli-advisor',
            verdictStatus: 'approve',
          }),
          validAdvisorEventJson('cli-record-2', {
            taskId: 'task-cli-advisor',
            verdictStatus: 'veto',
            consultationOutcome: 'advisor-error-fail-open',
          }),
          '{"schemaVersion":1,"recordId":"invalid-shape"}',
          '{"schemaVersion":1,"recordId":"torn"',
        ].join('\n'),
        'utf8',
      );
      const originalLedgerContent = readFileSync(ledgerPath, 'utf8');
      const originalLedgerStat = statSync(ledgerPath);
      const originalWorkspaceEntries = readdirSync(workspace).sort();
      const argv = [
        '--',
        '--ledger',
        ledgerPath,
        '--task-id',
        'task-cli-advisor',
        '--verdict',
        'veto',
        '--consultation-outcome',
        'advisor-error-fail-open',
        '--max-ledger-bytes',
        '10000',
        '--limit',
        '1',
        '--generated-at',
        '2026-05-05T10:10:00.000Z',
        '--pretty',
      ] as const;
      const io = makeIo();

      const exitCode = runPlanaAdvisorEventsReportCli(argv, io);

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe('');
      const report = JSON.parse(io.stdoutText()) as {
        readonly generatedAt: string;
        readonly filter: {
          readonly taskId?: string;
          readonly verdictStatus?: string;
          readonly consultationOutcome?: string;
          readonly limit?: number;
        };
        readonly replayAudit: {
          readonly totalLineCount: number;
          readonly emptyLineCount: number;
          readonly parsedRecordCount: number;
          readonly skippedMalformedLineCount: number;
        };
        readonly scorecard: {
          readonly recordCount: number;
          readonly verdictCounts: Record<string, number>;
          readonly consultationCounts: Record<string, number>;
          readonly recommendations: readonly string[];
        };
      };
      expect(report.generatedAt).toBe('2026-05-05T10:10:00.000Z');
      expect(report.filter).toEqual({
        taskId: 'task-cli-advisor',
        verdictStatus: 'veto',
        consultationOutcome: 'advisor-error-fail-open',
        limit: 1,
      });
      expect(report.replayAudit).toEqual({
        source: 'jsonl',
        totalLineCount: 5,
        emptyLineCount: 0,
        parsedRecordCount: 3,
        skippedMalformedLineCount: 2,
      });
      expectReplayAuditInvariant(report.replayAudit);
      expect(report.scorecard.recordCount).toBe(1);
      expect(report.scorecard.verdictCounts).toEqual({
        approve: 0,
        veto: 1,
        skip: 0,
      });
      expect(report.scorecard.consultationCounts).toEqual({
        consulted: 0,
        advisorErrorFailOpen: 1,
        advisorErrorFailClosed: 0,
      });
      expect(report.scorecard.recommendations[0]).toBe(
        'Review 2 malformed/torn advisor JSONL line(s); they were excluded from scoring.',
      );
      expect(io.stdoutText()).not.toContain('prompt');
      expect(io.stdoutText()).not.toContain('responseText');
      expect(readFileSync(ledgerPath, 'utf8')).toBe(originalLedgerContent);
      expect(statSync(ledgerPath).size).toBe(originalLedgerStat.size);
      expect(statSync(ledgerPath).mtimeMs).toBe(originalLedgerStat.mtimeMs);
      expect(readdirSync(workspace).sort()).toEqual(originalWorkspaceEntries);

      const secondIo = makeIo();
      const secondExitCode = runPlanaAdvisorEventsReportCli(argv, secondIo);

      expect(secondExitCode).toBe(0);
      expect(secondIo.stderrText()).toBe('');
      expect(secondIo.stdoutText()).toBe(io.stdoutText());
      expect(readFileSync(ledgerPath, 'utf8')).toBe(originalLedgerContent);
      expect(statSync(ledgerPath).size).toBe(originalLedgerStat.size);
      expect(statSync(ledgerPath).mtimeMs).toBe(originalLedgerStat.mtimeMs);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('prints help without requiring a ledger path', () => {
    const io = makeIo();

    const exitCode = runPlanaAdvisorEventsReportCli(['--help'], io);

    expect(exitCode).toBe(0);
    expect(io.stdoutText()).toContain('Usage: pnpm plana:advisor:events:report');
    expect(io.stdoutText()).toContain('This command is read-only.');
    expect(io.stdoutText()).toContain('malformed or torn JSONL');
    expect(io.stdoutText()).toContain(
      `--max-ledger-bytes <n>          Fail closed during bounded replay beyond this many bytes (default: ${String(PLANA_ADVISOR_EVENTS_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES)}).`,
    );
    expect(io.stderrText()).toBe('');
  });

  it('prints a compact non-promoting advisor audit JSONL template', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'plana-advisor-template-'));
    try {
      const io = makeIo();

      const exitCode = runPlanaAdvisorEventsReportCli(
        ['--print-template', '--generated-at', '2026-05-05T10:20:00.000Z'],
        io,
      );

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe('');
      expect(io.stdoutText()).toContain('\n');
      expect(io.stdoutText().endsWith('\n')).toBe(true);
      const lines = io.stdoutText().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toBe('');
      expect(lines[0]).toBe(JSON.stringify(JSON.parse(lines[0])));
      const template = JSON.parse(lines[0]) as PlanaAdvisorEventsTemplateRecord;
      expect(template).toEqual({
        schemaVersion: 1,
        recordId: 'template-plana-advisor-event',
        recordedAt: '2026-05-05T10:20:00.000Z',
        provider: 'claude-agent',
        provenance: 'plana-claude-runtime-advisor',
        taskId: 'template-task-redacted',
        instanceId: 'template-instance-redacted',
        eventKind: 'turn.started',
        eventTimestamp: '2026-05-05T10:20:00.000Z',
        eventItemType: 'template',
        verdictStatus: 'skip',
        consultationOutcome: 'advisor-error-fail-open',
        model: 'template-claude-agent-advisor',
      });
      expect(lines[0]).toBe(
        '{"schemaVersion":1,"recordId":"template-plana-advisor-event","recordedAt":"2026-05-05T10:20:00.000Z","provider":"claude-agent","provenance":"plana-claude-runtime-advisor","taskId":"template-task-redacted","instanceId":"template-instance-redacted","eventKind":"turn.started","eventTimestamp":"2026-05-05T10:20:00.000Z","eventItemType":"template","verdictStatus":"skip","consultationOutcome":"advisor-error-fail-open","model":"template-claude-agent-advisor"}',
      );
      expect(lines[0]).not.toContain('prompt');
      expect(lines[0]).not.toContain('responseText');
      expect(lines[0]).not.toContain('free-form reason');
      expect(lines[0]).not.toContain('Discord content');

      const secondIo = makeIo();
      const secondExitCode = runPlanaAdvisorEventsReportCli(
        ['--print-template', '--generated-at', '2026-05-05T10:20:00.000Z'],
        secondIo,
      );
      expect(secondExitCode).toBe(0);
      expect(secondIo.stderrText()).toBe('');
      expect(secondIo.stdoutText()).toBe(io.stdoutText());

      const ledgerPath = join(workspace, 'plana-advisor-events.jsonl');
      writeFileSync(ledgerPath, io.stdoutText(), 'utf8');
      const reportIo = makeIo();

      const reportExitCode = runPlanaAdvisorEventsReportCli(
        [
          '--ledger',
          ledgerPath,
          '--generated-at',
          '2026-05-05T10:21:00.000Z',
          '--pretty',
        ],
        reportIo,
      );

      expect(reportExitCode).toBe(0);
      expect(reportIo.stderrText()).toBe('');
      const report = JSON.parse(reportIo.stdoutText()) as {
        readonly generatedAt: string;
        readonly replayAudit: {
          readonly parsedRecordCount: number;
          readonly skippedMalformedLineCount: number;
        };
        readonly scorecard: {
          readonly recordCount: number;
          readonly verdictCounts: Record<string, number>;
          readonly consultationCounts: Record<string, number>;
          readonly eventKindCounts: Record<string, number>;
          readonly recency: {
            readonly firstRecordedAt?: string;
            readonly lastRecordedAt?: string;
          };
          readonly confidence: {
            readonly sufficientForTrend: boolean;
            readonly sampleSize: number;
            readonly templateRecordCount: number;
          };
          readonly recommendations: readonly string[];
        };
      };
      expect(report.generatedAt).toBe('2026-05-05T10:21:00.000Z');
      expect(report.replayAudit.parsedRecordCount).toBe(1);
      expect(report.replayAudit.skippedMalformedLineCount).toBe(0);
      expect(report.scorecard.recordCount).toBe(1);
      expect(report.scorecard.verdictCounts).toEqual({
        approve: 0,
        veto: 0,
        skip: 1,
      });
      expect(report.scorecard.consultationCounts).toEqual({
        consulted: 0,
        advisorErrorFailOpen: 1,
        advisorErrorFailClosed: 0,
      });
      expect(report.scorecard.eventKindCounts).toEqual({
        'turn.started': 1,
      });
      expect(report.scorecard.recency).toEqual({
        firstRecordedAt: '2026-05-05T10:20:00.000Z',
        lastRecordedAt: '2026-05-05T10:20:00.000Z',
      });
      expect(report.scorecard.confidence).toMatchObject({
        sampleSize: 0,
        templateRecordCount: 1,
        sufficientForTrend: false,
      });
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'template advisor event',
      );
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'at least 5',
      );
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'advisor-error-fail-open',
      );
      expect(reportIo.stdoutText()).not.toContain('template-task-redacted');
      expect(reportIo.stdoutText()).not.toContain('template-instance-redacted');
      expect(reportIo.stdoutText()).not.toContain(
        'template-claude-agent-advisor',
      );
      expect(reportIo.stdoutText()).not.toContain('prompt');
      expect(reportIo.stdoutText()).not.toContain('responseText');

      const repeatedTemplateLedgerPath = join(
        workspace,
        'plana-advisor-repeated-template.jsonl',
      );
      writeFileSync(repeatedTemplateLedgerPath, io.stdoutText().repeat(5), 'utf8');
      const repeatedTemplateReportIo = makeIo();

      const repeatedTemplateExitCode = runPlanaAdvisorEventsReportCli(
        ['--ledger', repeatedTemplateLedgerPath],
        repeatedTemplateReportIo,
      );

      expect(repeatedTemplateExitCode).toBe(0);
      expect(repeatedTemplateReportIo.stderrText()).toBe('');
      const repeatedTemplateReport = JSON.parse(
        repeatedTemplateReportIo.stdoutText(),
      ) as {
        readonly scorecard: {
          readonly recordCount: number;
          readonly confidence: {
            readonly sampleSize: number;
            readonly templateRecordCount: number;
            readonly sufficientForTrend: boolean;
          };
        };
      };
      expect(repeatedTemplateReport.scorecard.recordCount).toBe(5);
      expect(repeatedTemplateReport.scorecard.confidence).toMatchObject({
        sampleSize: 0,
        templateRecordCount: 5,
        sufficientForTrend: false,
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails closed for missing required arguments and invalid filter values', () => {
    expect(() => parsePlanaAdvisorEventsReportCliArgs([])).toThrow(
      /--ledger is required/,
    );
    expect(
      parsePlanaAdvisorEventsReportCliArgs(['--ledger', 'ledger.jsonl']),
    ).toMatchObject({
      ledgerPath: 'ledger.jsonl',
      filter: {},
      maxLedgerBytes: PLANA_ADVISOR_EVENTS_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
      printTemplate: false,
    });
    expect(parsePlanaAdvisorEventsReportCliArgs(['--print-template'])).toEqual({
      filter: {},
      maxLedgerBytes: PLANA_ADVISOR_EVENTS_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
      pretty: false,
      printTemplate: true,
    });
    expect(() =>
      parsePlanaAdvisorEventsReportCliArgs([
        '--ledger',
        'ledger.jsonl',
        '--verdit',
        'veto',
      ]),
    ).toThrow(/Unknown argument: --verdit/);
    expect(() =>
      parsePlanaAdvisorEventsReportCliArgs([
        '--ledger',
        'ledger.jsonl',
        '--verdict',
        'unknown',
      ]),
    ).toThrow(/--verdict must be one of/);
    expect(() =>
      parsePlanaAdvisorEventsReportCliArgs([
        '--ledger',
        'ledger.jsonl',
        '--consultation-outcome',
        'unknown',
      ]),
    ).toThrow(/--consultation-outcome must be one of/);
    expect(() =>
      parsePlanaAdvisorEventsReportCliArgs([
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
        parsePlanaAdvisorEventsReportCliArgs([
          '--ledger',
          'ledger.jsonl',
          '--max-ledger-bytes',
          invalidMaxLedgerBytes,
        ]),
      ).toThrow(/--max-ledger-bytes must be a positive safe integer/);
    }
    expect(() =>
      parsePlanaAdvisorEventsReportCliArgs([
        '--ledger',
        'ledger.jsonl',
        '--generated-at',
        'not-an-iso-instant',
      ]),
    ).toThrow(/--generated-at must be a valid ISO-8601 UTC timestamp/);
    for (const invalidGeneratedAt of [
      '2026-05-05T10:20:00.000+09:00',
      '2026-05-05T10:20:00',
      '2026-05-05',
    ]) {
      expect(() =>
        parsePlanaAdvisorEventsReportCliArgs([
          '--print-template',
          '--generated-at',
          invalidGeneratedAt,
        ]),
      ).toThrow(/--generated-at must be a valid ISO-8601 UTC timestamp/);
    }
    expect(() =>
      parsePlanaAdvisorEventsReportCliArgs([
        '--print-template',
        '--ledger',
        'ledger.jsonl',
      ]),
    ).toThrow(/--print-template cannot be combined with --ledger/);
    for (const reportOnlyArgs of [
      ['--pretty'],
      ['--task-id', 'task-cli-advisor'],
      ['--event-kind', 'item.completed'],
      ['--verdict', 'approve'],
      ['--consultation-outcome', 'consulted'],
      ['--limit', '1'],
      ['--max-ledger-bytes', '100'],
    ] as const) {
      expect(() =>
        parsePlanaAdvisorEventsReportCliArgs([
          '--print-template',
          ...reportOnlyArgs,
        ]),
      ).toThrow(
        new RegExp(
          `--print-template cannot be combined with report-only options: ${reportOnlyArgs[0]}`,
        ),
      );
    }
    expect(() =>
      buildPlanaAdvisorEventsReportFromCliOptions({
        filter: {},
        maxLedgerBytes: 10_000,
        pretty: false,
        printTemplate: true,
      }),
    ).toThrow(
      /Cannot build a Plana advisor events report from --print-template options/,
    );

    const io = makeIo();
    const exitCode = runPlanaAdvisorEventsReportCli([], io);

    expect(exitCode).toBe(1);
    expect(io.stdoutText()).toBe('');
    expect(io.stderrText()).toContain('--ledger is required');
  });

  it('uses a default ledger byte guard and lets operators override it', () => {
    expect(
      parsePlanaAdvisorEventsReportCliArgs([
        '--ledger',
        'ledger.jsonl',
      ]),
    ).toMatchObject({
      maxLedgerBytes: PLANA_ADVISOR_EVENTS_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
    });
    expect(
      parsePlanaAdvisorEventsReportCliArgs([
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
    const workspace = mkdtempSync(join(tmpdir(), 'plana-advisor-report-cli-edge-'));
    try {
      const ledgerPath = join(workspace, 'plana-advisor-events.jsonl');
      writeFileSync(ledgerPath, `${validAdvisorEventJson('cli-record-1')}\n`, 'utf8');
      const zeroLimitIo = makeIo();

      const zeroLimitExitCode = runPlanaAdvisorEventsReportCli(
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
      const missingLedgerExitCode = runPlanaAdvisorEventsReportCli(
        ['--ledger', join(workspace, 'missing.jsonl')],
        missingLedgerIo,
      );

      expect(missingLedgerExitCode).toBe(1);
      expect(missingLedgerIo.stdoutText()).toBe('');
      expect(missingLedgerIo.stderrText()).toContain('--ledger path does not exist');

      const directoryLedgerIo = makeIo();
      const directoryLedgerExitCode = runPlanaAdvisorEventsReportCli(
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
    const workspace = mkdtempSync(join(tmpdir(), 'plana-advisor-report-cli-max-'));
    try {
      const ledgerPath = join(workspace, 'plana-advisor-events.jsonl');
      writeFileSync(ledgerPath, `${validAdvisorEventJson('cli-record-1')}\n`, 'utf8');
      const originalLedgerContent = readFileSync(ledgerPath, 'utf8');
      const exactBoundaryIo = makeIo();

      const exactBoundaryExitCode = runPlanaAdvisorEventsReportCli(
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

      const exitCode = runPlanaAdvisorEventsReportCli(
        ['--ledger', ledgerPath, '--max-ledger-bytes', '1'],
        io,
      );

      expect(exitCode).toBe(1);
      expect(io.stdoutText()).toBe('');
      expect(io.stderrText()).toContain(
        'Plana Claude advisor audit ledger exceeds maxBytes',
      );
      expect(readFileSync(ledgerPath, 'utf8')).toBe(originalLedgerContent);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
