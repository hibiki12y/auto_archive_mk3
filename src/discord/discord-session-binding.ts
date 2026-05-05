import { createHmac, randomUUID } from 'node:crypto';

import type { ControlPlaneLedgerPort } from '../control/control-plane-ledger.js';

export type DiscordSessionBindingStatus = 'active' | 'released' | 'expired';
export type DiscordSessionBindingAuditAction =
  | 'binding-created'
  | 'binding-released'
  | 'focus-changed'
  | 'binding-expired'
  | 'binding-evicted'
  | 'steering-submitted';

export interface DiscordSessionBindingRecord {
  readonly bindingId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly taskId: string;
  readonly subagentId?: string;
  readonly ownerUserId: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
  readonly status: DiscordSessionBindingStatus;
}

export interface DiscordSessionBindingAudit {
  readonly schemaVersion: 1;
  readonly action: DiscordSessionBindingAuditAction;
  readonly legacyEventType:
    | 'session.binding_created'
    | 'session.binding_released'
    | 'session.focus_changed'
    | 'session.binding_expired'
    | 'session.binding_evicted'
    | 'steering.submitted';
  readonly status: DiscordSessionBindingStatus | 'steering-submitted';
  readonly occurredAt: string;
  readonly retained: true;
  readonly bindingIdPresent: boolean;
  readonly bindingHash?: `sha256:${string}`;
  readonly taskIdPresent: boolean;
  readonly taskHash?: `sha256:${string}`;
  readonly ownerUserIdPresent: boolean;
  readonly ownerHash?: `sha256:${string}`;
  readonly guildIdPresent: boolean;
  readonly guildHash?: `sha256:${string}`;
  readonly channelIdPresent: boolean;
  readonly channelHash?: `sha256:${string}`;
  readonly threadIdPresent: boolean;
  readonly threadHash?: `sha256:${string}`;
  readonly subagentIdPresent: boolean;
  readonly subagentHash?: `sha256:${string}`;
  readonly expiresAtPresent: boolean;
  readonly lastUsedAtPresent: boolean;
}

export interface DiscordSessionBindingManagerOptions {
  readonly idleTimeoutMs?: number;
  readonly maxAgeMs?: number;
  readonly ledger?: ControlPlaneLedgerPort;
  readonly idFactory?: () => string;
  /**
   * When set, terminal records (released/expired) whose `expiresAt` is
   * older than `nowMs() - retainTerminalAfterMs` are lazily deleted at
   * the head of every public method. When undefined (default) no
   * eviction occurs and `snapshot()` returns ALL records (pre-PR contract).
   */
  readonly retainTerminalAfterMs?: number;
  /**
   * Test-injected clock so retention windows can be exercised
   * deterministically. Defaults to `() => Date.now()`.
   */
  readonly nowMs?: () => number;
}

export interface FocusBindingInput {
  readonly guildId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly taskId: string;
  readonly subagentId?: string;
  readonly ownerUserId: string;
  readonly now?: Date;
}

export interface ReleaseBindingInput {
  readonly guildId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly ownerUserId: string;
  readonly now?: Date;
}

export type BindingMutationResult =
  | { readonly status: 'ok'; readonly binding: DiscordSessionBindingRecord }
  | { readonly status: 'denied'; readonly reason: string }
  | { readonly status: 'not-found'; readonly reason: string };

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const SESSION_BINDING_AUDIT_HASH_PEPPER_ENV =
  'AUTO_ARCHIVE_SESSION_BINDING_AUDIT_HASH_PEPPER';
type SessionBindingAuditHashField =
  | 'binding'
  | 'task'
  | 'owner'
  | 'guild'
  | 'channel'
  | 'thread'
  | 'subagent';

function resolveSessionBindingAuditHashPepper(): string {
  const configured = process.env[SESSION_BINDING_AUDIT_HASH_PEPPER_ENV]?.trim();
  return configured === undefined || configured.length === 0
    ? randomUUID()
    : configured;
}

const SESSION_BINDING_AUDIT_HASH_PEPPER = resolveSessionBindingAuditHashPepper();

function clone(record: DiscordSessionBindingRecord): DiscordSessionBindingRecord {
  return { ...record };
}

function bindingKey(input: { channelId: string; threadId?: string }): string {
  return `${input.channelId}:${input.threadId ?? input.channelId}`;
}

function sessionBindingHash(
  field: SessionBindingAuditHashField,
  value: string,
): `sha256:${string}` {
  return `sha256:${createHmac('sha256', SESSION_BINDING_AUDIT_HASH_PEPPER)
    .update('auto-archive.session-binding-audit.v1')
    .update('\0')
    .update(field)
    .update('\0')
    .update(value)
    .digest('hex')
    .slice(0, 16)}`;
}

function optionalHash(
  field: SessionBindingAuditHashField,
  value: string | undefined,
): `sha256:${string}` | undefined {
  return value === undefined || value.length === 0
    ? undefined
    : sessionBindingHash(field, value);
}

function auditActionForEvent(
  type:
    | 'session.binding_created'
    | 'session.binding_released'
    | 'session.focus_changed'
    | 'session.binding_expired'
    | 'session.binding_evicted'
    | 'steering.submitted',
): DiscordSessionBindingAuditAction {
  switch (type) {
    case 'session.binding_created':
      return 'binding-created';
    case 'session.binding_released':
      return 'binding-released';
    case 'session.focus_changed':
      return 'focus-changed';
    case 'session.binding_expired':
      return 'binding-expired';
    case 'session.binding_evicted':
      return 'binding-evicted';
    case 'steering.submitted':
      return 'steering-submitted';
  }
}

export function createDiscordSessionBindingAudit(
  legacyEventType: DiscordSessionBindingAudit['legacyEventType'],
  record: DiscordSessionBindingRecord,
  occurredAt: string,
): DiscordSessionBindingAudit {
  const bindingHash = optionalHash('binding', record.bindingId);
  const taskHash = optionalHash('task', record.taskId);
  const ownerHash = optionalHash('owner', record.ownerUserId);
  const guildHash = optionalHash('guild', record.guildId);
  const channelHash = optionalHash('channel', record.channelId);
  const threadHash = optionalHash('thread', record.threadId);
  const subagentHash = optionalHash('subagent', record.subagentId);
  return {
    schemaVersion: 1,
    action: auditActionForEvent(legacyEventType),
    legacyEventType,
    status:
      legacyEventType === 'steering.submitted'
        ? 'steering-submitted'
        : record.status,
    occurredAt,
    retained: true,
    bindingIdPresent: record.bindingId.length > 0,
    ...(bindingHash === undefined ? {} : { bindingHash }),
    taskIdPresent: record.taskId.length > 0,
    ...(taskHash === undefined ? {} : { taskHash }),
    ownerUserIdPresent: record.ownerUserId.length > 0,
    ...(ownerHash === undefined ? {} : { ownerHash }),
    guildIdPresent: record.guildId.length > 0,
    ...(guildHash === undefined ? {} : { guildHash }),
    channelIdPresent: record.channelId.length > 0,
    ...(channelHash === undefined ? {} : { channelHash }),
    threadIdPresent: record.threadId !== undefined && record.threadId.length > 0,
    ...(threadHash === undefined ? {} : { threadHash }),
    subagentIdPresent:
      record.subagentId !== undefined && record.subagentId.length > 0,
    ...(subagentHash === undefined ? {} : { subagentHash }),
    expiresAtPresent: record.expiresAt.length > 0,
    lastUsedAtPresent: record.lastUsedAt.length > 0,
  };
}

export class DiscordSessionBindingManager {
  private readonly bindings = new Map<string, DiscordSessionBindingRecord>();
  private readonly idleTimeoutMs: number;
  private readonly maxAgeMs: number;
  private readonly idFactory: () => string;
  private readonly retainTerminalAfterMs: number | undefined;
  private readonly nowMs: () => number;

  constructor(private readonly options: DiscordSessionBindingManagerOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.idFactory = options.idFactory ?? (() => `binding-${randomUUID().slice(0, 8)}`);
    this.retainTerminalAfterMs = options.retainTerminalAfterMs;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  focus(input: FocusBindingInput): DiscordSessionBindingRecord {
    const now = input.now ?? new Date(this.nowMs());
    this.pruneTerminalRecords();
    this.expire(now);
    const key = bindingKey(input);
    const existing = this.bindings.get(key);
    if (existing?.status === 'active') {
      const released = { ...existing, status: 'released' as const };
      this.bindings.set(key, released);
      this.record('session.focus_changed', released);
    }
    const createdAt = now.toISOString();
    const maxExpiresAt = new Date(now.getTime() + this.maxAgeMs).toISOString();
    const idleExpiresAt = new Date(now.getTime() + this.idleTimeoutMs).toISOString();
    const record: DiscordSessionBindingRecord = {
      bindingId: this.idFactory(),
      guildId: input.guildId ?? 'dm',
      channelId: input.channelId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      taskId: input.taskId,
      ...(input.subagentId === undefined ? {} : { subagentId: input.subagentId }),
      ownerUserId: input.ownerUserId,
      createdAt,
      lastUsedAt: createdAt,
      expiresAt: Date.parse(idleExpiresAt) < Date.parse(maxExpiresAt) ? idleExpiresAt : maxExpiresAt,
      status: 'active',
    };
    this.bindings.set(key, record);
    this.record('session.binding_created', record);
    return clone(record);
  }

  release(input: ReleaseBindingInput): BindingMutationResult {
    const now = input.now ?? new Date(this.nowMs());
    this.pruneTerminalRecords();
    this.expire(now);
    const key = bindingKey(input);
    const existing = this.bindings.get(key);
    if (existing === undefined || existing.status !== 'active') {
      return { status: 'not-found', reason: 'No active focus binding for this channel/thread.' };
    }
    if (existing.ownerUserId !== input.ownerUserId) {
      return { status: 'denied', reason: 'Only the binding owner can release this focus binding.' };
    }
    const released = { ...existing, status: 'released' as const };
    this.bindings.set(key, released);
    this.record('session.binding_released', released);
    return { status: 'ok', binding: clone(released) };
  }

  active(input: { channelId: string; threadId?: string; ownerUserId?: string; now?: Date }): DiscordSessionBindingRecord | undefined {
    const now = input.now ?? new Date(this.nowMs());
    this.pruneTerminalRecords();
    this.expire(now);
    const existing = this.bindings.get(bindingKey(input));
    if (existing === undefined || existing.status !== 'active') {
      return undefined;
    }
    if (input.ownerUserId !== undefined && existing.ownerUserId !== input.ownerUserId) {
      return undefined;
    }
    const refreshed = {
      ...existing,
      lastUsedAt: now.toISOString(),
      expiresAt: new Date(Math.min(
        Date.parse(existing.createdAt) + this.maxAgeMs,
        now.getTime() + this.idleTimeoutMs,
      )).toISOString(),
    };
    this.bindings.set(bindingKey(input), refreshed);
    return clone(refreshed);
  }

  releaseTask(taskId: string, now: Date = new Date(this.nowMs())): readonly DiscordSessionBindingRecord[] {
    this.pruneTerminalRecords();
    const released: DiscordSessionBindingRecord[] = [];
    for (const [key, record] of this.bindings.entries()) {
      if (record.taskId !== taskId || record.status !== 'active') continue;
      const next = { ...record, status: 'released' as const, lastUsedAt: now.toISOString() };
      this.bindings.set(key, next);
      this.record('session.binding_released', next);
      released.push(clone(next));
    }
    return released;
  }

  expire(now: Date = new Date(this.nowMs())): readonly DiscordSessionBindingRecord[] {
    this.pruneTerminalRecords();
    const expired: DiscordSessionBindingRecord[] = [];
    for (const [key, record] of this.bindings.entries()) {
      if (record.status !== 'active') continue;
      const maxAgeExpired = now.getTime() >= Date.parse(record.createdAt) + this.maxAgeMs;
      const idleExpired = now.getTime() >= Date.parse(record.expiresAt);
      if (!maxAgeExpired && !idleExpired) continue;
      const next = { ...record, status: 'expired' as const };
      this.bindings.set(key, next);
      this.record('session.binding_expired', next);
      expired.push(clone(next));
    }
    return expired;
  }

  snapshot(): readonly DiscordSessionBindingRecord[] {
    this.pruneTerminalRecords();
    return [...this.bindings.values()].map(clone);
  }

  /**
   * Lazy retention sweep. Called at the head of every public method so
   * the bindings Map stays bounded under the documented opt-in policy
   * without requiring a background timer. No-op when `retainTerminalAfterMs`
   * is unset (preserves the pre-PR no-eviction contract).
   */
  private pruneTerminalRecords(): void {
    if (this.retainTerminalAfterMs === undefined) {
      return;
    }
    const cutoff = this.nowMs() - this.retainTerminalAfterMs;
    for (const [key, rec] of this.bindings.entries()) {
      if (rec.status === 'active') continue;
      if (Date.parse(rec.expiresAt) > cutoff) continue;
      this.bindings.delete(key);
      this.record('session.binding_evicted', rec);
    }
  }

  private record(type: 'session.binding_created' | 'session.binding_released' | 'session.focus_changed' | 'session.binding_expired' | 'session.binding_evicted', record: DiscordSessionBindingRecord): void {
    this.options.ledger?.append({
      type,
      actor: { kind: 'discord-user', userId: record.ownerUserId },
      channel: {
        kind: 'discord',
        guildId: record.guildId,
        channelId: record.channelId,
      },
      conversationId: record.threadId ?? record.channelId,
      taskId: record.taskId,
      correlationId: record.bindingId,
      trust: { source: 'discord', inputTrust: 'trusted' },
      payload: {
        bindingAudit: createDiscordSessionBindingAudit(type, record, new Date().toISOString()),
      },
    });
  }
}
