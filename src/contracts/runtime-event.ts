import type { ObservedResourceSummary } from './resource-envelope.js';

export type RuntimeEventKind =
  | 'runtime-initialized'
  | 'agent-step'
  | 'tool-invocation'
  | 'turn.started'
  | 'turn.completed'
  | 'item.completed'
  | 'item.failed'
  | 'approval.requested';

interface RuntimeEventBase<TKind extends RuntimeEventKind> {
  kind: TKind;
  timestamp: string;
  instanceId: string;
  observedSummary?: ObservedResourceSummary;
}

export interface RuntimeInitializedEvent
  extends RuntimeEventBase<'runtime-initialized'> {
  message: string;
  settingsReviewedAt?: string;
}

export interface AgentStepEvent extends RuntimeEventBase<'agent-step'> {
  step: string;
  detail?: string;
}

export interface ToolInvocationEvent
  extends RuntimeEventBase<'tool-invocation'> {
  toolName: string;
  detail: string;
  /**
   * Optional tool category used by Plana's loop detector. Kept optional so the
   * existing `tool-invocation` event kind remains the compatibility surface.
   */
  toolKind?: string;
  /**
   * Stable digest of arguments supplied by the producer when raw arguments
   * should not be exposed. When omitted, consumers may derive a best-effort
   * digest from `detail`.
   */
  argumentsDigest?: string;
  /**
   * Digest of the observed result/delta for polling tools. Polling repeats are
   * only counted as no-progress loops when this digest is unchanged.
   */
  observedDeltaDigest?: string;
  /** Marks a tool as polling even if its name is not in the detector defaults. */
  knownPollingTool?: boolean;
}

export interface RuntimeEventProvenance {
  /**
   * The runtime driver that produced this event. The contract supports
   * multiple drivers per `specs/CLARIFICATIONS/multi-provider-scope.md`
   * (Codex SDK + Claude Agent SDK as of 2026-04-30). New driver implementations
   * MUST add their canonical id here so consumers can route on producer.
   */
  readonly producer: 'codex-runtime-driver' | 'claude-agent-runtime-driver';
  readonly sdkEventType:
    | 'turn.started'
    | 'turn.completed'
    | 'item.completed'
    | 'item.failed'
    | 'approval.requested';
  readonly threadId: string | null;
}

export type RuntimeReviewedItemType =
  | 'command_execution'
  | 'mcp_tool_call'
  | 'web_search'
  | 'agent_message'
  | 'reasoning'
  | 'file_change'
  | 'todo_list'
  | 'error'
  | 'unknown';

export interface RuntimeReviewedItem {
  readonly id: string;
  readonly type: RuntimeReviewedItemType;
  readonly originalType?: string;
  readonly status?: string;
  readonly summary: string;
}

export interface TurnStartedEvent extends RuntimeEventBase<'turn.started'> {
  readonly turnSequence: number;
  readonly provenance: RuntimeEventProvenance;
}

export interface TurnCompletedEvent extends RuntimeEventBase<'turn.completed'> {
  readonly turnSequence: number;
  readonly usage?: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
  };
  readonly provenance: RuntimeEventProvenance;
}

export interface ItemCompletedEvent extends RuntimeEventBase<'item.completed'> {
  readonly turnSequence: number;
  readonly item: RuntimeReviewedItem;
  readonly provenance: RuntimeEventProvenance;
}

export interface ItemFailedEvent extends RuntimeEventBase<'item.failed'> {
  readonly turnSequence: number;
  readonly item: RuntimeReviewedItem;
  readonly failure: {
    readonly message: string;
    readonly code?: string;
  };
  readonly provenance: RuntimeEventProvenance;
}

export type RuntimeApprovalRequestKind =
  | 'command_execution'
  | 'mcp_tool_call'
  | 'web_search'
  | 'file_change'
  | 'unknown';

export interface RuntimeApprovalRequest {
  readonly kind: RuntimeApprovalRequestKind;
  readonly reason: string;
  readonly command?: string;
  readonly toolServer?: string;
  readonly toolName?: string;
  readonly workingDirectory?: string;
}

export interface ApprovalDecisionApproved {
  readonly status: 'approved';
}

export interface ApprovalDecisionRejected {
  readonly status: 'rejected';
  readonly reason: string;
}

export interface ApprovalDecisionTimeout {
  readonly status: 'timeout';
  readonly reason: 'deadline-elapsed';
  readonly deadline: string;
}

export type ApprovalDecision =
  | ApprovalDecisionApproved
  | ApprovalDecisionRejected
  | ApprovalDecisionTimeout;

export type ApprovalHookDecision = Exclude<
  ApprovalDecision,
  ApprovalDecisionTimeout
>;

export interface ApprovalRequestedEvent
  extends RuntimeEventBase<'approval.requested'> {
  readonly turnSequence: number;
  readonly approvalRequestId: string;
  readonly deadline: string;
  readonly request: RuntimeApprovalRequest;
  readonly provenance: RuntimeEventProvenance;
}

export type RuntimeEvent =
  | RuntimeInitializedEvent
  | AgentStepEvent
  | ToolInvocationEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | ItemCompletedEvent
  | ItemFailedEvent
  | ApprovalRequestedEvent;

export type RuntimeEventInput =
  | Omit<RuntimeInitializedEvent, 'timestamp' | 'instanceId'>
  | Omit<AgentStepEvent, 'timestamp' | 'instanceId'>
  | Omit<ToolInvocationEvent, 'timestamp' | 'instanceId'>
  | Omit<TurnStartedEvent, 'timestamp' | 'instanceId'>
  | Omit<TurnCompletedEvent, 'timestamp' | 'instanceId'>
  | Omit<ItemCompletedEvent, 'timestamp' | 'instanceId'>
  | Omit<ItemFailedEvent, 'timestamp' | 'instanceId'>
  | Omit<ApprovalRequestedEvent, 'timestamp' | 'instanceId'>;

/** @internal */
export type RuntimeEventInternalInput =
  | Omit<RuntimeInitializedEvent, 'timestamp'>
  | Omit<AgentStepEvent, 'timestamp'>
  | Omit<ToolInvocationEvent, 'timestamp'>
  | Omit<TurnStartedEvent, 'timestamp'>
  | Omit<TurnCompletedEvent, 'timestamp'>
  | Omit<ItemCompletedEvent, 'timestamp'>
  | Omit<ItemFailedEvent, 'timestamp'>
  | Omit<ApprovalRequestedEvent, 'timestamp'>;

function requireString(value: unknown, fieldLabel: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${fieldLabel} must be a string.`);
  }

  return value;
}

function requireFiniteNumber(value: unknown, fieldLabel: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${fieldLabel} must be a finite number.`);
  }

  return value;
}

function requireRecord(value: unknown, fieldLabel: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${fieldLabel} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, fieldLabel: string): string {
  const str = requireString(value, fieldLabel);
  if (str.trim() === '') {
    throw new TypeError(`${fieldLabel} must be a non-empty string.`);
  }
  return str;
}

function requireIsoInstantString(value: unknown, fieldLabel: string): string {
  const instant = requireString(value, fieldLabel);
  if (Number.isNaN(Date.parse(instant))) {
    throw new TypeError(`${fieldLabel} must be a valid ISO 8601 string.`);
  }
  return instant;
}

function requirePositiveInteger(value: unknown, fieldLabel: string): number {
  const num = requireFiniteNumber(value, fieldLabel);
  if (!Number.isInteger(num) || num < 1) {
    throw new TypeError(`${fieldLabel} must be a positive integer.`);
  }
  return num;
}

function canonicalizeProvenance(value: unknown, fieldLabel: string): RuntimeEventProvenance {
  const record = requireRecord(value, fieldLabel);
  if (
    record.producer !== 'codex-runtime-driver' &&
    record.producer !== 'claude-agent-runtime-driver'
  ) {
    throw new TypeError(
      `${fieldLabel}.producer must be one of: "codex-runtime-driver", "claude-agent-runtime-driver".`,
    );
  }
  if (
    record.sdkEventType !== 'turn.started' &&
    record.sdkEventType !== 'turn.completed' &&
    record.sdkEventType !== 'item.completed' &&
    record.sdkEventType !== 'item.failed' &&
    record.sdkEventType !== 'approval.requested'
  ) {
    throw new TypeError(
      `${fieldLabel}.sdkEventType must be turn.started|turn.completed|item.completed|item.failed|approval.requested.`,
    );
  }
  if (record.threadId !== null && typeof record.threadId !== 'string') {
    throw new TypeError(`${fieldLabel}.threadId must be a string or null.`);
  }

  return {
    producer: record.producer,
    sdkEventType: record.sdkEventType,
    threadId: record.threadId,
  };
}

function canonicalizeRuntimeReviewedItem(
  value: unknown,
  fieldLabel: string,
): RuntimeReviewedItem {
  const record = requireRecord(value, fieldLabel);
  const type = record.type;
  if (
    type !== 'command_execution' &&
    type !== 'mcp_tool_call' &&
    type !== 'web_search' &&
    type !== 'agent_message' &&
    type !== 'reasoning' &&
    type !== 'file_change' &&
    type !== 'todo_list' &&
    type !== 'error' &&
    type !== 'unknown'
  ) {
    throw new TypeError(
      `${fieldLabel}.type must be command_execution|mcp_tool_call|web_search|agent_message|reasoning|file_change|todo_list|error|unknown.`,
    );
  }
  return {
    id: requireNonEmptyString(record.id, `${fieldLabel}.id`),
    type,
    ...(record.originalType === undefined
      ? {}
      : {
          originalType: requireNonEmptyString(
            record.originalType,
            `${fieldLabel}.originalType`,
          ),
        }),
    ...(record.status === undefined
      ? {}
      : { status: requireString(record.status, `${fieldLabel}.status`) }),
    summary: requireString(record.summary, `${fieldLabel}.summary`),
  };
}

function canonicalizeApprovalRequest(
  value: unknown,
  fieldLabel: string,
): RuntimeApprovalRequest {
  const record = requireRecord(value, fieldLabel);
  const kind = record.kind;
  if (
    kind !== 'command_execution' &&
    kind !== 'mcp_tool_call' &&
    kind !== 'web_search' &&
    kind !== 'file_change' &&
    kind !== 'unknown'
  ) {
    throw new TypeError(
      `${fieldLabel}.kind must be command_execution|mcp_tool_call|web_search|file_change|unknown.`,
    );
  }

  return {
    kind,
    reason: requireString(record.reason, `${fieldLabel}.reason`),
    ...(record.command === undefined
      ? {}
      : { command: requireString(record.command, `${fieldLabel}.command`) }),
    ...(record.toolServer === undefined
      ? {}
      : { toolServer: requireString(record.toolServer, `${fieldLabel}.toolServer`) }),
    ...(record.toolName === undefined
      ? {}
      : { toolName: requireString(record.toolName, `${fieldLabel}.toolName`) }),
    ...(record.workingDirectory === undefined
      ? {}
      : {
          workingDirectory: requireString(
            record.workingDirectory,
            `${fieldLabel}.workingDirectory`,
          ),
        }),
  };
}

export function canonicalizeObservedSummary(
  value: unknown,
  fieldPrefix = 'Runtime event field',
): ObservedResourceSummary | undefined {
  const labelFor = (fieldName: string): string => `${fieldPrefix} "${fieldName}"`;

  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${labelFor('observedSummary')} must be an object when provided.`);
  }

  const candidate = value as Record<string, unknown>;
  const observedSummary: ObservedResourceSummary = {};

  if (candidate.cpuCoresPeak !== undefined) {
    observedSummary.cpuCoresPeak = requireFiniteNumber(
      candidate.cpuCoresPeak,
      labelFor('observedSummary.cpuCoresPeak'),
    );
  }

  if (candidate.memoryMiBPeak !== undefined) {
    observedSummary.memoryMiBPeak = requireFiniteNumber(
      candidate.memoryMiBPeak,
      labelFor('observedSummary.memoryMiBPeak'),
    );
  }

  if (candidate.wallTimeSec !== undefined) {
    observedSummary.wallTimeSec = requireFiniteNumber(
      candidate.wallTimeSec,
      labelFor('observedSummary.wallTimeSec'),
    );
  }

  if (candidate.gpuCardsPeak !== undefined) {
    observedSummary.gpuCardsPeak = requireFiniteNumber(
      candidate.gpuCardsPeak,
      labelFor('observedSummary.gpuCardsPeak'),
    );
  }

  if (candidate.notes !== undefined) {
    observedSummary.notes = requireString(
      candidate.notes,
      labelFor('observedSummary.notes'),
    );
  }

  return observedSummary;
}

export function createRuntimeEvent(
  input: RuntimeEventInternalInput & Partial<Pick<RuntimeEvent, 'timestamp'>>,
): RuntimeEvent {
  const candidate = input as {
    kind?: unknown;
    timestamp?: unknown;
    instanceId?: unknown;
    observedSummary?: unknown;
    message?: unknown;
    settingsReviewedAt?: unknown;
    step?: unknown;
    detail?: unknown;
    toolName?: unknown;
    toolKind?: unknown;
    argumentsDigest?: unknown;
    observedDeltaDigest?: unknown;
    knownPollingTool?: unknown;
    turnSequence?: unknown;
    provenance?: unknown;
    usage?: unknown;
    item?: unknown;
    failure?: unknown;
    approvalRequestId?: unknown;
    deadline?: unknown;
    request?: unknown;
  };
  const timestamp =
    candidate.timestamp === undefined
      ? new Date().toISOString()
      : requireString(candidate.timestamp, 'Runtime event field "timestamp"');
  const instanceIdRaw = requireString(
    candidate.instanceId,
    'Runtime event field "instanceId"',
  );
  if (instanceIdRaw.trim() === '') {
    throw new TypeError(
      'Runtime event field "instanceId" must be a non-empty string.',
    );
  }
  const instanceId = instanceIdRaw;
  const observedSummary = canonicalizeObservedSummary(candidate.observedSummary);

  switch (candidate.kind) {
    case 'runtime-initialized': {
      const event: RuntimeInitializedEvent = {
        kind: candidate.kind,
        message: requireString(candidate.message, 'Runtime event field "message"'),
        timestamp,
        instanceId,
        observedSummary,
      };
      if (candidate.settingsReviewedAt !== undefined) {
        const reviewedAt = requireString(
          candidate.settingsReviewedAt,
          'Runtime event field "settingsReviewedAt"',
        );
        if (Number.isNaN(Date.parse(reviewedAt))) {
          throw new TypeError(
            'Runtime event field "settingsReviewedAt" must be a valid ISO 8601 string.',
          );
        }
        event.settingsReviewedAt = reviewedAt;
      }
      return event;
    }
    case 'agent-step': {
      const event: AgentStepEvent = {
        kind: candidate.kind,
        step: requireString(candidate.step, 'Runtime event field "step"'),
        detail:
          candidate.detail === undefined
            ? undefined
            : requireString(candidate.detail, 'Runtime event field "detail"'),
        timestamp,
        instanceId,
        observedSummary,
      };
      return event;
    }
    case 'tool-invocation': {
      const event: ToolInvocationEvent = {
        kind: candidate.kind,
        toolName: requireString(candidate.toolName, 'Runtime event field "toolName"'),
        detail: requireString(candidate.detail, 'Runtime event field "detail"'),
        timestamp,
        instanceId,
        observedSummary,
      };
      if (candidate.toolKind !== undefined) {
        event.toolKind = requireString(
          candidate.toolKind,
          'Runtime event field "toolKind"',
        );
      }
      if (candidate.argumentsDigest !== undefined) {
        event.argumentsDigest = requireString(
          candidate.argumentsDigest,
          'Runtime event field "argumentsDigest"',
        );
      }
      if (candidate.observedDeltaDigest !== undefined) {
        event.observedDeltaDigest = requireString(
          candidate.observedDeltaDigest,
          'Runtime event field "observedDeltaDigest"',
        );
      }
      if (candidate.knownPollingTool !== undefined) {
        if (typeof candidate.knownPollingTool !== 'boolean') {
          throw new TypeError(
            'Runtime event field "knownPollingTool" must be a boolean.',
          );
        }
        event.knownPollingTool = candidate.knownPollingTool;
      }
      return event;
    }
    case 'turn.started': {
      const event: TurnStartedEvent = {
        kind: candidate.kind,
        timestamp,
        instanceId,
        observedSummary,
        turnSequence: requirePositiveInteger(
          candidate.turnSequence,
          'Runtime event field "turnSequence"',
        ),
        provenance: canonicalizeProvenance(
          candidate.provenance,
          'Runtime event field "provenance"',
        ),
      };
      return event;
    }
    case 'turn.completed': {
      const usageRaw =
        candidate.usage === undefined
          ? undefined
          : requireRecord(candidate.usage, 'Runtime event field "usage"');
      const event: TurnCompletedEvent = {
        kind: candidate.kind,
        timestamp,
        instanceId,
        observedSummary,
        turnSequence: requirePositiveInteger(
          candidate.turnSequence,
          'Runtime event field "turnSequence"',
        ),
        ...(usageRaw === undefined
          ? {}
          : {
              usage: {
                inputTokens: requireFiniteNumber(
                  usageRaw.inputTokens,
                  'Runtime event field "usage.inputTokens"',
                ),
                cachedInputTokens: requireFiniteNumber(
                  usageRaw.cachedInputTokens,
                  'Runtime event field "usage.cachedInputTokens"',
                ),
                outputTokens: requireFiniteNumber(
                  usageRaw.outputTokens,
                  'Runtime event field "usage.outputTokens"',
                ),
              },
            }),
        provenance: canonicalizeProvenance(
          candidate.provenance,
          'Runtime event field "provenance"',
        ),
      };
      return event;
    }
    case 'item.completed': {
      const event: ItemCompletedEvent = {
        kind: candidate.kind,
        timestamp,
        instanceId,
        observedSummary,
        turnSequence: requirePositiveInteger(
          candidate.turnSequence,
          'Runtime event field "turnSequence"',
        ),
        item: canonicalizeRuntimeReviewedItem(
          candidate.item,
          'Runtime event field "item"',
        ),
        provenance: canonicalizeProvenance(
          candidate.provenance,
          'Runtime event field "provenance"',
        ),
      };
      return event;
    }
    case 'item.failed': {
      const failureRecord = requireRecord(
        candidate.failure,
        'Runtime event field "failure"',
      );
      const event: ItemFailedEvent = {
        kind: candidate.kind,
        timestamp,
        instanceId,
        observedSummary,
        turnSequence: requirePositiveInteger(
          candidate.turnSequence,
          'Runtime event field "turnSequence"',
        ),
        item: canonicalizeRuntimeReviewedItem(
          candidate.item,
          'Runtime event field "item"',
        ),
        failure: {
          message: requireString(
            failureRecord.message,
            'Runtime event field "failure.message"',
          ),
          ...(failureRecord.code === undefined
            ? {}
            : {
                code: requireString(
                  failureRecord.code,
                  'Runtime event field "failure.code"',
                ),
              }),
        },
        provenance: canonicalizeProvenance(
          candidate.provenance,
          'Runtime event field "provenance"',
        ),
      };
      return event;
    }
    case 'approval.requested': {
      const event: ApprovalRequestedEvent = {
        kind: candidate.kind,
        timestamp,
        instanceId,
        observedSummary,
        turnSequence: requirePositiveInteger(
          candidate.turnSequence,
          'Runtime event field "turnSequence"',
        ),
        approvalRequestId: requireNonEmptyString(
          candidate.approvalRequestId,
          'Runtime event field "approvalRequestId"',
        ),
        deadline: requireIsoInstantString(
          candidate.deadline,
          'Runtime event field "deadline"',
        ),
        request: canonicalizeApprovalRequest(
          candidate.request,
          'Runtime event field "request"',
        ),
        provenance: canonicalizeProvenance(
          candidate.provenance,
          'Runtime event field "provenance"',
        ),
      };
      return event;
    }
    default:
      throw new TypeError(`Unsupported runtime event kind: ${String(candidate.kind)}`);
  }
}
