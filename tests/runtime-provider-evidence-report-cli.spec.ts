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
  RUNTIME_PROVIDER_EVIDENCE_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES,
  buildRuntimeProviderEvidenceReportFromCliOptions,
  createTerminalEvidence,
  createRuntimeSettingsBundle,
  parseRuntimeProviderEvidenceReportCliArgs,
  runRuntimeProviderEvidenceReportCli,
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
    readonly provider?: 'codex' | 'claude-agent';
    readonly terminalCause?: 'success' | 'provider-failure';
    readonly provenanceOverride?: string;
    readonly transcriptProvider?: 'codex' | 'claude-agent';
    readonly includeTranscript?: boolean;
  } = {},
): string {
  const provider = input.provider ?? 'codex';
  const driverProvenance =
    provider === 'codex'
      ? 'codex-runtime-driver'
      : 'claude-agent-runtime-driver';
  const effectiveProvenance = input.provenanceOverride ?? driverProvenance;
  const transcriptProvenance =
    input.transcriptProvider === undefined
      ? effectiveProvenance
      : input.transcriptProvider === 'codex'
        ? 'codex-runtime-driver'
        : 'claude-agent-runtime-driver';
  const taskId = 'SECRET-task-provider-evidence';
  const runtimeInstanceId = 'SECRET-runtime-provider-evidence';
  const providerFailure =
    input.terminalCause === 'provider-failure'
      ? {
          kind: 'provider-failure',
          taskId,
          runtimeInstanceId,
          observedAt: '2026-05-05T16:00:03.000Z',
          provenance: effectiveProvenance,
          provider: provider === 'codex' ? 'codex' : 'anthropic',
          classification: 'permanent-auth',
          retryable: false,
          message: 'SECRET provider diagnostic must not render',
        }
      : undefined;

  return JSON.stringify({
    taskId,
    runtimeInstanceId,
    reason: 'SECRET terminal reason must not render',
    provenance: effectiveProvenance,
    executionContext: {
      planCreatedAt: '2026-05-05T16:00:00.000Z',
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
            events: [
              {
                kind: 'turn.started',
                timestamp: '2026-05-05T16:00:01.000Z',
                instanceId: runtimeInstanceId,
                turnSequence: 1,
                provenance: {
                  producer: transcriptProvenance,
                  sdkEventType: 'turn.started',
                  threadId: null,
                },
              },
              {
                kind: 'item.completed',
                timestamp: '2026-05-05T16:00:02.000Z',
                instanceId: runtimeInstanceId,
                turnSequence: 1,
                item: {
                  id: 'item-1',
                  type: 'agent_message',
                  summary: 'SECRET transcript content must not render',
                },
                provenance: {
                  producer: transcriptProvenance,
                  sdkEventType: 'item.completed',
                  threadId: null,
                },
              },
              {
                kind: 'turn.completed',
                timestamp: '2026-05-05T16:00:03.000Z',
                instanceId: runtimeInstanceId,
                turnSequence: 1,
                usage: {
                  inputTokens: 10,
                  cachedInputTokens: 2,
                  outputTokens: 5,
                },
                provenance: {
                  producer: transcriptProvenance,
                  sdkEventType: 'turn.completed',
                  threadId: null,
                },
              },
            ],
            droppedCount: 0,
          },
        }),
    startedAt: '2026-05-05T16:00:00.000Z',
    endedAt: '2026-05-05T16:00:04.000Z',
    cause:
      providerFailure ??
      {
        kind: 'success',
        taskId,
        runtimeInstanceId,
        observedAt: '2026-05-05T16:00:04.000Z',
        provenance: effectiveProvenance,
      },
  });
}

describe('Runtime provider evidence report CLI', () => {
  it('builds a read-only Codex provider report without rendering raw task content', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'runtime-provider-report-'));
    try {
      const evidencePath = join(workspace, 'terminal-evidence.json');
      writeFileSync(evidencePath, terminalEvidenceJson(), 'utf8');
      const originalEvidenceContent = readFileSync(evidencePath, 'utf8');
      const originalEvidenceStat = statSync(evidencePath);
      const originalWorkspaceEntries = readdirSync(workspace).sort();
      const io = makeIo();

      const exitCode = runRuntimeProviderEvidenceReportCli(
        [
          '--',
          '--evidence',
          evidencePath,
          '--provider',
          'codex',
          '--generated-at',
          '2026-05-05T16:01:00.000Z',
          '--pretty',
        ],
        io,
      );

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe('');
      const report = JSON.parse(io.stdoutText()) as {
        readonly generatedAt: string;
        readonly status: string;
        readonly scorecard: {
          readonly evidenceRecordCount: number;
          readonly selectedProviderRecordCount: number;
          readonly successfulProviderRecordCount: number;
          readonly providerProvenanceMatchedCount: number;
          readonly transcriptEventCount: number;
          readonly usage: { readonly totalTokens: number };
          readonly contextBudget: {
            readonly tokenUsage: {
              readonly provenance: string;
              readonly totalTokens?: number;
            };
            readonly contextFill: {
              readonly provenance: string;
              readonly pressure: string;
            };
            readonly compaction: { readonly provenance: string };
            readonly rawTranscriptRendered: boolean;
          };
          readonly providerCounts: { readonly codex: number };
          readonly qualityScore: { readonly value: number; readonly max: number };
        };
        readonly evidence: readonly {
          readonly provider: string;
          readonly status: string;
          readonly driverProvenanceSignal: string;
          readonly terminalCauseKind: string;
          readonly contextBudget: {
            readonly tokenUsage: {
              readonly provenance: string;
              readonly totalTokens?: number;
            };
            readonly contextFill: {
              readonly provenance: string;
              readonly pressure: string;
            };
            readonly compaction: { readonly provenance: string };
            readonly rawTranscriptRendered: boolean;
          };
        }[];
        readonly boundary: {
          readonly readOnly: boolean;
          readonly runtimeDriverCalled: boolean;
          readonly providerContacted: boolean;
          readonly evidenceFilesMutated: boolean;
          readonly environmentVariablesRead: boolean;
          readonly rawTaskIdsRendered: boolean;
          readonly rawRuntimeInstanceIdsRendered: boolean;
          readonly rawReasonsRendered: boolean;
          readonly rawTranscriptRendered: boolean;
        };
      };
      expect(report.generatedAt).toBe('2026-05-05T16:01:00.000Z');
      expect(report.status).toBe('complete');
      expect(report.scorecard.evidenceRecordCount).toBe(1);
      expect(report.scorecard.selectedProviderRecordCount).toBe(1);
      expect(report.scorecard.successfulProviderRecordCount).toBe(1);
      expect(report.scorecard.providerProvenanceMatchedCount).toBe(1);
      expect(report.scorecard.transcriptEventCount).toBe(3);
      expect(report.scorecard.usage.totalTokens).toBe(17);
      expect(report.scorecard.contextBudget).toMatchObject({
        tokenUsage: { provenance: 'provider-reported', totalTokens: 17 },
        contextFill: { provenance: 'unavailable', pressure: 'unknown' },
        compaction: { provenance: 'unavailable' },
        rawTranscriptRendered: false,
      });
      expect(report.scorecard.providerCounts.codex).toBe(1);
      expect(report.scorecard.qualityScore).toMatchObject({
        value: 100,
        max: 100,
      });
      expect(report.evidence[0]).toMatchObject({
        provider: 'codex',
        status: 'complete',
        driverProvenanceSignal: 'matched',
        terminalCauseKind: 'success',
        contextBudget: {
          tokenUsage: { provenance: 'provider-reported', totalTokens: 17 },
          contextFill: { provenance: 'unavailable', pressure: 'unknown' },
          compaction: { provenance: 'unavailable' },
          rawTranscriptRendered: false,
        },
      });
      expect(report.boundary).toEqual({
        readOnly: true,
        runtimeDriverCalled: false,
        providerContacted: false,
        evidenceFilesMutated: false,
        environmentVariablesRead: false,
        rawTaskIdsRendered: false,
        rawRuntimeInstanceIdsRendered: false,
        rawReasonsRendered: false,
        rawTranscriptRendered: false,
      });
      expect(io.stdoutText()).not.toContain('SECRET-task-provider-evidence');
      expect(io.stdoutText()).not.toContain('SECRET-runtime-provider-evidence');
      expect(io.stdoutText()).not.toContain('SECRET terminal reason');
      expect(io.stdoutText()).not.toContain('SECRET transcript content');
      expect(readFileSync(evidencePath, 'utf8')).toBe(originalEvidenceContent);
      expect(statSync(evidencePath).size).toBe(originalEvidenceStat.size);
      expect(statSync(evidencePath).mtimeMs).toBe(originalEvidenceStat.mtimeMs);
      expect(readdirSync(workspace).sort()).toEqual(originalWorkspaceEntries);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('estimates context pressure only from operator-supplied context window metadata', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'runtime-provider-report-'));
    try {
      const evidencePath = join(workspace, 'terminal-evidence.json');
      writeFileSync(evidencePath, terminalEvidenceJson(), 'utf8');
      const io = makeIo();

      const exitCode = runRuntimeProviderEvidenceReportCli(
        [
          '--evidence',
          evidencePath,
          '--provider',
          'codex',
          '--estimated-context-window-tokens',
          '20',
        ],
        io,
      );

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe('');
      const report = JSON.parse(io.stdoutText()) as {
        readonly scorecard: {
          readonly contextBudget: {
            readonly tokenUsage: {
              readonly provenance: string;
              readonly totalTokens?: number;
            };
            readonly contextFill: {
              readonly provenance: string;
              readonly pressure: string;
              readonly usedTokens?: number;
              readonly estimatedContextWindowTokens?: number;
              readonly fillRatio?: number;
            };
          };
        };
        readonly evidence: readonly {
          readonly contextBudget: {
            readonly contextFill: {
              readonly provenance: string;
              readonly pressure: string;
              readonly usedTokens?: number;
              readonly estimatedContextWindowTokens?: number;
              readonly fillRatio?: number;
            };
          };
        }[];
      };

      expect(report.scorecard.contextBudget.tokenUsage).toMatchObject({
        provenance: 'provider-reported',
        totalTokens: 17,
      });
      expect(report.scorecard.contextBudget.contextFill).toMatchObject({
        provenance: 'estimated',
        pressure: 'high',
        usedTokens: 17,
        estimatedContextWindowTokens: 20,
        fillRatio: 0.85,
      });
      expect(report.evidence[0]?.contextBudget.contextFill).toMatchObject({
        provenance: 'estimated',
        pressure: 'high',
        usedTokens: 17,
        estimatedContextWindowTokens: 20,
        fillRatio: 0.85,
      });
      expect(io.stdoutText()).not.toContain('SECRET transcript content');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps context fill unavailable when usage metadata is absent', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'runtime-provider-report-'));
    try {
      const evidencePath = join(workspace, 'terminal-evidence-no-usage.json');
      writeFileSync(
        evidencePath,
        terminalEvidenceJson({ includeTranscript: false }),
        'utf8',
      );
      const io = makeIo();

      expect(
        runRuntimeProviderEvidenceReportCli(
          [
            '--evidence',
            evidencePath,
            '--provider',
            'codex',
            '--estimated-context-window-tokens',
            '20',
          ],
          io,
        ),
      ).toBe(0);

      const report = JSON.parse(io.stdoutText()) as {
        readonly scorecard: {
          readonly contextBudget: {
            readonly tokenUsage: { readonly provenance: string };
            readonly contextFill: {
              readonly provenance: string;
              readonly pressure: string;
            };
          };
        };
        readonly evidence: readonly {
          readonly contextBudget: {
            readonly tokenUsage: { readonly provenance: string };
            readonly contextFill: {
              readonly provenance: string;
              readonly pressure: string;
            };
          };
        }[];
      };
      expect(report.scorecard.contextBudget).toMatchObject({
        tokenUsage: { provenance: 'unavailable' },
        contextFill: { provenance: 'unavailable', pressure: 'unknown' },
      });
      expect(report.evidence[0]?.contextBudget).toMatchObject({
        tokenUsage: { provenance: 'unavailable' },
        contextFill: { provenance: 'unavailable', pressure: 'unknown' },
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('reports Claude Agent provider-failure evidence as diagnostic-only', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'runtime-provider-report-'));
    try {
      const evidencePath = join(workspace, 'claude-terminal-evidence.json');
      writeFileSync(
        evidencePath,
        terminalEvidenceJson({
          provider: 'claude-agent',
          terminalCause: 'provider-failure',
        }),
        'utf8',
      );
      const io = makeIo();

      expect(
        runRuntimeProviderEvidenceReportCli(
          ['--evidence', evidencePath, '--provider', 'claude-agent'],
          io,
        ),
      ).toBe(0);

      const report = JSON.parse(io.stdoutText()) as {
        readonly status: string;
        readonly scorecard: {
          readonly selectedProviderRecordCount: number;
          readonly successfulProviderRecordCount: number;
          readonly failedProviderRecordCount: number;
          readonly providerFailureClassifications: {
            readonly 'permanent-auth'?: number;
          };
          readonly recommendations: readonly string[];
        };
        readonly evidence: readonly {
          readonly provider: string;
          readonly terminalCauseKind: string;
          readonly providerFailureClassification?: string;
          readonly providerFailureRetryable?: boolean;
        }[];
      };
      expect(report.status).toBe('warn');
      expect(report.scorecard.selectedProviderRecordCount).toBe(1);
      expect(report.scorecard.successfulProviderRecordCount).toBe(0);
      expect(report.scorecard.failedProviderRecordCount).toBe(1);
      expect(
        report.scorecard.providerFailureClassifications['permanent-auth'],
      ).toBe(1);
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'terminal-success provider run',
      );
      expect(report.evidence[0]).toMatchObject({
        provider: 'claude-agent',
        terminalCauseKind: 'provider-failure',
        providerFailureClassification: 'permanent-auth',
        providerFailureRetryable: false,
      });
      expect(io.stdoutText()).not.toContain('SECRET provider diagnostic');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('prints a read-only non-promoting provider TerminalEvidence template', () => {
    const io = makeIo();

    const exitCode = runRuntimeProviderEvidenceReportCli(
      [
        '--print-template',
        '--provider',
        'claude-agent',
        '--generated-at',
        '2026-05-05T16:02:00.000Z',
        '--pretty',
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    const template = JSON.parse(io.stdoutText()) as Parameters<
      typeof createTerminalEvidence
    >[0];
    const evidence = createTerminalEvidence(template);
    expect(evidence.taskId).toBe(
      'task-runtime-provider-claude-agent-template',
    );
    expect(evidence.runtimeInstanceId).toBe(
      'runtime-provider-claude-agent-template',
    );
    expect(evidence.provenance).toBe('claude-agent-runtime-driver');
    expect(evidence.reason).toContain('template only');
    expect(evidence.executionContext.planCreatedAt).toBe(
      '2026-05-05T16:02:00.000Z',
    );
    expect(evidence.executionContext.executionStartedAt).toBe(
      '2026-05-05T16:02:00.000Z',
    );
    expect(evidence.executionContext.runtimeSettings.networkProfile).toBe(
      'provider-only',
    );
    expect(evidence.resourceEnvelope.requested.gpuCards).toBe(0);
    expect(evidence.transcript?.events).toHaveLength(0);
    expect(evidence.startedAt).toBe('2026-05-05T16:02:00.000Z');
    expect(evidence.endedAt).toBe('2026-05-05T16:02:00.000Z');
    expect(evidence.cause).toMatchObject({
      kind: 'driver-failure',
      phase: 'template',
      provenance: 'claude-agent-runtime-driver',
    });
    if (evidence.cause.kind !== 'driver-failure') {
      throw new Error('expected a non-promoting driver-failure template cause');
    }
    expect(evidence.cause.message).toContain('non-promoting');
    expect(io.stdoutText()).not.toContain('SECRET');
    expect(io.stdoutText()).not.toContain('raw prompt');

    const secondIo = makeIo();
    expect(
      runRuntimeProviderEvidenceReportCli(
        [
          '--print-template',
          '--provider',
          'claude-agent',
          '--generated-at',
          '2026-05-05T16:02:00.000Z',
          '--pretty',
        ],
        secondIo,
      ),
    ).toBe(0);
    expect(secondIo.stderrText()).toBe('');
    expect(secondIo.stdoutText()).toBe(io.stdoutText());

    const defaultIo = makeIo();
    expect(
      runRuntimeProviderEvidenceReportCli(
        [
          '--print-template',
          '--generated-at',
          '2026-05-05T16:02:00.000Z',
        ],
        defaultIo,
      ),
    ).toBe(0);
    expect(
      createTerminalEvidence(
        JSON.parse(defaultIo.stdoutText()) as Parameters<
          typeof createTerminalEvidence
        >[0],
      ).provenance,
    ).toBe('codex-runtime-driver');

    const workspace = mkdtempSync(join(tmpdir(), 'runtime-provider-template-'));
    try {
      const templatePath = join(workspace, 'provider-template.json');
      writeFileSync(templatePath, io.stdoutText(), 'utf8');
      const reportIo = makeIo();

      const reportExitCode = runRuntimeProviderEvidenceReportCli(
        [
          '--evidence',
          templatePath,
          '--provider',
          'claude-agent',
          '--generated-at',
          '2026-05-05T16:03:00.000Z',
        ],
        reportIo,
      );

      expect(reportExitCode).toBe(0);
      expect(reportIo.stderrText()).toBe('');
      const report = JSON.parse(reportIo.stdoutText()) as {
        readonly status: string;
        readonly scorecard: {
          readonly selectedProviderRecordCount: number;
          readonly successfulProviderRecordCount: number;
          readonly failedProviderRecordCount: number;
          readonly providerProvenanceMatchedCount: number;
          readonly confidence: {
            readonly sufficientForProviderProof: boolean;
          };
          readonly qualityScore: { readonly value: number };
          readonly recommendations: readonly string[];
        };
        readonly evidence: readonly {
          readonly provider: string;
          readonly status: string;
          readonly terminalCauseKind: string;
          readonly driverProvenanceSignal: string;
        }[];
      };
      expect(report.status).toBe('warn');
      expect(report.scorecard.selectedProviderRecordCount).toBe(1);
      expect(report.scorecard.successfulProviderRecordCount).toBe(0);
      expect(report.scorecard.failedProviderRecordCount).toBe(1);
      expect(report.scorecard.providerProvenanceMatchedCount).toBe(1);
      expect(report.scorecard.confidence.sufficientForProviderProof).toBe(false);
      expect(report.scorecard.qualityScore.value).toBeLessThan(100);
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'terminal-success provider run',
      );
      expect(report.evidence[0]).toMatchObject({
        provider: 'claude-agent',
        status: 'non-success',
        terminalCauseKind: 'driver-failure',
        driverProvenanceSignal: 'matched',
      });
      expect(reportIo.stdoutText()).not.toContain(
        'task-runtime-provider-claude-agent-template',
      );
      expect(reportIo.stdoutText()).not.toContain(
        'runtime-provider-claude-agent-template',
      );
      expect(reportIo.stdoutText()).not.toContain('template only');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps provider filters explicit and marks mismatched evidence as no-record', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'runtime-provider-report-'));
    try {
      const evidencePath = join(workspace, 'codex-terminal-evidence.json');
      writeFileSync(evidencePath, terminalEvidenceJson(), 'utf8');
      const io = makeIo();

      expect(
        runRuntimeProviderEvidenceReportCli(
          ['--evidence', evidencePath, '--provider', 'claude-agent'],
          io,
        ),
      ).toBe(0);

      const report = JSON.parse(io.stdoutText()) as {
        readonly status: string;
        readonly scorecard: {
          readonly selectedProviderRecordCount: number;
          readonly providerCounts: { readonly codex: number };
        };
        readonly evidence: readonly { readonly status: string }[];
      };
      expect(report.status).toBe('no-record');
      expect(report.scorecard.selectedProviderRecordCount).toBe(0);
      expect(report.scorecard.providerCounts.codex).toBe(1);
      expect(report.evidence[0]?.status).toBe('provider-mismatch');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('defaults to both providers and preserves repeated provider filters as a union', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'runtime-provider-report-'));
    try {
      const codexPath = join(workspace, 'codex-terminal-evidence.json');
      const claudePath = join(workspace, 'claude-terminal-evidence.json');
      writeFileSync(codexPath, terminalEvidenceJson(), 'utf8');
      writeFileSync(
        claudePath,
        terminalEvidenceJson({ provider: 'claude-agent' }),
        'utf8',
      );
      const io = makeIo();

      expect(
        runRuntimeProviderEvidenceReportCli(
          ['--evidence', codexPath, '--evidence', claudePath],
          io,
        ),
      ).toBe(0);

      const report = JSON.parse(io.stdoutText()) as {
        readonly status: string;
        readonly filter: { readonly providers: readonly string[] };
        readonly scorecard: {
          readonly selectedProviderRecordCount: number;
          readonly providerCounts: {
            readonly codex: number;
            readonly 'claude-agent': number;
          };
        };
      };
      expect(report.status).toBe('complete');
      expect(report.filter.providers).toEqual(['codex', 'claude-agent']);
      expect(report.scorecard.selectedProviderRecordCount).toBe(2);
      expect(report.scorecard.providerCounts.codex).toBe(1);
      expect(report.scorecard.providerCounts['claude-agent']).toBe(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('does not silently attribute mixed provider provenance to either provider', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'runtime-provider-report-'));
    try {
      const evidencePath = join(workspace, 'mixed-terminal-evidence.json');
      writeFileSync(
        evidencePath,
        terminalEvidenceJson({ transcriptProvider: 'claude-agent' }),
        'utf8',
      );
      const io = makeIo();

      expect(
        runRuntimeProviderEvidenceReportCli(
          [
            '--evidence',
            evidencePath,
            '--provider',
            'codex',
            '--provider',
            'claude-agent',
          ],
          io,
        ),
      ).toBe(0);

      const report = JSON.parse(io.stdoutText()) as {
        readonly status: string;
        readonly scorecard: {
          readonly selectedProviderRecordCount: number;
          readonly providerCounts: { readonly mixed: number };
          readonly recommendations: readonly string[];
        };
        readonly evidence: readonly {
          readonly provider: string;
          readonly status: string;
          readonly driverProvenanceSignal: string;
        }[];
      };
      expect(report.status).toBe('no-record');
      expect(report.scorecard.selectedProviderRecordCount).toBe(0);
      expect(report.scorecard.providerCounts.mixed).toBe(1);
      expect(report.evidence[0]).toMatchObject({
        provider: 'mixed',
        status: 'provider-mismatch',
        driverProvenanceSignal: 'mixed',
      });
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'Separate mixed/unknown provider evidence',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails closed when provider-failure evidence lacks canonical driver provenance', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'runtime-provider-report-'));
    try {
      const evidencePath = join(workspace, 'codex-provider-failure.json');
      writeFileSync(
        evidencePath,
        terminalEvidenceJson({
          terminalCause: 'provider-failure',
          provenanceOverride: 'operator-retained-evidence',
          includeTranscript: false,
        }),
        'utf8',
      );
      const io = makeIo();

      expect(
        runRuntimeProviderEvidenceReportCli(
          ['--evidence', evidencePath, '--provider', 'codex'],
          io,
        ),
      ).toBe(0);

      const report = JSON.parse(io.stdoutText()) as {
        readonly status: string;
        readonly evidence: readonly {
          readonly status: string;
          readonly driverProvenanceSignal: string;
        }[];
        readonly scorecard: {
          readonly recommendations: readonly string[];
        };
      };
      expect(report.status).toBe('fail');
      expect(report.evidence[0]).toMatchObject({
        status: 'missing-provider-provenance',
        driverProvenanceSignal: 'missing',
      });
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'canonical driver provenance',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('validates CLI arguments and bounded byte guards', () => {
    expect(parseRuntimeProviderEvidenceReportCliArgs(['--help'])).toBe('help');
    expect(
      parseRuntimeProviderEvidenceReportCliArgs([
        '--evidence',
        'terminal-evidence.json',
        '--provider',
        'codex',
        '--provider',
        'claude-agent',
        '--provider',
        'codex',
      ]),
    ).toMatchObject({
      evidencePaths: ['terminal-evidence.json'],
      providers: ['codex', 'claude-agent'],
      maxEvidenceBytes:
        RUNTIME_PROVIDER_EVIDENCE_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES,
      printTemplate: false,
    });
    expect(
      parseRuntimeProviderEvidenceReportCliArgs([
        '--evidence',
        'terminal-evidence.json',
        '--estimated-context-window-tokens',
        '200000',
      ]),
    ).toMatchObject({
      evidencePaths: ['terminal-evidence.json'],
      estimatedContextWindowTokens: 200000,
      printTemplate: false,
    });
    expect(
      parseRuntimeProviderEvidenceReportCliArgs([
        '--print-template',
        '--provider',
        'codex',
      ]),
    ).toMatchObject({
      evidencePaths: [],
      providers: ['codex'],
      printTemplate: true,
    });
    expect(
      parseRuntimeProviderEvidenceReportCliArgs([
        '--print-template',
        '--provider',
        'codex',
        '--provider',
        'codex',
      ]),
    ).toMatchObject({
      evidencePaths: [],
      providers: ['codex'],
      printTemplate: true,
    });
    expect(() =>
      parseRuntimeProviderEvidenceReportCliArgs([
        '--evidence',
        'terminal-evidence.json',
        '--provider',
        'unknown',
      ]),
    ).toThrow(/--provider must be one of/);
    expect(() =>
      parseRuntimeProviderEvidenceReportCliArgs([
        '--evidence',
        'terminal-evidence.json',
        '--max-evidence-bytes',
        '0',
      ]),
    ).toThrow(/--max-evidence-bytes must be a positive safe integer/);
    expect(() =>
      parseRuntimeProviderEvidenceReportCliArgs([
        '--evidence',
        'terminal-evidence.json',
        '--estimated-context-window-tokens',
        '0',
      ]),
    ).toThrow(/--estimated-context-window-tokens must be a positive safe integer/);
    expect(() =>
      parseRuntimeProviderEvidenceReportCliArgs([
        '--print-template',
        '--generated-at',
        'not-a-date',
      ]),
    ).toThrow(/--generated-at must be a valid ISO-8601 UTC timestamp/);
    expect(() =>
      parseRuntimeProviderEvidenceReportCliArgs([
        '--print-template',
        '--unknown',
      ]),
    ).toThrow(/Unknown argument: --unknown/);
    expect(() =>
      parseRuntimeProviderEvidenceReportCliArgs([
        '--print-template',
        '--evidence',
        'terminal-evidence.json',
      ]),
    ).toThrow(/--print-template cannot be combined with --evidence/);
    expect(() =>
      parseRuntimeProviderEvidenceReportCliArgs([
        '--print-template',
        '--max-evidence-bytes',
        '100',
      ]),
    ).toThrow(/--print-template cannot be combined with --max-evidence-bytes/);
    expect(() =>
      parseRuntimeProviderEvidenceReportCliArgs([
        '--print-template',
        '--estimated-context-window-tokens',
        '100',
      ]),
    ).toThrow(
      /--print-template cannot be combined with --estimated-context-window-tokens/,
    );
    expect(() =>
      parseRuntimeProviderEvidenceReportCliArgs([
        '--print-template',
        '--provider',
        'codex',
        '--provider',
        'claude-agent',
      ]),
    ).toThrow(/--print-template accepts at most one --provider/);
    expect(() =>
      buildRuntimeProviderEvidenceReportFromCliOptions({
        evidencePaths: [],
        providers: [],
        maxEvidenceBytes:
          RUNTIME_PROVIDER_EVIDENCE_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES,
        pretty: false,
        printTemplate: true,
      }),
    ).toThrow(
      /Cannot build a runtime-provider evidence report from --print-template options/,
    );

    const helpIo = makeIo();
    expect(runRuntimeProviderEvidenceReportCli(['--help'], helpIo)).toBe(0);
    expect(helpIo.stdoutText()).toContain('--print-template');
    expect(helpIo.stdoutText()).toContain('--estimated-context-window-tokens');
    expect(helpIo.stdoutText()).toContain('non-promoting TerminalEvidence');
    expect(helpIo.stdoutText()).toContain('does not instantiate RuntimeDrivers');

    const workspace = mkdtempSync(join(tmpdir(), 'runtime-provider-report-'));
    try {
      const evidencePath = join(workspace, 'terminal-evidence.json');
      writeFileSync(evidencePath, terminalEvidenceJson(), 'utf8');
      const io = makeIo();

      expect(
        runRuntimeProviderEvidenceReportCli(
          ['--evidence', evidencePath, '--max-evidence-bytes', '1'],
          io,
        ),
      ).toBe(1);
      expect(io.stderrText()).toContain('exceeds --max-evidence-bytes');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
