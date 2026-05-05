import { statSync } from 'node:fs';

import {
  buildTraitSchedulerTickEvidenceReport,
  JsonlTraitSchedulerTickEvidenceLedger,
  type TraitSchedulerTickEvidenceFilter,
  type TraitSchedulerTickEvidenceRecord,
  type TraitSchedulerTickEvidenceReport,
} from './trait-scheduler-dispatch-runner.js';

export interface TraitSchedulerTickEvidenceReportCliIo {
  readonly stdout: {
    write(chunk: string): void;
  };
  readonly stderr: {
    write(chunk: string): void;
  };
}

export interface TraitSchedulerTickEvidenceReportCliOptions {
  readonly ledgerPath?: string;
  readonly filter: TraitSchedulerTickEvidenceFilter;
  readonly maxLedgerBytes: number;
  readonly generatedAt?: string;
  readonly pretty: boolean;
  readonly printTemplate: boolean;
}

export const TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES =
  100 * 1024 * 1024;

const USAGE = `Usage: pnpm trait:scheduler:evidence:report -- --ledger <path> [options]
       pnpm trait:scheduler:evidence:report -- --print-template [--generated-at <iso>]

Build a read-only TraitModule scheduler tick evidence report from a JSONL ledger.
Only valid, recoverable evidence records are scored; malformed or torn JSONL
lines are counted in replayAudit and skipped by the replay loader.
The CLI fails during bounded replay before accepting bytes beyond the configured
byte guard.

Use --print-template to emit one compact JSONL evidence-record skeleton. The
skeleton is intentionally non-promoting: it represents a held checkpoint with a
dispatch failure and must be replaced by real host-owned tick evidence.

Options:
  --ledger <path>        Required existing JSONL ledger path unless --print-template is set.
  --print-template       Print one non-promoting compact JSONL evidence record instead of reading --ledger.
  --source <source>      Filter records by evidence source.
  --status <status>      Filter by status: ran | skipped.
  --limit <count>        Score only the bounded tail after other filters.
  --max-ledger-bytes <n> Fail closed during bounded replay beyond this many bytes (default: ${String(TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES)}).
  --generated-at <iso>   Optional generatedAt timestamp to embed in the report.
  --pretty              Pretty-print JSON output.
  --help                Show this help text.

Boundary:
  This command is read-only. It does not run scheduler ticks, acquire leases,
  rotate ledgers, dispatch jobs, reload environment variables, or contact
  Discord/GitLab/provider services.
`;

export function parseTraitSchedulerTickEvidenceReportCliArgs(
  argv: readonly string[],
): TraitSchedulerTickEvidenceReportCliOptions | 'help' {
  let ledgerPath: string | undefined;
  let source: string | undefined;
  let status: TraitSchedulerTickEvidenceRecord['status'] | undefined;
  let limit: number | undefined;
  let maxLedgerBytes =
    TRAIT_SCHEDULER_TICK_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES;
  let generatedAt: string | undefined;
  let sourceProvided = false;
  let statusProvided = false;
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
      case '--source':
        source = requireCliValue(argv, index, '--source');
        sourceProvided = true;
        index += 1;
        break;
      case '--status': {
        const rawStatus = requireCliValue(argv, index, '--status');
        if (rawStatus !== 'ran' && rawStatus !== 'skipped') {
          throw new Error('--status must be one of: ran, skipped.');
        }
        status = rawStatus;
        statusProvided = true;
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
        limitProvided = true;
        index += 1;
        break;
      }
      case '--max-ledger-bytes': {
        const rawMaxLedgerBytes = requireCliValue(argv, index, '--max-ledger-bytes');
        const parsedMaxLedgerBytes = Number(rawMaxLedgerBytes);
        if (!Number.isSafeInteger(parsedMaxLedgerBytes) || parsedMaxLedgerBytes <= 0) {
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

  if (printTemplate && ledgerPath !== undefined) {
    throw new Error('--print-template cannot be combined with --ledger.');
  }
  if (
    printTemplate &&
    (sourceProvided ||
      statusProvided ||
      limitProvided ||
      maxLedgerBytesProvided ||
      pretty)
  ) {
    throw new Error(
      '--print-template cannot be combined with report-only options: --source, --status, --limit, --max-ledger-bytes, or --pretty.',
    );
  }

  if (!printTemplate && (ledgerPath === undefined || ledgerPath.length === 0)) {
    throw new Error('--ledger is required.');
  }

  return {
    ...(ledgerPath === undefined ? {} : { ledgerPath }),
    filter: {
      ...(source === undefined ? {} : { source }),
      ...(status === undefined ? {} : { status }),
      ...(limit === undefined ? {} : { limit }),
    },
    maxLedgerBytes,
    ...(generatedAt === undefined ? {} : { generatedAt }),
    pretty,
    printTemplate,
  };
}

export function buildTraitSchedulerTickEvidenceTemplateFromCliOptions(
  options: Pick<TraitSchedulerTickEvidenceReportCliOptions, 'generatedAt'>,
): TraitSchedulerTickEvidenceRecord {
  const recordedAt = options.generatedAt ?? new Date().toISOString();
  const observedStart = new Date(Date.parse(recordedAt) - 60_000).toISOString();
  const expiresAt = new Date(Date.parse(recordedAt) + 60_000).toISOString();
  return {
    schemaVersion: 1,
    recordId: 'trait-scheduler-tick-evidence-template',
    recordedAt,
    source: 'trait-scheduler-evidence-template',
    status: 'ran',
    lease: {
      status: 'acquired',
      leasePath: 'replace-with-operator-owned-lease-path',
      ownerId: 'template-operator',
      acquiredAt: recordedAt,
      expiresAt,
    },
    batch: {
      planTickedAt: recordedAt,
      windowStartExclusive: observedStart,
      windowEndInclusive: recordedAt,
      attemptedCount: 1,
      dispatchedCount: 0,
      failedCount: 1,
      skippedPlannedCount: 0,
      truncated: false,
      checkpointStatus: 'hold',
      checkpointHoldReasons: ['dispatch-failed'],
    },
  };
}

export function buildTraitSchedulerTickEvidenceReportFromCliOptions(
  options: TraitSchedulerTickEvidenceReportCliOptions,
): TraitSchedulerTickEvidenceReport {
  if (options.printTemplate) {
    throw new Error('Cannot build a Trait scheduler tick evidence report from --print-template options.');
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
  const ledger = new JsonlTraitSchedulerTickEvidenceLedger(options.ledgerPath);
  const replay = ledger.loadWithAudit({ maxBytes: options.maxLedgerBytes });
  return buildTraitSchedulerTickEvidenceReport({
    records: replay.records,
    replayAudit: replay.replayAudit,
    filter: options.filter,
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
  });
}

export function runTraitSchedulerTickEvidenceReportCli(
  argv: readonly string[],
  io: TraitSchedulerTickEvidenceReportCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  try {
    const options = parseTraitSchedulerTickEvidenceReportCliArgs(argv);
    if (options === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    if (options.printTemplate) {
      io.stdout.write(
        `${JSON.stringify(buildTraitSchedulerTickEvidenceTemplateFromCliOptions(options))}\n`,
      );
      return 0;
    }
    const report = buildTraitSchedulerTickEvidenceReportFromCliOptions(options);
    io.stdout.write(
      `${JSON.stringify(report, null, options.pretty ? 2 : undefined)}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(
      `trait:scheduler:evidence:report failed: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
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
