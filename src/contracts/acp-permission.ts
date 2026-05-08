/**
 * M10 Stage 1 — ACP permission bridge contract (declared early; consumed
 * starting Stage 3).
 *
 * The bridge fronts `RuntimeApprovalRegistry` for ACP clients. Stage 1
 * only declares the contract surface so that future stages can land
 * without a contract churn PR.
 *
 * Fail-closed default: any timeout, RPC error, or `cancelled` outcome
 * from the IDE maps to `denied` with a stable reason code. The bridge
 * NEVER auto-allows on missing client support.
 */

/**
 * High-level kind of action the agent is asking the IDE user to authorize.
 * Mirrors the categories the ACP `RequestPermissionRequest` carries via
 * `toolCall.kind`, mapped onto our internal vocabulary.
 */
export type AcpPermissionRequestKind =
  | 'tool-execute'
  | 'tool-read'
  | 'tool-edit'
  | 'tool-delete'
  | 'tool-network'
  | 'tool-other'
  | 'subagent-spawn'
  | 'shell-exec';

/**
 * The decision returned to the dispatcher after the IDE responds (or the
 * bridge times out / fails closed).
 */
export type AcpPermissionDecision =
  | { readonly kind: 'allowed'; readonly optionId: string }
  | { readonly kind: 'denied'; readonly reason: AcpPermissionDeniedReason };

/**
 * Why an ACP permission request resolved to `denied`. Stable enum so logs
 * and tests can assert on a specific failure mode.
 *
 * - `user-rejected`: the IDE user picked a `kind: 'reject'` option.
 * - `user-cancelled`: the IDE returned `cancelled` (e.g. session/cancel).
 * - `client-rpc-error`: the IDE returned a JSON-RPC error to our
 *   `requestPermission` call.
 * - `bridge-timeout`: the IDE never responded within the bridge timeout.
 * - `unsupported-client`: the IDE responded with `method-not-found`.
 * - `unsupported-allow-always`: the IDE selected a persistent approval
 *   option, but this implementation only supports single-use execution
 *   approvals.
 * - `bridge-internal`: the bridge itself raised (defensive fall-through).
 */
export type AcpPermissionDeniedReason =
  | 'user-rejected'
  | 'user-cancelled'
  | 'client-rpc-error'
  | 'bridge-timeout'
  | 'unsupported-client'
  | 'unsupported-allow-always'
  | 'bridge-internal';

/**
 * The envelope the dispatcher hands the bridge when it needs IDE
 * authorization. Mirrors `RuntimeApprovalRegistry.register()` arguments
 * but is kept SDK-agnostic so the registry doesn't take a hard dep on
 * the ACP SDK.
 */
export interface AcpPermissionRequest {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly kind: AcpPermissionRequestKind;
  readonly toolCallId: string;
  readonly title: string;
  readonly description?: string;
  /** Stable ordering for the IDE option list. */
  readonly options: readonly AcpPermissionOption[];
  readonly requestedAt: string;
}

/** One permission option the IDE will surface to the user. */
export interface AcpPermissionOption {
  readonly optionId: string;
  readonly label: string;
  readonly intent: 'allow-once' | 'allow-always' | 'reject-once' | 'reject-always';
}
