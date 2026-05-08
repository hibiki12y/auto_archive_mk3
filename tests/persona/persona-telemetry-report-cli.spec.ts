import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PERSONA_TELEMETRY_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
  buildPersonaTelemetryReportFromCliOptions,
  parsePersonaTelemetryReportCliArgs,
  runPersonaTelemetryReportCli,
  type PersonaTelemetryTemplateRecord,
} from '../../src/index.js';

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

function observationLine(index: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'persona-transform-observed',
    details: {
      eventType: index % 2 === 0 ? 'running-update' : 'ask-accepted',
      model: 'gpt-4o-mini',
      outcome: 'success',
      observedAt: `2026-05-05T04:0${String(index)}:00.000Z`,
      durationMs: 120 + index,
      latencyBudgetMs: 500,
      withinLatencyBudget: true,
      inputChars: 100 + index,
      outputChars: 120 + index,
      promptTokens: 50,
      completionTokens: 20,
      totalTokens: 70,
      humanReviewedNoSourceDialogueCopy: index === 1,
      ...overrides,
    },
  });
}

function nestedObject(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < depth; index += 1) {
    const next: Record<string, unknown> = {};
    cursor.next = next;
    cursor = next;
  }
  cursor.leaf = true;
  return root;
}

describe('persona telemetry report CLI', () => {
  it('builds a read-only scorecard from redacted persona telemetry JSONL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-persona-telemetry-report-'));
    try {
      const ledgerPath = join(dir, 'persona-telemetry.jsonl');
      writeFileSync(
        ledgerPath,
        [
          observationLine(1),
          observationLine(2),
          observationLine(3),
          observationLine(4),
          observationLine(5),
          JSON.stringify({ event: 'other-event', details: { text: 'ignored' } }),
          '',
        ].join('\n'),
        'utf8',
      );

      const io = makeIo();
      const exitCode = runPersonaTelemetryReportCli(
        [
          '--ledger',
          ledgerPath,
          '--generated-at',
          '2026-05-05T04:10:00.000Z',
          '--pretty',
        ],
        io,
      );
      const report = JSON.parse(io.stdoutText()) as {
        readonly status: string;
        readonly replayAudit: {
          readonly parsedObservationCount: number;
          readonly skippedNonObservationLineCount: number;
        };
        readonly scorecard: {
          readonly recordCount: number;
          readonly successCount: number;
          readonly qualityScore: { readonly value: number };
        };
        readonly boundary: {
          readonly rawTextRendered: boolean;
          readonly liveServicesContacted: boolean;
        };
      };

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe('');
      expect(report.status).toBe('complete');
      expect(report.replayAudit.parsedObservationCount).toBe(5);
      expect(report.replayAudit.skippedNonObservationLineCount).toBe(1);
      expect(report.scorecard.recordCount).toBe(5);
      expect(report.scorecard.successCount).toBe(5);
      expect(report.scorecard.qualityScore.value).toBe(100);
      expect(report.boundary).toMatchObject({
        rawTextRendered: false,
        liveServicesContacted: false,
      });
      expect(io.stdoutText()).not.toContain('source dialogue');
      expect(io.stdoutText()).not.toContain('transformed text');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints a compact non-promoting persona-transform-observed JSONL template', () => {
    const io = makeIo();

    const exitCode = runPersonaTelemetryReportCli(
      [
        '--print-template',
        '--generated-at',
        '2026-05-05T04:10:00.000Z',
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    const [line, trailing] = io.stdoutText().split('\n');
    expect(trailing).toBe('');
    expect(line).toBe(JSON.stringify(JSON.parse(line ?? '{}')));
    const record = JSON.parse(io.stdoutText()) as PersonaTelemetryTemplateRecord;
    const expectedRecord = {
      event: 'persona-transform-observed',
      details: {
        eventType: 'template.persona-transform',
        model: 'persona-template',
        outcome: 'success',
        observedAt: '2026-05-05T04:10:00.000Z',
        durationMs: 0,
        latencyBudgetMs: 500,
        withinLatencyBudget: true,
        inputChars: 0,
        outputChars: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        humanReviewedNoSourceDialogueCopy: false,
      },
    } as const satisfies PersonaTelemetryTemplateRecord;
    expect(record).toEqual(expectedRecord);
    expect(io.stdoutText()).toBe(`${JSON.stringify(expectedRecord)}\n`);
    expect(io.stdoutText()).not.toContain('SECRET');
    expect(io.stdoutText()).not.toContain('source dialogue');

    const secondIo = makeIo();
    expect(
      runPersonaTelemetryReportCli(
        [
          '--print-template',
          '--generated-at',
          '2026-05-05T04:10:00.000Z',
        ],
        secondIo,
      ),
    ).toBe(0);
    expect(secondIo.stderrText()).toBe('');
    expect(secondIo.stdoutText()).toBe(io.stdoutText());

    const dir = mkdtempSync(join(tmpdir(), 'aa-persona-telemetry-template-'));
    try {
      const ledgerPath = join(dir, 'persona-telemetry.jsonl');
      writeFileSync(ledgerPath, io.stdoutText(), 'utf8');
      const reportIo = makeIo();
      const reportExitCode = runPersonaTelemetryReportCli(
        [
          '--ledger',
          ledgerPath,
          '--generated-at',
          '2026-05-05T04:11:00.000Z',
        ],
        reportIo,
      );

      expect(reportExitCode).toBe(0);
      expect(reportIo.stderrText()).toBe('');
      const report = JSON.parse(reportIo.stdoutText()) as {
        readonly status: string;
        readonly replayAudit: { readonly parsedObservationCount: number };
        readonly scorecard: {
          readonly recordCount: number;
          readonly successCount: number;
          readonly fallbackCount: number;
          readonly latencyBudgetSampleCount: number;
          readonly withinLatencyBudgetCount: number;
          readonly humanReviewedNoSourceDialogueCopyCount: number;
          readonly averageDurationMs: number;
          readonly totalTokens: number;
          readonly qualityScore: { readonly value: number };
          readonly recommendations: readonly string[];
        };
      };
      expect(report.status).toBe('warn');
      expect(report.replayAudit.parsedObservationCount).toBe(1);
      expect(report.scorecard.recordCount).toBe(1);
      expect(report.scorecard.successCount).toBe(1);
      expect(report.scorecard.fallbackCount).toBe(0);
      expect(report.scorecard.latencyBudgetSampleCount).toBe(1);
      expect(report.scorecard.withinLatencyBudgetCount).toBe(1);
      expect(report.scorecard.humanReviewedNoSourceDialogueCopyCount).toBe(0);
      expect(report.scorecard.averageDurationMs).toBe(0);
      expect(report.scorecard.totalTokens).toBe(0);
      expect(report.scorecard.qualityScore.value).toBeLessThan(100);
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'at least 5',
      );
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'human review',
      );
      expect(reportIo.stdoutText()).not.toContain('persona-template');
      expect(reportIo.stdoutText()).not.toContain('source dialogue');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails report status for unsafe raw text fields without rendering them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-persona-telemetry-unsafe-'));
    try {
      const ledgerPath = join(dir, 'persona-telemetry.jsonl');
      writeFileSync(
        ledgerPath,
        [
          observationLine(1),
          observationLine(2, {
            inputText: 'SECRET source dialogue must not render',
          }),
          observationLine(3, {
            sourceText: 'SECRET source text alias must not render',
          }),
          observationLine(4, {
            metadata: {
              sourceDialogue: 'SECRET nested source dialogue must not render',
            },
          }),
          observationLine(5, {
            taskId: 'task-secret-123',
          }),
          observationLine(6, {
            metadata: nestedObject(40),
          }),
        ].join('\n'),
        'utf8',
      );

      const io = makeIo();
      const exitCode = runPersonaTelemetryReportCli(['--ledger', ledgerPath], io);
      const report = JSON.parse(io.stdoutText()) as {
        readonly status: string;
        readonly replayAudit: {
          readonly unsafeRawContentLineCount: number;
        };
      };

      expect(exitCode).toBe(0);
      expect(report.status).toBe('fail');
      expect(report.replayAudit.unsafeRawContentLineCount).toBe(5);
      expect(io.stdoutText()).not.toContain('SECRET source dialogue');
      expect(io.stdoutText()).not.toContain('SECRET source text alias');
      expect(io.stdoutText()).not.toContain('SECRET nested source dialogue');
      expect(io.stdoutText()).not.toContain('task-secret-123');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed for invalid persona telemetry CLI arguments and byte guard', () => {
    expect(
      parsePersonaTelemetryReportCliArgs(['--ledger', 'persona-telemetry.jsonl']),
    ).toMatchObject({
      ledgerPath: 'persona-telemetry.jsonl',
      filter: {},
      maxLedgerBytes: PERSONA_TELEMETRY_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
      printTemplate: false,
    });
    expect(parsePersonaTelemetryReportCliArgs(['--print-template'])).toEqual({
      filter: {},
      maxLedgerBytes: PERSONA_TELEMETRY_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
      pretty: false,
      printTemplate: true,
    });
    expect(() =>
      parsePersonaTelemetryReportCliArgs([
        '--print-template',
        '--generated-at',
        'not-an-instant',
      ]),
    ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp.');
    expect(() =>
      parsePersonaTelemetryReportCliArgs([
        '--print-template',
        '--generated-at',
        '2026-05-05T04:10:00.000+09:00',
      ]),
    ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp.');
    expect(() =>
      parsePersonaTelemetryReportCliArgs([
        '--print-template',
        '--generated-at',
        '2026-05-05T04:10:00',
      ]),
    ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp.');
    expect(() =>
      parsePersonaTelemetryReportCliArgs([
        '--print-template',
        '--generated-at',
        '2026-05-05',
      ]),
    ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp.');
    expect(() =>
      parsePersonaTelemetryReportCliArgs([
        '--print-template',
        '--ledger',
        'persona-telemetry.jsonl',
      ]),
    ).toThrow('--print-template cannot be combined with --ledger');
    for (const reportOnlyArgs of [
      ['--pretty'],
      ['--event-type', 'ask-accepted'],
      ['--model', 'gpt-4o-mini'],
      ['--outcome', 'success'],
      ['--limit', '1'],
      ['--max-ledger-bytes', '100'],
    ] as const) {
      expect(() =>
        parsePersonaTelemetryReportCliArgs(['--print-template', ...reportOnlyArgs]),
      ).toThrow(
        new RegExp(
          `--print-template cannot be combined with report-only options: ${reportOnlyArgs[0]}`,
        ),
      );
    }
    expect(() =>
      buildPersonaTelemetryReportFromCliOptions({
        filter: {},
        maxLedgerBytes: 10_000,
        pretty: false,
        printTemplate: true,
      }),
    ).toThrow(/Cannot build a persona telemetry report from --print-template options/);
    expect(() =>
      parsePersonaTelemetryReportCliArgs([
        '--ledger',
        'persona-telemetry.jsonl',
        '--outcome',
        'other',
      ]),
    ).toThrow('--outcome must be one of: success, fallback.');
    expect(() =>
      parsePersonaTelemetryReportCliArgs([
        '--ledger',
        'persona-telemetry.jsonl',
        '--generated-at',
        'not-an-instant',
      ]),
    ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp.');

    const dir = mkdtempSync(join(tmpdir(), 'aa-persona-telemetry-byte-'));
    try {
      const ledgerPath = join(dir, 'persona-telemetry.jsonl');
      writeFileSync(ledgerPath, observationLine(1), 'utf8');
      const io = makeIo();
      const exitCode = runPersonaTelemetryReportCli(
        ['--ledger', ledgerPath, '--max-ledger-bytes', '1'],
        io,
      );

      expect(exitCode).toBe(1);
      expect(io.stderrText()).toContain('persona:telemetry:report failed');
      expect(io.stderrText()).toContain('exceeds --max-ledger-bytes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const helpIo = makeIo();
    expect(runPersonaTelemetryReportCli(['--help'], helpIo)).toBe(0);
    const stdout = helpIo.stdoutText();
    expect(stdout).toContain('--print-template');
    expect(stdout).toContain('non-promoting');
    expect(stdout).toContain('Template mode accepts only --generated-at');
    expect(stdout).toContain('--ledger, --event-type');
  });
});
