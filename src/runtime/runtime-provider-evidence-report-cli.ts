import { lstatSync, readFileSync } from 'node:fs';

import {
  projectContextBudgetSnapshot,
  type ContextBudgetSnapshot,
} from '../contracts/context-budget-snapshot.js';
import {
  createTerminalEvidence,
  type TerminalEvidence,
  type TerminalEvidenceInput,
} from '../contracts/terminal-evidence.js';
import { createRuntimeSettingsBundle } from '../contracts/runtime-settings.js';
import type { ProviderFailureClassification } from '../contracts/terminal-cause.js';

export const RUNTIME_PROVIDER_EVIDENCE_REPORT_SCHEMA_VERSION = 1;
export const RUNTIME_PROVIDER_EVIDENCE_REPORT_RUBRIC_VERSION = 1;
export const RUNTIME_PROVIDER_EVIDENCE_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES =
  5 * 1024 * 1024;

export const RUNTIME_PROVIDER_EVIDENCE_PROVIDERS = Object.freeze([
  'codex',
  'claude-agent',
] as const);

const PROVIDER_TO_DRIVER_PROVENANCE = Object.freeze({
  codex: 'codex-runtime-driver',
  'claude-agent': 'claude-agent-runtime-driver',
} as const);

const PROVIDER_FAILURE_PROVIDER_TO_RUNTIME_PROVIDER = Object.freeze({
  codex: 'codex',
  anthropic: 'claude-agent',
} as const);

export type RuntimeProviderEvidenceProvider =
  (typeof RUNTIME_PROVIDER_EVIDENCE_PROVIDERS)[number];

export type RuntimeProviderEvidenceObservedProvider =
  | RuntimeProviderEvidenceProvider
  | 'mixed'
  | 'unknown';

export type RuntimeProviderEvidenceRecordStatus =
  | 'complete'
  | 'non-success'
  | 'provider-mismatch'
  | 'missing-provider-provenance';

export type RuntimeProviderEvidenceReportStatus =
  | 'complete'
  | 'warn'
  | 'fail'
  | 'no-record';

export interface RuntimeProviderEvidenceUsageSummary {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface RuntimeProviderEvidenceAssessment {
  readonly evidenceIndex: number;
  readonly provider: RuntimeProviderEvidenceObservedProvider;
  readonly status: RuntimeProviderEvidenceRecordStatus;
  readonly terminalCauseKind: string;
  readonly providerFailureClassification?: ProviderFailureClassification;
  readonly providerFailureRetryable?: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly driverProvenanceSignal:
    | 'matched'
    | 'missing'
    | 'mixed'
    | 'filtered-out';
  readonly runtimeSettingsPresent: boolean;
  readonly resourceEnvelopePresent: boolean;
  readonly transcriptEventCount: number;
  readonly turnCompletedEventCount: number;
  readonly itemCompletedEventCount: number;
  readonly itemFailedEventCount: number;
  readonly approvalRequestedEventCount: number;
  readonly usage: RuntimeProviderEvidenceUsageSummary;
  readonly contextBudget: ContextBudgetSnapshot;
}

export interface RuntimeProviderEvidenceReportScorecard {
  readonly schemaVersion: typeof RUNTIME_PROVIDER_EVIDENCE_REPORT_SCHEMA_VERSION;
  readonly evidenceRecordCount: number;
  readonly selectedProviderRecordCount: number;
  readonly successfulProviderRecordCount: number;
  readonly failedProviderRecordCount: number;
  readonly providerProvenanceMatchedCount: number;
  readonly runtimeSettingsRecordCount: number;
  readonly resourceEnvelopeRecordCount: number;
  readonly transcriptEventCount: number;
  readonly usage: RuntimeProviderEvidenceUsageSummary;
  readonly contextBudget: ContextBudgetSnapshot;
  readonly providerCounts: Readonly<
    Record<RuntimeProviderEvidenceObservedProvider, number>
  >;
  readonly terminalCauseCounts: Readonly<Record<string, number>>;
  readonly providerFailureClassifications: Readonly<
    Partial<Record<ProviderFailureClassification, number>>
  >;
  readonly recency: {
    readonly firstEndedAt?: string;
    readonly lastEndedAt?: string;
  };
  readonly confidence: {
    readonly sampleSize: number;
    readonly minimumRecommendedEvidenceRecords: 1;
    readonly sufficientForProviderProof: boolean;
    readonly summary: string;
  };
  readonly qualityScore: {
    readonly rubricVersion: typeof RUNTIME_PROVIDER_EVIDENCE_REPORT_RUBRIC_VERSION;
    readonly value: number;
    readonly max: 100;
    readonly summary: string;
  };
  readonly recommendations: readonly string[];
}

export interface RuntimeProviderEvidenceReport {
  readonly schemaVersion: typeof RUNTIME_PROVIDER_EVIDENCE_REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly status: RuntimeProviderEvidenceReportStatus;
  readonly filter: {
    readonly providers: readonly RuntimeProviderEvidenceProvider[];
  };
  readonly method: {
    readonly primaryMetric: string;
    readonly guardrailMetrics: readonly string[];
    readonly scoringRubricVersion: typeof RUNTIME_PROVIDER_EVIDENCE_REPORT_RUBRIC_VERSION;
    readonly promotionRule: string;
  };
  readonly scorecard: RuntimeProviderEvidenceReportScorecard;
  readonly evidence: readonly RuntimeProviderEvidenceAssessment[];
  readonly boundary: {
    readonly readOnly: true;
    readonly runtimeDriverCalled: false;
    readonly providerContacted: false;
    readonly evidenceFilesMutated: false;
    readonly environmentVariablesRead: false;
    readonly rawTaskIdsRendered: false;
    readonly rawRuntimeInstanceIdsRendered: false;
    readonly rawReasonsRendered: false;
    readonly rawTranscriptRendered: false;
  };
}

export interface BuildRuntimeProviderEvidenceReportInput {
  readonly evidence: readonly TerminalEvidence[];
  readonly providers?: readonly RuntimeProviderEvidenceProvider[];
  readonly estimatedContextWindowTokens?: number;
  readonly generatedAt?: string;
}

export interface RuntimeProviderEvidenceReportCliIo {
  readonly stdout: {
    write(chunk: string): void;
  };
  readonly stderr: {
    write(chunk: string): void;
  };
}

export interface RuntimeProviderEvidenceReportCliOptions {
  readonly evidencePaths: readonly string[];
  readonly providers: readonly RuntimeProviderEvidenceProvider[];
  readonly maxEvidenceBytes: number;
  readonly estimatedContextWindowTokens?: number;
  readonly generatedAt?: string;
  readonly pretty: boolean;
  readonly printTemplate: boolean;
}

const USAGE = `Usage: pnpm runtime:provider:evidence:report -- --evidence <path> [options]
       pnpm runtime:provider:evidence:report -- --print-template [--provider <provider>] [--generated-at <iso>] [--pretty]

Build a read-only provider-runtime scorecard from one or more TerminalEvidence
JSON files. The report verifies retained terminal evidence for the selected
runtime provider without running providers or rendering raw task content.

Use --print-template to emit a valid, non-promoting TerminalEvidence skeleton
for operator-owned provider proof collection. Template mode defaults to the
codex provider and accepts at most one --provider.

Options:
  --evidence <path>          Required TerminalEvidence JSON file path. May be repeated.
  --print-template           Print a non-promoting TerminalEvidence skeleton instead of reading evidence files.
  --provider <provider>      Optional provider filter: codex or claude-agent. May be repeated (default: both).
  --max-evidence-bytes <n>   Fail closed before reading any file beyond this many bytes (default: ${String(RUNTIME_PROVIDER_EVIDENCE_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES)}).
  --estimated-context-window-tokens <n>
                             Optional operator-supplied context window used only for estimated context-fill pressure.
  --generated-at <iso>       Optional generatedAt timestamp to embed in the report.
  --pretty                   Pretty-print JSON output.
  --help                     Show this help text.

Boundary:
  This command is read-only. It does not instantiate RuntimeDrivers, call Codex,
  call Claude Agent, switch providers, read environment variables, mutate
  evidence files, render raw task ids, render raw runtime instance ids, render
  raw terminal reasons, or render raw transcript content. Input files must be
  operator-owned retained TerminalEvidence JSON artifacts.
`;

export function parseRuntimeProviderEvidenceReportCliArgs(
  argv: readonly string[],
): RuntimeProviderEvidenceReportCliOptions | 'help' {
  const evidencePaths: string[] = [];
  const providers: RuntimeProviderEvidenceProvider[] = [];
  let maxEvidenceBytes =
    RUNTIME_PROVIDER_EVIDENCE_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES;
  let estimatedContextWindowTokens: number | undefined;
  let estimatedContextWindowTokensProvided = false;
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
      case '--provider':
        providers.push(
          parseRuntimeProviderEvidenceProvider(
            requireCliValue(argv, index, '--provider'),
          ),
        );
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
      case '--estimated-context-window-tokens': {
        const rawEstimatedContextWindowTokens = requireCliValue(
          argv,
          index,
          '--estimated-context-window-tokens',
        );
        const parsedEstimatedContextWindowTokens = Number(
          rawEstimatedContextWindowTokens,
        );
        if (
          !Number.isSafeInteger(parsedEstimatedContextWindowTokens) ||
          parsedEstimatedContextWindowTokens <= 0
        ) {
          throw new Error(
            '--estimated-context-window-tokens must be a positive safe integer.',
          );
        }
        estimatedContextWindowTokens = parsedEstimatedContextWindowTokens;
        estimatedContextWindowTokensProvided = true;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg ?? '(missing)'}.`);
    }
  }

  const uniqueProviderFilters = uniqueProviders(providers);
  if (printTemplate && evidencePaths.length > 0) {
    throw new Error('--print-template cannot be combined with --evidence.');
  }
  if (printTemplate && maxEvidenceBytesProvided) {
    throw new Error('--print-template cannot be combined with --max-evidence-bytes.');
  }
  if (printTemplate && estimatedContextWindowTokensProvided) {
    throw new Error(
      '--print-template cannot be combined with --estimated-context-window-tokens.',
    );
  }
  if (printTemplate && uniqueProviderFilters.length > 1) {
    throw new Error('--print-template accepts at most one --provider.');
  }

  if (!printTemplate && evidencePaths.length === 0) {
    throw new Error('--evidence is required.');
  }

  return {
    evidencePaths,
    providers: uniqueProviderFilters,
    maxEvidenceBytes,
    ...(estimatedContextWindowTokens === undefined
      ? {}
      : { estimatedContextWindowTokens }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
    pretty,
    printTemplate,
  };
}

export function buildRuntimeProviderEvidenceReportFromCliOptions(
  options: RuntimeProviderEvidenceReportCliOptions,
): RuntimeProviderEvidenceReport {
  if (options.printTemplate) {
    throw new Error('Cannot build a runtime-provider evidence report from --print-template options.');
  }
  if (options.evidencePaths.length === 0) {
    throw new Error('--evidence is required.');
  }

  const evidence = options.evidencePaths.map((evidencePath) =>
    readTerminalEvidenceJsonFile(evidencePath, options.maxEvidenceBytes),
  );
  return buildRuntimeProviderEvidenceReport({
    evidence,
    providers: options.providers,
    ...(options.estimatedContextWindowTokens === undefined
      ? {}
      : { estimatedContextWindowTokens: options.estimatedContextWindowTokens }),
    ...(options.generatedAt === undefined
      ? {}
      : { generatedAt: options.generatedAt }),
  });
}

export function buildRuntimeProviderEvidenceTemplateFromCliOptions(
  options: Pick<RuntimeProviderEvidenceReportCliOptions, 'providers' | 'generatedAt'>,
): TerminalEvidence {
  if (options.providers.length > 1) {
    throw new Error('--print-template accepts at most one --provider.');
  }
  const provider = options.providers[0] ?? 'codex';
  const observedAt = options.generatedAt ?? new Date().toISOString();
  const provenance = PROVIDER_TO_DRIVER_PROVENANCE[provider];
  const taskId = `task-runtime-provider-${provider}-template`;
  const runtimeInstanceId = `runtime-provider-${provider}-template`;
  return createTerminalEvidence({
    taskId,
    runtimeInstanceId,
    reason:
      'template only: replace with retained TerminalEvidence from an authenticated provider run before live proof review',
    provenance,
    executionContext: {
      planCreatedAt: observedAt,
      runtimeSettings: createRuntimeSettingsBundle({
        networkProfile: 'provider-only',
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
    artifactLocation: 'replace-with-redacted-provider-artifact-reference',
    cause: {
      kind: 'driver-failure',
      taskId,
      runtimeInstanceId,
      observedAt,
      provenance,
      phase: 'template',
      message:
        'non-promoting runtime-provider evidence template placeholder; replace with real terminal cause from retained evidence',
    },
  });
}

export function runRuntimeProviderEvidenceReportCli(
  argv: readonly string[],
  io: RuntimeProviderEvidenceReportCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  try {
    const options = parseRuntimeProviderEvidenceReportCliArgs(argv);
    if (options === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    const output = options.printTemplate
      ? buildRuntimeProviderEvidenceTemplateFromCliOptions(options)
      : buildRuntimeProviderEvidenceReportFromCliOptions(options);
    io.stdout.write(
      `${JSON.stringify(output, null, options.pretty ? 2 : undefined)}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(
      `runtime:provider:evidence:report failed: ${
        error instanceof Error ? error.message : String(error)
      }\n\n${USAGE}`,
    );
    return 1;
  }
}

export function buildRuntimeProviderEvidenceReport(
  input: BuildRuntimeProviderEvidenceReportInput,
): RuntimeProviderEvidenceReport {
  const providerFilter = uniqueProviders([...(input.providers ?? [])]);
  const requestedProviders =
    providerFilter.length === 0
      ? RUNTIME_PROVIDER_EVIDENCE_PROVIDERS
      : providerFilter;
  const requestedProviderSet = new Set<RuntimeProviderEvidenceProvider>(
    requestedProviders,
  );
  const providerCounts = {
    codex: 0,
    'claude-agent': 0,
    mixed: 0,
    unknown: 0,
  } satisfies Record<RuntimeProviderEvidenceObservedProvider, number>;
  const terminalCauseCounts: Record<string, number> = {};
  const providerFailureClassifications: Partial<
    Record<ProviderFailureClassification, number>
  > = {};

  const allEvidence = input.evidence.map((item, index) => {
    const assessment = assessRuntimeProviderEvidence(
      item,
      index,
      requestedProviderSet,
      input.estimatedContextWindowTokens,
    );
    providerCounts[assessment.provider] += 1;
    terminalCauseCounts[assessment.terminalCauseKind] =
      (terminalCauseCounts[assessment.terminalCauseKind] ?? 0) + 1;
    if (assessment.providerFailureClassification !== undefined) {
      providerFailureClassifications[assessment.providerFailureClassification] =
        (providerFailureClassifications[
          assessment.providerFailureClassification
        ] ?? 0) + 1;
    }
    return assessment;
  });

  const selectedEvidence = allEvidence.filter(
    (item) =>
      item.provider !== 'mixed' &&
      item.provider !== 'unknown' &&
      requestedProviderSet.has(item.provider),
  );
  const successfulProviderRecordCount = selectedEvidence.filter(
    (item) => item.status === 'complete',
  ).length;
  const failedProviderRecordCount = selectedEvidence.filter(
    (item) => item.terminalCauseKind !== 'success',
  ).length;
  const providerProvenanceMatchedCount = selectedEvidence.filter(
    (item) => item.driverProvenanceSignal === 'matched',
  ).length;
  const runtimeSettingsRecordCount = selectedEvidence.filter(
    (item) => item.runtimeSettingsPresent,
  ).length;
  const resourceEnvelopeRecordCount = selectedEvidence.filter(
    (item) => item.resourceEnvelopePresent,
  ).length;
  const transcriptEventCount = selectedEvidence.reduce(
    (sum, item) => sum + item.transcriptEventCount,
    0,
  );
  const usage = sumUsage(selectedEvidence.map((item) => item.usage));
  const contextBudget = projectContextBudgetSnapshot({
    tokenUsage: usage,
    tokenUsageObserved: selectedEvidence.some(
      (item) => item.contextBudget.tokenUsage.provenance === 'provider-reported',
    ),
    ...(input.estimatedContextWindowTokens === undefined
      ? {}
      : { estimatedContextWindowTokens: input.estimatedContextWindowTokens }),
  });
  const status = classifyRuntimeProviderEvidenceReportStatus({
    selectedProviderRecordCount: selectedEvidence.length,
    successfulProviderRecordCount,
    failedProviderRecordCount,
    providerProvenanceMatchedCount,
    runtimeSettingsRecordCount,
  });
  const qualityScore = scoreRuntimeProviderEvidence({
    selectedProviderRecordCount: selectedEvidence.length,
    successfulProviderRecordCount,
    providerProvenanceMatchedCount,
    runtimeSettingsRecordCount,
    resourceEnvelopeRecordCount,
    telemetryRecordCount: selectedEvidence.filter(
      (item) => item.transcriptEventCount > 0 || item.usage.totalTokens > 0,
    ).length,
  });
  const recency = minMaxIso(selectedEvidence.map((item) => item.endedAt));

  return {
    schemaVersion: RUNTIME_PROVIDER_EVIDENCE_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status,
    filter: {
      providers: requestedProviders,
    },
    method: {
      primaryMetric:
        'retained TerminalEvidence has terminal success and canonical runtime-driver provenance for the selected provider',
      guardrailMetrics: [
        'provider mismatch or mixed provenance',
        'non-success terminal causes',
        'missing runtime settings or resource envelope snapshots',
        'missing transcript/usage metadata',
        'raw task ids, raw reasons, and raw transcript content are not rendered',
      ],
      scoringRubricVersion: RUNTIME_PROVIDER_EVIDENCE_REPORT_RUBRIC_VERSION,
      promotionRule:
        'Promote provider live-proof evidence only when at least one selected-provider record is terminal success, every selected-provider record has matching driver provenance, and runtime settings/resource snapshots are retained.',
    },
    scorecard: {
      schemaVersion: RUNTIME_PROVIDER_EVIDENCE_REPORT_SCHEMA_VERSION,
      evidenceRecordCount: input.evidence.length,
      selectedProviderRecordCount: selectedEvidence.length,
      successfulProviderRecordCount,
      failedProviderRecordCount,
      providerProvenanceMatchedCount,
      runtimeSettingsRecordCount,
      resourceEnvelopeRecordCount,
      transcriptEventCount,
      usage,
      contextBudget,
      providerCounts,
      terminalCauseCounts,
      providerFailureClassifications,
      recency,
      confidence: {
        sampleSize: selectedEvidence.length,
        minimumRecommendedEvidenceRecords: 1,
        sufficientForProviderProof: status === 'complete',
        summary:
          status === 'complete'
            ? 'runtime provider evidence is sufficient for this retained sample'
            : 'runtime provider evidence is not yet sufficient for live-proof promotion',
      },
      qualityScore: {
        rubricVersion: RUNTIME_PROVIDER_EVIDENCE_REPORT_RUBRIC_VERSION,
        value: qualityScore,
        max: 100,
        summary: `${String(qualityScore)}/100 provider terminal evidence score`,
      },
      recommendations: buildRuntimeProviderEvidenceRecommendations({
        requestedProviders,
        status,
        selectedProviderRecordCount: selectedEvidence.length,
        successfulProviderRecordCount,
        failedProviderRecordCount,
        providerProvenanceMatchedCount,
        runtimeSettingsRecordCount,
        resourceEnvelopeRecordCount,
        transcriptEventCount,
        usageTotalTokens: usage.totalTokens,
        mixedProviderCount: providerCounts.mixed,
        unknownProviderCount: providerCounts.unknown,
      }),
    },
    evidence: allEvidence,
    boundary: {
      readOnly: true,
      runtimeDriverCalled: false,
      providerContacted: false,
      evidenceFilesMutated: false,
      environmentVariablesRead: false,
      rawTaskIdsRendered: false,
      rawRuntimeInstanceIdsRendered: false,
      rawReasonsRendered: false,
      rawTranscriptRendered: false,
    },
  };
}

function assessRuntimeProviderEvidence(
  evidence: TerminalEvidence,
  evidenceIndex: number,
  requestedProviders: ReadonlySet<RuntimeProviderEvidenceProvider>,
  estimatedContextWindowTokens: number | undefined,
): RuntimeProviderEvidenceAssessment {
  const provider = detectRuntimeProvider(evidence);
  const transcriptEvents = evidence.transcript?.events ?? [];
  const usageRecords = transcriptEvents.flatMap((event) =>
    event.kind === 'turn.completed' && event.usage !== undefined
      ? [
          {
            inputTokens: event.usage.inputTokens,
            cachedInputTokens: event.usage.cachedInputTokens,
            outputTokens: event.usage.outputTokens,
            totalTokens:
              event.usage.inputTokens +
              event.usage.cachedInputTokens +
              event.usage.outputTokens,
          },
        ]
      : [],
  );
  const usage = sumUsage(usageRecords);
  const contextBudget = projectContextBudgetSnapshot({
    tokenUsage: usage,
    tokenUsageObserved: usageRecords.length > 0,
    ...(estimatedContextWindowTokens === undefined
      ? {}
      : { estimatedContextWindowTokens }),
  });
  const selected =
    provider !== 'mixed' &&
    provider !== 'unknown' &&
    requestedProviders.has(provider);
  const driverProvenanceSignal = selected
    ? hasCanonicalDriverProvenance(evidence, provider)
      ? 'matched'
      : 'missing'
    : provider === 'mixed'
      ? 'mixed'
      : 'filtered-out';
  const status: RuntimeProviderEvidenceRecordStatus = !selected
    ? 'provider-mismatch'
    : driverProvenanceSignal !== 'matched'
      ? 'missing-provider-provenance'
      : evidence.cause.kind === 'success'
        ? 'complete'
        : 'non-success';

  return {
    evidenceIndex,
    provider,
    status,
    terminalCauseKind: evidence.cause.kind,
    ...(evidence.cause.kind === 'provider-failure'
      ? {
          providerFailureClassification: evidence.cause.classification,
          providerFailureRetryable: evidence.cause.retryable,
        }
      : {}),
    startedAt: evidence.startedAt,
    endedAt: evidence.endedAt,
    driverProvenanceSignal,
    runtimeSettingsPresent: evidence.executionContext.runtimeSettings !== undefined,
    resourceEnvelopePresent: evidence.resourceEnvelope !== undefined,
    transcriptEventCount: transcriptEvents.length,
    turnCompletedEventCount: transcriptEvents.filter(
      (event) => event.kind === 'turn.completed',
    ).length,
    itemCompletedEventCount: transcriptEvents.filter(
      (event) => event.kind === 'item.completed',
    ).length,
    itemFailedEventCount: transcriptEvents.filter(
      (event) => event.kind === 'item.failed',
    ).length,
    approvalRequestedEventCount: transcriptEvents.filter(
      (event) => event.kind === 'approval.requested',
    ).length,
    usage,
    contextBudget,
  };
}

function detectRuntimeProvider(
  evidence: TerminalEvidence,
): RuntimeProviderEvidenceObservedProvider {
  const providers = new Set<RuntimeProviderEvidenceProvider>();
  addProviderByDriverProvenance(evidence.provenance, providers);
  addProviderByDriverProvenance(evidence.cause.provenance, providers);
  if (evidence.cause.kind === 'provider-failure') {
    providers.add(
      PROVIDER_FAILURE_PROVIDER_TO_RUNTIME_PROVIDER[evidence.cause.provider],
    );
  }
  for (const event of evidence.transcript?.events ?? []) {
    if ('provenance' in event) {
      addProviderByDriverProvenance(event.provenance.producer, providers);
    }
  }
  if (providers.size === 0) {
    return 'unknown';
  }
  if (providers.size > 1) {
    return 'mixed';
  }
  return [...providers][0] ?? 'unknown';
}

function addProviderByDriverProvenance(
  provenance: string,
  providers: Set<RuntimeProviderEvidenceProvider>,
): void {
  if (provenance === PROVIDER_TO_DRIVER_PROVENANCE.codex) {
    providers.add('codex');
  }
  if (provenance === PROVIDER_TO_DRIVER_PROVENANCE['claude-agent']) {
    providers.add('claude-agent');
  }
}

function hasCanonicalDriverProvenance(
  evidence: TerminalEvidence,
  provider: RuntimeProviderEvidenceProvider,
): boolean {
  const expected = PROVIDER_TO_DRIVER_PROVENANCE[provider];
  if (evidence.provenance === expected || evidence.cause.provenance === expected) {
    return true;
  }
  return (evidence.transcript?.events ?? []).some(
    (event) => 'provenance' in event && event.provenance.producer === expected,
  );
}

function classifyRuntimeProviderEvidenceReportStatus(input: {
  readonly selectedProviderRecordCount: number;
  readonly successfulProviderRecordCount: number;
  readonly failedProviderRecordCount: number;
  readonly providerProvenanceMatchedCount: number;
  readonly runtimeSettingsRecordCount: number;
}): RuntimeProviderEvidenceReportStatus {
  if (input.selectedProviderRecordCount === 0) {
    return 'no-record';
  }
  if (input.providerProvenanceMatchedCount < input.selectedProviderRecordCount) {
    return 'fail';
  }
  if (
    input.successfulProviderRecordCount > 0 &&
    input.failedProviderRecordCount === 0 &&
    input.runtimeSettingsRecordCount === input.selectedProviderRecordCount
  ) {
    return 'complete';
  }
  return 'warn';
}

function scoreRuntimeProviderEvidence(input: {
  readonly selectedProviderRecordCount: number;
  readonly successfulProviderRecordCount: number;
  readonly providerProvenanceMatchedCount: number;
  readonly runtimeSettingsRecordCount: number;
  readonly resourceEnvelopeRecordCount: number;
  readonly telemetryRecordCount: number;
}): number {
  if (input.selectedProviderRecordCount === 0) {
    return 0;
  }
  const denominator = input.selectedProviderRecordCount;
  const evidencePresenceScore = 30;
  const successScore =
    (input.successfulProviderRecordCount / denominator) * 25;
  const provenanceScore =
    (input.providerProvenanceMatchedCount / denominator) * 25;
  const settingsScore =
    ((input.runtimeSettingsRecordCount + input.resourceEnvelopeRecordCount) /
      (denominator * 2)) *
    10;
  const telemetryScore = (input.telemetryRecordCount / denominator) * 10;
  return Math.max(
    0,
    Math.round(
      evidencePresenceScore +
        successScore +
        provenanceScore +
        settingsScore +
        telemetryScore,
    ),
  );
}

function buildRuntimeProviderEvidenceRecommendations(input: {
  readonly requestedProviders: readonly RuntimeProviderEvidenceProvider[];
  readonly status: RuntimeProviderEvidenceReportStatus;
  readonly selectedProviderRecordCount: number;
  readonly successfulProviderRecordCount: number;
  readonly failedProviderRecordCount: number;
  readonly providerProvenanceMatchedCount: number;
  readonly runtimeSettingsRecordCount: number;
  readonly resourceEnvelopeRecordCount: number;
  readonly transcriptEventCount: number;
  readonly usageTotalTokens: number;
  readonly mixedProviderCount: number;
  readonly unknownProviderCount: number;
}): readonly string[] {
  if (input.status === 'complete') {
    return [];
  }
  const recommendations: string[] = [];
  if (input.selectedProviderRecordCount === 0) {
    recommendations.push(
      `Retain at least one TerminalEvidence JSON artifact from an authenticated ${input.requestedProviders.join('/')} run before promoting provider live proof.`,
    );
  }
  if (input.successfulProviderRecordCount === 0) {
    recommendations.push(
      'Retain a terminal-success provider run with an accessible model; provider-failure or driver-failure evidence is diagnostic only.',
    );
  }
  if (
    input.providerProvenanceMatchedCount < input.selectedProviderRecordCount
  ) {
    recommendations.push(
      'Require canonical driver provenance (codex-runtime-driver or claude-agent-runtime-driver) on TerminalEvidence, terminal cause, or transcript runtime events.',
    );
  }
  if (input.failedProviderRecordCount > 0) {
    recommendations.push(
      'Resolve non-success terminal causes before treating the provider row as live-ready.',
    );
  }
  if (
    input.runtimeSettingsRecordCount < input.selectedProviderRecordCount ||
    input.resourceEnvelopeRecordCount < input.selectedProviderRecordCount
  ) {
    recommendations.push(
      'Keep runtime settings and resource-envelope snapshots in the retained TerminalEvidence artifact.',
    );
  }
  if (input.transcriptEventCount === 0 && input.usageTotalTokens === 0) {
    recommendations.push(
      'Keep redacted runtime transcript metadata or token-usage events when the provider exposes them.',
    );
  }
  if (input.mixedProviderCount > 0 || input.unknownProviderCount > 0) {
    recommendations.push(
      'Separate mixed/unknown provider evidence from provider-specific promotion artifacts.',
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      'Review retained TerminalEvidence before promoting runtime-provider live proof.',
    );
  }
  return recommendations;
}

function sumUsage(
  summaries: readonly RuntimeProviderEvidenceUsageSummary[],
): RuntimeProviderEvidenceUsageSummary {
  return summaries.reduce(
    (acc, item) => ({
      inputTokens: acc.inputTokens + item.inputTokens,
      cachedInputTokens: acc.cachedInputTokens + item.cachedInputTokens,
      outputTokens: acc.outputTokens + item.outputTokens,
      totalTokens: acc.totalTokens + item.totalTokens,
    }),
    {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  );
}

function minMaxIso(values: readonly string[]): {
  readonly firstEndedAt?: string;
  readonly lastEndedAt?: string;
} {
  const sorted = values
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort();
  const firstEndedAt = sorted[0];
  const lastEndedAt = sorted.at(-1);
  return {
    ...(firstEndedAt === undefined ? {} : { firstEndedAt }),
    ...(lastEndedAt === undefined ? {} : { lastEndedAt }),
  };
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

function parseRuntimeProviderEvidenceProvider(
  value: string,
): RuntimeProviderEvidenceProvider {
  if (
    (RUNTIME_PROVIDER_EVIDENCE_PROVIDERS as readonly string[]).includes(value)
  ) {
    return value as RuntimeProviderEvidenceProvider;
  }
  throw new Error(
    `--provider must be one of: ${RUNTIME_PROVIDER_EVIDENCE_PROVIDERS.join(', ')}.`,
  );
}

function uniqueProviders(
  providers: readonly RuntimeProviderEvidenceProvider[],
): RuntimeProviderEvidenceProvider[] {
  return [...new Set(providers)];
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
