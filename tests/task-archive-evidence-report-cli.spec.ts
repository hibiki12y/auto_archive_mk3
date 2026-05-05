import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_LEDGER_PATH,
  AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_MAX_LEDGER_BYTES,
  buildDoctorReportFromEnv,
  buildTaskArchiveEvidenceReportFromCliOptions,
  parseTaskArchiveEvidenceReportCliArgs,
  renderDoctorReport,
  runTaskArchiveEvidenceReportCli,
  type TaskArchiveEvidenceTemplateRecord,
} from '../src/index.js';

function safeHash(seed: number): `sha256:${string}` {
  return `sha256:${seed.toString(16).padStart(16, '0')}`;
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

function archiveEvidenceLine(
  action: 'archive' | 'unarchive',
  index: number,
  payloadOverrides: Record<string, unknown> = {},
): string {
  const archived = action === 'archive';
  return JSON.stringify({
    schemaVersion: 1,
    eventId: `task-archive-evidence-${index}`,
    timestamp: `2026-05-05T07:0${index}:00.000Z`,
    type: archived ? 'task.archived' : 'task.unarchived',
    actor: { kind: 'discord-user', userId: `raw-user-${index}` },
    taskId: `raw-task-${index}`,
    trust: { source: 'discord', inputTrust: 'trusted' },
    payload: {
      archiveAudit: {
        schemaVersion: 1,
        action,
        legacyEventType: archived ? 'task.archived' : 'task.unarchived',
        status: archived ? 'archived' : 'unarchived',
        occurredAt: `2026-05-05T07:0${index}:00.000Z`,
        retained: true,
        taskIdPresent: true,
        actorPresent: true,
        actorHash: safeHash(1000 + index),
        reasonPresent: true,
        reasonHash: safeHash(2000 + index),
        requestIdPresent: false,
      },
      ...payloadOverrides,
    },
  });
}

describe('task archive evidence report CLI model', () => {
  it('scores retained archive/unarchive JSONL without rendering raw task actor or reason values', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-task-archive-report-'));
    try {
      const ledgerPath = join(workspace, 'control-plane.jsonl');
      writeFileSync(
        ledgerPath,
        [
          archiveEvidenceLine('archive', 1),
          archiveEvidenceLine('unarchive', 2),
          JSON.stringify({
            schemaVersion: 1,
            eventId: 'task-accepted-secret',
            timestamp: '2026-05-05T07:03:00.000Z',
            type: 'task.accepted',
            actor: { kind: 'system' },
            trust: { source: 'system', inputTrust: 'trusted' },
            payload: { instruction: 'SECRET ignored instruction' },
          }),
        ].join('\n'),
        'utf8',
      );

      const report = buildTaskArchiveEvidenceReportFromCliOptions({
        ledgerPath,
        filter: {},
        maxLedgerBytes: 10_000,
        generatedAt: '2026-05-05T07:10:00.000Z',
        pretty: false,
        printTemplate: false,
      });
      const rendered = JSON.stringify(report);

      expect(report.status).toBe('complete');
      expect(report.scorecard.recordCount).toBe(2);
      expect(report.scorecard.archiveRecordCount).toBe(1);
      expect(report.scorecard.unarchiveRecordCount).toBe(1);
      expect(report.scorecard.qualityScore.value).toBe(100);
      expect(report.boundary).toMatchObject({
        readOnly: true,
        liveServicesContacted: false,
        ledgerMutated: false,
        rawTaskIdsRendered: false,
        rawActorIdsRendered: false,
        rawReasonsRendered: false,
      });
      expect(rendered).not.toContain('raw-task');
      expect(rendered).not.toContain('raw-user');
      expect(rendered).not.toContain('SECRET ignored instruction');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('prints a compact non-promoting task.archived control-plane JSONL template', () => {
    const io = makeIo();

    const exitCode = runTaskArchiveEvidenceReportCli(
      [
        '--print-template',
        '--generated-at',
        '2026-05-05T07:10:00.000Z',
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    const [line, trailing] = io.stdoutText().split('\n');
    expect(trailing).toBe('');
    expect(line).toBe(JSON.stringify(JSON.parse(line ?? '{}')));
    const record = JSON.parse(io.stdoutText()) as TaskArchiveEvidenceTemplateRecord;
    const expectedRecord = {
      schemaVersion: 1,
      eventId: 'task-archive-evidence-template',
      timestamp: '2026-05-05T07:10:00.000Z',
      type: 'task.archived',
      actor: { kind: 'system' },
      trust: { source: 'system', inputTrust: 'trusted' },
      payload: {
        archiveAudit: {
          schemaVersion: 1,
          action: 'archive',
          legacyEventType: 'task.archived',
          status: 'archived',
          occurredAt: '2026-05-05T07:10:00.000Z',
          retained: true,
          taskIdPresent: true,
          taskHash: 'sha256:0000000000000001',
          actorPresent: true,
          actorHash: 'sha256:0000000000000002',
          reasonPresent: false,
          requestIdPresent: false,
        },
      },
    } as const satisfies TaskArchiveEvidenceTemplateRecord;
    expect(record).toEqual(expectedRecord);
    expect(io.stdoutText()).toBe(`${JSON.stringify(expectedRecord)}\n`);
    expect(io.stdoutText()).not.toContain('SECRET');
    expect(io.stdoutText()).not.toContain('raw prompt');

    const secondIo = makeIo();
    expect(
      runTaskArchiveEvidenceReportCli(
        [
          '--print-template',
          '--generated-at',
          '2026-05-05T07:10:00.000Z',
        ],
        secondIo,
      ),
    ).toBe(0);
    expect(secondIo.stderrText()).toBe('');
    expect(secondIo.stdoutText()).toBe(io.stdoutText());

    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-task-archive-template-'));
    try {
      const ledgerPath = join(workspace, 'control-plane.jsonl');
      writeFileSync(ledgerPath, io.stdoutText(), 'utf8');
      const reportIo = makeIo();

      const reportExitCode = runTaskArchiveEvidenceReportCli(
        [
          '--ledger',
          ledgerPath,
          '--generated-at',
          '2026-05-05T07:11:00.000Z',
        ],
        reportIo,
      );

      expect(reportExitCode).toBe(0);
      expect(reportIo.stderrText()).toBe('');
      const report = JSON.parse(reportIo.stdoutText()) as {
        readonly status: string;
        readonly replayAudit: {
          readonly parsedEventCount: number;
          readonly parsedTaskArchiveRecordCount: number;
        };
        readonly scorecard: {
          readonly recordCount: number;
          readonly archiveEventCount: number;
          readonly unarchiveEventCount: number;
          readonly taskScopedRecordCount: number;
          readonly actorAttributedRecordCount: number;
          readonly currentArchivedTaskCount: number;
          readonly lastObservedAt?: string;
          readonly qualityScore: { readonly value: number };
          readonly recommendations: readonly string[];
        };
      };
      expect(report.status).toBe('warn');
      expect(report.replayAudit.parsedEventCount).toBe(1);
      expect(report.replayAudit.parsedTaskArchiveRecordCount).toBe(1);
      expect(report.scorecard.recordCount).toBe(1);
      expect(report.scorecard.archiveEventCount).toBe(1);
      expect(report.scorecard.unarchiveEventCount).toBe(0);
      expect(report.scorecard.taskScopedRecordCount).toBe(1);
      expect(report.scorecard.actorAttributedRecordCount).toBe(1);
      expect(report.scorecard.currentArchivedTaskCount).toBe(1);
      expect(report.scorecard.lastObservedAt).toBe('2026-05-05T07:10:00.000Z');
      expect(report.scorecard.qualityScore.value).toBeLessThan(100);
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'task.unarchived',
      );
      expect(reportIo.stdoutText()).not.toContain('task-archive-evidence-template');
      expect(reportIo.stdoutText()).not.toContain('sha256:0000000000000001');
      expect(reportIo.stdoutText()).not.toContain('sha256:0000000000000002');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('parses task archive template mode arguments with fail-closed report option boundaries', () => {
    expect(parseTaskArchiveEvidenceReportCliArgs(['--print-template'])).toEqual({
      filter: {},
      maxLedgerBytes: 10 * 1024 * 1024,
      pretty: false,
      printTemplate: true,
    });
    expect(() =>
      parseTaskArchiveEvidenceReportCliArgs([
        '--print-template',
        '--generated-at',
        'not-a-date',
      ]),
    ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp');
    expect(() =>
      parseTaskArchiveEvidenceReportCliArgs([
        '--print-template',
        '--generated-at',
        '2026-05-05T07:10:00.000+09:00',
      ]),
    ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp');
    expect(() =>
      parseTaskArchiveEvidenceReportCliArgs([
        '--print-template',
        '--ledger',
        'control-plane.jsonl',
      ]),
    ).toThrow('--print-template cannot be combined with --ledger');
    expect(() =>
      parseTaskArchiveEvidenceReportCliArgs(['--print-template', '--pretty']),
    ).toThrow(/--print-template cannot be combined with report-only options/);
    expect(() =>
      parseTaskArchiveEvidenceReportCliArgs([
        '--print-template',
        '--event-type',
        'task.archived',
      ]),
    ).toThrow(/--print-template cannot be combined with report-only options/);
    expect(() =>
      parseTaskArchiveEvidenceReportCliArgs([
        '--print-template',
        '--action',
        'archive',
      ]),
    ).toThrow(/--print-template cannot be combined with report-only options/);
    expect(() =>
      parseTaskArchiveEvidenceReportCliArgs(['--print-template', '--limit', '1']),
    ).toThrow(/--print-template cannot be combined with report-only options/);
    expect(() =>
      parseTaskArchiveEvidenceReportCliArgs([
        '--print-template',
        '--max-ledger-bytes',
        '100',
      ]),
    ).toThrow(/--print-template cannot be combined with report-only options/);
    expect(() =>
      buildTaskArchiveEvidenceReportFromCliOptions({
        filter: {},
        maxLedgerBytes: 10_000,
        pretty: false,
        printTemplate: true,
      }),
    ).toThrow(/Cannot build a task archive evidence report from --print-template options/);

    const helpIo = makeIo();
    expect(runTaskArchiveEvidenceReportCli(['--help'], helpIo)).toBe(0);
    const stdout = helpIo.stdoutText();
    expect(stdout).toContain('--print-template');
    expect(stdout).toContain('non-promoting task.archived control-plane');
    expect(stdout).toContain('Template mode accepts only --generated-at');
    expect(stdout).toContain('--ledger, --event-type');
  });

  it('flags unsafe legacy raw archive payloads and redacts doctor output', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-doctor-task-archive-'));
    try {
      const ledgerPath = join(workspace, 'control-plane.jsonl');
      writeFileSync(
        ledgerPath,
        [
          archiveEvidenceLine('archive', 1, {
            archive: { archivedBy: 'SECRET raw user', reason: 'SECRET raw reason' },
          }),
          archiveEvidenceLine('unarchive', 2),
          '{"schemaVersion":1,"eventId":"broken"',
        ].join('\n'),
        'utf8',
      );

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_LEDGER_PATH]: ledgerPath,
          [AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_MAX_LEDGER_BYTES]: '10000',
        }),
      );

      expect(text).toContain('[FAIL] Task archive evidence report');
      expect(text).toContain('Report status: fail');
      expect(text).toContain('Unsafe payload lines: 1');
      expect(text).toContain('Malformed/torn lines: 1');
      expect(text).toContain('Raw task ids: not rendered');
      expect(text).toContain('Raw actor ids: not rendered');
      expect(text).toContain('Raw reasons: not rendered');
      expect(text).toContain('Live service contact: none');
      expect(text).not.toContain(workspace);
      expect(text).not.toContain('SECRET raw user');
      expect(text).not.toContain('SECRET raw reason');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails archiveAudit records that include unexpected raw fields', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-task-archive-extra-'));
    try {
      const ledgerPath = join(workspace, 'control-plane.jsonl');
      writeFileSync(
        ledgerPath,
        [
          archiveEvidenceLine('archive', 1, {
            archiveAudit: {
              action: 'archive',
              legacyEventType: 'task.archived',
              status: 'archived',
              occurredAt: '2026-05-05T07:01:00.000Z',
              retained: true,
              taskIdPresent: true,
              actorPresent: true,
              actorHash: safeHash(3001),
              reasonPresent: true,
              reasonHash: safeHash(3002),
              requestIdPresent: false,
              reason: 'SECRET unexpected raw reason',
            },
          }),
          archiveEvidenceLine('unarchive', 2),
        ].join('\n'),
        'utf8',
      );

      const report = buildTaskArchiveEvidenceReportFromCliOptions({
        ledgerPath,
        filter: {},
        maxLedgerBytes: 10_000,
        pretty: false,
        printTemplate: false,
      });

      expect(report.status).toBe('fail');
      expect(report.replayAudit.unsafePayloadLineCount).toBe(1);
      expect(report.replayAudit.parsedTaskArchiveRecordCount).toBe(1);
      expect(JSON.stringify(report)).not.toContain('SECRET unexpected raw reason');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails hash-named archiveAudit fields that are not stable hash-shaped', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-task-archive-hash-'));
    try {
      const ledgerPath = join(workspace, 'control-plane.jsonl');
      writeFileSync(
        ledgerPath,
        [
          archiveEvidenceLine('archive', 1, {
            archiveAudit: {
              schemaVersion: 1,
              action: 'archive',
              legacyEventType: 'task.archived',
              status: 'archived',
              occurredAt: '2026-05-05T07:01:00.000Z',
              retained: true,
              taskIdPresent: true,
              taskHash: 'SECRET raw task smuggled under hash key',
              actorPresent: true,
              actorHash: safeHash(6001),
              reasonPresent: false,
              requestIdPresent: false,
            },
          }),
          archiveEvidenceLine('unarchive', 2),
        ].join('\n'),
        'utf8',
      );

      const report = buildTaskArchiveEvidenceReportFromCliOptions({
        ledgerPath,
        filter: {},
        maxLedgerBytes: 10_000,
        pretty: false,
        printTemplate: false,
      });

      expect(report.status).toBe('fail');
      expect(report.replayAudit.unsafePayloadLineCount).toBe(1);
      expect(JSON.stringify(report)).not.toContain('SECRET raw task');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('pins schemaVersion compatibility and present-but-invalid schema rejection', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-task-archive-schema-'));
    try {
      const ledgerPath = join(workspace, 'control-plane.jsonl');
      const invalidSchemaValues: readonly unknown[] = ['1', 0, null, 2];
      writeFileSync(
        ledgerPath,
        [
          ...invalidSchemaValues.map((schemaVersion, offset) =>
            archiveEvidenceLine('archive', offset + 1, {
              archiveAudit: {
                schemaVersion,
                action: 'archive',
                legacyEventType: 'task.archived',
                status: 'archived',
                occurredAt: `2026-05-05T07:0${String(offset + 1)}:00.000Z`,
                retained: true,
                taskIdPresent: true,
                taskHash: safeHash(7000 + offset),
                actorPresent: true,
                actorHash: safeHash(7100 + offset),
                reasonPresent: false,
                requestIdPresent: false,
              },
            }),
          ),
          archiveEvidenceLine('unarchive', 5, {
            archiveAudit: {
              action: 'unarchive',
              legacyEventType: 'task.unarchived',
              status: 'unarchived',
              occurredAt: '2026-05-05T07:05:00.000Z',
              retained: true,
              taskIdPresent: true,
              taskHash: safeHash(7005),
              actorPresent: true,
              actorHash: safeHash(7105),
              reasonPresent: false,
              requestIdPresent: false,
            },
          }),
        ].join('\n'),
        'utf8',
      );

      const report = buildTaskArchiveEvidenceReportFromCliOptions({
        ledgerPath,
        filter: {},
        maxLedgerBytes: 10_000,
        pretty: false,
        printTemplate: false,
      });

      expect(report.status).toBe('warn');
      expect(report.replayAudit.skippedMalformedLineCount).toBe(4);
      expect(report.replayAudit.unsafePayloadLineCount).toBe(0);
      expect(report.scorecard.recordCount).toBe(1);
      expect(report.scorecard.unarchiveEventCount).toBe(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails all malformed hash-shape variants without partial rendering', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-task-archive-hash-variants-'));
    try {
      const ledgerPath = join(workspace, 'control-plane.jsonl');
      const malformedHashes = [
        'sha256:ABCDEF0123456789',
        '',
        'sha256:abc',
        `sha256:${'a'.repeat(64)}`,
        'SECRET mixed raw value',
      ];
      writeFileSync(
        ledgerPath,
        [
          ...malformedHashes.map((taskHash, offset) =>
            archiveEvidenceLine('archive', offset + 1, {
              archiveAudit: {
                schemaVersion: 1,
                action: 'archive',
                legacyEventType: 'task.archived',
                status: 'archived',
                occurredAt: `2026-05-05T07:0${String(offset + 1)}:00.000Z`,
                retained: true,
                taskIdPresent: true,
                taskHash,
                actorPresent: true,
                actorHash: safeHash(8100 + offset),
                reasonPresent: false,
                requestIdPresent: false,
              },
            }),
          ),
          archiveEvidenceLine('unarchive', 6),
        ].join('\n'),
        'utf8',
      );

      const report = buildTaskArchiveEvidenceReportFromCliOptions({
        ledgerPath,
        filter: {},
        maxLedgerBytes: 10_000,
        pretty: false,
        printTemplate: false,
      });

      expect(report.status).toBe('fail');
      expect(report.replayAudit.unsafePayloadLineCount).toBe(5);
      expect(report.replayAudit.parsedTaskArchiveRecordCount).toBe(1);
      const rendered = JSON.stringify(report);
      expect(rendered).not.toContain('ABCDEF0123456789');
      expect(rendered).not.toContain('SECRET mixed raw value');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('warns on retained transition anomalies when a safe task hash is available', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-task-archive-anomaly-'));
    try {
      const ledgerPath = join(workspace, 'control-plane.jsonl');
      writeFileSync(
        ledgerPath,
        [
          archiveEvidenceLine('archive', 1, {
            archiveAudit: {
              action: 'archive',
              legacyEventType: 'task.archived',
              status: 'archived',
              occurredAt: '2026-05-05T07:01:00.000Z',
              retained: true,
              taskIdPresent: true,
              taskHash: safeHash(4001),
              actorPresent: true,
              actorHash: safeHash(4002),
              reasonPresent: false,
              requestIdPresent: false,
            },
          }),
          archiveEvidenceLine('archive', 2, {
            archiveAudit: {
              action: 'archive',
              legacyEventType: 'task.archived',
              status: 'archived',
              occurredAt: '2026-05-05T07:02:00.000Z',
              retained: true,
              taskIdPresent: true,
              taskHash: safeHash(4001),
              actorPresent: true,
              actorHash: safeHash(4002),
              reasonPresent: false,
              requestIdPresent: false,
            },
          }),
          archiveEvidenceLine('unarchive', 3, {
            archiveAudit: {
              action: 'unarchive',
              legacyEventType: 'task.unarchived',
              status: 'unarchived',
              occurredAt: '2026-05-05T07:03:00.000Z',
              retained: true,
              taskIdPresent: true,
              taskHash: safeHash(4003),
              actorPresent: true,
              actorHash: safeHash(4004),
              reasonPresent: false,
              requestIdPresent: false,
            },
          }),
        ].join('\n'),
        'utf8',
      );

      const report = buildTaskArchiveEvidenceReportFromCliOptions({
        ledgerPath,
        filter: {},
        maxLedgerBytes: 10_000,
        pretty: false,
        printTemplate: false,
      });

      expect(report.status).toBe('warn');
      expect(report.scorecard.duplicateArchiveCount).toBe(1);
      expect(report.scorecard.unmatchedUnarchiveCount).toBe(1);
      expect(report.scorecard.currentArchivedTaskCount).toBe(1);
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'duplicate archive',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('annotates filtered reports because transition counts are scoped to the filter', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-task-archive-filter-'));
    try {
      const ledgerPath = join(workspace, 'control-plane.jsonl');
      writeFileSync(
        ledgerPath,
        [
          archiveEvidenceLine('archive', 1, {
            archiveAudit: {
              action: 'archive',
              legacyEventType: 'task.archived',
              status: 'archived',
              occurredAt: '2026-05-05T07:01:00.000Z',
              retained: true,
              taskIdPresent: true,
              taskHash: safeHash(5001),
              actorPresent: true,
              actorHash: safeHash(5002),
              reasonPresent: false,
              requestIdPresent: false,
            },
          }),
          archiveEvidenceLine('unarchive', 2, {
            archiveAudit: {
              action: 'unarchive',
              legacyEventType: 'task.unarchived',
              status: 'unarchived',
              occurredAt: '2026-05-05T07:02:00.000Z',
              retained: true,
              taskIdPresent: true,
              taskHash: safeHash(5001),
              actorPresent: true,
              actorHash: safeHash(5002),
              reasonPresent: false,
              requestIdPresent: false,
            },
          }),
        ].join('\n'),
        'utf8',
      );

      const report = buildTaskArchiveEvidenceReportFromCliOptions({
        ledgerPath,
        filter: { eventType: 'task.archived' },
        maxLedgerBytes: 10_000,
        pretty: false,
        printTemplate: false,
      });

      expect(report.status).toBe('warn');
      expect(report.scorecard.filterApplied).toBe(true);
      expect(report.scorecard.transitionCountsFiltered).toBe(true);
      expect(report.scorecard.currentArchivedTaskCount).toBe(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
