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
  LIVE_PROOF_MOTHBALLED_SURFACES,
  LIVE_PROOF_SURFACES,
  LIVE_PROOF_REPORT_CLI_DEFAULT_MAX_PROOF_BYTES,
  LIVE_PROOF_REPORT_RUBRIC_VERSION,
  parseLiveProofManifestFile,
  parseLiveProofReportCliArgs,
  runLiveProofReportCli,
} from '../src/index.js';

function safeBoundary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    secretsRedacted: true,
    rawTokensIncluded: false,
    rawCredentialsIncluded: false,
    rawPromptsIncluded: false,
    rawResponsesIncluded: false,
    rawInstructionsIncluded: false,
    rawPrivateArtifactContentIncluded: false,
    ...overrides,
  };
}

function manifestJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    proofs: [
      {
        proofId: 'discord-smoke-2026-05-05',
        surface: 'discord-service',
        recordedAt: '2026-05-05T12:00:00.000Z',
        status: 'pass',
        operatorApproved: true,
        artifactKind: 'redacted-transcript',
        summary:
          'Gateway proof summary; raw token SECRET_TOKEN_SHOULD_NOT_RENDER must not be echoed.',
        artifacts: [
          'gateway-ready',
          'command-registration',
          'admin-doctor-or-auth-smoke',
          'correlated-command-reply',
        ],
        correlationIds: ['task-safe-1'],
        boundary: safeBoundary(),
      },
      {
        proofId: 'gitlab-proof-warn',
        surface: 'gitlab-recording',
        recordedAt: '2026-05-05T13:00:00.000Z',
        status: 'warn',
        operatorApproved: true,
        artifactKind: 'redacted-url-summary',
        summary: 'This summary is intentionally not rendered.',
        artifacts: ['real-project-or-issue-note'],
        boundary: safeBoundary(),
      },
    ],
  });
}

function unsafeManifestJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    proofs: [
      {
        proofId: 'otel-unsafe-proof',
        surface: 'control-plane-otel-logs',
        recordedAt: '2026-05-05T14:00:00.000Z',
        status: 'pass',
        operatorApproved: false,
        artifactKind: 'collector-receipt',
        summary: 'collector receipt with token=SECRET must not be printed',
        artifacts: ['collector-receipt'],
        correlationIds: ['event-safe-1'],
        boundary: safeBoundary({
          secretsRedacted: false,
          rawTokensIncluded: true,
        }),
      },
    ],
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

describe('Live proof report CLI', () => {
  it('keeps open-harness UX surface tokens documented in README and live-proof matrix', () => {
    const readme = readFileSync('README.md', 'utf8');
    const matrix = readFileSync('specs/ARCHIVE/live-proof-matrix.md', 'utf8');
    const openHarnessUxSurfaces = [
      'durable-task-archive-ux',
      'subagent-operator-surface',
      'focus-session-binding-ux',
    ] as const;

    for (const surface of openHarnessUxSurfaces) {
      expect(LIVE_PROOF_SURFACES).toContain(surface);
      expect(readme).toContain(surface);
      expect(matrix).toContain(surface);
    }
  });

  it('builds a read-only filtered scorecard from a redacted proof manifest', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'live-proof-report-cli-'));
    try {
      const proofPath = join(workspace, 'live-proof.json');
      writeFileSync(proofPath, manifestJson(), 'utf8');
      const originalContent = readFileSync(proofPath, 'utf8');
      const originalStat = statSync(proofPath);
      const originalWorkspaceEntries = readdirSync(workspace).sort();
      const argv = [
        '--',
        '--proof',
        proofPath,
        '--surface',
        'discord-service',
        '--max-proof-bytes',
        '10000',
        '--generated-at',
        '2026-05-05T15:00:00.000Z',
        '--pretty',
      ] as const;
      const io = makeIo();

      const exitCode = runLiveProofReportCli(argv, io);

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe('');
      const report = JSON.parse(io.stdoutText()) as {
        readonly generatedAt: string;
        readonly status: string;
        readonly filter: { readonly surfaces: readonly string[] };
        readonly source: {
          readonly proofFileCount: number;
          readonly proofRecordCount: number;
        };
        readonly scorecard: {
          readonly recordCount: number;
          readonly completeProofCount: number;
          readonly missingRequiredArtifactCount: number;
          readonly unsafeBoundaryCount: number;
          readonly qualityScore: { readonly rubricVersion: number; readonly value: number };
        };
        readonly proofs: readonly {
          readonly proofId: string;
          readonly surface: string;
          readonly boundarySafe: boolean;
          readonly correlationIdCount: number;
          readonly missingRequiredArtifacts: readonly string[];
        }[];
        readonly boundary: {
          readonly readOnly: boolean;
          readonly liveServicesContacted: boolean;
          readonly proofFilesMutated: boolean;
          readonly environmentVariablesRead: boolean;
          readonly rawSummariesRendered: boolean;
          readonly rawCorrelationIdsRendered: boolean;
        };
      };
      expect(report.generatedAt).toBe('2026-05-05T15:00:00.000Z');
      expect(report.status).toBe('complete');
      expect(report.filter.surfaces).toEqual(['discord-service']);
      expect(report.source).toEqual({
        proofFileCount: 1,
        proofRecordCount: 2,
      });
      expect(report.scorecard.recordCount).toBe(1);
      expect(report.scorecard.completeProofCount).toBe(1);
      expect(report.scorecard.missingRequiredArtifactCount).toBe(0);
      expect(report.scorecard.unsafeBoundaryCount).toBe(0);
      expect(report.scorecard.qualityScore).toMatchObject({
        rubricVersion: LIVE_PROOF_REPORT_RUBRIC_VERSION,
        value: 100,
      });
      expect(report.proofs).toEqual([
        {
          proofId: 'discord-smoke-2026-05-05',
          surface: 'discord-service',
          lifecycle: 'active',
          recordedAt: '2026-05-05T12:00:00.000Z',
          status: 'pass',
          operatorApproved: true,
          artifactKind: 'redacted-transcript',
          requiredArtifactCount: 4,
          missingRequiredArtifacts: [],
          boundarySafe: true,
          correlationIdCount: 1,
        },
      ]);
      expect(report.boundary).toEqual({
        readOnly: true,
        liveServicesContacted: false,
        proofFilesMutated: false,
        environmentVariablesRead: false,
        rawSummariesRendered: false,
        rawCorrelationIdsRendered: false,
      });
      expect(io.stdoutText()).not.toContain('SECRET_TOKEN_SHOULD_NOT_RENDER');
      expect(io.stdoutText()).not.toContain('task-safe-1');
      expect(io.stdoutText()).not.toContain(workspace);
      expect(readFileSync(proofPath, 'utf8')).toBe(originalContent);
      expect(statSync(proofPath).size).toBe(originalStat.size);
      expect(statSync(proofPath).mtimeMs).toBe(originalStat.mtimeMs);
      expect(readdirSync(workspace).sort()).toEqual(originalWorkspaceEntries);

      const secondIo = makeIo();
      const secondExitCode = runLiveProofReportCli(argv, secondIo);

      expect(secondExitCode).toBe(0);
      expect(secondIo.stderrText()).toBe('');
      expect(secondIo.stdoutText()).toBe(io.stdoutText());
      expect(readFileSync(proofPath, 'utf8')).toBe(originalContent);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps mothballed persona records historical instead of active release blockers', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'live-proof-report-cli-mothballed-'));
    try {
      const proofPath = join(workspace, 'persona-proof.json');
      writeFileSync(
        proofPath,
        JSON.stringify({
          schemaVersion: 1,
          proofs: [
            {
              proofId: 'persona-mothballed-history',
              surface: 'persona-model-rewrite',
              recordedAt: '2026-05-18T08:00:00.000Z',
              status: 'warn',
              operatorApproved: true,
              artifactKind: 'redacted-artifact-set',
              summary:
                'Historical persona telemetry gap; the summary must not be rendered.',
              artifacts: [
                'sampled-transform-telemetry',
                'latency-or-cost-note',
                'no-source-dialogue-copy-review',
              ],
              boundary: safeBoundary(),
            },
          ],
        }),
        'utf8',
      );
      const io = makeIo();

      const exitCode = runLiveProofReportCli(
        [
          '--proof',
          proofPath,
          '--surface',
          'persona-model-rewrite',
          '--generated-at',
          '2026-05-18T08:01:00.000Z',
          '--pretty',
        ],
        io,
      );

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe('');
      const report = JSON.parse(io.stdoutText()) as {
        readonly status: string;
        readonly scorecard: {
          readonly recordCount: number;
          readonly activeRecordCount: number;
          readonly mothballedProofCount: number;
          readonly operatorApprovedCount: number;
          readonly activeOperatorApprovedCount: number;
          readonly warnProofCount: number;
          readonly qualityScore: { readonly value: number };
          readonly recommendations: readonly string[];
        };
        readonly proofs: readonly {
          readonly surface: string;
          readonly lifecycle: string;
          readonly status: string;
        }[];
      };

      expect(LIVE_PROOF_MOTHBALLED_SURFACES).toContain('persona-model-rewrite');
      const liveProofMatrix = readFileSync(
        'specs/ARCHIVE/live-proof-matrix.md',
        'utf8',
      );
      expect(liveProofMatrix).toContain('Persona model rewrite');
      expect(liveProofMatrix).toContain('Mothballed 2026-05-18');
      expect(report.status).toBe('complete');
      expect(report.scorecard.recordCount).toBe(1);
      expect(report.scorecard.activeRecordCount).toBe(0);
      expect(report.scorecard.mothballedProofCount).toBe(1);
      expect(report.scorecard.operatorApprovedCount).toBe(1);
      expect(report.scorecard.activeOperatorApprovedCount).toBe(0);
      expect(report.scorecard.warnProofCount).toBe(0);
      expect(report.scorecard.qualityScore.value).toBe(100);
      expect(report.scorecard.recommendations.join('\n')).toContain(
        'mothballed live-proof record',
      );
      expect(report.proofs).toEqual([
        {
          proofId: 'persona-mothballed-history',
          surface: 'persona-model-rewrite',
          lifecycle: 'mothballed',
          recordedAt: '2026-05-18T08:00:00.000Z',
          status: 'warn',
          operatorApproved: true,
          artifactKind: 'redacted-artifact-set',
          requiredArtifactCount: 3,
          missingRequiredArtifacts: [],
          boundarySafe: true,
          correlationIdCount: 0,
        },
      ]);
      expect(io.stdoutText()).not.toContain('Historical persona telemetry gap');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('excludes mothballed severity from readiness but still fails unsafe boundaries', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'live-proof-report-cli-mothball-boundary-'));
    const makeProof = (overrides: Record<string, unknown>): Record<string, unknown> => ({
      proofId: 'persona-mothballed-boundary',
      surface: 'persona-model-rewrite',
      recordedAt: '2026-05-18T08:05:00.000Z',
      status: 'fail',
      operatorApproved: true,
      artifactKind: 'redacted-artifact-set',
      artifacts: [
        'sampled-transform-telemetry',
        'latency-or-cost-note',
        'no-source-dialogue-copy-review',
      ],
      boundary: safeBoundary(),
      ...overrides,
    });
    try {
      const safeFailPath = join(workspace, 'safe-fail.json');
      writeFileSync(
        safeFailPath,
        JSON.stringify({
          schemaVersion: 1,
          proofs: [makeProof({ proofId: 'persona-mothballed-safe-fail' })],
        }),
        'utf8',
      );
      const safeIo = makeIo();

      const safeExitCode = runLiveProofReportCli(
        [
          '--proof',
          safeFailPath,
          '--generated-at',
          '2026-05-18T08:06:00.000Z',
          '--pretty',
        ],
        safeIo,
      );

      expect(safeExitCode).toBe(0);
      const safeReport = JSON.parse(safeIo.stdoutText()) as {
        readonly status: string;
        readonly scorecard: {
          readonly failProofCount: number;
          readonly unsafeBoundaryCount: number;
        };
      };
      expect(safeReport.status).toBe('complete');
      expect(safeReport.scorecard.failProofCount).toBe(0);
      expect(safeReport.scorecard.unsafeBoundaryCount).toBe(0);

      const unsafePath = join(workspace, 'unsafe.json');
      writeFileSync(
        unsafePath,
        JSON.stringify({
          schemaVersion: 1,
          proofs: [
            makeProof({
              proofId: 'persona-mothballed-unsafe',
              status: 'warn',
              boundary: safeBoundary({ secretsRedacted: false }),
            }),
          ],
        }),
        'utf8',
      );
      const unsafeIo = makeIo();

      const unsafeExitCode = runLiveProofReportCli(
        [
          '--proof',
          unsafePath,
          '--generated-at',
          '2026-05-18T08:07:00.000Z',
          '--pretty',
        ],
        unsafeIo,
      );

      expect(unsafeExitCode).toBe(0);
      const unsafeReport = JSON.parse(unsafeIo.stdoutText()) as {
        readonly status: string;
        readonly scorecard: {
          readonly warnProofCount: number;
          readonly unsafeBoundaryCount: number;
        };
      };
      expect(unsafeReport.status).toBe('fail');
      expect(unsafeReport.scorecard.warnProofCount).toBe(0);
      expect(unsafeReport.scorecard.unsafeBoundaryCount).toBe(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('flags unsafe boundaries, missing artifact tokens, and missing operator approval', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'live-proof-report-cli-unsafe-'));
    try {
      const proofPath = join(workspace, 'unsafe-proof.json');
      writeFileSync(proofPath, unsafeManifestJson(), 'utf8');
      const io = makeIo();

      const exitCode = runLiveProofReportCli(
        [
          '--proof',
          proofPath,
          '--generated-at',
          '2026-05-05T15:10:00.000Z',
        ],
        io,
      );

      expect(exitCode).toBe(0);
      const report = JSON.parse(io.stdoutText()) as {
        readonly status: string;
        readonly scorecard: {
          readonly unsafeBoundaryCount: number;
          readonly operatorApprovedCount: number;
          readonly missingRequiredArtifactCount: number;
          readonly recommendations: readonly string[];
          readonly qualityScore: { readonly value: number };
        };
        readonly proofs: readonly {
          readonly boundarySafe: boolean;
          readonly missingRequiredArtifacts: readonly string[];
        }[];
      };
      expect(report.status).toBe('fail');
      expect(report.scorecard.unsafeBoundaryCount).toBe(1);
      expect(report.scorecard.operatorApprovedCount).toBe(0);
      expect(report.scorecard.missingRequiredArtifactCount).toBe(2);
      expect(report.scorecard.qualityScore.value).toBe(30);
      expect(report.scorecard.recommendations).toContain(
        'Remove unsafe proof records or replace them with redacted artifacts before sharing the report.',
      );
      expect(report.scorecard.recommendations).toContain(
        'Mark each retained live proof with explicit operator approval before treating it as live evidence.',
      );
      expect(report.proofs[0]?.boundarySafe).toBe(false);
      expect(report.proofs[0]?.missingRequiredArtifacts).toEqual([
        'known-control-plane-event-id',
        'no-raw-content-export-confirmation',
      ]);
      expect(io.stdoutText()).not.toContain('token=SECRET');
      expect(io.stdoutText()).not.toContain('event-safe-1');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('covers open-harness UX proof surfaces from the live-proof matrix', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'live-proof-report-cli-ux-'));
    try {
      const proofPath = join(workspace, 'ux-proof.json');
      writeFileSync(
        proofPath,
        JSON.stringify({
          schemaVersion: 1,
          proofs: [
            {
              proofId: 'archive-ux-proof',
              surface: 'durable-task-archive-ux',
              recordedAt: '2026-05-05T16:00:00.000Z',
              status: 'pass',
              operatorApproved: true,
              artifactKind: 'redacted-scorecard',
              artifacts: [
                'archive-interaction',
                'unarchive-interaction',
                'tasks-archived-before-restore',
                'archive-unarchive-audit-records',
                'redacted-scorecard',
              ],
              boundary: safeBoundary(),
            },
            {
              proofId: 'subagent-ux-proof',
              surface: 'subagent-operator-surface',
              recordedAt: '2026-05-05T16:05:00.000Z',
              status: 'pass',
              operatorApproved: true,
              artifactKind: 'redacted-scorecard',
              artifacts: [
                'subagents-operator-interactions',
                'root-owned-roster',
                'spawn-terminal-events',
                'progress-samples',
                'redacted-scorecard',
              ],
              boundary: safeBoundary(),
            },
            {
              proofId: 'focus-ux-warn',
              surface: 'focus-session-binding-ux',
              recordedAt: '2026-05-05T16:10:00.000Z',
              status: 'warn',
              operatorApproved: true,
              artifactKind: 'redacted-scorecard',
              artifacts: [
                'focus-command',
                'focused-ask-steering',
              ],
              boundary: safeBoundary(),
            },
          ],
        }),
        'utf8',
      );
      const io = makeIo();

      const exitCode = runLiveProofReportCli(
        [
          '--proof',
          proofPath,
          '--surface',
          'durable-task-archive-ux',
          '--surface',
          'subagent-operator-surface',
          '--surface',
          'focus-session-binding-ux',
          '--generated-at',
          '2026-05-05T16:30:00.000Z',
          '--pretty',
        ],
        io,
      );

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe('');
      const report = JSON.parse(io.stdoutText()) as {
        readonly status: string;
        readonly scorecard: {
          readonly recordCount: number;
          readonly completeProofCount: number;
          readonly warnProofCount: number;
          readonly missingRequiredArtifactCount: number;
          readonly surfaceCounts: Record<string, number>;
        };
        readonly proofs: readonly {
          readonly surface: string;
          readonly requiredArtifactCount: number;
          readonly missingRequiredArtifacts: readonly string[];
        }[];
      };

      expect(LIVE_PROOF_SURFACES).toEqual(
        expect.arrayContaining([
          'durable-task-archive-ux',
          'subagent-operator-surface',
          'focus-session-binding-ux',
        ]),
      );
      expect(report.status).toBe('warn');
      expect(report.scorecard.recordCount).toBe(3);
      expect(report.scorecard.completeProofCount).toBe(2);
      expect(report.scorecard.warnProofCount).toBe(1);
      expect(report.scorecard.missingRequiredArtifactCount).toBe(3);
      expect(report.scorecard.surfaceCounts['durable-task-archive-ux']).toBe(1);
      expect(report.scorecard.surfaceCounts['subagent-operator-surface']).toBe(1);
      expect(report.scorecard.surfaceCounts['focus-session-binding-ux']).toBe(1);
      expect(report.proofs.find((proof) => proof.surface === 'durable-task-archive-ux'))
        .toMatchObject({
          requiredArtifactCount: 5,
          missingRequiredArtifacts: [],
        });
      expect(report.proofs.find((proof) => proof.surface === 'subagent-operator-surface'))
        .toMatchObject({
          requiredArtifactCount: 5,
          missingRequiredArtifacts: [],
        });
      expect(report.proofs.find((proof) => proof.surface === 'focus-session-binding-ux'))
        .toMatchObject({
          requiredArtifactCount: 5,
          missingRequiredArtifacts: [
            'unfocus-command',
            'binding-create-steering-terminal-records',
            'redacted-scorecard',
          ],
        });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('prints a read-only redacted manifest template for selected surfaces', () => {
    const io = makeIo();

    const exitCode = runLiveProofReportCli(
      [
        '--print-template',
        '--surface',
        'durable-task-archive-ux',
        '--surface',
        'focus-session-binding-ux',
        '--generated-at',
        '2026-05-05T17:00:00.000Z',
        '--pretty',
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    const template = parseLiveProofManifestFile(io.stdoutText());
    expect(template.schemaVersion).toBe(1);
    expect(template.proofs).toHaveLength(2);
    expect(template.proofs.map((proof) => proof.surface)).toEqual([
      'durable-task-archive-ux',
      'focus-session-binding-ux',
    ]);
    for (const proof of template.proofs) {
      expect(proof.recordedAt).toBe('2026-05-05T17:00:00.000Z');
      expect(proof.status).toBe('warn');
      expect(proof.operatorApproved).toBe(false);
      expect(proof.artifactKind).toBe('redacted-artifact-set');
      expect(proof.correlationIds).toBeUndefined();
      expect(proof.boundary).toEqual(safeBoundary());
    }
    expect(template.proofs[0]?.artifacts).toEqual([
      'archive-interaction',
      'unarchive-interaction',
      'tasks-archived-before-restore',
      'archive-unarchive-audit-records',
      'redacted-scorecard',
    ]);
    expect(template.proofs[1]?.artifacts).toEqual([
      'focus-command',
      'focused-ask-steering',
      'unfocus-command',
      'binding-create-steering-terminal-records',
      'redacted-scorecard',
    ]);
    expect(io.stdoutText()).not.toContain('SECRET');
    expect(io.stdoutText()).not.toContain('raw-correlation-id');
  });

  it('prints all live-proof surfaces in template mode when no surface filter is provided', () => {
    const io = makeIo();

    const exitCode = runLiveProofReportCli(['--print-template'], io);

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    const template = parseLiveProofManifestFile(io.stdoutText());
    expect(template.proofs).toHaveLength(LIVE_PROOF_SURFACES.length);
    expect(template.proofs.map((proof) => proof.surface)).toEqual(
      LIVE_PROOF_SURFACES,
    );
    for (const proof of template.proofs) {
      expect(proof.status).toBe('warn');
      expect(proof.operatorApproved).toBe(false);
      expect(proof.artifacts.length).toBeGreaterThan(0);
      expect(proof.boundary).toEqual(safeBoundary());
    }
  });

  it('prints help without requiring a proof path', () => {
    const io = makeIo();

    const exitCode = runLiveProofReportCli(['--help'], io);

    expect(exitCode).toBe(0);
    expect(io.stdoutText()).toContain('Usage: pnpm live:proof:report');
    expect(io.stdoutText()).toContain('--print-template');
    expect(io.stdoutText()).toContain('This command is read-only.');
    expect(io.stdoutText()).toContain(
      '0 when a report is generated, including report status warn/fail/no-proof.',
    );
    expect(io.stdoutText()).toContain(
      '1 for argument, file, byte-guard, JSON, or manifest validation failures.',
    );
    expect(io.stdoutText()).toContain(
      `--max-proof-bytes <n>     Fail closed before reading any file beyond this many bytes (default: ${String(LIVE_PROOF_REPORT_CLI_DEFAULT_MAX_PROOF_BYTES)}).`,
    );
    expect(io.stderrText()).toBe('');
  });

  it('fails closed for missing arguments and invalid option values', () => {
    expect(() => parseLiveProofReportCliArgs([])).toThrow(/--proof is required/);
    expect(() =>
      parseLiveProofReportCliArgs([
        '--print-template',
        '--proof',
        'proof.json',
      ]),
    ).toThrow(/--print-template cannot be combined with --proof/);
    expect(() =>
      parseLiveProofReportCliArgs(['--proof', 'proof.json', '--surface', 'unknown']),
    ).toThrow(/--surface must be one of/);
    expect(() =>
      parseLiveProofReportCliArgs([
        '--proof',
        'proof.json',
        '--generated-at',
        'not-iso',
      ]),
    ).toThrow(/--generated-at must be a valid ISO-8601 UTC timestamp/);
    for (const invalidMaxProofBytes of [
      '0',
      '-1',
      '1.5',
      'abc',
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      expect(() =>
        parseLiveProofReportCliArgs([
          '--proof',
          'proof.json',
          '--max-proof-bytes',
          invalidMaxProofBytes,
        ]),
      ).toThrow(/--max-proof-bytes must be a positive safe integer/);
    }
  });

  it('validates manifest shape and safe token fields', () => {
    expect(() => parseLiveProofManifestFile('not json')).toThrow(
      /must be valid JSON/,
    );
    expect(() =>
      parseLiveProofManifestFile(
        JSON.stringify({ schemaVersion: 2, proofs: [] }),
      ),
    ).toThrow(/schemaVersion must be 1/);
    expect(() =>
      parseLiveProofManifestFile(
        JSON.stringify({
          schemaVersion: 1,
          proofs: [
            {
              proofId: 'unsafe proof id',
              surface: 'discord-service',
              recordedAt: '2026-05-05T12:00:00.000Z',
              status: 'pass',
              operatorApproved: true,
              artifactKind: 'redacted-transcript',
              artifacts: ['gateway-ready'],
              boundary: safeBoundary(),
            },
          ],
        }),
      ),
    ).toThrow(/proofs\[0\]\.proofId must be a safe identifier token/);
    expect(() =>
      parseLiveProofManifestFile(
        JSON.stringify({
          schemaVersion: 1,
          proofs: [
            {
              proofId: 'discord-safe',
              surface: 'discord-service',
              recordedAt: '2026-05-05T12:00:00.000Z',
              status: 'pass',
              operatorApproved: true,
              artifactKind: 'redacted-transcript',
              artifacts: ['gateway-ready', 'raw token text'],
              boundary: safeBoundary(),
            },
          ],
        }),
      ),
    ).toThrow(/proofs\[0\]\.artifacts\[1\] must be a safe artifact token/);
  });

  it('fails closed before reading oversized or non-file proof paths', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'live-proof-report-cli-guard-'));
    try {
      const proofPath = join(workspace, 'proof.json');
      writeFileSync(proofPath, manifestJson(), 'utf8');
      const io = makeIo();

      const exitCode = runLiveProofReportCli(
        ['--proof', proofPath, '--max-proof-bytes', '1'],
        io,
      );

      expect(exitCode).toBe(1);
      expect(io.stderrText()).toContain(
        '--proof file exceeds --max-proof-bytes',
      );

      const dirIo = makeIo();
      const dirExitCode = runLiveProofReportCli(['--proof', workspace], dirIo);

      expect(dirExitCode).toBe(1);
      expect(dirIo.stderrText()).toContain(
        '--proof path is not a regular file',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
