import { Codex } from '@openai/codex-sdk';
import type {
  CodexOptions,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  TodoListItem,
  WebSearchItem,
} from '@openai/codex-sdk';

import {
  BoundaryValidationError,
  formatPath,
  requireArray,
  requireObject,
  requireString,
  validateCodexResponse,
} from '../contracts/boundary-validators.js';
import type { RuntimeSettingsBundle } from '../contracts/runtime-settings.js';
import type {
  RuntimeApprovalRequest,
  RuntimeEventProvenance,
  RuntimeReviewedItem,
} from '../contracts/runtime-event.js';
import type {
  ProviderFailureClassification,
  TerminalCauseDriverFailure,
  TerminalCauseProviderFailure,
} from '../contracts/terminal-cause.js';
import { buildDriverFailureFromError } from '../contracts/driver-failure-factory.js';
import type { VetoPath } from '../contracts/veto.js';
import type {
  RuntimeDriver,
  RuntimeDriverResult,
  RuntimeExecutionContext,
} from '../contracts/runtime-driver.js';
import type { AdmissionGate } from '../core/admission-gate.js';
import { AdmissionDeniedError } from '../core/admission-denied-error.js';
import { createVetoPath } from '../contracts/veto.js';
import type { VetoSource } from '../contracts/terminal-cause.js';
import {
  resolveCodexBootstrapResolution,
  type CodexReasoningEffort,
  type CodexRuntimeConfigOverrides,
} from './codex-bootstrap-settings.js';

const DEFAULT_ABORT_POLL_INTERVAL_MS = 25;
const DEFAULT_SUCCESS_REASON = 'codex runtime completed';
const PROVIDER_FAILURE_PROVENANCE = 'codex-runtime-driver';
const CODEX_RESPONSE_BOUNDARY = 'B-CDX' as const;

type WebSearchCallItemCompat = {
  readonly id?: string;
  readonly type: 'web_search_call';
  readonly status?: string;
  readonly query?: string;
};

type FutureCodexThreadItemCompat = {
  readonly id?: string;
  readonly type: string;
  readonly status?: string;
  readonly summary?: string;
  readonly text?: string;
  readonly message?: string;
  readonly command?: string;
  readonly server?: string;
  readonly tool?: string;
  readonly query?: string;
  readonly [key: string]: unknown;
};

type NormalizableCodexThreadItem =
  | ThreadItem
  | WebSearchCallItemCompat
  | FutureCodexThreadItemCompat;

/**
 * WU-H §4 ownership: this file is the sole producer of
 * `kind: 'provider-failure'` terminal causes. The cause is attached as a
 * read-only property on the thrown Error so that the back-compat throw
 * surface is preserved while `agent-runtime.ts` can detect, augment, and
 * translate the structured payload during fail-closed handling.
 *
 * The cause built here intentionally omits `taskId` / `runtimeInstanceId` /
 * `observedAt`; those identity + temporal fields are populated by the
 * consumer (agent-runtime) which holds the surrounding execution context.
 *
 * The `message` field stores the raw provider message (NOT the prefixed
 * `codex turn.failed: ...` string — that prefixed form lives on the JS
 * Error's `super(message)` for stack-trace ergonomics).
 */
export type CodexProviderFailureCausePartial = Pick<
  TerminalCauseProviderFailure,
  'kind' | 'provider' | 'classification' | 'retryable' | 'message' | 'provenance'
> &
  Partial<
    Pick<
      TerminalCauseProviderFailure,
      'retryAfterMs' | 'attemptsExhausted' | 'sdkErrorCode'
    >
  >;

/**
 * WU-H §3.7 / §6.12 F1–F9 classifier for raw Codex provider error messages.
 *
 * Ordering discipline: most-specific, least-ambiguous signals FIRST; generic
 * transient/catch-all signals LAST. The switch at tail uses the
 * `_exhaustProviderFailureClassification` pattern via an `assertNever` local
 * to provide a compile-time exhaustiveness guarantee (AC-3): adding a new
 * F-class to `PROVIDER_FAILURE_CLASSIFICATIONS` fails this function's
 * type-check until the case is handled.
 *
 * Retry-policy logic (backoff scheduling, `retryAfterMs` extraction) is a
 * downstream WU; this function only assigns the F-class + the boolean
 * retryability hint (spec §3.7 default column).
 *
 * @see specs/wu-h-terminal-cause-taxonomy.md §3.7 F1–F9 enumeration.
 */
export function classifyCodexProviderFailureMessage(
  rawMessage: string,
  // `source` is reserved for future heuristics (e.g., 'error' transports may
  // imply transient transport faults). Kept in signature for forward use.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  source: 'turn.failed' | 'error',
): { classification: ProviderFailureClassification; retryable: boolean } {
  const m = rawMessage.toLowerCase();

  const includesAny = (needles: readonly string[]): boolean =>
    needles.some((n) => m.includes(n));

  // F1 — rate-limit (throttle / 429). Must precede F2 (billing) so a
  // "429 quota …" hybrid lands as rate-limit per existing test contract.
  if (includesAny(['rate limit', 'rate-limit', 'too many requests', '429'])) {
    return classificationResult('rate-limit');
  }
  // F2 — quota-exhausted (billing / 402).
  if (
    includesAny([
      'quota',
      'insufficient_quota',
      'billing',
      'payment required',
      '402',
    ])
  ) {
    return classificationResult('quota-exhausted');
  }
  // F6 — permanent-auth (401/403, invalid/revoked credential). Check before
  // generic transient buckets so auth errors never get retried.
  if (
    includesAny([
      '401',
      '403',
      'unauthorized',
      'forbidden',
      'invalid api key',
      'invalid_api_key',
      'invalid token',
      'revoked',
      'authentication failed',
    ])
  ) {
    return classificationResult('permanent-auth');
  }
  // F7 — permanent-config (invalid model / bad request / unsupported feature).
  if (
    includesAny([
      '400',
      'invalid model',
      'does not exist',
      'do not have access',
      "don't have access",
      'model not found',
      'model access',
      'not accessible',
      'not available',
      'not enabled',
      'unknown model',
      'unknown_model',
      'unsupported model',
      'unsupported_model',
      'unsupported feature',
      'malformed',
      'invalid request',
      'bad request',
      'invalid parameter',
    ])
  ) {
    return classificationResult('permanent-config');
  }
  // F8 — permanent-protocol (SDK contract breach / schema mismatch /
  // unexpected event shape). Check before F3/F4 so "invalid response shape"
  // does not slip into transient.
  if (
    includesAny([
      'unexpected event',
      'unexpected response',
      'schema mismatch',
      'schema error',
      'protocol error',
      'unsupported sdk',
      'contract breach',
      'invalid response shape',
      'response shape',
    ])
  ) {
    return classificationResult('permanent-protocol');
  }
  // F5 — transient-tool (tool / sandbox / container blip surfaced through
  // the Codex stream). Spec explicitly calls out sandbox container crash /
  // tool-call timeout. Kept above F3 because "sandbox" is a more specific
  // signal than generic "timeout".
  if (
    includesAny([
      'sandbox',
      'container crashed',
      'tool_call_timeout',
      'tool-call timed out',
      'tool call timed out',
    ])
  ) {
    return classificationResult('transient-tool');
  }
  // F4 — transient-server (provider-side 5xx / upstream gateway). Checked
  // BEFORE F3 so explicit numeric codes (e.g., "504 Gateway Timeout") are
  // not mis-classified by the generic "timeout" substring in F3.
  if (
    includesAny([
      '500',
      '502',
      '503',
      '504',
      'internal server error',
      'bad gateway',
      'service unavailable',
      'gateway timeout',
      'upstream',
      'server error',
    ])
  ) {
    return classificationResult('transient-server');
  }
  // F3 — transient-network (DNS, TCP reset, TLS, socket timeout). Per spec:
  // "replay-safe under §6.12 predicate". ECONN* / timeouts that surface as
  // socket-level signals belong here, not F4.
  if (
    includesAny([
      'econnreset',
      'econnrefused',
      'etimedout',
      'enotfound',
      'eai_again',
      'failed to lookup address information',
      'lookup address',
      'temporary failure in name resolution',
      'getaddrinfo',
      'dns',
      'tls',
      'socket hang up',
      'socket timeout',
      'connection reset',
      'connection refused',
      'network unreachable',
      'network error',
      'timed out',
      'timeout',
      'network',
      'connection',
    ])
  ) {
    return classificationResult('transient-network');
  }
  // F9 — unknown (catch-all; producers MUST emit F9 rather than guess).
  return classificationResult('unknown');
}

/**
 * AC-3 exhaustiveness guard: every F-class must map to an explicit
 * retryability hint. Adding a new member to `ProviderFailureClassification`
 * surfaces here as a compile-time error until the case is handled.
 */
function classificationResult(
  classification: ProviderFailureClassification,
): { classification: ProviderFailureClassification; retryable: boolean } {
  switch (classification) {
    case 'rate-limit':
      return { classification, retryable: true };
    case 'quota-exhausted':
      return { classification, retryable: false };
    case 'transient-network':
      return { classification, retryable: true };
    case 'transient-server':
      return { classification, retryable: true };
    case 'transient-tool':
      return { classification, retryable: true };
    case 'permanent-auth':
      return { classification, retryable: false };
    case 'permanent-config':
      return { classification, retryable: false };
    case 'permanent-protocol':
      return { classification, retryable: false };
    case 'unknown':
      return { classification, retryable: false };
    default: {
      const _exhaustive: never = classification;
      return _exhaustive;
    }
  }
}

export class CodexProviderFailureError extends Error {
  readonly providerFailureCause: CodexProviderFailureCausePartial;

  constructor(
    message: string,
    source: 'turn.failed' | 'error',
    classificationHint?: {
      classification?: ProviderFailureClassification;
      retryable?: boolean;
    },
  ) {
    super(`codex ${source}: ${message}`);
    this.name = 'CodexProviderFailureError';
    const heuristic = classifyCodexProviderFailureMessage(message, source);
    this.providerFailureCause = {
      kind: 'provider-failure',
      provider: 'codex',
      classification:
        classificationHint?.classification ?? heuristic.classification,
      retryable: classificationHint?.retryable ?? heuristic.retryable,
      message,
      provenance: PROVIDER_FAILURE_PROVENANCE,
    };
  }
}

export function extractCodexProviderFailureCause(
  error: unknown,
): CodexProviderFailureCausePartial | undefined {
  if (
    error &&
    typeof error === 'object' &&
    'providerFailureCause' in error &&
    (error as { providerFailureCause?: unknown }).providerFailureCause
  ) {
    const candidate = (error).providerFailureCause;
    if (
      candidate &&
      typeof candidate === 'object' &&
      (candidate as { kind?: unknown }).kind === 'provider-failure' &&
      'classification' in (candidate)
    ) {
      return candidate as CodexProviderFailureCausePartial;
    }
  }
  return undefined;
}

/**
 * WU-W Phase 2 — duck-typed extractor for the driver-originated
 * `TerminalCauseDriverFailure` attached to a driver-adapter throwable.
 *
 * Mirrors {@link extractCodexProviderFailureCause}: avoids `instanceof`
 * on the caught throwable so that hostile values (Proxies with
 * `getPrototypeOf` traps, frozen primitives, etc.) cannot derail the
 * fail-closed path. Detection keys on the property attachment + the
 * cause `kind` discriminator + every required field of
 * `TerminalCauseDriverFailure`. A throwable that carries a
 * `driverFailureCause` matching `kind` and `provenance` but missing
 * `taskId` / `runtimeInstanceId` / `observedAt` / `phase` / `message`
 * is rejected here so `agent-runtime`'s consumer cannot promote a
 * partial object to a fully-typed cause.
 *
 * The name is intentionally provider-neutral. The function matches any
 * driver-adapter wrapper that follows the WU-W Phase 1 producer contract
 * (currently `CodexDriverFailureError` and `ClaudeAgentDriverFailureError`).
 * The historical alias `extractCodexDriverFailureCause` was a misnomer.
 *
 * @see specs/wu-w-driver-fail-closed-origination.md §3 Phase 2.
 */
export function extractDriverAdapterFailureCause(
  error: unknown,
): TerminalCauseDriverFailure | undefined {
  if (
    !error ||
    typeof error !== 'object' ||
    !('driverFailureCause' in error) ||
    !(error as { driverFailureCause?: unknown }).driverFailureCause
  ) {
    return undefined;
  }
  const candidate = (error as { driverFailureCause?: unknown })
    .driverFailureCause;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    (candidate as { kind?: unknown }).kind !== 'driver-failure' ||
    (candidate as { provenance?: unknown }).provenance !== 'driver-adapter'
  ) {
    return undefined;
  }
  const c = candidate as Record<string, unknown>;
  if (
    typeof c['taskId'] !== 'string' ||
    c['taskId'] === '' ||
    typeof c['runtimeInstanceId'] !== 'string' ||
    c['runtimeInstanceId'] === '' ||
    typeof c['observedAt'] !== 'string' ||
    c['observedAt'] === '' ||
    typeof c['phase'] !== 'string' ||
    c['phase'] === '' ||
    typeof c['message'] !== 'string'
  ) {
    return undefined;
  }
  return candidate as TerminalCauseDriverFailure;
}

/**
 * WU-W Phase 2 — driver-side fail-closed origination.
 *
 * Mirrors the {@link CodexProviderFailureError} pattern: rather than
 * letting an unstructured `throw` escape the codex driver and force
 * `agent-runtime` to synthesize a `TerminalCauseDriverFailure` at the
 * boundary (the historical Phase 0 behavior), the driver now wraps any
 * non-structured throw with this exception and attaches the pre-built
 * `TerminalCauseDriverFailure`. The `agent-runtime` catch path detects
 * the attachment and trusts it verbatim, preserving the rich context
 * (stack, requestContext, accurate phase tag) that would otherwise be
 * lost across the throw boundary.
 *
 * Already-structured throws — `CodexProviderFailureError` (provider
 * origination) and `CodexDriverFailureError` itself (re-entry safety) —
 * are NOT wrapped; they propagate verbatim.
 *
 * Phase 3 will demote the agent-runtime fallback synthesis behind a
 * defense-in-depth gate; Phase 2 only adds the driver-originated path.
 *
 * @see specs/wu-w-driver-fail-closed-origination.md §3 Phase 2, §5 AC-W3.
 */
export class CodexDriverFailureError extends Error {
  constructor(
    message: string,
    public readonly driverFailureCause: TerminalCauseDriverFailure,
  ) {
    super(message);
    this.name = 'CodexDriverFailureError';
  }
}

interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(
    input: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

interface CodexSdkLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
}

export interface CodexRuntimeDriverOptions {
  sdkFactory?: (options?: CodexOptions) => CodexSdkLike;
  codexOptions?: CodexOptions;
  codexRuntimeConfig?: CodexRuntimeConfigOverrides;
  abortPollIntervalMs?: number;
  /**
   * WU-L Step D — optional admission gate evaluated at the T2
   * `tool-invoke` chokepoint (just before `thread.runStreamed`). On
   * `verdict === 'deny'` the gate raises an
   * {@link AdmissionDeniedError} internally; per WU-X that error is
   * caught inside `run()` and materialized as a `runtime-veto`
   * `RuntimeDriverResult` (provenance `'admission-gate'`,
   * `vetoSource: 'admission'`) so T1 and T2 emit byte-identical
   * admission-deny vetoes.
   *
   * Omitted in production until rules are wired; behavior is identical
   * to pre-WU-L when undefined.
   *
   * @see specs/wu-l-admission-rule-evaluator.md §4
   */
  admissionGate?: AdmissionGate;
  /**
   * Optional dispatch-boundary settings provider (multi-provider-scope.md
   * §1.3.0). When supplied, the driver consults this provider on every
   * `run()` entry and overlays operator-supplied `model` / `effort` onto the
   * bootstrap-time `codexRuntimeConfig`. `provider` overrides are *ignored*
   * — provider switching is bootstrap-time only.
   */
  settingsProvider?: CodexSettingsProvider;
}

export interface CodexSettingsSnapshot {
  readonly model?: string;
  readonly effort?: CodexReasoningEffort;
}

export interface CodexSettingsProvider {
  /** Read the current operator overrides for the `arona` persona. */
  readSettings(): CodexSettingsSnapshot;
}

function readDefaultCodexResolution(): {
  readonly options: CodexOptions;
  readonly runtimeConfig: CodexRuntimeConfigOverrides;
} {
  const resolution = resolveCodexBootstrapResolution();
  return {
    options: resolution.options,
    runtimeConfig: resolution.runtimeConfig,
  };
}

function buildThreadOptions(
  runtimeSettings: RuntimeSettingsBundle,
  codexRuntimeConfig: CodexRuntimeConfigOverrides,
  modelOverride?: string,
): ThreadOptions {
  const model = modelOverride ?? codexRuntimeConfig.model;
  return {
    ...(model === undefined ? {} : { model }),
    ...(codexRuntimeConfig.modelReasoningEffort === undefined
      ? {}
      : { modelReasoningEffort: codexRuntimeConfig.modelReasoningEffort }),
    sandboxMode: runtimeSettings.sandboxMode,
    approvalPolicy: runtimeSettings.approvalPolicy,
    networkAccessEnabled:
      runtimeSettings.networkProjection.networkAccessEnabled,
    webSearchMode:
      runtimeSettings.networkProjection.webSearchMode === 'provider'
        ? 'live'
        : 'disabled',
    skipGitRepoCheck: true,
    ...(runtimeSettings.workingDirectory === undefined
      ? {}
      : { workingDirectory: runtimeSettings.workingDirectory }),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function requireNumber(
  value: unknown,
  path: ReadonlyArray<string | number>,
): asserts value is number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new BoundaryValidationError(
      CODEX_RESPONSE_BOUNDARY,
      `${formatPath(path)} must be a number.`,
    );
  }
}

function requireBoolean(
  value: unknown,
  path: ReadonlyArray<string | number>,
): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new BoundaryValidationError(
      CODEX_RESPONSE_BOUNDARY,
      `${formatPath(path)} must be a boolean.`,
    );
  }
}

function requireOptionalString(
  value: unknown,
  path: ReadonlyArray<string | number>,
): asserts value is string | undefined | null {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new BoundaryValidationError(
      CODEX_RESPONSE_BOUNDARY,
      `${formatPath(path)} must be a string when present.`,
    );
  }
}

function requireAsyncIterable(
  value: unknown,
  path: ReadonlyArray<string | number>,
): asserts value is AsyncIterable<unknown> {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !==
      'function'
  ) {
    throw new BoundaryValidationError(
      CODEX_RESPONSE_BOUNDARY,
      `${formatPath(path)} must be an async iterable.`,
    );
  }
}

function assertCodexStreamedTurn(
  raw: unknown,
): asserts raw is { events: AsyncGenerator<ThreadEvent> } {
  requireObject(raw, CODEX_RESPONSE_BOUNDARY, ['streamedTurn']);
  requireAsyncIterable(raw['events'], ['streamedTurn', 'events']);
}

function assertCodexEventEnvelope(
  raw: unknown,
): asserts raw is { type: string } & Record<string, unknown> {
  requireObject(raw, CODEX_RESPONSE_BOUNDARY, ['event']);
  requireString(raw['type'], CODEX_RESPONSE_BOUNDARY, ['event', 'type']);
}

function assertThreadItemEnvelope(
  raw: unknown,
  path: ReadonlyArray<string | number>,
): asserts raw is { type: string } & Record<string, unknown> {
  requireObject(raw, CODEX_RESPONSE_BOUNDARY, path);
  requireString(raw['type'], CODEX_RESPONSE_BOUNDARY, [...path, 'type']);
  requireOptionalString(raw['id'], [...path, 'id']);
}

function assertTurnFailedEvent(
  raw: unknown,
): asserts raw is Extract<ThreadEvent, { type: 'turn.failed' }> {
  assertCodexEventEnvelope(raw);
  requireObject(raw['error'], CODEX_RESPONSE_BOUNDARY, ['event', 'error']);
  requireString(
    raw['error']['message'],
    CODEX_RESPONSE_BOUNDARY,
    ['event', 'error', 'message'],
  );
}

function assertThreadErrorEvent(
  raw: unknown,
): asserts raw is Extract<ThreadEvent, { type: 'error' }> {
  assertCodexEventEnvelope(raw);
  requireString(raw['message'], CODEX_RESPONSE_BOUNDARY, ['event', 'message']);
}

function assertTurnCompletedEvent(
  raw: unknown,
): asserts raw is Extract<ThreadEvent, { type: 'turn.completed' }> {
  assertCodexEventEnvelope(raw);
  requireObject(raw['usage'], CODEX_RESPONSE_BOUNDARY, ['event', 'usage']);
  requireNumber(raw['usage']['input_tokens'], ['event', 'usage', 'input_tokens']);
  requireNumber(
    raw['usage']['cached_input_tokens'],
    ['event', 'usage', 'cached_input_tokens'],
  );
  requireNumber(raw['usage']['output_tokens'], ['event', 'usage', 'output_tokens']);
}

function assertThreadItemForNormalization(
  raw: unknown,
): asserts raw is NormalizableCodexThreadItem {
  assertThreadItemEnvelope(raw, ['event', 'item']);

  switch (raw['type']) {
    case 'command_execution':
      requireString(
        raw['status'],
        CODEX_RESPONSE_BOUNDARY,
        ['event', 'item', 'status'],
      );
      requireString(
        raw['command'],
        CODEX_RESPONSE_BOUNDARY,
        ['event', 'item', 'command'],
      );
      if (raw['exit_code'] !== undefined) {
        requireNumber(
          raw['exit_code'],
          ['event', 'item', 'exit_code'],
        );
      }
      return;
    case 'mcp_tool_call':
      requireString(
        raw['status'],
        CODEX_RESPONSE_BOUNDARY,
        ['event', 'item', 'status'],
      );
      requireString(
        raw['server'],
        CODEX_RESPONSE_BOUNDARY,
        ['event', 'item', 'server'],
      );
      requireString(
        raw['tool'],
        CODEX_RESPONSE_BOUNDARY,
        ['event', 'item', 'tool'],
      );
      return;
    case 'web_search':
      requireString(
        raw['query'],
        CODEX_RESPONSE_BOUNDARY,
        ['event', 'item', 'query'],
      );
      return;
    case 'web_search_call':
      if (raw['query'] !== undefined) {
        requireString(
          raw['query'],
          CODEX_RESPONSE_BOUNDARY,
          ['event', 'item', 'query'],
        );
      }
      if (raw['status'] !== undefined) {
        requireString(
          raw['status'],
          CODEX_RESPONSE_BOUNDARY,
          ['event', 'item', 'status'],
        );
      }
      return;
    case 'agent_message':
    case 'reasoning':
      requireString(
        raw['text'],
        CODEX_RESPONSE_BOUNDARY,
        ['event', 'item', 'text'],
      );
      return;
    case 'file_change':
      requireString(
        raw['status'],
        CODEX_RESPONSE_BOUNDARY,
        ['event', 'item', 'status'],
      );
      requireArray(
        raw['changes'],
        CODEX_RESPONSE_BOUNDARY,
        ['event', 'item', 'changes'],
      );
      for (const [index, change] of raw['changes'].entries()) {
        requireObject(
          change,
          CODEX_RESPONSE_BOUNDARY,
          ['event', 'item', 'changes', index],
        );
        requireString(
          change['kind'],
          CODEX_RESPONSE_BOUNDARY,
          ['event', 'item', 'changes', index, 'kind'],
        );
        requireString(
          change['path'],
          CODEX_RESPONSE_BOUNDARY,
          ['event', 'item', 'changes', index, 'path'],
        );
      }
      return;
    case 'todo_list':
      requireArray(
        raw['items'],
        CODEX_RESPONSE_BOUNDARY,
        ['event', 'item', 'items'],
      );
      for (const [index, todoItem] of raw['items'].entries()) {
        requireObject(
          todoItem,
          CODEX_RESPONSE_BOUNDARY,
          ['event', 'item', 'items', index],
        );
        requireBoolean(
          todoItem['completed'],
          ['event', 'item', 'items', index, 'completed'],
        );
      }
      return;
    case 'error':
      requireString(
        raw['message'],
        CODEX_RESPONSE_BOUNDARY,
        ['event', 'item', 'message'],
      );
      return;
    default:
      if (raw['status'] !== undefined) {
        requireString(
          raw['status'],
          CODEX_RESPONSE_BOUNDARY,
          ['event', 'item', 'status'],
        );
      }
      if (raw['summary'] !== undefined) {
        requireString(
          raw['summary'],
          CODEX_RESPONSE_BOUNDARY,
          ['event', 'item', 'summary'],
        );
      }
      if (raw['text'] !== undefined) {
        requireString(
          raw['text'],
          CODEX_RESPONSE_BOUNDARY,
          ['event', 'item', 'text'],
        );
      }
      if (raw['message'] !== undefined) {
        requireString(
          raw['message'],
          CODEX_RESPONSE_BOUNDARY,
          ['event', 'item', 'message'],
        );
      }
      return;
  }
}

function assertAgentMessageItem(
  raw: unknown,
): asserts raw is Extract<ThreadItem, { type: 'agent_message' }> {
  assertThreadItemEnvelope(raw, ['event', 'item']);
  if (raw['type'] !== 'agent_message') {
    throw new BoundaryValidationError(
      CODEX_RESPONSE_BOUNDARY,
      `${formatPath(['event', 'item', 'type'])} must be "agent_message".`,
    );
  }
  requireString(raw['text'], CODEX_RESPONSE_BOUNDARY, ['event', 'item', 'text']);
}

function assertItemLifecycleEvent(
  raw: unknown,
): asserts raw is Extract<
  ThreadEvent,
  { type: 'item.started' | 'item.updated' | 'item.completed' }
> {
  assertCodexEventEnvelope(raw);
  assertThreadItemEnvelope(raw['item'], ['event', 'item']);
}

function assertItemFailedEvent(
  raw: unknown,
): asserts raw is {
  type: 'item.failed';
  item: ThreadItem;
  failure: { message?: unknown; code?: unknown };
} {
  assertCodexEventEnvelope(raw);
  assertThreadItemForNormalization(raw['item']);
  requireObject(raw['failure'], CODEX_RESPONSE_BOUNDARY, ['event', 'failure']);
}

function assertApprovalRequestedEvent(
  raw: unknown,
): asserts raw is {
  type: 'approval.requested';
  request?: unknown;
  deadline?: unknown;
} {
  assertCodexEventEnvelope(raw);
}

function translateBoundaryValidationError(
  error: BoundaryValidationError,
): CodexProviderFailureError {
  const providerError = new CodexProviderFailureError(
    `invalid Codex response shape: ${error.message}`,
    'error',
    { classification: 'permanent-protocol', retryable: false },
  ) as CodexProviderFailureError & { cause?: unknown };
  providerError.cause = error;
  return providerError;
}

function translateCodexExecExitError(
  error: unknown,
): CodexProviderFailureError | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  if (!error.message.includes('Codex Exec exited with')) {
    return undefined;
  }
  const heuristic = classifyCodexProviderFailureMessage(error.message, 'error');
  if (heuristic.classification === 'unknown') {
    return undefined;
  }
  const providerError = new CodexProviderFailureError(
    error.message,
    'error',
    heuristic,
  ) as CodexProviderFailureError & { cause?: unknown };
  providerError.cause = error;
  return providerError;
}

function describeCommandExecutionItem(item: CommandExecutionItem): string {
  return [item.status, item.command, ...(item.exit_code === undefined ? [] : [`exit ${item.exit_code}`])].join(
    ' | ',
  );
}

function describeMcpToolCallItem(item: McpToolCallItem): string {
  return [item.status, item.server, item.tool].join(' | ');
}

function describeWebSearchItem(item: WebSearchItem): string {
  return item.query;
}

function describeFileChangeItem(item: FileChangeItem): string {
  const changes = item.changes
    .map((change) => `${change.kind}:${change.path}`)
    .join(', ');
  return changes === '' ? item.status : `${item.status} | ${changes}`;
}

function describeTodoListItem(item: TodoListItem): string {
  const completedCount = item.items.filter(
    (todoItem) => todoItem.completed,
  ).length;
  return `${completedCount}/${item.items.length} completed`;
}

function describeFutureCodexThreadItem(item: FutureCodexThreadItemCompat): string {
  const candidateDetails = [
    item.status,
    item.summary,
    item.text,
    item.message,
    item.command,
    item.query,
    item.server === undefined && item.tool === undefined
      ? undefined
      : [item.server, item.tool].filter((part) => part !== undefined).join('/'),
  ].filter(
    (detail): detail is string =>
      typeof detail === 'string' && detail.trim() !== '',
  );

  const detail =
    candidateDetails.length === 0
      ? 'no adapter summary fields'
      : candidateDetails.join(' | ');
  return `unrecognized Codex item type "${item.type}": ${detail}`;
}

function normalizeThreadItem(
  item: NormalizableCodexThreadItem,
): RuntimeReviewedItem {
  const fallbackId = `unknown-${item.type}`;
  switch (item.type) {
    case 'command_execution': {
      const commandItem = item as CommandExecutionItem;
      return {
        id: commandItem.id ?? fallbackId,
        type: commandItem.type,
        status: commandItem.status,
        summary: describeCommandExecutionItem(commandItem),
      };
    }
    case 'mcp_tool_call': {
      const mcpItem = item as McpToolCallItem;
      return {
        id: mcpItem.id ?? fallbackId,
        type: mcpItem.type,
        status: mcpItem.status,
        summary: describeMcpToolCallItem(mcpItem),
      };
    }
    case 'web_search': {
      const webSearchItem = item as WebSearchItem;
      return {
        id: webSearchItem.id ?? fallbackId,
        type: webSearchItem.type,
        summary: describeWebSearchItem(webSearchItem),
      };
    }
    case 'web_search_call': {
      const webSearchCallItem = item as WebSearchCallItemCompat;
      return {
        id: webSearchCallItem.id ?? fallbackId,
        type: 'web_search',
        originalType: webSearchCallItem.type,
        ...(webSearchCallItem.status === undefined
          ? {}
          : { status: webSearchCallItem.status }),
        summary:
          webSearchCallItem.query ??
          webSearchCallItem.status ??
          'web search call',
      };
    }
    case 'agent_message': {
      const agentMessageItem = item as Extract<
        ThreadItem,
        { type: 'agent_message' }
      >;
      return {
        id: agentMessageItem.id ?? fallbackId,
        type: agentMessageItem.type,
        summary: agentMessageItem.text,
      };
    }
    case 'reasoning': {
      const reasoningItem = item as Extract<ThreadItem, { type: 'reasoning' }>;
      return {
        id: reasoningItem.id ?? fallbackId,
        type: reasoningItem.type,
        summary: reasoningItem.text,
      };
    }
    case 'file_change': {
      const fileChangeItem = item as FileChangeItem;
      return {
        id: fileChangeItem.id ?? fallbackId,
        type: fileChangeItem.type,
        status: fileChangeItem.status,
        summary: describeFileChangeItem(fileChangeItem),
      };
    }
    case 'todo_list': {
      const todoListItem = item as TodoListItem;
      return {
        id: todoListItem.id ?? fallbackId,
        type: todoListItem.type,
        summary: describeTodoListItem(todoListItem),
      };
    }
    case 'error': {
      const errorItem = item as Extract<ThreadItem, { type: 'error' }>;
      return {
        id: errorItem.id ?? fallbackId,
        type: errorItem.type,
        summary: errorItem.message,
      };
    }
    default: {
      const futureItem = item as FutureCodexThreadItemCompat;
      return {
        id: futureItem.id ?? fallbackId,
        type: 'unknown',
        originalType: futureItem.type,
        ...(typeof futureItem.status === 'string'
          ? { status: futureItem.status }
          : {}),
        summary: describeFutureCodexThreadItem(futureItem),
      };
    }
  }
}

function runtimeProvenance(
  sdkEventType: RuntimeEventProvenance['sdkEventType'],
  threadId: string | null,
): RuntimeEventProvenance {
  return {
    producer: 'codex-runtime-driver',
    sdkEventType,
    threadId,
  };
}

function mapApprovalRequest(
  value: unknown,
): RuntimeApprovalRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'unknown', reason: 'approval requested by runtime driver' };
  }
  const record = value as Record<string, unknown>;
  const kindCandidate = record.kind;
  const kind: RuntimeApprovalRequest['kind'] =
    kindCandidate === 'command_execution' ||
    kindCandidate === 'mcp_tool_call' ||
    kindCandidate === 'web_search' ||
    kindCandidate === 'file_change'
      ? kindCandidate
      : 'unknown';
  return {
    kind,
    reason:
      typeof record.reason === 'string'
        ? record.reason
        : 'approval requested by runtime driver',
    ...(typeof record.command === 'string' ? { command: record.command } : {}),
    ...(typeof record.toolServer === 'string'
      ? { toolServer: record.toolServer }
      : {}),
    ...(typeof record.toolName === 'string' ? { toolName: record.toolName } : {}),
    ...(typeof record.workingDirectory === 'string'
      ? { workingDirectory: record.workingDirectory }
      : {}),
  };
}

function createVetoResult(
  veto: VetoPath,
  context: RuntimeExecutionContext,
  vetoSource?: VetoSource,
): RuntimeDriverResult {
  return {
    reason: veto.reason,
    provenance: veto.provenance,
    artifactLocation: context.plan.artifactLocation,
    // WU-V Phase 5 (closure): outcome retired — `cause` is the sole
    // terminal-state field on `RuntimeDriverResult`. Outcome derivation
    // happens at the agent-runtime boundary via `deriveOutcomeFromCause`
    // (which lifts `runtime-veto` to `'abort'` and synthesizes
    // `TerminalAbortInfo` via `deriveAbortInfoFromCause`).
    cause: {
      kind: 'runtime-veto',
      taskId: context.plan.taskId,
      runtimeInstanceId: context.instance.instanceId,
      observedAt: new Date().toISOString(),
      provenance: veto.provenance,
      reason: veto.reason,
      veto,
      ...(vetoSource === undefined ? {} : { vetoSource }),
      // omit cancellation — driver-level veto has no cancellation context
    },
  };
}

function isModelConfigurationFailureMessage(message: string): boolean {
  const m = message.toLowerCase();
  return [
    'model',
    'models',
    'unsupported_model',
    'unknown_model',
  ].some((needle) => m.includes(needle));
}

async function emitCodexModelFallbackEvent({
  context,
  error,
  primaryModel,
  fallbackModel,
}: {
  readonly context: RuntimeExecutionContext;
  readonly error: unknown;
  readonly primaryModel: string | undefined;
  readonly fallbackModel: string;
}): Promise<void> {
  const cause = extractCodexProviderFailureCause(error);
  const message =
    cause?.message ?? (error instanceof Error ? error.message : String(error));
  await context.emit({
    kind: 'item.failed',
    turnSequence: 1,
    item: {
      id: 'codex-model-fallback',
      type: 'error',
      summary: `primary Codex model ${primaryModel ?? '(global default)'} failed; retrying fallback model ${fallbackModel}`,
    },
    failure: {
      message,
      code: 'codex-model-fallback',
    },
    provenance: {
      producer: 'codex-runtime-driver',
      sdkEventType: 'item.failed',
      threadId: null,
    },
  });
}

function createAbortPoller(
  isAborted: () => boolean,
  controller: AbortController,
  pollIntervalMs: number,
): () => void {
  const timer = setInterval(() => {
    if (isAborted() && !controller.signal.aborted) {
      controller.abort();
    }
  }, pollIntervalMs);

  return () => {
    clearInterval(timer);
  };
}

export class CodexRuntimeDriver implements RuntimeDriver {
  private readonly sdk: CodexSdkLike;
  private readonly abortPollIntervalMs: number;
  private readonly admissionGate: AdmissionGate | undefined;
  private readonly bootstrapRuntimeConfig: CodexRuntimeConfigOverrides;
  private readonly settingsProvider: CodexSettingsProvider | undefined;

  constructor(options: CodexRuntimeDriverOptions = {}) {
    const defaultResolution =
      options.codexOptions === undefined
        ? readDefaultCodexResolution()
        : undefined;
    const codexOptions = options.codexOptions ?? defaultResolution?.options ?? {};
    this.bootstrapRuntimeConfig =
      options.codexRuntimeConfig ?? defaultResolution?.runtimeConfig ?? {};
    this.sdk =
      options.sdkFactory?.(codexOptions) ??
      new Codex(codexOptions);
    this.abortPollIntervalMs =
      options.abortPollIntervalMs ?? DEFAULT_ABORT_POLL_INTERVAL_MS;
    this.admissionGate = options.admissionGate;
    this.settingsProvider = options.settingsProvider;
  }

  /**
   * Resolve the effective per-dispatch runtime config by overlaying operator
   * overrides (if any) on top of the bootstrap config. Called once per
   * `run()` so `/config set` lands on the next dispatch without restart.
   * The Codex `modelFallback` is NEVER overridden — it stays bound to the
   * bootstrap config so model fallback semantics remain stable.
   */
  private resolveDispatchRuntimeConfig(): CodexRuntimeConfigOverrides {
    let snapshot: CodexSettingsSnapshot = {};
    try {
      snapshot = this.settingsProvider?.readSettings() ?? {};
    } catch {
      snapshot = {};
    }
    return {
      ...this.bootstrapRuntimeConfig,
      ...(snapshot.model !== undefined ? { model: snapshot.model } : {}),
      ...(snapshot.effort !== undefined
        ? { modelReasoningEffort: snapshot.effort }
        : {}),
    };
  }

  async run(context: RuntimeExecutionContext): Promise<RuntimeDriverResult> {
    const dispatchConfig = this.resolveDispatchRuntimeConfig();
    const primaryThreadOptions = buildThreadOptions(
      context.instance.runtimeSettings,
      dispatchConfig,
    );
    try {
      return await this.runOnce(context, primaryThreadOptions);
    } catch (error) {
      if (!this.shouldRetryWithModelFallback(error, dispatchConfig)) {
        throw error;
      }

      const fallbackModel = dispatchConfig.modelFallback;
      if (fallbackModel === undefined) {
        throw error;
      }

      await emitCodexModelFallbackEvent({
        context,
        error,
        primaryModel: dispatchConfig.model,
        fallbackModel,
      });

      return this.runOnce(
        context,
        buildThreadOptions(
          context.instance.runtimeSettings,
          dispatchConfig,
          fallbackModel,
        ),
      );
    }
  }

  private shouldRetryWithModelFallback(
    error: unknown,
    dispatchConfig: CodexRuntimeConfigOverrides,
  ): boolean {
    if (dispatchConfig.modelFallback === undefined) {
      return false;
    }
    const cause = extractCodexProviderFailureCause(error);
    if (cause?.classification !== 'permanent-config') {
      return false;
    }
    return isModelConfigurationFailureMessage(cause.message);
  }

  private async runOnce(
    context: RuntimeExecutionContext,
    threadOptions: ThreadOptions,
  ): Promise<RuntimeDriverResult> {
    if (context.isAborted()) {
      const abortReason = 'codex runtime aborted before turn start';
      return {
        reason: abortReason,
        provenance: 'codex-runtime-driver',
        artifactLocation: context.plan.artifactLocation,
        // WU-V Phase 5 (closure): outcome retired from the driver
        // contract. Pre-turn abort lacks a `VetoPath`, so we cannot
        // synthesize a `runtime-veto` cause here. Per §4 producer-column
        // layering, the driver may emit only `success`, `provider-failure`,
        // `timeout`, `runtime-veto`, or `external-cancel` causes; the
        // §6.12 F9 fallback (`provider-failure` with
        // `classification: 'unknown'`) is preserved as the degenerate
        // signal. No further change planned without a §4 amendment.
        cause: {
          kind: 'provider-failure',
          taskId: context.plan.taskId,
          runtimeInstanceId: context.instance.instanceId,
          observedAt: new Date().toISOString(),
          provenance: 'codex-runtime-driver',
          provider: 'codex',
          classification: 'unknown',
          retryable: false,
          message: abortReason,
        },
      };
    }

    const thread = this.sdk.startThread(threadOptions);
    const controller = new AbortController();
    const stopAbortPoller = createAbortPoller(
      () => context.isAborted(),
      controller,
      this.abortPollIntervalMs,
    );
    let latestAgentMessage = '';
    let observedItemActivity = false;
    let observedNonZeroUsage = false;
    let observedTurnActivity = false;
    let turnSequence = 0;

    try {
      // WU-L Step D — T2 `tool-invoke` chokepoint. Skipped entirely
      // when no gate is injected.
      if (this.admissionGate !== undefined) {
        const { decision, trace } =
          this.admissionGate.evaluateAndCaptureTrace({
            taskId: context.plan.taskId,
            trigger: 'T2_ChokepointCrossing',
            chokepoint: 'tool-invoke',
            attempt: 1,
            traits: [],
            metadata: { tool: 'codex.thread.runStreamed' },
          });
        if (decision.verdict === 'deny') {
          throw new AdmissionDeniedError(decision, trace);
        }
      }

      if (context.isAborted()) {
        controller.abort();
      }

      const streamedTurn = await thread.runStreamed(context.plan.instruction, {
        signal: controller.signal,
      });
      const streamedEvents = validateCodexResponse(
        streamedTurn,
        assertCodexStreamedTurn,
      ).events;

      for await (const rawEvent of streamedEvents) {
        const event = validateCodexResponse(rawEvent, assertCodexEventEnvelope);
        if (event.type === 'turn.failed') {
          const failedEvent = validateCodexResponse(event, assertTurnFailedEvent);
          throw new CodexProviderFailureError(
            failedEvent.error.message,
            'turn.failed',
          );
        }

        if (event.type === 'error') {
          const errorEvent = validateCodexResponse(event, assertThreadErrorEvent);
          throw new CodexProviderFailureError(errorEvent.message, 'error');
        }

        if (event.type === 'turn.started') {
          observedTurnActivity = true;
          turnSequence += 1;
          await context.emit({
            kind: 'turn.started',
            turnSequence,
            provenance: runtimeProvenance('turn.started', thread.id),
          });
          if (context.isAborted()) {
            controller.abort();
            break;
          }
          continue;
        }

        if (event.type === 'turn.completed') {
          const completedEvent = validateCodexResponse(
            event,
            assertTurnCompletedEvent,
          );
          observedTurnActivity = true;
          if (
            completedEvent.usage.input_tokens > 0 ||
            completedEvent.usage.cached_input_tokens > 0 ||
            completedEvent.usage.output_tokens > 0
          ) {
            observedNonZeroUsage = true;
          }
          await context.emit({
            kind: 'turn.completed',
            turnSequence: Math.max(1, turnSequence),
            usage: {
              inputTokens: completedEvent.usage.input_tokens,
              cachedInputTokens: completedEvent.usage.cached_input_tokens,
              outputTokens: completedEvent.usage.output_tokens,
            },
            provenance: runtimeProvenance('turn.completed', thread.id),
          });
          if (context.isAborted()) {
            controller.abort();
            break;
          }
          continue;
        }

        if (
          event.type === 'item.started' ||
          event.type === 'item.updated' ||
          event.type === 'item.completed'
        ) {
          const itemEvent = validateCodexResponse(event, assertItemLifecycleEvent);
          observedItemActivity = true;
          if (itemEvent.item.type === 'agent_message') {
            const agentMessageItem = validateCodexResponse(
              itemEvent.item,
              assertAgentMessageItem,
            );
            latestAgentMessage = agentMessageItem.text;
          }

          if (itemEvent.type === 'item.completed') {
            const completedItem = validateCodexResponse(
              itemEvent.item,
              assertThreadItemForNormalization,
            );
            await context.emit({
              kind: 'item.completed',
              turnSequence: Math.max(1, turnSequence),
              item: normalizeThreadItem(completedItem),
              provenance: runtimeProvenance('item.completed', thread.id),
            });
            if (context.isAborted()) {
              controller.abort();
              break;
            }
          }
        }

        if (event.type === 'item.failed') {
          const failedEvent = validateCodexResponse(event, assertItemFailedEvent);
          observedItemActivity = true;
          await context.emit({
            kind: 'item.failed',
            turnSequence: Math.max(1, turnSequence),
            item: normalizeThreadItem(failedEvent.item),
            failure: {
              message:
                typeof failedEvent.failure.message === 'string'
                  ? failedEvent.failure.message
                  : 'item failed',
              ...(typeof failedEvent.failure.code === 'string'
                ? { code: failedEvent.failure.code }
                : {}),
            },
            provenance: runtimeProvenance('item.failed', thread.id),
          });
          if (context.isAborted()) {
            controller.abort();
            break;
          }
        }

        if (event.type === 'approval.requested') {
          const approvalEvent = validateCodexResponse(
            event,
            assertApprovalRequestedEvent,
          );
          observedItemActivity = true;
          const decision = await context.requestApproval({
            request: mapApprovalRequest(approvalEvent.request),
            ...(typeof approvalEvent.deadline === 'string'
              ? { deadline: approvalEvent.deadline }
              : {}),
          });
          if (decision.status !== 'approved') {
            await context.emit({
              kind: 'item.failed',
              turnSequence: Math.max(1, turnSequence),
              item: {
                id: `approval-${Math.max(1, turnSequence)}`,
                type: 'command_execution',
                summary: 'approval-gated operation',
              },
              failure: {
                message:
                  decision.status === 'timeout'
                    ? 'approval request timed out'
                    : decision.reason,
                code: 'approval-rejected',
              },
              provenance: runtimeProvenance('item.failed', thread.id),
            });
            if (context.isAborted()) {
              controller.abort();
              break;
            }
          }
        }

        if (context.isAborted()) {
          controller.abort();
          break;
        }
      }
    } catch (error) {
      // WU-W Phase 2 — already-structured throws propagate verbatim.
      // CodexProviderFailureError carries a structured provider-failure
      // attachment built at the producer; CodexDriverFailureError is the
      // wrapper this branch produces (re-entry safety).
      if (
        error instanceof CodexProviderFailureError ||
        error instanceof CodexDriverFailureError
      ) {
        throw error;
      }
      if (error instanceof BoundaryValidationError) {
        throw translateBoundaryValidationError(error);
      }
      // AbortError is the downstream effect of external-cancel /
      // boundary-driven termination — the driver does not own it. Per
      // AC-W5(e) (external-cancel wins over driver-failure) and the
      // pre-existing veto-on-abort branch above, AbortError propagates
      // as-is so agent-runtime's `currentTerminalCause()` resolves the
      // authoritative cause from the cancellation boundary.
      if (isAbortError(error)) {
        throw error;
      }
      // WU-X — T2 admission denial materializes as a runtime-veto
      // outcome (NOT a driver failure). The dispatcher's T1 path
      // (src/core/dispatcher.ts) latches an admission-deny via
      // `createVetoPath('runtime', reason, 'admission-gate')` with
      // `vetoSource: 'admission'`. T2 mirrors that shape exactly so
      // T1 and T2 emit byte-identical veto provenance + vetoSource
      // for the same admission decision. Returns normally — does NOT
      // throw — because the driver completed its contract by
      // recognizing a gate veto and reporting it as a terminal cause.
      if (error instanceof AdmissionDeniedError) {
        const reason =
          error.decision.reason ??
          `Denied by rule '${error.decision.ruleId}'`;
        const veto = createVetoPath('runtime', reason, 'admission-gate');
        return createVetoResult(veto, context, 'admission');
      }
      const providerExitError = translateCodexExecExitError(error);
      if (providerExitError !== undefined) {
        throw providerExitError;
      }
      // Unstructured throw — wrap so agent-runtime trusts the
      // driver-originated cause instead of synthesizing one. See spec
      // §3 Phase 2 + §5 AC-W3, AC-W5(a/b/g/h).
      const driverFailureCause = buildDriverFailureFromError({
        error,
        taskId: context.plan.taskId,
        runtimeInstanceId: context.instance.instanceId,
        phase: 'codex-run',
        requestContext: {
          taskId: context.plan.taskId,
          phase: 'codex-run',
        },
      });
      const wrappedMessage =
        error instanceof Error ? error.message : String(error);
      throw new CodexDriverFailureError(wrappedMessage, driverFailureCause);
    } finally {
      stopAbortPoller();
    }

    if (context.isAborted()) {
      const abortError = new Error('runtime aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }

    if (
      latestAgentMessage.trim() === '' &&
      observedTurnActivity &&
      !observedItemActivity &&
      !observedNonZeroUsage
    ) {
      throw new CodexProviderFailureError(
        'streamed turn completed without observable assistant output, item activity, or token usage',
        'error',
        {
          classification: 'permanent-protocol',
          retryable: false,
        },
      );
    }

    const successReason =
      latestAgentMessage.trim() === ''
        ? DEFAULT_SUCCESS_REASON
        : latestAgentMessage.trim();
    return {
      reason: successReason,
      provenance: 'codex-runtime-driver',
      artifactLocation: context.plan.artifactLocation,
      // WU-V Phase 5 (closure): outcome retired — `cause` is the sole
      // terminal-state field. Outcome is derived at the agent-runtime
      // boundary via `deriveOutcomeFromCause`.
      cause: {
        kind: 'success',
        taskId: context.plan.taskId,
        runtimeInstanceId: context.instance.instanceId,
        observedAt: new Date().toISOString(),
        provenance: 'codex-runtime-driver',
        ...(context.plan.artifactLocation === undefined
          ? {}
          : { artifactLocation: context.plan.artifactLocation }),
      },
    };
  }
}
