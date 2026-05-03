import type { ObservedResourceSummary, ResourceEnvelope } from '../contracts/resource-envelope.js';
import type {
  TerminalCause,
  TerminalCauseExternalCancel,
  TerminalCauseRuntimeVeto,
} from '../contracts/terminal-cause.js';
import {
  createAbortEvidenceFromVeto,
  createTerminalEvidence,
  type TerminalEvidence,
  type TerminalExecutionContextSnapshot,
  type TerminalEvidenceTranscript,
  type RuntimeWarningEvidence,
} from '../contracts/terminal-evidence.js';
import type { RuntimeTerminalCause } from '../contracts/runtime-driver.js';

export interface TerminalCauseEvidenceParams {
  taskId: string;
  runtimeInstanceId: string;
  terminalCause: RuntimeTerminalCause;
  executionContext: TerminalExecutionContextSnapshot;
  resourceEnvelope: ResourceEnvelope;
  observedSummary?: ObservedResourceSummary;
  transcript?: TerminalEvidenceTranscript;
  runtimeWarnings?: RuntimeWarningEvidence[];
  startedAt: string;
  endedAt: string;
  artifactLocation?: string;
}

/**
 * Lift the runtime-side `RuntimeTerminalCause` into the WU-H typed
 * `TerminalCause` discriminated union, anchoring identity + temporal fields
 * with the surrounding execution context.
 */
function liftRuntimeTerminalCause(
  params: TerminalCauseEvidenceParams,
): TerminalCause {
  const { taskId, runtimeInstanceId, terminalCause, endedAt } = params;

  if (terminalCause.kind === 'external-cancel') {
    const cause: TerminalCauseExternalCancel = {
      kind: 'external-cancel',
      taskId,
      runtimeInstanceId,
      observedAt: terminalCause.requestedAt ?? endedAt,
      provenance: terminalCause.provenance,
      reason: terminalCause.reason,
      requestedAt: terminalCause.requestedAt,
      ...(terminalCause.cancelMode === undefined
        ? {}
        : { cancelMode: terminalCause.cancelMode }),
      ...(terminalCause.cancelDetail === undefined
        ? {}
        : { cancelDetail: { ...terminalCause.cancelDetail } }),
    };
    return cause;
  }

  const vetoSource: 'admission' | 'plana' | undefined =
    terminalCause.veto.provenance === 'admission-gate'
      ? 'admission'
      : terminalCause.veto.provenance === 'plana-runtime-review'
        ? 'plana'
        : undefined;

  const inferredCancelDetail =
    terminalCause.veto.provenance === 'plana-runtime-review'
      ? { originPort: 'plana-runtime-review' as const }
      : undefined;

  const cause: TerminalCauseRuntimeVeto = {
    kind: 'runtime-veto',
    taskId,
    runtimeInstanceId,
    observedAt: terminalCause.requestedAt ?? endedAt,
    provenance: terminalCause.provenance,
    reason: terminalCause.reason,
    veto: terminalCause.veto,
    ...(terminalCause.cancellation === undefined
      ? {}
      : {
          cancellation: {
            requestedAt: terminalCause.cancellation.requestedAt,
            ...(terminalCause.cancellation.cancelMode === undefined
              ? {}
              : { cancelMode: terminalCause.cancellation.cancelMode }),
            ...(terminalCause.cancellation.cancelDetail === undefined
              ? {}
              : { cancelDetail: { ...terminalCause.cancellation.cancelDetail } }),
            ...(terminalCause.cancellation.cancelDetail === undefined &&
            inferredCancelDetail !== undefined
              ? { cancelDetail: inferredCancelDetail }
              : {}),
          },
        }),
    ...(vetoSource === undefined ? {} : { vetoSource }),
  };
  return cause;
}

export function createTerminalEvidenceFromTerminalCause(
  params: TerminalCauseEvidenceParams,
): TerminalEvidence {
  const cause = liftRuntimeTerminalCause(params);

  if (params.terminalCause.kind === 'external-cancel') {
    return createTerminalEvidence({
      taskId: params.taskId,
      runtimeInstanceId: params.runtimeInstanceId,
      reason: params.terminalCause.reason,
      provenance: params.terminalCause.provenance,
      executionContext: params.executionContext,
      resourceEnvelope: params.resourceEnvelope,
      observedSummary: params.observedSummary,
      transcript: params.transcript,
      runtimeWarnings: params.runtimeWarnings,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
      artifactLocation: params.artifactLocation,
      cause,
    });
  }

  return createAbortEvidenceFromVeto({
    taskId: params.taskId,
    runtimeInstanceId: params.runtimeInstanceId,
    veto: params.terminalCause.veto,
    executionContext: params.executionContext,
    cancellation: params.terminalCause.cancellation
      ? {
          ...params.terminalCause.cancellation,
          boundary: 'dispatcher',
        }
      : undefined,
    resourceEnvelope: params.resourceEnvelope,
    observedSummary: params.observedSummary,
    transcript: params.transcript,
    runtimeWarnings: params.runtimeWarnings,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    artifactLocation: params.artifactLocation,
    cause,
  });
}
