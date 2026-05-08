import { statSync } from 'node:fs';

import {
  buildPlanaClaudeAdvisorAuditReport,
  JsonlPlanaClaudeAdvisorAuditLedger,
  type PlanaClaudeAdvisorAuditFilter,
  type PlanaClaudeAdvisorAuditReport,
  type PlanaClaudeAdvisorConsultationOutcome,
} from './plana-claude-runtime-advisor.js';
import type { PlanaAdvisorVerdict } from './plana-runtime-advisor.js';

export const PLANA_ADVISOR_EVENTS_TEMPLATE_RECORD_ID =
  'template-plana-advisor-event' as const;
export const PLANA_ADVISOR_EVENTS_TEMPLATE_TASK_ID =
  'template-task-redacted' as const;
export const PLANA_ADVISOR_EVENTS_TEMPLATE_INSTANCE_ID =
  'template-instance-redacted' as const;
export const PLANA_ADVISOR_EVENTS_TEMPLATE_MODEL =
  'template-claude-agent-advisor' as const;

export interface PlanaAdvisorEventsReportCliIo {
  readonly stdout: {
    write(chunk: string): void;
  };
  readonly stderr: {
    write(chunk: string): void;
  };
}

export interface PlanaAdvisorEventsReportCliOptions {
  readonly ledgerPath?: string;
  readonly filter: PlanaClaudeAdvisorAuditFilter;
  readonly maxLedgerBytes: number;
  readonly generatedAt?: string;
  readonly pretty: boolean;
  readonly printTemplate: boolean;
}

export interface PlanaAdvisorEventsTemplateRecord {
  readonly schemaVersion: 1;
  readonly recordId: typeof PLANA_ADVISOR_EVENTS_TEMPLATE_RECORD_ID;
  readonly recordedAt: string;
  readonly provider: 'claude-agent';
  readonly provenance: 'plana-claude-runtime-advisor';
  readonly taskId: typeof PLANA_ADVISOR_EVENTS_TEMPLATE_TASK_ID;
  readonly instanceId: typeof PLANA_ADVISOR_EVENTS_TEMPLATE_INSTANCE_ID;
  readonly eventKind: 'turn.started';
  readonly eventTimestamp: string;
  readonly eventItemType: 'template';
  readonly verdictStatus: 'skip';
  readonly consultationOutcome: 'advisor-error-fail-open';
  readonly model: typeof PLANA_ADVISOR_EVENTS_TEMPLATE_MODEL;
}

export const PLANA_ADVISOR_EVENTS_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES =
  100 * 1024 * 1024;

const USAGE = `Usage: pnpm plana:advisor:events:report -- --ledger <path> [options]
       pnpm plana:advisor:events:report -- --print-template [--generated-at <iso>]

Build a read-only Plana advisor events report from a redacted JSONL ledger.
Only valid advisor audit records are scored; malformed or torn JSONL lines are
counted in replayAudit and skipped by the replay loader. The CLI fails during
bounded replay before accepting bytes beyond the configured byte guard.

Use --print-template to emit one compact, non-promoting advisor audit JSONL
skeleton for operator-owned ledger setup. The placeholder contains metadata
only and remains insufficient for trend evidence until replaced by at least 5
real redacted advisor event records.

Template mode accepts only --generated-at; it rejects --ledger, --task-id,
--event-kind, --verdict, --consultation-outcome, --limit, --max-ledger-bytes,
and --pretty so the output remains one compact JSONL line.

Options:
  --ledger <path>                 Required existing JSONL ledger path.
  --print-template                Print one non-promoting compact advisor audit JSONL record instead of reading --ledger.
  --task-id <task-id>             Filter records by task id.
  --event-kind <kind>             Filter records by runtime event kind.
  --verdict <status>              Filter by verdict: approve | veto | skip.
  --consultation-outcome <value>  Filter by consultation outcome: consulted | advisor-error-fail-open | advisor-error-fail-closed.
  --limit <count>                 Score only the bounded tail after other filters.
  --max-ledger-bytes <n>          Fail closed during bounded replay beyond this many bytes (default: ${String(PLANA_ADVISOR_EVENTS_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES)}).
  --generated-at <iso>            Optional generatedAt timestamp to embed in the report.
  --pretty                       Pretty-print JSON output.
  --help                         Show this help text.

Filter semantics:
  Filters compose by AND. --limit is applied after all other filters and keeps
  the latest matching records.

Boundary:
  This command is read-only. It does not call Claude, run advisor reviews,
  dispatch tasks, alter decisions, mutate or rotate ledgers, reload environment
  variables, or contact Discord/GitLab/provider services. The input ledger is
  expected to contain redacted metadata only; prompt text, response text,
  free-form veto reasons, Discord content, and raw task instructions must not
  be present.
`;

export function parsePlanaAdvisorEventsReportCliArgs(
  argv: readonly string[],
): PlanaAdvisorEventsReportCliOptions | 'help' {
  let ledgerPath: string | undefined;
  let taskId: string | undefined;
  let eventKind: string | undefined;
  let verdictStatus: PlanaAdvisorVerdict['status'] | undefined;
  let consultationOutcome: PlanaClaudeAdvisorConsultationOutcome | undefined;
  let limit: number | undefined;
  let maxLedgerBytes = PLANA_ADVISOR_EVENTS_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES;
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
      case '--task-id':
        taskId = requireCliValue(argv, index, '--task-id');
        index += 1;
        break;
      case '--event-kind':
        eventKind = requireCliValue(argv, index, '--event-kind');
        index += 1;
        break;
      case '--verdict': {
        const rawVerdict = requireCliValue(argv, index, '--verdict');
        if (
          rawVerdict !== 'approve' &&
          rawVerdict !== 'veto' &&
          rawVerdict !== 'skip'
        ) {
          throw new Error('--verdict must be one of: approve, veto, skip.');
        }
        verdictStatus = rawVerdict;
        index += 1;
        break;
      }
      case '--consultation-outcome': {
        const rawOutcome = requireCliValue(
          argv,
          index,
          '--consultation-outcome',
        );
        if (
          rawOutcome !== 'consulted' &&
          rawOutcome !== 'advisor-error-fail-open' &&
          rawOutcome !== 'advisor-error-fail-closed'
        ) {
          throw new Error(
            '--consultation-outcome must be one of: consulted, advisor-error-fail-open, advisor-error-fail-closed.',
          );
        }
        consultationOutcome = rawOutcome;
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
        taskId === undefined ? undefined : '--task-id',
        eventKind === undefined ? undefined : '--event-kind',
        verdictStatus === undefined ? undefined : '--verdict',
        consultationOutcome === undefined ? undefined : '--consultation-outcome',
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
      ...(taskId === undefined ? {} : { taskId }),
      ...(eventKind === undefined ? {} : { eventKind }),
      ...(verdictStatus === undefined ? {} : { verdictStatus }),
      ...(consultationOutcome === undefined ? {} : { consultationOutcome }),
      ...(limit === undefined ? {} : { limit }),
    },
    maxLedgerBytes,
    ...(generatedAt === undefined ? {} : { generatedAt }),
    pretty,
    printTemplate,
  };
}

export function buildPlanaAdvisorEventsReportFromCliOptions(
  options: PlanaAdvisorEventsReportCliOptions,
): PlanaClaudeAdvisorAuditReport {
  if (options.printTemplate) {
    throw new Error(
      'Cannot build a Plana advisor events report from --print-template options.',
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

  const ledger = new JsonlPlanaClaudeAdvisorAuditLedger(options.ledgerPath);
  const replay = ledger.loadWithAudit({ maxBytes: options.maxLedgerBytes });
  return buildPlanaClaudeAdvisorAuditReport({
    records: replay.records,
    replayAudit: replay.replayAudit,
    filter: options.filter,
    ...(options.generatedAt === undefined
      ? {}
      : { generatedAt: options.generatedAt }),
  });
}

export function buildPlanaAdvisorEventsTemplateFromCliOptions(
  options: PlanaAdvisorEventsReportCliOptions,
): PlanaAdvisorEventsTemplateRecord {
  const recordedAt = options.generatedAt ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    recordId: PLANA_ADVISOR_EVENTS_TEMPLATE_RECORD_ID,
    recordedAt,
    provider: 'claude-agent',
    provenance: 'plana-claude-runtime-advisor',
    taskId: PLANA_ADVISOR_EVENTS_TEMPLATE_TASK_ID,
    instanceId: PLANA_ADVISOR_EVENTS_TEMPLATE_INSTANCE_ID,
    eventKind: 'turn.started',
    eventTimestamp: recordedAt,
    eventItemType: 'template',
    verdictStatus: 'skip',
    consultationOutcome: 'advisor-error-fail-open',
    model: PLANA_ADVISOR_EVENTS_TEMPLATE_MODEL,
  };
}

export function runPlanaAdvisorEventsReportCli(
  argv: readonly string[],
  io: PlanaAdvisorEventsReportCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  try {
    const options = parsePlanaAdvisorEventsReportCliArgs(argv);
    if (options === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    if (options.printTemplate) {
      io.stdout.write(
        `${JSON.stringify(buildPlanaAdvisorEventsTemplateFromCliOptions(options))}\n`,
      );
      return 0;
    }
    const report = buildPlanaAdvisorEventsReportFromCliOptions(options);
    io.stdout.write(
      `${JSON.stringify(report, null, options.pretty ? 2 : undefined)}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(
      `plana:advisor:events:report failed: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
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
