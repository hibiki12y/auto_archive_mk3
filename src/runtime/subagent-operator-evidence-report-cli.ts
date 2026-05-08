import { lstatSync, readFileSync } from 'node:fs';

export const SUBAGENT_OPERATOR_EVIDENCE_REPORT_SCHEMA_VERSION = 1;
export const SUBAGENT_OPERATOR_EVIDENCE_REPORT_RUBRIC_VERSION =
  '2026-05-05.subagent-operator-evidence-v2' as const;
export const SUBAGENT_OPERATOR_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES =
  10 * 1024 * 1024;

export type SubagentOperatorEvidenceReportStatus =
  | 'complete'
  | 'warn'
  | 'fail'
  | 'no-record';
export type SubagentOperatorEvidenceEventKind =
  | 'subagent.spawned'
  | 'subagent.completed'
  | 'subagent.aborted'
  | 'subagent.failed'
  | 'roster.progress';

export interface SubagentOperatorEvidenceReportCliIo {
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
}

export interface SubagentOperatorEvidenceReportCliOptions {
  readonly ledgerPath?: string;
  readonly filter: {
    readonly eventKind?: SubagentOperatorEvidenceEventKind;
    readonly limit?: number;
  };
  readonly maxLedgerBytes: number;
  readonly generatedAt?: string;
  readonly pretty: boolean;
  readonly printTemplate: boolean;
}

export interface SubagentOperatorEvidenceTemplateRecord {
  readonly kind: 'subagent.spawned';
  readonly correlationKey: {
    readonly taskId: string;
    readonly instanceId: string;
    readonly subagentId: string;
  };
  readonly timestamp: string;
  readonly descriptor: {
    readonly subagentId: string;
    readonly role: 'template';
    readonly parent: {
      readonly taskId: string;
      readonly instanceId: string;
    };
    readonly createdAt: string;
    readonly state: 'active';
    readonly envelope: {
      readonly requested: {
        readonly cpuCores: 1;
        readonly memoryMiB: 512;
        readonly wallTimeSec: 60;
        readonly gpuCards: 0;
      };
      readonly effective: {
        readonly cpuCores: 1;
        readonly memoryMiB: 512;
        readonly wallTimeSec: 60;
        readonly gpuCards: 0;
      };
    };
  };
}

interface SubagentOperatorEvidenceRecord {
  readonly observedAt: string;
  readonly eventKind: SubagentOperatorEvidenceEventKind;
  readonly hasSubagentId: boolean;
  readonly hasParentTask: boolean;
  readonly hasParentRuntime: boolean;
  readonly role?: string;
  readonly state?: string;
  readonly terminalKind?: string;
  readonly subagentStateKey?: string;
}

export interface SubagentOperatorEvidenceReplayAudit {
  readonly source: 'jsonl';
  readonly totalLineCount: number;
  readonly emptyLineCount: number;
  readonly parsedRecordCount: number;
  readonly skippedMalformedLineCount: number;
  readonly unsafePayloadLineCount: number;
}

export interface SubagentOperatorEvidenceReport {
  readonly schemaVersion: typeof SUBAGENT_OPERATOR_EVIDENCE_REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly status: SubagentOperatorEvidenceReportStatus;
  readonly filter: SubagentOperatorEvidenceReportCliOptions['filter'];
  readonly method: {
    readonly sourceEvents: readonly [
      'subagent.spawned',
      'subagent.completed',
      'subagent.aborted',
      'subagent.failed',
      'roster.progress',
    ];
    readonly scoringRubricVersion: typeof SUBAGENT_OPERATOR_EVIDENCE_REPORT_RUBRIC_VERSION;
    readonly promotionRule: string;
  };
  readonly replayAudit: SubagentOperatorEvidenceReplayAudit;
  readonly scorecard: {
    readonly recordCount: number;
    readonly spawnedCount: number;
    readonly completedCount: number;
    readonly abortedCount: number;
    readonly failedCount: number;
    readonly progressCount: number;
    readonly terminalCount: number;
    readonly subagentScopedRecordCount: number;
    readonly parentTaskScopedRecordCount: number;
    readonly parentRuntimeScopedRecordCount: number;
    readonly currentActiveSubagentCount: number;
    readonly duplicateSpawnCount: number;
    readonly terminalWithoutSpawnCount: number;
    readonly filterApplied: boolean;
    readonly transitionCountsFiltered: boolean;
    readonly roleCounts: Readonly<Record<string, number>>;
    readonly terminalKindCounts: Readonly<Record<string, number>>;
    readonly lastObservedAt?: string;
    readonly qualityScore: {
      readonly rubricVersion: typeof SUBAGENT_OPERATOR_EVIDENCE_REPORT_RUBRIC_VERSION;
      readonly value: number;
      readonly max: 100;
      readonly summary: string;
    };
    readonly recommendations: readonly string[];
  };
  readonly boundary: {
    readonly readOnly: true;
    readonly liveServicesContacted: false;
    readonly rosterMutated: false;
    readonly ledgerMutated: false;
    readonly rawSubagentIdsRendered: false;
    readonly rawTaskIdsRendered: false;
    readonly rawRuntimeIdsRendered: false;
    readonly rawMessagesRendered: false;
    readonly rawArtifactsRendered: false;
    readonly rawPayloadRendered: false;
  };
}

const SOURCE_EVENTS = [
  'subagent.spawned',
  'subagent.completed',
  'subagent.aborted',
  'subagent.failed',
  'roster.progress',
] as const;

const USAGE = `Usage: pnpm subagent:operator:evidence:report -- --ledger <path> [options]
       pnpm subagent:operator:evidence:report -- --print-template [--generated-at <iso>]

Build a read-only retained subagent operator scorecard from a roster-event JSONL ledger.
The report never renders raw subagent ids, task ids, runtime ids, terminal messages, artifacts, or payload blobs.

Use --print-template to emit one compact, non-promoting roster-event JSONL
skeleton. It records a placeholder active spawn only, so report mode remains
WARN until replaced by real host-owned spawn, terminal, and progress evidence.
Template mode accepts only --generated-at; it rejects --ledger, --event-kind,
--limit, --max-ledger-bytes, and --pretty so redirected output remains one
machine-readable JSONL line.

Options:
  --ledger <path>            Required existing roster-event JSONL ledger path unless --print-template is set.
  --print-template           Print one non-promoting compact roster-event JSONL record instead of reading --ledger.
  --event-kind <kind>        Filter by subagent.spawned|subagent.completed|subagent.aborted|subagent.failed|roster.progress.
  --limit <count>            Score only the bounded tail after filtering.
  --max-ledger-bytes <n>     Fail closed before reading beyond this many bytes (default: ${String(SUBAGENT_OPERATOR_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES)}).
  --generated-at <iso>       Optional generatedAt timestamp to embed in the report.
  --pretty                   Pretty-print JSON output.
  --help                     Show this help text.

Boundary:
  This command is read-only. It does not call Discord/GitLab/provider services,
  spawn, steer, kill, or inspect live subagents, mutate roster state, mutate or
  rotate ledgers, reload environment variables, or render raw subagent ids, task
  ids, runtime ids, messages, artifacts, instructions, prompts, responses, or payloads.
`;

export function parseSubagentOperatorEvidenceReportCliArgs(
  argv: readonly string[],
): SubagentOperatorEvidenceReportCliOptions | 'help' {
  let ledgerPath: string | undefined;
  let eventKind: SubagentOperatorEvidenceEventKind | undefined;
  let limit: number | undefined;
  let maxLedgerBytes = SUBAGENT_OPERATOR_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES;
  let generatedAt: string | undefined;
  let eventKindProvided = false;
  let limitProvided = false;
  let maxLedgerBytesProvided = false;
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
      case '--ledger':
        ledgerPath = requireCliValue(argv, index, '--ledger');
        index += 1;
        break;
      case '--event-kind': {
        const raw = requireCliValue(argv, index, '--event-kind');
        if (!isSubagentOperatorEvidenceEventKind(raw)) {
          throw new Error(`--event-kind must be one of ${SOURCE_EVENTS.join(', ')}.`);
        }
        eventKind = raw;
        eventKindProvided = true;
        index += 1;
        break;
      }
      case '--limit': {
        const parsed = Number(requireCliValue(argv, index, '--limit'));
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error('--limit must be a non-negative integer.');
        }
        limit = parsed;
        limitProvided = true;
        index += 1;
        break;
      }
      case '--max-ledger-bytes': {
        const parsed = Number(requireCliValue(argv, index, '--max-ledger-bytes'));
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          throw new Error('--max-ledger-bytes must be a positive safe integer.');
        }
        maxLedgerBytes = parsed;
        maxLedgerBytesProvided = true;
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

  if (printTemplate && ledgerPath !== undefined) {
    throw new Error('--print-template cannot be combined with --ledger.');
  }
  if (
    printTemplate &&
    (eventKindProvided || limitProvided || maxLedgerBytesProvided || pretty)
  ) {
    throw new Error(
      '--print-template cannot be combined with report-only options: --event-kind, --limit, --max-ledger-bytes, or --pretty.',
    );
  }

  if (!printTemplate && (ledgerPath === undefined || ledgerPath.length === 0)) {
    throw new Error('--ledger is required.');
  }

  return {
    ...(ledgerPath === undefined ? {} : { ledgerPath }),
    filter: {
      ...(eventKind === undefined ? {} : { eventKind }),
      ...(limit === undefined ? {} : { limit }),
    },
    maxLedgerBytes,
    ...(generatedAt === undefined ? {} : { generatedAt }),
    pretty,
    printTemplate,
  };
}

export function buildSubagentOperatorEvidenceReportFromCliOptions(
  options: SubagentOperatorEvidenceReportCliOptions,
): SubagentOperatorEvidenceReport {
  if (options.printTemplate) {
    throw new Error('Cannot build a subagent operator evidence report from --print-template options.');
  }
  if (options.ledgerPath === undefined || options.ledgerPath.length === 0) {
    throw new Error('--ledger is required.');
  }
  const replay = readSubagentOperatorEvidenceLedgerFile(
    options.ledgerPath,
    options.maxLedgerBytes,
  );
  const filtered = filterSubagentOperatorEvidenceRecords(
    replay.records,
    options.filter,
  );
  return buildSubagentOperatorEvidenceReport({
    records: filtered,
    replayAudit: replay.replayAudit,
    filter: options.filter,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  });
}

export function buildSubagentOperatorEvidenceTemplateFromCliOptions(
  options: Pick<SubagentOperatorEvidenceReportCliOptions, 'generatedAt'>,
): SubagentOperatorEvidenceTemplateRecord {
  const observedAt = options.generatedAt ?? new Date().toISOString();
  const taskId = 'task-subagent-operator-template';
  const instanceId = 'runtime-subagent-operator-template';
  const subagentId = 'subagent-operator-template';
  const resourceSpec = {
    cpuCores: 1,
    memoryMiB: 512,
    wallTimeSec: 60,
    gpuCards: 0,
  } as const;
  return {
    kind: 'subagent.spawned',
    correlationKey: {
      taskId,
      instanceId,
      subagentId,
    },
    timestamp: observedAt,
    descriptor: {
      subagentId,
      role: 'template',
      parent: {
        taskId,
        instanceId,
      },
      createdAt: observedAt,
      state: 'active',
      envelope: {
        requested: resourceSpec,
        effective: resourceSpec,
      },
    },
  };
}

export function runSubagentOperatorEvidenceReportCli(
  argv: readonly string[],
  io: SubagentOperatorEvidenceReportCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  try {
    const options = parseSubagentOperatorEvidenceReportCliArgs(argv);
    if (options === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    if (options.printTemplate) {
      io.stdout.write(
        `${JSON.stringify(buildSubagentOperatorEvidenceTemplateFromCliOptions(options))}\n`,
      );
      return 0;
    }
    const report = buildSubagentOperatorEvidenceReportFromCliOptions(options);
    io.stdout.write(`${JSON.stringify(report, null, options.pretty ? 2 : undefined)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `subagent:operator:evidence:report failed: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    );
    return 1;
  }
}

function buildSubagentOperatorEvidenceReport(input: {
  readonly records: readonly SubagentOperatorEvidenceRecord[];
  readonly replayAudit: SubagentOperatorEvidenceReplayAudit;
  readonly filter: SubagentOperatorEvidenceReportCliOptions['filter'];
  readonly generatedAt: string;
}): SubagentOperatorEvidenceReport {
  let spawnedCount = 0;
  let completedCount = 0;
  let abortedCount = 0;
  let failedCount = 0;
  let progressCount = 0;
  let subagentScopedRecordCount = 0;
  let parentTaskScopedRecordCount = 0;
  let parentRuntimeScopedRecordCount = 0;
  let duplicateSpawnCount = 0;
  let terminalWithoutSpawnCount = 0;
  let lastObservedAt: string | undefined;
  const activeState = new Map<string, boolean>();
  const roleCounts = new Map<string, number>();
  const terminalKindCounts = new Map<string, number>();

  for (const record of input.records) {
    if (record.eventKind === 'subagent.spawned') spawnedCount += 1;
    if (record.eventKind === 'subagent.completed') completedCount += 1;
    if (record.eventKind === 'subagent.aborted') abortedCount += 1;
    if (record.eventKind === 'subagent.failed') failedCount += 1;
    if (record.eventKind === 'roster.progress') progressCount += 1;
    if (record.hasSubagentId) subagentScopedRecordCount += 1;
    if (record.hasParentTask) parentTaskScopedRecordCount += 1;
    if (record.hasParentRuntime) parentRuntimeScopedRecordCount += 1;
    if (record.role !== undefined) increment(roleCounts, record.role);
    if (record.terminalKind !== undefined) increment(terminalKindCounts, record.terminalKind);
    lastObservedAt =
      lastObservedAt === undefined || record.observedAt > lastObservedAt
        ? record.observedAt
        : lastObservedAt;

    if (record.subagentStateKey !== undefined) {
      const wasActive = activeState.get(record.subagentStateKey) === true;
      if (record.eventKind === 'subagent.spawned') {
        if (wasActive) duplicateSpawnCount += 1;
        activeState.set(record.subagentStateKey, true);
      } else if (isTerminalEventKind(record.eventKind)) {
        if (!wasActive) terminalWithoutSpawnCount += 1;
        activeState.set(record.subagentStateKey, false);
      }
    }
  }

  const recordCount = input.records.length;
  const terminalCount = completedCount + abortedCount + failedCount;
  const currentActiveSubagentCount = Array.from(activeState.values()).filter(Boolean).length;
  const filterApplied = input.filter.eventKind !== undefined || input.filter.limit !== undefined;
  const cleanReplay =
    input.replayAudit.skippedMalformedLineCount === 0 &&
    input.replayAudit.unsafePayloadLineCount === 0;
  const qualityScoreValue = round4(
    25 * (recordCount > 0 ? 1 : 0) +
      20 * (spawnedCount > 0 ? 1 : 0) +
      20 * (terminalCount > 0 ? 1 : 0) +
      10 * (progressCount > 0 ? 1 : 0) +
      10 * rate(subagentScopedRecordCount, recordCount) +
      15 * (cleanReplay ? 1 : 0),
  );
  const status = subagentOperatorEvidenceReportStatus({
    recordCount,
    spawnedCount,
    terminalCount,
    progressCount,
    subagentScopedRecordCount,
    currentActiveSubagentCount,
    duplicateSpawnCount,
    terminalWithoutSpawnCount,
    replayAudit: input.replayAudit,
  });
  const recommendations = subagentOperatorEvidenceRecommendations({
    recordCount,
    spawnedCount,
    terminalCount,
    progressCount,
    currentActiveSubagentCount,
    duplicateSpawnCount,
    terminalWithoutSpawnCount,
    replayAudit: input.replayAudit,
  });

  return {
    schemaVersion: SUBAGENT_OPERATOR_EVIDENCE_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    status,
    filter: input.filter,
    method: {
      sourceEvents: SOURCE_EVENTS,
      scoringRubricVersion: SUBAGENT_OPERATOR_EVIDENCE_REPORT_RUBRIC_VERSION,
      promotionRule:
        'Require retained subagent spawn plus terminal lifecycle evidence, at least one roster.progress sample, clean bounded replay, and no raw prompt/message/artifact payloads before treating the subagent operator surface as complete retained evidence.',
    },
    replayAudit: input.replayAudit,
    scorecard: {
      recordCount,
      spawnedCount,
      completedCount,
      abortedCount,
      failedCount,
      progressCount,
      terminalCount,
      subagentScopedRecordCount,
      parentTaskScopedRecordCount,
      parentRuntimeScopedRecordCount,
      currentActiveSubagentCount,
      duplicateSpawnCount,
      terminalWithoutSpawnCount,
      filterApplied,
      transitionCountsFiltered: filterApplied,
      roleCounts: Object.fromEntries(roleCounts),
      terminalKindCounts: Object.fromEntries(terminalKindCounts),
      ...(lastObservedAt === undefined ? {} : { lastObservedAt }),
      qualityScore: {
        rubricVersion: SUBAGENT_OPERATOR_EVIDENCE_REPORT_RUBRIC_VERSION,
        value: qualityScoreValue,
        max: 100,
        summary:
          recordCount === 0
            ? 'No subagent roster events were available for scoring.'
            : `Subagent operator evidence score ${String(qualityScoreValue)}/100 over ${String(recordCount)} retained roster event(s).`,
      },
      recommendations,
    },
    boundary: {
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
    },
  };
}

function subagentOperatorEvidenceReportStatus(input: {
  readonly recordCount: number;
  readonly spawnedCount: number;
  readonly terminalCount: number;
  readonly progressCount: number;
  readonly subagentScopedRecordCount: number;
  readonly currentActiveSubagentCount: number;
  readonly duplicateSpawnCount: number;
  readonly terminalWithoutSpawnCount: number;
  readonly replayAudit: SubagentOperatorEvidenceReplayAudit;
}): SubagentOperatorEvidenceReportStatus {
  if (input.replayAudit.unsafePayloadLineCount > 0) return 'fail';
  if (input.recordCount === 0) return 'no-record';
  if (
    input.replayAudit.skippedMalformedLineCount > 0 ||
    input.spawnedCount === 0 ||
    input.terminalCount === 0 ||
    input.progressCount === 0 ||
    input.subagentScopedRecordCount < input.recordCount ||
    input.currentActiveSubagentCount > 0 ||
    input.duplicateSpawnCount > 0 ||
    input.terminalWithoutSpawnCount > 0
  ) {
    return 'warn';
  }
  return 'complete';
}

function subagentOperatorEvidenceRecommendations(input: {
  readonly recordCount: number;
  readonly spawnedCount: number;
  readonly terminalCount: number;
  readonly progressCount: number;
  readonly currentActiveSubagentCount: number;
  readonly duplicateSpawnCount: number;
  readonly terminalWithoutSpawnCount: number;
  readonly replayAudit: SubagentOperatorEvidenceReplayAudit;
}): readonly string[] {
  const recommendations: string[] = [];
  if (input.replayAudit.unsafePayloadLineCount > 0) {
    recommendations.push(
      `Remove ${String(input.replayAudit.unsafePayloadLineCount)} unsafe subagent roster event line(s); retained evidence must not contain raw prompts, responses, instructions, messages, reasons, credentials, or raw artifact payloads.`,
    );
  }
  if (input.replayAudit.skippedMalformedLineCount > 0) {
    recommendations.push(
      `Review ${String(input.replayAudit.skippedMalformedLineCount)} malformed/torn roster JSONL line(s); they were excluded from scoring.`,
    );
  }
  if (input.recordCount === 0) {
    recommendations.push('Record at least one subagent.spawned and one terminal roster event before promoting operator-surface evidence.');
  }
  if (input.spawnedCount === 0) recommendations.push('Record at least one subagent.spawned event.');
  if (input.terminalCount === 0) recommendations.push('Record at least one subagent terminal event.');
  if (input.progressCount === 0) recommendations.push('Record at least one roster.progress sample from the root-owned roster.');
  if (input.currentActiveSubagentCount > 0) {
    recommendations.push(`Resolve ${String(input.currentActiveSubagentCount)} active subagent transition(s) before treating retained evidence as complete.`);
  }
  if (input.duplicateSpawnCount > 0) {
    recommendations.push(`Investigate ${String(input.duplicateSpawnCount)} duplicate subagent spawn transition(s).`);
  }
  if (input.terminalWithoutSpawnCount > 0) {
    recommendations.push(`Investigate ${String(input.terminalWithoutSpawnCount)} terminal-without-spawn transition(s).`);
  }
  if (recommendations.length === 0) {
    recommendations.push('Subagent operator retained evidence meets the local scorecard threshold; live operator control remains deployment-gated.');
  }
  return recommendations;
}

function readSubagentOperatorEvidenceLedgerFile(
  ledgerPath: string,
  maxLedgerBytes: number,
): {
  readonly records: readonly SubagentOperatorEvidenceRecord[];
  readonly replayAudit: SubagentOperatorEvidenceReplayAudit;
} {
  let stat;
  try {
    stat = lstatSync(ledgerPath);
  } catch (error) {
    throw new Error(`--ledger path does not exist: ${ledgerPath}`, { cause: error });
  }
  if (!stat.isFile()) throw new Error(`--ledger path is not a regular file: ${ledgerPath}`);
  if (!Number.isSafeInteger(maxLedgerBytes) || maxLedgerBytes <= 0) {
    throw new Error('--max-ledger-bytes must be a positive safe integer.');
  }
  if (stat.size > maxLedgerBytes) {
    throw new Error(`--ledger file exceeds --max-ledger-bytes (${String(stat.size)} > ${String(maxLedgerBytes)}).`);
  }
  return replaySubagentOperatorEvidenceJsonl(readFileSync(ledgerPath, 'utf8'));
}

function replaySubagentOperatorEvidenceJsonl(content: string): {
  readonly records: readonly SubagentOperatorEvidenceRecord[];
  readonly replayAudit: SubagentOperatorEvidenceReplayAudit;
} {
  const records: SubagentOperatorEvidenceRecord[] = [];
  let totalLineCount = 0;
  let emptyLineCount = 0;
  let skippedMalformedLineCount = 0;
  let unsafePayloadLineCount = 0;

  for (const line of content.split('\n')) {
    totalLineCount += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      emptyLineCount += 1;
      continue;
    }
    try {
      const raw: unknown = JSON.parse(trimmed);
      if (!isRecord(raw) || !isSubagentOperatorEvidenceEventKind(raw['kind'])) {
        skippedMalformedLineCount += 1;
        continue;
      }
      if (hasUnsafeSubagentOperatorEvidencePayload(raw)) {
        unsafePayloadLineCount += 1;
        continue;
      }
      const parsed = parseSubagentOperatorEvidenceRecord(raw);
      if (parsed === undefined) {
        skippedMalformedLineCount += 1;
        continue;
      }
      records.push(parsed);
    } catch {
      skippedMalformedLineCount += 1;
    }
  }

  return {
    records,
    replayAudit: {
      source: 'jsonl',
      totalLineCount,
      emptyLineCount,
      parsedRecordCount: records.length,
      skippedMalformedLineCount,
      unsafePayloadLineCount,
    },
  };
}

function parseSubagentOperatorEvidenceRecord(
  raw: Record<string, unknown>,
): SubagentOperatorEvidenceRecord | undefined {
  const eventKind = raw['kind'];
  if (!isSubagentOperatorEvidenceEventKind(eventKind)) return undefined;
  const timestamp = raw['timestamp'];
  if (typeof timestamp !== 'string' || !isIsoInstant(timestamp)) return undefined;
  const correlationKey = isRecord(raw['correlationKey']) ? raw['correlationKey'] : undefined;
  const subagentId = optionalString(correlationKey?.['subagentId']);
  const taskId = optionalString(correlationKey?.['taskId']);
  const instanceId = optionalString(correlationKey?.['instanceId']);
  const descriptor = isRecord(raw['descriptor']) ? raw['descriptor'] : undefined;
  const role = optionalSafeRole(descriptor?.['role']);
  const state = optionalSafeState(descriptor?.['state']);
  const cause = isRecord(raw['cause']) ? raw['cause'] : undefined;
  const terminalKind = optionalString(cause?.['kind']);
  return {
    observedAt: timestamp,
    eventKind,
    hasSubagentId: subagentId !== undefined,
    hasParentTask: taskId !== undefined,
    hasParentRuntime: instanceId !== undefined,
    ...(role === undefined ? {} : { role }),
    ...(state === undefined ? {} : { state }),
    ...(terminalKind === undefined ? {} : { terminalKind }),
    ...(subagentId === undefined ? {} : { subagentStateKey: subagentId }),
  };
}

function filterSubagentOperatorEvidenceRecords(
  records: readonly SubagentOperatorEvidenceRecord[],
  filter: SubagentOperatorEvidenceReportCliOptions['filter'],
): readonly SubagentOperatorEvidenceRecord[] {
  const filtered = records.filter((record) =>
    filter.eventKind === undefined ? true : record.eventKind === filter.eventKind,
  );
  return filter.limit === undefined ? filtered : filtered.slice(-Math.max(0, filter.limit));
}

const UNSAFE_SUBAGENT_OPERATOR_KEYS = new Set([
  'text',
  'content',
  'message',
  'reason',
  'instruction',
  'instructions',
  'rawInstruction',
  'prompt',
  'rawPrompt',
  'response',
  'rawResponse',
  'payload',
  'rawPayload',
  'rawArtifact',
  'artifactPayload',
  'artifactContent',
  'apiKey',
  'api_key',
  'authorization',
  'Authorization',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'password',
  'secret',
  'credential',
  'credentials',
  'privateKey',
  'private_key',
]);
const UNSAFE_SUBAGENT_OPERATOR_SCAN_MAX_DEPTH = 16;

function hasUnsafeSubagentOperatorEvidencePayload(value: unknown): boolean {
  return hasUnsafeSubagentOperatorEvidencePayloadRecursive(
    value,
    new WeakSet<object>(),
    [],
  );
}

function hasUnsafeSubagentOperatorEvidencePayloadRecursive(
  value: unknown,
  seen: WeakSet<object>,
  path: readonly string[],
): boolean {
  if (path.length > UNSAFE_SUBAGENT_OPERATOR_SCAN_MAX_DEPTH) return true;
  const currentKey = path[path.length - 1];
  if (currentKey === 'artifact' || currentKey === 'partialArtifact') {
    return !isSafeSubagentOperatorArtifactReference(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.some((item, index) =>
      hasUnsafeSubagentOperatorEvidencePayloadRecursive(item, seen, [...path, String(index)]),
    );
  }
  if (!isRecord(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(
    ([key, nested]) =>
      UNSAFE_SUBAGENT_OPERATOR_KEYS.has(key) ||
      hasUnsafeSubagentOperatorEvidencePayloadRecursive(nested, seen, [...path, key]),
  );
}

const SAFE_ARTIFACT_REFERENCE_KEYS = new Set(['digest', 'ref']);

function isSafeSubagentOperatorArtifactReference(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length === 0) return true;
  return entries.every(([key, nested]) => {
    if (!SAFE_ARTIFACT_REFERENCE_KEYS.has(key)) return false;
    return isSafeArtifactReferenceValue(nested);
  });
}

function isSafeArtifactReferenceValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 512) return false;
  if (/[\r\n]/u.test(value)) return false;
  return !/(?:SECRET|sk-[A-Za-z0-9_-]+|glpat-[A-Za-z0-9_-]+|token|password|private[-_ ]?key)/iu.test(
    value,
  );
}

function isTerminalEventKind(kind: SubagentOperatorEvidenceEventKind): boolean {
  return (
    kind === 'subagent.completed' ||
    kind === 'subagent.aborted' ||
    kind === 'subagent.failed'
  );
}

function isSubagentOperatorEvidenceEventKind(
  value: unknown,
): value is SubagentOperatorEvidenceEventKind {
  return typeof value === 'string' && SOURCE_EVENTS.includes(value as never);
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalSafeRole(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z-]+$/u.test(value) ? value : undefined;
}

function optionalSafeState(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z-]+$/u.test(value) ? value : undefined;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireCliValue(argv: readonly string[], index: number, optionName: string): string {
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
  if (!Number.isFinite(date.getTime())) return false;
  const canonicalInput = value.includes('.') ? value : value.replace(/Z$/u, '.000Z');
  return date.toISOString() === canonicalInput;
}
