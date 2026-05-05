/**
 * Operator-facing report CLI for the Claude token offload ledger.
 *
 * Reads one or more JSONL ledger files written by
 * `JsonlClaudeOffloadLedger`, replays them with banned-key filtering, and
 * emits a structurally redacted JSON report covering counts, statuses,
 * and recency. The report is read-only: it never contacts Claude, never
 * writes to the ledger, and never expands raw response bodies (the
 * ledger does not retain them in the first place).
 *
 * Usage (via scripts/claude-token-offload-report.mjs):
 *
 *   pnpm build && node scripts/claude-token-offload-report.mjs \
 *     --ledger var/claude-token-offload.jsonl [--pretty] [--max-bytes N]
 */

import { lstatSync, readFileSync } from 'node:fs';

import {
  CLAUDE_OFFLOAD_LEDGER_DEFAULT_MAX_BYTES,
  CLAUDE_OFFLOAD_LEDGER_PROVENANCE,
  CLAUDE_OFFLOAD_LEDGER_SCHEMA_VERSION,
  JsonlClaudeOffloadLedger,
  buildClaudeOffloadLedgerScorecard,
  type ClaudeOffloadLedgerRecord,
  type ClaudeOffloadLedgerScorecard,
} from './claude-token-offload-ledger.js';

export const CLAUDE_OFFLOAD_REPORT_CLI_SCHEMA_VERSION = 1 as const;

export interface ClaudeOffloadReportCliIo {
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
}

export interface ClaudeOffloadReportCliOptions {
  readonly ledgerPaths: readonly string[];
  readonly maxBytes: number;
  readonly pretty: boolean;
  readonly generatedAt?: string;
}

export interface ClaudeOffloadReportSourceFile {
  readonly path: string;
  readonly recordCount: number;
  readonly skippedMalformedLineCount: number;
  readonly skippedUnsafeLineCount: number;
}

export interface ClaudeOffloadReport {
  readonly schemaVersion: typeof CLAUDE_OFFLOAD_REPORT_CLI_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly provenance: typeof CLAUDE_OFFLOAD_LEDGER_PROVENANCE;
  readonly source: {
    readonly ledgerSchemaVersion: typeof CLAUDE_OFFLOAD_LEDGER_SCHEMA_VERSION;
    readonly files: readonly ClaudeOffloadReportSourceFile[];
  };
  readonly scorecard: ClaudeOffloadLedgerScorecard;
  readonly boundary: {
    readonly readOnly: true;
    readonly liveServicesContacted: false;
    readonly ledgerFilesMutated: false;
    readonly rawPromptsRendered: false;
    readonly rawResponsesRendered: false;
  };
}

const USAGE = `Usage: claude-token-offload-report --ledger <path> [--ledger <path> ...] [--max-bytes <n>] [--pretty]

Reads metadata-only Claude offload ledger JSONL files and prints a redacted scorecard.
The ledger never carries raw prompts/responses; this CLI cannot expose them.
`;

export function parseClaudeOffloadReportCliArgs(
  argv: readonly string[],
): ClaudeOffloadReportCliOptions | 'help' {
  const ledgerPaths: string[] = [];
  let maxBytes = CLAUDE_OFFLOAD_LEDGER_DEFAULT_MAX_BYTES;
  let pretty = false;
  let generatedAt: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        return 'help';
      case '--ledger': {
        const value = argv[i + 1];
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error('--ledger requires a path argument');
        }
        ledgerPaths.push(value);
        i += 1;
        break;
      }
      case '--max-bytes': {
        const value = argv[i + 1];
        if (typeof value !== 'string') {
          throw new Error('--max-bytes requires an integer argument');
        }
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          throw new Error(
            `--max-bytes must be a positive safe integer (got ${value})`,
          );
        }
        maxBytes = parsed;
        i += 1;
        break;
      }
      case '--pretty': {
        pretty = true;
        break;
      }
      case '--generated-at': {
        const value = argv[i + 1];
        if (typeof value !== 'string') {
          throw new Error('--generated-at requires a value');
        }
        generatedAt = value;
        i += 1;
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (ledgerPaths.length === 0) {
    throw new Error('at least one --ledger <path> argument is required');
  }

  return {
    ledgerPaths,
    maxBytes,
    pretty,
    ...(generatedAt === undefined ? {} : { generatedAt }),
  };
}

export function buildClaudeOffloadReportFromCliOptions(
  options: ClaudeOffloadReportCliOptions,
): ClaudeOffloadReport {
  const allRecords: ClaudeOffloadLedgerRecord[] = [];
  const files: ClaudeOffloadReportSourceFile[] = [];

  for (const ledgerPath of options.ledgerPaths) {
    const stat = lstatSync(ledgerPath);
    if (!stat.isFile()) {
      throw new Error(`--ledger path is not a regular file: ${ledgerPath}`);
    }
    if (stat.size > options.maxBytes) {
      throw new Error(
        `--ledger file exceeds --max-bytes (${stat.size} > ${options.maxBytes}): ${ledgerPath}`,
      );
    }
    // Defensive: read once via fs to confirm readability before replay.
    readFileSync(ledgerPath);
    const ledger = new JsonlClaudeOffloadLedger(ledgerPath);
    const replay = ledger.loadWithAudit({ maxBytes: options.maxBytes });
    files.push({
      path: ledgerPath,
      recordCount: replay.replayAudit.parsedRecordCount,
      skippedMalformedLineCount: replay.replayAudit.skippedMalformedLineCount,
      skippedUnsafeLineCount: replay.replayAudit.skippedUnsafeLineCount,
    });
    allRecords.push(...replay.records);
  }

  const scorecard = buildClaudeOffloadLedgerScorecard(allRecords);
  return Object.freeze({
    schemaVersion: CLAUDE_OFFLOAD_REPORT_CLI_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    provenance: CLAUDE_OFFLOAD_LEDGER_PROVENANCE,
    source: {
      ledgerSchemaVersion: CLAUDE_OFFLOAD_LEDGER_SCHEMA_VERSION,
      files: Object.freeze<ClaudeOffloadReportSourceFile[]>(files),
    },
    scorecard,
    boundary: Object.freeze({
      readOnly: true as const,
      liveServicesContacted: false as const,
      ledgerFilesMutated: false as const,
      rawPromptsRendered: false as const,
      rawResponsesRendered: false as const,
    }),
  });
}

export function runClaudeOffloadReportCli(
  argv: readonly string[],
  io: ClaudeOffloadReportCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  try {
    const options = parseClaudeOffloadReportCliArgs(argv);
    if (options === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    const report = buildClaudeOffloadReportFromCliOptions(options);
    io.stdout.write(
      `${JSON.stringify(report, null, options.pretty ? 2 : undefined)}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(
      `claude-token-offload-report failed: ${
        error instanceof Error ? error.message : String(error)
      }\n\n${USAGE}`,
    );
    return 1;
  }
}
