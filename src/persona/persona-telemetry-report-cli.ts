import { lstatSync, readFileSync } from 'node:fs';

export const PERSONA_TELEMETRY_REPORT_SCHEMA_VERSION = 1;
export const PERSONA_TELEMETRY_REPORT_RUBRIC_VERSION =
  '2026-05-05.persona-telemetry-v1' as const;
export const PERSONA_TELEMETRY_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES =
  5 * 1024 * 1024;

export type PersonaTelemetryOutcome = 'success' | 'fallback';
export type PersonaTelemetryReportStatus =
  | 'complete'
  | 'warn'
  | 'fail'
  | 'no-record';

export interface PersonaTelemetryRecord {
  readonly eventType: string;
  readonly model: string;
  readonly outcome: PersonaTelemetryOutcome;
  readonly observedAt?: string;
  readonly fallbackReason?: string;
  readonly durationMs?: number;
  readonly latencyBudgetMs?: number;
  readonly withinLatencyBudget?: boolean;
  readonly inputChars?: number;
  readonly outputChars?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly humanReviewedNoSourceDialogueCopy?: boolean;
}

export interface PersonaTelemetryReplayAudit {
  readonly source: 'jsonl';
  readonly totalLineCount: number;
  readonly emptyLineCount: number;
  readonly parsedObservationCount: number;
  readonly skippedNonObservationLineCount: number;
  readonly skippedMalformedLineCount: number;
  readonly unsafeRawContentLineCount: number;
}

export interface PersonaTelemetryReportCliIo {
  readonly stdout: {
    write(chunk: string): void;
  };
  readonly stderr: {
    write(chunk: string): void;
  };
}

export interface PersonaTelemetryReportCliOptions {
  readonly ledgerPath?: string;
  readonly filter: {
    readonly eventType?: string;
    readonly model?: string;
    readonly outcome?: PersonaTelemetryOutcome;
    readonly limit?: number;
  };
  readonly maxLedgerBytes: number;
  readonly generatedAt?: string;
  readonly pretty: boolean;
  readonly printTemplate: boolean;
}

export interface PersonaTelemetryTemplateRecord {
  readonly event: 'persona-transform-observed';
  readonly details: {
    readonly eventType: 'template.persona-transform';
    readonly model: 'persona-template';
    readonly outcome: 'success';
    readonly observedAt: string;
    readonly durationMs: 0;
    readonly latencyBudgetMs: 500;
    readonly withinLatencyBudget: true;
    readonly inputChars: 0;
    readonly outputChars: 0;
    readonly promptTokens: 0;
    readonly completionTokens: 0;
    readonly totalTokens: 0;
    readonly humanReviewedNoSourceDialogueCopy: false;
  };
}

export interface PersonaTelemetryReport {
  readonly schemaVersion: typeof PERSONA_TELEMETRY_REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly status: PersonaTelemetryReportStatus;
  readonly filter: PersonaTelemetryReportCliOptions['filter'];
  readonly method: {
    readonly sourceEvent: 'persona-transform-observed';
    readonly scoringRubricVersion: typeof PERSONA_TELEMETRY_REPORT_RUBRIC_VERSION;
    readonly promotionRule: string;
  };
  readonly replayAudit: PersonaTelemetryReplayAudit;
  readonly scorecard: {
    readonly recordCount: number;
    readonly successCount: number;
    readonly fallbackCount: number;
    readonly fallbackReasonCounts: Readonly<Record<string, number>>;
    readonly latencyBudgetSampleCount: number;
    readonly withinLatencyBudgetCount: number;
    readonly humanReviewedNoSourceDialogueCopyCount: number;
    readonly averageDurationMs: number;
    readonly totalTokens: number;
    readonly qualityScore: {
      readonly rubricVersion: typeof PERSONA_TELEMETRY_REPORT_RUBRIC_VERSION;
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
    readonly rawTextRendered: false;
    readonly taskIdsRendered: false;
  };
}

const USAGE = `Usage: pnpm persona:telemetry:report -- --ledger <path> [options]
       pnpm persona:telemetry:report -- --print-template [--generated-at <iso>]

Build a read-only scorecard from a redacted persona telemetry JSONL ledger.
The report consumes sampled persona-transform-observed metadata and never
renders raw prompt text, source dialogue, transformed text, task ids, or
credentials.

Use --print-template to emit one compact, non-promoting
persona-transform-observed JSONL skeleton for operator-owned telemetry setup.
The placeholder contains metadata only and remains WARN until replaced by at
least 5 real sampled observations with human no-copy review evidence.

Template mode accepts only --generated-at; it rejects --ledger, --event-type,
--model, --outcome, --limit, --max-ledger-bytes, and --pretty so the output
remains one compact JSONL line.

Accepted JSONL shapes:
  {"event":"persona-transform-observed","details":{...}}
  {"event":"persona-transform-observed", ...details}

Options:
  --ledger <path>            Required existing JSONL ledger path unless --print-template is set.
  --print-template           Print one non-promoting compact persona-transform-observed JSONL record instead of reading --ledger.
  --event-type <type>        Filter records by Discord delivery event type.
  --model <model>            Filter records by model.
  --outcome <value>          Filter by outcome: success | fallback.
  --limit <count>            Score only the bounded tail after other filters.
  --max-ledger-bytes <n>     Fail closed before reading beyond this many bytes (default: ${String(PERSONA_TELEMETRY_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES)}).
  --generated-at <iso>       Optional generatedAt timestamp to embed in the report.
  --pretty                   Pretty-print JSON output.
  --help                     Show this help text.

Boundary:
  This command is read-only. It does not call persona models, transform text,
  mutate or rotate ledgers, reload environment variables, or contact
  Discord/GitLab/provider services. The input ledger must contain metadata
  only; raw prompt text, source dialogue, transformed text, responses,
  credentials, and raw task instructions are unsafe and force report status
  fail.
`;

export function parsePersonaTelemetryReportCliArgs(
  argv: readonly string[],
): PersonaTelemetryReportCliOptions | 'help' {
  let ledgerPath: string | undefined;
  let eventType: string | undefined;
  let model: string | undefined;
  let outcome: PersonaTelemetryOutcome | undefined;
  let limit: number | undefined;
  let maxLedgerBytes = PERSONA_TELEMETRY_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES;
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
      case '--event-type':
        eventType = requireCliValue(argv, index, '--event-type');
        index += 1;
        break;
      case '--model':
        model = requireCliValue(argv, index, '--model');
        index += 1;
        break;
      case '--outcome': {
        const rawOutcome = requireCliValue(argv, index, '--outcome');
        if (rawOutcome !== 'success' && rawOutcome !== 'fallback') {
          throw new Error('--outcome must be one of: success, fallback.');
        }
        outcome = rawOutcome;
        index += 1;
        break;
      }
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
        eventType === undefined ? undefined : '--event-type',
        model === undefined ? undefined : '--model',
        outcome === undefined ? undefined : '--outcome',
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
      ...(eventType === undefined ? {} : { eventType }),
      ...(model === undefined ? {} : { model }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(limit === undefined ? {} : { limit }),
    },
    maxLedgerBytes,
    ...(generatedAt === undefined ? {} : { generatedAt }),
    pretty,
    printTemplate,
  };
}

export function buildPersonaTelemetryReportFromCliOptions(
  options: PersonaTelemetryReportCliOptions,
): PersonaTelemetryReport {
  if (options.printTemplate) {
    throw new Error('Cannot build a persona telemetry report from --print-template options.');
  }
  if (options.ledgerPath === undefined || options.ledgerPath.length === 0) {
    throw new Error('--ledger is required.');
  }
  const replay = readPersonaTelemetryLedgerFile(
    options.ledgerPath,
    options.maxLedgerBytes,
  );
  const filtered = filterPersonaTelemetryRecords(replay.records, options.filter);
  return buildPersonaTelemetryReport({
    records: filtered,
    replayAudit: replay.replayAudit,
    filter: options.filter,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  });
}

export function buildPersonaTelemetryTemplateFromCliOptions(
  options: PersonaTelemetryReportCliOptions,
): PersonaTelemetryTemplateRecord {
  const observedAt = options.generatedAt ?? new Date().toISOString();
  return {
    event: 'persona-transform-observed',
    details: {
      eventType: 'template.persona-transform',
      model: 'persona-template',
      outcome: 'success',
      observedAt,
      durationMs: 0,
      latencyBudgetMs: 500,
      withinLatencyBudget: true,
      inputChars: 0,
      outputChars: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      humanReviewedNoSourceDialogueCopy: false,
    },
  };
}

export function runPersonaTelemetryReportCli(
  argv: readonly string[],
  io: PersonaTelemetryReportCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  try {
    const options = parsePersonaTelemetryReportCliArgs(argv);
    if (options === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    if (options.printTemplate) {
      io.stdout.write(
        `${JSON.stringify(buildPersonaTelemetryTemplateFromCliOptions(options))}\n`,
      );
      return 0;
    }
    const report = buildPersonaTelemetryReportFromCliOptions(options);
    io.stdout.write(
      `${JSON.stringify(report, null, options.pretty ? 2 : undefined)}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(
      `persona:telemetry:report failed: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    );
    return 1;
  }
}

function buildPersonaTelemetryReport(input: {
  readonly records: readonly PersonaTelemetryRecord[];
  readonly replayAudit: PersonaTelemetryReplayAudit;
  readonly filter: PersonaTelemetryReportCliOptions['filter'];
  readonly generatedAt: string;
}): PersonaTelemetryReport {
  const recordCount = input.records.length;
  const successCount = input.records.filter(
    (record) => record.outcome === 'success',
  ).length;
  const fallbackCount = recordCount - successCount;
  const fallbackReasonCounts: Record<string, number> = {};
  let durationTotal = 0;
  let durationCount = 0;
  let totalTokens = 0;
  let latencyBudgetSampleCount = 0;
  let withinLatencyBudgetCount = 0;
  let humanReviewedNoSourceDialogueCopyCount = 0;

  for (const record of input.records) {
    if (record.fallbackReason !== undefined) {
      fallbackReasonCounts[record.fallbackReason] =
        (fallbackReasonCounts[record.fallbackReason] ?? 0) + 1;
    }
    if (record.durationMs !== undefined) {
      durationTotal += record.durationMs;
      durationCount += 1;
    }
    totalTokens += record.totalTokens ?? 0;
    if (record.withinLatencyBudget !== undefined) {
      latencyBudgetSampleCount += 1;
      if (record.withinLatencyBudget) {
        withinLatencyBudgetCount += 1;
      }
    }
    if (record.humanReviewedNoSourceDialogueCopy === true) {
      humanReviewedNoSourceDialogueCopyCount += 1;
    }
  }

  const successRate = rate(successCount, recordCount);
  const withinBudgetRate = rate(withinLatencyBudgetCount, latencyBudgetSampleCount);
  const humanReviewGate = humanReviewedNoSourceDialogueCopyCount > 0 ? 1 : 0;
  const sampleRate = Math.min(1, recordCount / 5);
  const qualityScoreValue = round4(
    40 * successRate +
      25 * withinBudgetRate +
      20 * humanReviewGate +
      15 * sampleRate,
  );
  const status = personaTelemetryReportStatus({
    recordCount,
    successRate,
    withinBudgetRate,
    latencyBudgetSampleCount,
    humanReviewedNoSourceDialogueCopyCount,
    replayAudit: input.replayAudit,
  });
  const recommendations = personaTelemetryRecommendations({
    recordCount,
    successRate,
    latencyBudgetSampleCount,
    withinBudgetRate,
    humanReviewedNoSourceDialogueCopyCount,
    replayAudit: input.replayAudit,
  });

  return {
    schemaVersion: PERSONA_TELEMETRY_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    status,
    filter: input.filter,
    method: {
      sourceEvent: 'persona-transform-observed',
      scoringRubricVersion: PERSONA_TELEMETRY_REPORT_RUBRIC_VERSION,
      promotionRule:
        'Require at least 5 redacted sampled observations, success rate >= 80%, latency-budget pass rate >= 80% when a budget is present, at least one human no-copy review, and zero unsafe raw-content lines before treating persona live telemetry as complete.',
    },
    replayAudit: input.replayAudit,
    scorecard: {
      recordCount,
      successCount,
      fallbackCount,
      fallbackReasonCounts,
      latencyBudgetSampleCount,
      withinLatencyBudgetCount,
      humanReviewedNoSourceDialogueCopyCount,
      averageDurationMs:
        durationCount === 0 ? 0 : round4(durationTotal / durationCount),
      totalTokens,
      qualityScore: {
        rubricVersion: PERSONA_TELEMETRY_REPORT_RUBRIC_VERSION,
        value: qualityScoreValue,
        max: 100,
        summary:
          recordCount === 0
            ? 'No persona telemetry observations were available for scoring.'
            : `Persona telemetry score ${String(qualityScoreValue)}/100 over ${String(recordCount)} observation(s).`,
      },
      recommendations,
    },
    boundary: {
      readOnly: true,
      liveServicesContacted: false,
      ledgerMutated: false,
      rawTextRendered: false,
      taskIdsRendered: false,
    },
  };
}

function personaTelemetryReportStatus(input: {
  readonly recordCount: number;
  readonly successRate: number;
  readonly latencyBudgetSampleCount: number;
  readonly withinBudgetRate: number;
  readonly humanReviewedNoSourceDialogueCopyCount: number;
  readonly replayAudit: PersonaTelemetryReplayAudit;
}): PersonaTelemetryReportStatus {
  if (input.replayAudit.unsafeRawContentLineCount > 0) {
    return 'fail';
  }
  if (input.recordCount === 0) {
    return 'no-record';
  }
  if (
    input.replayAudit.skippedMalformedLineCount > 0 ||
    input.recordCount < 5 ||
    input.successRate < 0.8 ||
    (input.latencyBudgetSampleCount > 0 && input.withinBudgetRate < 0.8) ||
    input.humanReviewedNoSourceDialogueCopyCount === 0
  ) {
    return 'warn';
  }
  return 'complete';
}

function personaTelemetryRecommendations(input: {
  readonly recordCount: number;
  readonly successRate: number;
  readonly latencyBudgetSampleCount: number;
  readonly withinBudgetRate: number;
  readonly humanReviewedNoSourceDialogueCopyCount: number;
  readonly replayAudit: PersonaTelemetryReplayAudit;
}): readonly string[] {
  const recommendations: string[] = [];
  if (input.replayAudit.unsafeRawContentLineCount > 0) {
    recommendations.push(
      `Remove ${String(input.replayAudit.unsafeRawContentLineCount)} unsafe raw-content telemetry line(s); persona telemetry ledgers must contain metadata only.`,
    );
  }
  if (input.replayAudit.skippedMalformedLineCount > 0) {
    recommendations.push(
      `Review ${String(input.replayAudit.skippedMalformedLineCount)} malformed/torn telemetry line(s); they were excluded from scoring.`,
    );
  }
  if (input.recordCount < 5) {
    recommendations.push(
      'Collect at least 5 sampled persona-transform-observed metadata records before treating the trend as live telemetry evidence.',
    );
  }
  if (input.successRate < 0.8) {
    recommendations.push(
      'Investigate persona fallback reasons before promoting the model/profile.',
    );
  }
  if (input.latencyBudgetSampleCount === 0) {
    recommendations.push(
      'Set AUTO_ARCHIVE_PERSONA_LATENCY_BUDGET_MS so latency-budget compliance can be scored.',
    );
  } else if (input.withinBudgetRate < 0.8) {
    recommendations.push(
      'Tune persona model/provider latency before enabling the profile broadly.',
    );
  }
  if (input.humanReviewedNoSourceDialogueCopyCount === 0) {
    recommendations.push(
      'Record a human review flag confirming that sampled persona output passed the source-copy safety check.',
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      'Persona telemetry meets the local scorecard threshold; keep live proof operator-gated until retained artifacts are reviewed.',
    );
  }
  return recommendations;
}

function readPersonaTelemetryLedgerFile(
  ledgerPath: string,
  maxLedgerBytes: number,
): {
  readonly records: readonly PersonaTelemetryRecord[];
  readonly replayAudit: PersonaTelemetryReplayAudit;
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
  return replayPersonaTelemetryJsonl(readFileSync(ledgerPath, 'utf8'));
}

function replayPersonaTelemetryJsonl(content: string): {
  readonly records: readonly PersonaTelemetryRecord[];
  readonly replayAudit: PersonaTelemetryReplayAudit;
} {
  const records: PersonaTelemetryRecord[] = [];
  let totalLineCount = 0;
  let emptyLineCount = 0;
  let skippedNonObservationLineCount = 0;
  let skippedMalformedLineCount = 0;
  let unsafeRawContentLineCount = 0;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      emptyLineCount += 1;
      continue;
    }
    totalLineCount += 1;
    try {
      const raw = JSON.parse(trimmed) as unknown;
      if (!isRecord(raw) || raw.event !== 'persona-transform-observed') {
        skippedNonObservationLineCount += 1;
        continue;
      }
      if (hasUnsafeRawContentKey(raw)) {
        unsafeRawContentLineCount += 1;
        continue;
      }
      const payload = isRecord(raw.details) ? raw.details : raw;
      const parsed = parsePersonaTelemetryRecord(payload);
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
      parsedObservationCount: records.length,
      skippedNonObservationLineCount,
      skippedMalformedLineCount,
      unsafeRawContentLineCount,
    },
  };
}

function parsePersonaTelemetryRecord(
  payload: Record<string, unknown>,
): PersonaTelemetryRecord | undefined {
  const eventType = optionalNonEmptyString(payload.eventType);
  const model = optionalNonEmptyString(payload.model);
  const outcome = payload.outcome;
  if (
    eventType === undefined ||
    model === undefined ||
    (outcome !== 'success' && outcome !== 'fallback')
  ) {
    return undefined;
  }
  const observedAt = optionalNonEmptyString(payload.observedAt);
  if (observedAt !== undefined && !isIsoInstant(observedAt)) {
    return undefined;
  }
  return {
    eventType,
    model,
    outcome,
    ...optionalStringField(payload, 'fallbackReason'),
    ...optionalStringField(payload, 'observedAt'),
    ...optionalNonNegativeNumberField(payload, 'durationMs'),
    ...optionalPositiveNumberField(payload, 'latencyBudgetMs'),
    ...optionalBooleanField(payload, 'withinLatencyBudget'),
    ...optionalNonNegativeNumberField(payload, 'inputChars'),
    ...optionalNonNegativeNumberField(payload, 'outputChars'),
    ...optionalNonNegativeNumberField(payload, 'promptTokens'),
    ...optionalNonNegativeNumberField(payload, 'completionTokens'),
    ...optionalNonNegativeNumberField(payload, 'totalTokens'),
    ...optionalBooleanField(payload, 'humanReviewedNoSourceDialogueCopy'),
  };
}

function filterPersonaTelemetryRecords(
  records: readonly PersonaTelemetryRecord[],
  filter: PersonaTelemetryReportCliOptions['filter'],
): readonly PersonaTelemetryRecord[] {
  const filtered = records.filter((record) => {
    if (filter.eventType !== undefined && record.eventType !== filter.eventType) {
      return false;
    }
    if (filter.model !== undefined && record.model !== filter.model) {
      return false;
    }
    if (filter.outcome !== undefined && record.outcome !== filter.outcome) {
      return false;
    }
    return true;
  });
  return filter.limit === undefined
    ? filtered
    : filtered.slice(-Math.max(0, filter.limit));
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

function optionalStringField(
  payload: Record<string, unknown>,
  field: string,
): Record<string, string> {
  const value = optionalNonEmptyString(payload[field]);
  return value === undefined ? {} : { [field]: value };
}

function optionalBooleanField(
  payload: Record<string, unknown>,
  field: string,
): Record<string, boolean> {
  return typeof payload[field] === 'boolean'
    ? { [field]: payload[field] }
    : {};
}

function optionalNonNegativeNumberField(
  payload: Record<string, unknown>,
  field: string,
): Record<string, number> {
  const value = payload[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? { [field]: value }
    : {};
}

function optionalPositiveNumberField(
  payload: Record<string, unknown>,
  field: string,
): Record<string, number> {
  const value = payload[field];
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? { [field]: value }
    : {};
}

const UNSAFE_RAW_CONTENT_KEYS = new Set([
  'text',
  'inputText',
  'outputText',
  'prompt',
  'completion',
  'messageContent',
  'dialogue',
  'response',
  'sourceText',
  'sourceDialogue',
  'targetText',
  'transformedText',
  'rawPrompt',
  'rawResponse',
  'rawInstruction',
  'taskId',
  'taskID',
  'task_id',
  'correlationId',
  'correlation_id',
  'requestId',
  'request_id',
  'runId',
  'run_id',
  'threadId',
  'thread_id',
  'conversationId',
  'conversation_id',
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
const UNSAFE_RAW_CONTENT_SCAN_MAX_DEPTH = 32;

function hasUnsafeRawContentKey(value: unknown): boolean {
  return hasUnsafeRawContentKeyRecursive(value, new WeakSet<object>(), 0);
}

function hasUnsafeRawContentKeyRecursive(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): boolean {
  if (depth > UNSAFE_RAW_CONTENT_SCAN_MAX_DEPTH) {
    return true;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return value.some((item) =>
      hasUnsafeRawContentKeyRecursive(item, seen, depth + 1),
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
      UNSAFE_RAW_CONTENT_KEYS.has(key) ||
      hasUnsafeRawContentKeyRecursive(nestedValue, seen, depth + 1),
  );
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
