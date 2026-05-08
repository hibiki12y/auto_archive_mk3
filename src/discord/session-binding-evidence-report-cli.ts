import { lstatSync, readFileSync } from 'node:fs';

export const SESSION_BINDING_EVIDENCE_REPORT_SCHEMA_VERSION = 1;
export const SESSION_BINDING_EVIDENCE_REPORT_RUBRIC_VERSION =
  '2026-05-05.session-binding-evidence-v1' as const;
export const SESSION_BINDING_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES =
  10 * 1024 * 1024;

export type SessionBindingEvidenceReportStatus =
  | 'complete'
  | 'warn'
  | 'fail'
  | 'no-record';
export type SessionBindingEvidenceEventType =
  | 'session.binding_created'
  | 'session.binding_released'
  | 'session.focus_changed'
  | 'session.binding_expired'
  | 'session.binding_evicted'
  | 'steering.submitted';

type SessionBindingAuditAction =
  | 'binding-created'
  | 'binding-released'
  | 'focus-changed'
  | 'binding-expired'
  | 'binding-evicted'
  | 'steering-submitted';

export interface SessionBindingEvidenceReportCliIo {
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
}

export interface SessionBindingEvidenceReportCliOptions {
  readonly ledgerPath?: string;
  readonly filter: {
    readonly eventType?: SessionBindingEvidenceEventType;
    readonly limit?: number;
  };
  readonly maxLedgerBytes: number;
  readonly generatedAt?: string;
  readonly pretty: boolean;
  readonly printTemplate: boolean;
}

export interface SessionBindingEvidenceTemplateRecord {
  readonly schemaVersion: 1;
  readonly eventId: 'session-binding-evidence-template';
  readonly timestamp: string;
  readonly type: 'session.binding_created';
  readonly actor: { readonly kind: 'system' };
  readonly trust: {
    readonly source: 'system';
    readonly inputTrust: 'trusted';
  };
  readonly payload: {
    readonly bindingAudit: {
      readonly schemaVersion: 1;
      readonly action: 'binding-created';
      readonly legacyEventType: 'session.binding_created';
      readonly status: 'active';
      readonly occurredAt: string;
      readonly retained: true;
      readonly bindingIdPresent: true;
      readonly bindingHash: 'sha256:0000000000000001';
      readonly taskIdPresent: true;
      readonly taskHash: 'sha256:0000000000000002';
      readonly ownerUserIdPresent: true;
      readonly ownerHash: 'sha256:0000000000000003';
      readonly guildIdPresent: true;
      readonly guildHash: 'sha256:0000000000000004';
      readonly channelIdPresent: true;
      readonly channelHash: 'sha256:0000000000000005';
      readonly threadIdPresent: true;
      readonly threadHash: 'sha256:0000000000000006';
      readonly subagentIdPresent: true;
      readonly subagentHash: 'sha256:0000000000000007';
      readonly expiresAtPresent: false;
      readonly lastUsedAtPresent: false;
    };
  };
}

interface SessionBindingEvidenceRecord {
  readonly observedAt: string;
  readonly eventType: SessionBindingEvidenceEventType;
  readonly action: SessionBindingAuditAction;
  readonly bindingHash?: `sha256:${string}`;
  readonly hasTask: boolean;
  readonly hasOwner: boolean;
  readonly hasChannel: boolean;
  readonly hasThread: boolean;
  readonly hasSubagent: boolean;
}

export interface SessionBindingEvidenceReplayAudit {
  readonly source: 'jsonl';
  readonly totalLineCount: number;
  readonly emptyLineCount: number;
  readonly parsedRecordCount: number;
  readonly skippedMalformedLineCount: number;
  readonly unsafePayloadLineCount: number;
  readonly skippedNonSessionBindingLineCount: number;
}

export interface SessionBindingEvidenceReport {
  readonly schemaVersion: typeof SESSION_BINDING_EVIDENCE_REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly status: SessionBindingEvidenceReportStatus;
  readonly filter: SessionBindingEvidenceReportCliOptions['filter'];
  readonly method: {
    readonly sourceEvents: readonly [
      'session.binding_created',
      'session.binding_released',
      'session.focus_changed',
      'session.binding_expired',
      'session.binding_evicted',
      'steering.submitted',
    ];
    readonly scoringRubricVersion: typeof SESSION_BINDING_EVIDENCE_REPORT_RUBRIC_VERSION;
    readonly promotionRule: string;
  };
  readonly replayAudit: SessionBindingEvidenceReplayAudit;
  readonly scorecard: {
    readonly recordCount: number;
    readonly bindingCreatedCount: number;
    readonly bindingReleasedCount: number;
    readonly focusChangedCount: number;
    readonly bindingExpiredCount: number;
    readonly bindingEvictedCount: number;
    readonly steeringSubmittedCount: number;
    readonly terminalTransitionCount: number;
    readonly bindingScopedRecordCount: number;
    readonly taskScopedRecordCount: number;
    readonly ownerAttributedRecordCount: number;
    readonly channelScopedRecordCount: number;
    readonly threadScopedRecordCount: number;
    readonly subagentScopedRecordCount: number;
    readonly currentActiveBindingCount: number;
    readonly duplicateCreateCount: number;
    readonly terminalWithoutCreateCount: number;
    readonly steeringWithoutActiveBindingCount: number;
    readonly filterApplied: boolean;
    readonly transitionCountsFiltered: boolean;
    readonly lastObservedAt?: string;
    readonly qualityScore: {
      readonly rubricVersion: typeof SESSION_BINDING_EVIDENCE_REPORT_RUBRIC_VERSION;
      readonly value: number;
      readonly max: 100;
      readonly summary: string;
    };
    readonly recommendations: readonly string[];
  };
  readonly boundary: {
    readonly readOnly: true;
    readonly liveServicesContacted: false;
    readonly focusMutated: false;
    readonly ledgerMutated: false;
    readonly rawBindingIdsRendered: false;
    readonly rawTaskIdsRendered: false;
    readonly rawOwnerUserIdsRendered: false;
    readonly rawGuildIdsRendered: false;
    readonly rawChannelIdsRendered: false;
    readonly rawThreadIdsRendered: false;
    readonly rawSubagentIdsRendered: false;
    readonly rawInstructionsRendered: false;
    readonly rawPayloadRendered: false;
  };
}

const SOURCE_EVENTS = [
  'session.binding_created',
  'session.binding_released',
  'session.focus_changed',
  'session.binding_expired',
  'session.binding_evicted',
  'steering.submitted',
] as const;

const USAGE = `Usage: pnpm session:binding:evidence:report -- --ledger <path> [options]
       pnpm session:binding:evidence:report -- --print-template [--generated-at <iso>]

Build a read-only retained focus/session-binding scorecard from a control-plane JSONL ledger.
The report never renders raw binding ids, task ids, owner ids, guild/channel/thread ids, subagent ids, instructions, or payload blobs.

Use --print-template to emit one compact, non-promoting session.binding_created
control-plane JSONL skeleton for operator-owned focus/session proof setup. The
placeholder has metadata-only bindingAudit hashes and remains WARN until real
steering plus release/change/expiry/eviction evidence replaces it.

Template mode accepts only --generated-at; it rejects --ledger, --event-type,
--limit, --max-ledger-bytes, and --pretty so the output remains one compact
JSONL line.

Options:
  --ledger <path>            Required existing control-plane JSONL ledger path unless --print-template is set.
  --print-template           Print one non-promoting compact session.binding_created JSONL record instead of reading --ledger.
  --event-type <type>        Filter by session.binding_created|session.binding_released|session.focus_changed|session.binding_expired|session.binding_evicted|steering.submitted.
  --limit <count>            Score only the bounded tail after filtering.
  --max-ledger-bytes <n>     Fail closed before reading beyond this many bytes (default: ${String(SESSION_BINDING_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES)}).
  --generated-at <iso>       Optional generatedAt timestamp to embed in the report.
  --pretty                   Pretty-print JSON output.
  --help                     Show this help text.

Boundary:
  This command is read-only. It does not call Discord/GitLab/provider services,
  focus, unfocus, steer, mutate session bindings, mutate or rotate ledgers,
  reload environment variables, or render raw binding ids, task ids, owner ids,
  channel/thread ids, subagent ids, instructions, or payloads.
`;

export function parseSessionBindingEvidenceReportCliArgs(
  argv: readonly string[],
): SessionBindingEvidenceReportCliOptions | 'help' {
  let ledgerPath: string | undefined;
  let eventType: SessionBindingEvidenceEventType | undefined;
  let limit: number | undefined;
  let maxLedgerBytes = SESSION_BINDING_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES;
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
      case '--event-type': {
        const raw = requireCliValue(argv, index, '--event-type');
        if (!isSessionBindingEvidenceEventType(raw)) {
          throw new Error(`--event-type must be one of ${SOURCE_EVENTS.join(', ')}.`);
        }
        eventType = raw;
        index += 1;
        break;
      }
      case '--limit': {
        const parsed = Number(requireCliValue(argv, index, '--limit'));
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error('--limit must be a non-negative integer.');
        }
        limit = parsed;
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

  if (ledgerPath === undefined || ledgerPath.length === 0) {
    if (printTemplate) {
      const reportOnlyOptions = [
        eventType === undefined ? undefined : '--event-type',
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
      ...(limit === undefined ? {} : { limit }),
    },
    maxLedgerBytes,
    ...(generatedAt === undefined ? {} : { generatedAt }),
    pretty,
    printTemplate,
  };
}

export function buildSessionBindingEvidenceReportFromCliOptions(
  options: SessionBindingEvidenceReportCliOptions,
): SessionBindingEvidenceReport {
  if (options.printTemplate) {
    throw new Error('Cannot build a session binding evidence report from --print-template options.');
  }
  if (options.ledgerPath === undefined || options.ledgerPath.length === 0) {
    throw new Error('--ledger is required.');
  }
  const replay = readSessionBindingEvidenceLedgerFile(
    options.ledgerPath,
    options.maxLedgerBytes,
  );
  const filtered = filterSessionBindingEvidenceRecords(
    replay.records,
    options.filter,
  );
  return buildSessionBindingEvidenceReport({
    records: filtered,
    replayAudit: replay.replayAudit,
    filter: options.filter,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  });
}

export function buildSessionBindingEvidenceTemplateFromCliOptions(
  options: SessionBindingEvidenceReportCliOptions,
): SessionBindingEvidenceTemplateRecord {
  const observedAt = options.generatedAt ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    eventId: 'session-binding-evidence-template',
    timestamp: observedAt,
    type: 'session.binding_created',
    actor: { kind: 'system' },
    trust: { source: 'system', inputTrust: 'trusted' },
    payload: {
      bindingAudit: {
        schemaVersion: 1,
        action: 'binding-created',
        legacyEventType: 'session.binding_created',
        status: 'active',
        occurredAt: observedAt,
        retained: true,
        bindingIdPresent: true,
        bindingHash: 'sha256:0000000000000001',
        taskIdPresent: true,
        taskHash: 'sha256:0000000000000002',
        ownerUserIdPresent: true,
        ownerHash: 'sha256:0000000000000003',
        guildIdPresent: true,
        guildHash: 'sha256:0000000000000004',
        channelIdPresent: true,
        channelHash: 'sha256:0000000000000005',
        threadIdPresent: true,
        threadHash: 'sha256:0000000000000006',
        subagentIdPresent: true,
        subagentHash: 'sha256:0000000000000007',
        expiresAtPresent: false,
        lastUsedAtPresent: false,
      },
    },
  };
}

export function runSessionBindingEvidenceReportCli(
  argv: readonly string[],
  io: SessionBindingEvidenceReportCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  try {
    const options = parseSessionBindingEvidenceReportCliArgs(argv);
    if (options === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    if (options.printTemplate) {
      io.stdout.write(
        `${JSON.stringify(buildSessionBindingEvidenceTemplateFromCliOptions(options))}\n`,
      );
      return 0;
    }
    const report = buildSessionBindingEvidenceReportFromCliOptions(options);
    io.stdout.write(`${JSON.stringify(report, null, options.pretty ? 2 : undefined)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `session:binding:evidence:report failed: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    );
    return 1;
  }
}

function buildSessionBindingEvidenceReport(input: {
  readonly records: readonly SessionBindingEvidenceRecord[];
  readonly replayAudit: SessionBindingEvidenceReplayAudit;
  readonly filter: SessionBindingEvidenceReportCliOptions['filter'];
  readonly generatedAt: string;
}): SessionBindingEvidenceReport {
  let bindingCreatedCount = 0;
  let bindingReleasedCount = 0;
  let focusChangedCount = 0;
  let bindingExpiredCount = 0;
  let bindingEvictedCount = 0;
  let steeringSubmittedCount = 0;
  let bindingScopedRecordCount = 0;
  let taskScopedRecordCount = 0;
  let ownerAttributedRecordCount = 0;
  let channelScopedRecordCount = 0;
  let threadScopedRecordCount = 0;
  let subagentScopedRecordCount = 0;
  let duplicateCreateCount = 0;
  let terminalWithoutCreateCount = 0;
  let steeringWithoutActiveBindingCount = 0;
  let lastObservedAt: string | undefined;
  const activeState = new Map<string, boolean>();

  for (const record of input.records) {
    if (record.eventType === 'session.binding_created') bindingCreatedCount += 1;
    if (record.eventType === 'session.binding_released') bindingReleasedCount += 1;
    if (record.eventType === 'session.focus_changed') focusChangedCount += 1;
    if (record.eventType === 'session.binding_expired') bindingExpiredCount += 1;
    if (record.eventType === 'session.binding_evicted') bindingEvictedCount += 1;
    if (record.eventType === 'steering.submitted') steeringSubmittedCount += 1;
    if (record.bindingHash !== undefined) bindingScopedRecordCount += 1;
    if (record.hasTask) taskScopedRecordCount += 1;
    if (record.hasOwner) ownerAttributedRecordCount += 1;
    if (record.hasChannel) channelScopedRecordCount += 1;
    if (record.hasThread) threadScopedRecordCount += 1;
    if (record.hasSubagent) subagentScopedRecordCount += 1;
    lastObservedAt =
      lastObservedAt === undefined || record.observedAt > lastObservedAt
        ? record.observedAt
        : lastObservedAt;

    if (record.bindingHash !== undefined) {
      const wasActive = activeState.get(record.bindingHash) === true;
      if (record.eventType === 'session.binding_created') {
        if (wasActive) duplicateCreateCount += 1;
        activeState.set(record.bindingHash, true);
      } else if (record.eventType === 'steering.submitted') {
        if (!wasActive) steeringWithoutActiveBindingCount += 1;
      } else if (isTerminalSessionBindingEvent(record.eventType)) {
        if (!wasActive) terminalWithoutCreateCount += 1;
        activeState.set(record.bindingHash, false);
      }
    }
  }

  const recordCount = input.records.length;
  const terminalTransitionCount =
    bindingReleasedCount + focusChangedCount + bindingExpiredCount + bindingEvictedCount;
  const currentActiveBindingCount = Array.from(activeState.values()).filter(Boolean).length;
  const filterApplied = input.filter.eventType !== undefined || input.filter.limit !== undefined;
  const cleanReplay =
    input.replayAudit.skippedMalformedLineCount === 0 &&
    input.replayAudit.unsafePayloadLineCount === 0;
  const qualityScoreValue = round4(
    25 * (recordCount > 0 ? 1 : 0) +
      20 * (bindingCreatedCount > 0 ? 1 : 0) +
      20 * (terminalTransitionCount > 0 ? 1 : 0) +
      15 * (steeringSubmittedCount > 0 ? 1 : 0) +
      10 * rate(bindingScopedRecordCount, recordCount) +
      10 * (cleanReplay ? 1 : 0),
  );
  const status = sessionBindingEvidenceReportStatus({
    recordCount,
    bindingCreatedCount,
    terminalTransitionCount,
    steeringSubmittedCount,
    bindingScopedRecordCount,
    taskScopedRecordCount,
    ownerAttributedRecordCount,
    channelScopedRecordCount,
    currentActiveBindingCount,
    duplicateCreateCount,
    terminalWithoutCreateCount,
    steeringWithoutActiveBindingCount,
    replayAudit: input.replayAudit,
  });
  const recommendations = sessionBindingEvidenceRecommendations({
    recordCount,
    bindingCreatedCount,
    terminalTransitionCount,
    steeringSubmittedCount,
    currentActiveBindingCount,
    duplicateCreateCount,
    terminalWithoutCreateCount,
    steeringWithoutActiveBindingCount,
    replayAudit: input.replayAudit,
  });

  return {
    schemaVersion: SESSION_BINDING_EVIDENCE_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    status,
    filter: input.filter,
    method: {
      sourceEvents: SOURCE_EVENTS,
      scoringRubricVersion: SESSION_BINDING_EVIDENCE_REPORT_RUBRIC_VERSION,
      promotionRule:
        'Require retained focus creation, steering submission, terminal focus lifecycle evidence, clean bounded replay, and metadata-only bindingAudit records before treating focus/session binding evidence as complete.',
    },
    replayAudit: input.replayAudit,
    scorecard: {
      recordCount,
      bindingCreatedCount,
      bindingReleasedCount,
      focusChangedCount,
      bindingExpiredCount,
      bindingEvictedCount,
      steeringSubmittedCount,
      terminalTransitionCount,
      bindingScopedRecordCount,
      taskScopedRecordCount,
      ownerAttributedRecordCount,
      channelScopedRecordCount,
      threadScopedRecordCount,
      subagentScopedRecordCount,
      currentActiveBindingCount,
      duplicateCreateCount,
      terminalWithoutCreateCount,
      steeringWithoutActiveBindingCount,
      filterApplied,
      transitionCountsFiltered: filterApplied,
      ...(lastObservedAt === undefined ? {} : { lastObservedAt }),
      qualityScore: {
        rubricVersion: SESSION_BINDING_EVIDENCE_REPORT_RUBRIC_VERSION,
        value: qualityScoreValue,
        max: 100,
        summary:
          recordCount === 0
            ? 'No focus/session-binding events were available for scoring.'
            : `Focus/session-binding evidence score ${String(qualityScoreValue)}/100 over ${String(recordCount)} retained event(s).`,
      },
      recommendations,
    },
    boundary: {
      readOnly: true,
      liveServicesContacted: false,
      focusMutated: false,
      ledgerMutated: false,
      rawBindingIdsRendered: false,
      rawTaskIdsRendered: false,
      rawOwnerUserIdsRendered: false,
      rawGuildIdsRendered: false,
      rawChannelIdsRendered: false,
      rawThreadIdsRendered: false,
      rawSubagentIdsRendered: false,
      rawInstructionsRendered: false,
      rawPayloadRendered: false,
    },
  };
}

function sessionBindingEvidenceReportStatus(input: {
  readonly recordCount: number;
  readonly bindingCreatedCount: number;
  readonly terminalTransitionCount: number;
  readonly steeringSubmittedCount: number;
  readonly bindingScopedRecordCount: number;
  readonly taskScopedRecordCount: number;
  readonly ownerAttributedRecordCount: number;
  readonly channelScopedRecordCount: number;
  readonly currentActiveBindingCount: number;
  readonly duplicateCreateCount: number;
  readonly terminalWithoutCreateCount: number;
  readonly steeringWithoutActiveBindingCount: number;
  readonly replayAudit: SessionBindingEvidenceReplayAudit;
}): SessionBindingEvidenceReportStatus {
  if (input.replayAudit.unsafePayloadLineCount > 0) return 'fail';
  if (input.recordCount === 0) return 'no-record';
  if (
    input.replayAudit.skippedMalformedLineCount > 0 ||
    input.bindingCreatedCount === 0 ||
    input.terminalTransitionCount === 0 ||
    input.steeringSubmittedCount === 0 ||
    input.bindingScopedRecordCount < input.recordCount ||
    input.taskScopedRecordCount < input.recordCount ||
    input.ownerAttributedRecordCount < input.recordCount ||
    input.channelScopedRecordCount < input.recordCount ||
    input.currentActiveBindingCount > 0 ||
    input.duplicateCreateCount > 0 ||
    input.terminalWithoutCreateCount > 0 ||
    input.steeringWithoutActiveBindingCount > 0
  ) {
    return 'warn';
  }
  return 'complete';
}

function sessionBindingEvidenceRecommendations(input: {
  readonly recordCount: number;
  readonly bindingCreatedCount: number;
  readonly terminalTransitionCount: number;
  readonly steeringSubmittedCount: number;
  readonly currentActiveBindingCount: number;
  readonly duplicateCreateCount: number;
  readonly terminalWithoutCreateCount: number;
  readonly steeringWithoutActiveBindingCount: number;
  readonly replayAudit: SessionBindingEvidenceReplayAudit;
}): readonly string[] {
  const recommendations: string[] = [];
  if (input.replayAudit.unsafePayloadLineCount > 0) {
    recommendations.push(
      `Remove ${String(input.replayAudit.unsafePayloadLineCount)} unsafe focus/session-binding payload line(s); retained evidence must contain bindingAudit metadata/hashes only and never raw binding ids, owner ids, prompts, steering text, or payload blobs.`,
    );
  }
  if (input.replayAudit.skippedMalformedLineCount > 0) {
    recommendations.push(
      `Review ${String(input.replayAudit.skippedMalformedLineCount)} malformed/torn focus/session-binding JSONL line(s); they were excluded from scoring.`,
    );
  }
  if (input.recordCount === 0) {
    recommendations.push('Record focus creation, steering submission, and release/expiry evidence before promoting focus-binding UX evidence.');
  }
  if (input.bindingCreatedCount === 0) recommendations.push('Record at least one session.binding_created event.');
  if (input.steeringSubmittedCount === 0) recommendations.push('Record at least one steering.submitted event tied to an active focus binding.');
  if (input.terminalTransitionCount === 0) recommendations.push('Record at least one release, focus-change, expiry, or eviction terminal transition.');
  if (input.currentActiveBindingCount > 0) {
    recommendations.push(`Resolve ${String(input.currentActiveBindingCount)} active focus binding(s) before treating retained evidence as complete.`);
  }
  if (input.duplicateCreateCount > 0) {
    recommendations.push(`Investigate ${String(input.duplicateCreateCount)} duplicate focus binding create transition(s).`);
  }
  if (input.terminalWithoutCreateCount > 0) {
    recommendations.push(`Investigate ${String(input.terminalWithoutCreateCount)} terminal-without-create transition(s).`);
  }
  if (input.steeringWithoutActiveBindingCount > 0) {
    recommendations.push(`Investigate ${String(input.steeringWithoutActiveBindingCount)} steering submission(s) without an active focus binding.`);
  }
  if (recommendations.length === 0) {
    recommendations.push('Focus/session-binding retained evidence meets the local scorecard threshold; live Discord proof remains operator-gated.');
  }
  return recommendations;
}

function readSessionBindingEvidenceLedgerFile(
  ledgerPath: string,
  maxLedgerBytes: number,
): {
  readonly records: readonly SessionBindingEvidenceRecord[];
  readonly replayAudit: SessionBindingEvidenceReplayAudit;
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
  return replaySessionBindingEvidenceJsonl(readFileSync(ledgerPath, 'utf8'));
}

function replaySessionBindingEvidenceJsonl(content: string): {
  readonly records: readonly SessionBindingEvidenceRecord[];
  readonly replayAudit: SessionBindingEvidenceReplayAudit;
} {
  const records: SessionBindingEvidenceRecord[] = [];
  let totalLineCount = 0;
  let emptyLineCount = 0;
  let skippedMalformedLineCount = 0;
  let unsafePayloadLineCount = 0;
  let skippedNonSessionBindingLineCount = 0;

  for (const line of content.split('\n')) {
    totalLineCount += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      emptyLineCount += 1;
      continue;
    }
    try {
      const raw: unknown = JSON.parse(trimmed);
      if (!isRecord(raw)) {
        skippedMalformedLineCount += 1;
        continue;
      }
      const eventType = raw['type'];
      if (!isSessionBindingEvidenceEventType(eventType)) {
        skippedNonSessionBindingLineCount += 1;
        continue;
      }
      const payload = isRecord(raw['payload']) ? raw['payload'] : undefined;
      if (payload === undefined) {
        skippedMalformedLineCount += 1;
        continue;
      }
      if (hasUnsafeSessionBindingPayload(payload)) {
        unsafePayloadLineCount += 1;
        continue;
      }
      const parsed = parseSessionBindingEvidenceRecord(raw, eventType, payload);
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
      skippedNonSessionBindingLineCount,
    },
  };
}

function parseSessionBindingEvidenceRecord(
  raw: Record<string, unknown>,
  eventType: SessionBindingEvidenceEventType,
  payload: Record<string, unknown>,
): SessionBindingEvidenceRecord | undefined {
  const timestamp = raw['timestamp'];
  if (typeof timestamp !== 'string' || !isIsoInstant(timestamp)) return undefined;
  const audit = isRecord(payload['bindingAudit']) ? payload['bindingAudit'] : undefined;
  if (audit === undefined) return undefined;
  const parsedAudit = parseSessionBindingAudit(audit, eventType);
  if (parsedAudit === undefined || parsedAudit === 'unsafe') return undefined;
  return {
    observedAt: timestamp,
    eventType,
    action: parsedAudit.action,
    ...(parsedAudit.bindingHash === undefined ? {} : { bindingHash: parsedAudit.bindingHash }),
    hasTask: parsedAudit.taskIdPresent,
    hasOwner: parsedAudit.ownerUserIdPresent,
    hasChannel: parsedAudit.channelIdPresent,
    hasThread: parsedAudit.threadIdPresent,
    hasSubagent: parsedAudit.subagentIdPresent,
  };
}

function filterSessionBindingEvidenceRecords(
  records: readonly SessionBindingEvidenceRecord[],
  filter: SessionBindingEvidenceReportCliOptions['filter'],
): readonly SessionBindingEvidenceRecord[] {
  const filtered = records.filter((record) =>
    filter.eventType === undefined ? true : record.eventType === filter.eventType,
  );
  return filter.limit === undefined ? filtered : filtered.slice(-Math.max(0, filter.limit));
}

const SESSION_BINDING_AUDIT_KEYS = new Set([
  'schemaVersion',
  'action',
  'legacyEventType',
  'status',
  'occurredAt',
  'retained',
  'bindingIdPresent',
  'bindingHash',
  'taskIdPresent',
  'taskHash',
  'ownerUserIdPresent',
  'ownerHash',
  'guildIdPresent',
  'guildHash',
  'channelIdPresent',
  'channelHash',
  'threadIdPresent',
  'threadHash',
  'subagentIdPresent',
  'subagentHash',
  'expiresAtPresent',
  'lastUsedAtPresent',
]);
const SESSION_BINDING_HASH_KEYS = new Set([
  'bindingHash',
  'taskHash',
  'ownerHash',
  'guildHash',
  'channelHash',
  'threadHash',
  'subagentHash',
]);
const SESSION_BINDING_BOOL_KEYS = new Set([
  'retained',
  'bindingIdPresent',
  'taskIdPresent',
  'ownerUserIdPresent',
  'guildIdPresent',
  'channelIdPresent',
  'threadIdPresent',
  'subagentIdPresent',
  'expiresAtPresent',
  'lastUsedAtPresent',
]);

function hasUnsafeSessionBindingPayload(payload: Record<string, unknown>): boolean {
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== 'bindingAudit') return true;
  const audit = payload['bindingAudit'];
  if (!isRecord(audit)) return true;
  return parseSessionBindingAudit(audit) === 'unsafe';
}

function parseSessionBindingAudit(
  audit: Record<string, unknown>,
  expectedEventType?: SessionBindingEvidenceEventType,
):
  | {
      readonly action: SessionBindingAuditAction;
      readonly bindingHash?: `sha256:${string}`;
      readonly taskIdPresent: boolean;
      readonly ownerUserIdPresent: boolean;
      readonly channelIdPresent: boolean;
      readonly threadIdPresent: boolean;
      readonly subagentIdPresent: boolean;
    }
  | 'unsafe'
  | undefined {
  for (const [key, value] of Object.entries(audit)) {
    if (!SESSION_BINDING_AUDIT_KEYS.has(key)) return 'unsafe';
    if (SESSION_BINDING_HASH_KEYS.has(key) && !isShortHash(value)) return 'unsafe';
    if (SESSION_BINDING_BOOL_KEYS.has(key) && typeof value !== 'boolean') return undefined;
  }
  if (audit['schemaVersion'] !== 1) return undefined;
  if (audit['retained'] !== true) return undefined;
  const action = audit['action'];
  if (!isSessionBindingAuditAction(action)) return undefined;
  const legacyEventType = audit['legacyEventType'];
  if (!isSessionBindingEvidenceEventType(legacyEventType)) return undefined;
  if (expectedEventType !== undefined && legacyEventType !== expectedEventType) return undefined;
  if (typeof audit['occurredAt'] !== 'string' || !isIsoInstant(audit['occurredAt'])) return undefined;
  const bindingHash = audit['bindingHash'];
  return {
    action,
    ...(isShortHash(bindingHash) ? { bindingHash } : {}),
    taskIdPresent: audit['taskIdPresent'] === true,
    ownerUserIdPresent: audit['ownerUserIdPresent'] === true,
    channelIdPresent: audit['channelIdPresent'] === true,
    threadIdPresent: audit['threadIdPresent'] === true,
    subagentIdPresent: audit['subagentIdPresent'] === true,
  };
}

function isTerminalSessionBindingEvent(type: SessionBindingEvidenceEventType): boolean {
  return (
    type === 'session.binding_released' ||
    type === 'session.focus_changed' ||
    type === 'session.binding_expired' ||
    type === 'session.binding_evicted'
  );
}

function isSessionBindingEvidenceEventType(
  value: unknown,
): value is SessionBindingEvidenceEventType {
  return typeof value === 'string' && SOURCE_EVENTS.includes(value as never);
}

function isSessionBindingAuditAction(value: unknown): value is SessionBindingAuditAction {
  return (
    value === 'binding-created' ||
    value === 'binding-released' ||
    value === 'focus-changed' ||
    value === 'binding-expired' ||
    value === 'binding-evicted' ||
    value === 'steering-submitted'
  );
}

function isShortHash(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{16}$/u.test(value);
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
