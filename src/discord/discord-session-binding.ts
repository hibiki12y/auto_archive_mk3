import { randomUUID } from 'node:crypto';

import type { ControlPlaneLedgerPort } from '../control/control-plane-ledger.js';

export type DiscordSessionBindingStatus = 'active' | 'released' | 'expired';

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

export interface DiscordSessionBindingManagerOptions {
  readonly idleTimeoutMs?: number;
  readonly maxAgeMs?: number;
  readonly ledger?: ControlPlaneLedgerPort;
  readonly idFactory?: () => string;
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

function clone(record: DiscordSessionBindingRecord): DiscordSessionBindingRecord {
  return { ...record };
}

function bindingKey(input: { channelId: string; threadId?: string }): string {
  return `${input.channelId}:${input.threadId ?? input.channelId}`;
}

export class DiscordSessionBindingManager {
  private readonly bindings = new Map<string, DiscordSessionBindingRecord>();
  private readonly idleTimeoutMs: number;
  private readonly maxAgeMs: number;
  private readonly idFactory: () => string;

  constructor(private readonly options: DiscordSessionBindingManagerOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.idFactory = options.idFactory ?? (() => `binding-${randomUUID().slice(0, 8)}`);
  }

  focus(input: FocusBindingInput): DiscordSessionBindingRecord {
    const now = input.now ?? new Date();
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
    const now = input.now ?? new Date();
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
    const now = input.now ?? new Date();
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

  releaseTask(taskId: string, now: Date = new Date()): readonly DiscordSessionBindingRecord[] {
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

  expire(now: Date = new Date()): readonly DiscordSessionBindingRecord[] {
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
    return [...this.bindings.values()].map(clone);
  }

  private record(type: 'session.binding_created' | 'session.binding_released' | 'session.focus_changed' | 'session.binding_expired', record: DiscordSessionBindingRecord): void {
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
      payload: { binding: record },
    });
  }
}
