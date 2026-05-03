/**
 * WU-J `CancellableResultAsync<T, E>` — typed wrap over the dispatcher result
 * chain and the existing `SubmissionCancellationState` latch.
 *
 * Spec: `specs/wu-j-cancellable-result-wrap.md`. Prerequisite WU-H terminal
 * cause taxonomy at `src/contracts/terminal-cause.ts`.
 *
 * Binding constraints honored here:
 *   C-J1 WRAP not REPLACE   — this module exposes no mutator on the latch;
 *                              it only consumes a read-only observer surface
 *                              (see `CancellationLatchObserver` below). The
 *                              underlying `SubmissionCancellationState` in
 *                              `src/core/dispatcher.ts` is unchanged.
 *   C-J2 dispatcher-observable, NOT SDK-shape — this module does not import,
 *                              reference, or `instanceof`-check `AbortError`.
 *                              SDK-shape translation happens inside the
 *                              driver result mapper (see
 *                              `src/runtime/codex-runtime-adapter.ts`); the
 *                              cancellation cause that crosses this seam is
 *                              already the WU-H typed cause.
 *   C-J3 cancellation cause borrowed from WU-H — the `cancelled` branch
 *                              carries `TerminalCauseExternalCancel |
 *                              TerminalCauseRuntimeVeto` directly (WU-H §3),
 *                              not a redefined vocabulary.
 *   C-J4 cancel-mode metadata stays in WU-K — surfaced via the underlying
 *                              cause's optional `cancelMode` /
 *                              `cancellation.cancelMode` fields, never
 *                              redefined here.
 *   C-J5 NO new exception class crosses the dispatcher seam — this module
 *                              exports zero `class` declarations of any
 *                              kind. Cancellation flows through the typed
 *                              `cancelled` branch.
 *   C-J6 `<T, E>` with E bounded to a named driver/provider failure type —
 *                              `E extends DispatcherDriverFailure` where
 *                              `DispatcherDriverFailure` resolves to the
 *                              concrete `CodexProviderFailureError` class
 *                              from the driver. `E` is NOT `unknown` /
 *                              `Error` / `any`.
 *
 * Anti-scope honored here:
 *   NG-J1 no `neverthrow` / `fp-ts` / `effect-ts` imports.
 *   NG-J2 no replacement of `SubmissionCancellationState`.
 *   NG-J3 no cancel-mode taxonomy (lives in WU-K).
 *   NG-J4 no `AsyncIterable<RuntimeEvent>` transport (lives in WU-Q).
 *   NG-J5 no promotion to a generic project-wide result framework.
 */

import type {
  TerminalCause,
  TerminalCauseExternalCancel,
  TerminalCauseRuntimeVeto,
} from './terminal-cause.js';
import type { TaskId } from './task-id.js';
import type { CodexProviderFailureError } from '../runtime/codex-runtime-adapter.js';

// ---------------------------------------------------------------------------
// Bounded failure type for `E` — single named driver/provider failure today.
// Per C-J6 reversal: a second concrete consumer would widen this to a union.
// ---------------------------------------------------------------------------

export type DispatcherDriverFailure = CodexProviderFailureError;

// ---------------------------------------------------------------------------
// Cancellation cause — WU-H subset (external-cancel | runtime-veto).
// Cancel-mode metadata (WU-K) flows through unchanged on the cause object.
// ---------------------------------------------------------------------------

export type CancellationTerminalCause =
  | TerminalCauseExternalCancel
  | TerminalCauseRuntimeVeto;

// ---------------------------------------------------------------------------
// Branches.
// ---------------------------------------------------------------------------

export interface CancellableSuccess<T> {
  readonly kind: 'success';
  readonly value: T;
  readonly taskId: TaskId;
}

export interface CancellableFailure<E extends DispatcherDriverFailure> {
  readonly kind: 'failure';
  readonly error: E;
  readonly cause: TerminalCause;
  readonly taskId: TaskId;
}

export interface CancellableCancelled {
  readonly kind: 'cancelled';
  readonly cause: CancellationTerminalCause;
  readonly taskId: TaskId;
}

export type CancellableResult<T, E extends DispatcherDriverFailure> =
  | CancellableSuccess<T>
  | CancellableFailure<E>
  | CancellableCancelled;

export type CancellableResultAsync<T, E extends DispatcherDriverFailure> =
  Promise<CancellableResult<T, E>>;

// ---------------------------------------------------------------------------
// Constructors. Plain object factories — no class identities at the seam.
// ---------------------------------------------------------------------------

export function cancellableSuccess<T>(
  taskId: TaskId,
  value: T,
): CancellableSuccess<T> {
  return { kind: 'success', taskId, value };
}

export function cancellableFailure<E extends DispatcherDriverFailure>(
  taskId: TaskId,
  error: E,
  cause: TerminalCause,
): CancellableFailure<E> {
  return { kind: 'failure', taskId, error, cause };
}

export function cancellableCancelled(
  taskId: TaskId,
  cause: CancellationTerminalCause,
): CancellableCancelled {
  return { kind: 'cancelled', taskId, cause };
}

// ---------------------------------------------------------------------------
// Discriminators.
// ---------------------------------------------------------------------------

export function isCancellableSuccess<T, E extends DispatcherDriverFailure>(
  result: CancellableResult<T, E>,
): result is CancellableSuccess<T> {
  return result.kind === 'success';
}

export function isCancellableFailure<T, E extends DispatcherDriverFailure>(
  result: CancellableResult<T, E>,
): result is CancellableFailure<E> {
  return result.kind === 'failure';
}

export function isCancellableCancelled<T, E extends DispatcherDriverFailure>(
  result: CancellableResult<T, E>,
): result is CancellableCancelled {
  return result.kind === 'cancelled';
}

// ---------------------------------------------------------------------------
// Latch observer — typed adapter at the wrap boundary (AC-J7 allowance).
//
// Exposes ONLY read methods; cancel-trigger paths remain via the existing
// `SubmissionCancellationState` API in `src/core/dispatcher.ts` (I-J7).
// ---------------------------------------------------------------------------

export interface CancellationLatchObserver {
  /** Synchronous read of latched cause (or undefined if not yet latched). */
  currentLatchedCause(): CancellationTerminalCause | undefined;
  /**
   * Promise that resolves when (and only when) the latch fires. MUST NOT be
   * used to wait for non-cancellation outcomes; the wrap relies on this
   * promise being silent if the task ends without cancellation.
   */
  whenLatched(): Promise<CancellationTerminalCause>;
}

// ---------------------------------------------------------------------------
// Driver result envelope consumed by the projection.
//
// The driver result mapper (e.g., `codex-runtime-adapter.ts`) is responsible
// for translating any SDK-shape error (including `AbortError`) into either a
// `failure` envelope (with a WU-H cause) or — when cancellation was the
// proximate cause — letting the latch observation drive the result. This
// module never sees `AbortError`.
// ---------------------------------------------------------------------------

export type DriverResultEnvelope<T, E extends DispatcherDriverFailure> =
  | { outcome: 'success'; value: T }
  | { outcome: 'failure'; error: E; cause: TerminalCause };

// ---------------------------------------------------------------------------
// Projection: combine latch + driver result into the typed wrap.
//
// Ordering policy (I-J3) defers to whichever observation lands first on the
// JS microtask queue — the underlying `SubmissionCancellationState` ordering
// is the oracle and is NOT redefined here. If the latch fired before the
// driver-result mapper produced a value, the wrap reports cancellation;
// otherwise, the driver result wins.
// ---------------------------------------------------------------------------

export async function projectCancellableResult<
  T,
  E extends DispatcherDriverFailure,
>(args: {
  taskId: TaskId;
  latch: CancellationLatchObserver;
  driverResult: Promise<DriverResultEnvelope<T, E>>;
}): CancellableResultAsync<T, E> {
  const { taskId, latch, driverResult } = args;

  // Fast-path: latch already set before we entered.
  const preObserved = latch.currentLatchedCause();
  if (preObserved !== undefined) {
    return cancellableCancelled(taskId, preObserved);
  }

  type Win =
    | { src: 'driver'; envelope: DriverResultEnvelope<T, E> }
    | { src: 'latch'; cause: CancellationTerminalCause };

  const driverP: Promise<Win> = driverResult.then((envelope) => ({
    src: 'driver' as const,
    envelope,
  }));
  const latchP: Promise<Win> = latch.whenLatched().then((cause) => ({
    src: 'latch' as const,
    cause,
  }));

  const winner = await Promise.race([driverP, latchP]);
  if (winner.src === 'latch') {
    return cancellableCancelled(taskId, winner.cause);
  }

  // Driver settled first. Per I-J3 ("success-before-latch → success") we do
  // NOT override with a post-success latch observation — the race already
  // captured the ordering decision.
  if (winner.envelope.outcome === 'success') {
    return cancellableSuccess(taskId, winner.envelope.value);
  }
  return cancellableFailure(taskId, winner.envelope.error, winner.envelope.cause);
}
