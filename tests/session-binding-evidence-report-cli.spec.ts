import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AUTO_ARCHIVE_SESSION_BINDING_EVIDENCE_LEDGER_PATH,
  AUTO_ARCHIVE_SESSION_BINDING_EVIDENCE_MAX_LEDGER_BYTES,
  DiscordSessionBindingManager,
  InMemoryControlPlaneLedger,
  SESSION_BINDING_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES,
  buildDoctorReportFromEnv,
  buildSessionBindingEvidenceReportFromCliOptions,
  createDiscordSessionBindingAudit,
  parseSessionBindingEvidenceReportCliArgs,
  renderDoctor,
  renderDoctorReport,
  resolveSessionBindingEvidenceReportDoctorStatusFromEnv,
  runSessionBindingEvidenceReportCli,
  type SessionBindingEvidenceTemplateRecord,
} from '../src/index.js';

function makeRetainedLedgerLines(): readonly string[] {
  const ledger = new InMemoryControlPlaneLedger();
  const manager = new DiscordSessionBindingManager({
    ledger,
    idFactory: () => 'SECRET-binding-id',
    idleTimeoutMs: 30 * 60 * 1000,
    maxAgeMs: 6 * 60 * 60 * 1000,
  });
  const binding = manager.focus({
    guildId: 'SECRET-guild-id',
    channelId: 'SECRET-channel-id',
    threadId: 'SECRET-thread-id',
    taskId: 'SECRET-task-id',
    subagentId: 'SECRET-subagent-id',
    ownerUserId: 'SECRET-owner-id',
    now: new Date('2026-05-05T09:00:00.000Z'),
  });
  ledger.append({
    type: 'steering.submitted',
    actor: { kind: 'discord-user', userId: 'SECRET-owner-id' },
    channel: {
      kind: 'discord',
      guildId: 'SECRET-guild-id',
      channelId: 'SECRET-channel-id',
    },
    conversationId: 'SECRET-thread-id',
    taskId: binding.taskId,
    correlationId: binding.bindingId,
    trust: { source: 'discord', inputTrust: 'untrusted' },
    payload: {
      bindingAudit: createDiscordSessionBindingAudit(
        'steering.submitted',
        binding,
        '2026-05-05T09:01:00.000Z',
      ),
    },
  });
  manager.release({
    guildId: 'SECRET-guild-id',
    channelId: 'SECRET-channel-id',
    threadId: 'SECRET-thread-id',
    ownerUserId: 'SECRET-owner-id',
    now: new Date('2026-05-05T09:02:00.000Z'),
  });
  return ledger.loadAll().map((event) => JSON.stringify(event));
}

function writeLedger(lines: readonly string[]): { readonly workspace: string; readonly ledgerPath: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-session-binding-'));
  const ledgerPath = join(workspace, 'control-plane.jsonl');
  writeFileSync(ledgerPath, lines.join('\n'), 'utf8');
  return { workspace, ledgerPath };
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

describe('session binding evidence report CLI model', () => {
  it('scores retained focus/steering/release JSONL without rendering raw binding task owner channel or subagent ids', () => {
    const { workspace, ledgerPath } = writeLedger([
      ...makeRetainedLedgerLines(),
      JSON.stringify({
        schemaVersion: 1,
        eventId: 'other-event',
        timestamp: '2026-05-05T09:03:00.000Z',
        type: 'task.requested',
        actor: { kind: 'discord-user', userId: 'SECRET-unrelated-user' },
        trust: { source: 'discord', inputTrust: 'untrusted' },
        payload: { instruction: 'SECRET unrelated instruction ignored' },
      }),
    ]);
    try {
      const report = buildSessionBindingEvidenceReportFromCliOptions({
        ledgerPath,
        filter: {},
        maxLedgerBytes: 20_000,
        generatedAt: '2026-05-05T09:10:00.000Z',
        pretty: false,
        printTemplate: false,
      });
      const rendered = JSON.stringify(report);

      expect(report.schemaVersion).toBe(1);
      expect(report.generatedAt).toBe('2026-05-05T09:10:00.000Z');
      expect(report.method.scoringRubricVersion).toBe(
        '2026-05-05.session-binding-evidence-v1',
      );
      expect(report.status).toBe('complete');
      expect(report.scorecard.recordCount).toBe(3);
      expect(report.scorecard.bindingCreatedCount).toBe(1);
      expect(report.scorecard.steeringSubmittedCount).toBe(1);
      expect(report.scorecard.bindingReleasedCount).toBe(1);
      expect(report.scorecard.terminalTransitionCount).toBe(1);
      expect(report.scorecard.currentActiveBindingCount).toBe(0);
      expect(report.scorecard.qualityScore.value).toBe(100);
      expect(report.replayAudit.skippedNonSessionBindingLineCount).toBe(1);
      expect(report.boundary).toMatchObject({
        readOnly: true,
        liveServicesContacted: false,
        focusMutated: false,
        ledgerMutated: false,
        rawBindingIdsRendered: false,
        rawTaskIdsRendered: false,
        rawOwnerUserIdsRendered: false,
        rawChannelIdsRendered: false,
        rawThreadIdsRendered: false,
        rawSubagentIdsRendered: false,
        rawInstructionsRendered: false,
        rawPayloadRendered: false,
      });
      expect(rendered).not.toContain('SECRET-binding-id');
      expect(rendered).not.toContain('SECRET-task-id');
      expect(rendered).not.toContain('SECRET-owner-id');
      expect(rendered).not.toContain('SECRET-channel-id');
      expect(rendered).not.toContain('SECRET-thread-id');
      expect(rendered).not.toContain('SECRET-subagent-id');
      expect(rendered).not.toContain('SECRET unrelated instruction');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('prints a compact non-promoting session.binding_created control-plane JSONL template', () => {
    const io = makeIo();

    const exitCode = runSessionBindingEvidenceReportCli(
      [
        '--print-template',
        '--generated-at',
        '2026-05-05T09:10:00.000Z',
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    const [line, trailing] = io.stdoutText().split('\n');
    expect(trailing).toBe('');
    expect(line).toBe(JSON.stringify(JSON.parse(line ?? '{}')));
    const record = JSON.parse(io.stdoutText()) as SessionBindingEvidenceTemplateRecord;
    const expectedRecord = {
      schemaVersion: 1,
      eventId: 'session-binding-evidence-template',
      timestamp: '2026-05-05T09:10:00.000Z',
      type: 'session.binding_created',
      actor: { kind: 'system' },
      trust: { source: 'system', inputTrust: 'trusted' },
      payload: {
        bindingAudit: {
          schemaVersion: 1,
          action: 'binding-created',
          legacyEventType: 'session.binding_created',
          status: 'active',
          occurredAt: '2026-05-05T09:10:00.000Z',
          retained: true,
          bindingIdPresent: true,
          bindingHash: 'sha256:0000000000000001',
          taskIdPresent: true,
          taskHash: 'sha256:0000000000000002',
          ownerUserIdPresent: true,
          ownerHash: 'sha256:0000000000000003',
          guildIdPresent: true,
          guildHash: 'sha256:0000000000000004',
          channelIdPresent: true,
          channelHash: 'sha256:0000000000000005',
          threadIdPresent: true,
          threadHash: 'sha256:0000000000000006',
          subagentIdPresent: true,
          subagentHash: 'sha256:0000000000000007',
          expiresAtPresent: false,
          lastUsedAtPresent: false,
        },
      },
    } as const satisfies SessionBindingEvidenceTemplateRecord;
    expect(record).toEqual(expectedRecord);
    expect(io.stdoutText()).toBe(`${JSON.stringify(expectedRecord)}\n`);
    expect(io.stdoutText()).not.toContain('SECRET');
    expect(io.stdoutText()).not.toContain('raw prompt');

    const secondIo = makeIo();
    expect(
      runSessionBindingEvidenceReportCli(
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

    const { workspace, ledgerPath } = writeLedger([io.stdoutText().trimEnd()]);
    try {
      const reportIo = makeIo();
      const reportExitCode = runSessionBindingEvidenceReportCli(
        [
          '--ledger',
          ledgerPath,
          '--generated-at',
          '2026-05-05T09:11:00.000Z',
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
          readonly bindingCreatedCount: number;
          readonly steeringSubmittedCount: number;
          readonly terminalTransitionCount: number;
          readonly bindingScopedRecordCount: number;
          readonly taskScopedRecordCount: number;
          readonly ownerAttributedRecordCount: number;
          readonly channelScopedRecordCount: number;
          readonly threadScopedRecordCount: number;
          readonly subagentScopedRecordCount: number;
          readonly currentActiveBindingCount: number;
          readonly lastObservedAt?: string;
          readonly qualityScore: { readonly value: number };
          readonly recommendations: readonly string[];
        };
      };
      expect(report.status).toBe('warn');
      expect(report.replayAudit.parsedRecordCount).toBe(1);
      expect(report.scorecard.recordCount).toBe(1);
      expect(report.scorecard.bindingCreatedCount).toBe(1);
      expect(report.scorecard.steeringSubmittedCount).toBe(0);
      expect(report.scorecard.terminalTransitionCount).toBe(0);
      expect(report.scorecard.bindingScopedRecordCount).toBe(1);
      expect(report.scorecard.taskScopedRecordCount).toBe(1);
      expect(report.scorecard.ownerAttributedRecordCount).toBe(1);
      expect(report.scorecard.channelScopedRecordCount).toBe(1);
      expect(report.scorecard.threadScopedRecordCount).toBe(1);
      expect(report.scorecard.subagentScopedRecordCount).toBe(1);
      expect(report.scorecard.currentActiveBindingCount).toBe(1);
      expect(report.scorecard.lastObservedAt).toBe('2026-05-05T09:10:00.000Z');
      expect(report.scorecard.qualityScore.value).toBeLessThan(100);
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'steering.submitted',
      );
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'terminal transition',
      );
      expect(reportIo.stdoutText()).not.toContain('session-binding-evidence-template');
      expect(reportIo.stdoutText()).not.toContain('sha256:0000000000000001');
      expect(reportIo.stdoutText()).not.toContain('sha256:0000000000000007');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('domain-separates retained audit hashes so equal raw ids do not correlate across fields', () => {
    const record = {
      bindingId: 'SECRET-shared-id',
      guildId: 'SECRET-shared-id',
      channelId: 'SECRET-shared-id',
      threadId: 'SECRET-shared-id',
      taskId: 'SECRET-shared-id',
      subagentId: 'SECRET-shared-id',
      ownerUserId: 'SECRET-shared-id',
      createdAt: '2026-05-05T09:00:00.000Z',
      lastUsedAt: '2026-05-05T09:01:00.000Z',
      expiresAt: '2026-05-05T10:00:00.000Z',
      status: 'active' as const,
    };
    const audit = createDiscordSessionBindingAudit(
      'session.binding_created',
      record,
      '2026-05-05T09:00:00.000Z',
    );
    const repeatedAudit = createDiscordSessionBindingAudit(
      'session.binding_created',
      record,
      '2026-05-05T09:00:00.000Z',
    );
    const hashes = [
      audit.bindingHash,
      audit.taskHash,
      audit.ownerHash,
      audit.guildHash,
      audit.channelHash,
      audit.threadHash,
      audit.subagentHash,
    ];

    for (const hash of hashes) {
      expect(hash).toMatch(/^sha256:[0-9a-f]{16}$/u);
    }
    expect(repeatedAudit.bindingHash).toBe(audit.bindingHash);
    expect(new Set(hashes)).toHaveLength(7);
    expect(JSON.stringify(audit)).not.toContain('SECRET-shared-id');
  });

  it('fails closed on legacy raw binding payloads and raw steering binding ids', () => {
    const { workspace, ledgerPath } = writeLedger([
      JSON.stringify({
        schemaVersion: 1,
        eventId: 'legacy-binding',
        timestamp: '2026-05-05T09:00:00.000Z',
        type: 'session.binding_created',
        actor: { kind: 'discord-user', userId: 'SECRET-owner-id' },
        channel: { kind: 'discord', channelId: 'SECRET-channel-id' },
        taskId: 'SECRET-task-id',
        correlationId: 'SECRET-binding-id',
        trust: { source: 'discord', inputTrust: 'trusted' },
        payload: {
          binding: {
            bindingId: 'SECRET-binding-id',
            taskId: 'SECRET-task-id',
            ownerUserId: 'SECRET-owner-id',
          },
        },
      }),
      JSON.stringify({
        schemaVersion: 1,
        eventId: 'legacy-steering',
        timestamp: '2026-05-05T09:01:00.000Z',
        type: 'steering.submitted',
        actor: { kind: 'discord-user', userId: 'SECRET-owner-id' },
        trust: { source: 'discord', inputTrust: 'untrusted' },
        payload: { bindingId: 'SECRET-binding-id' },
      }),
      '{"schemaVersion":1,"eventId":"broken"',
    ]);
    try {
      const report = buildSessionBindingEvidenceReportFromCliOptions({
        ledgerPath,
        filter: {},
        maxLedgerBytes: 20_000,
        pretty: false,
        printTemplate: false,
      });
      const rendered = JSON.stringify(report);

      expect(report.status).toBe('fail');
      expect(report.replayAudit.unsafePayloadLineCount).toBe(2);
      expect(report.replayAudit.skippedMalformedLineCount).toBe(1);
      expect(report.scorecard.recordCount).toBe(0);
      expect(rendered).not.toContain('SECRET-binding-id');
      expect(rendered).not.toContain('SECRET-task-id');
      expect(rendered).not.toContain('SECRET-owner-id');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('annotates event-type and limit filters because transition counts are filter-scoped', () => {
    const { workspace, ledgerPath } = writeLedger(makeRetainedLedgerLines());
    try {
      const report = buildSessionBindingEvidenceReportFromCliOptions({
        ledgerPath,
        filter: { eventType: 'steering.submitted', limit: 1 },
        maxLedgerBytes: 20_000,
        pretty: false,
        printTemplate: false,
      });

      expect(report.status).toBe('warn');
      expect(report.filter).toEqual({ eventType: 'steering.submitted', limit: 1 });
      expect(report.scorecard.recordCount).toBe(1);
      expect(report.scorecard.bindingCreatedCount).toBe(0);
      expect(report.scorecard.steeringSubmittedCount).toBe(1);
      expect(report.scorecard.steeringWithoutActiveBindingCount).toBe(1);
      expect(report.scorecard.filterApplied).toBe(true);
      expect(report.scorecard.transitionCountsFiltered).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('validates CLI arguments and bounded ledger byte guards', () => {
    const { workspace, ledgerPath } = writeLedger(makeRetainedLedgerLines());
    try {
      expect(parseSessionBindingEvidenceReportCliArgs(['--help'])).toBe('help');
      expect(() => parseSessionBindingEvidenceReportCliArgs([])).toThrow('--ledger is required');
      expect(parseSessionBindingEvidenceReportCliArgs(['--print-template'])).toEqual({
        filter: {},
        maxLedgerBytes: 10 * 1024 * 1024,
        pretty: false,
        printTemplate: true,
      });
      expect(
        parseSessionBindingEvidenceReportCliArgs([
          '--ledger',
          ledgerPath,
          '--generated-at',
          '2026-05-05T09:10:00.000Z',
        ]),
      ).toMatchObject({
        ledgerPath,
        generatedAt: '2026-05-05T09:10:00.000Z',
        printTemplate: false,
      });
      const defaultTemplateIo = makeIo();
      expect(runSessionBindingEvidenceReportCli(['--print-template'], defaultTemplateIo)).toBe(0);
      expect(defaultTemplateIo.stderrText()).toBe('');
      const defaultTemplate = JSON.parse(defaultTemplateIo.stdoutText()) as {
        readonly eventId: string;
        readonly timestamp: string;
      };
      expect(defaultTemplate.eventId).toBe('session-binding-evidence-template');
      expect(defaultTemplate.eventId).not.toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      );
      expect(defaultTemplate.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
      );
      expect(() =>
        parseSessionBindingEvidenceReportCliArgs([
          '--print-template',
          '--generated-at',
          'not-a-date',
        ]),
      ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp');
      expect(() =>
        parseSessionBindingEvidenceReportCliArgs([
          '--print-template',
          '--generated-at',
          '2026-05-05T09:10:00.000+09:00',
        ]),
      ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp');
      expect(() =>
        parseSessionBindingEvidenceReportCliArgs([
          '--print-template',
          '--ledger',
          ledgerPath,
        ]),
      ).toThrow('--print-template cannot be combined with --ledger');
      expect(() =>
        parseSessionBindingEvidenceReportCliArgs(['--print-template', '--pretty']),
      ).toThrow(/--print-template cannot be combined with report-only options/);
      expect(() =>
        parseSessionBindingEvidenceReportCliArgs([
          '--print-template',
          '--event-type',
          'session.binding_created',
        ]),
      ).toThrow(/--print-template cannot be combined with report-only options/);
      expect(() =>
        parseSessionBindingEvidenceReportCliArgs(['--print-template', '--limit', '1']),
      ).toThrow(/--print-template cannot be combined with report-only options/);
      expect(() =>
        parseSessionBindingEvidenceReportCliArgs([
          '--print-template',
          '--max-ledger-bytes',
          '100',
        ]),
      ).toThrow(/--print-template cannot be combined with report-only options/);
      expect(() =>
        buildSessionBindingEvidenceReportFromCliOptions({
          filter: {},
          maxLedgerBytes: 20_000,
          pretty: false,
          printTemplate: true,
        }),
      ).toThrow(
        /Cannot build a session binding evidence report from --print-template options/,
      );
      expect(() =>
        parseSessionBindingEvidenceReportCliArgs([
          '--ledger',
          ledgerPath,
          '--event-type',
          'task.archived',
        ]),
      ).toThrow('--event-type must be one of');
      expect(() =>
        parseSessionBindingEvidenceReportCliArgs(['--ledger', ledgerPath, '--limit', '-1']),
      ).toThrow('--limit must be a non-negative integer');
      expect(() =>
        parseSessionBindingEvidenceReportCliArgs([
          '--ledger',
          ledgerPath,
          '--generated-at',
          '2026-05-05',
        ]),
      ).toThrow('--generated-at must be a valid ISO-8601 UTC timestamp');
      expect(() =>
        buildSessionBindingEvidenceReportFromCliOptions({
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
        runSessionBindingEvidenceReportCli(['--help'], {
          stdout: { write: (chunk) => { stdout += chunk; } },
          stderr: { write: (chunk) => { stderr += chunk; } },
        }),
      ).toBe(0);
      expect(stdout).toContain('Usage: pnpm session:binding:evidence:report');
      expect(stdout).toContain('--print-template');
      expect(stdout).toContain('non-promoting session.binding_created');
      expect(stdout).toContain('Template mode accepts only --generated-at');
      expect(stdout).toContain('--ledger, --event-type');
      expect(stderr).toBe('');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('renders read-only /doctor and Discord doctor diagnostics from retained focus/session binding evidence', () => {
    const { workspace, ledgerPath } = writeLedger(makeRetainedLedgerLines());
    try {
      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_SESSION_BINDING_EVIDENCE_LEDGER_PATH]: ledgerPath,
          [AUTO_ARCHIVE_SESSION_BINDING_EVIDENCE_MAX_LEDGER_BYTES]: '20000',
        }),
      );

      expect(text).toContain('[PASS] Session binding evidence report (retained)');
      expect(text).toContain('Ledger: control-plane.jsonl#');
      expect(text).toContain('Report status: complete');
      expect(text).toContain('Created/released/focus-changed: 1/1/0');
      expect(text).toContain('Steering submitted: 1');
      expect(text).toContain('Raw binding ids: not rendered');
      expect(text).toContain('Raw task ids: not rendered');
      expect(text).toContain('Raw owner/user ids: not rendered');
      expect(text).toContain('Raw guild/channel/thread ids: not rendered');
      expect(text).toContain('Raw instructions: not rendered');
      expect(text).toContain('Focus mutation: none');
      expect(text).toContain('Ledger mutation: none');
      expect(text).toContain('Operator actions: none');
      expect(text).toContain('Env reload: none');
      expect(text).not.toContain(workspace);
      expect(text).not.toContain('SECRET-binding-id');

      const defaultStatus = resolveSessionBindingEvidenceReportDoctorStatusFromEnv({
        [AUTO_ARCHIVE_SESSION_BINDING_EVIDENCE_LEDGER_PATH]: ledgerPath,
      });
      expect(defaultStatus?.maxLedgerBytes).toBe(
        SESSION_BINDING_EVIDENCE_DOCTOR_DEFAULT_MAX_LEDGER_BYTES,
      );

      const payload = renderDoctor({
        ledgerEnabled: true,
        accessPolicyEnabled: true,
        authDatabaseEnabled: true,
        runtimeProviderScope: 'multi-provider',
        activeRuntimeProvider: 'codex',
        approvalRegistryEnabled: true,
        sessionBindingEvidenceReport: {
          ledgerPath: '/tmp/session-binding/control-plane.jsonl',
          maxLedgerBytes: 20_000,
          reportStatus: 'complete',
          recordCount: 3,
          bindingCreatedCount: 1,
          bindingReleasedCount: 1,
          focusChangedCount: 0,
          bindingExpiredCount: 0,
          bindingEvictedCount: 0,
          steeringSubmittedCount: 1,
          terminalTransitionCount: 1,
          bindingScopedRecordCount: 3,
          taskScopedRecordCount: 3,
          ownerAttributedRecordCount: 3,
          channelScopedRecordCount: 3,
          threadScopedRecordCount: 3,
          subagentScopedRecordCount: 3,
          currentActiveBindingCount: 0,
          duplicateCreateCount: 0,
          terminalWithoutCreateCount: 0,
          steeringWithoutActiveBindingCount: 0,
          malformedLineCount: 0,
          unsafePayloadLineCount: 0,
          nonSessionBindingLineCount: 0,
          qualityScore: 100,
          qualityScoreMax: 100,
        },
      });
      expect(payload.content).toContain('[PASS] Session binding evidence report');
      expect(payload.content).toContain('Raw binding ids: not rendered');
      expect(payload.content).not.toContain('/tmp/session-binding');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
