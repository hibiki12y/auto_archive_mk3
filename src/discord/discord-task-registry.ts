import { createHash } from 'node:crypto';

import type { LifecyclePhaseObservation } from '../contracts/dispatch-lifecycle.js';
import type { DispatchAcceptance } from '../contracts/dispatch-submission.js';
import type { CancellationReceipt } from '../core/dispatcher.js';
import type { TerminalEvidence } from '../contracts/terminal-evidence.js';
import type {
  ControlPlaneEvent,
  ControlPlaneLedgerPort,
} from '../control/control-plane-ledger.js';

export type DiscordTaskCoarseState = 'accepted' | 'running' | 'terminal';
export type DiscordTaskCommandName = 'ask' | 'research';
export type DiscordTaskAuditStageStatus =
  | 'captured'
  | 'attempted'
  | 'missing'
  | 'weak'
  | 'skipped';
export type DiscordTaskAuditMatchSignal =
  | 'marker'
  | 'task-id'
  | 'author'
  | 'timing'
  | 'lifecycle-shape';

export interface DiscordTaskAuditStage {
  status: DiscordTaskAuditStageStatus;
  summary: string;
  observedAt?: string;
  source?: string;
  marker?: string;
  taskId?: string;
  messageId?: string;
  authorId?: string;
  matchedOn?: readonly DiscordTaskAuditMatchSignal[];
}

export interface DiscordTaskMarkerAudit {
  marker?: string;
  submit: DiscordTaskAuditStage;
  taskCorrelation: DiscordTaskAuditStage;
  ack: DiscordTaskAuditStage;
  matchedReply: DiscordTaskAuditStage;
  updatedAt: string;
}

export const DISCORD_TASK_ARCHIVE_AUDIT_SCHEMA_VERSION = 1 as const;

export type DiscordTaskArchiveAuditAction = 'archive' | 'unarchive';
export type DiscordTaskArchiveAuditStatus =
  | 'archived'
  | 'unarchived'
  | 'already-archived'
  | 'not-archived';

export interface DiscordTaskArchive {
  archivedAt: string;
  archivedBy: string;
  reason?: string;
}

export interface DiscordTaskUnarchive {
  unarchivedAt: string;
  unarchivedBy: string;
  reason?: string;
}

export interface DiscordTaskArchiveControlPlaneAudit {
  schemaVersion: typeof DISCORD_TASK_ARCHIVE_AUDIT_SCHEMA_VERSION;
  action: DiscordTaskArchiveAuditAction;
  legacyEventType: 'task.archived' | 'task.unarchived';
  status: DiscordTaskArchiveAuditStatus;
  occurredAt: string;
  retained: true;
  taskIdPresent: boolean;
  taskHash?: string;
  actorPresent: boolean;
  actorHash?: string;
  reasonPresent: boolean;
  reasonHash?: string;
  requestIdPresent: boolean;
  requestIdHash?: string;
}

export interface DiscordTaskAuditStageInput {
  status: DiscordTaskAuditStageStatus;
  summary?: string;
  observedAt?: string;
  source?: string;
  marker?: string;
  taskId?: string;
  messageId?: string;
  authorId?: string;
  matchedOn?: readonly DiscordTaskAuditMatchSignal[];
}

export interface DiscordTaskAuditUpdateInput {
  observedAt: string;
  marker?: string;
  submit?: DiscordTaskAuditStageInput;
  taskCorrelation?: DiscordTaskAuditStageInput;
  ack?: DiscordTaskAuditStageInput;
  matchedReply?: DiscordTaskAuditStageInput;
}

export interface DiscordTaskRecord {
  taskId: string;
  commandName?: DiscordTaskCommandName;
  instruction: string;
  requestedInstruction?: string;
  rerunOfTaskId?: string;
  userId: string;
  channelId?: string;
  acceptance: DispatchAcceptance;
  coarseState: DiscordTaskCoarseState;
  lastLifecyclePhase: LifecyclePhaseObservation['phase'];
  updatedAt: string;
  markerAudit?: DiscordTaskMarkerAudit;
  archive?: DiscordTaskArchive;
  terminalEvidence?: TerminalEvidence;
  cancellationReceipt?: CancellationReceipt;
}

export interface RegisterDiscordTaskInput {
  taskId: string;
  commandName?: DiscordTaskCommandName;
  instruction: string;
  requestedInstruction?: string;
  rerunOfTaskId?: string;
  userId: string;
  channelId?: string;
  guildId?: string;
  acceptance: DispatchAcceptance;
}

export interface DiscordTaskRegistryOptions {
  readonly ledger?: ControlPlaneLedgerPort;
  readonly replayLedger?: boolean;
}

export interface ListDiscordTasksOptions {
  readonly userId?: string;
  readonly channelId?: string;
  readonly state?: DiscordTaskCoarseState | 'active' | 'all' | 'archived';
  readonly limit?: number;
}

function cloneRecord(record: DiscordTaskRecord): DiscordTaskRecord {
  return {
    ...record,
    acceptance: {
      ...record.acceptance,
    },
    markerAudit:
      record.markerAudit === undefined
        ? undefined
        : cloneMarkerAudit(record.markerAudit),
    archive:
      record.archive === undefined ? undefined : { ...record.archive },
    terminalEvidence: record.terminalEvidence,
    cancellationReceipt: record.cancellationReceipt
      ? { ...record.cancellationReceipt }
      : undefined,
  };
}

function cloneAuditStage(stage: DiscordTaskAuditStage): DiscordTaskAuditStage {
  return {
    ...stage,
    matchedOn: stage.matchedOn === undefined ? undefined : [...stage.matchedOn],
  };
}

function cloneMarkerAudit(audit: DiscordTaskMarkerAudit): DiscordTaskMarkerAudit {
  return {
    ...audit,
    submit: cloneAuditStage(audit.submit),
    taskCorrelation: cloneAuditStage(audit.taskCorrelation),
    ack: cloneAuditStage(audit.ack),
    matchedReply: cloneAuditStage(audit.matchedReply),
  };
}

function cloneAuditStageInput(
  input: DiscordTaskAuditStageInput,
): DiscordTaskAuditStageInput {
  return {
    ...input,
    matchedOn: input.matchedOn === undefined ? undefined : [...input.matchedOn],
  };
}

function cloneAuditUpdateInput(
  input: DiscordTaskAuditUpdateInput,
): DiscordTaskAuditUpdateInput {
  return {
    ...input,
    submit: input.submit === undefined ? undefined : cloneAuditStageInput(input.submit),
    taskCorrelation:
      input.taskCorrelation === undefined
        ? undefined
        : cloneAuditStageInput(input.taskCorrelation),
    ack: input.ack === undefined ? undefined : cloneAuditStageInput(input.ack),
    matchedReply:
      input.matchedReply === undefined
        ? undefined
        : cloneAuditStageInput(input.matchedReply),
  };
}

function defaultAuditSummary(
  stage: keyof Omit<DiscordTaskMarkerAudit, 'marker' | 'updatedAt'>,
  status: DiscordTaskAuditStageStatus,
): string {
  switch (stage) {
    case 'submit':
      return status === 'attempted'
        ? 'Remote submit was attempted.'
        : status === 'captured'
          ? 'Remote submit evidence was captured.'
          : status === 'missing'
            ? 'Remote submit evidence is missing.'
            : status === 'weak'
              ? 'Remote submit evidence is indirect or weak.'
              : 'Remote submit did not run in this record.';
    case 'taskCorrelation':
      return status === 'captured'
        ? 'Task correlation was captured.'
        : status === 'weak'
          ? 'Task correlation is indirect or marker-only.'
          : status === 'missing'
            ? 'Task correlation evidence is missing.'
            : status === 'attempted'
              ? 'Task correlation was attempted.'
              : 'Task correlation was skipped.';
    case 'ack':
      return status === 'captured'
        ? 'Acknowledgement evidence was captured.'
        : status === 'weak'
          ? 'Acknowledgement evidence is indirect or weak.'
          : status === 'missing'
            ? 'Acknowledgement evidence is missing.'
            : status === 'attempted'
              ? 'Acknowledgement capture was attempted.'
              : 'Acknowledgement capture was skipped.';
    case 'matchedReply':
      return status === 'captured'
        ? 'Matched reply evidence was captured.'
        : status === 'weak'
          ? 'Matched reply evidence is indirect or weak.'
          : status === 'missing'
            ? 'Matched reply evidence is missing.'
            : status === 'attempted'
              ? 'Matched reply capture was attempted.'
              : 'Matched reply capture was skipped.';
  }
}

function buildAuditStage(
  stage: keyof Omit<DiscordTaskMarkerAudit, 'marker' | 'updatedAt'>,
  input: DiscordTaskAuditStageInput,
): DiscordTaskAuditStage {
  return {
    status: input.status,
    summary: input.summary ?? defaultAuditSummary(stage, input.status),
    observedAt: input.observedAt,
    source: input.source,
    marker: input.marker,
    taskId: input.taskId,
    messageId: input.messageId,
    authorId: input.authorId,
    matchedOn: input.matchedOn === undefined ? undefined : [...input.matchedOn],
  };
}

function applyAuditStageUpdate(
  current: DiscordTaskAuditStage,
  stage: keyof Omit<DiscordTaskMarkerAudit, 'marker' | 'updatedAt'>,
  update: DiscordTaskAuditStageInput | undefined,
  observedAt: string,
): DiscordTaskAuditStage {
  if (update === undefined) {
    return cloneAuditStage(current);
  }
  return {
    ...current,
    ...buildAuditStage(stage, update),
    observedAt: update.observedAt ?? observedAt,
  };
}

function createDefaultMarkerAudit(observedAt: string): DiscordTaskMarkerAudit {
  return {
    submit: buildAuditStage('submit', { status: 'skipped', observedAt }),
    taskCorrelation: buildAuditStage('taskCorrelation', {
      status: 'skipped',
      observedAt,
    }),
    ack: buildAuditStage('ack', { status: 'skipped', observedAt }),
    matchedReply: buildAuditStage('matchedReply', { status: 'skipped', observedAt }),
    updatedAt: observedAt,
  };
}

function mapLifecyclePhaseToCoarseState(
  phase: LifecyclePhaseObservation['phase'],
): DiscordTaskCoarseState {
  switch (phase) {
    case 'accepted':
      return 'accepted';
    case 'terminal':
      return 'terminal';
    default:
      return 'running';
  }
}

export class DiscordTaskRegistry {
  private readonly tasks = new Map<string, DiscordTaskRecord>();
  private readonly ledger: ControlPlaneLedgerPort | undefined;
  private replaying = false;

  constructor(options: DiscordTaskRegistryOptions = {}) {
    this.ledger = options.ledger;
    if (this.ledger !== undefined && (options.replayLedger ?? true)) {
      this.replayFromLedger(this.ledger.loadAll());
    }
  }

  registerTask(input: RegisterDiscordTaskInput): DiscordTaskRecord {
    const record: DiscordTaskRecord = {
      taskId: input.taskId,
      ...(input.commandName === undefined
        ? {}
        : { commandName: input.commandName }),
      instruction: input.instruction,
      ...(input.requestedInstruction === undefined
        ? {}
        : { requestedInstruction: input.requestedInstruction }),
      ...(input.rerunOfTaskId === undefined
        ? {}
        : { rerunOfTaskId: input.rerunOfTaskId }),
      userId: input.userId,
      channelId: input.channelId,
      acceptance: {
        ...input.acceptance,
      },
      coarseState: 'accepted',
      lastLifecyclePhase: 'accepted',
      updatedAt: input.acceptance.acceptedAt,
    };

    this.tasks.set(input.taskId, record);
    this.recordLedgerEvent('task.accepted', input.taskId, input.userId, input.channelId, {
      record,
    });
    return cloneRecord(record);
  }

  observeLifecycle(
    observation: LifecyclePhaseObservation,
  ): { record: DiscordTaskRecord; coarseStateChanged: boolean } | undefined {
    const existing = this.tasks.get(observation.taskId);
    if (!existing) {
      return undefined;
    }

    const previousState = existing.coarseState;
    if (existing.archive === undefined) {
      existing.lastLifecyclePhase = observation.phase;
      existing.coarseState = mapLifecyclePhaseToCoarseState(observation.phase);
      existing.updatedAt = observation.observedAt;
    }
    if (this.ledger !== undefined && !this.replaying) {
      this.ledger.append({
        type: 'task.lifecycle_observed',
        actor: {
          kind: 'system',
        },
        channel: {
          kind: 'discord',
          ...(existing.channelId === undefined
            ? {}
            : { channelId: existing.channelId }),
        },
        conversationId: existing.channelId,
        taskId: observation.taskId,
        trust: {
          source: 'system',
          inputTrust: 'trusted',
        },
        payload: { observation },
      });
    }

    return {
      record: cloneRecord(existing),
      coarseStateChanged:
        existing.archive === undefined && previousState !== existing.coarseState,
    };
  }

  private observeLifecycleFromReplay(
    observation: LifecyclePhaseObservation,
  ): void {
    const existing = this.tasks.get(observation.taskId);
    if (!existing) {
      return;
    }
    if (existing.archive !== undefined) {
      return;
    }
    existing.lastLifecyclePhase = observation.phase;
    existing.coarseState = mapLifecyclePhaseToCoarseState(observation.phase);
    existing.updatedAt = observation.observedAt;
  }

  recordCancellation(
    taskId: string,
    receipt: CancellationReceipt,
  ): DiscordTaskRecord | undefined {
    const existing = this.tasks.get(taskId);
    if (!existing) {
      return undefined;
    }

    existing.cancellationReceipt = {
      ...receipt,
    };
    existing.updatedAt = receipt.requestedAt;
    this.recordLedgerEvent(
      'task.cancel_requested',
      taskId,
      existing.userId,
      existing.channelId,
      { receipt },
    );
    return cloneRecord(existing);
  }

  markTerminal(taskId: string, evidence: TerminalEvidence): DiscordTaskRecord | undefined {
    const existing = this.tasks.get(taskId);
    if (!existing) {
      return undefined;
    }

    existing.coarseState = 'terminal';
    existing.lastLifecyclePhase = 'terminal';
    existing.updatedAt = evidence.endedAt;
    existing.terminalEvidence = evidence;
    this.recordLedgerEvent(
      'task.terminal',
      taskId,
      existing.userId,
      existing.channelId,
      { evidence },
    );
    return cloneRecord(existing);
  }

  archiveTask(input: {
    readonly taskId: string;
    readonly archivedAt: string;
    readonly archivedBy: string;
    readonly reason?: string;
    readonly requestId?: string;
  }): DiscordTaskRecord | undefined {
    const existing = this.tasks.get(input.taskId);
    if (!existing) {
      return undefined;
    }
    if (existing.archive !== undefined) {
      return cloneRecord(existing);
    }

    const archive: DiscordTaskArchive = {
      archivedAt: input.archivedAt,
      archivedBy: input.archivedBy,
      ...(input.reason === undefined || input.reason.trim().length === 0
        ? {}
        : { reason: input.reason.trim() }),
    };
    existing.archive = archive;
    existing.updatedAt = input.archivedAt;
    this.recordLedgerEvent(
      'task.archived',
      input.taskId,
      existing.userId,
      existing.channelId,
      buildArchiveControlPlanePayload({
        action: 'archive',
        legacyEventType: 'task.archived',
        status: 'archived',
        occurredAt: input.archivedAt,
        taskId: input.taskId,
        actorId: input.archivedBy,
        reason: input.reason,
        requestId: input.requestId,
      }),
    );
    return cloneRecord(existing);
  }

  unarchiveTask(input: {
    readonly taskId: string;
    readonly unarchivedAt: string;
    readonly unarchivedBy: string;
    readonly reason?: string;
    readonly requestId?: string;
  }): DiscordTaskRecord | undefined {
    const existing = this.tasks.get(input.taskId);
    if (!existing) {
      return undefined;
    }
    if (existing.archive === undefined) {
      return cloneRecord(existing);
    }

    existing.archive = undefined;
    existing.updatedAt = input.unarchivedAt;
    this.recordLedgerEvent(
      'task.unarchived',
      input.taskId,
      existing.userId,
      existing.channelId,
      buildArchiveControlPlanePayload({
        action: 'unarchive',
        legacyEventType: 'task.unarchived',
        status: 'unarchived',
        occurredAt: input.unarchivedAt,
        taskId: input.taskId,
        actorId: input.unarchivedBy,
        reason: input.reason,
        requestId: input.requestId,
      }),
    );
    return cloneRecord(existing);
  }

  recordMarkerAudit(
    taskId: string,
    update: DiscordTaskAuditUpdateInput,
  ): DiscordTaskRecord | undefined {
    const existing = this.tasks.get(taskId);
    if (!existing) {
      return undefined;
    }

    const currentAudit = existing.markerAudit ?? createDefaultMarkerAudit(update.observedAt);
    existing.markerAudit = {
      ...cloneMarkerAudit(currentAudit),
      ...(update.marker === undefined ? {} : { marker: update.marker }),
      submit: applyAuditStageUpdate(
        currentAudit.submit,
        'submit',
        update.submit,
        update.observedAt,
      ),
      taskCorrelation: applyAuditStageUpdate(
        currentAudit.taskCorrelation,
        'taskCorrelation',
        update.taskCorrelation,
        update.observedAt,
      ),
      ack: applyAuditStageUpdate(currentAudit.ack, 'ack', update.ack, update.observedAt),
      matchedReply: applyAuditStageUpdate(
        currentAudit.matchedReply,
        'matchedReply',
        update.matchedReply,
        update.observedAt,
      ),
      updatedAt: update.observedAt,
    };
    existing.updatedAt = update.observedAt;
    if (this.ledger !== undefined && !this.replaying) {
      this.ledger.append({
        type: 'task.marker_audit_recorded',
        actor: {
          kind: 'system',
        },
        channel: {
          kind: 'discord',
          ...(existing.channelId === undefined ? {} : { channelId: existing.channelId }),
        },
        conversationId: existing.channelId,
        taskId,
        trust: {
          source: 'system',
          inputTrust: 'trusted',
        },
        payload: {
          auditUpdate: cloneAuditUpdateInput(update),
        },
      });
    }
    return cloneRecord(existing);
  }

  get(taskId: string): DiscordTaskRecord | undefined {
    const record = this.tasks.get(taskId);
    return record ? cloneRecord(record) : undefined;
  }

  list(options: ListDiscordTasksOptions = {}): DiscordTaskRecord[] {
    const state = options.state ?? 'all';
    const records = Array.from(this.tasks.values())
      .filter((record) => {
        if (options.userId !== undefined && record.userId !== options.userId) {
          return false;
        }
        if (
          options.channelId !== undefined &&
          record.channelId !== options.channelId
        ) {
          return false;
        }
        if (state === 'archived') {
          return record.archive !== undefined;
        }
        if (record.archive !== undefined) {
          return false;
        }
        if (state === 'all') {
          return true;
        }
        if (state === 'active') {
          return record.coarseState !== 'terminal';
        }
        return record.coarseState === state;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneRecord);
    return options.limit === undefined
      ? records
      : records.slice(0, Math.max(0, options.limit));
  }

  private recordLedgerEvent(
    type:
      | 'task.accepted'
      | 'task.cancel_requested'
      | 'task.terminal'
      | 'task.archived'
      | 'task.unarchived',
    taskId: string,
    userId: string,
    channelId: string | undefined,
    payload: Record<string, unknown>,
  ): void {
    if (this.ledger === undefined || this.replaying) {
      return;
    }
    this.ledger.append({
      type,
      actor: {
        kind: 'discord-user',
        userId,
      },
      channel: {
        kind: 'discord',
        ...(channelId === undefined ? {} : { channelId }),
      },
      conversationId: channelId,
      taskId,
      trust: {
        source: 'discord',
        inputTrust: 'trusted',
      },
      payload,
    });
  }

  private replayFromLedger(events: readonly ControlPlaneEvent[]): void {
    this.replaying = true;
    try {
      for (const event of events) {
        if (event.type === 'task.accepted') {
          const record = event.payload['record'];
          if (isDiscordTaskRecord(record)) {
            this.tasks.set(record.taskId, cloneRecord(record));
          }
          continue;
        }
        if (event.type === 'task.lifecycle_observed') {
          const observation = event.payload['observation'];
          if (isLifecycleObservation(observation)) {
            this.observeLifecycleFromReplay(observation);
          }
          continue;
        }
        if (event.type === 'task.marker_audit_recorded') {
          const auditUpdate = event.payload['auditUpdate'];
          if (
            typeof event.taskId === 'string' &&
            isDiscordTaskAuditUpdateInput(auditUpdate)
          ) {
            this.recordMarkerAudit(event.taskId, auditUpdate);
          }
          continue;
        }
        if (event.type === 'task.cancel_requested') {
          const receipt = event.payload['receipt'];
          const record = this.tasks.get(event.taskId ?? '');
          if (record !== undefined && isCancellationReceipt(receipt)) {
            record.cancellationReceipt = { ...receipt };
            record.updatedAt = receipt.requestedAt;
          }
          continue;
        }
        if (event.type === 'task.archived') {
          const archive = event.payload['archive'];
          const audit = event.payload['archiveAudit'];
          const record = this.tasks.get(event.taskId ?? '');
          if (record !== undefined && isDiscordTaskArchive(archive)) {
            record.archive = { ...archive };
            record.updatedAt = archive.archivedAt;
          } else if (record !== undefined && isDiscordTaskArchiveControlPlaneAudit(audit)) {
            record.archive = {
              archivedAt: audit.occurredAt,
              archivedBy: audit.actorHash ?? 'redacted-actor',
            };
            record.updatedAt = audit.occurredAt;
          }
          continue;
        }
        if (event.type === 'task.unarchived') {
          const unarchive = event.payload['unarchive'];
          const audit = event.payload['archiveAudit'];
          const record = this.tasks.get(event.taskId ?? '');
          if (record !== undefined && isDiscordTaskUnarchive(unarchive)) {
            record.archive = undefined;
            record.updatedAt = unarchive.unarchivedAt;
          } else if (record !== undefined && isDiscordTaskArchiveControlPlaneAudit(audit)) {
            record.archive = undefined;
            record.updatedAt = audit.occurredAt;
          }
          continue;
        }
        if (event.type === 'task.terminal') {
          const evidence = event.payload['evidence'];
          const record = this.tasks.get(event.taskId ?? '');
          if (record !== undefined && isTerminalEvidence(evidence)) {
            record.coarseState = 'terminal';
            record.lastLifecyclePhase = 'terminal';
            record.updatedAt = evidence.endedAt;
            record.terminalEvidence = evidence;
          }
        }
      }
    } finally {
      this.replaying = false;
    }
  }
}


function buildArchiveControlPlanePayload(input: {
  readonly action: DiscordTaskArchiveAuditAction;
  readonly legacyEventType: 'task.archived' | 'task.unarchived';
  readonly status: DiscordTaskArchiveAuditStatus;
  readonly occurredAt: string;
  readonly taskId: string;
  readonly actorId: string;
  readonly reason?: string;
  readonly requestId?: string;
}): { readonly archiveAudit: DiscordTaskArchiveControlPlaneAudit } {
  const reason = input.reason?.trim();
  const requestId = input.requestId?.trim();
  const audit: DiscordTaskArchiveControlPlaneAudit = {
    schemaVersion: DISCORD_TASK_ARCHIVE_AUDIT_SCHEMA_VERSION,
    action: input.action,
    legacyEventType: input.legacyEventType,
    status: input.status,
    occurredAt: input.occurredAt,
    retained: true,
    taskIdPresent: input.taskId.length > 0,
    ...(input.taskId.length === 0
      ? {}
      : { taskHash: stableRedactedHash(input.taskId) }),
    actorPresent: input.actorId.length > 0,
    ...(input.actorId.length === 0
      ? {}
      : { actorHash: stableRedactedHash(input.actorId) }),
    reasonPresent: reason !== undefined && reason.length > 0,
    ...(reason === undefined || reason.length === 0
      ? {}
      : { reasonHash: stableRedactedHash(reason) }),
    requestIdPresent: requestId !== undefined && requestId.length > 0,
    ...(requestId === undefined || requestId.length === 0
      ? {}
      : { requestIdHash: stableRedactedHash(requestId) }),
  };
  return { archiveAudit: audit };
}

function stableRedactedHash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function isStableRedactedHash(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{16}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDiscordTaskRecord(value: unknown): value is DiscordTaskRecord {
  return (
    isRecord(value) &&
    typeof value['taskId'] === 'string' &&
    (value['commandName'] === undefined ||
      value['commandName'] === 'ask' ||
      value['commandName'] === 'research') &&
    typeof value['instruction'] === 'string' &&
    (value['requestedInstruction'] === undefined ||
      typeof value['requestedInstruction'] === 'string') &&
    (value['rerunOfTaskId'] === undefined ||
      typeof value['rerunOfTaskId'] === 'string') &&
    typeof value['userId'] === 'string' &&
    isRecord(value['acceptance']) &&
    (value['coarseState'] === 'accepted' ||
      value['coarseState'] === 'running' ||
      value['coarseState'] === 'terminal') &&
    typeof value['lastLifecyclePhase'] === 'string' &&
    typeof value['updatedAt'] === 'string' &&
    (value['markerAudit'] === undefined ||
      isDiscordTaskMarkerAudit(value['markerAudit'])) &&
    (value['archive'] === undefined || isDiscordTaskArchive(value['archive']))
  );
}

function isDiscordTaskArchive(value: unknown): value is DiscordTaskArchive {
  return (
    isRecord(value) &&
    typeof value['archivedAt'] === 'string' &&
    typeof value['archivedBy'] === 'string' &&
    (value['reason'] === undefined || typeof value['reason'] === 'string')
  );
}

function isDiscordTaskUnarchive(value: unknown): value is DiscordTaskUnarchive {
  return (
    isRecord(value) &&
    typeof value['unarchivedAt'] === 'string' &&
    typeof value['unarchivedBy'] === 'string' &&
    (value['reason'] === undefined || typeof value['reason'] === 'string')
  );
}

function isAuditStageStatus(value: unknown): value is DiscordTaskAuditStageStatus {
  return (
    value === 'captured' ||
    value === 'attempted' ||
    value === 'missing' ||
    value === 'weak' ||
    value === 'skipped'
  );
}

function isAuditMatchSignal(value: unknown): value is DiscordTaskAuditMatchSignal {
  return (
    value === 'marker' ||
    value === 'task-id' ||
    value === 'author' ||
    value === 'timing' ||
    value === 'lifecycle-shape'
  );
}

function isDiscordTaskAuditStage(value: unknown): value is DiscordTaskAuditStage {
  return (
    isRecord(value) &&
    isAuditStageStatus(value['status']) &&
    typeof value['summary'] === 'string' &&
    (value['matchedOn'] === undefined ||
      (Array.isArray(value['matchedOn']) &&
        value['matchedOn'].every((entry) => isAuditMatchSignal(entry))))
  );
}

function isDiscordTaskAuditStageInput(
  value: unknown,
): value is DiscordTaskAuditStageInput {
  return (
    isRecord(value) &&
    isAuditStageStatus(value['status']) &&
    (value['summary'] === undefined || typeof value['summary'] === 'string') &&
    (value['observedAt'] === undefined || typeof value['observedAt'] === 'string') &&
    (value['source'] === undefined || typeof value['source'] === 'string') &&
    (value['marker'] === undefined || typeof value['marker'] === 'string') &&
    (value['taskId'] === undefined || typeof value['taskId'] === 'string') &&
    (value['messageId'] === undefined || typeof value['messageId'] === 'string') &&
    (value['authorId'] === undefined || typeof value['authorId'] === 'string') &&
    (value['matchedOn'] === undefined ||
      (Array.isArray(value['matchedOn']) &&
        value['matchedOn'].every((entry) => isAuditMatchSignal(entry))))
  );
}

function isDiscordTaskAuditUpdateInput(
  value: unknown,
): value is DiscordTaskAuditUpdateInput {
  return (
    isRecord(value) &&
    typeof value['observedAt'] === 'string' &&
    (value['marker'] === undefined || typeof value['marker'] === 'string') &&
    (value['submit'] === undefined || isDiscordTaskAuditStageInput(value['submit'])) &&
    (value['taskCorrelation'] === undefined ||
      isDiscordTaskAuditStageInput(value['taskCorrelation'])) &&
    (value['ack'] === undefined || isDiscordTaskAuditStageInput(value['ack'])) &&
    (value['matchedReply'] === undefined ||
      isDiscordTaskAuditStageInput(value['matchedReply']))
  );
}

function isDiscordTaskMarkerAudit(value: unknown): value is DiscordTaskMarkerAudit {
  return (
    isRecord(value) &&
    isDiscordTaskAuditStage(value['submit']) &&
    isDiscordTaskAuditStage(value['taskCorrelation']) &&
    isDiscordTaskAuditStage(value['ack']) &&
    isDiscordTaskAuditStage(value['matchedReply']) &&
    typeof value['updatedAt'] === 'string'
  );
}

function isLifecycleObservation(
  value: unknown,
): value is LifecyclePhaseObservation {
  return (
    isRecord(value) &&
    typeof value['taskId'] === 'string' &&
    typeof value['phase'] === 'string' &&
    typeof value['observedAt'] === 'string'
  );
}

function isCancellationReceipt(value: unknown): value is CancellationReceipt {
  return (
    isRecord(value) &&
    typeof value['taskId'] === 'string' &&
    typeof value['reason'] === 'string' &&
    typeof value['provenance'] === 'string' &&
    typeof value['requestedAt'] === 'string' &&
    (value['status'] === 'accepted' || value['status'] === 'not-active')
  );
}

function isTerminalEvidence(value: unknown): value is TerminalEvidence {
  return (
    isRecord(value) &&
    typeof value['taskId'] === 'string' &&
    typeof value['reason'] === 'string' &&
    typeof value['provenance'] === 'string' &&
    typeof value['startedAt'] === 'string' &&
    typeof value['endedAt'] === 'string' &&
    isRecord(value['cause'])
  );
}

function isDiscordTaskArchiveControlPlaneAudit(
  value: unknown,
): value is DiscordTaskArchiveControlPlaneAudit {
  return (
    isRecord(value) &&
    value['schemaVersion'] === DISCORD_TASK_ARCHIVE_AUDIT_SCHEMA_VERSION &&
    (value['action'] === 'archive' || value['action'] === 'unarchive') &&
    (value['legacyEventType'] === 'task.archived' ||
      value['legacyEventType'] === 'task.unarchived') &&
    (value['status'] === 'archived' ||
      value['status'] === 'unarchived' ||
      value['status'] === 'already-archived' ||
      value['status'] === 'not-archived') &&
    typeof value['occurredAt'] === 'string' &&
    value['retained'] === true &&
    typeof value['taskIdPresent'] === 'boolean' &&
    (value['taskHash'] === undefined || isStableRedactedHash(value['taskHash'])) &&
    typeof value['actorPresent'] === 'boolean' &&
    (value['actorHash'] === undefined || isStableRedactedHash(value['actorHash'])) &&
    typeof value['reasonPresent'] === 'boolean' &&
    (value['reasonHash'] === undefined || isStableRedactedHash(value['reasonHash'])) &&
    typeof value['requestIdPresent'] === 'boolean' &&
    (value['requestIdHash'] === undefined ||
      isStableRedactedHash(value['requestIdHash']))
  );
}
