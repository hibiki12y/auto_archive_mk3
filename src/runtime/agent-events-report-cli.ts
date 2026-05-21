import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

import {
  projectCapabilityEnvelope,
  type CapabilityEnvelope,
} from '../contracts/capability-envelope.js';
import {
  projectContextBudgetSnapshot,
  type ContextBudgetSnapshot,
} from '../contracts/context-budget-snapshot.js';
import {
  projectCostUsageSnapshot,
  type CostUsageSnapshot,
  type CostUsageTokenSummary,
} from '../contracts/cost-usage-snapshot.js';
import {
  projectHumanGateSnapshot,
  type HumanGateSnapshot,
} from '../contracts/human-gate-port.js';
import type { RuntimeEvent } from '../contracts/runtime-event.js';
import {
  projectRestartRecipeSnapshot,
  type RestartRecipeSnapshot,
} from '../contracts/restart-recipe-snapshot.js';
import {
  createTerminalEvidence,
  type TerminalEvidence,
  type TerminalEvidenceInput,
} from '../contracts/terminal-evidence.js';

export const AGENT_EVENTS_REPORT_SCHEMA_VERSION = 1;
export const AGENT_EVENTS_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES =
  5 * 1024 * 1024;

export type AgentEventsReportStatus = 'complete' | 'warn' | 'fail' | 'no-record';
export type AgentEventRecordKind =
  | 'task.started'
  | 'runtime.event'
  | 'task.terminal';

export interface AgentEventsReportCliIo {
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
}

export interface AgentEventsReportCliOptions {
  readonly evidencePaths: readonly string[];
  readonly maxEvidenceBytes: number;
  readonly estimatedContextWindowTokens?: number;
  readonly generatedAt?: string;
  readonly pretty: boolean;
}

export interface AgentSessionRecordProjection {
  readonly schemaVersion: typeof AGENT_EVENTS_REPORT_SCHEMA_VERSION;
  readonly sessionIdHash: string;
  readonly runtimeInstanceIdHash: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly agentRecordCount: number;
  readonly eventRecordCount: number;
  readonly rawRuntimeInstanceIdRendered: false;
}

export interface AgentRecordProjection {
  readonly schemaVersion: typeof AGENT_EVENTS_REPORT_SCHEMA_VERSION;
  readonly agentIdHash: string;
  readonly taskIdHash: string;
  readonly runtimeInstanceIdHash: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly terminalCauseKind: TerminalEvidence['cause']['kind'];
  readonly capabilityEnvelope: CapabilityEnvelope;
  readonly restartRecipe: RestartRecipeSnapshot;
  readonly costUsage: CostUsageSnapshot;
  readonly rawTaskIdRendered: false;
  readonly rawRuntimeInstanceIdRendered: false;
  readonly rawInstructionRendered: false;
  readonly rawReasonRendered: false;
}

export interface AgentEventRecordProjection {
  readonly schemaVersion: typeof AGENT_EVENTS_REPORT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly kind: AgentEventRecordKind;
  readonly observedAt: string;
  readonly taskIdHash: string;
  readonly runtimeInstanceIdHash: string;
  readonly terminalCauseKind?: TerminalEvidence['cause']['kind'];
  readonly runtimeEventKind?: RuntimeEvent['kind'];
  readonly turnSequence?: number;
  readonly itemType?: string;
  readonly approvalRequestKind?: string;
  readonly humanGate?: HumanGateSnapshot;
  readonly answerProvenanceRequired?: true;
  readonly restartRecipe?: RestartRecipeSnapshot;
  readonly costUsage?: CostUsageSnapshot;
  readonly rawTaskIdRendered: false;
  readonly rawRuntimeInstanceIdRendered: false;
  readonly rawApprovalRequestIdRendered: false;
  readonly rawApprovalReasonRendered: false;
  readonly rawInstructionRendered: false;
  readonly rawReasonRendered: false;
  readonly rawTranscriptRendered: false;
}

export interface AgentEventsReport {
  readonly schemaVersion: typeof AGENT_EVENTS_REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly status: AgentEventsReportStatus;
  readonly source: {
    readonly kind: 'terminal-evidence-files';
    readonly evidenceFileCount: number;
    readonly maxEvidenceBytes: number;
    readonly pathRendered: false;
    readonly fileRead: true;
  };
  readonly method: {
    readonly projection: 'SessionRecord/AgentRecord/EventRecord';
    readonly sourceContract: 'TerminalEvidence';
    readonly promotionRule: string;
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
    readonly humanGateCount: number;
    readonly answerProvenanceRequiredCount: number;
    readonly providerReportedTokenUsageRecordCount: number;
    readonly costUsage: CostUsageSnapshot;
    readonly contextBudget: ContextBudgetSnapshot;
    readonly terminalCauseCounts: Readonly<Record<string, number>>;
    readonly runtimeEventKindCounts: Readonly<Record<string, number>>;
    readonly recommendations: readonly string[];
  };
  readonly sessions: readonly AgentSessionRecordProjection[];
  readonly agents: readonly AgentRecordProjection[];
  readonly events: readonly AgentEventRecordProjection[];
  readonly boundary: {
    readonly readOnly: true;
    readonly runtimeDriverCalled: false;
    readonly providerContacted: false;
    readonly evidenceFilesMutated: false;
    readonly environmentVariablesRead: false;
    readonly rawTaskIdsRendered: false;
    readonly rawRuntimeInstanceIdsRendered: false;
    readonly rawInstructionsRendered: false;
    readonly rawReasonsRendered: false;
    readonly rawTranscriptRendered: false;
    readonly rawBillingRendered: false;
    readonly publicApiStarted: false;
  };
}

export interface BuildAgentEventsReportInput {
  readonly evidence: readonly TerminalEvidence[];
  readonly maxEvidenceBytes?: number;
  readonly estimatedContextWindowTokens?: number;
  readonly generatedAt?: string;
}

const USAGE = `Usage: pnpm agent:events:report -- --evidence <path> [options]

Build a read-only managed agent SessionRecord/AgentRecord/EventRecord
projection from retained TerminalEvidence JSON files. The report is an
operator-local metadata projection, not a REST/SSE API server and not live
provider proof by itself.

Options:
  --evidence <path>          Required TerminalEvidence JSON file path. May be repeated.
  --max-evidence-bytes <n>   Fail closed before reading any file beyond this many bytes (default: ${String(AGENT_EVENTS_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES)}).
  --estimated-context-window-tokens <n>
                             Optional operator-supplied context window used only for estimated context-fill pressure.
  --generated-at <iso>       Optional generatedAt timestamp to embed in the report.
  --pretty                   Pretty-print JSON output.
  --help                     Show this help text.

Boundary:
  This command is read-only. It does not instantiate RuntimeDrivers, call Codex,
  call Claude Agent, contact Discord/GitLab/provider services, read environment
  variables, mutate evidence files, render raw task ids, render raw runtime ids,
  render raw instructions, render raw terminal reasons, render raw transcript
  content, or render billing details. Input files must be operator-owned retained
  TerminalEvidence JSON artifacts.
`;

export function parseAgentEventsReportCliArgs(
  argv: readonly string[],
): AgentEventsReportCliOptions | 'help' {
  const evidencePaths: string[] = [];
  let maxEvidenceBytes = AGENT_EVENTS_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES;
  let estimatedContextWindowTokens: number | undefined;
  let generatedAt: string | undefined;
  let pretty = false;

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
      case '--evidence':
        evidencePaths.push(requireCliValue(argv, index, '--evidence'));
        index += 1;
        break;
      case '--max-evidence-bytes': {
        const parsed = Number(
          requireCliValue(argv, index, '--max-evidence-bytes'),
        );
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          throw new Error(
            '--max-evidence-bytes must be a positive safe integer.',
          );
        }
        maxEvidenceBytes = parsed;
        index += 1;
        break;
      }
      case '--estimated-context-window-tokens': {
        const parsed = Number(
          requireCliValue(argv, index, '--estimated-context-window-tokens'),
        );
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          throw new Error(
            '--estimated-context-window-tokens must be a positive safe integer.',
          );
        }
        estimatedContextWindowTokens = parsed;
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

  if (evidencePaths.length === 0) {
    throw new Error('--evidence is required.');
  }

  return {
    evidencePaths,
    maxEvidenceBytes,
    ...(estimatedContextWindowTokens === undefined
      ? {}
      : { estimatedContextWindowTokens }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
    pretty,
  };
}

export function buildAgentEventsReportFromCliOptions(
  options: AgentEventsReportCliOptions,
): AgentEventsReport {
  const evidence = options.evidencePaths.map((evidencePath) =>
    readTerminalEvidenceJsonFile(evidencePath, options.maxEvidenceBytes),
  );
  return buildAgentEventsReport({
    evidence,
    maxEvidenceBytes: options.maxEvidenceBytes,
    ...(options.estimatedContextWindowTokens === undefined
      ? {}
      : { estimatedContextWindowTokens: options.estimatedContextWindowTokens }),
    ...(options.generatedAt === undefined
      ? {}
      : { generatedAt: options.generatedAt }),
  });
}

export function runAgentEventsReportCli(
  argv: readonly string[] = process.argv.slice(2),
  io: AgentEventsReportCliIo = process,
): number {
  try {
    const options = parseAgentEventsReportCliArgs(argv);
    if (options === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    const report = buildAgentEventsReportFromCliOptions(options);
    io.stdout.write(JSON.stringify(report, null, options.pretty ? 2 : 0));
    io.stdout.write('\n');
    return report.status === 'fail' ? 1 : 0;
  } catch (error) {
    io.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

export function buildAgentEventsReport(
  input: BuildAgentEventsReportInput,
): AgentEventsReport {
  const uniqueEvidence = dedupeEvidence(input.evidence);
  const eventRecords: AgentEventRecordProjection[] = [];
  const agentRecords = uniqueEvidence.map((evidence, evidenceIndex) => {
    const costUsage = projectEvidenceCostUsage(evidence);
    const taskIdHash = sha256(evidence.taskId);
    const runtimeInstanceIdHash = sha256(evidence.runtimeInstanceId);
    const agentRecord: AgentRecordProjection = {
      schemaVersion: AGENT_EVENTS_REPORT_SCHEMA_VERSION,
      agentIdHash: sha256(`${evidence.taskId}:${evidence.runtimeInstanceId}`),
      taskIdHash,
      runtimeInstanceIdHash,
      startedAt: evidence.startedAt,
      endedAt: evidence.endedAt,
      terminalCauseKind: evidence.cause.kind,
      capabilityEnvelope: projectCapabilityEnvelope({
        runtimeSettings: evidence.executionContext.runtimeSettings,
        resourceEnvelope: evidence.resourceEnvelope,
      }),
      restartRecipe: projectRestartRecipeSnapshot(evidence.cause),
      costUsage,
      rawTaskIdRendered: false,
      rawRuntimeInstanceIdRendered: false,
      rawInstructionRendered: false,
      rawReasonRendered: false,
    };

    eventRecords.push(
      buildTaskStartedEventRecord(evidence, evidenceIndex, 0, costUsage),
    );
    for (let index = 0; index < (evidence.transcript?.events ?? []).length; index += 1) {
      eventRecords.push(
        buildRuntimeEventRecord(
          evidence,
          evidence.transcript?.events[index] as RuntimeEvent,
          evidenceIndex,
          index + 1,
        ),
      );
    }
    eventRecords.push(
      buildTaskTerminalEventRecord(
        evidence,
        evidenceIndex,
        (evidence.transcript?.events ?? []).length + 1,
        costUsage,
      ),
    );
    return agentRecord;
  });

  const sessions = buildSessionRecords(uniqueEvidence, eventRecords);
  const tokenUsageRecords = uniqueEvidence.map((evidence) =>
    summarizeEvidenceUsage(evidence),
  );
  const usage = sumUsage(tokenUsageRecords.map((item) => item.usage));
  const tokenUsageObserved = tokenUsageRecords.some((item) => item.observed);
  const costUsage = projectCostUsageSnapshot({
    tokenUsage: usage,
    tokenUsageObserved,
  });
  const contextBudget = projectContextBudgetSnapshot({
    tokenUsage: usage,
    tokenUsageObserved,
    ...(input.estimatedContextWindowTokens === undefined
      ? {}
      : { estimatedContextWindowTokens: input.estimatedContextWindowTokens }),
  });
  const terminalCauseCounts = countBy(
    uniqueEvidence.map((evidence) => evidence.cause.kind),
  );
  const runtimeEventKindCounts = countBy(
    eventRecords.flatMap((event) =>
      event.runtimeEventKind === undefined ? [] : [event.runtimeEventKind],
    ),
  );
  const duplicateEvidenceRecordCount = input.evidence.length - uniqueEvidence.length;
  const nonSuccessTerminalCauseCount = uniqueEvidence.filter(
    (evidence) => evidence.cause.kind !== 'success',
  ).length;
  const status = classifyReportStatus({
    projectedEvidenceCount: uniqueEvidence.length,
    nonSuccessTerminalCauseCount,
    duplicateEvidenceRecordCount,
  });

  return {
    schemaVersion: AGENT_EVENTS_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status,
    source: {
      kind: 'terminal-evidence-files',
      evidenceFileCount: input.evidence.length,
      maxEvidenceBytes:
        input.maxEvidenceBytes ?? AGENT_EVENTS_REPORT_CLI_DEFAULT_MAX_EVIDENCE_BYTES,
      pathRendered: false,
      fileRead: true,
    },
    method: {
      projection: 'SessionRecord/AgentRecord/EventRecord',
      sourceContract: 'TerminalEvidence',
      promotionRule:
        'Use this operator-local projection only when retained TerminalEvidence exists; API/SSE serving and live provider proof are separate gates.',
    },
    scorecard: {
      sessionRecordCount: sessions.length,
      agentRecordCount: agentRecords.length,
      eventRecordCount: eventRecords.length,
      terminalEventCount: eventRecords.filter(
        (event) => event.kind === 'task.terminal',
      ).length,
      nonSuccessTerminalCauseCount,
      duplicateEvidenceRecordCount,
      restartRecipeCount: agentRecords.length,
      capabilityEnvelopeCount: agentRecords.length,
      humanGateCount: eventRecords.filter((event) => event.humanGate !== undefined)
        .length,
      answerProvenanceRequiredCount: eventRecords.filter(
        (event) => event.answerProvenanceRequired === true,
      ).length,
      providerReportedTokenUsageRecordCount: tokenUsageRecords.filter(
        (item) => item.observed,
      ).length,
      costUsage,
      contextBudget,
      terminalCauseCounts,
      runtimeEventKindCounts,
      recommendations: buildRecommendations({
        projectedEvidenceCount: uniqueEvidence.length,
        nonSuccessTerminalCauseCount,
        duplicateEvidenceRecordCount,
      }),
    },
    sessions,
    agents: agentRecords,
    events: eventRecords,
    boundary: {
      readOnly: true,
      runtimeDriverCalled: false,
      providerContacted: false,
      evidenceFilesMutated: false,
      environmentVariablesRead: false,
      rawTaskIdsRendered: false,
      rawRuntimeInstanceIdsRendered: false,
      rawInstructionsRendered: false,
      rawReasonsRendered: false,
      rawTranscriptRendered: false,
      rawBillingRendered: false,
      publicApiStarted: false,
    },
  };
}

function buildTaskStartedEventRecord(
  evidence: TerminalEvidence,
  evidenceIndex: number,
  eventIndex: number,
  costUsage: CostUsageSnapshot,
): AgentEventRecordProjection {
  return baseEventRecord(evidence, evidenceIndex, eventIndex, {
    kind: 'task.started',
    observedAt: evidence.startedAt,
    costUsage,
  });
}

function buildRuntimeEventRecord(
  evidence: TerminalEvidence,
  runtimeEvent: RuntimeEvent,
  evidenceIndex: number,
  eventIndex: number,
): AgentEventRecordProjection {
  const usage =
    runtimeEvent.kind === 'turn.completed' && runtimeEvent.usage !== undefined
      ? {
          inputTokens: runtimeEvent.usage.inputTokens,
          cachedInputTokens: runtimeEvent.usage.cachedInputTokens,
          outputTokens: runtimeEvent.usage.outputTokens,
          totalTokens:
            runtimeEvent.usage.inputTokens +
            runtimeEvent.usage.cachedInputTokens +
            runtimeEvent.usage.outputTokens,
        }
      : undefined;
  return baseEventRecord(evidence, evidenceIndex, eventIndex, {
    kind: 'runtime.event',
    observedAt: runtimeEvent.timestamp,
    runtimeEventKind: runtimeEvent.kind,
    ...('turnSequence' in runtimeEvent
      ? { turnSequence: runtimeEvent.turnSequence }
      : {}),
    ...(runtimeEvent.kind === 'item.completed' || runtimeEvent.kind === 'item.failed'
      ? { itemType: runtimeEvent.item.type }
      : {}),
    ...(runtimeEvent.kind === 'approval.requested'
      ? {
          approvalRequestKind: runtimeEvent.request.kind,
          humanGate: projectHumanGateSnapshot({
            gateId: runtimeEvent.approvalRequestId,
            question: buildApprovalGateQuestion(runtimeEvent),
            timeoutSec: deriveApprovalTimeoutSec(runtimeEvent),
            onTimeout: 'fail-closed',
          }),
          answerProvenanceRequired: true as const,
        }
      : {}),
    ...(usage === undefined
      ? {}
      : {
          costUsage: projectCostUsageSnapshot({
            tokenUsage: usage,
            tokenUsageObserved: true,
          }),
        }),
  });
}

function buildApprovalGateQuestion(
  runtimeEvent: Extract<RuntimeEvent, { readonly kind: 'approval.requested' }>,
): string {
  const request = runtimeEvent.request;
  return [
    `approval kind: ${request.kind}`,
    `reason: ${request.reason}`,
    request.command === undefined ? undefined : `command: ${request.command}`,
    request.toolServer === undefined ? undefined : `tool server: ${request.toolServer}`,
    request.toolName === undefined ? undefined : `tool name: ${request.toolName}`,
    request.workingDirectory === undefined
      ? undefined
      : `working directory: ${request.workingDirectory}`,
  ]
    .filter((item): item is string => item !== undefined)
    .join('\n');
}

function deriveApprovalTimeoutSec(
  runtimeEvent: Extract<RuntimeEvent, { readonly kind: 'approval.requested' }>,
): number {
  const startedAtMs = Date.parse(runtimeEvent.timestamp);
  const deadlineMs = Date.parse(runtimeEvent.deadline);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(deadlineMs)) {
    return 1;
  }
  return Math.max(1, Math.ceil((deadlineMs - startedAtMs) / 1000));
}

function buildTaskTerminalEventRecord(
  evidence: TerminalEvidence,
  evidenceIndex: number,
  eventIndex: number,
  costUsage: CostUsageSnapshot,
): AgentEventRecordProjection {
  return baseEventRecord(evidence, evidenceIndex, eventIndex, {
    kind: 'task.terminal',
    observedAt: evidence.endedAt,
    terminalCauseKind: evidence.cause.kind,
    restartRecipe: projectRestartRecipeSnapshot(evidence.cause),
    costUsage,
  });
}

function baseEventRecord(
  evidence: TerminalEvidence,
  evidenceIndex: number,
  eventIndex: number,
  fields: Omit<AgentEventRecordProjection, 'schemaVersion' | 'eventId' | 'taskIdHash' | 'runtimeInstanceIdHash' | 'rawTaskIdRendered' | 'rawRuntimeInstanceIdRendered' | 'rawApprovalRequestIdRendered' | 'rawApprovalReasonRendered' | 'rawInstructionRendered' | 'rawReasonRendered' | 'rawTranscriptRendered'>,
): AgentEventRecordProjection {
  return {
    schemaVersion: AGENT_EVENTS_REPORT_SCHEMA_VERSION,
    eventId: `event-${String(evidenceIndex + 1)}-${String(eventIndex + 1)}`,
    taskIdHash: sha256(evidence.taskId),
    runtimeInstanceIdHash: sha256(evidence.runtimeInstanceId),
    ...fields,
    rawTaskIdRendered: false,
    rawRuntimeInstanceIdRendered: false,
    rawApprovalRequestIdRendered: false,
    rawApprovalReasonRendered: false,
    rawInstructionRendered: false,
    rawReasonRendered: false,
    rawTranscriptRendered: false,
  };
}

function buildSessionRecords(
  evidence: readonly TerminalEvidence[],
  events: readonly AgentEventRecordProjection[],
): readonly AgentSessionRecordProjection[] {
  const runtimeInstanceIds = [...new Set(evidence.map((item) => item.runtimeInstanceId))];
  return runtimeInstanceIds.map((runtimeInstanceId) => {
    const runtimeInstanceIdHash = sha256(runtimeInstanceId);
    const sessionEvidence = evidence.filter(
      (item) => item.runtimeInstanceId === runtimeInstanceId,
    );
    const sessionEvents = events.filter(
      (item) => item.runtimeInstanceIdHash === runtimeInstanceIdHash,
    );
    return {
      schemaVersion: AGENT_EVENTS_REPORT_SCHEMA_VERSION,
      sessionIdHash: sha256(`session:${runtimeInstanceId}`),
      runtimeInstanceIdHash,
      startedAt: minIso(sessionEvidence.map((item) => item.startedAt)),
      endedAt: maxIso(sessionEvidence.map((item) => item.endedAt)),
      agentRecordCount: sessionEvidence.length,
      eventRecordCount: sessionEvents.length,
      rawRuntimeInstanceIdRendered: false,
    };
  });
}

function projectEvidenceCostUsage(evidence: TerminalEvidence): CostUsageSnapshot {
  const summary = summarizeEvidenceUsage(evidence);
  return projectCostUsageSnapshot({
    tokenUsage: summary.usage,
    tokenUsageObserved: summary.observed,
  });
}

function summarizeEvidenceUsage(evidence: TerminalEvidence): {
  readonly usage: CostUsageTokenSummary;
  readonly observed: boolean;
} {
  const records = (evidence.transcript?.events ?? []).flatMap((event) =>
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
  return {
    usage: sumUsage(records),
    observed: records.length > 0,
  };
}

function sumUsage(
  summaries: readonly CostUsageTokenSummary[],
): CostUsageTokenSummary {
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

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function classifyReportStatus(input: {
  readonly projectedEvidenceCount: number;
  readonly nonSuccessTerminalCauseCount: number;
  readonly duplicateEvidenceRecordCount: number;
}): AgentEventsReportStatus {
  if (input.projectedEvidenceCount === 0) {
    return 'no-record';
  }
  if (
    input.nonSuccessTerminalCauseCount > 0 ||
    input.duplicateEvidenceRecordCount > 0
  ) {
    return 'warn';
  }
  return 'complete';
}

function buildRecommendations(input: {
  readonly projectedEvidenceCount: number;
  readonly nonSuccessTerminalCauseCount: number;
  readonly duplicateEvidenceRecordCount: number;
}): readonly string[] {
  const recommendations: string[] = [];
  if (input.projectedEvidenceCount === 0) {
    recommendations.push(
      'Retain at least one TerminalEvidence JSON artifact before using the managed event projection.',
    );
  }
  if (input.nonSuccessTerminalCauseCount > 0) {
    recommendations.push(
      'Non-success TerminalEvidence is projected for restart/accountability review; treat it as diagnostic until a fresh operator-approved rerun succeeds.',
    );
  }
  if (input.duplicateEvidenceRecordCount > 0) {
    recommendations.push(
      'Duplicate TerminalEvidence records were collapsed before projection to avoid double-counting events and token usage.',
    );
  }
  return recommendations;
}

function dedupeEvidence(
  evidence: readonly TerminalEvidence[],
): readonly TerminalEvidence[] {
  const seen = new Set<string>();
  const unique: TerminalEvidence[] = [];
  for (const item of evidence) {
    const key = [
      item.taskId,
      item.runtimeInstanceId,
      item.startedAt,
      item.endedAt,
      item.cause.kind,
      item.cause.provenance,
    ].join('\0');
    const digest = sha256(key);
    if (seen.has(digest)) {
      continue;
    }
    seen.add(digest);
    unique.push(item);
  }
  return unique;
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
    throw new Error(`--evidence path is not a regular file: ${evidencePath}`);
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
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function minIso(values: readonly string[]): string {
  return values.filter((value) => Number.isFinite(Date.parse(value))).sort()[0] ?? '';
}

function maxIso(values: readonly string[]): string {
  return values
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort()
    .at(-1) ?? '';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
