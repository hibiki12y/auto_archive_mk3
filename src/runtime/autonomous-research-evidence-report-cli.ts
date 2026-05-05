import { lstatSync, readFileSync } from 'node:fs';

import {
  AUTONOMOUS_RESEARCH_TRAIT_MODULE_ID,
  AUTONOMOUS_RESEARCH_TRAIT_PROFILES,
  type AutonomousResearchEvidenceCheckpointKind,
  type AutonomousResearchEvidenceCheckpointStatus,
  type AutonomousResearchTraitCriterion,
  type AutonomousResearchTraitProfileId,
  type AutonomousResearchTraitSourceMapId,
} from '../contracts/autonomous-research-trait.js';
import {
  createTerminalEvidence,
  type TerminalEvidence,
  type TerminalEvidenceInput,
} from '../contracts/terminal-evidence.js';
import { createRuntimeSettingsBundle } from '../contracts/runtime-settings.js';

const AUTONOMOUS_RESEARCH_CHECKPOINT_STEP =
  'autonomous-research.checkpoint';
const AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_SCHEMA_VERSION = 1;
const AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_RUBRIC_VERSION = 1;
const MINIMUM_RECOMMENDED_EVIDENCE_RECORDS = 1;

const AUTONOMOUS_RESEARCH_CHECKPOINT_KINDS = Object.freeze([
  'runtime-decoration-start',
  'runtime-decoration-complete',
  'runtime-decoration-error',
] as const) satisfies readonly AutonomousResearchEvidenceCheckpointKind[];

const AUTONOMOUS_RESEARCH_COMPLETION_STATUSES = Object.freeze([
  'delegate-returned',
  'delegate-threw',
] as const) satisfies readonly AutonomousResearchEvidenceCheckpointStatus[];

export const AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES =
  5 * 1024 * 1024;

export type AutonomousResearchEvidenceReportStatus =
  | 'complete'
  | 'delegate-error'
  | 'incomplete'
  | 'not-requested';

export type AutonomousResearchEvidenceTaskStatus =
  | 'complete'
  | 'delegate-error'
  | 'incomplete'
  | 'not-requested';

export interface AutonomousResearchEvidenceReportCheckpoint {
  readonly checkpoint: AutonomousResearchEvidenceCheckpointKind;
  readonly timestamp: string;
  readonly completionStatus?: AutonomousResearchEvidenceCheckpointStatus;
  readonly causeKind?: string;
}

export interface AutonomousResearchEvidenceReportTask {
  readonly taskId: string;
  readonly runtimeInstanceId: string;
  readonly terminalCauseKind: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly status: AutonomousResearchEvidenceTaskStatus;
  readonly checkpoints: readonly AutonomousResearchEvidenceReportCheckpoint[];
}

export interface AutonomousResearchEvidenceReportScorecard {
  readonly schemaVersion: typeof AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_SCHEMA_VERSION;
  readonly evidenceRecordCount: number;
  readonly autonomousTaskCount: number;
  readonly taskStatusCounts: Readonly<
    Record<AutonomousResearchEvidenceTaskStatus, number>
  >;
  readonly checkpointCounts: Readonly<
    Record<AutonomousResearchEvidenceCheckpointKind, number>
  >;
  readonly terminalCauseCounts: Readonly<Record<string, number>>;
  readonly criteriaCoverage: {
    readonly expected: readonly AutonomousResearchTraitCriterion[];
    readonly observed: readonly AutonomousResearchTraitCriterion[];
    readonly missing: readonly AutonomousResearchTraitCriterion[];
    readonly complete: boolean;
  };
  readonly sourceMapIds: readonly AutonomousResearchTraitSourceMapId[];
  readonly recency: {
    readonly firstCheckpointAt?: string;
    readonly lastCheckpointAt?: string;
  };
  readonly confidence: {
    readonly sampleSize: number;
    readonly minimumRecommendedEvidenceRecords: typeof MINIMUM_RECOMMENDED_EVIDENCE_RECORDS;
    readonly sufficientForCompletion: boolean;
    readonly summary: string;
  };
  readonly qualityScore: {
    readonly rubricVersion: typeof AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_RUBRIC_VERSION;
    readonly value: number;
    readonly max: 100;
    readonly summary: string;
  };
  readonly recommendations: readonly string[];
}

export interface AutonomousResearchEvidenceReport {
  readonly schemaVersion: typeof AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly status: AutonomousResearchEvidenceReportStatus;
  readonly method: {
    readonly primaryMetric: string;
    readonly guardrailMetrics: readonly string[];
    readonly requiredRuntimeStep: typeof AUTONOMOUS_RESEARCH_CHECKPOINT_STEP;
    readonly requiredTraitModuleId: typeof AUTONOMOUS_RESEARCH_TRAIT_MODULE_ID;
    readonly requiredProfileId: AutonomousResearchTraitProfileId;
    readonly scoringRubricVersion: typeof AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_RUBRIC_VERSION;
    readonly promotionRule: string;
  };
  readonly scorecard: AutonomousResearchEvidenceReportScorecard;
  readonly tasks: readonly AutonomousResearchEvidenceReportTask[];
  readonly boundary: {
    readonly readOnly: true;
    readonly runtimeDriverCalled: false;
    readonly delegateCalled: false;
    readonly providerSwitching: false;
    readonly sourceMutation: false;
  };
}

export interface BuildAutonomousResearchEvidenceReportInput {
  readonly evidence: readonly TerminalEvidence[];
  readonly generatedAt?: string;
}

export interface AutonomousResearchEvidenceReportCliIo {
  readonly stdout: {
    write(chunk: string): void;
  };
  readonly stderr: {
    write(chunk: string): void;
  };
}

export interface AutonomousResearchEvidenceReportCliOptions {
  readonly evidencePaths: readonly string[];
  readonly maxEvidenceBytes: number;
  readonly generatedAt?: string;
  readonly pretty: boolean;
  readonly printTemplate: boolean;
}

const USAGE = `Usage: pnpm autonomous:research:evidence:report -- --evidence <path> [options]
       pnpm autonomous:research:evidence:report -- --print-template [--generated-at <iso>] [--pretty]

Build a read-only autonomous-research TraitModule evidence report from one or
more TerminalEvidence JSON files. The report looks only at transcript
autonomous-research.checkpoint events and terminal causes.

Use --print-template to emit a valid, non-promoting TerminalEvidence skeleton
for operator-owned archive-loop evidence collection.

Options:
  --evidence <path>          Required TerminalEvidence JSON file path unless --print-template is set. May be repeated.
  --print-template           Print a non-promoting TerminalEvidence skeleton instead of reading evidence files.
  --max-evidence-bytes <n>   Fail closed before reading any file beyond this many bytes (default: ${String(AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES)}).
  --generated-at <iso>       Optional generatedAt timestamp to embed in the report.
  --pretty                   Pretty-print JSON output.
  --help                     Show this help text.

Boundary:
  This command is read-only. It does not run autonomous research, dispatch
  tasks, load TraitModule runtime code, call a RuntimeDriver/delegate, evaluate
  candidate variants, change providers, reload environment variables, contact
  Discord/GitLab/provider services, or mutate evidence files.
`;

interface ParsedCheckpointDetail {
  readonly checkpoint: AutonomousResearchEvidenceCheckpointKind;
  readonly completionStatus?: AutonomousResearchEvidenceCheckpointStatus;
  readonly causeKind?: string;
  readonly criteria: readonly AutonomousResearchTraitCriterion[];
  readonly sourceMapIds: readonly AutonomousResearchTraitSourceMapId[];
}

export function parseAutonomousResearchEvidenceReportCliArgs(
  argv: readonly string[],
): AutonomousResearchEvidenceReportCliOptions | 'help' {
  const evidencePaths: string[] = [];
  let maxEvidenceBytes =
    AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES;
  let generatedAt: string | undefined;
  let maxEvidenceBytesProvided = false;
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
      case '--evidence':
        evidencePaths.push(requireCliValue(argv, index, '--evidence'));
        index += 1;
        break;
      case '--generated-at':
        generatedAt = requireCliValue(argv, index, '--generated-at');
        if (!isIsoInstant(generatedAt)) {
          throw new Error('--generated-at must be a valid ISO-8601 UTC timestamp.');
        }
        index += 1;
        break;
      case '--max-evidence-bytes': {
        const rawMaxEvidenceBytes = requireCliValue(
          argv,
          index,
          '--max-evidence-bytes',
        );
        const parsedMaxEvidenceBytes = Number(rawMaxEvidenceBytes);
        if (
          !Number.isSafeInteger(parsedMaxEvidenceBytes) ||
          parsedMaxEvidenceBytes <= 0
        ) {
          throw new Error(
            '--max-evidence-bytes must be a positive safe integer.',
          );
        }
        maxEvidenceBytes = parsedMaxEvidenceBytes;
        maxEvidenceBytesProvided = true;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg ?? '(missing)'}.`);
    }
  }

  if (printTemplate && evidencePaths.length > 0) {
    throw new Error('--print-template cannot be combined with --evidence.');
  }
  if (printTemplate && maxEvidenceBytesProvided) {
    throw new Error('--print-template cannot be combined with --max-evidence-bytes.');
  }

  if (!printTemplate && evidencePaths.length === 0) {
    throw new Error('--evidence is required.');
  }

  return {
    evidencePaths,
    maxEvidenceBytes,
    ...(generatedAt === undefined ? {} : { generatedAt }),
    pretty,
    printTemplate,
  };
}

export function buildAutonomousResearchEvidenceTemplateFromCliOptions(
  options: Pick<AutonomousResearchEvidenceReportCliOptions, 'generatedAt'>,
): TerminalEvidence {
  const observedAt = options.generatedAt ?? new Date().toISOString();
  const taskId = 'task-autonomous-research-template';
  const runtimeInstanceId = 'runtime-autonomous-research-template';
  return createTerminalEvidence({
    taskId,
    runtimeInstanceId,
    reason:
      'template only: replace with retained TerminalEvidence from a real bounded autonomous-research run before live proof review',
    provenance: 'autonomous-research-evidence-template',
    executionContext: {
      planCreatedAt: observedAt,
      runtimeSettings: createRuntimeSettingsBundle({
        networkProfile: 'offline',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
      }),
      executionStartedAt: observedAt,
    },
    resourceEnvelope: {
      requested: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
      effective: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
    },
    transcript: {
      events: [],
      droppedCount: 0,
    },
    startedAt: observedAt,
    endedAt: observedAt,
    artifactLocation: 'replace-with-redacted-artifact-reference',
    cause: {
      kind: 'driver-failure',
      taskId,
      runtimeInstanceId,
      observedAt,
      provenance: 'autonomous-research-evidence-template',
      phase: 'template',
      message:
        'non-promoting template placeholder; replace with real terminal cause from retained evidence',
    },
  });
}

export function buildAutonomousResearchEvidenceReportFromCliOptions(
  options: AutonomousResearchEvidenceReportCliOptions,
): AutonomousResearchEvidenceReport {
  if (options.printTemplate) {
    throw new Error('Cannot build an autonomous-research evidence report from --print-template options.');
  }
  if (options.evidencePaths.length === 0) {
    throw new Error('--evidence is required.');
  }

  const evidence = options.evidencePaths.map((evidencePath) =>
    readTerminalEvidenceJsonFile(evidencePath, options.maxEvidenceBytes),
  );
  return buildAutonomousResearchEvidenceReport({
    evidence,
    ...(options.generatedAt === undefined
      ? {}
      : { generatedAt: options.generatedAt }),
  });
}

export function runAutonomousResearchEvidenceReportCli(
  argv: readonly string[],
  io: AutonomousResearchEvidenceReportCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  try {
    const options = parseAutonomousResearchEvidenceReportCliArgs(argv);
    if (options === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    const output = options.printTemplate
      ? buildAutonomousResearchEvidenceTemplateFromCliOptions(options)
      : buildAutonomousResearchEvidenceReportFromCliOptions(options);
    io.stdout.write(
      `${JSON.stringify(output, null, options.pretty ? 2 : undefined)}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(
      `autonomous:research:evidence:report failed: ${
        error instanceof Error ? error.message : String(error)
      }\n\n${USAGE}`,
    );
    return 1;
  }
}

export function buildAutonomousResearchEvidenceReport(
  input: BuildAutonomousResearchEvidenceReportInput,
): AutonomousResearchEvidenceReport {
  const expectedCriteria = AUTONOMOUS_RESEARCH_TRAIT_PROFILES[0].criteria;
  const expectedProfileId = AUTONOMOUS_RESEARCH_TRAIT_PROFILES[0].id;
  const taskStatusCounts = {
    complete: 0,
    'delegate-error': 0,
    incomplete: 0,
    'not-requested': 0,
  } satisfies Record<AutonomousResearchEvidenceTaskStatus, number>;
  const checkpointCounts = {
    'runtime-decoration-start': 0,
    'runtime-decoration-complete': 0,
    'runtime-decoration-error': 0,
  } satisfies Record<AutonomousResearchEvidenceCheckpointKind, number>;
  const terminalCauseCounts: Record<string, number> = {};
  const observedCriteria = new Set<AutonomousResearchTraitCriterion>();
  const sourceMapIds = new Set<AutonomousResearchTraitSourceMapId>();
  const checkpointTimestamps: string[] = [];

  const tasks = input.evidence.map((evidence) => {
    terminalCauseCounts[evidence.cause.kind] =
      (terminalCauseCounts[evidence.cause.kind] ?? 0) + 1;
    const checkpoints = extractAutonomousResearchCheckpoints(evidence);
    for (const checkpoint of checkpoints) {
      checkpointCounts[checkpoint.checkpoint] += 1;
      checkpointTimestamps.push(checkpoint.timestamp);
    }
    for (const event of extractParsedCheckpointDetails(evidence)) {
      for (const criterion of event.criteria) {
        observedCriteria.add(criterion);
      }
      for (const sourceMapId of event.sourceMapIds) {
        sourceMapIds.add(sourceMapId);
      }
    }

    const status = classifyTaskStatus(evidence, checkpoints);
    taskStatusCounts[status] += 1;
    return {
      taskId: evidence.taskId,
      runtimeInstanceId: evidence.runtimeInstanceId,
      terminalCauseKind: evidence.cause.kind,
      startedAt: evidence.startedAt,
      endedAt: evidence.endedAt,
      status,
      checkpoints,
    };
  });

  const autonomousTaskCount =
    taskStatusCounts.complete +
    taskStatusCounts['delegate-error'] +
    taskStatusCounts.incomplete;
  const observedCriteriaList = [...observedCriteria].sort();
  const missingCriteria = expectedCriteria.filter(
    (criterion) => !observedCriteria.has(criterion),
  );
  const criteriaComplete = missingCriteria.length === 0;
  const status = classifyReportStatus(
    autonomousTaskCount,
    taskStatusCounts,
    criteriaComplete,
  );
  const sufficientForCompletion = status === 'complete';
  const qualityScore = scoreAutonomousResearchEvidence({
    autonomousTaskCount,
    taskStatusCounts,
    checkpointCounts,
    criteriaComplete,
  });

  return {
    schemaVersion: AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status,
    method: {
      primaryMetric:
        'autonomous research task has start+complete checkpoints and terminal success',
      guardrailMetrics: [
        'delegate error checkpoints',
        'missing DGM bounded-archive criteria',
        'non-success terminal causes',
        'not-requested terminal evidence',
      ],
      requiredRuntimeStep: AUTONOMOUS_RESEARCH_CHECKPOINT_STEP,
      requiredTraitModuleId: AUTONOMOUS_RESEARCH_TRAIT_MODULE_ID,
      requiredProfileId: expectedProfileId,
      scoringRubricVersion: AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_RUBRIC_VERSION,
      promotionRule:
        'Promote the archive-loop evidence only when at least one autonomous task completed with terminal success and all bounded-archive criteria were observed.',
    },
    scorecard: {
      schemaVersion: AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_SCHEMA_VERSION,
      evidenceRecordCount: input.evidence.length,
      autonomousTaskCount,
      taskStatusCounts,
      checkpointCounts,
      terminalCauseCounts,
      criteriaCoverage: {
        expected: expectedCriteria,
        observed: observedCriteriaList,
        missing: missingCriteria,
        complete: criteriaComplete,
      },
      sourceMapIds: [...sourceMapIds].sort(),
      recency: {
        ...minMaxIso(checkpointTimestamps),
      },
      confidence: {
        sampleSize: autonomousTaskCount,
        minimumRecommendedEvidenceRecords: MINIMUM_RECOMMENDED_EVIDENCE_RECORDS,
        sufficientForCompletion,
        summary: sufficientForCompletion
          ? 'autonomous-research archive-loop evidence is sufficient for this bounded sample'
          : 'autonomous-research archive-loop evidence is not yet sufficient for completion',
      },
      qualityScore: {
        rubricVersion: AUTONOMOUS_RESEARCH_EVIDENCE_REPORT_RUBRIC_VERSION,
        value: qualityScore,
        max: 100,
        summary: `${String(qualityScore)}/100 bounded archive-loop evidence score`,
      },
      recommendations: buildAutonomousResearchRecommendations({
        status,
        taskStatusCounts,
        checkpointCounts,
        missingCriteria,
      }),
    },
    tasks,
    boundary: {
      readOnly: true,
      runtimeDriverCalled: false,
      delegateCalled: false,
      providerSwitching: false,
      sourceMutation: false,
    },
  };
}

function extractAutonomousResearchCheckpoints(
  evidence: TerminalEvidence,
): AutonomousResearchEvidenceReportCheckpoint[] {
  const checkpoints: AutonomousResearchEvidenceReportCheckpoint[] = [];
  for (const event of evidence.transcript?.events ?? []) {
    if (
      event.kind !== 'agent-step' ||
      event.step !== AUTONOMOUS_RESEARCH_CHECKPOINT_STEP
    ) {
      continue;
    }
    const parsed = parseAutonomousResearchCheckpointDetail(event.detail);
    if (parsed === undefined) {
      continue;
    }
    checkpoints.push({
      checkpoint: parsed.checkpoint,
      timestamp: event.timestamp,
      ...(parsed.completionStatus === undefined
        ? {}
        : { completionStatus: parsed.completionStatus }),
      ...(parsed.causeKind === undefined ? {} : { causeKind: parsed.causeKind }),
    });
  }
  return checkpoints;
}

function extractParsedCheckpointDetails(
  evidence: TerminalEvidence,
): ParsedCheckpointDetail[] {
  return (evidence.transcript?.events ?? []).flatMap((event) => {
    if (
      event.kind !== 'agent-step' ||
      event.step !== AUTONOMOUS_RESEARCH_CHECKPOINT_STEP
    ) {
      return [];
    }
    const parsed = parseAutonomousResearchCheckpointDetail(event.detail);
    return parsed === undefined ? [] : [parsed];
  });
}

function parseAutonomousResearchCheckpointDetail(
  detail: string | undefined,
): ParsedCheckpointDetail | undefined {
  if (detail === undefined || detail.trim().length === 0) {
    return undefined;
  }
  const fields = new Map<string, string>();
  for (const segment of detail.split(' | ')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    fields.set(segment.slice(0, separator), segment.slice(separator + 1));
  }
  const checkpoint = fields.get('checkpoint');
  if (!isCheckpointKind(checkpoint)) {
    return undefined;
  }
  const trait = fields.get('trait');
  if (trait !== 'autonomous-research-goal-loop') {
    return undefined;
  }
  const profile = fields.get('profile');
  if (profile !== AUTONOMOUS_RESEARCH_TRAIT_PROFILES[0].id) {
    return undefined;
  }

  const completionStatus = fields.get('completionStatus');
  const parsedCompletionStatus = isCompletionStatus(completionStatus)
    ? completionStatus
    : undefined;
  return {
    checkpoint,
    ...(parsedCompletionStatus === undefined
      ? {}
      : { completionStatus: parsedCompletionStatus }),
    ...(fields.get('causeKind') === undefined
      ? {}
      : { causeKind: fields.get('causeKind') as string }),
    criteria: parseKnownList(
      fields.get('criteria'),
      isAutonomousResearchTraitCriterion,
    ),
    sourceMapIds: parseKnownList(
      fields.get('sources'),
      isAutonomousResearchTraitSourceMapId,
    ),
  };
}

function classifyTaskStatus(
  evidence: TerminalEvidence,
  checkpoints: readonly AutonomousResearchEvidenceReportCheckpoint[],
): AutonomousResearchEvidenceTaskStatus {
  if (checkpoints.length === 0) {
    return 'not-requested';
  }
  if (
    checkpoints.some(
      (checkpoint) => checkpoint.checkpoint === 'runtime-decoration-error',
    )
  ) {
    return 'delegate-error';
  }
  const hasStart = checkpoints.some(
    (checkpoint) => checkpoint.checkpoint === 'runtime-decoration-start',
  );
  const hasComplete = checkpoints.some(
    (checkpoint) =>
      checkpoint.checkpoint === 'runtime-decoration-complete' &&
      checkpoint.completionStatus === 'delegate-returned',
  );
  if (hasStart && hasComplete && evidence.cause.kind === 'success') {
    return 'complete';
  }
  return 'incomplete';
}

function classifyReportStatus(
  autonomousTaskCount: number,
  taskStatusCounts: Readonly<Record<AutonomousResearchEvidenceTaskStatus, number>>,
  criteriaComplete: boolean,
): AutonomousResearchEvidenceReportStatus {
  if (autonomousTaskCount === 0) {
    return 'not-requested';
  }
  if (taskStatusCounts['delegate-error'] > 0) {
    return 'delegate-error';
  }
  if (
    taskStatusCounts.complete === autonomousTaskCount &&
    criteriaComplete
  ) {
    return 'complete';
  }
  return 'incomplete';
}

function scoreAutonomousResearchEvidence(input: {
  readonly autonomousTaskCount: number;
  readonly taskStatusCounts: Readonly<
    Record<AutonomousResearchEvidenceTaskStatus, number>
  >;
  readonly checkpointCounts: Readonly<
    Record<AutonomousResearchEvidenceCheckpointKind, number>
  >;
  readonly criteriaComplete: boolean;
}): number {
  if (input.autonomousTaskCount === 0) {
    return 0;
  }
  const taskCompletionScore =
    (input.taskStatusCounts.complete / input.autonomousTaskCount) * 45;
  const checkpointScore =
    input.checkpointCounts['runtime-decoration-start'] > 0 &&
    input.checkpointCounts['runtime-decoration-complete'] > 0
      ? 25
      : 0;
  const criteriaScore = input.criteriaComplete ? 20 : 0;
  const errorPenalty =
    input.taskStatusCounts['delegate-error'] > 0 ? 20 : 0;
  const notRequestedPenalty =
    input.taskStatusCounts['not-requested'] > 0 ? 5 : 0;
  return Math.max(
    0,
    Math.round(
      taskCompletionScore +
        checkpointScore +
        criteriaScore +
        10 -
        errorPenalty -
        notRequestedPenalty,
    ),
  );
}

function buildAutonomousResearchRecommendations(input: {
  readonly status: AutonomousResearchEvidenceReportStatus;
  readonly taskStatusCounts: Readonly<
    Record<AutonomousResearchEvidenceTaskStatus, number>
  >;
  readonly checkpointCounts: Readonly<
    Record<AutonomousResearchEvidenceCheckpointKind, number>
  >;
  readonly missingCriteria: readonly AutonomousResearchTraitCriterion[];
}): readonly string[] {
  if (input.status === 'complete') {
    return [];
  }
  if (input.status === 'not-requested') {
    return [
      'Enable AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION=bounded-evidence for a bounded research task before promoting archive-loop completion.',
    ];
  }
  const recommendations: string[] = [];
  if (input.taskStatusCounts['delegate-error'] > 0) {
    recommendations.push(
      'Inspect delegate-threw autonomous-research checkpoints and terminal failure evidence before retrying the archive-loop task.',
    );
  }
  if (
    input.checkpointCounts['runtime-decoration-start'] === 0 ||
    input.checkpointCounts['runtime-decoration-complete'] === 0
  ) {
    recommendations.push(
      'Require both runtime-decoration-start and runtime-decoration-complete checkpoints in terminal evidence.',
    );
  }
  if (input.missingCriteria.length > 0) {
    recommendations.push(
      `Cover ${String(input.missingCriteria.length)} missing bounded-archive criterion/criteria before completion: ${input.missingCriteria.join(', ')}.`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      'Review terminal cause and checkpoint ordering before promoting autonomous-research archive-loop evidence.',
    );
  }
  return recommendations;
}

function readTerminalEvidenceJsonFile(
  evidencePath: string,
  maxEvidenceBytes: number,
): TerminalEvidence {
  let evidenceStat;
  try {
    evidenceStat = lstatSync(evidencePath);
  } catch (error) {
    throw new Error(`--evidence path does not exist: ${evidencePath}`, {
      cause: error,
    });
  }
  if (!evidenceStat.isFile()) {
    throw new Error(
      `--evidence path is not a regular file: ${evidencePath}`,
    );
  }
  if (evidenceStat.size > maxEvidenceBytes) {
    throw new Error(
      `--evidence file exceeds --max-evidence-bytes (${evidenceStat.size} > ${maxEvidenceBytes}).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(evidencePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `TerminalEvidence file must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }.`,
      { cause: error },
    );
  }
  return createTerminalEvidence(parsed as TerminalEvidenceInput);
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

function isCheckpointKind(
  value: string | undefined,
): value is AutonomousResearchEvidenceCheckpointKind {
  return (
    value !== undefined &&
    (AUTONOMOUS_RESEARCH_CHECKPOINT_KINDS as readonly string[]).includes(value)
  );
}

function isCompletionStatus(
  value: string | undefined,
): value is AutonomousResearchEvidenceCheckpointStatus {
  return (
    value !== undefined &&
    (AUTONOMOUS_RESEARCH_COMPLETION_STATUSES as readonly string[]).includes(
      value,
    )
  );
}

function isAutonomousResearchTraitCriterion(
  value: string,
): value is AutonomousResearchTraitCriterion {
  return (
    AUTONOMOUS_RESEARCH_TRAIT_PROFILES[0].criteria as readonly string[]
  ).includes(value);
}

function isAutonomousResearchTraitSourceMapId(
  value: string,
): value is AutonomousResearchTraitSourceMapId {
  return (
    AUTONOMOUS_RESEARCH_TRAIT_PROFILES[0].sourceMapIds as readonly string[]
  ).includes(value);
}

function parseKnownList<T extends string>(
  value: string | undefined,
  guard: (item: string) => item is T,
): readonly T[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  return value.split(',').filter(guard);
}

function minMaxIso(values: readonly string[]): {
  readonly firstCheckpointAt?: string;
  readonly lastCheckpointAt?: string;
} {
  if (values.length === 0) {
    return {};
  }
  const sorted = [...values].sort();
  return {
    firstCheckpointAt: sorted[0],
    lastCheckpointAt: sorted[sorted.length - 1],
  };
}
