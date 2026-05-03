import { randomUUID } from 'node:crypto';

import type {
  ControlPlaneEvent,
  ControlPlaneLedgerPort,
} from '../control/control-plane-ledger.js';

export type ResearchAgendaStatus = 'open' | 'done';

export interface ResearchAgendaItem {
  readonly agendaId: string;
  readonly title: string;
  readonly userId: string;
  readonly channelId?: string;
  readonly status: ResearchAgendaStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface ResearchCadenceRecord {
  readonly conversationId: string;
  readonly cadence: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface DiscordResearchAgendaOptions {
  readonly ledger?: ControlPlaneLedgerPort;
  readonly replayLedger?: boolean;
  readonly idFactory?: () => string;
  readonly now?: () => string;
}

export interface ListResearchAgendaOptions {
  readonly channelId?: string;
  readonly status?: ResearchAgendaStatus | 'all';
  readonly limit?: number;
}

function cloneItem(item: ResearchAgendaItem): ResearchAgendaItem {
  return { ...item };
}

function cloneCadence(cadence: ResearchCadenceRecord): ResearchCadenceRecord {
  return { ...cadence };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResearchAgendaStatus(value: unknown): value is ResearchAgendaStatus {
  return value === 'open' || value === 'done';
}

function isResearchAgendaItem(value: unknown): value is ResearchAgendaItem {
  return (
    isRecord(value) &&
    typeof value['agendaId'] === 'string' &&
    typeof value['title'] === 'string' &&
    typeof value['userId'] === 'string' &&
    (value['channelId'] === undefined || typeof value['channelId'] === 'string') &&
    isResearchAgendaStatus(value['status']) &&
    typeof value['createdAt'] === 'string' &&
    typeof value['updatedAt'] === 'string' &&
    (value['completedAt'] === undefined ||
      typeof value['completedAt'] === 'string')
  );
}

function isResearchCadenceRecord(value: unknown): value is ResearchCadenceRecord {
  return (
    isRecord(value) &&
    typeof value['conversationId'] === 'string' &&
    typeof value['cadence'] === 'string' &&
    typeof value['updatedBy'] === 'string' &&
    typeof value['updatedAt'] === 'string'
  );
}

function normalizeTitle(title: string): string {
  const normalized = title.replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0) {
    throw new TypeError('Research agenda title must be non-empty.');
  }
  return normalized;
}

function normalizeCadence(cadence: string): string {
  const normalized = cadence.replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0) {
    throw new TypeError('Research cadence must be non-empty.');
  }
  return normalized;
}

export class DiscordResearchAgenda {
  private readonly items = new Map<string, ResearchAgendaItem>();
  private readonly cadences = new Map<string, ResearchCadenceRecord>();
  private readonly ledger: ControlPlaneLedgerPort | undefined;
  private readonly idFactory: () => string;
  private readonly now: () => string;
  private replaying = false;

  constructor(options: DiscordResearchAgendaOptions = {}) {
    this.ledger = options.ledger;
    this.idFactory = options.idFactory ?? (() => randomUUID().slice(0, 8));
    this.now = options.now ?? (() => new Date().toISOString());
    if (this.ledger !== undefined && (options.replayLedger ?? true)) {
      this.replayFromLedger(this.ledger.loadAll());
    }
  }

  addItem(input: {
    readonly title: string;
    readonly userId: string;
    readonly channelId?: string;
  }): ResearchAgendaItem {
    const now = this.now();
    const item: ResearchAgendaItem = {
      agendaId: `research-agenda-${this.idFactory()}`,
      title: normalizeTitle(input.title),
      userId: input.userId,
      ...(input.channelId === undefined ? {} : { channelId: input.channelId }),
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(item.agendaId, item);
    this.appendLedgerEvent('research.agenda_item_added', item, input.userId, input.channelId, {
      item,
    });
    return cloneItem(item);
  }

  completeItem(input: {
    readonly agendaId: string;
    readonly userId: string;
    readonly channelId?: string;
  }): ResearchAgendaItem | undefined {
    const existing = this.items.get(input.agendaId);
    if (existing === undefined) {
      return undefined;
    }
    const now = this.now();
    const completed: ResearchAgendaItem = {
      ...existing,
      status: 'done',
      updatedAt: now,
      completedAt: now,
    };
    this.items.set(completed.agendaId, completed);
    this.appendLedgerEvent(
      'research.agenda_item_completed',
      completed,
      input.userId,
      input.channelId ?? completed.channelId,
      { item: completed },
    );
    return cloneItem(completed);
  }

  list(options: ListResearchAgendaOptions = {}): ResearchAgendaItem[] {
    const status = options.status ?? 'open';
    const records = Array.from(this.items.values())
      .filter((item) => {
        if (options.channelId !== undefined && item.channelId !== options.channelId) {
          return false;
        }
        if (status !== 'all' && item.status !== status) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneItem);
    return options.limit === undefined
      ? records
      : records.slice(0, Math.max(0, options.limit));
  }

  setCadence(input: {
    readonly cadence: string;
    readonly userId: string;
    readonly conversationId: string;
    readonly channelId?: string;
  }): ResearchCadenceRecord {
    const record: ResearchCadenceRecord = {
      conversationId: input.conversationId,
      cadence: normalizeCadence(input.cadence),
      updatedBy: input.userId,
      updatedAt: this.now(),
    };
    this.cadences.set(record.conversationId, record);
    this.appendCadenceLedgerEvent(record, input.userId, input.channelId);
    return cloneCadence(record);
  }

  getCadence(conversationId: string | undefined): ResearchCadenceRecord | undefined {
    if (conversationId === undefined) {
      return undefined;
    }
    const record = this.cadences.get(conversationId);
    return record === undefined ? undefined : cloneCadence(record);
  }

  private appendLedgerEvent(
    type: 'research.agenda_item_added' | 'research.agenda_item_completed',
    item: ResearchAgendaItem,
    userId: string,
    channelId: string | undefined,
    payload: Record<string, unknown>,
  ): void {
    if (this.ledger === undefined || this.replaying) {
      return;
    }
    this.ledger.append({
      type,
      actor: { kind: 'discord-user', userId },
      channel: {
        kind: 'discord',
        ...(channelId === undefined ? {} : { channelId }),
      },
      conversationId: channelId,
      correlationId: item.agendaId,
      trust: { source: 'discord', inputTrust: 'trusted' },
      payload,
    });
  }

  private appendCadenceLedgerEvent(
    cadence: ResearchCadenceRecord,
    userId: string,
    channelId: string | undefined,
  ): void {
    if (this.ledger === undefined || this.replaying) {
      return;
    }
    this.ledger.append({
      type: 'research.cadence_set',
      actor: { kind: 'discord-user', userId },
      channel: {
        kind: 'discord',
        ...(channelId === undefined ? {} : { channelId }),
      },
      conversationId: cadence.conversationId,
      correlationId: cadence.conversationId,
      trust: { source: 'discord', inputTrust: 'trusted' },
      payload: { cadence },
    });
  }

  private replayFromLedger(events: readonly ControlPlaneEvent[]): void {
    this.replaying = true;
    try {
      for (const event of events) {
        if (
          event.type === 'research.agenda_item_added' ||
          event.type === 'research.agenda_item_completed'
        ) {
          const item = event.payload['item'];
          if (isResearchAgendaItem(item)) {
            this.items.set(item.agendaId, cloneItem(item));
          }
          continue;
        }
        if (event.type === 'research.cadence_set') {
          const cadence = event.payload['cadence'];
          if (isResearchCadenceRecord(cadence)) {
            this.cadences.set(cadence.conversationId, cloneCadence(cadence));
          }
        }
      }
    } finally {
      this.replaying = false;
    }
  }
}
