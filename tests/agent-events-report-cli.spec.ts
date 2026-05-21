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
  AGENT_EVENTS_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES,
  buildAgentEventsReportFromCliOptions,
  createRuntimeSettingsBundle,
  parseAgentEventsReportCliArgs,
  runAgentEventsReportCli,
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

function terminalEvidenceJson(
  input: {
    readonly terminalCause?: 'success' | 'timeout' | 'provider-failure';
    readonly includeTranscript?: boolean;
    readonly includeApproval?: boolean;
    readonly approvalDeadline?: string;
  } = {},
): string {
  const taskId = 'SECRET-agent-events-task';
  const runtimeInstanceId = 'SECRET-agent-events-runtime';
  const cause = buildCause(input.terminalCause ?? 'success', {
    taskId,
    runtimeInstanceId,
  });
  const transcriptEvents: unknown[] = [
    {
      kind: 'turn.started',
      timestamp: '2026-05-18T08:00:01.000Z',
      instanceId: runtimeInstanceId,
      turnSequence: 1,
      provenance: {
        producer: 'codex-runtime-driver',
        sdkEventType: 'turn.started',
        threadId: null,
      },
    },
    {
      kind: 'item.completed',
      timestamp: '2026-05-18T08:00:02.000Z',
      instanceId: runtimeInstanceId,
      turnSequence: 1,
      item: {
        id: 'SECRET-item-id',
        type: 'agent_message',
        summary: 'SECRET transcript content must not render',
      },
      provenance: {
        producer: 'codex-runtime-driver',
        sdkEventType: 'item.completed',
        threadId: null,
      },
    },
    ...(input.includeApproval === true
      ? [
          {
            kind: 'approval.requested',
            timestamp: '2026-05-18T08:00:02.500Z',
            instanceId: runtimeInstanceId,
            turnSequence: 1,
            approvalRequestId: 'SECRET-approval-id',
            deadline: input.approvalDeadline ?? '2026-05-18T08:05:02.500Z',
            request: {
              kind: 'command_execution',
              reason: 'SECRET approval reason must not render',
              command: 'cat /tmp/SECRET-approval-command',
              workingDirectory: '/tmp/SECRET-approval-cwd',
            },
            provenance: {
              producer: 'codex-runtime-driver',
              sdkEventType: 'approval.requested',
              threadId: null,
            },
          },
        ]
      : []),
    {
      kind: 'turn.completed',
      timestamp: '2026-05-18T08:00:03.000Z',
      instanceId: runtimeInstanceId,
      turnSequence: 1,
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
      },
      provenance: {
        producer: 'codex-runtime-driver',
        sdkEventType: 'turn.completed',
        threadId: null,
      },
    },
  ];

  return JSON.stringify({
    taskId,
    runtimeInstanceId,
    reason: 'SECRET terminal reason must not render',
    provenance: 'codex-runtime-driver',
    executionContext: {
      planCreatedAt: '2026-05-18T08:00:00.000Z',
      runtimeSettings: createRuntimeSettingsBundle({
        networkProfile: 'provider-only',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
      }),
    },
    resourceEnvelope: {
      requested: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
      effective: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
    },
    ...(input.includeTranscript === false
      ? {}
      : {
          transcript: {
            events: transcriptEvents,
            droppedCount: 0,
          },
        }),
    startedAt: '2026-05-18T08:00:00.000Z',
    endedAt: '2026-05-18T08:00:04.000Z',
    cause,
  });
}

function buildCause(
  terminalCause: 'success' | 'timeout' | 'provider-failure',
  ids: { readonly taskId: string; readonly runtimeInstanceId: string },
): unknown {
  if (terminalCause === 'timeout') {
    return {
      kind: 'timeout',
      taskId: ids.taskId,
      runtimeInstanceId: ids.runtimeInstanceId,
      observedAt: '2026-05-18T08:00:04.000Z',
      provenance: 'codex-runtime-driver',
      deadlineMs: 60000,
      firedAt: '2026-05-18T08:00:04.000Z',
    };
  }
  if (terminalCause === 'provider-failure') {
    return {
      kind: 'provider-failure',
      taskId: ids.taskId,
      runtimeInstanceId: ids.runtimeInstanceId,
      observedAt: '2026-05-18T08:00:04.000Z',
      provenance: 'codex-runtime-driver',
      provider: 'codex',
      classification: 'transient-server',
      retryable: true,
      message: 'SECRET provider message must not render',
      retryAfterMs: 5000,
      attemptsExhausted: 1,
    };
  }
  return {
    kind: 'success',
    taskId: ids.taskId,
    runtimeInstanceId: ids.runtimeInstanceId,
    observedAt: '2026-05-18T08:00:04.000Z',
    provenance: 'codex-runtime-driver',
  };
}

describe('agent events report CLI', () => {
  it('projects retained TerminalEvidence into redacted session, agent, and event records', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agent-events-report-'));
    try {
      const evidencePath = join(workspace, 'terminal-evidence.json');
      writeFileSync(evidencePath, terminalEvidenceJson(), 'utf8');
      const originalEvidenceContent = readFileSync(evidencePath, 'utf8');
      const originalEvidenceStat = statSync(evidencePath);
      const originalWorkspaceEntries = readdirSync(workspace).sort();
      const io = makeIo();

      const exitCode = runAgentEventsReportCli(
        [
          '--evidence',
          evidencePath,
          '--generated-at',
          '2026-05-18T08:01:00.000Z',
          '--pretty',
        ],
        io,
      );

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe('');
      const report = JSON.parse(io.stdoutText()) as {
        readonly generatedAt: string;
        readonly status: string;
        readonly source: {
          readonly evidenceFileCount: number;
          readonly pathRendered: boolean;
        };
        readonly scorecard: {
          readonly sessionRecordCount: number;
          readonly agentRecordCount: number;
          readonly eventRecordCount: number;
          readonly terminalEventCount: number;
          readonly nonSuccessTerminalCauseCount: number;
          readonly duplicateEvidenceRecordCount: number;
          readonly restartRecipeCount: number;
          readonly capabilityEnvelopeCount: number;
          readonly providerReportedTokenUsageRecordCount: number;
          readonly costUsage: {
            readonly tokenUsage: {
              readonly provenance: string;
              readonly totalTokens?: number;
            };
            readonly cost: { readonly provenance: string };
            readonly rawBillingRendered: boolean;
          };
          readonly contextBudget: {
            readonly tokenUsage: {
              readonly provenance: string;
              readonly totalTokens?: number;
            };
            readonly contextFill: { readonly provenance: string };
            readonly rawTranscriptRendered: boolean;
          };
          readonly terminalCauseCounts: { readonly success?: number };
          readonly runtimeEventKindCounts: { readonly 'turn.completed'?: number };
        };
        readonly sessions: readonly {
          readonly rawRuntimeInstanceIdRendered: boolean;
        }[];
        readonly agents: readonly {
          readonly terminalCauseKind: string;
          readonly capabilityEnvelope: { readonly schemaVersion: number };
          readonly restartRecipe: {
            readonly retryability: string;
            readonly recommendedAction: string;
            readonly rawReasonRendered: boolean;
          };
          readonly costUsage: {
            readonly tokenUsage: {
              readonly provenance: string;
              readonly totalTokens?: number;
            };
            readonly cost: { readonly provenance: string };
          };
          readonly rawTaskIdRendered: boolean;
          readonly rawRuntimeInstanceIdRendered: boolean;
        }[];
        readonly events: readonly {
          readonly kind: string;
          readonly runtimeEventKind?: string;
          readonly restartRecipe?: { readonly retryability: string };
          readonly costUsage?: {
            readonly tokenUsage: {
              readonly provenance: string;
              readonly totalTokens?: number;
            };
          };
          readonly rawTranscriptRendered: boolean;
        }[];
        readonly boundary: {
          readonly readOnly: boolean;
          readonly runtimeDriverCalled: boolean;
          readonly publicApiStarted: boolean;
          readonly providerContacted: boolean;
          readonly evidenceFilesMutated: boolean;
          readonly environmentVariablesRead: boolean;
          readonly rawTaskIdsRendered: boolean;
          readonly rawRuntimeInstanceIdsRendered: boolean;
          readonly rawInstructionsRendered: boolean;
          readonly rawReasonsRendered: boolean;
          readonly rawTranscriptRendered: boolean;
          readonly rawBillingRendered: boolean;
        };
      };

      expect(report.generatedAt).toBe('2026-05-18T08:01:00.000Z');
      expect(report.status).toBe('complete');
      expect(report.source).toMatchObject({
        evidenceFileCount: 1,
        pathRendered: false,
      });
      expect(report.scorecard).toMatchObject({
        sessionRecordCount: 1,
        agentRecordCount: 1,
        eventRecordCount: 5,
        terminalEventCount: 1,
        nonSuccessTerminalCauseCount: 0,
        duplicateEvidenceRecordCount: 0,
        restartRecipeCount: 1,
        capabilityEnvelopeCount: 1,
        providerReportedTokenUsageRecordCount: 1,
        terminalCauseCounts: { success: 1 },
        runtimeEventKindCounts: { 'turn.completed': 1 },
      });
      expect(report.scorecard.costUsage).toMatchObject({
        tokenUsage: { provenance: 'provider-reported', totalTokens: 17 },
        cost: { provenance: 'unavailable' },
        rawBillingRendered: false,
      });
      expect(report.scorecard.contextBudget).toMatchObject({
        tokenUsage: { provenance: 'provider-reported', totalTokens: 17 },
        contextFill: { provenance: 'unavailable' },
        rawTranscriptRendered: false,
      });
      expect(report.sessions[0]?.rawRuntimeInstanceIdRendered).toBe(false);
      expect(report.agents[0]).toMatchObject({
        terminalCauseKind: 'success',
        capabilityEnvelope: { schemaVersion: 1 },
        restartRecipe: {
          retryability: 'not-needed',
          recommendedAction: 'none',
          rawReasonRendered: false,
        },
        costUsage: {
          tokenUsage: { provenance: 'provider-reported', totalTokens: 17 },
          cost: { provenance: 'unavailable' },
        },
        rawTaskIdRendered: false,
        rawRuntimeInstanceIdRendered: false,
      });
      expect(report.events.map((event) => event.kind)).toEqual([
        'task.started',
        'runtime.event',
        'runtime.event',
        'runtime.event',
        'task.terminal',
      ]);
      expect(
        report.events.find(
          (event) => event.runtimeEventKind === 'turn.completed',
        )?.costUsage,
      ).toMatchObject({
        tokenUsage: { provenance: 'provider-reported', totalTokens: 17 },
      });
      expect(report.events.at(-1)?.restartRecipe).toMatchObject({
        retryability: 'not-needed',
      });
      expect(report.events.every((event) => !event.rawTranscriptRendered)).toBe(
        true,
      );
      expect(report.boundary).toEqual({
        readOnly: true,
        runtimeDriverCalled: false,
        publicApiStarted: false,
        providerContacted: false,
        evidenceFilesMutated: false,
        environmentVariablesRead: false,
        rawTaskIdsRendered: false,
        rawRuntimeInstanceIdsRendered: false,
        rawInstructionsRendered: false,
        rawReasonsRendered: false,
        rawTranscriptRendered: false,
        rawBillingRendered: false,
      });
      expect(io.stdoutText()).not.toContain('SECRET-agent-events-task');
      expect(io.stdoutText()).not.toContain('SECRET-agent-events-runtime');
      expect(io.stdoutText()).not.toContain('SECRET terminal reason');
      expect(io.stdoutText()).not.toContain('SECRET transcript content');
      expect(io.stdoutText()).not.toContain('SECRET provider message');
      expect(readFileSync(evidencePath, 'utf8')).toBe(originalEvidenceContent);
      expect(statSync(evidencePath).size).toBe(originalEvidenceStat.size);
      expect(statSync(evidencePath).mtimeMs).toBe(originalEvidenceStat.mtimeMs);
      expect(readdirSync(workspace).sort()).toEqual(originalWorkspaceEntries);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('renders restart recipes for retryable provider failures without raw diagnostics', () => {
    const report = buildAgentEventsReportFromCliOptions({
      evidencePaths: [],
      maxEvidenceBytes: AGENT_EVENTS_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES,
      generatedAt: '2026-05-18T08:02:00.000Z',
      pretty: false,
    });
    expect(report.status).toBe('no-record');

    const workspace = mkdtempSync(join(tmpdir(), 'agent-events-report-'));
    try {
      const evidencePath = join(workspace, 'provider-failure.json');
      writeFileSync(
        evidencePath,
        terminalEvidenceJson({ terminalCause: 'provider-failure' }),
        'utf8',
      );

      const providerFailureReport = buildAgentEventsReportFromCliOptions({
        evidencePaths: [evidencePath],
        maxEvidenceBytes: AGENT_EVENTS_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES,
        generatedAt: '2026-05-18T08:03:00.000Z',
        pretty: false,
      });

      expect(providerFailureReport.status).toBe('warn');
      expect(providerFailureReport.scorecard.nonSuccessTerminalCauseCount).toBe(1);
      expect(providerFailureReport.agents[0]?.restartRecipe).toMatchObject({
        terminalCauseKind: 'provider-failure',
        retryability: 'retryable',
        recommendedAction: 'inspect-provider-failure',
        operatorActionRequired: false,
        providerFailureClassification: 'transient-server',
        providerFailureRetryable: true,
        retryAfterMs: 5000,
        attemptsExhausted: 1,
        rawProviderMessageRendered: false,
      });
      expect(JSON.stringify(providerFailureReport)).not.toContain(
        'SECRET provider message',
      );

      const duplicateReport = buildAgentEventsReportFromCliOptions({
        evidencePaths: [evidencePath, evidencePath],
        maxEvidenceBytes: AGENT_EVENTS_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES,
        generatedAt: '2026-05-18T08:03:30.000Z',
        pretty: false,
      });
      expect(duplicateReport.status).toBe('warn');
      expect(duplicateReport.scorecard.duplicateEvidenceRecordCount).toBe(1);
      expect(duplicateReport.scorecard.agentRecordCount).toBe(1);
      expect(duplicateReport.scorecard.costUsage.tokenUsage.totalTokens).toBe(17);
      expect(duplicateReport.scorecard.recommendations).toEqual(
        expect.arrayContaining([expect.stringContaining('Duplicate TerminalEvidence')]),
      );

    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('projects approval.requested events through HumanGateSnapshot without raw answers or approval text', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agent-events-report-'));
    try {
      const evidencePath = join(workspace, 'approval-terminal-evidence.json');
      writeFileSync(
        evidencePath,
        terminalEvidenceJson({ includeApproval: true }),
        'utf8',
      );

      const report = buildAgentEventsReportFromCliOptions({
        evidencePaths: [evidencePath],
        maxEvidenceBytes: AGENT_EVENTS_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES,
        generatedAt: '2026-05-18T08:04:30.000Z',
        pretty: false,
      });
      const approvalEvent = report.events.find(
        (event) => event.runtimeEventKind === 'approval.requested',
      );

      expect(report.scorecard.humanGateCount).toBe(1);
      expect(report.scorecard.answerProvenanceRequiredCount).toBe(1);
      expect(approvalEvent).toMatchObject({
        kind: 'runtime.event',
        runtimeEventKind: 'approval.requested',
        approvalRequestKind: 'command_execution',
        answerProvenanceRequired: true,
        rawApprovalRequestIdRendered: false,
        rawApprovalReasonRendered: false,
        rawTranscriptRendered: false,
        humanGate: {
          schemaVersion: 1,
          rawGateIdRendered: false,
          timeoutSec: 300,
          onTimeout: 'fail-closed',
          providerContactRequired: false,
          question: {
            rawRendered: false,
          },
          answerProvenance: {
            required: true,
            rawAnswerRendered: false,
          },
          summary: {
            required: true,
            rawSummaryRendered: false,
          },
        },
      });
      const repeatedReport = buildAgentEventsReportFromCliOptions({
        evidencePaths: [evidencePath],
        maxEvidenceBytes: AGENT_EVENTS_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES,
        generatedAt: '2026-05-18T08:04:31.000Z',
        pretty: false,
      });
      const repeatedApprovalEvent = repeatedReport.events.find(
        (event) => event.runtimeEventKind === 'approval.requested',
      );
      expect(repeatedApprovalEvent?.humanGate?.gateIdHash).toBe(
        approvalEvent?.humanGate?.gateIdHash,
      );
      expect(repeatedApprovalEvent?.humanGate?.question.sha256).toBe(
        approvalEvent?.humanGate?.question.sha256,
      );

      const pastDeadlinePath = join(workspace, 'approval-past-deadline.json');
      writeFileSync(
        pastDeadlinePath,
        terminalEvidenceJson({
          includeApproval: true,
          approvalDeadline: '2026-05-18T08:00:01.000Z',
        }),
        'utf8',
      );
      const pastDeadlineReport = buildAgentEventsReportFromCliOptions({
        evidencePaths: [pastDeadlinePath],
        maxEvidenceBytes: AGENT_EVENTS_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES,
        generatedAt: '2026-05-18T08:04:32.000Z',
        pretty: false,
      });
      expect(
        pastDeadlineReport.events.find(
          (event) => event.runtimeEventKind === 'approval.requested',
        )?.humanGate?.timeoutSec,
      ).toBe(1);
      expect(JSON.stringify(report)).not.toContain('SECRET-approval-id');
      expect(JSON.stringify(report)).not.toContain('SECRET approval reason');
      expect(JSON.stringify(report)).not.toContain('SECRET-approval-command');
      expect(JSON.stringify(report)).not.toContain('SECRET-approval-cwd');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('parses args, estimates context pressure from operator metadata, and fails closed on oversized evidence', () => {
    expect(
      parseAgentEventsReportCliArgs([
        '--evidence',
        'terminal.json',
        '--max-evidence-bytes',
        '1000',
        '--estimated-context-window-tokens',
        '20',
        '--generated-at',
        '2026-05-18T08:04:00.000Z',
        '--pretty',
      ]),
    ).toEqual({
      evidencePaths: ['terminal.json'],
      maxEvidenceBytes: 1000,
      estimatedContextWindowTokens: 20,
      generatedAt: '2026-05-18T08:04:00.000Z',
      pretty: true,
    });

    const helpIo = makeIo();
    expect(runAgentEventsReportCli(['--help'], helpIo)).toBe(0);
    expect(helpIo.stdoutText()).toContain('agent:events:report');
    expect(helpIo.stdoutText()).toContain('SessionRecord/AgentRecord/EventRecord');
    expect(helpIo.stderrText()).toBe('');

    const workspace = mkdtempSync(join(tmpdir(), 'agent-events-report-'));
    try {
      const evidencePath = join(workspace, 'terminal-evidence.json');
      writeFileSync(evidencePath, terminalEvidenceJson(), 'utf8');
      const estimateIo = makeIo();
      expect(
        runAgentEventsReportCli(
          [
            '--evidence',
            evidencePath,
            '--estimated-context-window-tokens',
            '20',
          ],
          estimateIo,
        ),
      ).toBe(0);
      const estimateReport = JSON.parse(estimateIo.stdoutText()) as {
        readonly scorecard: {
          readonly contextBudget: {
            readonly contextFill: {
              readonly provenance: string;
              readonly pressure: string;
              readonly fillRatio?: number;
            };
          };
        };
      };
      expect(estimateReport.scorecard.contextBudget.contextFill).toMatchObject({
        provenance: 'estimated',
        pressure: 'high',
        fillRatio: 0.85,
      });

      const oversizedIo = makeIo();
      expect(
        runAgentEventsReportCli(
          ['--evidence', evidencePath, '--max-evidence-bytes', '1'],
          oversizedIo,
        ),
      ).toBe(1);
      expect(oversizedIo.stdoutText()).toBe('');
      expect(oversizedIo.stderrText()).toContain(
        'exceeds --max-evidence-bytes',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }

    expect(() => parseAgentEventsReportCliArgs([])).toThrow(/--evidence/);
    expect(() =>
      parseAgentEventsReportCliArgs([
        '--evidence',
        'terminal.json',
        '--generated-at',
        'bad',
      ]),
    ).toThrow(/valid ISO-8601 UTC/);
  });
});
