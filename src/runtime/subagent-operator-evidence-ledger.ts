/**
 * P4 Stage 4-3 — append-side ledger for the subagent operator
 * evidence surface. Mirrors the read-only replay/scoring contract
 * already enforced by `subagent-operator-evidence-report-cli.ts`:
 * lines must NOT carry raw instructions, prompts, responses, messages,
 * reasons, credentials, or raw artifact payloads. The append helpers
 * therefore redact every `RosterEvent` to a host-owned, retained
 * shape before serializing the JSONL line.
 *
 * The CLI's replay path silently skips lines whose top-level scan trips
 * the unsafe-key heuristic (text/content/message/reason/instruction/
 * prompt/response/payload/credentials/...) and counts them in
 * `replayAudit.unsafePayloadLineCount`. Writing redacted records here
 * prevents the ledger from accumulating dropped lines, which would
 * otherwise pollute downstream operator scorecards even when the
 * sink path is otherwise healthy.
 *
 * The ledger contract is intentionally a thin surface:
 *   - `append(event)` writes one redacted JSONL line and returns the
 *     redacted record.
 *   - `appendMany(events)` is a convenience for tests; production
 *     consumers stream events one-by-one via the runtime sink.
 *
 * Cross-process append serialization, log rotation, and retention
 * remain host-owned (no `flock` / size compaction here). The on-disk
 * JSONL shape is forward-compatible with the existing report CLI.
 */
import {
  appendFileSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { RosterEvent } from '../contracts/subagent-roster-event.js';
import type {
  TerminalCauseDriverFailure,
  TerminalCauseExternalCancel,
  TerminalCauseProviderFailure,
  TerminalCauseRuntimeVeto,
  TerminalCauseSuccess,
  TerminalCauseTimeout,
} from '../contracts/terminal-cause.js';

export interface SubagentOperatorEvidenceLedgerPort {
  append(event: RosterEvent): RedactedSubagentOperatorEvidenceRecord;
  appendMany(
    events: readonly RosterEvent[],
  ): readonly RedactedSubagentOperatorEvidenceRecord[];
}

/**
 * Top-level record schema written by `JsonlSubagentOperatorEvidenceLedger`.
 * Every field is host-owned metadata; raw operator/user content stays
 * out of the persisted shape.
 */
export type RedactedSubagentOperatorEvidenceRecord =
  | RedactedSpawnedRecord
  | RedactedTerminalRecord
  | RedactedProgressRecord;

interface RedactedRecordBase {
  readonly kind: RosterEvent['kind'];
  readonly correlationKey: {
    readonly taskId: string;
    readonly instanceId: string;
    readonly subagentId: string;
  };
  readonly timestamp: string;
}

export interface RedactedSpawnedRecord extends RedactedRecordBase {
  readonly kind: 'subagent.spawned';
  readonly descriptor: {
    readonly subagentId: string;
    readonly role: string;
    readonly parent: {
      readonly taskId: string;
      readonly instanceId: string;
    };
    readonly createdAt: string;
    readonly state: string;
    readonly envelope: unknown;
  };
}

export interface RedactedTerminalRecord extends RedactedRecordBase {
  readonly kind: 'subagent.completed' | 'subagent.aborted' | 'subagent.failed';
  readonly cause: RedactedTerminalCause;
  readonly artifact?: { readonly digest?: string; readonly ref?: string } | null;
  readonly partialArtifact?:
    | { readonly digest?: string; readonly ref?: string }
    | null;
}

export interface RedactedProgressRecord extends RedactedRecordBase {
  readonly kind: 'roster.progress';
  readonly completed: number;
  readonly aborted: number;
  readonly failed: number;
  readonly total: number;
  readonly inFlight: number;
}

/**
 * Redacted subset of `TerminalCause` that contains only the metadata the
 * operator scorecard already consumes: `kind`, identity, observedAt,
 * provenance, plus type-specific safe fields. Free-text fields like
 * `reason`, `message`, `phase`, `cancelDetail`, `requestContext`,
 * `stack`, and unmapped extras are intentionally omitted.
 */
export type RedactedTerminalCause =
  | RedactedSuccessCause
  | RedactedExternalCancelCause
  | RedactedRuntimeVetoCause
  | RedactedTimeoutCause
  | RedactedDriverFailureCause
  | RedactedProviderFailureCause;

interface RedactedCauseBase {
  readonly kind: string;
  readonly taskId: string;
  readonly runtimeInstanceId: string;
  readonly observedAt: string;
  readonly provenance: string;
}

interface RedactedSuccessCause extends RedactedCauseBase {
  readonly kind: 'success';
  readonly artifactLocation?: string;
}

interface RedactedExternalCancelCause extends RedactedCauseBase {
  readonly kind: 'external-cancel';
  readonly requestedAt: string;
  readonly cancelMode?: string;
}

interface RedactedRuntimeVetoCause extends RedactedCauseBase {
  readonly kind: 'runtime-veto';
  readonly vetoSource?: string;
  readonly cancellation?: {
    readonly requestedAt: string;
    readonly cancelMode?: string;
  };
}

interface RedactedTimeoutCause extends RedactedCauseBase {
  readonly kind: 'timeout';
  readonly deadlineMs: number;
  readonly firedAt: string;
}

interface RedactedDriverFailureCause extends RedactedCauseBase {
  readonly kind: 'driver-failure';
}

interface RedactedProviderFailureCause extends RedactedCauseBase {
  readonly kind: 'provider-failure';
  readonly provider: string;
  readonly classification: string;
  readonly retryable: boolean;
}

export class InMemorySubagentOperatorEvidenceLedger
  implements SubagentOperatorEvidenceLedgerPort {
  private readonly records: RedactedSubagentOperatorEvidenceRecord[] = [];

  append(event: RosterEvent): RedactedSubagentOperatorEvidenceRecord {
    const redacted = redactSubagentOperatorEvidenceRecord(event);
    this.records.push(redacted);
    return redacted;
  }

  appendMany(
    events: readonly RosterEvent[],
  ): readonly RedactedSubagentOperatorEvidenceRecord[] {
    return events.map((event) => this.append(event));
  }

  loadAll(): readonly RedactedSubagentOperatorEvidenceRecord[] {
    return [...this.records];
  }
}

export class JsonlSubagentOperatorEvidenceLedger
  implements SubagentOperatorEvidenceLedgerPort {
  constructor(private readonly filePath: string) {
    if (filePath.trim().length === 0) {
      throw new Error(
        'JsonlSubagentOperatorEvidenceLedger requires a non-empty file path.',
      );
    }
  }

  append(event: RosterEvent): RedactedSubagentOperatorEvidenceRecord {
    const redacted = redactSubagentOperatorEvidenceRecord(event);
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(redacted)}\n`, 'utf8');
    return redacted;
  }

  appendMany(
    events: readonly RosterEvent[],
  ): readonly RedactedSubagentOperatorEvidenceRecord[] {
    return events.map((event) => this.append(event));
  }
}

export function redactSubagentOperatorEvidenceRecord(
  event: RosterEvent,
): RedactedSubagentOperatorEvidenceRecord {
  switch (event.kind) {
    case 'subagent.spawned':
      return {
        kind: 'subagent.spawned',
        correlationKey: { ...event.correlationKey },
        timestamp: event.timestamp,
        descriptor: {
          subagentId: event.descriptor.subagentId,
          role: event.descriptor.role,
          parent: {
            taskId: event.descriptor.parent.taskId,
            instanceId: event.descriptor.parent.instanceId,
          },
          createdAt: event.descriptor.createdAt,
          state: event.descriptor.state,
          envelope: event.descriptor.envelope,
        },
      };
    case 'subagent.completed':
      return {
        kind: 'subagent.completed',
        correlationKey: { ...event.correlationKey },
        timestamp: event.timestamp,
        cause: redactSuccessCause(event.cause),
        ...(isSafeArtifactReference(event.artifact)
          ? { artifact: cloneArtifactReference(event.artifact) }
          : { artifact: null }),
      };
    case 'subagent.aborted':
      return {
        kind: 'subagent.aborted',
        correlationKey: { ...event.correlationKey },
        timestamp: event.timestamp,
        cause: redactAbortedCause(event.cause),
        ...(event.partialArtifact === undefined
          ? {}
          : isSafeArtifactReference(event.partialArtifact)
            ? { partialArtifact: cloneArtifactReference(event.partialArtifact) }
            : { partialArtifact: null }),
      };
    case 'subagent.failed':
      return {
        kind: 'subagent.failed',
        correlationKey: { ...event.correlationKey },
        timestamp: event.timestamp,
        cause: redactFailedCause(event.cause),
      };
    case 'roster.progress':
      return {
        kind: 'roster.progress',
        correlationKey: { ...event.correlationKey },
        timestamp: event.timestamp,
        completed: event.completed,
        aborted: event.aborted,
        failed: event.failed,
        total: event.total,
        inFlight: event.inFlight,
      };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function redactSuccessCause(cause: TerminalCauseSuccess): RedactedSuccessCause {
  return {
    kind: 'success',
    taskId: cause.taskId,
    runtimeInstanceId: cause.runtimeInstanceId,
    observedAt: cause.observedAt,
    provenance: cause.provenance,
    ...(cause.artifactLocation === undefined
      ? {}
      : { artifactLocation: cause.artifactLocation }),
  };
}

function redactAbortedCause(
  cause: TerminalCauseExternalCancel | TerminalCauseRuntimeVeto,
): RedactedExternalCancelCause | RedactedRuntimeVetoCause {
  if (cause.kind === 'external-cancel') {
    return {
      kind: 'external-cancel',
      taskId: cause.taskId,
      runtimeInstanceId: cause.runtimeInstanceId,
      observedAt: cause.observedAt,
      provenance: cause.provenance,
      requestedAt: cause.requestedAt,
      ...(cause.cancelMode === undefined
        ? {}
        : { cancelMode: cause.cancelMode }),
    };
  }
  return {
    kind: 'runtime-veto',
    taskId: cause.taskId,
    runtimeInstanceId: cause.runtimeInstanceId,
    observedAt: cause.observedAt,
    provenance: cause.provenance,
    ...(cause.vetoSource === undefined ? {} : { vetoSource: cause.vetoSource }),
    ...(cause.cancellation === undefined
      ? {}
      : {
          cancellation: {
            requestedAt: cause.cancellation.requestedAt,
            ...(cause.cancellation.cancelMode === undefined
              ? {}
              : { cancelMode: cause.cancellation.cancelMode }),
          },
        }),
  };
}

function redactFailedCause(
  cause:
    | TerminalCauseTimeout
    | TerminalCauseDriverFailure
    | TerminalCauseProviderFailure,
):
  | RedactedTimeoutCause
  | RedactedDriverFailureCause
  | RedactedProviderFailureCause {
  if (cause.kind === 'timeout') {
    return {
      kind: 'timeout',
      taskId: cause.taskId,
      runtimeInstanceId: cause.runtimeInstanceId,
      observedAt: cause.observedAt,
      provenance: cause.provenance,
      deadlineMs: cause.deadlineMs,
      firedAt: cause.firedAt,
    };
  }
  if (cause.kind === 'driver-failure') {
    return {
      kind: 'driver-failure',
      taskId: cause.taskId,
      runtimeInstanceId: cause.runtimeInstanceId,
      observedAt: cause.observedAt,
      provenance: cause.provenance,
    };
  }
  return {
    kind: 'provider-failure',
    taskId: cause.taskId,
    runtimeInstanceId: cause.runtimeInstanceId,
    observedAt: cause.observedAt,
    provenance: cause.provenance,
    provider: cause.provider,
    classification: cause.classification,
    retryable: cause.retryable,
  };
}

function isSafeArtifactReference(
  value: unknown,
): value is { digest?: string; ref?: string } | null {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.every(([key, nested]) => {
    if (key !== 'digest' && key !== 'ref') return false;
    if (typeof nested !== 'string') return false;
    if (nested.length === 0 || nested.length > 512) return false;
    return !/[\r\n]/u.test(nested);
  });
}

function cloneArtifactReference(
  value: { digest?: string; ref?: string } | null | undefined,
): { digest?: string; ref?: string } | null {
  if (value === null || value === undefined) return null;
  return {
    ...(value.digest === undefined ? {} : { digest: value.digest }),
    ...(value.ref === undefined ? {} : { ref: value.ref }),
  };
}
