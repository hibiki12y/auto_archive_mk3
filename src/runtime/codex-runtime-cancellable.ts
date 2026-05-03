/**
 * WU-J-INT (driver-local scope) — Codex turn outcome → CancellableResultAsync
 * mapper.
 *
 * Spec: `specs/wu-j-cancellable-result-wrap.md` (C-J1..C-J6, I-J1..I-J7,
 * AC-J1..AC-J9). This module is the driver-side translator from the SDK's
 * AbortError-shaped failure transport to the WU-H `external-cancel` terminal
 * cause, and from `CodexProviderFailureError` to the `provider-failure`
 * terminal cause — both projected into the typed `CancellableResultAsync`
 * three-branch envelope from `src/contracts/cancellable-result.ts`.
 *
 * Binding constraints honored here:
 *
 *   C-J1 WRAP not REPLACE — this module performs no mutation on
 *        `SubmissionCancellationState`; it only consumes a read function
 *        (`observeExternalCancellation`) supplied by the caller.
 *   C-J2 dispatcher-observable, NOT SDK-shape — the helper does not import
 *        `AbortError` nor any SDK-specific type. Identification is by the
 *        AC-J2-friendly shape `error.name === 'AbortError'` (per ST-09 in
 *        `specs/wu-j-cancellable-result-wrap.md` lines 60-65, 152-154).
 *   C-J3 cancellation cause borrowed from WU-H — cancellation produces
 *        `TerminalCauseExternalCancel` (WU-H §3); no new cause vocabulary.
 *   C-J4 cancel-mode metadata stays in WU-K — surfaced via the optional
 *        `cancelMode` field passed through unmodified from the caller.
 *   C-J5 no new exception class crosses the dispatcher seam — cancellation
 *        and provider failure both flow through the typed `cancelled` /
 *        `failure` branches of the wrap.
 *   C-J6 `<TSuccess, CodexProviderFailureError>` — the `E` parameter is
 *        bound to the named driver/provider failure type per the wrap
 *        contract. Not `unknown` / `Error` / `any`.
 *
 * Scope boundary: this helper lives in `src/runtime/` and is consumed only
 * by driver-adjacent callers. Dispatcher-wide adoption of
 * `CancellableResultAsync` is reserved for a separate WU (WU-J-INT-DISPATCHER)
 * to avoid file-conflict pressure with WU-M-INT. This module MUST NOT import
 * from `src/core/dispatcher.ts` nor `src/runtime/agent-runtime.ts`'s
 * finalize chain.
 */

import {
  cancellableCancelled,
  cancellableFailure,
  cancellableSuccess,
  type CancellableResultAsync,
} from '../contracts/cancellable-result.js';
import type { TaskId } from '../contracts/task-id.js';
import type {
  CancelMode,
  TerminalCauseExternalCancel,
  TerminalCauseProviderFailure,
} from '../contracts/terminal-cause.js';

import { CodexProviderFailureError } from './codex-runtime-adapter.js';

/**
 * Caller-supplied observation of an external cancellation that occurred
 * during the turn. The driver result mapper consults this when (and only
 * when) the turn throws an AbortError-shaped error: a non-`undefined`
 * return value implies the AbortError was the proximate result of an
 * external (cooperative) cancellation request, which the helper translates
 * into a `cancelled` branch.
 *
 * Cancel-mode metadata is optional and flows through unchanged per C-J4
 * (WU-K owns the vocabulary; this module does not validate it beyond
 * type-shape).
 */
export interface ExternalCancellationObservation {
  readonly reason: string;
  /** ISO-8601 timestamp of the external cancellation request. */
  readonly requestedAt: string;
  readonly cancelMode?: CancelMode;
}

export interface CodexTurnOutcomeMapperContext {
  readonly taskId: TaskId;
  readonly runtimeInstanceId: string;
  /**
   * Cause-base `provenance` to attach to synthesized terminal causes.
   * Defaults to `'codex-runtime-driver'` to match the driver's existing
   * provenance string (see `codex-runtime-adapter.ts`; the literal value
   * is preserved as a behavioral contract per
   * `specs/wu-scaffold-cleanup-bundle.md` §B Out-of-scope).
   */
  readonly provenance?: string;
  /**
   * Clock injection seam for deterministic tests. Returns the ISO-8601
   * string used for `observedAt` on synthesized causes.
   */
  readonly observedAtNow?: () => string;
  /**
   * Observation function: returns cancellation context iff external
   * cancellation was observed during the turn (per C-J1 the helper does
   * not read the latch directly — it only consumes a read closure).
   *
   * If this returns `undefined` while an AbortError is in-flight, the
   * helper rethrows the original error rather than silently re-classifying
   * it: an unexplained AbortError is a programmer error to surface, not a
   * cancellation to absorb.
   */
  readonly observeExternalCancellation: () =>
    | ExternalCancellationObservation
    | undefined;
}

/**
 * SDK-shape-independent AbortError detector. We identify by the JS-standard
 * `error.name === 'AbortError'` convention (WHATWG DOM AbortController
 * shape) rather than by `instanceof` against any SDK-exported class. This
 * keeps the seam stable across `@openai/codex-sdk` versions per ST-09.
 */
function isAbortErrorShape(error: unknown): error is Error {
  return (
    error instanceof Error &&
    typeof (error as { name?: unknown }).name === 'string' &&
    (error as Error).name === 'AbortError'
  );
}

function buildExternalCancelCause(args: {
  taskId: TaskId;
  runtimeInstanceId: string;
  provenance: string;
  observedAt: string;
  observation: ExternalCancellationObservation;
}): TerminalCauseExternalCancel {
  const { taskId, runtimeInstanceId, provenance, observedAt, observation } =
    args;
  return {
    kind: 'external-cancel',
    taskId,
    runtimeInstanceId,
    observedAt,
    provenance,
    reason: observation.reason,
    requestedAt: observation.requestedAt,
    ...(observation.cancelMode === undefined
      ? {}
      : { cancelMode: observation.cancelMode }),
  };
}

function completeProviderFailureCause(args: {
  taskId: TaskId;
  runtimeInstanceId: string;
  observedAt: string;
  error: CodexProviderFailureError;
}): TerminalCauseProviderFailure {
  const { taskId, runtimeInstanceId, observedAt, error } = args;
  const partial = error.providerFailureCause;
  return {
    kind: 'provider-failure',
    taskId,
    runtimeInstanceId,
    observedAt,
    provenance: partial.provenance,
    provider: partial.provider,
    classification: partial.classification,
    retryable: partial.retryable,
    message: partial.message,
    ...(partial.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: partial.retryAfterMs }),
    ...(partial.attemptsExhausted === undefined
      ? {}
      : { attemptsExhausted: partial.attemptsExhausted }),
    ...(partial.sdkErrorCode === undefined
      ? {}
      : { sdkErrorCode: partial.sdkErrorCode }),
  };
}

const DEFAULT_PROVENANCE = 'codex-runtime-driver';

/**
 * Drive a Codex turn invocation through the WU-J typed wrap.
 *
 * Outcome mapping:
 *
 *   - `runTurn` resolves with a value         → `success` branch.
 *   - `runTurn` throws an AbortError-shaped error
 *      AND `observeExternalCancellation` returns an observation
 *                                              → `cancelled` branch
 *                                                (TerminalCauseExternalCancel).
 *   - `runTurn` throws a `CodexProviderFailureError`
 *                                              → `failure` branch
 *                                                (TerminalCauseProviderFailure
 *                                                with the existing 4-axis
 *                                                classification preserved).
 *   - Any other thrown value (including AbortError without an external
 *     cancellation observation) is rethrown unchanged. The helper does
 *     NOT manufacture a cause for unrecognised failures; that decision
 *     belongs to the surrounding agent-runtime fail-closed path.
 */
export async function mapCodexTurnOutcomeToCancellableResult<TSuccess>(
  context: CodexTurnOutcomeMapperContext,
  runTurn: () => Promise<TSuccess>,
): CancellableResultAsync<TSuccess, CodexProviderFailureError> {
  const provenance = context.provenance ?? DEFAULT_PROVENANCE;
  const now = context.observedAtNow ?? (() => new Date().toISOString());

  let value: TSuccess;
  try {
    value = await runTurn();
  } catch (error) {
    if (isAbortErrorShape(error)) {
      const observation = context.observeExternalCancellation();
      if (observation !== undefined) {
        return cancellableCancelled(
          context.taskId,
          buildExternalCancelCause({
            taskId: context.taskId,
            runtimeInstanceId: context.runtimeInstanceId,
            provenance,
            observedAt: now(),
            observation,
          }),
        );
      }
      // AbortError without a paired external-cancellation observation is
      // surfaced upward unchanged (e.g., veto-driven controller.abort()
      // paths handled by the driver itself, or unexpected aborts that
      // should not be silently re-classified).
      throw error;
    }

    if (error instanceof CodexProviderFailureError) {
      return cancellableFailure(
        context.taskId,
        error,
        completeProviderFailureCause({
          taskId: context.taskId,
          runtimeInstanceId: context.runtimeInstanceId,
          observedAt: now(),
          error,
        }),
      );
    }

    throw error;
  }

  return cancellableSuccess(context.taskId, value);
}
