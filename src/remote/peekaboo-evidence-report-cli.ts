import { statSync } from 'node:fs';

import {
  buildPeekabooEvidenceDigest,
  buildPeekabooQuantitativeReport,
  JsonlPeekabooEvidenceLedger,
  type PeekabooEvidenceRecord,
  type PeekabooEvidenceRecordFilter,
  type PeekabooQuantitativeReport,
} from './peekaboo-evidence-ledger.js';
import {
  buildPeekabooReadinessReport,
  type PeekabooExecutionMode,
} from './peekaboo-remote-evaluation.js';

export const PEEKABOO_EVIDENCE_TEMPLATE_RECORD_ID =
  'template-peekaboo-evidence' as const;
export const PEEKABOO_EVIDENCE_TEMPLATE_RUN_ID =
  'template-run-redacted' as const;
export const PEEKABOO_EVIDENCE_TEMPLATE_TURN_MARKER =
  'template-turn-redacted' as const;
export const PEEKABOO_EVIDENCE_TEMPLATE_CORRELATION_ID =
  'template-correlation-redacted' as const;
export const PEEKABOO_EVIDENCE_TEMPLATE_TASK_ID =
  'template-task-redacted' as const;

export interface PeekabooEvidenceReportCliIo {
  readonly stdout: {
    write(chunk: string): void;
  };
  readonly stderr: {
    write(chunk: string): void;
  };
}

export interface PeekabooEvidenceReportCliOptions {
  readonly ledgerPath?: string;
  readonly filter: PeekabooEvidenceRecordFilter;
  readonly maxLedgerBytes: number;
  readonly baselineRunId?: string;
  readonly candidateRunId?: string;
  readonly generatedAt?: string;
  readonly pretty: boolean;
  readonly printTemplate: boolean;
}

export const PEEKABOO_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES =
  100 * 1024 * 1024;

const USAGE = `Usage: pnpm peekaboo:evidence:report -- --ledger <path> [options]
       pnpm peekaboo:evidence:report -- --print-template [--generated-at <iso>]

Build a read-only Peekaboo remote-evaluation quantitative report from a JSONL
evidence ledger. Only valid evidence records are scored; malformed or torn
JSONL lines are counted in replayAudit and skipped by the replay loader. The
CLI fails during bounded replay before accepting bytes beyond the configured
byte guard.

Use --print-template to emit one compact, non-promoting dry-run evidence JSONL
skeleton for operator-owned ledger setup. The placeholder contains redacted
metadata only and remains insufficient for promotion because it is not live
GUI evidence.

Template mode accepts only --generated-at; it rejects --ledger, --run-id,
--turn-marker, --task-id, --correlation-id, --channel-id, --phase, --limit,
--baseline-run-id, --candidate-run-id, --max-ledger-bytes, and --pretty so the
output remains one compact JSONL line.

Options:
  --ledger <path>             Required existing JSONL ledger path.
  --print-template            Print one non-promoting compact dry-run evidence JSONL record instead of reading --ledger.
  --run-id <run-id>           Filter records by run id.
  --turn-marker <marker>      Filter records by turn marker.
  --task-id <task-id>         Filter records by task id.
  --correlation-id <id>       Filter records by correlation id.
  --channel-id <id>           Filter records by Discord channel id.
  --phase <phase>             Filter by phase: dry-run | probe | live.
  --limit <count>             Score only the bounded tail after other filters.
  --baseline-run-id <id>      Baseline run id for comparison.
  --candidate-run-id <id>     Candidate run id for comparison.
  --max-ledger-bytes <n>      Fail closed during bounded replay beyond this many bytes (default: ${String(PEEKABOO_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES)}).
  --generated-at <iso>        Optional generatedAt timestamp to embed in the report.
  --pretty                    Pretty-print JSON output.
  --help                      Show this help text.

Filter semantics:
  Filters compose by AND. --limit is applied after all other filters and keeps
  the latest matching records. Baseline/candidate comparison requires both ids.

Boundary:
  This command is read-only. It does not submit GUI actions, poll Discord,
  contact Peekaboo, mutate or rotate ledgers, reload environment variables, or
  contact provider services. The input ledger is expected to contain redacted
  metadata only; Discord message content, prompt text, responses, credentials,
  and raw task instructions must not be present.
`;

export function parsePeekabooEvidenceReportCliArgs(
  argv: readonly string[],
): PeekabooEvidenceReportCliOptions | 'help' {
  let ledgerPath: string | undefined;
  let runId: string | undefined;
  let turnMarker: string | undefined;
  let taskId: string | undefined;
  let correlationId: string | undefined;
  let channelId: string | undefined;
  let phase: PeekabooExecutionMode | undefined;
  let limit: number | undefined;
  let baselineRunId: string | undefined;
  let candidateRunId: string | undefined;
  let maxLedgerBytes = PEEKABOO_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES;
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
      case '--run-id':
        runId = requireCliValue(argv, index, '--run-id');
        index += 1;
        break;
      case '--turn-marker':
        turnMarker = requireCliValue(argv, index, '--turn-marker');
        index += 1;
        break;
      case '--task-id':
        taskId = requireCliValue(argv, index, '--task-id');
        index += 1;
        break;
      case '--correlation-id':
        correlationId = requireCliValue(argv, index, '--correlation-id');
        index += 1;
        break;
      case '--channel-id':
        channelId = requireCliValue(argv, index, '--channel-id');
        index += 1;
        break;
      case '--phase': {
        const rawPhase = requireCliValue(argv, index, '--phase');
        if (rawPhase !== 'dry-run' && rawPhase !== 'probe' && rawPhase !== 'live') {
          throw new Error('--phase must be one of: dry-run, probe, live.');
        }
        phase = rawPhase;
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
      case '--baseline-run-id':
        baselineRunId = requireCliValue(argv, index, '--baseline-run-id');
        index += 1;
        break;
      case '--candidate-run-id':
        candidateRunId = requireCliValue(argv, index, '--candidate-run-id');
        index += 1;
        break;
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
        runId === undefined ? undefined : '--run-id',
        turnMarker === undefined ? undefined : '--turn-marker',
        taskId === undefined ? undefined : '--task-id',
        correlationId === undefined ? undefined : '--correlation-id',
        channelId === undefined ? undefined : '--channel-id',
        phase === undefined ? undefined : '--phase',
        limit === undefined ? undefined : '--limit',
        baselineRunId === undefined ? undefined : '--baseline-run-id',
        candidateRunId === undefined ? undefined : '--candidate-run-id',
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
  if ((baselineRunId === undefined) !== (candidateRunId === undefined)) {
    throw new Error(
      '--baseline-run-id and --candidate-run-id must be provided together.',
    );
  }

  return {
    ledgerPath,
    filter: {
      ...(runId === undefined ? {} : { runId }),
      ...(turnMarker === undefined ? {} : { turnMarker }),
      ...(taskId === undefined ? {} : { taskId }),
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(channelId === undefined ? {} : { channelId }),
      ...(phase === undefined ? {} : { phase }),
      ...(limit === undefined ? {} : { limit }),
    },
    maxLedgerBytes,
    ...(baselineRunId === undefined ? {} : { baselineRunId }),
    ...(candidateRunId === undefined ? {} : { candidateRunId }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
    pretty,
    printTemplate,
  };
}

export function buildPeekabooEvidenceReportFromCliOptions(
  options: PeekabooEvidenceReportCliOptions,
): PeekabooQuantitativeReport {
  if (options.printTemplate) {
    throw new Error(
      'Cannot build a Peekaboo evidence report from --print-template options.',
    );
  }
  if (options.ledgerPath === undefined || options.ledgerPath.length === 0) {
    throw new Error('--ledger is required.');
  }
  try {
    if (!statSync(options.ledgerPath).isFile()) {
      throw new Error(`--ledger path is not a file: ${options.ledgerPath}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('--ledger path')) {
      throw error;
    }
    throw new Error(`--ledger path does not exist: ${options.ledgerPath}`, {
      cause: error,
    });
  }
  const replay = new JsonlPeekabooEvidenceLedger(options.ledgerPath).loadWithAudit({
    maxBytes: options.maxLedgerBytes,
  });
  return buildPeekabooQuantitativeReport({
    records: replay.records,
    replayAudit: replay.replayAudit,
    filter: options.filter,
    ...(options.baselineRunId === undefined
      ? {}
      : { baselineRunId: options.baselineRunId }),
    ...(options.candidateRunId === undefined
      ? {}
      : { candidateRunId: options.candidateRunId }),
    ...(options.generatedAt === undefined
      ? {}
      : { generatedAt: options.generatedAt }),
  });
}

export function buildPeekabooEvidenceTemplateFromCliOptions(
  options: PeekabooEvidenceReportCliOptions,
): PeekabooEvidenceRecord {
  const recordedAt = options.generatedAt ?? new Date().toISOString();
  const readiness = buildPeekabooReadinessReport({
    phase: 'dry-run',
    configOk: true,
    marker: PEEKABOO_EVIDENCE_TEMPLATE_TURN_MARKER,
    expectedTaskId: PEEKABOO_EVIDENCE_TEMPLATE_TASK_ID,
  });
  return buildPeekabooEvidenceDigest({
    recordId: PEEKABOO_EVIDENCE_TEMPLATE_RECORD_ID,
    recordedAt,
    runId: PEEKABOO_EVIDENCE_TEMPLATE_RUN_ID,
    turnMarker: PEEKABOO_EVIDENCE_TEMPLATE_TURN_MARKER,
    correlationId: PEEKABOO_EVIDENCE_TEMPLATE_CORRELATION_ID,
    readinessReport: readiness,
    evidence: readiness.evidence,
    outcome: 'WARN_TEMPLATE',
  });
}

export function runPeekabooEvidenceReportCli(
  argv: readonly string[],
  io: PeekabooEvidenceReportCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  try {
    const options = parsePeekabooEvidenceReportCliArgs(argv);
    if (options === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    if (options.printTemplate) {
      io.stdout.write(
        `${JSON.stringify(buildPeekabooEvidenceTemplateFromCliOptions(options))}\n`,
      );
      return 0;
    }
    const report = buildPeekabooEvidenceReportFromCliOptions(options);
    io.stdout.write(
      `${JSON.stringify(report, null, options.pretty ? 2 : undefined)}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(
      `peekaboo:evidence:report failed: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    );
    return 1;
  }
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
