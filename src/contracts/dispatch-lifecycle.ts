/**
 * @version 1.0.0
 * @stability frozen
 *
 * Wave 1 Control Proof Freeze 후보. Public surface 변경은 SemVer minor 이상 bump 필요.
 */

/**
 * WU-N Observer Authority Boundary — observer authority levels and contract.
 *
 * Spec: `specs/wu-n-observer-authority-boundary.md`.
 *
 * Governance resolution (DIS-009, §6 Q2):
 *   "Observer authority (DIS-009): ADVISORY by default + per-observer
 *    `authoritative: true` opt-in flag. Unblocks WU-N. Rationale: ST-15
 *    evidence-earned override 톤 유지; cascading-cancel risk 회피."
 *      — IMPLEMENTATION_LOG.md 2026-04-20
 *
 * ## Authority levels (BC-1 / BC-2)
 *
 * - **ADVISORY (default).** An observer registered as a bare function or as
 *   a `LifecycleObserverDescriptor` without an explicit `authoritative:
 *   true` flag is advisory. Advisory observers receive lifecycle phases for
 *   visibility / logging / metrics. They MUST NOT trigger admission
 *   rejection, MUST NOT cause terminal cause changes, MUST NOT mutate
 *   dispatcher or runtime state. If an advisory observer throws, the
 *   exception is caught at the fan-out boundary, a structured warn line is
 *   emitted (`'lifecycle.observer.advisory-throw'` JSON), and dispatch
 *   proceeds.
 *
 * - **AUTHORITATIVE (opt-in).** Setting `authoritative: true` on the
 *   descriptor at registration time is the ONLY admission path. There is
 *   no environment variable, ambient context, or implicit promotion. An
 *   authoritative observer that throws may, via the documented authority
 *   surface only, cause a terminal `runtime-veto` (WU-H §3.4) carrying the
 *   observer's identity as `provenance`. The observer never reaches into
 *   dispatcher internals; the runtime translates the throw into a
 *   `VetoPath` through `latchRuntimeVeto` (WU-J cancellable wrap path).
 *   This is the single side-channel-free authority surface (BC-3).
 *
 * ## Multi-authoritative resolution (BC-4 / I-N5)
 *
 * Per §6 Q2, when two or more authoritative observers throw against the
 * same lifecycle phase, **first-wins**: the first thrown veto latches the
 * terminal cause; subsequent authoritative throws are recorded in the
 * `LifecycleAuthorityAuditSink` as suppressed votes (with both committed
 * and suppressed observer identities) but do NOT reopen the latch. This
 * matches WU-J's I-J3 latch-precedence rule.
 *
 * ## taskId opacity (BC-5 / BC-6 cross-reference)
 *
 * `LifecyclePhaseObservation.taskId` is a `string` for transport
 * compatibility, but per WU-M BC-5/BC-6 observers MUST treat it opaquely:
 * comparison-by-equality and verbatim relay only. Structural decomposition
 * (substring, split, regex against internal layout, case normalization) is
 * forbidden. The `taskId` field is intentionally typed `string` rather
 * than the branded `TaskId` to avoid leaking the brand symbol across
 * arbitrary observer transport boundaries; the opacity discipline is a
 * convention enforced by code review and grep audits, not by the type.
 *
 * ## Authority register (current call sites)
 *
 * Small register (not a registry). Update when a new observer site is
 * added or when an existing site is reclassified.
 *
 *   | Call site                                              | Authority |
 *   |--------------------------------------------------------|-----------|
 *   | `src/core/dispatcher.ts` `safeNotify(...)`             | ADVISORY  |
 *   | `src/runtime/agent-runtime.ts` `safeNotifyLifecycle()` | mixed *   |
 *   | `src/core/compute-node.ts` per-allocation observer     | ADVISORY  |
 *   | `src/core/compute-node-slurm-apptainer.ts` (unused)    | ADVISORY  |
 *   | `src/core/gitlab-clone-compute-node.ts`                | ADVISORY  |
 *
 *   * `agent-runtime.ts` accepts either a function (advisory) or a
 *     descriptor (authority per `authoritative` flag); see
 *     `LifecycleObserverInput`.
 *
 * Anything not in this register is, by BC-1, advisory until explicitly
 * reclassified here.
 */

import type { TerminalCause } from './terminal-cause.js';

export type DispatchLifecyclePhase =
  | 'accepted'
  | 'admission-denied'
  | 'runtime-entering'
  | 'runtime-running'
  | 'settling'
  | 'terminal';

export const DISPATCH_LIFECYCLE_PHASES = [
  'accepted',
  'admission-denied',
  'runtime-entering',
  'runtime-running',
  'settling',
  'terminal',
] as const satisfies readonly DispatchLifecyclePhase[];

export interface LifecyclePhaseObservation {
  phase: DispatchLifecyclePhase;
  /**
   * Opaque correlation key issued by the dispatcher admission boundary
   * (WU-M BC-4). Observers MUST treat as opaque (BC-5/BC-6): equality
   * compare or relay verbatim; never parse / split / normalize.
   */
  taskId: string;
  observedAt: string;
  instanceId?: string;
  /**
   * WU-V Phase 6 (closure): structured `cause` is the SOLE terminal-state
   * field on lifecycle observations. Producers populate on the `terminal`
   * phase only; subscribers MUST tolerate absence on non-terminal phases.
   */
  cause?: TerminalCause;
}

/**
 * Bare function observer. Per BC-1, registering a bare function selects
 * ADVISORY authority. The function form is preserved for backward
 * compatibility with pre-WU-N call sites (dispatcher and compute-node)
 * and remains the recommended shape for any
 * pure-notification observer.
 */
export type LifecycleObserver = (
  observation: LifecyclePhaseObservation,
) => void;

/**
 * Descriptor form for observers that need to declare authority. Use this
 * shape when you need `authoritative: true` (the only path to authority,
 * per BC-2) or want to attach a stable `id` for audit-log provenance.
 *
 * @remarks
 * The `authoritative` flag is intentionally a single-value literal-ish
 * boolean — there is no priority field, no preempt flag. Multi-observer
 * resolution is fixed at first-wins (BC-4); changing it requires
 * governance escalation.
 */
export interface LifecycleObserverDescriptor {
  /**
   * Stable identifier for this observer, surfaced in the authority audit
   * log and in any `runtime-veto` cause provenance produced by an
   * authoritative throw. Defaults to `'anonymous-observer'` when omitted;
   * supplying a meaningful id is strongly recommended for authoritative
   * observers.
   */
  id?: string;

  /** Notification callback. Same signature as `LifecycleObserver`. */
  notify: LifecycleObserver;

  /**
   * Opt-in authority declaration. Omitted, `false`, or `undefined` ⇒
   * ADVISORY. Only the literal `true` value selects AUTHORITATIVE
   * authority (BC-2). No truthy-coercion, no environment promotion.
   */
  authoritative?: boolean;
}

/**
 * Union of accepted observer shapes at the runtime fan-out surface. A
 * bare function is treated as an advisory descriptor with
 * `id = 'anonymous-observer'`.
 */
export type LifecycleObserverInput =
  | LifecycleObserver
  | LifecycleObserverDescriptor;

/**
 * Audit log entry recorded for each lifecycle observer dispatch event. The
 * audit log is written by `AgentRuntime` and consumed by the test harness
 * and (eventually) by an observability sink. Per I-N6, every authoritative
 * action carries provenance back to the originating observer's identity.
 */
export interface LifecycleAuthorityAuditEntry {
  /** Phase at which the observer fired. */
  phase: DispatchLifecyclePhase;
  /** Observer identity from the descriptor (`id` or `'anonymous-observer'`). */
  observerId: string;
  /** Resolved authority level. Always one of these two values (I-N1). */
  authority: 'advisory' | 'authoritative';
  /** ISO-8601 of when the audit entry was recorded. */
  recordedAt: string;
  /** Opaque taskId per BC-5/BC-6. */
  taskId: string;
  /**
   * Outcome of the observer invocation:
   *   - `'notified'`: callback returned without throwing.
   *   - `'advisory-suppressed'`: advisory observer threw; suppressed.
   *   - `'authority-committed'`: authoritative observer threw and its
   *      veto became the latched terminal cause (BC-4 winner).
   *   - `'authority-suppressed'`: authoritative observer threw but a
   *      prior authoritative cause was already latched (BC-4 loser).
   */
  outcome:
    | 'notified'
    | 'advisory-suppressed'
    | 'authority-committed'
    | 'authority-suppressed';
  /** Stringified error message when the observer threw; absent on success. */
  error?: string;
}

/**
 * Audit-sink callback. Errors thrown from the sink are themselves caught
 * and ignored (the sink is observation-only — it MUST NOT influence
 * dispatch state or this would itself be an unsanctioned authority
 * surface).
 */
export type LifecycleAuthorityAuditSink = (
  entry: LifecycleAuthorityAuditEntry,
) => void;
