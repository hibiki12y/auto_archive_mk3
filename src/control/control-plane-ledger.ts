import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const CONTROL_PLANE_EVENT_SCHEMA_VERSION = 1 as const;
export const CONTROL_PLANE_LEDGER_LOAD_SINCE_MAX_BYTES = 10 * 1024 * 1024;

export const CONTROL_PLANE_EVENT_TYPES = [
  'conversation.message_observed',
  'conversation.context_selected',
  'task.requested',
  'task.accepted',
  'task.marker_audit_recorded',
  'task.lifecycle_observed',
  'task.health_stalled',
  'task.terminal',
  'task.cancel_requested',
  'task.archived',
  'task.unarchived',
  // UX-25 (cycle 11): per-deliver-op record so automated tests can
  // verify in-place edit (cycle 8/10) and per-task thread (cycle 9)
  // by reading the ledger alone — no Discord REST fetch required.
  // payload: { operation, eventType, sequence, messageId?, channelId?, threadId?, deliveryStatus }
  'task.delivery_observed',
  'approval.requested',
  'approval.resolved',
  'escalation.requested',
  'session.binding_created',
  'session.binding_released',
  'session.focus_changed',
  'session.binding_expired',
  'session.binding_evicted',
  'research.agenda_item_added',
  'research.agenda_item_completed',
  'research.cadence_set',
  'steering.submitted',
  'memory.promotion_candidate',
  'memory.promotion_decided',
] as const;

export type ControlPlaneEventType = (typeof CONTROL_PLANE_EVENT_TYPES)[number];

export interface ControlPlaneActor {
  readonly kind: 'discord-user' | 'arona' | 'plana' | 'system';
  readonly userId?: string;
}

export interface ControlPlaneChannelRef {
  readonly kind: 'discord' | 'system';
  readonly guildId?: string;
  readonly channelId?: string;
  readonly messageId?: string;
}

export interface ControlPlaneTrustEnvelope {
  readonly source: 'discord' | 'system';
  readonly inputTrust: 'trusted' | 'untrusted' | 'operator-approved';
}

export interface ControlPlaneEvent {
  readonly schemaVersion: typeof CONTROL_PLANE_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly timestamp: string;
  readonly type: ControlPlaneEventType;
  readonly actor: ControlPlaneActor;
  readonly channel?: ControlPlaneChannelRef;
  readonly conversationId?: string;
  readonly taskId?: string;
  readonly correlationId?: string;
  readonly trust: ControlPlaneTrustEnvelope;
  readonly payload: Record<string, unknown>;
}

export type ControlPlaneEventInput = Omit<
  ControlPlaneEvent,
  'schemaVersion' | 'eventId' | 'timestamp'
> & {
  readonly eventId?: string;
  readonly timestamp?: string;
};

export interface ControlPlaneLedgerPort {
  append(event: ControlPlaneEventInput): ControlPlaneEvent;
  loadAll(): ControlPlaneEvent[];
  loadSince(
    timestamp: string,
    limit: number,
    filter?: ControlPlaneLoadSinceFilter,
  ): ControlPlaneEvent[];
}

export interface ControlPlaneLoadSinceFilter {
  readonly typePrefix?: `${string}.`;
}

export interface ControlPlaneEventFilter {
  readonly taskId?: string;
  readonly conversationId?: string;
  readonly userId?: string;
  readonly channelId?: string;
  readonly type?: ControlPlaneEventType;
  readonly limit?: number;
}

export interface ControlPlaneObserverPort {
  observe(event: ControlPlaneEvent): void | Promise<void>;
}

const CONTROL_PLANE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  CONTROL_PLANE_EVENT_TYPES,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseControlPlaneEventType(
  value: unknown,
): ControlPlaneEventType | undefined {
  return typeof value === 'string' && CONTROL_PLANE_EVENT_TYPE_SET.has(value)
    ? (value as ControlPlaneEventType)
    : undefined;
}

function parseActor(value: unknown): ControlPlaneActor | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = value['kind'];
  if (
    kind !== 'discord-user' &&
    kind !== 'arona' &&
    kind !== 'plana' &&
    kind !== 'system'
  ) {
    return undefined;
  }
  return {
    kind,
    ...(optionalString(value['userId']) === undefined
      ? {}
      : { userId: optionalString(value['userId']) }),
  };
}

function parseChannel(value: unknown): ControlPlaneChannelRef | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = value['kind'];
  if (kind !== 'discord' && kind !== 'system') {
    return undefined;
  }
  return {
    kind,
    ...(optionalString(value['guildId']) === undefined
      ? {}
      : { guildId: optionalString(value['guildId']) }),
    ...(optionalString(value['channelId']) === undefined
      ? {}
      : { channelId: optionalString(value['channelId']) }),
    ...(optionalString(value['messageId']) === undefined
      ? {}
      : { messageId: optionalString(value['messageId']) }),
  };
}

function parseTrust(value: unknown): ControlPlaneTrustEnvelope | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const source = value['source'];
  const inputTrust = value['inputTrust'];
  if (source !== 'discord' && source !== 'system') {
    return undefined;
  }
  if (
    inputTrust !== 'trusted' &&
    inputTrust !== 'untrusted' &&
    inputTrust !== 'operator-approved'
  ) {
    return undefined;
  }
  return { source, inputTrust };
}

function eventIsAtOrAfter(event: ControlPlaneEvent, timestamp: string): boolean {
  const sinceMs = Date.parse(timestamp);
  if (!Number.isFinite(sinceMs)) {
    return false;
  }
  const eventMs = Date.parse(event.timestamp);
  return Number.isFinite(eventMs) && eventMs >= sinceMs;
}

function eventMatchesLoadSinceFilter(
  event: ControlPlaneEvent,
  filter: ControlPlaneLoadSinceFilter | undefined,
): boolean {
  return (
    filter?.typePrefix === undefined || event.type.startsWith(filter.typePrefix)
  );
}

function boundedLimit(limit: number): number {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50;
}

export class ControlPlaneLedgerTooLargeError extends Error {
  constructor(
    readonly sizeBytes: number,
    readonly maxBytes = CONTROL_PLANE_LEDGER_LOAD_SINCE_MAX_BYTES,
  ) {
    super(
      `Control-plane ledger is too large for bounded feed reads: ${sizeBytes} bytes > ${maxBytes} bytes`,
    );
    this.name = 'ControlPlaneLedgerTooLargeError';
  }
}

export function isControlPlaneLedgerTooLargeError(
  error: unknown,
): error is ControlPlaneLedgerTooLargeError {
  return error instanceof ControlPlaneLedgerTooLargeError;
}

export function createControlPlaneEvent(
  input: ControlPlaneEventInput,
): ControlPlaneEvent {
  return {
    schemaVersion: CONTROL_PLANE_EVENT_SCHEMA_VERSION,
    eventId: input.eventId ?? randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    type: input.type,
    actor: { ...input.actor },
    ...(input.channel === undefined ? {} : { channel: { ...input.channel } }),
    ...(input.conversationId === undefined
      ? {}
      : { conversationId: input.conversationId }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: input.correlationId }),
    trust: { ...input.trust },
    payload: { ...input.payload },
  };
}

export function parseControlPlaneEvent(raw: unknown): ControlPlaneEvent | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (raw['schemaVersion'] !== CONTROL_PLANE_EVENT_SCHEMA_VERSION) {
    return undefined;
  }
  const eventId = optionalString(raw['eventId']);
  const timestamp = optionalString(raw['timestamp']);
  const type = parseControlPlaneEventType(raw['type']);
  const actor = parseActor(raw['actor']);
  const channel = parseChannel(raw['channel']);
  const trust = parseTrust(raw['trust']);
  const payload = raw['payload'];
  if (
    eventId === undefined ||
    timestamp === undefined ||
    type === undefined ||
    actor === undefined ||
    trust === undefined ||
    !isRecord(payload)
  ) {
    return undefined;
  }
  return {
    schemaVersion: CONTROL_PLANE_EVENT_SCHEMA_VERSION,
    eventId,
    timestamp,
    type,
    actor,
    ...(channel === undefined ? {} : { channel }),
    ...(optionalString(raw['conversationId']) === undefined
      ? {}
      : { conversationId: optionalString(raw['conversationId']) }),
    ...(optionalString(raw['taskId']) === undefined
      ? {}
      : { taskId: optionalString(raw['taskId']) }),
    ...(optionalString(raw['correlationId']) === undefined
      ? {}
      : { correlationId: optionalString(raw['correlationId']) }),
    trust,
    payload: { ...payload },
  };
}

export function filterControlPlaneEvents(
  events: readonly ControlPlaneEvent[],
  filter: ControlPlaneEventFilter = {},
): ControlPlaneEvent[] {
  const filtered = events.filter((event) => {
    if (filter.taskId !== undefined && event.taskId !== filter.taskId) {
      return false;
    }
    if (
      filter.conversationId !== undefined &&
      event.conversationId !== filter.conversationId
    ) {
      return false;
    }
    if (filter.userId !== undefined && event.actor.userId !== filter.userId) {
      return false;
    }
    if (
      filter.channelId !== undefined &&
      event.channel?.channelId !== filter.channelId
    ) {
      return false;
    }
    if (filter.type !== undefined && event.type !== filter.type) {
      return false;
    }
    return true;
  });
  return filter.limit === undefined
    ? filtered
    : filtered.slice(-Math.max(0, filter.limit));
}

/**
 * M5c — observe-only hook bindings the ledger fires on each successful
 * append. Each binding's exception is contained: a throwing hook never
 * disrupts the append.
 */
export interface ControlPlaneLedgerHookBinding {
  readonly moduleId: string;
  readonly moduleVersion: string;
  readonly ledgerAppendObserve: import('../contracts/trait-runtime-hook.js').TraitLedgerAppendObserveHook;
}

function fireLedgerAppendHooks(
  hooks: ReadonlyArray<ControlPlaneLedgerHookBinding>,
  event: ControlPlaneEvent,
): void {
  if (hooks.length === 0) return;
  const observedAt = new Date().toISOString();
  for (const binding of hooks) {
    Promise.resolve()
      .then(() =>
        binding.ledgerAppendObserve(
          {
            moduleId: binding.moduleId as never,
            moduleVersion: binding.moduleVersion,
            observedAt,
          },
          {
            eventId: event.eventId,
            eventType: event.type,
            ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
          },
        ),
      )
      .catch((error: unknown) => {
        console.warn(
          'trait-runtime-hook-threw',
          JSON.stringify({
            hook: 'ledgerAppendObserve',
            moduleId: binding.moduleId,
            eventId: event.eventId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
  }
}

function fireControlPlaneObservers(
  observers: ReadonlyArray<ControlPlaneObserverPort>,
  event: ControlPlaneEvent,
): void {
  if (observers.length === 0) return;
  for (const observer of observers) {
    try {
      const result = observer.observe({ ...event, payload: { ...event.payload } });
      Promise.resolve(result).catch((error: unknown) => {
        console.warn(
          'control-plane-observer-threw',
          JSON.stringify({
            eventId: event.eventId,
            eventType: event.type,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    } catch (error) {
      console.warn(
        'control-plane-observer-threw',
        JSON.stringify({
          eventId: event.eventId,
          eventType: event.type,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

export class InMemoryControlPlaneLedger implements ControlPlaneLedgerPort {
  private readonly events: ControlPlaneEvent[] = [];
  private readonly hooks: ReadonlyArray<ControlPlaneLedgerHookBinding>;
  private readonly observers: ReadonlyArray<ControlPlaneObserverPort>;

  constructor(
    seed: readonly ControlPlaneEvent[] = [],
    hooks: ReadonlyArray<ControlPlaneLedgerHookBinding> = [],
    observers: ReadonlyArray<ControlPlaneObserverPort> = [],
  ) {
    this.events.push(...seed.map((event) => ({ ...event, payload: { ...event.payload } })));
    this.hooks = hooks;
    this.observers = observers;
  }

  append(input: ControlPlaneEventInput): ControlPlaneEvent {
    const event = createControlPlaneEvent(input);
    this.events.push(event);
    fireLedgerAppendHooks(this.hooks, event);
    fireControlPlaneObservers(this.observers, event);
    return { ...event, payload: { ...event.payload } };
  }

  loadAll(): ControlPlaneEvent[] {
    return this.events.map((event) => ({ ...event, payload: { ...event.payload } }));
  }

  loadSince(
    timestamp: string,
    limit: number,
    filter?: ControlPlaneLoadSinceFilter,
  ): ControlPlaneEvent[] {
    return this.events
      .filter((event) => eventIsAtOrAfter(event, timestamp))
      .filter((event) => eventMatchesLoadSinceFilter(event, filter))
      .slice(-boundedLimit(limit))
      .map((event) => ({ ...event, payload: { ...event.payload } }));
  }
}

export class JsonlControlPlaneLedger implements ControlPlaneLedgerPort {
  private readonly hooks: ReadonlyArray<ControlPlaneLedgerHookBinding>;
  private readonly observers: ReadonlyArray<ControlPlaneObserverPort>;

  constructor(
    private readonly filePath: string,
    hooks: ReadonlyArray<ControlPlaneLedgerHookBinding> = [],
    observers: ReadonlyArray<ControlPlaneObserverPort> = [],
  ) {
    this.hooks = hooks;
    this.observers = observers;
  }

  append(input: ControlPlaneEventInput): ControlPlaneEvent {
    const event = createControlPlaneEvent(input);
    ensureDirFor(this.filePath);
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
    fireLedgerAppendHooks(this.hooks, event);
    fireControlPlaneObservers(this.observers, event);
    return event;
  }

  loadAll(): ControlPlaneEvent[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const raw = readFileSync(this.filePath, 'utf8');
    const events: ControlPlaneEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        const event = parseControlPlaneEvent(JSON.parse(trimmed));
        if (event !== undefined) {
          events.push(event);
        }
      } catch {
        // A torn final line or operator-edited invalid line must not prevent
        // the always-on control plane from restarting.
      }
    }
    return events;
  }

  loadSince(
    timestamp: string,
    limit: number,
    filter?: ControlPlaneLoadSinceFilter,
  ): ControlPlaneEvent[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const sizeBytes = statSync(this.filePath).size;
    if (sizeBytes > CONTROL_PLANE_LEDGER_LOAD_SINCE_MAX_BYTES) {
      throw new ControlPlaneLedgerTooLargeError(sizeBytes);
    }
    const raw = readFileSync(this.filePath, 'utf8');
    const events: ControlPlaneEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        const event = parseControlPlaneEvent(JSON.parse(trimmed));
        if (
          event !== undefined &&
          eventIsAtOrAfter(event, timestamp) &&
          eventMatchesLoadSinceFilter(event, filter)
        ) {
          events.push(event);
        }
      } catch {
        // A torn final line or operator-edited invalid line must not prevent
        // bounded feed reads from returning earlier valid events.
      }
    }
    return events.slice(-boundedLimit(limit));
  }
}

function ensureDirFor(filePath: string): void {
  const dir = dirname(filePath);
  if (dir.length > 0 && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
