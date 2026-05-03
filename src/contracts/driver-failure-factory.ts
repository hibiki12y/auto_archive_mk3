/**
 * WU-W Phase 1 — Driver-failure construction factory.
 *
 * Builds a `TerminalCauseDriverFailure` from an arbitrary throwable (or
 * non-throwable) value caught at the driver-adapter boundary. This helper
 * formalizes the fail-closed origination pattern that Phase 2 will adopt
 * inside `codex-runtime-adapter`; Phase 3 will demote the agent-runtime
 * fallback construction (`buildFailClosedCause`) to defense-in-depth.
 *
 * Design choices (per orchestrator dispatch + spec §3 Phase 1):
 *   - Provenance literal is `'driver-adapter'` to mark origination at the
 *     driver boundary (distinct from agent-runtime fallback).
 *   - `requestContext` is a strict pass-through: callers control what
 *     breadcrumbs are recorded. Per OQ-W1 v1 the shape is unconstrained.
 *     Callers MUST NOT pass secrets/tokens/raw instructions (§7 R3).
 *   - `stack` is populated only when the input is an `Error` instance with
 *     a string `stack` property; never synthesized.
 *   - `message` falls back to `String(error)` for non-Error throwables to
 *     preserve forensic value (e.g. `throw 'oops'`, `throw 42`).
 *
 * @see specs/wu-w-driver-fail-closed-origination.md §3 Phase 1, §5 AC-W2
 */

import type { TerminalCauseDriverFailure } from './terminal-cause.js';

export interface BuildDriverFailureFromErrorParams {
  /** The caught throwable. Any value is accepted (Error, string, number, object, …). */
  readonly error: unknown;
  readonly taskId: string;
  readonly runtimeInstanceId: string;
  /**
   * Free-form phase tag (e.g. `'pre-turn'`, `'streaming'`, `'post-turn'`).
   * Phase enumeration is a non-goal for v1; see spec OQ-1 follow-up.
   */
  readonly phase: string;
  /** Defaults to `new Date()` when omitted. */
  readonly observedAt?: Date;
  /**
   * Optional structured breadcrumbs. Pass-through verbatim; producers MUST
   * sanitize PII/secrets before invocation (§7 R3).
   */
  readonly requestContext?: Record<string, unknown>;
}

/**
 * Construct a `TerminalCauseDriverFailure` from a caught throwable.
 *
 * Behavior matrix (AC-W2):
 *   - `error instanceof Error` → `message = error.message`,
 *     `stack = error.stack` (when string), provenance `'driver-adapter'`.
 *   - non-Error throwable → `message = String(error)`, no `stack`.
 *   - `observedAt` parameter present → used; otherwise `new Date()`.
 *   - `requestContext` parameter present → passed through (shallow copy is
 *     NOT performed; callers retain ownership of the object identity per
 *     spec §3 Phase 1 pass-through semantics).
 *   - `requestContext` parameter absent → field is OMITTED from output.
 */
export function buildDriverFailureFromError(
  params: BuildDriverFailureFromErrorParams,
): TerminalCauseDriverFailure {
  const { error, taskId, runtimeInstanceId, phase, observedAt, requestContext } = params;

  const isError = error instanceof Error;
  const message = isError ? error.message : String(error);
  const stack = isError && typeof error.stack === 'string' ? error.stack : undefined;
  const observedAtIso = (observedAt ?? new Date()).toISOString();

  const cause: TerminalCauseDriverFailure = {
    kind: 'driver-failure',
    taskId,
    runtimeInstanceId,
    observedAt: observedAtIso,
    provenance: 'driver-adapter',
    phase,
    message,
    ...(stack === undefined ? {} : { stack }),
    ...(requestContext === undefined ? {} : { requestContext }),
  };

  return cause;
}
