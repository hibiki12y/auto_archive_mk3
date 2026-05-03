import type {
  SubagentCorrelationKey,
  SubagentDescriptor,
} from './subagent-roster.js';
import type {
  TerminalCauseDriverFailure,
  TerminalCauseExternalCancel,
  TerminalCauseProviderFailure,
  TerminalCauseRuntimeVeto,
  TerminalCauseSuccess,
  TerminalCauseTimeout,
} from './terminal-cause.js';

export type RosterEventKind =
  | 'subagent.spawned'
  | 'subagent.completed'
  | 'subagent.aborted'
  | 'subagent.failed'
  | 'roster.progress';

interface RosterEventBase<TKind extends RosterEventKind> {
  kind: TKind;
  correlationKey: SubagentCorrelationKey;
  timestamp: string;
}

export interface SubagentSpawnedEvent extends RosterEventBase<'subagent.spawned'> {
  descriptor: SubagentDescriptor;
}

export interface SubagentCompletedEvent
  extends RosterEventBase<'subagent.completed'> {
  artifact: unknown;
  cause: TerminalCauseSuccess;
}

export interface SubagentAbortedEvent extends RosterEventBase<'subagent.aborted'> {
  partialArtifact?: { digest?: string; ref?: string } | null;
  cause: TerminalCauseExternalCancel | TerminalCauseRuntimeVeto;
}

export interface SubagentFailedEvent extends RosterEventBase<'subagent.failed'> {
  cause:
    | TerminalCauseTimeout
    | TerminalCauseDriverFailure
    | TerminalCauseProviderFailure;
}

export interface RosterProgressEvent extends RosterEventBase<'roster.progress'> {
  completed: number;
  aborted: number;
  failed: number;
  total: number;
  inFlight: number;
}

export type RosterEvent =
  | SubagentSpawnedEvent
  | SubagentCompletedEvent
  | SubagentAbortedEvent
  | SubagentFailedEvent
  | RosterProgressEvent;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRosterEvent(value: unknown): value is RosterEvent {
  if (!isObject(value) || typeof value.kind !== 'string') {
    return false;
  }
  return (
    value.kind === 'subagent.spawned' ||
    value.kind === 'subagent.completed' ||
    value.kind === 'subagent.aborted' ||
    value.kind === 'subagent.failed' ||
    value.kind === 'roster.progress'
  );
}

export function isSubagentSpawnedEvent(
  value: unknown,
): value is SubagentSpawnedEvent {
  return isObject(value) && value.kind === 'subagent.spawned';
}

export function isSubagentCompletedEvent(
  value: unknown,
): value is SubagentCompletedEvent {
  return isObject(value) && value.kind === 'subagent.completed';
}

export function isSubagentAbortedEvent(value: unknown): value is SubagentAbortedEvent {
  return isObject(value) && value.kind === 'subagent.aborted';
}

export function isSubagentFailedEvent(value: unknown): value is SubagentFailedEvent {
  return isObject(value) && value.kind === 'subagent.failed';
}

export function isRosterProgressEvent(value: unknown): value is RosterProgressEvent {
  return isObject(value) && value.kind === 'roster.progress';
}
