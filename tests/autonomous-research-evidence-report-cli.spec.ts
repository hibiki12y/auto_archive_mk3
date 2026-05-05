import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES,
  buildAutonomousResearchEvidenceReportFromCliOptions,
  createAutonomousResearchEvidenceCheckpoint,
  createTerminalEvidence,
  createRuntimeSettingsBundle,
  formatAutonomousResearchEvidenceCheckpointDetail,
  parseAutonomousResearchEvidenceReportCliArgs,
  runAutonomousResearchEvidenceReportCli,
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

function checkpointDetail(
  checkpoint: Parameters<typeof createAutonomousResearchEvidenceCheckpoint>[0]['checkpoint'],
): string {
  return formatAutonomousResearchEvidenceCheckpointDetail(
    createAutonomousResearchEvidenceCheckpoint({
      taskId: 'task-autonomous-evidence-report',
      requested: true,
      selectedTraitId: 'autonomous-research-goal-loop',
      selectedProfileId: 'dgm-bounded-archive-runtime',
      runtimeDecorationIntent: 'bounded-archive-evidence',
      runtimeDecorationEnforcement: 'required',
      checkpoint,
      ...(checkpoint === 'runtime-decoration-complete'
        ? {
            completionStatus: 'delegate-returned',
            causeKind: 'success',
          }
        : {}),
      ...(checkpoint === 'runtime-decoration-error'
        ? {
            completionStatus: 'delegate-threw',
          }
        : {}),
    }),
  );
}

function terminalEvidenceJson(
  input: {
    readonly includeAutonomousCheckpoints?: boolean;
    readonly includeErrorCheckpoint?: boolean;
  } = {},
): string {
  const taskId = 'task-autonomous-evidence-report';
  const runtimeInstanceId = 'runtime-autonomous-evidence-report';
  const checkpointEvents =
    input.includeAutonomousCheckpoints === false
      ? []
      : [
          {
            kind: 'agent-step',
            timestamp: '2026-05-05T14:00:01.000Z',
            instanceId: runtimeInstanceId,
            step: 'autonomous-research.checkpoint',
            detail: checkpointDetail('runtime-decoration-start'),
          },
          {
            kind: 'agent-step',
            timestamp: '2026-05-05T14:00:02.000Z',
            instanceId: runtimeInstanceId,
            step: 'autonomous-research.checkpoint',
            detail: checkpointDetail(
              input.includeErrorCheckpoint === true
                ? 'runtime-decoration-error'
                : 'runtime-decoration-complete',
            ),
          },
        ];
  return JSON.stringify({
    taskId,
    runtimeInstanceId,
    reason: 'done',
    provenance: 'test',
    executionContext: {
      planCreatedAt: '2026-05-05T14:00:00.000Z',
      runtimeSettings: createRuntimeSettingsBundle({
        networkProfile: 'offline',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
      }),
    },
    resourceEnvelope: {
      requested: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
      effective: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
    },
    transcript: {
      events: checkpointEvents,
      droppedCount: 0,
    },
    startedAt: '2026-05-05T14:00:00.000Z',
    endedAt: '2026-05-05T14:00:03.000Z',
    cause: {
      kind: input.includeErrorCheckpoint === true ? 'driver-failure' : 'success',
      taskId,
      runtimeInstanceId,
      observedAt: '2026-05-05T14:00:03.000Z',
      provenance: 'test',
      ...(input.includeErrorCheckpoint === true
        ? {
            phase: 'delegate',
            message: 'delegate failed',
          }
        : {}),
    },
  });
}

describe('Autonomous research evidence report CLI', () => {
  it('builds a read-only report from TerminalEvidence JSON', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'autonomous-evidence-report-'));
    try {
      const evidencePath = join(workspace, 'terminal-evidence.json');
      writeFileSync(evidencePath, terminalEvidenceJson(), 'utf8');
      const originalEvidenceContent = readFileSync(evidencePath, 'utf8');
      const originalEvidenceStat = statSync(evidencePath);
      const originalWorkspaceEntries = readdirSync(workspace).sort();
      const argv = [
        '--',
        '--evidence',
        evidencePath,
        '--generated-at',
        '2026-05-05T14:01:00.000Z',
        '--pretty',
      ] as const;
      const io = makeIo();

      const exitCode = runAutonomousResearchEvidenceReportCli(argv, io);

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe('');
      const report = JSON.parse(io.stdoutText()) as {
        readonly generatedAt: string;
        readonly status: string;
        readonly scorecard: {
          readonly evidenceRecordCount: number;
          readonly autonomousTaskCount: number;
          readonly checkpointCounts: {
            readonly 'runtime-decoration-start': number;
            readonly 'runtime-decoration-complete': number;
            readonly 'runtime-decoration-error': number;
          };
          readonly criteriaCoverage: {
            readonly complete: boolean;
            readonly missing: readonly string[];
          };
          readonly qualityScore: {
            readonly value: number;
            readonly max: number;
          };
        };
        readonly tasks: readonly {
          readonly status: string;
          readonly checkpoints: readonly unknown[];
        }[];
        readonly boundary: {
          readonly readOnly: boolean;
          readonly runtimeDriverCalled: boolean;
          readonly delegateCalled: boolean;
          readonly providerSwitching: boolean;
          readonly sourceMutation: boolean;
        };
      };
      expect(report.generatedAt).toBe('2026-05-05T14:01:00.000Z');
      expect(report.status).toBe('complete');
      expect(report.scorecard.evidenceRecordCount).toBe(1);
      expect(report.scorecard.autonomousTaskCount).toBe(1);
      expect(report.scorecard.checkpointCounts).toEqual({
        'runtime-decoration-start': 1,
        'runtime-decoration-complete': 1,
        'runtime-decoration-error': 0,
      });
      expect(report.scorecard.criteriaCoverage).toMatchObject({
        complete: true,
        missing: [],
      });
      expect(report.scorecard.qualityScore).toMatchObject({
        value: 100,
        max: 100,
      });
      expect(report.tasks[0]?.status).toBe('complete');
      expect(report.tasks[0]?.checkpoints).toHaveLength(2);
      expect(report.boundary).toEqual({
        readOnly: true,
        runtimeDriverCalled: false,
        delegateCalled: false,
        providerSwitching: false,
        sourceMutation: false,
      });
      expect(io.stdoutText()).not.toContain('research until secret');
      expect(readFileSync(evidencePath, 'utf8')).toBe(originalEvidenceContent);
      expect(statSync(evidencePath).size).toBe(originalEvidenceStat.size);
      expect(statSync(evidencePath).mtimeMs).toBe(originalEvidenceStat.mtimeMs);
      expect(readdirSync(workspace).sort()).toEqual(originalWorkspaceEntries);

      const secondIo = makeIo();
      const secondExitCode = runAutonomousResearchEvidenceReportCli(
        argv,
        secondIo,
      );

      expect(secondExitCode).toBe(0);
      expect(secondIo.stderrText()).toBe('');
      expect(secondIo.stdoutText()).toBe(io.stdoutText());
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('reports not-requested evidence without dispatching a trait runtime', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'autonomous-evidence-report-'));
    try {
      const evidencePath = join(workspace, 'terminal-evidence.json');
      writeFileSync(
        evidencePath,
        terminalEvidenceJson({ includeAutonomousCheckpoints: false }),
        'utf8',
      );
      const io = makeIo();

      const exitCode = runAutonomousResearchEvidenceReportCli(
        ['--evidence', evidencePath, '--generated-at', '2026-05-05T14:01:00.000Z'],
        io,
      );

      expect(exitCode).toBe(0);
      const report = JSON.parse(io.stdoutText()) as {
        readonly status: string;
        readonly scorecard: {
          readonly recommendations: readonly string[];
        };
      };
      expect(report.status).toBe('not-requested');
      expect(report.scorecard.recommendations[0]).toContain(
        'AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('reports delegate-error checkpoints as blocking evidence', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'autonomous-evidence-report-'));
    try {
      const evidencePath = join(workspace, 'terminal-evidence.json');
      writeFileSync(
        evidencePath,
        terminalEvidenceJson({ includeErrorCheckpoint: true }),
        'utf8',
      );
      const io = makeIo();

      const exitCode = runAutonomousResearchEvidenceReportCli(
        ['--evidence', evidencePath, '--generated-at', '2026-05-05T14:01:00.000Z'],
        io,
      );

      expect(exitCode).toBe(0);
      const report = JSON.parse(io.stdoutText()) as {
        readonly status: string;
        readonly tasks: readonly { readonly status: string }[];
      };
      expect(report.status).toBe('delegate-error');
      expect(report.tasks[0]?.status).toBe('delegate-error');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('aggregates repeated evidence paths with explicit status precedence', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'autonomous-evidence-report-'));
    try {
      const completePath = join(workspace, 'complete.json');
      const notRequestedPath = join(workspace, 'not-requested.json');
      const delegateErrorPath = join(workspace, 'delegate-error.json');
      writeFileSync(completePath, terminalEvidenceJson(), 'utf8');
      writeFileSync(
        notRequestedPath,
        terminalEvidenceJson({ includeAutonomousCheckpoints: false }),
        'utf8',
      );
      writeFileSync(
        delegateErrorPath,
        terminalEvidenceJson({ includeErrorCheckpoint: true }),
        'utf8',
      );

      const completePlusNotRequestedIo = makeIo();
      expect(
        runAutonomousResearchEvidenceReportCli(
          [
            '--evidence',
            completePath,
            '--evidence',
            notRequestedPath,
            '--generated-at',
            '2026-05-05T14:01:00.000Z',
          ],
          completePlusNotRequestedIo,
        ),
      ).toBe(0);
      const completePlusNotRequested = JSON.parse(
        completePlusNotRequestedIo.stdoutText(),
      ) as {
        readonly status: string;
        readonly scorecard: {
          readonly evidenceRecordCount: number;
          readonly autonomousTaskCount: number;
          readonly taskStatusCounts: {
            readonly complete: number;
            readonly 'not-requested': number;
          };
        };
      };
      expect(completePlusNotRequested.status).toBe('complete');
      expect(completePlusNotRequested.scorecard.evidenceRecordCount).toBe(2);
      expect(completePlusNotRequested.scorecard.autonomousTaskCount).toBe(1);
      expect(
        completePlusNotRequested.scorecard.taskStatusCounts.complete,
      ).toBe(1);
      expect(
        completePlusNotRequested.scorecard.taskStatusCounts['not-requested'],
      ).toBe(1);

      const delegateErrorIo = makeIo();
      expect(
        runAutonomousResearchEvidenceReportCli(
          [
            '--evidence',
            completePath,
            '--evidence',
            delegateErrorPath,
            '--generated-at',
            '2026-05-05T14:01:00.000Z',
          ],
          delegateErrorIo,
        ),
      ).toBe(0);
      const delegateErrorReport = JSON.parse(delegateErrorIo.stdoutText()) as {
        readonly status: string;
      };
      expect(delegateErrorReport.status).toBe('delegate-error');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('ignores non-canonical or empty checkpoint details instead of promoting completion', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'autonomous-evidence-report-'));
    try {
      const evidencePath = join(workspace, 'terminal-evidence.json');
      const parsed = JSON.parse(terminalEvidenceJson()) as {
        transcript: { events: unknown[] };
      };
      parsed.transcript.events = [
        {
          kind: 'agent-step',
          timestamp: '2026-05-05T14:00:01.000Z',
          instanceId: 'runtime-autonomous-evidence-report',
          step: 'autonomous-research.checkpoint',
          detail:
            'checkpoint=runtime-decoration-start | trait=other-trait | profile=dgm-bounded-archive-runtime',
        },
        {
          kind: 'agent-step',
          timestamp: '2026-05-05T14:00:02.000Z',
          instanceId: 'runtime-autonomous-evidence-report',
          step: 'autonomous-research.checkpoint',
          detail: '',
        },
        {
          kind: 'agent-step',
          timestamp: '2026-05-05T14:00:03.000Z',
          instanceId: 'runtime-autonomous-evidence-report',
          step: 'other.step',
          detail: checkpointDetail('runtime-decoration-complete'),
        },
      ];
      writeFileSync(evidencePath, JSON.stringify(parsed), 'utf8');
      const io = makeIo();

      const exitCode = runAutonomousResearchEvidenceReportCli(
        ['--evidence', evidencePath, '--generated-at', '2026-05-05T14:01:00.000Z'],
        io,
      );

      expect(exitCode).toBe(0);
      const report = JSON.parse(io.stdoutText()) as {
        readonly status: string;
        readonly scorecard: { readonly autonomousTaskCount: number };
      };
      expect(report.status).toBe('not-requested');
      expect(report.scorecard.autonomousTaskCount).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });


  it('prints a read-only non-promoting TerminalEvidence template', () => {
    const io = makeIo();

    const exitCode = runAutonomousResearchEvidenceReportCli(
      [
        '--print-template',
        '--generated-at',
        '2026-05-05T14:02:00.000Z',
        '--pretty',
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    const template = JSON.parse(io.stdoutText()) as {
      readonly taskId: string;
      readonly runtimeInstanceId: string;
      readonly provenance: string;
      readonly reason: string;
      readonly executionContext: {
        readonly planCreatedAt: string;
        readonly executionStartedAt: string;
        readonly runtimeSettings: { readonly networkProfile: string };
      };
      readonly transcript: { readonly events: readonly unknown[] };
      readonly cause: {
        readonly kind: string;
        readonly phase: string;
        readonly message: string;
      };
    };
    expect(template.taskId).toBe('task-autonomous-research-template');
    expect(template.runtimeInstanceId).toBe(
      'runtime-autonomous-research-template',
    );
    expect(template.provenance).toBe('autonomous-research-evidence-template');
    expect(template.reason).toContain('template only');
    expect(template.executionContext.planCreatedAt).toBe(
      '2026-05-05T14:02:00.000Z',
    );
    expect(template.executionContext.executionStartedAt).toBe(
      '2026-05-05T14:02:00.000Z',
    );
    expect(template.executionContext.runtimeSettings.networkProfile).toBe(
      'offline',
    );
    expect(template.transcript.events).toHaveLength(0);
    expect(template.cause).toMatchObject({
      kind: 'driver-failure',
      phase: 'template',
    });
    expect(template.cause.message).toContain('non-promoting template');
    expect(io.stdoutText()).not.toContain('SECRET');
    expect(io.stdoutText()).not.toContain('raw prompt');
    expect(() => createTerminalEvidence(JSON.parse(io.stdoutText()))).not.toThrow();

    const secondIo = makeIo();
    expect(
      runAutonomousResearchEvidenceReportCli(
        [
          '--print-template',
          '--generated-at',
          '2026-05-05T14:02:00.000Z',
          '--pretty',
        ],
        secondIo,
      ),
    ).toBe(0);
    expect(secondIo.stderrText()).toBe('');
    expect(secondIo.stdoutText()).toBe(io.stdoutText());

    const workspace = mkdtempSync(join(tmpdir(), 'autonomous-template-report-'));
    try {
      const templatePath = join(workspace, 'autonomous-template.json');
      writeFileSync(templatePath, io.stdoutText(), 'utf8');
      const reportIo = makeIo();

      const reportExitCode = runAutonomousResearchEvidenceReportCli(
        [
          '--evidence',
          templatePath,
          '--generated-at',
          '2026-05-05T14:03:00.000Z',
          '--pretty',
        ],
        reportIo,
      );

      expect(reportExitCode).toBe(0);
      const report = JSON.parse(reportIo.stdoutText()) as {
        readonly status: string;
        readonly scorecard: {
          readonly evidenceRecordCount: number;
          readonly autonomousTaskCount: number;
          readonly qualityScore: { readonly value: number };
          readonly recommendations: readonly string[];
        };
        readonly boundary: {
          readonly readOnly: boolean;
          readonly runtimeDriverCalled: boolean;
          readonly delegateCalled: boolean;
          readonly providerSwitching: boolean;
          readonly sourceMutation: boolean;
        };
      };
      expect(report.status).toBe('not-requested');
      expect(report.scorecard.evidenceRecordCount).toBe(1);
      expect(report.scorecard.autonomousTaskCount).toBe(0);
      expect(report.scorecard.qualityScore.value).toBe(0);
      expect(report.scorecard.recommendations[0]).toContain(
        'AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION',
      );
      expect(report.boundary).toEqual({
        readOnly: true,
        runtimeDriverCalled: false,
        delegateCalled: false,
        providerSwitching: false,
        sourceMutation: false,
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails closed for template/report mode conflicts and report builder misuse', () => {
    const evidenceConflictIo = makeIo();
    expect(
      runAutonomousResearchEvidenceReportCli(
        ['--print-template', '--evidence', 'terminal-evidence.json'],
        evidenceConflictIo,
      ),
    ).toBe(1);
    expect(evidenceConflictIo.stderrText()).toContain(
      '--print-template cannot be combined with --evidence',
    );

    const byteGuardConflictIo = makeIo();
    expect(
      runAutonomousResearchEvidenceReportCli(
        ['--print-template', '--max-evidence-bytes', '100'],
        byteGuardConflictIo,
      ),
    ).toBe(1);
    expect(byteGuardConflictIo.stderrText()).toContain(
      '--print-template cannot be combined with --max-evidence-bytes',
    );

    expect(() =>
      buildAutonomousResearchEvidenceReportFromCliOptions({
        evidencePaths: [],
        maxEvidenceBytes:
          AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES,
        pretty: false,
        printTemplate: true,
      }),
    ).toThrow(
      /Cannot build an autonomous-research evidence report from --print-template options/,
    );
  });

  it('prints help without requiring evidence files', () => {
    const io = makeIo();

    const exitCode = runAutonomousResearchEvidenceReportCli(['--help'], io);

    expect(exitCode).toBe(0);
    expect(io.stdoutText()).toContain(
      'Usage: pnpm autonomous:research:evidence:report',
    );
    expect(io.stdoutText()).toContain('--print-template');
    expect(io.stdoutText()).toContain('This command is read-only.');
    expect(io.stdoutText()).toContain('does not run autonomous research');
    expect(io.stdoutText()).toContain(
      `--max-evidence-bytes <n>   Fail closed before reading any file beyond this many bytes (default: ${String(AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES)}).`,
    );
    expect(io.stderrText()).toBe('');
  });

  it('fails closed for missing arguments and invalid option values', () => {
    expect(() => parseAutonomousResearchEvidenceReportCliArgs([])).toThrow(
      /--evidence is required/,
    );
    expect(() =>
      parseAutonomousResearchEvidenceReportCliArgs([
        '--print-template',
        '--evidence',
        'terminal-evidence.json',
      ]),
    ).toThrow(/--print-template cannot be combined with --evidence/);
    expect(() =>
      parseAutonomousResearchEvidenceReportCliArgs([
        '--print-template',
        '--generated-at',
        'not-iso',
      ]),
    ).toThrow(/--generated-at must be a valid ISO-8601 UTC timestamp/);
    expect(() =>
      parseAutonomousResearchEvidenceReportCliArgs([
        '--evidence',
        'terminal-evidence.json',
        '--generated-at',
        'not-iso',
      ]),
    ).toThrow(/--generated-at must be a valid ISO-8601 UTC timestamp/);
    for (const invalidMaxEvidenceBytes of [
      '0',
      '-1',
      '1.5',
      'abc',
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      expect(() =>
        parseAutonomousResearchEvidenceReportCliArgs([
          '--evidence',
          'terminal-evidence.json',
          '--max-evidence-bytes',
          invalidMaxEvidenceBytes,
        ]),
      ).toThrow(/--max-evidence-bytes must be a positive safe integer/);
    }
  });

  it('fails closed for missing, directory, symlink, and oversized evidence paths', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'autonomous-evidence-report-'));
    try {
      const evidencePath = join(workspace, 'terminal-evidence.json');
      const symlinkPath = join(workspace, 'terminal-evidence-link.json');
      writeFileSync(evidencePath, terminalEvidenceJson(), 'utf8');
      symlinkSync(evidencePath, symlinkPath);

      const missingIo = makeIo();
      expect(
        runAutonomousResearchEvidenceReportCli(
          ['--evidence', join(workspace, 'missing.json')],
          missingIo,
        ),
      ).toBe(1);
      expect(missingIo.stderrText()).toContain('--evidence path does not exist');

      const directoryIo = makeIo();
      expect(
        runAutonomousResearchEvidenceReportCli(['--evidence', workspace], directoryIo),
      ).toBe(1);
      expect(directoryIo.stderrText()).toContain(
        '--evidence path is not a regular file',
      );

      const symlinkIo = makeIo();
      expect(
        runAutonomousResearchEvidenceReportCli(['--evidence', symlinkPath], symlinkIo),
      ).toBe(1);
      expect(symlinkIo.stderrText()).toContain(
        '--evidence path is not a regular file',
      );

      const oversizedIo = makeIo();
      expect(
        runAutonomousResearchEvidenceReportCli(
          ['--evidence', evidencePath, '--max-evidence-bytes', '2'],
          oversizedIo,
        ),
      ).toBe(1);
      expect(oversizedIo.stderrText()).toContain(
        '--evidence file exceeds --max-evidence-bytes',
      );

      const invalidJsonPath = join(workspace, 'invalid.json');
      writeFileSync(invalidJsonPath, '{"taskId":', 'utf8');
      const invalidJsonIo = makeIo();
      expect(
        runAutonomousResearchEvidenceReportCli(
          ['--evidence', invalidJsonPath],
          invalidJsonIo,
        ),
      ).toBe(1);
      expect(invalidJsonIo.stderrText()).toContain(
        'TerminalEvidence file must be valid JSON',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
