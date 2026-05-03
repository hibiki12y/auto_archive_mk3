/**
 * M10 Stage 3 — ACP permission bridge.
 *
 * Translates an internal `AcpPermissionRequest` into an ACP
 * `connection.requestPermission(...)` RPC against the IDE, then maps
 * the IDE's response (or its absence) into a stable
 * `AcpPermissionDecision`.
 *
 * Fail-closed posture (decided in design Q2):
 *
 *   - The ACP protocol does NOT advertise `requestPermission` as a
 *     client-capability flag. Clients either implement it or return
 *     `methodNotFound`. We MUST treat any non-`selected` outcome —
 *     including RPC error, timeout, or `cancelled` — as a `denied`
 *     decision with a stable `AcpPermissionDeniedReason`.
 *   - There is NO auto-allow path. A bridge that "could not ask the
 *     IDE" results in `denied`, full stop.
 *
 * Bridge surface:
 *
 *   - `requestPermission(connection, request, options)` returns a
 *     `Promise<AcpPermissionDecision>` that always resolves (never
 *     rejects). Callers consume the decision and translate it into
 *     dispatcher-level allow/reject. This keeps the bridge simple to
 *     wire and impossible to misuse (no caller forgets a try/catch).
 *
 * Stage 3 ships the bridge in isolation. The actual call site that
 * funnels `RuntimeApprovalRegistry` events into this bridge lands
 * with the dispatcher-backed prompt driver in a follow-up stage.
 */

import {
  type AgentSideConnection,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ToolCallStatus,
  type ToolKind,
  RequestError,
} from '@agentclientprotocol/sdk';

import type {
  AcpPermissionDecision,
  AcpPermissionDeniedReason,
  AcpPermissionOption,
  AcpPermissionRequest,
  AcpPermissionRequestKind,
} from '../contracts/acp-permission.js';
import { type AcpLogger, defaultAcpLogger } from './acp-logger.js';

/** Default options surfaced to the IDE when a request omits its own. */
export const DEFAULT_PERMISSION_OPTIONS: readonly AcpPermissionOption[] = [
  {
    optionId: 'allow_once',
    label: 'Allow once',
    intent: 'allow-once',
  },
  {
    optionId: 'allow_always',
    label: 'Allow always',
    intent: 'allow-always',
  },
  {
    optionId: 'reject_once',
    label: 'Reject once',
    intent: 'reject-once',
  },
  {
    optionId: 'reject_always',
    label: 'Reject always',
    intent: 'reject-always',
  },
];

/**
 * The inverse of an `AcpPermissionOption.intent` — which decisions the
 * bridge interprets as "allowed".
 */
const ALLOW_INTENTS: ReadonlySet<AcpPermissionOption['intent']> = new Set([
  'allow-once',
  'allow-always',
]);

/** Per-call configuration knobs. */
export interface AcpPermissionBridgeOptions {
  /**
   * Hard cap on how long the bridge waits for the IDE response.
   * Defaults to 5 minutes — long enough for a thoughtful user, short
   * enough that a forgotten dialog doesn't keep a dispatch hanging
   * forever. Clamp range: `[1_000, 30 * 60_000]` ms.
   */
  readonly timeoutMs?: number;
  /**
   * Test seam for the `setTimeout`/`clearTimeout` pair so tests can
   * advance the timer deterministically without `vi.useFakeTimers()`.
   * Defaults to the global functions.
   */
  readonly schedule?: {
    readonly setTimer: (cb: () => void, ms: number) => unknown;
    readonly clearTimer: (handle: unknown) => void;
  };
  /**
   * Stage 5 — diagnostic logger. Defaults to `defaultAcpLogger`.
   * Every `denied` outcome emits one `acp-permission-denied` event
   * carrying the stable `reason` so operators can audit IDE-side
   * UX issues without wiring extra plumbing.
   */
  readonly logger?: AcpLogger;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30 * 60_000;

export class AcpPermissionBridge {
  private readonly timeoutMs: number;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly logger: AcpLogger;

  constructor(options: AcpPermissionBridgeOptions = {}) {
    const requested = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.timeoutMs = Math.max(
      MIN_TIMEOUT_MS,
      Math.min(MAX_TIMEOUT_MS, requested),
    );
    this.setTimer =
      options.schedule?.setTimer ??
      ((cb: () => void, ms: number) => setTimeout(cb, ms));
    this.clearTimer =
      options.schedule?.clearTimer ??
      ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.logger = options.logger ?? defaultAcpLogger;
  }

  /**
   * Ask the IDE for permission. Always resolves; never rejects.
   *
   * Decision mapping:
   *
   *   - `outcome.outcome === 'selected'` and the chosen option is
   *     `allow_once`/`allow_always` → `{kind: 'allowed', optionId}`
   *   - `outcome.outcome === 'selected'` and the chosen option is
   *     `reject_once`/`reject_always` → `{kind: 'denied', reason: 'user-rejected'}`
   *   - `outcome.outcome === 'cancelled'` → `denied: 'user-cancelled'`
   *   - RPC `methodNotFound` (-32601) → `denied: 'unsupported-client'`
   *   - Other JSON-RPC error → `denied: 'client-rpc-error'`
   *   - Timeout (`timeoutMs` elapsed) → `denied: 'bridge-timeout'`
   *   - Anything else thrown → `denied: 'bridge-internal'`
   */
  async requestPermission(
    connection: Pick<AgentSideConnection, 'requestPermission'>,
    request: AcpPermissionRequest,
  ): Promise<AcpPermissionDecision> {
    const options = request.options.length > 0
      ? request.options
      : DEFAULT_PERMISSION_OPTIONS;
    const optionLookup = new Map(options.map((o) => [o.optionId, o] as const));
    const wireOptions: PermissionOption[] = options.map((o) => ({
      optionId: o.optionId,
      name: o.label,
      kind: intentToKind(o.intent),
    }));

    const wireRequest: RequestPermissionRequest = {
      sessionId: request.sessionId,
      toolCall: {
        toolCallId: request.toolCallId,
        title: request.title,
        kind: requestKindToToolKind(request.kind),
        status: 'pending' satisfies ToolCallStatus,
        ...(request.description === undefined
          ? {}
          : {
              content: [
                {
                  type: 'content',
                  content: { type: 'text', text: request.description },
                },
              ],
            }),
      },
      options: wireOptions,
    };

    let timer: unknown;
    const timeoutPromise = new Promise<{
      readonly kind: 'timeout';
    }>((resolve) => {
      timer = this.setTimer(() => resolve({ kind: 'timeout' }), this.timeoutMs);
    });

    let response: RequestPermissionResponse | undefined;
    let rpcError: { readonly code?: number; readonly message: string } | undefined;
    try {
      const winner = await Promise.race([
        connection.requestPermission(wireRequest).then(
          (res: RequestPermissionResponse) => ({
            kind: 'response' as const,
            response: res,
          }),
          (err: unknown) => ({ kind: 'error' as const, error: err }),
        ),
        timeoutPromise,
      ]);

      if (winner.kind === 'timeout') {
        return this.recordDenied(request, 'bridge-timeout');
      }
      if (winner.kind === 'error') {
        rpcError = normalizeRpcError(winner.error);
      } else {
        response = winner.response;
      }
    } finally {
      if (timer !== undefined) {
        this.clearTimer(timer);
      }
    }

    if (rpcError !== undefined) {
      if (rpcError.code === -32601) {
        return this.recordDenied(request, 'unsupported-client', {
          rpcMessage: rpcError.message,
        });
      }
      return this.recordDenied(request, 'client-rpc-error', {
        rpcCode: rpcError.code,
        rpcMessage: rpcError.message,
      });
    }

    if (response === undefined) {
      return this.recordDenied(request, 'bridge-internal');
    }
    const decision = classifyResponse(response, optionLookup);
    if (decision.kind === 'denied') {
      this.recordDenied(request, decision.reason);
    }
    return decision;
  }

  /**
   * Emit `acp-permission-denied` and return the decision in one
   * step. Centralizes the log shape so every denied path carries
   * the same fields (`approvalId`, `sessionId`, `kind`, `reason`,
   * plus optional extras for RPC-error sub-classes).
   */
  private recordDenied(
    request: AcpPermissionRequest,
    reason: AcpPermissionDeniedReason,
    extra?: Readonly<Record<string, unknown>>,
  ): AcpPermissionDecision {
    this.logger({
      level: 'warn',
      label: 'acp-permission-denied',
      payload: {
        approvalId: request.approvalId,
        sessionId: request.sessionId,
        kind: request.kind,
        reason,
        ...(extra ?? {}),
      },
    });
    return denied(reason);
  }
}

function classifyResponse(
  response: RequestPermissionResponse,
  optionLookup: ReadonlyMap<string, AcpPermissionOption>,
): AcpPermissionDecision {
  const outcome = response.outcome;
  if (outcome.outcome === 'cancelled') {
    return denied('user-cancelled');
  }
  // outcome === 'selected'
  const choice = optionLookup.get(outcome.optionId);
  if (choice !== undefined) {
    if (ALLOW_INTENTS.has(choice.intent)) {
      return { kind: 'allowed', optionId: choice.optionId };
    }
    return denied('user-rejected');
  }
  // The IDE returned an option id we did not advertise. Treat as a
  // denied client-rpc-error: the IDE returned malformed-from-our-pov
  // data, so we fail closed.
  return denied('client-rpc-error');
}

function denied(reason: AcpPermissionDeniedReason): AcpPermissionDecision {
  return { kind: 'denied', reason };
}

function normalizeRpcError(err: unknown): {
  readonly code?: number;
  readonly message: string;
} {
  if (err instanceof RequestError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { message: err.message };
  }
  return { message: String(err) };
}

function intentToKind(
  intent: AcpPermissionOption['intent'],
): PermissionOption['kind'] {
  switch (intent) {
    case 'allow-once':
      return 'allow_once';
    case 'allow-always':
      return 'allow_always';
    case 'reject-once':
      return 'reject_once';
    case 'reject-always':
      return 'reject_always';
  }
}

function requestKindToToolKind(kind: AcpPermissionRequestKind): ToolKind {
  switch (kind) {
    case 'tool-execute':
      return 'execute';
    case 'tool-read':
      return 'read';
    case 'tool-edit':
      return 'edit';
    case 'tool-delete':
      return 'delete';
    case 'tool-network':
      return 'fetch';
    case 'tool-other':
      return 'other';
    case 'subagent-spawn':
      return 'execute';
    case 'shell-exec':
      return 'execute';
  }
}
