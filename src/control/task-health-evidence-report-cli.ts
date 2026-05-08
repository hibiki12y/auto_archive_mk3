import { lstatSync, readFileSync } from 'node:fs';

import {
  parseControlPlaneEvent,
  type ControlPlaneEvent,
} from './control-plane-ledger.js';
import {
  TASK_HEALTH_STALL_CONTROL_PLANE_PHASE,
  TASK_HEALTH_STALL_CONTROL_PLANE_PROVENANCE,
  TASK_HEALTH_STALL_CONTROL_PLANE_SCOPE,
} from './task-health-control-plane-recorder.js';

export const TASK_HEALTH_EVIDENCE_REPORT_SCHEMA_VERSION = 1;
export const TASK_HEALTH_EVIDENCE_REPORT_RUBRIC_VERSION =
  '2026-05-05.task-health-evidence-v1' as const;
export const TASK_HEALTH_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES =
  10 * 1024 * 1024;

export type TaskHealthEvidenceReportStatus =
  | 'complete'
  | 'warn'
  | 'fail'
  | 'no-record';

export interface TaskHealthEvidenceRecord {
  readonly observedAt: string;
  readonly lastProgressAt: string;
  readonly thresholdMs: number;
  readonly lastEventKind: string;
  readonly hasTaskId: boolean;
  readonly hasCorrelationId: boolean;
}

export interface TaskHealthEvidenceReplayAudit {
  readonly source: 'jsonl';
  readonly totalLineCount: number;
  readonly emptyLineCount: number;
  readonly parsedEventCount: number;
  readonly parsedTaskHealthRecordCount: number;
  readonly skippedNonTaskHealthLineCount: number;
  readonly skippedMalformedLineCount: number;
  readonly unsafePayloadLineCount: number;
}

export interface TaskHealthEvidenceReportCliIo {
  readonly stdout: {
    write(chunk: string): void;
  };
  readonly stderr: {
    write(chunk: string): void;
  };
}

export interface TaskHealthEvidenceReportCliOptions {
  readonly ledgerPath?: string;
  readonly filter: {
    readonly lastEventKind?: string;
    readonly limit?: number;
  };
  readonly maxLedgerBytes: number;
  readonly generatedAt?: string;
  readonly pretty: boolean;
  readonly printTemplate: boolean;
}

export interface TaskHealthEvidenceTemplateRecord {
  readonly schemaVersion: 1;
  readonly eventId: 'task-health-evidence-template';
  readonly timestamp: string;
  readonly type: 'task.health_stalled';
  readonly actor: {
    readonly kind: 'system';
  };
  readonly trust: {
    readonly source: 'system';
    readonly inputTrust: 'trusted';
  };
  readonly payload: {
    readonly phase: typeof TASK_HEALTH_STALL_CONTROL_PLANE_PHASE;
    readonly scope: typeof TASK_HEALTH_STALL_CONTROL_PLANE_SCOPE;
    readonly provenance: typeof TASK_HEALTH_STALL_CONTROL_PLANE_PROVENANCE;
    readonly lastProgressAt: string;
    readonly thresholdMs: 1000;
    readonly lastEventKind: 'template.progress';
  };
}

export interface TaskHealthEvidenceReport {
  readonly schemaVersion: typeof TASK_HEALTH_EVIDENCE_REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly status: TaskHealthEvidenceReportStatus;
  readonly filter: TaskHealthEvidenceReportCliOptions['filter'];
  readonly method: {
    readonly sourceEvent: 'task.health_stalled';
    readonly scoringRubricVersion: typeof TASK_HEALTH_EVIDENCE_REPORT_RUBRIC_VERSION;
    readonly promotionRule: string;
  };
  readonly replayAudit: TaskHealthEvidenceReplayAudit;
  readonly scorecard: {
    readonly recordCount: number;
    readonly taskScopedRecordCount: number;
    readonly correlationScopedRecordCount: number;
    readonly lastEventKindCounts: Readonly<Record<string, number>>;
    readonly averageStallMs: number;
    readonly maxStallMs: number;
    readonly maxThresholdMs: number;
    readonly lastObservedAt?: string;
    readonly qualityScore: {
      readonly rubricVersion: typeof TASK_HEALTH_EVIDENCE_REPORT_RUBRIC_VERSION;
      readonly value: number;
      readonly max: 100;
      readonly summary: string;
    };
    readonly recommendations: readonly string[];
  };
  readonly boundary: {
    readonly readOnly: true;
    readonly liveServicesContacted: false;
    readonly ledgerMutated: false;
    readonly rawTaskIdsRendered: false;
    readonly rawCorrelationIdsRendered: false;
    readonly rawPayloadRendered: false;
  };
}

const USAGE = `Usage: pnpm task:health:evidence:report -- --ledger <path> [options]
       pnpm task:health:evidence:report -- --print-template [--generated-at <iso>]

Build a read-only task health evidence report from a control-plane JSONL ledger.
Only task.health_stalled events with the safe task-health payload shape are
scored. The report never renders raw task ids, correlation ids, Discord content,
task instructions, or payload blobs.

Use --print-template to emit one compact, non-promoting task.health_stalled
control-plane JSONL skeleton for operator-owned task-health proof setup. The
placeholder omits raw task and runtime correlation scopes, so it remains WARN
until replaced by real retained stall evidence.

Template mode accepts only --generated-at; it rejects --ledger,
--last-event-kind, --limit, --max-ledger-bytes, and --pretty so the output
remains one compact JSONL line.

Options:
  --ledger <path>            Required existing control-plane JSONL ledger path unless --print-template is set.
  --print-template           Print one non-promoting compact task.health_stalled JSONL record instead of reading --ledger.
  --last-event-kind <kind>   Filter by the runtime event kind that last made progress.
  --limit <count>            Score only the bounded tail after other filters.
  --max-ledger-bytes <n>     Fail closed before reading beyond this many bytes (default: ${String(TASK_HEALTH_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES)}).
  --generated-at <iso>       Optional generatedAt timestamp to embed in the report.
  --pretty                   Pretty-print JSON output.
  --help                     Show this help text.

Boundary:
  This command is read-only. It does not run observers, tick task health,
  write control-plane events, mutate or rotate ledgers, reload environment
  variables, contact Discord/GitLab/provider services, or render raw task ids
  and correlation ids.
`;

export function parseTaskHealthEvidenceReportCliArgs(
  argv: readonly string[],
): TaskHealthEvidenceReportCliOptions | 'help' {
  let ledgerPath: string | undefined;
  let lastEventKind: string | undefined;
  let limit: number | undefined;
  let maxLedgerBytes = TASK_HEALTH_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES;
  let maxLedgerBytesProvided = false;
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
      case '--ledger':
        ledgerPath = requireCliValue(argv, index, '--ledger');
        index += 1;
        break;
      case '--last-event-kind':
        lastEventKind = requireCliValue(argv, index, '--last-event-kind');
        index += 1;
        break;
      case '--limit': {
        const rawLimit = requireCliValue(argv, index, '--limit');
        const parsedLimit = Number(rawLimit);
        if (!Number.isInteger(parsedLimit) || parsedLimit < 0) {
          throw new Error('--limit must be a non-negative integer.');
        }
        limit = parsedLimit;
        index += 1;
        break;
      }
      case '--max-ledger-bytes': {
        const rawMaxLedgerBytes = requireCliValue(
          argv,
          index,
          '--max-ledger-bytes',
        );
        const parsedMaxLedgerBytes = Number(rawMaxLedgerBytes);
        if (
          !Number.isSafeInteger(parsedMaxLedgerBytes) ||
          parsedMaxLedgerBytes <= 0
        ) {
          throw new Error('--max-ledger-bytes must be a positive safe integer.');
        }
        maxLedgerBytes = parsedMaxLedgerBytes;
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

  if (ledgerPath === undefined || ledgerPath.length === 0) {
    if (printTemplate) {
      const reportOnlyOptions = [
        lastEventKind === undefined ? undefined : '--last-event-kind',
        limit === undefined ? undefined : '--limit',
        maxLedgerBytesProvided ? '--max-ledger-bytes' : undefined,
        pretty ? '--pretty' : undefined,
      ].filter((option): option is string => option !== undefined);
      if (reportOnlyOptions.length > 0) {
        throw new Error(
          `--print-template cannot be combined with report-only options: ${reportOnlyOptions.join(', ')}.`,
        );
      }
      return {
        filter: {},
        maxLedgerBytes,
        ...(generatedAt === undefined ? {} : { generatedAt }),
        pretty: false,
        printTemplate,
      };
    }
    throw new Error('--ledger is required.');
  }

  if (printTemplate) {
    throw new Error('--print-template cannot be combined with --ledger.');
  }

  return {
    ledgerPath,
    filter: {
      ...(lastEventKind === undefined ? {} : { lastEventKind }),
      ...(limit === undefined ? {} : { limit }),
    },
    maxLedgerBytes,
    ...(generatedAt === undefined ? {} : { generatedAt }),
    pretty,
    printTemplate,
  };
}

export function buildTaskHealthEvidenceReportFromCliOptions(
  options: TaskHealthEvidenceReportCliOptions,
): TaskHealthEvidenceReport {
  if (options.printTemplate) {
    throw new Error('Cannot build a task health evidence report from --print-template options.');
  }
  if (options.ledgerPath === undefined || options.ledgerPath.length === 0) {
    throw new Error('--ledger is required.');
  }
  const replay = readTaskHealthEvidenceLedgerFile(
    options.ledgerPath,
    options.maxLedgerBytes,
  );
  const filtered = filterTaskHealthEvidenceRecords(
    replay.records,
    options.filter,
  );
  return buildTaskHealthEvidenceReport({
    records: filtered,
    replayAudit: replay.replayAudit,
    filter: options.filter,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  });
}

export function buildTaskHealthEvidenceTemplateFromCliOptions(
  options: TaskHealthEvidenceReportCliOptions,
): TaskHealthEvidenceTemplateRecord {
  const observedAt = options.generatedAt ?? new Date().toISOString();
  const lastProgressAt = new Date(Date.parse(observedAt) - 1000).toISOString();
  return {
    schemaVersion: 1,
    eventId: 'task-health-evidence-template',
    timestamp: observedAt,
    type: 'task.health_stalled',
    actor: { kind: 'system' },
    trust: { source: 'system', inputTrust: 'trusted' },
    payload: {
      phase: TASK_HEALTH_STALL_CONTROL_PLANE_PHASE,
      scope: TASK_HEALTH_STALL_CONTROL_PLANE_SCOPE,
      provenance: TASK_HEALTH_STALL_CONTROL_PLANE_PROVENANCE,
      lastProgressAt,
      thresholdMs: 1000,
      lastEventKind: 'template.progress',
    },
  };
}

export function runTaskHealthEvidenceReportCli(
  argv: readonly string[],
  io: TaskHealthEvidenceReportCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  try {
    const options = parseTaskHealthEvidenceReportCliArgs(argv);
    if (options === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    if (options.printTemplate) {
      io.stdout.write(
        `${JSON.stringify(buildTaskHealthEvidenceTemplateFromCliOptions(options))}\n`,
      );
      return 0;
    }
    const report = buildTaskHealthEvidenceReportFromCliOptions(options);
    io.stdout.write(
      `${JSON.stringify(report, null, options.pretty ? 2 : undefined)}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(
      `task:health:evidence:report failed: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    );
    return 1;
  }
}

function buildTaskHealthEvidenceReport(input: {
  readonly records: readonly TaskHealthEvidenceRecord[];
  readonly replayAudit: TaskHealthEvidenceReplayAudit;
  readonly filter: TaskHealthEvidenceReportCliOptions['filter'];
  readonly generatedAt: string;
}): TaskHealthEvidenceReport {
  const recordCount = input.records.length;
  let taskScopedRecordCount = 0;
  let correlationScopedRecordCount = 0;
  let totalStallMs = 0;
  let maxStallMs = 0;
  let maxThresholdMs = 0;
  let lastObservedAt: string | undefined;
  const lastEventKindCounts: Record<string, number> = {};

  for (const record of input.records) {
    if (record.hasTaskId) {
      taskScopedRecordCount += 1;
    }
    if (record.hasCorrelationId) {
      correlationScopedRecordCount += 1;
    }
    const stallMs = Date.parse(record.observedAt) - Date.parse(record.lastProgressAt);
    totalStallMs += Math.max(0, stallMs);
    maxStallMs = Math.max(maxStallMs, Math.max(0, stallMs));
    maxThresholdMs = Math.max(maxThresholdMs, record.thresholdMs);
    lastObservedAt =
      lastObservedAt === undefined || record.observedAt > lastObservedAt
        ? record.observedAt
        : lastObservedAt;
    lastEventKindCounts[record.lastEventKind] =
      (lastEventKindCounts[record.lastEventKind] ?? 0) + 1;
  }

  const taskScopedRate = rate(taskScopedRecordCount, recordCount);
  const correlationScopedRate = rate(correlationScopedRecordCount, recordCount);
  const cleanReplayGate =
    input.replayAudit.skippedMalformedLineCount === 0 &&
    input.replayAudit.unsafePayloadLineCount === 0
      ? 1
      : 0;
  const evidencePresenceGate = recordCount > 0 ? 1 : 0;
  const qualityScoreValue = round4(
    35 * evidencePresenceGate +
      20 * taskScopedRate +
      20 * correlationScopedRate +
      25 * cleanReplayGate,
  );
  const status = taskHealthEvidenceReportStatus({
    recordCount,
    taskScopedRecordCount,
    correlationScopedRecordCount,
    replayAudit: input.replayAudit,
  });
  const recommendations = taskHealthEvidenceRecommendations({
    recordCount,
    taskScopedRecordCount,
    correlationScopedRecordCount,
    replayAudit: input.replayAudit,
  });

  return {
    schemaVersion: TASK_HEALTH_EVIDENCE_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    status,
    filter: input.filter,
    method: {
      sourceEvent: 'task.health_stalled',
      scoringRubricVersion: TASK_HEALTH_EVIDENCE_REPORT_RUBRIC_VERSION,
      promotionRule:
        'Require at least one valid task.health_stalled control-plane event with task and runtime correlation scopes, zero unsafe payload lines, and zero malformed/torn task-health lines before treating retained task-health evidence as complete.',
    },
    replayAudit: input.replayAudit,
    scorecard: {
      recordCount,
      taskScopedRecordCount,
      correlationScopedRecordCount,
      lastEventKindCounts,
      averageStallMs: recordCount === 0 ? 0 : round4(totalStallMs / recordCount),
      maxStallMs,
      maxThresholdMs,
      ...(lastObservedAt === undefined ? {} : { lastObservedAt }),
      qualityScore: {
        rubricVersion: TASK_HEALTH_EVIDENCE_REPORT_RUBRIC_VERSION,
        value: qualityScoreValue,
        max: 100,
        summary:
          recordCount === 0
            ? 'No task.health_stalled evidence records were available for scoring.'
            : `Task health evidence score ${String(qualityScoreValue)}/100 over ${String(recordCount)} stall event(s).`,
      },
      recommendations,
    },
    boundary: {
      readOnly: true,
      liveServicesContacted: false,
      ledgerMutated: false,
      rawTaskIdsRendered: false,
      rawCorrelationIdsRendered: false,
      rawPayloadRendered: false,
    },
  };
}

function taskHealthEvidenceReportStatus(input: {
  readonly recordCount: number;
  readonly taskScopedRecordCount: number;
  readonly correlationScopedRecordCount: number;
  readonly replayAudit: TaskHealthEvidenceReplayAudit;
}): TaskHealthEvidenceReportStatus {
  if (input.replayAudit.unsafePayloadLineCount > 0) {
    return 'fail';
  }
  if (input.recordCount === 0) {
    return 'no-record';
  }
  if (
    input.replayAudit.skippedMalformedLineCount > 0 ||
    input.taskScopedRecordCount < input.recordCount ||
    input.correlationScopedRecordCount < input.recordCount
  ) {
    return 'warn';
  }
  return 'complete';
}

function taskHealthEvidenceRecommendations(input: {
  readonly recordCount: number;
  readonly taskScopedRecordCount: number;
  readonly correlationScopedRecordCount: number;
  readonly replayAudit: TaskHealthEvidenceReplayAudit;
}): readonly string[] {
  const recommendations: string[] = [];
  if (input.replayAudit.unsafePayloadLineCount > 0) {
    recommendations.push(
      `Remove ${String(input.replayAudit.unsafePayloadLineCount)} unsafe task-health payload line(s); retained evidence must contain task-health metadata only.`,
    );
  }
  if (input.replayAudit.skippedMalformedLineCount > 0) {
    recommendations.push(
      `Review ${String(input.replayAudit.skippedMalformedLineCount)} malformed/torn task-health JSONL line(s); they were excluded from scoring.`,
    );
  }
  if (input.recordCount === 0) {
    recommendations.push(
      'Record at least one task.health_stalled control-plane event before treating task-health live proof as retained evidence.',
    );
  }
  if (input.taskScopedRecordCount < input.recordCount) {
    recommendations.push(
      'Ensure every task-health stall event carries a task scope before promotion.',
    );
  }
  if (input.correlationScopedRecordCount < input.recordCount) {
    recommendations.push(
      'Ensure every task-health stall event carries a runtime correlation scope before promotion.',
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      'Task-health retained evidence meets the local scorecard threshold; keep live proof operator-gated until the retained artifact is reviewed.',
    );
  }
  return recommendations;
}

function readTaskHealthEvidenceLedgerFile(
  ledgerPath: string,
  maxLedgerBytes: number,
): {
  readonly records: readonly TaskHealthEvidenceRecord[];
  readonly replayAudit: TaskHealthEvidenceReplayAudit;
} {
  let stat;
  try {
    stat = lstatSync(ledgerPath);
  } catch (error) {
    throw new Error(`--ledger path does not exist: ${ledgerPath}`, {
      cause: error,
    });
  }
  if (!stat.isFile()) {
    throw new Error(`--ledger path is not a regular file: ${ledgerPath}`);
  }
  if (stat.size > maxLedgerBytes) {
    throw new Error(
      `--ledger file exceeds --max-ledger-bytes (${String(stat.size)} > ${String(maxLedgerBytes)}).`,
    );
  }
  if (!Number.isSafeInteger(maxLedgerBytes) || maxLedgerBytes <= 0) {
    throw new Error('--max-ledger-bytes must be a positive safe integer.');
  }
  return replayTaskHealthEvidenceJsonl(readFileSync(ledgerPath, 'utf8'));
}

function replayTaskHealthEvidenceJsonl(content: string): {
  readonly records: readonly TaskHealthEvidenceRecord[];
  readonly replayAudit: TaskHealthEvidenceReplayAudit;
} {
  const records: TaskHealthEvidenceRecord[] = [];
  let totalLineCount = 0;
  let emptyLineCount = 0;
  let parsedEventCount = 0;
  let skippedNonTaskHealthLineCount = 0;
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
      const event = parseControlPlaneEvent(JSON.parse(trimmed));
      if (event === undefined) {
        skippedMalformedLineCount += 1;
        continue;
      }
      parsedEventCount += 1;
      if (event.type !== 'task.health_stalled') {
        skippedNonTaskHealthLineCount += 1;
        continue;
      }
      if (hasUnsafeTaskHealthPayload(event.payload)) {
        unsafePayloadLineCount += 1;
        continue;
      }
      const parsed = parseTaskHealthEvidenceRecord(event);
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
      parsedEventCount,
      parsedTaskHealthRecordCount: records.length,
      skippedNonTaskHealthLineCount,
      skippedMalformedLineCount,
      unsafePayloadLineCount,
    },
  };
}

function parseTaskHealthEvidenceRecord(
  event: ControlPlaneEvent,
): TaskHealthEvidenceRecord | undefined {
  const payload = event.payload;
  if (
    payload['phase'] !== TASK_HEALTH_STALL_CONTROL_PLANE_PHASE ||
    payload['scope'] !== TASK_HEALTH_STALL_CONTROL_PLANE_SCOPE ||
    payload['provenance'] !== TASK_HEALTH_STALL_CONTROL_PLANE_PROVENANCE
  ) {
    return undefined;
  }
  const lastProgressAt = optionalIsoInstant(payload['lastProgressAt']);
  const thresholdMs = payload['thresholdMs'];
  const lastEventKind = optionalNonEmptyString(payload['lastEventKind']);
  if (
    !isIsoInstant(event.timestamp) ||
    lastProgressAt === undefined ||
    typeof thresholdMs !== 'number' ||
    !Number.isSafeInteger(thresholdMs) ||
    thresholdMs <= 0 ||
    lastEventKind === undefined
  ) {
    return undefined;
  }
  return {
    observedAt: event.timestamp,
    lastProgressAt,
    thresholdMs,
    lastEventKind,
    hasTaskId: event.taskId !== undefined,
    hasCorrelationId: event.correlationId !== undefined,
  };
}

function filterTaskHealthEvidenceRecords(
  records: readonly TaskHealthEvidenceRecord[],
  filter: TaskHealthEvidenceReportCliOptions['filter'],
): readonly TaskHealthEvidenceRecord[] {
  const filtered = records.filter((record) => {
    if (
      filter.lastEventKind !== undefined &&
      record.lastEventKind !== filter.lastEventKind
    ) {
      return false;
    }
    return true;
  });
  return filter.limit === undefined
    ? filtered
    : filtered.slice(-Math.max(0, filter.limit));
}

const UNSAFE_TASK_HEALTH_PAYLOAD_KEYS = new Set([
  'text',
  'content',
  'message',
  'messageContent',
  'instruction',
  'rawInstruction',
  'prompt',
  'rawPrompt',
  'response',
  'rawResponse',
  'reason',
  'note',
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
const UNSAFE_TASK_HEALTH_PAYLOAD_SCAN_MAX_DEPTH = 16;

function hasUnsafeTaskHealthPayload(value: unknown): boolean {
  return hasUnsafeTaskHealthPayloadRecursive(value, new WeakSet<object>(), 0);
}

function hasUnsafeTaskHealthPayloadRecursive(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): boolean {
  if (depth > UNSAFE_TASK_HEALTH_PAYLOAD_SCAN_MAX_DEPTH) {
    return true;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return value.some((item) =>
      hasUnsafeTaskHealthPayloadRecursive(item, seen, depth + 1),
    );
  }
  if (!isRecord(value)) {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  return Object.entries(value).some(
    ([key, nestedValue]) =>
      UNSAFE_TASK_HEALTH_PAYLOAD_KEYS.has(key) ||
      hasUnsafeTaskHealthPayloadRecursive(nestedValue, seen, depth + 1),
  );
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

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function optionalIsoInstant(value: unknown): string | undefined {
  return typeof value === 'string' && isIsoInstant(value) ? value : undefined;
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
  const canonicalInput = value.includes('.') ? value : value.replace(/Z$/u, '.000Z');
  return date.toISOString() === canonicalInput;
}
