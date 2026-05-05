import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH,
  AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_MAX_LEDGER_BYTES,
  buildDoctorReportFromEnv,
  buildSubagentOperatorEvidenceReportFromCliOptions,
  parseSubagentOperatorEvidenceReportCliArgs,
  renderDoctorReport,
  runSubagentOperatorEvidenceReportCli,
  type SubagentOperatorEvidenceTemplateRecord,
} from '../src/index.js';

type RosterKind =
  | 'subagent.spawned'
  | 'subagent.completed'
  | 'subagent.aborted'
  | 'subagent.failed'
  | 'roster.progress';

function correlation(index: number): {
  readonly taskId: string;
  readonly instanceId: string;
  readonly subagentId: string;
} {
  return {
    taskId: `SECRET-subagent-task-${String(index)}`,
    instanceId: `SECRET-subagent-runtime-${String(index)}`,
    subagentId: `SECRET-subagent-id-${String(index)}`,
  };
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

function rosterEventLine(
  kind: RosterKind,
  index: number,
  overrides: Record<string, unknown> = {},
): string {
  const key = correlation(index);
  const timestamp = `2026-05-05T08:0${String(index)}:00.000Z`;
  const base = {
    kind,
    correlationKey: key,
    timestamp,
  } as const;
  if (kind === 'subagent.spawned') {
    return JSON.stringify({
      ...base,
      descriptor: {
        subagentId: key.subagentId,
        role: index % 2 === 0 ? 'coder' : 'explorer',
        parent: { taskId: key.taskId, instanceId: key.instanceId },
        createdAt: timestamp,
        state: 'active',
        envelope: {
          requested: {
            cpuCores: 1,
            memoryMiB: 512,
            wallTimeSec: 60,
            gpuCards: 0,
          },
          effective: {
            cpuCores: 1,
            memoryMiB: 512,
            wallTimeSec: 60,
            gpuCards: 0,
          },
        },
      },
      ...overrides,
    });
  }
  if (kind === 'subagent.completed') {
    return JSON.stringify({
      ...base,
      artifact: { digest: `sha256:${String(index).padStart(16, '0')}`, ref: `artifact://subagent/${String(index)}` },
      cause: {
        kind: 'success',
        taskId: key.taskId,
        runtimeInstanceId: key.instanceId,
        observedAt: timestamp,
        provenance: 'test',
      },
      ...overrides,
    });
  }
  if (kind === 'subagent.failed') {
    return JSON.stringify({
      ...base,
      cause: {
        kind: 'driver-failure',
        taskId: key.taskId,
        runtimeInstanceId: key.instanceId,
        observedAt: timestamp,
        provenance: 'test',
        classification: 'unknown',
        retryable: false,
      },
      ...overrides,
    });
  }
  if (kind === 'subagent.aborted') {
    return JSON.stringify({
      ...base,
      partialArtifact: { digest: `sha256:${String(index).padStart(16, 'a')}` },
      cause: {
        kind: 'external-cancel',
        taskId: key.taskId,
        runtimeInstanceId: key.instanceId,
        observedAt: timestamp,
        provenance: 'test',
        requestedBy: 'operator',
      },
      ...overrides,
    });
  }
  return JSON.stringify({
    ...base,
    completed: 1,
    aborted: 0,
    failed: 0,
    total: 1,
    inFlight: 0,
    ...overrides,
  });
}

describe('subagent operator evidence report CLI model', () => {
  it('scores retained roster-event JSONL without rendering raw subagent task runtime ids or artifacts', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-subagent-evidence-'));
    try {
      const ledgerPath = join(workspace, 'subagent-roster-events.jsonl');
      writeFileSync(
        ledgerPath,
        [
          rosterEventLine('subagent.spawned', 1),
          rosterEventLine('subagent.completed', 1),
          rosterEventLine('roster.progress', 1),
        ].join('\n'),
        'utf8',
      );

      const report = buildSubagentOperatorEvidenceReportFromCliOptions({
        ledgerPath,
        filter: {},
        maxLedgerBytes: 10_000,
        generatedAt: '2026-05-05T08:10:00.000Z',
        pretty: false,
        printTemplate: false,
      });
      const rendered = JSON.stringify(report);

      expect(report.schemaVersion).toBe(1);
      expect(report.generatedAt).toBe('2026-05-05T08:10:00.000Z');
      expect(report.method.scoringRubricVersion).toBe(
        '2026-05-05.subagent-operator-evidence-v2',
      );
      expect(report.status).toBe('complete');
      expect(report.scorecard.recordCount).toBe(3);
      expect(report.scorecard.spawnedCount).toBe(1);
      expect(report.scorecard.completedCount).toBe(1);
      expect(report.scorecard.progressCount).toBe(1);
      expect(report.scorecard.terminalCount).toBe(1);
      expect(report.scorecard.currentActiveSubagentCount).toBe(0);
      expect(report.scorecard.filterApplied).toBe(false);
      expect(report.scorecard.transitionCountsFiltered).toBe(false);
      expect(report.scorecard.qualityScore.value).toBe(100);
      expect(report.boundary).toMatchObject({
        readOnly: true,
        liveServicesContacted: false,
        rosterMutated: false,
        ledgerMutated: false,
        rawSubagentIdsRendered: false,
        rawTaskIdsRendered: false,
        rawRuntimeIdsRendered: false,
        rawMessagesRendered: false,
        rawArtifactsRendered: false,
        rawPayloadRendered: false,
      });
      expect(rendered).not.toContain('SECRET-subagent-task');
      expect(rendered).not.toContain('SECRET-subagent-runtime');
      expect(rendered).not.toContain('SECRET-subagent-id');
      expect(rendered).not.toContain('artifact://subagent');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps spawn and terminal evidence warning-scoped until a roster.progress sample is retained', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-subagent-progress-'));
    try {
      const ledgerPath = join(workspace, 'subagent-roster-events.jsonl');
      writeFileSync(
        ledgerPath,
        [
          rosterEventLine('subagent.spawned', 1),
          rosterEventLine('subagent.completed', 1),
        ].join('\n'),
        'utf8',
      );

      const report = buildSubagentOperatorEvidenceReportFromCliOptions({
        ledgerPath,
        filter: {},
        maxLedgerBytes: 10_000,
        generatedAt: '2026-05-05T08:10:00.000Z',
        pretty: false,
        printTemplate: false,
      });

      expect(report.status).toBe('warn');
      expect(report.scorecard.recordCount).toBe(2);
      expect(report.scorecard.spawnedCount).toBe(1);
      expect(report.scorecard.terminalCount).toBe(1);
      expect(report.scorecard.progressCount).toBe(0);
      expect(report.scorecard.qualityScore.value).toBe(90);
      expect(report.scorecard.recommendations).toContain(
        'Record at least one roster.progress sample from the root-owned roster.',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('prints a compact non-promoting roster-event JSONL template', () => {
    const io = makeIo();

    const exitCode = runSubagentOperatorEvidenceReportCli(
      [
        '--print-template',
        '--generated-at',
        '2026-05-05T08:10:00.000Z',
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    const [line, trailing] = io.stdoutText().split('\n');
    expect(trailing).toBe('');
    expect(line).toBe(JSON.stringify(JSON.parse(line ?? '{}')));
    const record = JSON.parse(io.stdoutText()) as SubagentOperatorEvidenceTemplateRecord;
    const expectedRecord = {
      kind: 'subagent.spawned',
      correlationKey: {
        taskId: 'task-subagent-operator-template',
        instanceId: 'runtime-subagent-operator-template',
        subagentId: 'subagent-operator-template',
      },
      timestamp: '2026-05-05T08:10:00.000Z',
      descriptor: {
        subagentId: 'subagent-operator-template',
        role: 'template',
        parent: {
          taskId: 'task-subagent-operator-template',
          instanceId: 'runtime-subagent-operator-template',
        },
        createdAt: '2026-05-05T08:10:00.000Z',
        state: 'active',
        envelope: {
          requested: {
            cpuCores: 1,
            memoryMiB: 512,
            wallTimeSec: 60,
            gpuCards: 0,
          },
          effective: {
            cpuCores: 1,
            memoryMiB: 512,
            wallTimeSec: 60,
            gpuCards: 0,
          },
        },
      },
    } as const satisfies SubagentOperatorEvidenceTemplateRecord;
    expect(record).toEqual(expectedRecord);
    expect(io.stdoutText()).toBe(`${JSON.stringify(expectedRecord)}\n`);
    expect(io.stdoutText()).not.toContain('SECRET');
    expect(io.stdoutText()).not.toContain('raw prompt');

    const secondIo = makeIo();
    expect(
      runSubagentOperatorEvidenceReportCli(
        [
          '--print-template',
          '--generated-at',
          '2026-05-05T08:10:00.000Z',
        ],
        secondIo,
      ),
    ).toBe(0);
    expect(secondIo.stderrText()).toBe('');
    expect(secondIo.stdoutText()).toBe(io.stdoutText());

    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-subagent-template-'));
    try {
      const ledgerPath = join(workspace, 'subagent-roster-events.jsonl');
      writeFileSync(ledgerPath, io.stdoutText(), 'utf8');
      const reportIo = makeIo();

      const reportExitCode = runSubagentOperatorEvidenceReportCli(
        [
          '--ledger',
          ledgerPath,
          '--generated-at',
          '2026-05-05T08:11:00.000Z',
        ],
        reportIo,
      );

      expect(reportExitCode).toBe(0);
      expect(reportIo.stderrText()).toBe('');
      const report = JSON.parse(reportIo.stdoutText()) as {
        readonly status: string;
        readonly replayAudit: { readonly parsedRecordCount: number };
        readonly scorecard: {
          readonly recordCount: number;
          readonly spawnedCount: number;
          readonly terminalCount: number;
          readonly progressCount: number;
          readonly currentActiveSubagentCount: number;
          readonly roleCounts: Record<string, number>;
          readonly lastObservedAt?: string;
          readonly qualityScore: { readonly value: number };
          readonly recommendations: readonly string[];
        };
      };
      expect(report.status).toBe('warn');
      expect(report.replayAudit.parsedRecordCount).toBe(1);
      expect(report.scorecard.recordCount).toBe(1);
      expect(report.scorecard.spawnedCount).toBe(1);
      expect(report.scorecard.terminalCount).toBe(0);
      expect(report.scorecard.progressCount).toBe(0);
      expect(report.scorecard.currentActiveSubagentCount).toBe(1);
      expect(report.scorecard.roleCounts).toEqual({ template: 1 });
      expect(report.scorecard.lastObservedAt).toBe('2026-05-05T08:10:00.000Z');
      expect(report.scorecard.qualityScore.value).toBeLessThan(100);
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'terminal event',
      );
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'roster.progress',
      );
      expect(reportIo.stdoutText()).not.toContain('task-subagent-operator-template');
      expect(reportIo.stdoutText()).not.toContain('runtime-subagent-operator-template');
      expect(reportIo.stdoutText()).not.toContain('subagent-operator-template');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails closed on unsafe raw messages, reasons, payloads, and raw artifact strings without rendering them', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-subagent-unsafe-'));
    try {
      const ledgerPath = join(workspace, 'subagent-roster-events.jsonl');
      writeFileSync(
        ledgerPath,
        [
          rosterEventLine('subagent.spawned', 1),
          rosterEventLine('subagent.completed', 1, {
            artifact: 'SECRET raw artifact must fail closed',
          }),
          rosterEventLine('subagent.failed', 2, {
            cause: {
              kind: 'driver-failure',
              taskId: correlation(2).taskId,
              runtimeInstanceId: correlation(2).instanceId,
              observedAt: '2026-05-05T08:02:00.000Z',
              provenance: 'test',
              message: 'SECRET raw failure message must fail closed',
            },
          }),
          rosterEventLine('roster.progress', 3, {
            payload: { instruction: 'SECRET raw prompt must fail closed' },
          }),
        ].join('\n'),
        'utf8',
      );

      const report = buildSubagentOperatorEvidenceReportFromCliOptions({
        ledgerPath,
        filter: {},
        maxLedgerBytes: 10_000,
        pretty: false,
        printTemplate: false,
      });
      const rendered = JSON.stringify(report);

      expect(report.status).toBe('fail');
      expect(report.replayAudit.unsafePayloadLineCount).toBe(3);
      expect(report.scorecard.recordCount).toBe(1);
      expect(rendered).not.toContain('SECRET raw artifact');
      expect(rendered).not.toContain('SECRET raw failure message');
      expect(rendered).not.toContain('SECRET raw prompt');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('annotates event-kind and limit filters because transition counts are filter-scoped', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-subagent-filter-'));
    try {
      const ledgerPath = join(workspace, 'subagent-roster-events.jsonl');
      writeFileSync(
        ledgerPath,
        [
          rosterEventLine('subagent.spawned', 1),
          rosterEventLine('subagent.completed', 1),
          rosterEventLine('subagent.spawned', 2),
          rosterEventLine('subagent.completed', 2),
        ].join('\n'),
        'utf8',
      );

      const report = buildSubagentOperatorEvidenceReportFromCliOptions({
        ledgerPath,
        filter: { eventKind: 'subagent.completed', limit: 1 },
        maxLedgerBytes: 10_000,
        pretty: false,
        printTemplate: false,
      });

      expect(report.status).toBe('warn');
      expect(report.filter).toEqual({ eventKind: 'subagent.completed', limit: 1 });
      expect(report.scorecard.recordCount).toBe(1);
      expect(report.scorecard.spawnedCount).toBe(0);
      expect(report.scorecard.completedCount).toBe(1);
      expect(report.scorecard.filterApplied).toBe(true);
      expect(report.scorecard.transitionCountsFiltered).toBe(true);
      expect(report.scorecard.terminalWithoutSpawnCount).toBe(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('validates CLI arguments and bounded ledger byte guards', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-subagent-args-'));
    try {
      const ledgerPath = join(workspace, 'subagent-roster-events.jsonl');
      writeFileSync(ledgerPath, rosterEventLine('subagent.spawned', 1), 'utf8');

      expect(parseSubagentOperatorEvidenceReportCliArgs(['--help'])).toBe('help');
      expect(() => parseSubagentOperatorEvidenceReportCliArgs([])).toThrow('--ledger is required');
      expect(
        parseSubagentOperatorEvidenceReportCliArgs(['--print-template']),
      ).toMatchObject({
        filter: {},
        printTemplate: true,
      });
      expect(() =>
        parseSubagentOperatorEvidenceReportCliArgs([
          '--ledger',
          ledgerPath,
          '--event-kind',
          'task.archived',
        ]),
      ).toThrow('--event-kind must be one of');
      expect(() =>
        parseSubagentOperatorEvidenceReportCliArgs(['--ledger', ledgerPath, '--limit', '-1']),
      ).toThrow('--limit must be a non-negative integer');
      expect(() =>
        parseSubagentOperatorEvidenceReportCliArgs([
          '--ledger',
          ledgerPath,
          '--generated-at',
          '2026-05-05',
        ]),
      ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp');
      expect(() =>
        parseSubagentOperatorEvidenceReportCliArgs([
          '--print-template',
          '--generated-at',
          'not-a-date',
        ]),
      ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp');
      expect(() =>
        parseSubagentOperatorEvidenceReportCliArgs([
          '--print-template',
          '--generated-at',
          '2026-05-05T08:10:00.000+09:00',
        ]),
      ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp');
      expect(() =>
        parseSubagentOperatorEvidenceReportCliArgs([
          '--ledger',
          ledgerPath,
          '--max-ledger-bytes',
          '0',
        ]),
      ).toThrow('--max-ledger-bytes must be a positive safe integer');
      expect(() =>
        parseSubagentOperatorEvidenceReportCliArgs([
          '--print-template',
          '--ledger',
          ledgerPath,
        ]),
      ).toThrow('--print-template cannot be combined with --ledger');
      expect(() =>
        parseSubagentOperatorEvidenceReportCliArgs([
          '--print-template',
          '--pretty',
        ]),
      ).toThrow(/--print-template cannot be combined with report-only options/);
      expect(() =>
        parseSubagentOperatorEvidenceReportCliArgs([
          '--print-template',
          '--event-kind',
          'subagent.spawned',
        ]),
      ).toThrow(/--print-template cannot be combined with report-only options/);
      expect(() =>
        parseSubagentOperatorEvidenceReportCliArgs([
          '--print-template',
          '--limit',
          '1',
        ]),
      ).toThrow(/--print-template cannot be combined with report-only options/);
      expect(() =>
        parseSubagentOperatorEvidenceReportCliArgs([
          '--print-template',
          '--max-ledger-bytes',
          '100',
        ]),
      ).toThrow(/--print-template cannot be combined with report-only options/);
      expect(() =>
        buildSubagentOperatorEvidenceReportFromCliOptions({
          filter: {},
          maxLedgerBytes: 10_000,
          pretty: false,
          printTemplate: true,
        }),
      ).toThrow(
        /Cannot build a subagent operator evidence report from --print-template options/,
      );
      expect(() =>
        buildSubagentOperatorEvidenceReportFromCliOptions({
          ledgerPath,
          filter: {},
          maxLedgerBytes: 1,
          pretty: false,
          printTemplate: false,
        }),
      ).toThrow('--ledger file exceeds --max-ledger-bytes');

      let stdout = '';
      let stderr = '';
      expect(
        runSubagentOperatorEvidenceReportCli(['--help'], {
          stdout: { write: (chunk) => { stdout += chunk; } },
          stderr: { write: (chunk) => { stderr += chunk; } },
        }),
      ).toBe(0);
      expect(stdout).toContain('Usage: pnpm subagent:operator:evidence:report');
      expect(stdout).toContain('--print-template');
      expect(stdout).toContain('non-promoting roster-event JSONL');
      expect(stdout).toContain('Template mode accepts only --generated-at');
      expect(stdout).toContain('--ledger, --event-kind');
      expect(stderr).toBe('');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('renders read-only /doctor diagnostics from the retained roster ledger', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-subagent-doctor-'));
    try {
      const ledgerPath = join(workspace, 'subagent-roster-events.jsonl');
      writeFileSync(
        ledgerPath,
        [
          rosterEventLine('subagent.spawned', 1),
          rosterEventLine('subagent.completed', 1),
          rosterEventLine('roster.progress', 1),
        ].join('\n'),
        'utf8',
      );

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH]: ledgerPath,
          [AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_MAX_LEDGER_BYTES]: '10000',
        }),
      );

      expect(text).toContain('[PASS] Subagent operator evidence report (retained)');
      expect(text).toContain('Ledger: subagent-roster-events.jsonl#');
      expect(text).toContain('Report status: complete');
      expect(text).toContain('Records: 3');
      expect(text).toContain('Spawned events: 1');
      expect(text).toContain('Completed/aborted/failed events: 1/0/0');
      expect(text).toContain('Raw subagent ids: not rendered');
      expect(text).toContain('Raw runtime instance ids: not rendered');
      expect(text).toContain('Raw artifacts: not rendered');
      expect(text).toContain('Live service contact: none');
      expect(text).toContain('Roster mutation: none');
      expect(text).toContain('Ledger mutation: none');
      expect(text).toContain('Operator actions: none');
      expect(text).toContain('Env reload: none');
      expect(text).not.toContain(workspace);
      expect(text).not.toContain('SECRET-subagent-task');
      expect(text).not.toContain('artifact://subagent');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
