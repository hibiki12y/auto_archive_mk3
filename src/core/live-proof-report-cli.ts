import { lstatSync, readFileSync } from 'node:fs';

export const LIVE_PROOF_REPORT_SCHEMA_VERSION = 1;
export const LIVE_PROOF_REPORT_RUBRIC_VERSION = 1;
export const LIVE_PROOF_REPORT_CLI_DEFAULT_MAX_PROOF_BYTES =
  5 * 1024 * 1024;

export const LIVE_PROOF_SURFACES = Object.freeze([
  'discord-service',
  'gitlab-recording',
  'codex-runtime-provider',
  'claude-agent-runtime-provider',
  'agent-harness-registry',
  'plana-runtime-advisor',
  'autonomous-research-evidence',
  'durable-task-archive-ux',
  'subagent-operator-surface',
  'focus-session-binding-ux',
  'task-health-observer',
  'trait-scheduler-tick-evidence',
  'control-plane-otel-logs',
  'slurm-apptainer-compute',
  'peekaboo-discord-gui',
  'persona-model-rewrite',
] as const);

export type LiveProofSurface = (typeof LIVE_PROOF_SURFACES)[number];
export const LIVE_PROOF_MOTHBALLED_SURFACES = Object.freeze([
  'persona-model-rewrite',
] as const satisfies readonly LiveProofSurface[]);
export type LiveProofSurfaceLifecycle = 'active' | 'mothballed';
export type LiveProofArtifactStatus = 'pass' | 'warn' | 'fail';
export type LiveProofReportStatus = 'complete' | 'warn' | 'fail' | 'no-proof';

export interface LiveProofArtifactBoundary {
  readonly secretsRedacted: boolean;
  readonly rawTokensIncluded: boolean;
  readonly rawCredentialsIncluded: boolean;
  readonly rawPromptsIncluded: boolean;
  readonly rawResponsesIncluded: boolean;
  readonly rawInstructionsIncluded: boolean;
  readonly rawPrivateArtifactContentIncluded: boolean;
}

export interface LiveProofArtifactRecord {
  readonly proofId: string;
  readonly surface: LiveProofSurface;
  readonly recordedAt: string;
  readonly status: LiveProofArtifactStatus;
  readonly operatorApproved: boolean;
  readonly artifactKind: string;
  readonly summary?: string;
  readonly artifacts: readonly string[];
  readonly correlationIds?: readonly string[];
  readonly boundary: LiveProofArtifactBoundary;
}

export interface LiveProofManifestFile {
  readonly schemaVersion: typeof LIVE_PROOF_REPORT_SCHEMA_VERSION;
  readonly proofs: readonly LiveProofArtifactRecord[];
}

export interface LiveProofReportCliIo {
  readonly stdout: {
    write(chunk: string): void;
  };
  readonly stderr: {
    write(chunk: string): void;
  };
}

export interface LiveProofReportCliOptions {
  readonly proofPaths: readonly string[];
  readonly surfaces: readonly LiveProofSurface[];
  readonly maxProofBytes: number;
  readonly generatedAt?: string;
  readonly pretty: boolean;
  readonly printTemplate: boolean;
}

export interface LiveProofAssessment {
  readonly proofId: string;
  readonly surface: LiveProofSurface;
  readonly lifecycle: LiveProofSurfaceLifecycle;
  readonly recordedAt: string;
  readonly status: LiveProofArtifactStatus;
  readonly operatorApproved: boolean;
  readonly artifactKind: string;
  readonly requiredArtifactCount: number;
  readonly missingRequiredArtifacts: readonly string[];
  readonly boundarySafe: boolean;
  readonly correlationIdCount: number;
}

export interface LiveProofReport {
  readonly schemaVersion: typeof LIVE_PROOF_REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly status: LiveProofReportStatus;
  readonly filter: {
    readonly surfaces: readonly LiveProofSurface[];
  };
  readonly method: {
    readonly requirementSource: 'specs/ARCHIVE/live-proof-matrix.md';
    readonly scoringRubricVersion: typeof LIVE_PROOF_REPORT_RUBRIC_VERSION;
    readonly promotionRule: string;
  };
  readonly source: {
    readonly proofFileCount: number;
    readonly proofRecordCount: number;
  };
  readonly scorecard: {
    readonly recordCount: number;
    readonly activeRecordCount: number;
    readonly mothballedProofCount: number;
    readonly completeProofCount: number;
    readonly warnProofCount: number;
    readonly failProofCount: number;
    readonly operatorApprovedCount: number;
    readonly activeOperatorApprovedCount: number;
    readonly unsafeBoundaryCount: number;
    readonly missingRequiredArtifactCount: number;
    readonly surfaceCounts: Readonly<Record<LiveProofSurface, number>>;
    readonly qualityScore: {
      readonly rubricVersion: typeof LIVE_PROOF_REPORT_RUBRIC_VERSION;
      readonly value: number;
      readonly max: 100;
      readonly summary: string;
    };
    readonly recommendations: readonly string[];
  };
  readonly proofs: readonly LiveProofAssessment[];
  readonly boundary: {
    readonly readOnly: true;
    readonly liveServicesContacted: false;
    readonly proofFilesMutated: false;
    readonly environmentVariablesRead: false;
    readonly rawSummariesRendered: false;
    readonly rawCorrelationIdsRendered: false;
  };
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_ARTIFACT_PATTERN = /^[a-z0-9._:-]{1,128}$/u;

const LIVE_PROOF_REQUIRED_ARTIFACTS = Object.freeze({
  'discord-service': [
    'gateway-ready',
    'command-registration',
    'admin-doctor-or-auth-smoke',
    'correlated-command-reply',
  ],
  'gitlab-recording': [
    'real-project-or-issue-note',
    'redacted-url-or-id',
    'cleanup-or-closeout',
  ],
  'codex-runtime-provider': [
    'authenticated-run',
    'terminal-evidence',
    'codex-runtime-driver-provenance',
  ],
  'claude-agent-runtime-provider': [
    'authenticated-run',
    'terminal-evidence',
    'claude-agent-runtime-driver-provenance',
  ],
  'agent-harness-registry': [
    'operator-owned-descriptor',
    'selected-harness-preview',
    'zero-provider-switching',
  ],
  'plana-runtime-advisor': [
    'advisor-ledger-sample',
    'redacted-scorecard',
    'veto-or-fail-open-counts',
  ],
  'autonomous-research-evidence': [
    'terminal-evidence-json',
    'start-checkpoint',
    'complete-checkpoint',
    'criteria-coverage',
  ],
  'durable-task-archive-ux': [
    'archive-interaction',
    'unarchive-interaction',
    'tasks-archived-before-restore',
    'archive-unarchive-audit-records',
    'redacted-scorecard',
  ],
  'subagent-operator-surface': [
    'subagents-operator-interactions',
    'root-owned-roster',
    'spawn-terminal-events',
    'progress-samples',
    'redacted-scorecard',
  ],
  'focus-session-binding-ux': [
    'focus-command',
    'focused-ask-steering',
    'unfocus-command',
    'binding-create-steering-terminal-records',
    'redacted-scorecard',
  ],
  'task-health-observer': [
    'calibrated-threshold',
    'runtime-progress-events',
    'task-health-stalled-ledger-event',
    'terminal-release',
  ],
  'trait-scheduler-tick-evidence': [
    'operator-owned-tick-loop',
    'minimum-evidence-sample',
    'redacted-scorecard',
    'retention-policy',
  ],
  'control-plane-otel-logs': [
    'collector-receipt',
    'known-control-plane-event-id',
    'no-raw-content-export-confirmation',
  ],
  'slurm-apptainer-compute': [
    'real-salloc-or-apptainer-dispatch',
    'gpu-or-resource-evidence',
    'cleanup-record',
  ],
  'peekaboo-discord-gui': [
    'readiness-record',
    'gui-submit',
    'bot-ack-or-matched-reply',
    'evidence-ledger-record',
  ],
  'persona-model-rewrite': [
    'sampled-transform-telemetry',
    'latency-or-cost-note',
    'no-source-dialogue-copy-review',
  ],
} as const) satisfies Readonly<Record<LiveProofSurface, readonly string[]>>;

const USAGE = `Usage: pnpm live:proof:report -- --proof <path> [options]
       pnpm live:proof:report -- --print-template [--surface <surface>] [options]

Build a read-only scorecard from one or more operator-owned live-proof JSON
manifests. The command checks redaction boundaries and whether each proof record
claims the required artifact tokens for its live-proof matrix surface.
Mothballed surfaces are parsed and reported, but excluded from active
live-readiness status and quality scoring unless their boundary is unsafe.
Scorecard operatorApprovedCount counts all retained proofs; activeOperatorApprovedCount
is the release-readiness numerator after mothballed rows are excluded.
Use --print-template to emit a redacted manifest skeleton for the selected
surface(s) without reading or writing any proof file.

Manifest shape:
  {
    "schemaVersion": 1,
    "proofs": [
      {
        "proofId": "discord-smoke-2026-05-05",
        "surface": "discord-service",
        "recordedAt": "2026-05-05T12:00:00.000Z",
        "status": "pass",
        "operatorApproved": true,
        "artifactKind": "redacted-transcript",
        "summary": "Not rendered by this report; keep it redacted.",
        "artifacts": [
          "gateway-ready",
          "command-registration",
          "admin-doctor-or-auth-smoke",
          "correlated-command-reply"
        ],
        "correlationIds": ["task-abc"],
        "boundary": {
          "secretsRedacted": true,
          "rawTokensIncluded": false,
          "rawCredentialsIncluded": false,
          "rawPromptsIncluded": false,
          "rawResponsesIncluded": false,
          "rawInstructionsIncluded": false,
          "rawPrivateArtifactContentIncluded": false
        }
      }
    ]
  }

Options:
  --proof <path>            Required JSON proof manifest path. May be repeated.
  --print-template          Print a redacted manifest skeleton instead of reading proof files.
  --surface <surface>       Filter by live-proof surface. May be repeated.
  --max-proof-bytes <n>     Fail closed before reading any file beyond this many bytes (default: ${String(LIVE_PROOF_REPORT_CLI_DEFAULT_MAX_PROOF_BYTES)}).
  --generated-at <iso>      Optional generatedAt timestamp to embed in the report.
  --pretty                  Pretty-print JSON output.
  --help                    Show this help text.

Boundary:
  This command is read-only. It does not contact Discord, GitLab, providers,
  SLURM, Peekaboo, OTLP collectors, or any other live service. It does not read
  environment variables, mutate proof files, render raw summaries, or render raw
  correlation ids. Input manifests must be redacted operator-owned artifacts and
  must not include secrets, prompts, responses, private artifact content, or raw
  task instructions.

Exit codes:
  0 when a report is generated, including report status warn/fail/no-proof.
  1 for argument, file, byte-guard, JSON, or manifest validation failures.
`;

export function parseLiveProofReportCliArgs(
  argv: readonly string[],
): LiveProofReportCliOptions | 'help' {
  const proofPaths: string[] = [];
  const surfaces: LiveProofSurface[] = [];
  let maxProofBytes = LIVE_PROOF_REPORT_CLI_DEFAULT_MAX_PROOF_BYTES;
  let generatedAt: string | undefined;
  let pretty = false;
  let printTemplate = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--':
        break;
      case '--help':
      case '-h':
        return 'help';
      case '--pretty':
        pretty = true;
        break;
      case '--print-template':
        printTemplate = true;
        break;
      case '--proof':
        proofPaths.push(requireCliValue(argv, index, '--proof'));
        index += 1;
        break;
      case '--surface': {
        const rawSurface = requireCliValue(argv, index, '--surface');
        surfaces.push(parseLiveProofSurface(rawSurface, '--surface'));
        index += 1;
        break;
      }
      case '--max-proof-bytes': {
        const rawMaxProofBytes = requireCliValue(
          argv,
          index,
          '--max-proof-bytes',
        );
        const parsedMaxProofBytes = Number(rawMaxProofBytes);
        if (
          !Number.isSafeInteger(parsedMaxProofBytes) ||
          parsedMaxProofBytes <= 0
        ) {
          throw new Error('--max-proof-bytes must be a positive safe integer.');
        }
        maxProofBytes = parsedMaxProofBytes;
        index += 1;
        break;
      }
      case '--generated-at':
        generatedAt = requireCliValue(argv, index, '--generated-at');
        if (!isIsoInstant(generatedAt)) {
          throw new Error('--generated-at must be a valid ISO-8601 UTC timestamp.');
        }
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg ?? '(missing)'}.`);
    }
  }

  if (printTemplate && proofPaths.length > 0) {
    throw new Error('--print-template cannot be combined with --proof.');
  }

  if (!printTemplate && proofPaths.length === 0) {
    throw new Error('--proof is required.');
  }

  return {
    proofPaths,
    surfaces: dedupeSurfaces(surfaces),
    maxProofBytes,
    ...(generatedAt === undefined ? {} : { generatedAt }),
    pretty,
    printTemplate,
  };
}

export function parseLiveProofManifestFile(
  content: string,
): LiveProofManifestFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error('Proof manifest must be valid JSON.', { cause: error });
  }

  const object = requireRecord(parsed, 'proof manifest');
  if (object.schemaVersion !== LIVE_PROOF_REPORT_SCHEMA_VERSION) {
    throw new Error('Proof manifest schemaVersion must be 1.');
  }
  if (!Array.isArray(object.proofs)) {
    throw new Error('Proof manifest proofs must be an array.');
  }

  return {
    schemaVersion: LIVE_PROOF_REPORT_SCHEMA_VERSION,
    proofs: object.proofs.map((entry, index) =>
      parseLiveProofArtifactRecord(entry, `proofs[${String(index)}]`),
    ),
  };
}

export function buildLiveProofReportFromCliOptions(
  options: LiveProofReportCliOptions,
): LiveProofReport {
  const proofs = options.proofPaths.flatMap((proofPath) =>
    readProofManifestFile(proofPath, options.maxProofBytes).proofs,
  );
  return buildLiveProofReport({
    proofs,
    surfaces: options.surfaces,
    proofFileCount: options.proofPaths.length,
    ...(options.generatedAt === undefined
      ? {}
      : { generatedAt: options.generatedAt }),
  });
}

export function buildLiveProofManifestTemplateFromCliOptions(
  options: LiveProofReportCliOptions,
): LiveProofManifestFile {
  const surfaces =
    options.surfaces.length === 0 ? LIVE_PROOF_SURFACES : options.surfaces;
  const recordedAt = options.generatedAt ?? new Date().toISOString();
  return {
    schemaVersion: LIVE_PROOF_REPORT_SCHEMA_VERSION,
    proofs: surfaces.map((surface) =>
      buildLiveProofTemplateRecord(surface, recordedAt),
    ),
  };
}

export function buildLiveProofReport(input: {
  readonly proofs: readonly LiveProofArtifactRecord[];
  readonly surfaces?: readonly LiveProofSurface[];
  readonly proofFileCount?: number;
  readonly generatedAt?: string;
}): LiveProofReport {
  const filteredProofs =
    input.surfaces === undefined || input.surfaces.length === 0
      ? input.proofs
      : input.proofs.filter((proof) => input.surfaces?.includes(proof.surface));
  const assessments = filteredProofs.map(assessLiveProof);
  const surfaceCounts = zeroSurfaceCounts();
  for (const assessment of assessments) {
    surfaceCounts[assessment.surface] += 1;
  }
  const activeAssessments = assessments.filter(
    (assessment) => assessment.lifecycle === 'active',
  );
  const mothballedProofCount = assessments.length - activeAssessments.length;
  const warnProofCount = activeAssessments.filter(
    (assessment) => assessment.status === 'warn',
  ).length;
  const failProofCount = activeAssessments.filter(
    (assessment) => assessment.status === 'fail',
  ).length;
  const unsafeBoundaryCount = assessments.filter(
    (assessment) => !assessment.boundarySafe,
  ).length;
  const operatorApprovedCount = assessments.filter(
    (assessment) => assessment.operatorApproved,
  ).length;
  const activeOperatorApprovedCount = activeAssessments.filter(
    (assessment) => assessment.operatorApproved,
  ).length;
  const missingRequiredArtifactCount = activeAssessments.reduce(
    (sum, assessment) => sum + assessment.missingRequiredArtifacts.length,
    0,
  );
  const completeProofCount = activeAssessments.filter(
    (assessment) =>
      assessment.status === 'pass' &&
      assessment.operatorApproved &&
      assessment.boundarySafe &&
      assessment.missingRequiredArtifacts.length === 0,
  ).length;
  const status = resolveLiveProofReportStatus({
    recordCount: assessments.length,
    activeRecordCount: activeAssessments.length,
    warnProofCount,
    failProofCount,
    unsafeBoundaryCount,
    operatorApprovedCount: activeOperatorApprovedCount,
    missingRequiredArtifactCount,
  });
  const recommendations = buildRecommendations({
    recordCount: assessments.length,
    activeRecordCount: activeAssessments.length,
    mothballedProofCount,
    warnProofCount,
    failProofCount,
    unsafeBoundaryCount,
    operatorApprovedCount: activeOperatorApprovedCount,
    missingRequiredArtifactCount,
  });
  const qualityScoreValue =
    activeAssessments.length === 0 &&
    assessments.length > 0 &&
    unsafeBoundaryCount === 0
      ? 100
      : calculateQualityScore({
          recordCount: activeAssessments.length,
          warnProofCount,
          failProofCount,
          unsafeBoundaryCount,
          notOperatorApprovedCount:
            activeAssessments.length - activeOperatorApprovedCount,
          missingRequiredArtifactCount,
        });

  return {
    schemaVersion: LIVE_PROOF_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status,
    filter: {
      surfaces: input.surfaces ?? [],
    },
    method: {
      requirementSource: 'specs/ARCHIVE/live-proof-matrix.md',
      scoringRubricVersion: LIVE_PROOF_REPORT_RUBRIC_VERSION,
      promotionRule:
        'An active surface is complete only when an operator-approved PASS proof has safe boundaries and all required artifact tokens for that surface; mothballed surfaces are excluded from active readiness scoring.',
    },
    source: {
      proofFileCount: input.proofFileCount ?? 1,
      proofRecordCount: input.proofs.length,
    },
    scorecard: {
      recordCount: assessments.length,
      activeRecordCount: activeAssessments.length,
      mothballedProofCount,
      completeProofCount,
      warnProofCount,
      failProofCount,
      operatorApprovedCount,
      activeOperatorApprovedCount,
      unsafeBoundaryCount,
      missingRequiredArtifactCount,
      surfaceCounts,
      qualityScore: {
        rubricVersion: LIVE_PROOF_REPORT_RUBRIC_VERSION,
        value: qualityScoreValue,
        max: 100,
        summary:
          status === 'complete'
            ? 'All active filtered proof records satisfy the static live-proof artifact gate.'
            : 'One or more live-proof artifact gates need operator follow-up.',
      },
      recommendations,
    },
    proofs: assessments,
    boundary: {
      readOnly: true,
      liveServicesContacted: false,
      proofFilesMutated: false,
      environmentVariablesRead: false,
      rawSummariesRendered: false,
      rawCorrelationIdsRendered: false,
    },
  };
}

export function runLiveProofReportCli(
  argv: readonly string[],
  io: LiveProofReportCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  try {
    const options = parseLiveProofReportCliArgs(argv);
    if (options === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    const output = options.printTemplate
      ? buildLiveProofManifestTemplateFromCliOptions(options)
      : buildLiveProofReportFromCliOptions(options);
    io.stdout.write(
      `${JSON.stringify(output, null, options.pretty ? 2 : undefined)}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(
      `live:proof:report failed: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    );
    return 1;
  }
}

function buildLiveProofTemplateRecord(
  surface: LiveProofSurface,
  recordedAt: string,
): LiveProofArtifactRecord {
  return {
    proofId: `${surface}-proof-template`,
    surface,
    recordedAt,
    status: 'warn',
    operatorApproved: false,
    artifactKind: 'redacted-artifact-set',
    summary:
      'Template only. Replace with a redacted operator summary; never include secrets, prompts, raw responses, private artifacts, or raw task instructions.',
    artifacts: LIVE_PROOF_REQUIRED_ARTIFACTS[surface],
    boundary: {
      secretsRedacted: true,
      rawTokensIncluded: false,
      rawCredentialsIncluded: false,
      rawPromptsIncluded: false,
      rawResponsesIncluded: false,
      rawInstructionsIncluded: false,
      rawPrivateArtifactContentIncluded: false,
    },
  };
}

function readProofManifestFile(
  proofPath: string,
  maxProofBytes: number,
): LiveProofManifestFile {
  let proofStat;
  try {
    proofStat = lstatSync(proofPath);
  } catch (error) {
    throw new Error(`--proof path does not exist: ${proofPath}`, {
      cause: error,
    });
  }
  if (!proofStat.isFile()) {
    throw new Error(`--proof path is not a regular file: ${proofPath}`);
  }
  if (proofStat.size > maxProofBytes) {
    throw new Error(
      `--proof file exceeds --max-proof-bytes (${String(proofStat.size)} > ${String(maxProofBytes)}).`,
    );
  }
  return parseLiveProofManifestFile(readFileSync(proofPath, 'utf8'));
}

function parseLiveProofArtifactRecord(
  value: unknown,
  path: string,
): LiveProofArtifactRecord {
  const object = requireRecord(value, path);
  const proofId = requireSafeId(object.proofId, `${path}.proofId`);
  const surface = parseLiveProofSurface(object.surface, `${path}.surface`);
  const recordedAt = requireIsoInstant(object.recordedAt, `${path}.recordedAt`);
  const status = parseStatus(object.status, `${path}.status`);
  const operatorApproved = requireBoolean(
    object.operatorApproved,
    `${path}.operatorApproved`,
  );
  const artifactKind = requireSafeArtifactToken(
    object.artifactKind,
    `${path}.artifactKind`,
  );
  const artifacts = requireSafeArtifactTokenArray(
    object.artifacts,
    `${path}.artifacts`,
  );
  const boundary = parseBoundary(object.boundary, `${path}.boundary`);
  const summary =
    object.summary === undefined
      ? undefined
      : requireString(object.summary, `${path}.summary`);
  const correlationIds =
    object.correlationIds === undefined
      ? undefined
      : requireSafeIdArray(object.correlationIds, `${path}.correlationIds`);

  return {
    proofId,
    surface,
    recordedAt,
    status,
    operatorApproved,
    artifactKind,
    ...(summary === undefined ? {} : { summary }),
    artifacts,
    ...(correlationIds === undefined ? {} : { correlationIds }),
    boundary,
  };
}

function parseBoundary(value: unknown, path: string): LiveProofArtifactBoundary {
  const object = requireRecord(value, path);
  return {
    secretsRedacted: requireBoolean(object.secretsRedacted, `${path}.secretsRedacted`),
    rawTokensIncluded: requireBoolean(
      object.rawTokensIncluded,
      `${path}.rawTokensIncluded`,
    ),
    rawCredentialsIncluded: requireBoolean(
      object.rawCredentialsIncluded,
      `${path}.rawCredentialsIncluded`,
    ),
    rawPromptsIncluded: requireBoolean(
      object.rawPromptsIncluded,
      `${path}.rawPromptsIncluded`,
    ),
    rawResponsesIncluded: requireBoolean(
      object.rawResponsesIncluded,
      `${path}.rawResponsesIncluded`,
    ),
    rawInstructionsIncluded: requireBoolean(
      object.rawInstructionsIncluded,
      `${path}.rawInstructionsIncluded`,
    ),
    rawPrivateArtifactContentIncluded: requireBoolean(
      object.rawPrivateArtifactContentIncluded,
      `${path}.rawPrivateArtifactContentIncluded`,
    ),
  };
}

function assessLiveProof(proof: LiveProofArtifactRecord): LiveProofAssessment {
  const requiredArtifacts = LIVE_PROOF_REQUIRED_ARTIFACTS[proof.surface];
  const artifactSet = new Set(proof.artifacts);
  const missingRequiredArtifacts = requiredArtifacts.filter(
    (requiredArtifact) => !artifactSet.has(requiredArtifact),
  );
  return {
    proofId: proof.proofId,
    surface: proof.surface,
    lifecycle: getLiveProofSurfaceLifecycle(proof.surface),
    recordedAt: proof.recordedAt,
    status: proof.status,
    operatorApproved: proof.operatorApproved,
    artifactKind: proof.artifactKind,
    requiredArtifactCount: requiredArtifacts.length,
    missingRequiredArtifacts,
    boundarySafe: isBoundarySafe(proof.boundary),
    correlationIdCount: proof.correlationIds?.length ?? 0,
  };
}

function getLiveProofSurfaceLifecycle(
  surface: LiveProofSurface,
): LiveProofSurfaceLifecycle {
  return (
    LIVE_PROOF_MOTHBALLED_SURFACES as readonly LiveProofSurface[]
  ).includes(surface)
    ? 'mothballed'
    : 'active';
}

function isBoundarySafe(boundary: LiveProofArtifactBoundary): boolean {
  return (
    boundary.secretsRedacted &&
    !boundary.rawTokensIncluded &&
    !boundary.rawCredentialsIncluded &&
    !boundary.rawPromptsIncluded &&
    !boundary.rawResponsesIncluded &&
    !boundary.rawInstructionsIncluded &&
    !boundary.rawPrivateArtifactContentIncluded
  );
}

function resolveLiveProofReportStatus(input: {
  readonly recordCount: number;
  readonly activeRecordCount: number;
  readonly warnProofCount: number;
  readonly failProofCount: number;
  readonly unsafeBoundaryCount: number;
  readonly operatorApprovedCount: number;
  readonly missingRequiredArtifactCount: number;
}): LiveProofReportStatus {
  if (input.recordCount === 0) {
    return 'no-proof';
  }
  if (
    input.failProofCount > 0 ||
    input.unsafeBoundaryCount > 0 ||
    input.operatorApprovedCount < input.activeRecordCount
  ) {
    return 'fail';
  }
  if (input.warnProofCount > 0 || input.missingRequiredArtifactCount > 0) {
    return 'warn';
  }
  return 'complete';
}

function buildRecommendations(input: {
  readonly recordCount: number;
  readonly activeRecordCount: number;
  readonly mothballedProofCount: number;
  readonly warnProofCount: number;
  readonly failProofCount: number;
  readonly unsafeBoundaryCount: number;
  readonly operatorApprovedCount: number;
  readonly missingRequiredArtifactCount: number;
}): readonly string[] {
  const recommendations: string[] = [];
  if (input.recordCount === 0) {
    recommendations.push(
      'Provide at least one operator-owned live-proof manifest record for the selected surface filter.',
    );
  }
  if (input.mothballedProofCount > 0) {
    recommendations.push(
      `${String(input.mothballedProofCount)} mothballed live-proof record(s) were retained for history and excluded from active readiness scoring.`,
    );
  }
  if (input.failProofCount > 0) {
    recommendations.push(
      'Investigate failed live-proof records before promoting the surface to live-ready.',
    );
  }
  if (input.warnProofCount > 0) {
    recommendations.push(
      'Review warning live-proof records and retain the operator decision with the artifact.',
    );
  }
  if (input.unsafeBoundaryCount > 0) {
    recommendations.push(
      'Remove unsafe proof records or replace them with redacted artifacts before sharing the report.',
    );
  }
  if (input.operatorApprovedCount < input.activeRecordCount) {
    recommendations.push(
      'Mark each retained live proof with explicit operator approval before treating it as live evidence.',
    );
  }
  if (input.missingRequiredArtifactCount > 0) {
    recommendations.push(
      `Add ${String(input.missingRequiredArtifactCount)} missing live-proof artifact token(s) from specs/ARCHIVE/live-proof-matrix.md.`,
    );
  }
  return recommendations;
}

function calculateQualityScore(input: {
  readonly recordCount: number;
  readonly warnProofCount: number;
  readonly failProofCount: number;
  readonly unsafeBoundaryCount: number;
  readonly notOperatorApprovedCount: number;
  readonly missingRequiredArtifactCount: number;
}): number {
  if (input.recordCount === 0) {
    return 0;
  }
  const penalty =
    input.failProofCount * 30 +
    input.unsafeBoundaryCount * 40 +
    input.notOperatorApprovedCount * 20 +
    input.warnProofCount * 10 +
    input.missingRequiredArtifactCount * 5;
  return Math.max(0, Math.min(100, 100 - penalty));
}

function zeroSurfaceCounts(): Record<LiveProofSurface, number> {
  return Object.fromEntries(
    LIVE_PROOF_SURFACES.map((surface) => [surface, 0]),
  ) as Record<LiveProofSurface, number>;
}

function dedupeSurfaces(
  surfaces: readonly LiveProofSurface[],
): readonly LiveProofSurface[] {
  return [...new Set(surfaces)];
}

function parseLiveProofSurface(value: unknown, path: string): LiveProofSurface {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string.`);
  }
  if (!LIVE_PROOF_SURFACES.includes(value as LiveProofSurface)) {
    throw new Error(
      `${path} must be one of: ${LIVE_PROOF_SURFACES.join(', ')}.`,
    );
  }
  return value as LiveProofSurface;
}

function parseStatus(value: unknown, path: string): LiveProofArtifactStatus {
  if (value !== 'pass' && value !== 'warn' && value !== 'fail') {
    throw new Error(`${path} must be one of: pass, warn, fail.`);
  }
  return value;
}

function requireRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string.`);
  }
  return value;
}

function requireSafeId(value: unknown, path: string): string {
  const stringValue = requireString(value, path);
  if (!SAFE_ID_PATTERN.test(stringValue)) {
    throw new Error(`${path} must be a safe identifier token.`);
  }
  return stringValue;
}

function requireSafeArtifactToken(value: unknown, path: string): string {
  const stringValue = requireString(value, path);
  if (!SAFE_ARTIFACT_PATTERN.test(stringValue)) {
    throw new Error(`${path} must be a safe artifact token.`);
  }
  return stringValue;
}

function requireSafeIdArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value.map((entry, index) =>
    requireSafeId(entry, `${path}[${String(index)}]`),
  );
}

function requireSafeArtifactTokenArray(
  value: unknown,
  path: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value.map((entry, index) =>
    requireSafeArtifactToken(entry, `${path}[${String(index)}]`),
  );
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean.`);
  }
  return value;
}

function requireIsoInstant(value: unknown, path: string): string {
  const stringValue = requireString(value, path);
  if (!isIsoInstant(stringValue)) {
    throw new Error(`${path} must be a valid ISO-8601 UTC timestamp.`);
  }
  return stringValue;
}

function requireCliValue(
  argv: readonly string[],
  index: number,
  optionName: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function isIsoInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    return false;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return false;
  }
  const canonicalInput = value.includes('.')
    ? value
    : value.replace(/Z$/u, '.000Z');
  return date.toISOString() === canonicalInput;
}
