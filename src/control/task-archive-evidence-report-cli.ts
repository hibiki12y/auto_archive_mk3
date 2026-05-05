import { lstatSync, readFileSync } from 'node:fs';

import {
  parseControlPlaneEvent,
  type ControlPlaneEvent,
} from './control-plane-ledger.js';

export const TASK_ARCHIVE_EVIDENCE_REPORT_SCHEMA_VERSION = 1;
export const TASK_ARCHIVE_EVIDENCE_REPORT_RUBRIC_VERSION =
  '2026-05-05.task-archive-evidence-v1' as const;
export const TASK_ARCHIVE_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES =
  10 * 1024 * 1024;
export const TASK_ARCHIVE_AUDIT_SCHEMA_VERSION = 1;

export type TaskArchiveEvidenceReportStatus =
  | 'complete'
  | 'warn'
  | 'fail'
  | 'no-record';
export type TaskArchiveEvidenceAction = 'archive' | 'unarchive';
export type TaskArchiveEvidenceStatus = 'archived' | 'unarchived';
export type TaskArchiveEvidenceEventType = 'task.archived' | 'task.unarchived';

export interface TaskArchiveEvidenceRecord {
  readonly observedAt: string;
  readonly eventType: TaskArchiveEvidenceEventType;
  readonly action: TaskArchiveEvidenceAction;
  readonly status: TaskArchiveEvidenceStatus;
  readonly hasTaskId: boolean;
  readonly hasActor: boolean;
  readonly hasChannel: boolean;
  readonly hasReason: boolean;
  readonly hasRequestId: boolean;
  readonly retained: boolean;
}

interface InternalTaskArchiveEvidenceRecord extends TaskArchiveEvidenceRecord {
  /** Raw task ids are used only for in-memory transition reconstruction. */
  readonly taskStateKey?: string;
}

export interface TaskArchiveEvidenceReplayAudit {
  readonly source: 'jsonl';
  readonly totalLineCount: number;
  readonly emptyLineCount: number;
  readonly parsedEventCount: number;
  readonly parsedTaskArchiveRecordCount: number;
  readonly skippedNonTaskArchiveLineCount: number;
  readonly skippedMalformedLineCount: number;
  readonly unsafePayloadLineCount: number;
}

export interface TaskArchiveEvidenceReportCliIo {
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
}

export interface TaskArchiveEvidenceReportCliOptions {
  readonly ledgerPath?: string;
  readonly filter: {
    readonly eventType?: TaskArchiveEvidenceEventType;
    readonly action?: TaskArchiveEvidenceAction;
    readonly limit?: number;
  };
  readonly maxLedgerBytes: number;
  readonly generatedAt?: string;
  readonly pretty: boolean;
  readonly printTemplate: boolean;
}

export interface TaskArchiveEvidenceTemplateRecord {
  readonly schemaVersion: 1;
  readonly eventId: 'task-archive-evidence-template';
  readonly timestamp: string;
  readonly type: 'task.archived';
  readonly actor: {
    readonly kind: 'system';
  };
  readonly trust: {
    readonly source: 'system';
    readonly inputTrust: 'trusted';
  };
  readonly payload: {
    readonly archiveAudit: {
      readonly schemaVersion: 1;
      readonly action: 'archive';
      readonly legacyEventType: 'task.archived';
      readonly status: 'archived';
      readonly occurredAt: string;
      readonly retained: true;
      readonly taskIdPresent: true;
      readonly taskHash: 'sha256:0000000000000001';
      readonly actorPresent: true;
      readonly actorHash: 'sha256:0000000000000002';
      readonly reasonPresent: false;
      readonly requestIdPresent: false;
    };
  };
}

export interface TaskArchiveEvidenceReport {
  readonly schemaVersion: typeof TASK_ARCHIVE_EVIDENCE_REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly status: TaskArchiveEvidenceReportStatus;
  readonly filter: TaskArchiveEvidenceReportCliOptions['filter'];
  readonly method: {
    readonly sourceEvents: readonly ['task.archived', 'task.unarchived'];
    readonly scoringRubricVersion: typeof TASK_ARCHIVE_EVIDENCE_REPORT_RUBRIC_VERSION;
    readonly promotionRule: string;
  };
  readonly replayAudit: TaskArchiveEvidenceReplayAudit;
  readonly scorecard: {
    readonly recordCount: number;
    readonly archiveEventCount: number;
    readonly unarchiveEventCount: number;
    readonly archiveRecordCount: number;
    readonly unarchiveRecordCount: number;
    readonly taskScopedRecordCount: number;
    readonly actorAttributedRecordCount: number;
    readonly actorScopedRecordCount: number;
    readonly channelScopedRecordCount: number;
    readonly reasonPresentCount: number;
    readonly requestIdPresentCount: number;
    readonly retainedRecordCount: number;
    readonly currentArchivedTaskCount: number;
    readonly duplicateArchiveCount: number;
    readonly unmatchedUnarchiveCount: number;
    readonly filterApplied: boolean;
    readonly transitionCountsFiltered: boolean;
    readonly lastActionAt?: string;
    readonly lastObservedAt?: string;
    readonly qualityScore: {
      readonly rubricVersion: typeof TASK_ARCHIVE_EVIDENCE_REPORT_RUBRIC_VERSION;
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
    readonly archiveStateMutated: false;
    readonly rawTaskIdsRendered: false;
    readonly rawActorIdsRendered: false;
    readonly rawChannelIdsRendered: false;
    readonly rawReasonsRendered: false;
    readonly rawPayloadRendered: false;
  };
}

const USAGE = `Usage: pnpm task:archive:evidence:report -- --ledger <path> [options]
       pnpm task:archive:evidence:report -- --print-template [--generated-at <iso>]

Build a read-only retained archive/unarchive scorecard from a control-plane JSONL ledger.
Only task.archived/task.unarchived records with safe archive evidence payloads are scored.
The report never renders raw task ids, actor/user ids, channel ids, reasons, Discord content, or payload blobs.

Use --print-template to emit one compact, non-promoting task.archived control-plane
JSONL skeleton for operator-owned archive proof setup. The placeholder records
metadata-only archive audit evidence and remains WARN until replaced by real
archive and unarchive operator evidence.

Template mode accepts only --generated-at; it rejects --ledger, --event-type,
--action, --limit, --max-ledger-bytes, and --pretty so the output remains one
compact JSONL line.

Options:
  --ledger <path>            Required existing control-plane JSONL ledger path unless --print-template is set.
  --print-template           Print one non-promoting compact task.archived JSONL record instead of reading --ledger.
  --event-type <type>        Filter by task.archived or task.unarchived.
  --action <archive|unarchive> Backward-compatible action filter.
  --limit <count>            Score only the bounded tail after other filters.
  --max-ledger-bytes <n>     Fail closed before reading beyond this many bytes (default: ${String(TASK_ARCHIVE_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES)}).
  --generated-at <iso>       Optional generatedAt timestamp to embed in the report.
  --pretty                   Pretty-print JSON output.
  --help                     Show this help text.

Boundary:
  This command is read-only. It does not call Discord/GitLab/provider services,
  write control-plane events, mutate archive state, mutate or rotate ledgers,
  reload environment variables, or render raw task ids, actor ids, channel ids,
  reasons, instructions, or payloads.
`;

export function parseTaskArchiveEvidenceReportCliArgs(
  argv: readonly string[],
): TaskArchiveEvidenceReportCliOptions | 'help' {
  let ledgerPath: string | undefined;
  let eventType: TaskArchiveEvidenceEventType | undefined;
  let action: TaskArchiveEvidenceAction | undefined;
  let limit: number | undefined;
  let maxLedgerBytes = TASK_ARCHIVE_EVIDENCE_REPORT_CLI_DEFAULT_MAX_LEDGER_BYTES;
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
        const rawEventType = requireCliValue(argv, index, '--event-type');
        if (rawEventType !== 'task.archived' && rawEventType !== 'task.unarchived') {
          throw new Error(
            '--event-type must be one of task.archived, task.unarchived.',
          );
        }
        eventType = rawEventType;
        index += 1;
        break;
      }
      case '--action': {
        const rawAction = requireCliValue(argv, index, '--action');
        if (rawAction !== 'archive' && rawAction !== 'unarchive') {
          throw new Error('--action must be archive or unarchive.');
        }
        action = rawAction;
        index += 1;
        break;
      }
      case '--limit': {
        const parsedLimit = Number(requireCliValue(argv, index, '--limit'));
        if (!Number.isInteger(parsedLimit) || parsedLimit < 0) {
          throw new Error('--limit must be a non-negative integer.');
        }
        limit = parsedLimit;
        index += 1;
        break;
      }
      case '--max-ledger-bytes': {
        const parsedMaxLedgerBytes = Number(
          requireCliValue(argv, index, '--max-ledger-bytes'),
        );
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
        action === undefined ? undefined : '--action',
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

  const actionFromEventType = eventTypeToAction(eventType);
  if (
    action !== undefined &&
    actionFromEventType !== undefined &&
    action !== actionFromEventType
  ) {
    throw new Error('--event-type and --action filters conflict.');
  }

  return {
    ledgerPath,
    filter: {
      ...(eventType === undefined ? {} : { eventType }),
      ...(eventType === undefined && action !== undefined ? { action } : {}),
      ...(limit === undefined ? {} : { limit }),
    },
    maxLedgerBytes,
    ...(generatedAt === undefined ? {} : { generatedAt }),
    pretty,
    printTemplate,
  };
}

export function buildTaskArchiveEvidenceReportFromCliOptions(
  options: TaskArchiveEvidenceReportCliOptions,
): TaskArchiveEvidenceReport {
  if (options.printTemplate) {
    throw new Error('Cannot build a task archive evidence report from --print-template options.');
  }
  if (options.ledgerPath === undefined || options.ledgerPath.length === 0) {
    throw new Error('--ledger is required.');
  }
  const replay = readTaskArchiveEvidenceLedgerFile(
    options.ledgerPath,
    options.maxLedgerBytes,
  );
  const filtered = filterTaskArchiveEvidenceRecords(
    replay.records,
    options.filter,
  );
  return buildTaskArchiveEvidenceReport({
    records: filtered,
    replayAudit: replay.replayAudit,
    filter: options.filter,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  });
}

export function buildTaskArchiveEvidenceTemplateFromCliOptions(
  options: TaskArchiveEvidenceReportCliOptions,
): TaskArchiveEvidenceTemplateRecord {
  const observedAt = options.generatedAt ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    eventId: 'task-archive-evidence-template',
    timestamp: observedAt,
    type: 'task.archived',
    actor: { kind: 'system' },
    trust: { source: 'system', inputTrust: 'trusted' },
    payload: {
      archiveAudit: {
        schemaVersion: 1,
        action: 'archive',
        legacyEventType: 'task.archived',
        status: 'archived',
        occurredAt: observedAt,
        retained: true,
        taskIdPresent: true,
        taskHash: 'sha256:0000000000000001',
        actorPresent: true,
        actorHash: 'sha256:0000000000000002',
        reasonPresent: false,
        requestIdPresent: false,
      },
    },
  };
}

export function runTaskArchiveEvidenceReportCli(
  argv: readonly string[],
  io: TaskArchiveEvidenceReportCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): number {
  try {
    const options = parseTaskArchiveEvidenceReportCliArgs(argv);
    if (options === 'help') {
      io.stdout.write(USAGE);
      return 0;
    }
    if (options.printTemplate) {
      io.stdout.write(
        `${JSON.stringify(buildTaskArchiveEvidenceTemplateFromCliOptions(options))}\n`,
      );
      return 0;
    }
    const report = buildTaskArchiveEvidenceReportFromCliOptions(options);
    io.stdout.write(
      `${JSON.stringify(report, null, options.pretty ? 2 : undefined)}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(
      `task:archive:evidence:report failed: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    );
    return 1;
  }
}

function buildTaskArchiveEvidenceReport(input: {
  readonly records: readonly InternalTaskArchiveEvidenceRecord[];
  readonly replayAudit: TaskArchiveEvidenceReplayAudit;
  readonly filter: TaskArchiveEvidenceReportCliOptions['filter'];
  readonly generatedAt: string;
}): TaskArchiveEvidenceReport {
  const recordCount = input.records.length;
  let archiveEventCount = 0;
  let unarchiveEventCount = 0;
  let taskScopedRecordCount = 0;
  let actorAttributedRecordCount = 0;
  let channelScopedRecordCount = 0;
  let reasonPresentCount = 0;
  let requestIdPresentCount = 0;
  let retainedRecordCount = 0;
  let lastActionAt: string | undefined;
  let duplicateArchiveCount = 0;
  let unmatchedUnarchiveCount = 0;
  const archivedStateByTask = new Map<string, boolean>();

  for (const record of input.records) {
    if (record.eventType === 'task.archived') archiveEventCount += 1;
    if (record.eventType === 'task.unarchived') unarchiveEventCount += 1;
    if (record.hasTaskId) taskScopedRecordCount += 1;
    if (record.hasActor) actorAttributedRecordCount += 1;
    if (record.hasChannel) channelScopedRecordCount += 1;
    if (record.hasReason) reasonPresentCount += 1;
    if (record.hasRequestId) requestIdPresentCount += 1;
    if (record.retained) retainedRecordCount += 1;
    lastActionAt =
      lastActionAt === undefined || record.observedAt > lastActionAt
        ? record.observedAt
        : lastActionAt;

    if (record.taskStateKey !== undefined) {
      const wasArchived = archivedStateByTask.get(record.taskStateKey) === true;
      if (record.action === 'archive') {
        if (wasArchived) duplicateArchiveCount += 1;
        archivedStateByTask.set(record.taskStateKey, true);
      } else {
        if (!wasArchived) unmatchedUnarchiveCount += 1;
        archivedStateByTask.set(record.taskStateKey, false);
      }
    }
  }

  const currentArchivedTaskCount = Array.from(archivedStateByTask.values()).filter(
    Boolean,
  ).length;
  const filterApplied =
    input.filter.eventType !== undefined ||
    input.filter.action !== undefined ||
    input.filter.limit !== undefined;
  const qualityScoreValue = round4(
    30 * (recordCount > 0 ? 1 : 0) +
      20 * (archiveEventCount > 0 ? 1 : 0) +
      10 * (unarchiveEventCount > 0 ? 1 : 0) +
      15 * rate(taskScopedRecordCount, recordCount) +
      15 * rate(actorAttributedRecordCount, recordCount) +
      10 *
        (input.replayAudit.skippedMalformedLineCount === 0 &&
        input.replayAudit.unsafePayloadLineCount === 0
          ? 1
          : 0),
  );
  const status = taskArchiveEvidenceReportStatus({
    recordCount,
    archiveEventCount,
    unarchiveEventCount,
    taskScopedRecordCount,
    actorAttributedRecordCount,
    duplicateArchiveCount,
    unmatchedUnarchiveCount,
    replayAudit: input.replayAudit,
  });
  const recommendations = taskArchiveEvidenceRecommendations({
    recordCount,
    archiveEventCount,
    unarchiveEventCount,
    taskScopedRecordCount,
    actorAttributedRecordCount,
    duplicateArchiveCount,
    unmatchedUnarchiveCount,
    replayAudit: input.replayAudit,
  });

  return {
    schemaVersion: TASK_ARCHIVE_EVIDENCE_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    status,
    filter: input.filter,
    method: {
      sourceEvents: ['task.archived', 'task.unarchived'],
      scoringRubricVersion: TASK_ARCHIVE_EVIDENCE_REPORT_RUBRIC_VERSION,
      promotionRule:
        'Require retained task.archived and task.unarchived audit records, metadata-only payloads, task/actor attribution, and clean bounded replay before treating archive UX evidence as complete.',
    },
    replayAudit: input.replayAudit,
    scorecard: {
      recordCount,
      archiveEventCount,
      unarchiveEventCount,
      archiveRecordCount: archiveEventCount,
      unarchiveRecordCount: unarchiveEventCount,
      taskScopedRecordCount,
      actorAttributedRecordCount,
      actorScopedRecordCount: actorAttributedRecordCount,
      channelScopedRecordCount,
      reasonPresentCount,
      requestIdPresentCount,
      retainedRecordCount,
      currentArchivedTaskCount,
      duplicateArchiveCount,
      unmatchedUnarchiveCount,
      filterApplied,
      transitionCountsFiltered: filterApplied,
      ...(lastActionAt === undefined ? {} : { lastActionAt, lastObservedAt: lastActionAt }),
      qualityScore: {
        rubricVersion: TASK_ARCHIVE_EVIDENCE_REPORT_RUBRIC_VERSION,
        value: qualityScoreValue,
        max: 100,
        summary:
          recordCount === 0
            ? 'No archive/unarchive control-plane evidence records were available for scoring.'
            : `Task archive evidence score ${String(qualityScoreValue)}/100 over ${String(recordCount)} retained control-plane event(s).`,
      },
      recommendations,
    },
    boundary: {
      readOnly: true,
      liveServicesContacted: false,
      ledgerMutated: false,
      archiveStateMutated: false,
      rawTaskIdsRendered: false,
      rawActorIdsRendered: false,
      rawChannelIdsRendered: false,
      rawReasonsRendered: false,
      rawPayloadRendered: false,
    },
  };
}

function taskArchiveEvidenceReportStatus(input: {
  readonly recordCount: number;
  readonly archiveEventCount: number;
  readonly unarchiveEventCount: number;
  readonly taskScopedRecordCount: number;
  readonly actorAttributedRecordCount: number;
  readonly duplicateArchiveCount: number;
  readonly unmatchedUnarchiveCount: number;
  readonly replayAudit: TaskArchiveEvidenceReplayAudit;
}): TaskArchiveEvidenceReportStatus {
  if (input.replayAudit.unsafePayloadLineCount > 0) return 'fail';
  if (input.recordCount === 0) return 'no-record';
  if (
    input.replayAudit.skippedMalformedLineCount > 0 ||
    input.archiveEventCount === 0 ||
    input.unarchiveEventCount === 0 ||
    input.taskScopedRecordCount < input.recordCount ||
    input.actorAttributedRecordCount < input.recordCount ||
    input.duplicateArchiveCount > 0 ||
    input.unmatchedUnarchiveCount > 0
  ) {
    return 'warn';
  }
  return 'complete';
}

function taskArchiveEvidenceRecommendations(input: {
  readonly recordCount: number;
  readonly archiveEventCount: number;
  readonly unarchiveEventCount: number;
  readonly taskScopedRecordCount: number;
  readonly actorAttributedRecordCount: number;
  readonly duplicateArchiveCount: number;
  readonly unmatchedUnarchiveCount: number;
  readonly replayAudit: TaskArchiveEvidenceReplayAudit;
}): readonly string[] {
  const recommendations: string[] = [];
  if (input.replayAudit.unsafePayloadLineCount > 0) {
    recommendations.push(
      `Remove ${String(input.replayAudit.unsafePayloadLineCount)} unsafe archive payload line(s); retained evidence must contain metadata/hashes only and never raw instructions, prompts, responses, or secrets.`,
    );
  }
  if (input.replayAudit.skippedMalformedLineCount > 0) {
    recommendations.push(
      `Review ${String(input.replayAudit.skippedMalformedLineCount)} malformed/torn archive JSONL line(s); they were excluded from scoring.`,
    );
  }
  if (input.recordCount === 0) {
    recommendations.push(
      'Record at least one task.archived and task.unarchived control-plane event before treating archive UX live proof as retained evidence.',
    );
  }
  if (input.archiveEventCount === 0) {
    recommendations.push('Record at least one retained task.archived audit event.');
  }
  if (input.unarchiveEventCount === 0) {
    recommendations.push('Record at least one retained task.unarchived audit event.');
  }
  if (input.taskScopedRecordCount < input.recordCount) {
    recommendations.push('Ensure every archive audit event is task-scoped.');
  }
  if (input.actorAttributedRecordCount < input.recordCount) {
    recommendations.push('Ensure every archive audit event carries actor attribution or actorPresent=true.');
  }
  if (input.duplicateArchiveCount > 0) {
    recommendations.push(
      `Investigate ${String(input.duplicateArchiveCount)} duplicate archive transition(s) before promoting archive evidence.`,
    );
  }
  if (input.unmatchedUnarchiveCount > 0) {
    recommendations.push(
      `Investigate ${String(input.unmatchedUnarchiveCount)} unmatched unarchive transition(s) before promoting archive evidence.`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      'Task archive retained evidence meets the local scorecard threshold; keep live proof operator-gated until the retained artifact is reviewed.',
    );
  }
  return recommendations;
}

function readTaskArchiveEvidenceLedgerFile(
  ledgerPath: string,
  maxLedgerBytes: number,
): {
  readonly records: readonly InternalTaskArchiveEvidenceRecord[];
  readonly replayAudit: TaskArchiveEvidenceReplayAudit;
} {
  let stat;
  try {
    stat = lstatSync(ledgerPath);
  } catch (error) {
    throw new Error(`--ledger path does not exist: ${ledgerPath}`, { cause: error });
  }
  if (!stat.isFile()) {
    throw new Error(`--ledger path is not a regular file: ${ledgerPath}`);
  }
  if (!Number.isSafeInteger(maxLedgerBytes) || maxLedgerBytes <= 0) {
    throw new Error('--max-ledger-bytes must be a positive safe integer.');
  }
  if (stat.size > maxLedgerBytes) {
    throw new Error(
      `--ledger file exceeds --max-ledger-bytes (${String(stat.size)} > ${String(maxLedgerBytes)}).`,
    );
  }
  return replayTaskArchiveEvidenceJsonl(readFileSync(ledgerPath, 'utf8'));
}

function replayTaskArchiveEvidenceJsonl(content: string): {
  readonly records: readonly InternalTaskArchiveEvidenceRecord[];
  readonly replayAudit: TaskArchiveEvidenceReplayAudit;
} {
  const records: InternalTaskArchiveEvidenceRecord[] = [];
  let totalLineCount = 0;
  let emptyLineCount = 0;
  let parsedEventCount = 0;
  let skippedNonTaskArchiveLineCount = 0;
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
      if (event.type !== 'task.archived' && event.type !== 'task.unarchived') {
        skippedNonTaskArchiveLineCount += 1;
        continue;
      }
      if (hasUnsafeTaskArchivePayload(event.payload)) {
        unsafePayloadLineCount += 1;
        continue;
      }
      const parsed = parseTaskArchiveEvidenceRecord(event);
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
      parsedTaskArchiveRecordCount: records.length,
      skippedNonTaskArchiveLineCount,
      skippedMalformedLineCount,
      unsafePayloadLineCount,
    },
  };
}

function parseTaskArchiveEvidenceRecord(
  event: ControlPlaneEvent,
): InternalTaskArchiveEvidenceRecord | undefined {
  if (event.type !== 'task.archived' && event.type !== 'task.unarchived') {
    return undefined;
  }
  const eventType = event.type;
  const expectedAction: TaskArchiveEvidenceAction =
    eventType === 'task.archived' ? 'archive' : 'unarchive';
  const expectedStatus: TaskArchiveEvidenceStatus =
    eventType === 'task.archived' ? 'archived' : 'unarchived';
  const channelPresent =
    typeof event.channel?.channelId === 'string' ||
    typeof event.conversationId === 'string';
  const audit = event.payload['archiveAudit'];
  if (isRecord(audit)) {
    if (
      (audit['schemaVersion'] !== undefined &&
        audit['schemaVersion'] !== TASK_ARCHIVE_AUDIT_SCHEMA_VERSION) ||
      audit['action'] !== expectedAction ||
      audit['status'] !== expectedStatus ||
      audit['legacyEventType'] !== eventType ||
      audit['retained'] !== true ||
      typeof audit['taskIdPresent'] !== 'boolean' ||
      typeof audit['actorPresent'] !== 'boolean' ||
      typeof audit['reasonPresent'] !== 'boolean' ||
      typeof audit['requestIdPresent'] !== 'boolean'
    ) {
      return undefined;
    }
    const observedAt = optionalIsoInstant(audit['occurredAt']) ?? event.timestamp;
    if (!isIsoInstant(observedAt)) return undefined;
    return {
      observedAt,
      eventType,
      action: expectedAction,
      status: expectedStatus,
      hasTaskId: audit['taskIdPresent'],
      hasActor: audit['actorPresent'],
      hasChannel: channelPresent,
      hasReason: audit['reasonPresent'],
      hasRequestId: audit['requestIdPresent'],
      retained: true,
      ...(isStableRedactedHash(audit['taskHash'])
        ? { taskStateKey: audit['taskHash'] }
        : {}),
    };
  }

  const legacyPayloadKey = eventType === 'task.archived' ? 'archive' : 'unarchive';
  const legacyPayload = event.payload[legacyPayloadKey];
  if (!isRecord(legacyPayload)) return undefined;
  const timestampKey = eventType === 'task.archived' ? 'archivedAt' : 'unarchivedAt';
  const actorKey = eventType === 'task.archived' ? 'archivedBy' : 'unarchivedBy';
  const observedAt = optionalIsoInstant(legacyPayload[timestampKey]) ?? event.timestamp;
  if (!isIsoInstant(observedAt)) return undefined;
  return {
    observedAt,
    eventType,
    action: expectedAction,
    status: expectedStatus,
    hasTaskId: typeof event.taskId === 'string' && event.taskId.length > 0,
    hasActor:
      (typeof legacyPayload[actorKey] === 'string' &&
        legacyPayload[actorKey].length > 0) ||
      (typeof event.actor.userId === 'string' && event.actor.userId.length > 0),
    hasChannel: channelPresent,
    hasReason:
      typeof legacyPayload['reason'] === 'string' &&
      legacyPayload['reason'].trim().length > 0,
    hasRequestId:
      (typeof legacyPayload['requestId'] === 'string' &&
        legacyPayload['requestId'].length > 0) ||
      (typeof event.correlationId === 'string' && event.correlationId.length > 0),
    retained: true,
    ...(typeof event.taskId === 'string' && event.taskId.length > 0
      ? { taskStateKey: event.taskId }
      : {}),
  };
}

function filterTaskArchiveEvidenceRecords(
  records: readonly InternalTaskArchiveEvidenceRecord[],
  filter: TaskArchiveEvidenceReportCliOptions['filter'],
): readonly InternalTaskArchiveEvidenceRecord[] {
  const eventType = filter.eventType ?? actionToEventType(filter.action);
  const filtered = records.filter((record) =>
    eventType === undefined ? true : record.eventType === eventType,
  );
  return filter.limit === undefined
    ? filtered
    : filtered.slice(-Math.max(0, filter.limit));
}

const UNSAFE_TASK_ARCHIVE_PAYLOAD_KEYS = new Set([
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
  'note',
  'body',
  'userId',
  'actorId',
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
const SAFE_TASK_ARCHIVE_AUDIT_KEYS = new Set([
  'schemaVersion',
  'action',
  'legacyEventType',
  'status',
  'occurredAt',
  'retained',
  'taskIdPresent',
  'taskHash',
  'actorPresent',
  'actorHash',
  'reasonPresent',
  'reasonHash',
  'requestIdPresent',
  'requestIdHash',
]);
const UNSAFE_TASK_ARCHIVE_PAYLOAD_SCAN_MAX_DEPTH = 16;

function hasUnsafeTaskArchivePayload(value: unknown): boolean {
  if (
    isRecord(value) &&
    isRecord(value['archiveAudit']) &&
    (value['archive'] !== undefined ||
      value['unarchive'] !== undefined ||
      hasUnexpectedArchiveAuditPayloadKey(value['archiveAudit']) ||
      hasUnsafeArchiveAuditHashValue(value['archiveAudit']))
  ) {
    return true;
  }
  return hasUnsafeTaskArchivePayloadRecursive(value, new WeakSet<object>(), []);
}

function hasUnexpectedArchiveAuditPayloadKey(
  audit: Record<string, unknown>,
): boolean {
  return Object.keys(audit).some((key) => !SAFE_TASK_ARCHIVE_AUDIT_KEYS.has(key));
}

function hasUnsafeArchiveAuditHashValue(audit: Record<string, unknown>): boolean {
  return ['taskHash', 'actorHash', 'reasonHash', 'requestIdHash'].some((key) => {
    const value = audit[key];
    return value !== undefined && !isStableRedactedHash(value);
  });
}

function hasUnsafeTaskArchivePayloadRecursive(
  value: unknown,
  seen: WeakSet<object>,
  path: readonly string[],
): boolean {
  if (path.length > UNSAFE_TASK_ARCHIVE_PAYLOAD_SCAN_MAX_DEPTH) return true;
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.some((item, index) =>
      hasUnsafeTaskArchivePayloadRecursive(item, seen, [...path, String(index)]),
    );
  }
  if (!isRecord(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, nestedValue]) => {
    if (isAllowedTaskArchiveEvidencePayloadKey(path, key)) return false;
    return (
      UNSAFE_TASK_ARCHIVE_PAYLOAD_KEYS.has(key) ||
      hasUnsafeTaskArchivePayloadRecursive(nestedValue, seen, [...path, key])
    );
  });
}

function isAllowedTaskArchiveEvidencePayloadKey(
  path: readonly string[],
  key: string,
): boolean {
  const parent = path.at(-1);
  if (
    (parent === 'archive' && (key === 'reason' || key === 'archivedBy')) ||
    (parent === 'unarchive' && (key === 'reason' || key === 'unarchivedBy'))
  ) {
    return true;
  }
  if (
    parent === 'archiveAudit' &&
    (key === 'taskHash' ||
      key === 'actorHash' ||
      key === 'reasonHash' ||
      key === 'requestIdHash')
  ) {
    return true;
  }
  return false;
}

function actionToEventType(
  action: TaskArchiveEvidenceAction | undefined,
): TaskArchiveEvidenceEventType | undefined {
  if (action === 'archive') return 'task.archived';
  if (action === 'unarchive') return 'task.unarchived';
  return undefined;
}

function eventTypeToAction(
  eventType: TaskArchiveEvidenceEventType | undefined,
): TaskArchiveEvidenceAction | undefined {
  if (eventType === 'task.archived') return 'archive';
  if (eventType === 'task.unarchived') return 'unarchive';
  return undefined;
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

function isStableRedactedHash(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{16}$/u.test(value);
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
  if (!Number.isFinite(date.getTime())) return false;
  const canonicalInput = value.includes('.') ? value : value.replace(/Z$/u, '.000Z');
  return date.toISOString() === canonicalInput;
}
