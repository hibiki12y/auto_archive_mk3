import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  TASK_HEALTH_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
  buildTaskHealthEvidenceReportFromCliOptions,
  parseTaskHealthEvidenceReportCliArgs,
  runTaskHealthEvidenceReportCli,
  type TaskHealthEvidenceTemplateRecord,
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

function taskHealthEventLine(
  index: number,
  overrides: {
    readonly payload?: Record<string, unknown>;
    readonly event?: Record<string, unknown>;
  } = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    eventId: `task-health-event-${String(index)}`,
    timestamp: `2026-05-05T11:0${String(index)}:01.000Z`,
    type: 'task.health_stalled',
    actor: { kind: 'system' },
    channel: { kind: 'system' },
    taskId: `SECRET-task-health-${String(index)}`,
    correlationId: `SECRET-instance-${String(index)}`,
    trust: {
      source: 'system',
      inputTrust: 'trusted',
    },
    payload: {
      phase: 'stalled',
      scope: 'task-health',
      provenance: 'task-health-control-plane-recorder',
      lastProgressAt: `2026-05-05T11:0${String(index)}:00.000Z`,
      thresholdMs: 1000,
      lastEventKind: index % 2 === 0 ? 'turn.completed' : 'turn.started',
      ...overrides.payload,
    },
    ...overrides.event,
  });
}

function nestedPayload(depth: number): Record<string, unknown> {
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

describe('task health evidence report CLI', () => {
  it('builds a read-only scorecard from retained task.health_stalled events', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'aa-task-health-report-'));
    try {
      const ledgerPath = join(workspace, 'control-plane.jsonl');
      writeFileSync(
        ledgerPath,
        [
          taskHealthEventLine(1),
          taskHealthEventLine(2),
          JSON.stringify({
            schemaVersion: 1,
            eventId: 'other-event',
            timestamp: '2026-05-05T11:00:00.000Z',
            type: 'task.accepted',
            actor: { kind: 'system' },
            trust: { source: 'system', inputTrust: 'trusted' },
            payload: { instruction: 'ignored non-task raw instruction' },
          }),
          '{"schemaVersion":1,"eventId":"torn"',
          '',
        ].join('\n'),
        'utf8',
      );

      const io = makeIo();
      const exitCode = runTaskHealthEvidenceReportCli(
        [
          '--ledger',
          ledgerPath,
          '--last-event-kind',
          'turn.started',
          '--limit',
          '1',
          '--generated-at',
          '2026-05-05T11:10:00.000Z',
          '--pretty',
        ],
        io,
      );
      const report = JSON.parse(io.stdoutText()) as {
        readonly generatedAt: string;
        readonly status: string;
        readonly replayAudit: {
          readonly parsedEventCount: number;
          readonly parsedTaskHealthRecordCount: number;
          readonly skippedNonTaskHealthLineCount: number;
          readonly skippedMalformedLineCount: number;
        };
        readonly scorecard: {
          readonly recordCount: number;
          readonly taskScopedRecordCount: number;
          readonly correlationScopedRecordCount: number;
          readonly qualityScore: { readonly value: number };
          readonly lastEventKindCounts: Record<string, number>;
        };
        readonly boundary: {
          readonly readOnly: boolean;
          readonly liveServicesContacted: boolean;
          readonly ledgerMutated: boolean;
          readonly rawTaskIdsRendered: boolean;
          readonly rawCorrelationIdsRendered: boolean;
        };
      };

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe('');
      expect(report.generatedAt).toBe('2026-05-05T11:10:00.000Z');
      expect(report.status).toBe('warn');
      expect(report.replayAudit.parsedEventCount).toBe(3);
      expect(report.replayAudit.parsedTaskHealthRecordCount).toBe(2);
      expect(report.replayAudit.skippedNonTaskHealthLineCount).toBe(1);
      expect(report.replayAudit.skippedMalformedLineCount).toBe(1);
      expect(report.scorecard.recordCount).toBe(1);
      expect(report.scorecard.taskScopedRecordCount).toBe(1);
      expect(report.scorecard.correlationScopedRecordCount).toBe(1);
      expect(report.scorecard.lastEventKindCounts).toEqual({ 'turn.started': 1 });
      expect(report.scorecard.qualityScore.value).toBe(75);
      expect(report.boundary).toMatchObject({
        readOnly: true,
        liveServicesContacted: false,
        ledgerMutated: false,
        rawTaskIdsRendered: false,
        rawCorrelationIdsRendered: false,
      });
      expect(io.stdoutText()).not.toContain('SECRET-task-health');
      expect(io.stdoutText()).not.toContain('SECRET-instance');
      expect(io.stdoutText()).not.toContain('ignored non-task raw instruction');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('prints a compact non-promoting task.health_stalled control-plane JSONL template', () => {
    const io = makeIo();

    const exitCode = runTaskHealthEvidenceReportCli(
      [
        '--print-template',
        '--generated-at',
        '2026-05-05T11:10:01.000Z',
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    const [line, trailing] = io.stdoutText().split('\n');
    expect(trailing).toBe('');
    expect(line).toBe(JSON.stringify(JSON.parse(line ?? '{}')));
    const record = JSON.parse(io.stdoutText()) as TaskHealthEvidenceTemplateRecord;
    const expectedRecord = {
      schemaVersion: 1,
      eventId: 'task-health-evidence-template',
      timestamp: '2026-05-05T11:10:01.000Z',
      type: 'task.health_stalled',
      actor: { kind: 'system' },
      trust: {
        source: 'system',
        inputTrust: 'trusted',
      },
      payload: {
        phase: 'stalled',
        scope: 'task-health',
        provenance: 'task-health-control-plane-recorder',
        lastProgressAt: '2026-05-05T11:10:00.000Z',
        thresholdMs: 1000,
        lastEventKind: 'template.progress',
      },
    } as const satisfies TaskHealthEvidenceTemplateRecord;
    expect(record).toEqual(expectedRecord);
    expect(io.stdoutText()).toBe(`${JSON.stringify(expectedRecord)}\n`);
    expect(io.stdoutText()).not.toContain('SECRET');
    expect(io.stdoutText()).not.toContain('raw prompt');

    const secondIo = makeIo();
    expect(
      runTaskHealthEvidenceReportCli(
        [
          '--print-template',
          '--generated-at',
          '2026-05-05T11:10:01.000Z',
        ],
        secondIo,
      ),
    ).toBe(0);
    expect(secondIo.stderrText()).toBe('');
    expect(secondIo.stdoutText()).toBe(io.stdoutText());

    const workspace = mkdtempSync(join(tmpdir(), 'aa-task-health-template-'));
    try {
      const ledgerPath = join(workspace, 'control-plane.jsonl');
      writeFileSync(ledgerPath, io.stdoutText(), 'utf8');
      const reportIo = makeIo();

      const reportExitCode = runTaskHealthEvidenceReportCli(
        [
          '--ledger',
          ledgerPath,
          '--generated-at',
          '2026-05-05T11:11:00.000Z',
        ],
        reportIo,
      );

      expect(reportExitCode).toBe(0);
      expect(reportIo.stderrText()).toBe('');
      const report = JSON.parse(reportIo.stdoutText()) as {
        readonly status: string;
        readonly replayAudit: {
          readonly parsedEventCount: number;
          readonly parsedTaskHealthRecordCount: number;
        };
        readonly scorecard: {
          readonly recordCount: number;
          readonly taskScopedRecordCount: number;
          readonly correlationScopedRecordCount: number;
          readonly lastEventKindCounts: Record<string, number>;
          readonly averageStallMs: number;
          readonly maxStallMs: number;
          readonly maxThresholdMs: number;
          readonly lastObservedAt?: string;
          readonly qualityScore: { readonly value: number };
          readonly recommendations: readonly string[];
        };
      };
      expect(report.status).toBe('warn');
      expect(report.replayAudit.parsedEventCount).toBe(1);
      expect(report.replayAudit.parsedTaskHealthRecordCount).toBe(1);
      expect(report.scorecard.recordCount).toBe(1);
      expect(report.scorecard.taskScopedRecordCount).toBe(0);
      expect(report.scorecard.correlationScopedRecordCount).toBe(0);
      expect(report.scorecard.lastEventKindCounts).toEqual({
        'template.progress': 1,
      });
      expect(report.scorecard.averageStallMs).toBe(1000);
      expect(report.scorecard.maxStallMs).toBe(1000);
      expect(report.scorecard.maxThresholdMs).toBe(1000);
      expect(report.scorecard.lastObservedAt).toBe('2026-05-05T11:10:01.000Z');
      expect(report.scorecard.qualityScore.value).toBeLessThan(100);
      expect(report.scorecard.recommendations.join('\n')).toContain('task scope');
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'runtime correlation scope',
      );
      expect(reportIo.stdoutText()).not.toContain('task-health-evidence-template');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails report status for unsafe task-health payloads without rendering values', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'aa-task-health-unsafe-'));
    try {
      const ledgerPath = join(workspace, 'control-plane.jsonl');
      writeFileSync(
        ledgerPath,
        [
          taskHealthEventLine(1),
          taskHealthEventLine(2, {
            payload: { instruction: 'SECRET raw instruction must not render' },
          }),
          taskHealthEventLine(3, {
            payload: {
              metadata: { prompt: 'SECRET nested prompt must not render' },
            },
          }),
          taskHealthEventLine(4, {
            payload: { metadata: nestedPayload(20) },
          }),
        ].join('\n'),
        'utf8',
      );

      const io = makeIo();
      const exitCode = runTaskHealthEvidenceReportCli(['--ledger', ledgerPath], io);
      const report = JSON.parse(io.stdoutText()) as {
        readonly status: string;
        readonly replayAudit: { readonly unsafePayloadLineCount: number };
      };

      expect(exitCode).toBe(0);
      expect(report.status).toBe('fail');
      expect(report.replayAudit.unsafePayloadLineCount).toBe(3);
      expect(io.stdoutText()).not.toContain('SECRET raw instruction');
      expect(io.stdoutText()).not.toContain('SECRET nested prompt');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails closed for invalid task health evidence CLI arguments and byte guard', () => {
    expect(
      parseTaskHealthEvidenceReportCliArgs(['--ledger', 'control-plane.jsonl']),
    ).toMatchObject({
      ledgerPath: 'control-plane.jsonl',
      filter: {},
      maxLedgerBytes: TASK_HEALTH_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
      printTemplate: false,
    });
    expect(parseTaskHealthEvidenceReportCliArgs(['--print-template'])).toEqual({
      filter: {},
      maxLedgerBytes: TASK_HEALTH_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES,
      pretty: false,
      printTemplate: true,
    });
    expect(() =>
      parseTaskHealthEvidenceReportCliArgs([
        '--print-template',
        '--generated-at',
        'not-an-instant',
      ]),
    ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp.');
    expect(() =>
      parseTaskHealthEvidenceReportCliArgs([
        '--print-template',
        '--generated-at',
        '2026-05-05T11:10:00.000+09:00',
      ]),
    ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp.');
    expect(() =>
      parseTaskHealthEvidenceReportCliArgs([
        '--print-template',
        '--ledger',
        'control-plane.jsonl',
      ]),
    ).toThrow('--print-template cannot be combined with --ledger');
    expect(() =>
      parseTaskHealthEvidenceReportCliArgs(['--print-template', '--pretty']),
    ).toThrow(/--print-template cannot be combined with report-only options/);
    expect(() =>
      parseTaskHealthEvidenceReportCliArgs([
        '--print-template',
        '--last-event-kind',
        'turn.started',
      ]),
    ).toThrow(/--print-template cannot be combined with report-only options/);
    expect(() =>
      parseTaskHealthEvidenceReportCliArgs(['--print-template', '--limit', '1']),
    ).toThrow(/--print-template cannot be combined with report-only options/);
    expect(() =>
      parseTaskHealthEvidenceReportCliArgs([
        '--print-template',
        '--max-ledger-bytes',
        '100',
      ]),
    ).toThrow(/--print-template cannot be combined with report-only options/);
    expect(() =>
      buildTaskHealthEvidenceReportFromCliOptions({
        filter: {},
        maxLedgerBytes: 10_000,
        pretty: false,
        printTemplate: true,
      }),
    ).toThrow(/Cannot build a task health evidence report from --print-template options/);
    expect(() =>
      parseTaskHealthEvidenceReportCliArgs([
        '--ledger',
        'control-plane.jsonl',
        '--limit',
        '-1',
      ]),
    ).toThrow('--limit must be a non-negative integer.');
    expect(() =>
      parseTaskHealthEvidenceReportCliArgs([
        '--ledger',
        'control-plane.jsonl',
        '--generated-at',
        'not-an-instant',
      ]),
    ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp.');
    for (const invalidMaxLedgerBytes of [
      '0',
      '-1',
      '1.5',
      'abc',
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      expect(() =>
        parseTaskHealthEvidenceReportCliArgs([
          '--ledger',
          'control-plane.jsonl',
          '--max-ledger-bytes',
          invalidMaxLedgerBytes,
        ]),
      ).toThrow('--max-ledger-bytes must be a positive safe integer.');
    }

    const workspace = mkdtempSync(join(tmpdir(), 'aa-task-health-byte-'));
    try {
      const ledgerPath = join(workspace, 'control-plane.jsonl');
      writeFileSync(ledgerPath, taskHealthEventLine(1), 'utf8');
      const io = makeIo();
      const exitCode = runTaskHealthEvidenceReportCli(
        ['--ledger', ledgerPath, '--max-ledger-bytes', '1'],
        io,
      );

      expect(exitCode).toBe(1);
      expect(io.stderrText()).toContain('task:health:evidence:report failed');
      expect(io.stderrText()).toContain('exceeds --max-ledger-bytes');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }

    const helpIo = makeIo();
    expect(runTaskHealthEvidenceReportCli(['--help'], helpIo)).toBe(0);
    const stdout = helpIo.stdoutText();
    expect(stdout).toContain('--print-template');
    expect(stdout).toContain('non-promoting task.health_stalled');
    expect(stdout).toContain('Template mode accepts only --generated-at');
    expect(stdout).toContain('--ledger,');
  });
});
