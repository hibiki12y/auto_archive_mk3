/**
 * M10 Stage 1 — ACP session contract.
 *
 * The minimal in-memory shape the ACP server tracks per active session.
 * Persistence (Stage 4) will serialize a superset of this shape; Stage 1
 * only needs the in-process state to keep handshake + lifecycle tests
 * honest.
 *
 * Discriminated string types are kept as plain `string` aliases so the
 * SDK's own `SessionId` type (re-exported from `@agentclientprotocol/sdk`)
 * stays compatible without coercion.
 */

/** ACP session id. Mirrors `schema.SessionId` (a plain string in the SDK). */
export type AcpSessionId = string;

/**
 * Lifecycle phase of an ACP session as observed locally. The ACP wire
 * protocol does not surface these as a single field; we maintain them
 * to make telemetry and tests deterministic.
 */
export type AcpSessionPhase =
  | 'initialized'
  | 'authenticated'
  | 'idle'
  | 'prompting'
  | 'cancelling'
  | 'closed';

/**
 * The in-memory session record. Stage 1 introduced the immutable
 * identity fields; Stage 2 added `currentTaskId` + `pendingCancel`
 * (mutable per-turn fields) so the server can route a `cancel`
 * notification to the in-flight prompt's `AbortController`.
 *
 * Stage 4 will add `parentSessionId` (for fork lineage) and
 * `lastPromptAt` (for resume timestamps).
 */
export interface AcpSessionState {
  readonly sessionId: AcpSessionId;
  /** Working directory the client requested for this session. */
  readonly cwd: string;
  /** Additional roots advertised by the client at session creation. */
  readonly additionalDirectories: readonly string[];
  /** When the session record was created locally. */
  readonly createdAt: string;
  phase: AcpSessionPhase;
  /**
   * Stable identifier for the in-flight prompt turn, when one is
   * running. Set on `prompt` entry, cleared on `prompt` resolution
   * or after `cancel` propagates through. Stage 1 left this
   * unset; Stage 2 populates it with a turn-local id (not a
   * dispatcher-issued `TaskId`, since Stage 2 does not yet drive
   * the dispatcher).
   */
  currentTaskId?: string;
  /**
   * Abort controller wired into the active prompt turn's stream.
   * Stage 2 wires this to the `AcpPromptDriver.drive(...)` signal.
   * `cancel(sessionId)` aborts whichever controller is set.
   *
   * Defensive: the bridge MUST clear this back to `undefined` when
   * the turn settles (success or cancelled) so a stale controller
   * cannot be aborted on a later, unrelated turn.
   */
  pendingCancel?: AbortController;
  /**
   * Stage 3 — set to `true` after the server has emitted the first
   * `available_commands_update` notification for this session. Used
   * to avoid re-advertising the (rarely-changing) command list on
   * every prompt turn while still ensuring the IDE eventually sees
   * it.
   */
  commandsAdvertised?: boolean;
  /**
   * Stage 4 — when this session is the result of a `session/fork`,
   * carries the id of the upstream session it forked from. Used by
   * the server to fire M3 `rotateSession` lineage events and by the
   * persistence layer for crash-recovery audit trails.
   */
  parentSessionId?: AcpSessionId;
}

/**
 * Lifecycle event emitted by the server for observability hooks. Kept as a
 * sum of literal `kind` values so future stages can extend without
 * widening into a structural-only union.
 */
export type AcpSessionLifecycleEvent =
  | {
      readonly kind: 'session-created';
      readonly sessionId: AcpSessionId;
      readonly cwd: string;
      readonly observedAt: string;
    }
  | {
      readonly kind: 'session-authenticated';
      readonly sessionId: AcpSessionId;
      readonly methodId: string;
      readonly observedAt: string;
    }
  | {
      readonly kind: 'session-closed';
      readonly sessionId: AcpSessionId;
      readonly reason: 'cancel' | 'eof' | 'error';
      readonly observedAt: string;
    };
