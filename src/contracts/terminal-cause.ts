/**
 * @version 1.1.0
 * @stability frozen
 *
 * Wave 1 Control Proof Freeze 후보. Public surface 변경은 SemVer minor 이상 bump 필요.
 *
 * 1.1.0 (2026-04-30): Widen `TerminalCauseProviderFailure.provider` from the
 * `'codex'` literal to `'codex' | 'anthropic'` per
 * `specs/CLARIFICATIONS/multi-provider-scope.md`. Additive: existing producers
 * continue to populate `'codex'`; the Claude Agent driver populates
 * `'anthropic'`.
 */

import type { VetoPath } from './veto.js';

/**
 * WU-H Terminal-Cause Taxonomy (planning-only spec implementation).
 *
 * Discriminated union that consolidates the cause vocabulary previously split
 * across `terminal-evidence.ts`, `agent-runtime.ts`, and
 * `codex-runtime-adapter.ts`. This module owns the **shape**; producers per
 * §4 own the **classification**. See `specs/wu-h-terminal-cause-taxonomy.md`.
 *
 * Validator-neutrality (§5): only JSON-round-trippable fields; no host
 * objects (`Error`, `Promise`, `AbortSignal`); discriminant is `kind`.
 */

export type TerminalCauseKind =
  | 'success'
  | 'timeout'
  | 'external-cancel'
  | 'runtime-veto'
  | 'driver-failure'
  | 'provider-failure';

export const TERMINAL_CAUSE_KINDS = [
  'success',
  'timeout',
  'external-cancel',
  'runtime-veto',
  'driver-failure',
  'provider-failure',
] as const satisfies readonly TerminalCauseKind[];

export type CancelMode = 'cooperative' | 'preemptive' | 'degraded';

export const CANCEL_MODES = ['cooperative', 'preemptive', 'degraded'] as const satisfies readonly CancelMode[];

/**
 * WU-K §3.3 — unified ComputeNode cancel-origin port enumeration.
 *
 * Names the **signal source** behind a cancellation event, kept behind the
 * unified compute-node abstraction (C2) so no `provider:*`, `originator:*`,
 * `slurm-only:*`, or `local-compute-node:*` discriminants can leak in.
 * These values are observations that map INTO `cancelMode`; they are not
 * themselves a peer cause-kind (ST-03).
 */
export type CancelOriginPort =
  | 'codex-sdk-abort'
  | 'dispatcher-veto-latch'
  | 'roster-saturation-latch'
  | 'plana-runtime-review'
  | 'compute-node:slurm-scancel'
  | 'compute-node:container-signal'
  | 'compute-node:exit-inferred';

export const CANCEL_ORIGIN_PORTS = [
  'codex-sdk-abort',
  'dispatcher-veto-latch',
  'roster-saturation-latch',
  'plana-runtime-review',
  'compute-node:slurm-scancel',
  'compute-node:container-signal',
  'compute-node:exit-inferred',
] as const satisfies readonly CancelOriginPort[];

/**
 * WU-K §3.2 — optional structured detail attached alongside `cancelMode`
 * on the two cancel-bearing members of `TerminalCause`. All fields except
 * `originPort` are optional; values remain JSON-round-trippable per §5.
 */
export interface CancelModeDetail {
  originPort: CancelOriginPort;
  /** Platform signal string when observable (e.g. 'SIGTERM', 'SIGKILL'). */
  signal?: string;
  /** Finite numeric exit code when observed from the compute-node side. */
  observedExitCode?: number;
  /** ISO-8601 timestamp when the origin signal was observed. */
  observedAt?: string;
}

/**
 * Exhaustiveness helper — compile-time guarantee that switches over
 * `CancelMode` cover all three reserved values. The `never` default
 * branch fails to typecheck if a fourth value is ever added without
 * updating callers.
 */
export function _exhaustCancelMode(m: CancelMode): string {
  switch (m) {
    case 'cooperative':
      return 'cooperative';
    case 'preemptive':
      return 'preemptive';
    case 'degraded':
      return 'degraded';
    default: {
      const _x: never = m;
      return _x;
    }
  }
}

export interface TerminalCauseBase {
  taskId: string;
  runtimeInstanceId: string;
  /** ISO-8601 timestamp marking when this cause was observed by its producer. */
  observedAt: string;
  /** Free-form attribution tag; see WU-N for prospective enumeration. */
  provenance: string;
}

export interface TerminalCauseSuccess extends TerminalCauseBase {
  kind: 'success';
  artifactLocation?: string;
}

export interface TerminalCauseTimeout extends TerminalCauseBase {
  kind: 'timeout';
  deadlineMs: number;
  /** ISO-8601 timestamp; when the timer fired. */
  firedAt: string;
}

export interface TerminalCauseExternalCancel extends TerminalCauseBase {
  kind: 'external-cancel';
  reason: string;
  /** ISO-8601 timestamp; when external cancellation was requested. */
  requestedAt: string;
  /** WU-K metadata; not a peer-kind. */
  cancelMode?: CancelMode;
  /** WU-K structured cancel-origin detail (optional). */
  cancelDetail?: CancelModeDetail;
}

/**
 * WU-H §3.6 sub-discriminator for `runtime-veto` causes (Option H1).
 *
 * Identifies the subsystem that issued the veto without introducing a new
 * peer cause-kind in the `TerminalCause` discriminated union (ST-03
 * metadata-not-peer-kind alignment). Optional for backward compatibility;
 * legacy producers MAY omit the field, in which case consumers SHOULD treat
 * the veto as `'runtime'` (the legacy intra-runtime default).
 *
 * Mapping:
 *   - `'admission'` — WU-L `AdmissionGate` deny path (T1, T2 pre-chokepoint,
 *     or admit→deny flip surfaced via `latchRuntimeVeto`).
 *   - `'operator'`  — explicit operator kill-switch surface.
 *   - `'runtime'`   — intra-runtime veto (legacy default; equivalent to
 *     omitted/undefined).
 *
 * @see specs/wu-h-terminal-cause-taxonomy.md §3.6 runtime-veto
 *      sub-discriminator (Option H1).
 * @see specs/wu-l-admission-rule-evaluator.md §3.5 and §8 (coordinated
 *      extension block).
 */
export type VetoSource = 'admission' | 'operator' | 'runtime' | 'plana';

export const VETO_SOURCES = [
  'admission',
  'operator',
  'runtime',
  'plana',
] as const satisfies readonly VetoSource[];

export interface TerminalCauseRuntimeVeto extends TerminalCauseBase {
  kind: 'runtime-veto';
  reason: string;
  veto: VetoPath;
  cancellation?: {
    requestedAt: string;
    cancelMode?: CancelMode;
    /** WU-K structured cancel-origin detail (optional). */
    cancelDetail?: CancelModeDetail;
  };
  /**
   * Sub-discriminator identifying the subsystem that issued the veto.
   * Optional for backward compatibility (legacy veto records may omit).
   * Per WU-H Option H1 (ST-03 metadata-not-peer-kind alignment) —
   * admission-gate denials surface as `runtime-veto` with
   * `vetoSource: 'admission'` rather than as a new peer cause-kind.
   * @see specs/wu-h-terminal-cause-taxonomy.md §3.6 runtime-veto
   *      sub-discriminator
   * @see specs/wu-l-admission-rule-evaluator.md §3.5
   */
  readonly vetoSource?: VetoSource;
}

export interface TerminalCauseDriverFailure extends TerminalCauseBase {
  kind: 'driver-failure';
  /** Narrow string today; tightenable to enum in a follow-up WU (OQ-1). */
  phase: string;
  message: string;
  /**
   * WU-W Phase 1 (additive, optional). Best-effort error stack-trace string
   * extracted from the originating throwable when it is an `Error` instance.
   * Validator-neutral (plain string only). Producers MAY pre-truncate to
   * bound payload size; no host objects.
   *
   * @see specs/wu-w-driver-fail-closed-origination.md §3 Phase 1
   * @see specs/wu-w-driver-fail-closed-origination.md §7 R2 (truncation hook,
   *      future hardening)
   */
  readonly stack?: string;
  /**
   * WU-W Phase 1 (additive, optional). Free-form structured context recorded
   * by the driver at fail-closed origination time (e.g. `taskId`, `phase`,
   * adapter-specific routing hints). Per OQ-W1 v1, the shape is intentionally
   * unconstrained; callers SHOULD include enough breadcrumbs to root-cause
   * the failure but no schema is enforced.
   *
   * **WARNING (§7 R3):** This field MUST NOT contain secrets, tokens, raw
   * instruction text, operator identifiers, or any other PII. The value
   * propagates verbatim through observer fan-out; producers are responsible
   * for sanitizing input. Reviewer audit is enforced at WU-W Phase 3.
   *
   * @see specs/wu-w-driver-fail-closed-origination.md §3 Phase 1, §6 OQ-W1, §7 R3
   */
  readonly requestContext?: Record<string, unknown>;
}

/**
 * WU-H §6.12 binding (RESOLVED, Session 115): provider-failure classification
 * adopts the **Codex 9-class taxonomy**. Each semantic name corresponds to a
 * canonical F-class identifier in the spec; producers MUST emit the semantic
 * name (string literal) — the F-class identifiers are documentation only.
 *
 * | F-class | Semantic name           | Retryable? | Typical signal                             |
 * |---------|-------------------------|------------|--------------------------------------------|
 * | F1      | `rate-limit`            | yes        | 429 / throttle / token-bucket exhaustion   |
 * | F2      | `quota-exhausted`       | no         | 402 / billing-quota / plan-cap exceeded    |
 * | F3      | `transient-network`     | yes        | DNS, TCP reset, TLS handshake, ECONN*      |
 * | F4      | `transient-server`      | yes        | 5xx, gateway timeout, upstream unavailable |
 * | F5      | `transient-tool`        | yes        | tool-call timeout / sandbox blip / IO race |
 * | F6      | `permanent-auth`        | no         | 401 / 403 / invalid-key / revoked-token    |
 * | F7      | `permanent-config`      | no         | invalid model / missing env / bad request  |
 * | F8      | `permanent-protocol`    | no         | malformed SDK response / contract drift    |
 * | F9      | `unknown`               | no         | unmapped error; default catch-all          |
 *
 * The `provider` discriminator is one of the literals enumerated by
 * `PROVIDER_FAILURE_PROVIDERS` (see `specs/CLARIFICATIONS/multi-provider-scope.md`
 * — Codex SDK + Claude Agent SDK as of 1.1.0). Forward-reserved optional fields
 * (`retryAfterMs`, `attemptsExhausted`, `sdkErrorCode`, `cause`) are part of
 * the type today but no producer is required to populate them; retry-policy
 * scheduling is a downstream WU.
 *
 * @see specs/wu-h-terminal-cause-taxonomy.md §6.12 (Codex 9-class taxonomy)
 */
export const PROVIDER_FAILURE_CLASSIFICATIONS = [
  'rate-limit',
  'quota-exhausted',
  'transient-network',
  'transient-server',
  'transient-tool',
  'permanent-auth',
  'permanent-config',
  'permanent-protocol',
  'unknown',
] as const;

export type ProviderFailureClassification =
  (typeof PROVIDER_FAILURE_CLASSIFICATIONS)[number];

/**
 * Allowed provider literals for `TerminalCauseProviderFailure.provider`.
 * Each entry corresponds to a runtime driver registered by
 * `specs/CLARIFICATIONS/multi-provider-scope.md`. Adding a new provider
 * requires a coordinated WU (driver + factory + doctor + this list).
 */
export const PROVIDER_FAILURE_PROVIDERS = ['codex', 'anthropic'] as const;

export type ProviderFailureProvider =
  (typeof PROVIDER_FAILURE_PROVIDERS)[number];

/**
 * AC-3 forward-extension proof: adding a new classification value requires
 * editing exactly this file (the tuple above + this exhaustive switch); every
 * downstream consumer that exhausts on `ProviderFailureClassification` will
 * fail to compile until updated.
 */
export function _exhaustProviderFailureClassification(
  c: ProviderFailureClassification,
): string {
  switch (c) {
    case 'rate-limit':
      return 'rate-limit';
    case 'quota-exhausted':
      return 'quota-exhausted';
    case 'transient-network':
      return 'transient-network';
    case 'transient-server':
      return 'transient-server';
    case 'transient-tool':
      return 'transient-tool';
    case 'permanent-auth':
      return 'permanent-auth';
    case 'permanent-config':
      return 'permanent-config';
    case 'permanent-protocol':
      return 'permanent-protocol';
    case 'unknown':
      return 'unknown';
    default: {
      const _x: never = c;
      return _x;
    }
  }
}

/**
 * Provider-failure terminal cause (WU-H §6.12 binding — Codex 9-class
 * taxonomy). Emitted by the codex-runtime driver (and downstream adapters)
 * when the provider SDK surfaces an error that the runtime classifies into
 * one of the F1..F9 buckets defined on `ProviderFailureClassification`.
 *
 * Required fields:
 *   - `kind`           — discriminator literal `'provider-failure'`.
 *   - `classification` — semantic F-class name (see table above).
 *   - `message`        — human-readable diagnostic, safe for surfacing in
 *                        logs and operator UI; MUST NOT contain secrets.
 *   - `provenance`     — inherited from `TerminalCauseBase`; identifies the
 *                        producer site (e.g., `'codex-runtime-driver/turn.failed'`).
 *   - `provider`       — fixed literal `'codex'` (per C3, no provider abstraction).
 *   - `retryable`      — derived from classification; provided explicitly so
 *                        downstream consumers do not duplicate the F-class →
 *                        retry mapping.
 *
 * Optional / forward-reserved fields:
 *   - `retryAfterMs`      — provider-supplied backoff hint (e.g., from a
 *                            `Retry-After` header), in milliseconds.
 *   - `attemptsExhausted` — count of attempts already burned by an upstream
 *                            retry loop.
 *   - `sdkErrorCode`      — opaque SDK-native error code for cross-referencing.
 *   - `cause`             — underlying error (e.g., the original `Error`
 *                            instance) for debugging only. NOT part of the
 *                            discriminator and NOT JSON-round-trippable;
 *                            consumers MUST treat it as best-effort and MUST
 *                            NOT rely on its shape. Validator-neutrality
 *                            (§5) is preserved because the field is optional
 *                            and is excluded from `cloneTerminalCause`.
 *
 * @see specs/wu-h-terminal-cause-taxonomy.md §6.12 (RESOLVED, Session 115)
 */
export interface TerminalCauseProviderFailure extends TerminalCauseBase {
  kind: 'provider-failure';
  provider: ProviderFailureProvider;
  classification: ProviderFailureClassification;
  retryable: boolean;
  message: string;
  // Forward-reserved (optional today; retry-policy WU will populate).
  retryAfterMs?: number;
  attemptsExhausted?: number;
  sdkErrorCode?: string;
  /**
   * Optional underlying error for debugging. Excluded from the discriminator
   * and from JSON-round-trip cloning per §5 validator-neutrality.
   */
  cause?: unknown;
}

export type TerminalCause =
  | TerminalCauseSuccess
  | TerminalCauseTimeout
  | TerminalCauseExternalCancel
  | TerminalCauseRuntimeVeto
  | TerminalCauseDriverFailure
  | TerminalCauseProviderFailure;

// ---------------------------------------------------------------------------
// Validator (hand-rolled, matches existing src/contracts convention)
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertBaseFields(
  value: Record<string, unknown>,
  kind: TerminalCauseKind,
): void {
  for (const field of ['taskId', 'runtimeInstanceId', 'observedAt', 'provenance'] as const) {
    if (!isNonEmptyString(value[field])) {
      throw new TypeError(
        `terminal cause '${kind}' requires non-empty string field '${field}'.`,
      );
    }
  }
}

function isCancelMode(value: unknown): value is CancelMode {
  return value === 'cooperative' || value === 'preemptive' || value === 'degraded';
}

function isCancelOriginPort(value: unknown): value is CancelOriginPort {
  return (
    typeof value === 'string' &&
    (CANCEL_ORIGIN_PORTS as readonly string[]).includes(value)
  );
}

function isCancelModeDetail(value: unknown): value is CancelModeDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (!isCancelOriginPort(r['originPort'])) return false;
  if (r['signal'] !== undefined && typeof r['signal'] !== 'string') return false;
  if (
    r['observedExitCode'] !== undefined &&
    (typeof r['observedExitCode'] !== 'number' ||
      !Number.isFinite(r['observedExitCode']))
  ) {
    return false;
  }
  if (r['observedAt'] !== undefined && !isNonEmptyString(r['observedAt']))
    return false;
  return true;
}

function isVetoSource(value: unknown): value is VetoSource {
  return (
    value === 'admission' ||
    value === 'operator' ||
    value === 'runtime' ||
    value === 'plana'
  );
}

function isVetoPath(value: unknown): value is VetoPath {
  if (!value || typeof value !== 'object') return false;
  const veto = value as Record<string, unknown>;
  if (veto['origin'] !== 'pre-dispatch' && veto['origin'] !== 'runtime') return false;
  if (typeof veto['reason'] !== 'string') return false;
  if (typeof veto['provenance'] !== 'string') return false;
  const propagation = veto['propagation'];
  if (!propagation || typeof propagation !== 'object') return false;
  const p = propagation as Record<string, unknown>;
  return (
    typeof p['blocksSubmission'] === 'boolean' &&
    typeof p['requestsCancellation'] === 'boolean' &&
    typeof p['requestsTermination'] === 'boolean'
  );
}

export function assertTerminalCause(value: unknown): TerminalCause {
  if (!value || typeof value !== 'object') {
    throw new TypeError('terminal cause must be an object.');
  }
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (typeof kind !== 'string' || !TERMINAL_CAUSE_KINDS.includes(kind as TerminalCauseKind)) {
    throw new TypeError(
      `terminal cause kind must be one of: ${TERMINAL_CAUSE_KINDS.join(', ')}`,
    );
  }
  assertBaseFields(record, kind as TerminalCauseKind);

  switch (kind as TerminalCauseKind) {
    case 'success': {
      if (
        record['artifactLocation'] !== undefined &&
        typeof record['artifactLocation'] !== 'string'
      ) {
        throw new TypeError("terminal cause 'success' artifactLocation must be a string.");
      }
      return value as TerminalCauseSuccess;
    }
    case 'timeout': {
      if (typeof record['deadlineMs'] !== 'number' || !Number.isFinite(record['deadlineMs'])) {
        throw new TypeError("terminal cause 'timeout' requires numeric deadlineMs.");
      }
      if (!isNonEmptyString(record['firedAt'])) {
        throw new TypeError("terminal cause 'timeout' requires non-empty firedAt.");
      }
      return value as TerminalCauseTimeout;
    }
    case 'external-cancel': {
      if (typeof record['reason'] !== 'string') {
        throw new TypeError("terminal cause 'external-cancel' requires reason string.");
      }
      if (!isNonEmptyString(record['requestedAt'])) {
        throw new TypeError("terminal cause 'external-cancel' requires non-empty requestedAt.");
      }
      if (record['cancelMode'] !== undefined && !isCancelMode(record['cancelMode'])) {
        throw new TypeError(
          "terminal cause 'external-cancel' cancelMode must be cooperative|preemptive|degraded.",
        );
      }
      if (
        record['cancelDetail'] !== undefined &&
        !isCancelModeDetail(record['cancelDetail'])
      ) {
        throw new TypeError(
          "terminal cause 'external-cancel' cancelDetail must be {originPort, signal?, observedExitCode?, observedAt?}.",
        );
      }
      return value as TerminalCauseExternalCancel;
    }
    case 'runtime-veto': {
      if (typeof record['reason'] !== 'string') {
        throw new TypeError("terminal cause 'runtime-veto' requires reason string.");
      }
      if (!isVetoPath(record['veto'])) {
        throw new TypeError("terminal cause 'runtime-veto' requires structured veto.");
      }
      const cancellation = record['cancellation'];
      if (cancellation !== undefined) {
        if (!cancellation || typeof cancellation !== 'object') {
          throw new TypeError("terminal cause 'runtime-veto' cancellation must be an object.");
        }
        const c = cancellation as Record<string, unknown>;
        if (!isNonEmptyString(c['requestedAt'])) {
          throw new TypeError(
            "terminal cause 'runtime-veto' cancellation.requestedAt must be a non-empty string.",
          );
        }
        if (c['cancelMode'] !== undefined && !isCancelMode(c['cancelMode'])) {
          throw new TypeError(
            "terminal cause 'runtime-veto' cancellation.cancelMode must be cooperative|preemptive|degraded.",
          );
        }
        if (
          c['cancelDetail'] !== undefined &&
          !isCancelModeDetail(c['cancelDetail'])
        ) {
          throw new TypeError(
            "terminal cause 'runtime-veto' cancellation.cancelDetail must be {originPort, signal?, observedExitCode?, observedAt?}.",
          );
        }
      }
      if (record['vetoSource'] !== undefined && !isVetoSource(record['vetoSource'])) {
        throw new TypeError(
          "terminal cause 'runtime-veto' vetoSource must be admission|operator|runtime|plana.",
        );
      }
      return value as TerminalCauseRuntimeVeto;
    }
    case 'driver-failure': {
      if (!isNonEmptyString(record['phase'])) {
        throw new TypeError("terminal cause 'driver-failure' requires non-empty phase.");
      }
      if (typeof record['message'] !== 'string') {
        throw new TypeError("terminal cause 'driver-failure' requires message string.");
      }
      if (record['stack'] !== undefined && typeof record['stack'] !== 'string') {
        throw new TypeError(
          "terminal cause 'driver-failure' optional stack must be a string when present.",
        );
      }
      if (
        record['requestContext'] !== undefined &&
        (typeof record['requestContext'] !== 'object' ||
          record['requestContext'] === null ||
          Array.isArray(record['requestContext']))
      ) {
        throw new TypeError(
          "terminal cause 'driver-failure' optional requestContext must be a plain object when present.",
        );
      }
      return value as TerminalCauseDriverFailure;
    }
    case 'provider-failure': {
      if (
        typeof record['provider'] !== 'string' ||
        !(PROVIDER_FAILURE_PROVIDERS as readonly string[]).includes(
          record['provider'],
        )
      ) {
        throw new TypeError(
          `terminal cause 'provider-failure' provider must be one of: ${PROVIDER_FAILURE_PROVIDERS.join(', ')}`,
        );
      }
      if (
        typeof record['classification'] !== 'string' ||
        !PROVIDER_FAILURE_CLASSIFICATIONS.includes(
          record['classification'] as ProviderFailureClassification,
        )
      ) {
        throw new TypeError(
          `terminal cause 'provider-failure' classification must be one of: ${PROVIDER_FAILURE_CLASSIFICATIONS.join(', ')}`,
        );
      }
      if (typeof record['retryable'] !== 'boolean') {
        throw new TypeError(
          "terminal cause 'provider-failure' requires boolean retryable.",
        );
      }
      if (typeof record['message'] !== 'string') {
        throw new TypeError(
          "terminal cause 'provider-failure' requires message string.",
        );
      }
      if (
        record['retryAfterMs'] !== undefined &&
        (typeof record['retryAfterMs'] !== 'number' ||
          !Number.isFinite(record['retryAfterMs']))
      ) {
        throw new TypeError(
          "terminal cause 'provider-failure' retryAfterMs must be a finite number.",
        );
      }
      if (
        record['attemptsExhausted'] !== undefined &&
        (typeof record['attemptsExhausted'] !== 'number' ||
          !Number.isFinite(record['attemptsExhausted']))
      ) {
        throw new TypeError(
          "terminal cause 'provider-failure' attemptsExhausted must be a finite number.",
        );
      }
      if (
        record['sdkErrorCode'] !== undefined &&
        typeof record['sdkErrorCode'] !== 'string'
      ) {
        throw new TypeError(
          "terminal cause 'provider-failure' sdkErrorCode must be a string.",
        );
      }
      return value as TerminalCauseProviderFailure;
    }
    default: {
      // Exhaustiveness guard.
      const _exhaustive: never = kind as never;
      throw new TypeError(`unhandled terminal cause kind: ${String(_exhaustive)}`);
    }
  }
}

function cloneVetoPath(veto: VetoPath): VetoPath {
  return {
    origin: veto.origin,
    reason: veto.reason,
    provenance: veto.provenance,
    propagation: { ...veto.propagation },
  };
}

export function cloneTerminalCause(cause: TerminalCause): TerminalCause {
  switch (cause.kind) {
    case 'success':
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
    case 'timeout':
      return {
        kind: 'timeout',
        taskId: cause.taskId,
        runtimeInstanceId: cause.runtimeInstanceId,
        observedAt: cause.observedAt,
        provenance: cause.provenance,
        deadlineMs: cause.deadlineMs,
        firedAt: cause.firedAt,
      };
    case 'external-cancel':
      return {
        kind: 'external-cancel',
        taskId: cause.taskId,
        runtimeInstanceId: cause.runtimeInstanceId,
        observedAt: cause.observedAt,
        provenance: cause.provenance,
        reason: cause.reason,
        requestedAt: cause.requestedAt,
        ...(cause.cancelMode === undefined ? {} : { cancelMode: cause.cancelMode }),
        ...(cause.cancelDetail === undefined
          ? {}
          : { cancelDetail: { ...cause.cancelDetail } }),
      };
    case 'runtime-veto':
      return {
        kind: 'runtime-veto',
        taskId: cause.taskId,
        runtimeInstanceId: cause.runtimeInstanceId,
        observedAt: cause.observedAt,
        provenance: cause.provenance,
        reason: cause.reason,
        veto: cloneVetoPath(cause.veto),
        ...(cause.cancellation === undefined
          ? {}
          : {
              cancellation: {
                requestedAt: cause.cancellation.requestedAt,
                ...(cause.cancellation.cancelMode === undefined
                  ? {}
                  : { cancelMode: cause.cancellation.cancelMode }),
                ...(cause.cancellation.cancelDetail === undefined
                  ? {}
                  : { cancelDetail: { ...cause.cancellation.cancelDetail } }),
              },
            }),
        ...(cause.vetoSource === undefined ? {} : { vetoSource: cause.vetoSource }),
      };
    case 'driver-failure':
      return {
        kind: 'driver-failure',
        taskId: cause.taskId,
        runtimeInstanceId: cause.runtimeInstanceId,
        observedAt: cause.observedAt,
        provenance: cause.provenance,
        phase: cause.phase,
        message: cause.message,
        ...(cause.stack === undefined ? {} : { stack: cause.stack }),
        ...(cause.requestContext === undefined
          ? {}
          : { requestContext: { ...cause.requestContext } }),
      };
    case 'provider-failure':
      return {
        kind: 'provider-failure',
        taskId: cause.taskId,
        runtimeInstanceId: cause.runtimeInstanceId,
        observedAt: cause.observedAt,
        provenance: cause.provenance,
        provider: cause.provider,
        classification: cause.classification,
        retryable: cause.retryable,
        message: cause.message,
        ...(cause.retryAfterMs === undefined ? {} : { retryAfterMs: cause.retryAfterMs }),
        ...(cause.attemptsExhausted === undefined
          ? {}
          : { attemptsExhausted: cause.attemptsExhausted }),
        ...(cause.sdkErrorCode === undefined ? {} : { sdkErrorCode: cause.sdkErrorCode }),
      };
    default: {
      const _exhaustive: never = cause;
      throw new TypeError(`unhandled terminal cause kind: ${String(_exhaustive)}`);
    }
  }
}
