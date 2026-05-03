/**
 * @version 1.0.0
 * @stability frozen
 *
 * Wave 1 Control Proof Freeze 후보. Public surface 변경은 SemVer minor 이상 bump 필요.
 */

import type {
  ObservedResourceSummary,
  ResourceEnvelope,
  ResourceSpec,
} from './resource-envelope.js';
import {
  cloneExecutionCheckpoint,
  type ExecutionCheckpoint,
} from './execution-checkpoint.js';
import { createRuntimeEvent, type RuntimeEvent } from './runtime-event.js';
import type { RuntimeSettingsBundle } from './runtime-settings.js';
import {
  cloneTerminalCause,
  type TerminalCause,
} from './terminal-cause.js';
import type { VetoPath } from './veto.js';

// WU-V Phase 6: `TerminalOutcome`, `TERMINAL_OUTCOMES`, and the
// associated `assertTerminalOutcome` validator have been retired.
// `TerminalCause` from `./terminal-cause.ts` is now the SOLE terminal-
// state carrier across the codebase; consumers needing a human-facing
// label should call `deriveOutcomeFromCause` from
// `src/core/derive-outcome.ts`.
// @see specs/wu-v-terminal-cause-tightening.md §3 Phase 6.

export interface ResourceEnvelopeSnapshot {
  requested: ResourceSpec;
  effective: ResourceSpec;
}

export interface TerminalAbortCancellation {
  taskId: string;
  reason: string;
  provenance: string;
  requestedAt: string;
  boundary: 'dispatcher';
}

export interface TerminalAbortInfo {
  kind: 'veto';
  veto: VetoPath;
  cancellation?: TerminalAbortCancellation;
}

export interface SettingsReviewSnapshot {
  status: 'approved' | 'vetoed';
  reviewedAt: string;
  provenance?: string;
}

export interface TerminalExecutionContextSnapshot {
  planCreatedAt: string;
  runtimeSettings: RuntimeSettingsBundle;
  executionStartedAt?: string;
  settingsReview?: SettingsReviewSnapshot;
  executionCheckpoint?: ExecutionCheckpoint;
}

export interface TerminalEvidenceTranscript {
  events: RuntimeEvent[];
  droppedCount: number;
}

export interface RuntimeWarningEvidence {
  kind: 'tool-loop';
  status: 'warn' | 'veto';
  reason: string;
  provenance: string;
  fingerprint: string;
  count: number;
  observedAt: string;
}

export interface TerminalEvidence {
  taskId: string;
  runtimeInstanceId: string;
  reason: string;
  provenance: string;
  executionContext: TerminalExecutionContextSnapshot;
  resourceEnvelope: ResourceEnvelopeSnapshot;
  observedSummary?: ObservedResourceSummary;
  transcript?: TerminalEvidenceTranscript;
  runtimeWarnings?: RuntimeWarningEvidence[];
  abort?: TerminalAbortInfo;
  startedAt: string;
  endedAt: string;
  artifactLocation?: string;
  /**
   * WU-V Phase 6 (closure): `TerminalCause` is the sole terminal-state
   * carrier on TerminalEvidence. Consumers needing a label MUST derive
   * it from `cause` via `deriveOutcomeFromCause`.
   */
  cause: TerminalCause;
}

export interface TerminalEvidenceInput {
  taskId: string;
  runtimeInstanceId: string;
  reason: string;
  provenance: string;
  executionContext: TerminalExecutionContextSnapshot;
  resourceEnvelope: ResourceEnvelope;
  observedSummary?: ObservedResourceSummary;
  transcript?: TerminalEvidenceTranscript;
  runtimeWarnings?: RuntimeWarningEvidence[];
  abort?: TerminalAbortInfo;
  startedAt: string;
  endedAt: string;
  artifactLocation?: string;
  cause: TerminalCause;
}

function cloneVetoPath(veto: VetoPath): VetoPath {
  return {
    origin: veto.origin,
    reason: veto.reason,
    provenance: veto.provenance,
    propagation: { ...veto.propagation },
  };
}

function cloneAbortInfo(abort: TerminalAbortInfo): TerminalAbortInfo {
  return {
    kind: abort.kind,
    veto: cloneVetoPath(abort.veto),
    cancellation: abort.cancellation
      ? {
          ...abort.cancellation,
        }
      : undefined,
  };
}

function cloneTranscript(
  transcript: TerminalEvidenceTranscript,
): TerminalEvidenceTranscript {
  if (!Array.isArray(transcript.events)) {
    throw new TypeError('terminal transcript events must be an array.');
  }

  if (
    typeof transcript.droppedCount !== 'number' ||
    !Number.isInteger(transcript.droppedCount) ||
    transcript.droppedCount < 0
  ) {
    throw new TypeError(
      'terminal transcript droppedCount must be a non-negative integer.',
    );
  }

  return {
    events: transcript.events.map((event) =>
      createRuntimeEvent(event as Parameters<typeof createRuntimeEvent>[0]),
    ),
    droppedCount: transcript.droppedCount,
  };
}

function cloneRuntimeWarnings(
  warnings: readonly RuntimeWarningEvidence[] | undefined,
): RuntimeWarningEvidence[] | undefined {
  if (warnings === undefined) {
    return undefined;
  }
  return warnings.map((warning) => ({
    kind: warning.kind,
    status: warning.status,
    reason: warning.reason,
    provenance: warning.provenance,
    fingerprint: warning.fingerprint,
    count: warning.count,
    observedAt: warning.observedAt,
  }));
}

function cloneExecutionContext(
  context: TerminalExecutionContextSnapshot,
): TerminalExecutionContextSnapshot {
  return {
    planCreatedAt: context.planCreatedAt,
    runtimeSettings: {
      networkProfile: context.runtimeSettings.networkProfile,
      sandboxMode: context.runtimeSettings.sandboxMode,
      approvalPolicy: context.runtimeSettings.approvalPolicy,
      networkProjection: {
        ...context.runtimeSettings.networkProjection,
      },
      ...(context.runtimeSettings.workingDirectory === undefined
        ? {}
        : { workingDirectory: context.runtimeSettings.workingDirectory }),
      ...(context.runtimeSettings.deadlineMs === undefined
        ? {}
        : { deadlineMs: context.runtimeSettings.deadlineMs }),
    },
    ...(context.executionStartedAt === undefined
      ? {}
      : { executionStartedAt: context.executionStartedAt }),
    ...(context.settingsReview === undefined
      ? {}
      : {
          settingsReview: {
            status: context.settingsReview.status,
            reviewedAt: context.settingsReview.reviewedAt,
            ...(context.settingsReview.provenance === undefined
              ? {}
              : { provenance: context.settingsReview.provenance }),
          },
        }),
    ...(context.executionCheckpoint === undefined
      ? {}
      : {
          executionCheckpoint: cloneExecutionCheckpoint(
            context.executionCheckpoint,
          ),
        }),
  };
}

export function createTerminalEvidence(
  input: TerminalEvidenceInput,
): TerminalEvidence {
  // WU-V Phase 4b: cause is REQUIRED. Validate presence at construction
  // before any other invariant — this is the load-bearing flip enforcement.
  if (input.cause === undefined) {
    throw new Error(
      'TerminalEvidence.cause is required as of WU-V Phase 4b',
    );
  }

  // WU-V Phase 6: structural side-condition for runtime-veto causes —
  // they MUST carry a structured `abort` payload; non-veto causes MUST
  // NOT. (Previously expressed via the now-retired `outcome === 'abort'`
  // gate.)
  const isVetoCause = input.cause.kind === 'runtime-veto';
  if (isVetoCause && input.abort === undefined) {
    throw new Error('abort terminal evidence requires structured abort details');
  }
  if (!isVetoCause && input.abort !== undefined) {
    throw new Error(
      'structured abort details are only valid for abort terminal outcomes',
    );
  }

  return {
    taskId: input.taskId,
    runtimeInstanceId: input.runtimeInstanceId,
    reason: input.reason,
    provenance: input.provenance,
    executionContext: cloneExecutionContext(input.executionContext),
    resourceEnvelope: {
      requested: { ...input.resourceEnvelope.requested },
      effective: { ...input.resourceEnvelope.effective },
    },
    observedSummary: input.observedSummary,
    transcript: input.transcript ? cloneTranscript(input.transcript) : undefined,
    runtimeWarnings: cloneRuntimeWarnings(input.runtimeWarnings),
    abort: input.abort ? cloneAbortInfo(input.abort) : undefined,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    artifactLocation: input.artifactLocation,
    cause: cloneTerminalCause(input.cause),
  };
}

export interface AbortEvidenceFromVetoInput {
  taskId: string;
  runtimeInstanceId: string;
  veto: VetoPath;
  executionContext: TerminalExecutionContextSnapshot;
  resourceEnvelope: ResourceEnvelope;
  observedSummary?: ObservedResourceSummary;
  transcript?: TerminalEvidenceTranscript;
  runtimeWarnings?: RuntimeWarningEvidence[];
  cancellation?: TerminalAbortCancellation;
  startedAt: string;
  endedAt: string;
  artifactLocation?: string;
  /** WU-V Phase 4b: REQUIRED. */
  cause: TerminalCause;
}

export function createAbortEvidenceFromVeto(
  input: AbortEvidenceFromVetoInput,
): TerminalEvidence {
  return createTerminalEvidence({
    taskId: input.taskId,
    runtimeInstanceId: input.runtimeInstanceId,
    reason: input.veto.reason,
    provenance: input.veto.provenance,
    executionContext: input.executionContext,
    resourceEnvelope: input.resourceEnvelope,
    observedSummary: input.observedSummary,
    transcript: input.transcript,
    runtimeWarnings: input.runtimeWarnings,
    abort: {
      kind: 'veto',
      veto: input.veto,
      cancellation: input.cancellation,
    },
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    artifactLocation: input.artifactLocation,
    cause: input.cause,
  });
}
