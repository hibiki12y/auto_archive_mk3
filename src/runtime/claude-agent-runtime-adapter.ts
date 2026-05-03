/**
 * Claude Agent SDK runtime driver.
 *
 * Implements the `RuntimeDriver` port (`src/contracts/runtime-driver.ts`)
 * on top of `@anthropic-ai/claude-agent-sdk`'s `query()` entry point.
 * Enables a second LLM provider per
 * `specs/CLARIFICATIONS/multi-provider-scope.md`.
 *
 * Design parity with `CodexRuntimeDriver`:
 *   - Same `RuntimeDriver` port shape (`run(ctx) -> RuntimeDriverResult`)
 *   - Same lifecycle: each `run()` opens a single Claude Agent session,
 *     consumes its `AsyncGenerator<SDKMessage>`, emits structured runtime
 *     events into the `RuntimeExecutionContext`, and resolves on the
 *     final `SDKResultMessage`.
 *   - Same provider-failure cause taxonomy (WU-H §6.12 F1–F9) — Claude's
 *     `error_during_execution` / `error_max_turns` / `error_max_budget_usd`
 *     subtypes are classified into the shared 4-axis vocabulary.
 *   - Provenance label on every emitted event:
 *     `'claude-agent-runtime-driver'`.
 *
 * Boundaries:
 *   - SDK import is type-only at module load to keep tests free of the
 *     real `@anthropic-ai/claude-agent-sdk` peer dependency. The actual
 *     `query` callable is supplied at construction time via
 *     `ClaudeAgentRuntimeDriverOptions.queryFactory`. Production wiring
 *     binds it to the real package; tests bind synthetic stubs.
 *   - Plana approval is plumbed through the `canUseTool` callback so the
 *     same approval semantics surface as in the Codex driver.
 */

import type {
  ProviderFailureClassification,
  TerminalCauseDriverFailure,
  TerminalCauseProviderFailure,
} from '../contracts/terminal-cause.js';
import { buildDriverFailureFromError } from '../contracts/driver-failure-factory.js';
import type {
  RuntimeDriver,
  RuntimeDriverResult,
  RuntimeExecutionContext,
} from '../contracts/runtime-driver.js';

const DEFAULT_PROVENANCE = 'claude-agent-runtime-driver' as const;
const DEFAULT_SUCCESS_REASON = 'claude agent runtime completed';
const DEFAULT_ABORT_REASON = 'claude agent runtime aborted before turn start';

export const CLAUDE_AGENT_PROVIDER_LABEL = 'anthropic' as const;

/**
 * Subset of the Claude Agent SDK surface this adapter needs. Defining a
 * narrow interface here keeps the runtime/contracts layer decoupled from
 * the real package version and lets tests inject minimal stubs.
 *
 * See `https://code.claude.com/docs/en/agent-sdk/typescript`.
 */
export interface ClaudeAgentSDKMessage {
  readonly type: string;
  readonly subtype?: string;
  readonly session_id?: string;
  readonly uuid?: string;
  readonly message?: {
    readonly content?: ReadonlyArray<
      | { readonly type: 'text'; readonly text: string }
      | {
          readonly type: 'tool_use';
          readonly id: string;
          readonly name: string;
          readonly input?: Record<string, unknown>;
        }
      | { readonly type: string; readonly [key: string]: unknown }
    >;
  };
  readonly result?: string;
  readonly is_error?: boolean;
  readonly num_turns?: number;
  readonly stop_reason?: string | null;
  readonly total_cost_usd?: number;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly output_tokens?: number;
  };
  readonly modelUsage?: Record<string, unknown>;
  readonly permission_denials?: ReadonlyArray<unknown>;
  readonly error?: { readonly message?: string };
  readonly [key: string]: unknown;
}

export interface ClaudeAgentQueryHandle
  extends AsyncIterable<ClaudeAgentSDKMessage> {
  interrupt?(): Promise<void>;
}

export interface ClaudeAgentQueryArgs {
  readonly prompt: string;
  readonly options: ClaudeAgentQueryOptions;
}

export interface ClaudeAgentQueryOptions {
  readonly model?: string;
  readonly fallbackModel?: string;
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
  readonly cwd?: string;
  readonly permissionMode?:
    | 'default'
    | 'acceptEdits'
    | 'bypassPermissions'
    | 'plan'
    | 'dontAsk'
    | 'auto';
  readonly canUseTool?: ClaudeAgentCanUseTool;
  readonly abortController?: AbortController;
  readonly env?: Record<string, string | undefined>;
  readonly pathToClaudeCodeExecutable?: string;
  readonly systemPrompt?:
    | string
    | { readonly type: 'preset'; readonly preset: 'claude_code'; readonly append?: string; readonly excludeDynamicSections?: boolean };
  readonly thinking?:
    | { readonly type: 'disabled' }
    | { readonly type: 'enabled'; readonly budgetTokens?: number }
    | { readonly type: 'adaptive' }
    | { readonly type: 'extended'; readonly budgetTokens?: number };
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly includePartialMessages?: boolean;
  readonly extraArgs?: Record<string, string | null>;
}

export type ClaudeAgentCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  meta: { readonly toolUseID: string; readonly signal: AbortSignal },
) => Promise<
  | { readonly behavior: 'allow'; readonly updatedInput?: Record<string, unknown> }
  | { readonly behavior: 'deny'; readonly message: string }
>;

export type ClaudeAgentQueryFactory = (
  args: ClaudeAgentQueryArgs,
) => ClaudeAgentQueryHandle;

export interface ClaudeAgentRuntimeDriverOptions {
  /**
   * Production path: import `query` from `@anthropic-ai/claude-agent-sdk`
   * and pass it here adapted as `(args) => query(args)`. Tests pass a
   * synthetic factory that yields a programmed `SDKMessage` sequence.
   */
  readonly queryFactory: ClaudeAgentQueryFactory;
  readonly model?: string;
  readonly fallbackModel?: string;
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
  readonly pathToClaudeCodeExecutable?: string;
  readonly anthropicApiKey?: string;
  readonly extraEnv?: Record<string, string>;
  readonly systemPrompt?: ClaudeAgentQueryOptions['systemPrompt'];
  readonly thinking?: ClaudeAgentQueryOptions['thinking'];
  readonly permissionMode?: ClaudeAgentQueryOptions['permissionMode'];
}

export type ClaudeAgentProviderFailureCausePartial = Pick<
  TerminalCauseProviderFailure,
  'kind' | 'provider' | 'classification' | 'retryable' | 'message' | 'provenance'
>;

export class ClaudeAgentProviderFailureError extends Error {
  readonly providerFailureCause: ClaudeAgentProviderFailureCausePartial;

  constructor(
    message: string,
    classification: ProviderFailureClassification,
    retryable: boolean,
  ) {
    super(`claude-agent: ${message}`);
    this.name = 'ClaudeAgentProviderFailureError';
    this.providerFailureCause = {
      kind: 'provider-failure',
      provider: CLAUDE_AGENT_PROVIDER_LABEL,
      classification,
      retryable,
      message,
      provenance: DEFAULT_PROVENANCE,
    };
  }
}

export class ClaudeAgentDriverFailureError extends Error {
  constructor(
    message: string,
    public readonly driverFailureCause: TerminalCauseDriverFailure,
  ) {
    super(message);
    this.name = 'ClaudeAgentDriverFailureError';
  }
}

/**
 * Classify a Claude Agent error message into the shared §6.12 4-axis
 * provider-failure taxonomy. Uses the same most-specific-first ordering
 * as the Codex classifier so that hybrid signals (e.g. "429 quota") land
 * on the more-specific axis.
 */
export function classifyClaudeAgentMessage(
  rawMessage: string,
): { classification: ProviderFailureClassification; retryable: boolean } {
  const m = rawMessage.toLowerCase();
  const has = (needles: readonly string[]): boolean =>
    needles.some((n) => m.includes(n));

  if (has(['rate limit', 'rate-limit', 'too many requests', '429'])) {
    return { classification: 'rate-limit', retryable: true };
  }
  if (
    has([
      'quota',
      'insufficient_quota',
      'billing',
      'payment required',
      '402',
      'max budget',
      'budget exceeded',
    ])
  ) {
    return { classification: 'quota-exhausted', retryable: false };
  }
  if (
    has([
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
    return { classification: 'permanent-auth', retryable: false };
  }
  if (
    has([
      '400',
      'invalid model',
      'does not exist',
      'model not found',
      'model access',
      'not accessible',
      'not available',
      'unknown model',
      'unsupported model',
      'malformed',
      'invalid request',
      'bad request',
      'invalid parameter',
    ])
  ) {
    return { classification: 'permanent-config', retryable: false };
  }
  if (
    has([
      'unexpected event',
      'schema mismatch',
      'protocol error',
      'invalid response shape',
      'response shape',
      'unsupported sdk',
    ])
  ) {
    return { classification: 'permanent-protocol', retryable: false };
  }
  if (has(['sandbox', 'tool_call_timeout', 'tool-call timed out', 'tool call timed out'])) {
    return { classification: 'transient-tool', retryable: true };
  }
  if (
    has([
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
    return { classification: 'transient-server', retryable: true };
  }
  if (
    has([
      'econnreset',
      'econnrefused',
      'etimedout',
      'enotfound',
      'eai_again',
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
    ])
  ) {
    return { classification: 'transient-network', retryable: true };
  }
  return { classification: 'unknown', retryable: false };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function buildAbortBeforeStartResult(
  context: RuntimeExecutionContext,
): RuntimeDriverResult {
  return {
    reason: DEFAULT_ABORT_REASON,
    provenance: DEFAULT_PROVENANCE,
    artifactLocation: context.plan.artifactLocation,
    cause: {
      kind: 'provider-failure',
      taskId: context.plan.taskId,
      runtimeInstanceId: context.instance.instanceId,
      observedAt: new Date().toISOString(),
      provenance: DEFAULT_PROVENANCE,
      provider: CLAUDE_AGENT_PROVIDER_LABEL,
      classification: 'unknown',
      retryable: false,
      message: DEFAULT_ABORT_REASON,
    },
  };
}

function mapResultMessageToCause(
  message: ClaudeAgentSDKMessage,
  context: RuntimeExecutionContext,
): RuntimeDriverResult {
  const observedAt = new Date().toISOString();
  if (message.subtype === 'success') {
    return {
      reason:
        typeof message.result === 'string' && message.result.length > 0
          ? message.result.slice(0, 2000)
          : DEFAULT_SUCCESS_REASON,
      provenance: DEFAULT_PROVENANCE,
      artifactLocation: context.plan.artifactLocation,
      cause: {
        kind: 'success',
        taskId: context.plan.taskId,
        runtimeInstanceId: context.instance.instanceId,
        observedAt,
        provenance: DEFAULT_PROVENANCE,
        ...(context.plan.artifactLocation === undefined
          ? {}
          : { artifactLocation: context.plan.artifactLocation }),
      },
    };
  }

  // Non-success result subtypes are mapped to provider-failure causes.
  const rawMessage =
    message.error?.message ??
    (typeof message.result === 'string' && message.result.length > 0
      ? message.result
      : `claude-agent terminal subtype: ${String(message.subtype ?? 'unknown')}`);

  const heuristic = classifyClaudeAgentMessage(rawMessage);
  return {
    reason: rawMessage.slice(0, 2000),
    provenance: DEFAULT_PROVENANCE,
    artifactLocation: context.plan.artifactLocation,
    cause: {
      kind: 'provider-failure',
      taskId: context.plan.taskId,
      runtimeInstanceId: context.instance.instanceId,
      observedAt,
      provenance: DEFAULT_PROVENANCE,
      provider: CLAUDE_AGENT_PROVIDER_LABEL,
      classification: heuristic.classification,
      retryable: heuristic.retryable,
      message: rawMessage,
    },
  };
}

function mergedEnv(
  apiKey: string | undefined,
  extra: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  if (apiKey !== undefined && apiKey.length > 0) {
    merged.ANTHROPIC_API_KEY = apiKey;
  }
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value.length > 0) {
        merged[key] = value;
      }
    }
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

export class ClaudeAgentRuntimeDriver implements RuntimeDriver {
  private readonly queryFactory: ClaudeAgentQueryFactory;
  private readonly model: string | undefined;
  private readonly fallbackModel: string | undefined;
  private readonly effort: ClaudeAgentRuntimeDriverOptions['effort'];
  private readonly maxTurns: number | undefined;
  private readonly maxBudgetUsd: number | undefined;
  private readonly pathToClaudeCodeExecutable: string | undefined;
  private readonly anthropicApiKey: string | undefined;
  private readonly extraEnv: Record<string, string> | undefined;
  private readonly systemPrompt: ClaudeAgentQueryOptions['systemPrompt'];
  private readonly thinking: ClaudeAgentQueryOptions['thinking'];
  private readonly permissionMode: ClaudeAgentQueryOptions['permissionMode'];

  constructor(options: ClaudeAgentRuntimeDriverOptions) {
    if (typeof options.queryFactory !== 'function') {
      throw new TypeError(
        'ClaudeAgentRuntimeDriver requires a queryFactory.',
      );
    }
    this.queryFactory = options.queryFactory;
    this.model = options.model;
    this.fallbackModel = options.fallbackModel;
    this.effort = options.effort;
    this.maxTurns = options.maxTurns;
    this.maxBudgetUsd = options.maxBudgetUsd;
    this.pathToClaudeCodeExecutable = options.pathToClaudeCodeExecutable;
    this.anthropicApiKey = options.anthropicApiKey;
    this.extraEnv = options.extraEnv;
    this.systemPrompt = options.systemPrompt;
    this.thinking = options.thinking;
    this.permissionMode = options.permissionMode;
  }

  async run(context: RuntimeExecutionContext): Promise<RuntimeDriverResult> {
    if (context.isAborted()) {
      return buildAbortBeforeStartResult(context);
    }

    const abortController = new AbortController();
    const stopAbortPoller = createAbortPoller(
      () => context.isAborted(),
      abortController,
    );
    const env = mergedEnv(this.anthropicApiKey, this.extraEnv);

    const canUseTool: ClaudeAgentCanUseTool = async (
      toolName,
      input,
      { signal },
    ) => {
      try {
        const decision = await context.requestApproval({
          request: {
            kind: 'mcp_tool_call',
            reason: `claude agent requested tool ${toolName}`,
            toolName,
          },
        });
        if (decision.status === 'approved') {
          return { behavior: 'allow' };
        }
        const denyMessage =
          decision.status === 'rejected'
            ? decision.reason
            : decision.status === 'timeout'
              ? `approval timed out at ${decision.deadline}`
              : 'plana denied tool use';
        return {
          behavior: 'deny',
          message: denyMessage,
        };
      } catch (error) {
        if (signal.aborted) {
          return { behavior: 'deny', message: 'aborted before approval resolved' };
        }
        return {
          behavior: 'deny',
          message:
            error instanceof Error
              ? `approval hook failure: ${error.message}`
              : 'approval hook failure',
        };
      }
    };

    const queryOptions: ClaudeAgentQueryOptions = {
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(this.fallbackModel === undefined
        ? {}
        : { fallbackModel: this.fallbackModel }),
      ...(this.effort === undefined ? {} : { effort: this.effort }),
      ...(this.maxTurns === undefined ? {} : { maxTurns: this.maxTurns }),
      ...(this.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: this.maxBudgetUsd }),
      ...(this.pathToClaudeCodeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable }),
      ...(this.systemPrompt === undefined ? {} : { systemPrompt: this.systemPrompt }),
      ...(this.thinking === undefined ? {} : { thinking: this.thinking }),
      permissionMode: this.permissionMode ?? 'default',
      canUseTool,
      abortController,
      ...(env === undefined ? {} : { env }),
      ...(context.plan.runtimeSettings.workingDirectory === undefined
        ? {}
        : { cwd: context.plan.runtimeSettings.workingDirectory }),
    };

    let handle: ClaudeAgentQueryHandle;
    try {
      handle = this.queryFactory({
        prompt: context.plan.instruction,
        options: queryOptions,
      });
    } catch (error) {
      stopAbortPoller();
      throw new ClaudeAgentDriverFailureError(
        `claude-agent query factory failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        buildDriverFailureFromError({
          taskId: context.plan.taskId,
          runtimeInstanceId: context.instance.instanceId,
          phase: 'claude-agent.query-factory',
          error,
        }),
      );
    }

    let sessionId: string | null = null;
    let turnSequence = 0;
    let resultMessage: ClaudeAgentSDKMessage | undefined;

    try {
      for await (const message of handle) {
        if (context.isAborted()) {
          abortController.abort();
        }

        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = message.session_id ?? sessionId;
          continue;
        }

        if (message.type === 'assistant') {
          turnSequence += 1;
          await context.emit({
            kind: 'turn.started',
            turnSequence,
            provenance: {
              producer: DEFAULT_PROVENANCE,
              sdkEventType: 'turn.started',
              threadId: sessionId,
            },
          });
          const blocks = message.message?.content ?? [];
          for (const block of blocks) {
            if (block.type === 'text') {
              await context.emit({
                kind: 'item.completed',
                item: {
                  id: typeof message.uuid === 'string' ? message.uuid : 'agent_message',
                  type: 'agent_message',
                  summary: typeof block.text === 'string' ? block.text.slice(0, 1000) : '',
                },
                turnSequence,
                provenance: {
                  producer: DEFAULT_PROVENANCE,
                  sdkEventType: 'item.completed',
                  threadId: sessionId,
                },
              });
            } else if (block.type === 'tool_use') {
              const toolName =
                typeof block.name === 'string' ? block.name : 'unknown_tool';
              const toolInput =
                typeof block.input === 'object' && block.input !== null
                  ? (block.input as Record<string, unknown>)
                  : {};
              await context.emit({
                kind: 'tool-invocation',
                toolName,
                detail: shallowJsonDigest(toolInput),
              });
            }
          }
          continue;
        }

        if (message.type === 'result') {
          resultMessage = message;
          break;
        }
      }
    } catch (error) {
      stopAbortPoller();
      if (isAbortError(error)) {
        return buildAbortBeforeStartResult(context);
      }
      const message = error instanceof Error ? error.message : String(error);
      const heuristic = classifyClaudeAgentMessage(message);
      throw new ClaudeAgentProviderFailureError(
        message,
        heuristic.classification,
        heuristic.retryable,
      );
    } finally {
      stopAbortPoller();
    }

    if (resultMessage === undefined) {
      const reason = 'claude-agent stream ended without a result message';
      throw new ClaudeAgentProviderFailureError(reason, 'permanent-protocol', false);
    }

    return mapResultMessageToCause(resultMessage, context);
  }
}

function createAbortPoller(
  isAborted: () => boolean,
  controller: AbortController,
  intervalMs = 25,
): () => void {
  if (isAborted()) {
    controller.abort();
    return () => undefined;
  }
  const handle = setInterval(() => {
    if (isAborted()) {
      controller.abort();
      clearInterval(handle);
    }
  }, intervalMs);
  if (typeof handle.unref === 'function') {
    handle.unref();
  }
  return () => clearInterval(handle);
}

function shallowJsonDigest(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length <= 240 ? text : text.slice(0, 240) + '…';
  } catch {
    return '<unserializable>';
  }
}

/**
 * Production query factory backed by `@anthropic-ai/claude-agent-sdk`.
 *
 * Returns a synchronous `ClaudeAgentQueryFactory` that internally lazy-loads
 * the SDK on first invocation. The returned `ClaudeAgentQueryHandle` exposes
 * `[Symbol.asyncIterator]()` directly; the SDK call is deferred until that
 * iterator is consumed by the caller's `for await` loop.
 *
 * Bootstrap layers stay synchronous: only when the operator switches the
 * provider to `claude-agent` AND a dispatch actually starts is the dynamic
 * import paid. Build environments without the peer dependency continue to
 * function on the default `'codex'` path.
 */
export function createDefaultClaudeAgentQueryFactory(): ClaudeAgentQueryFactory {
  return (args: ClaudeAgentQueryArgs): ClaudeAgentQueryHandle => {
    const handlePromise = (async () => {
      const moduleId = '@anthropic-ai/claude-agent-sdk';
      const sdk = (await import(moduleId)) as {
        query?: (input: ClaudeAgentQueryArgs) => ClaudeAgentQueryHandle;
      };
      if (typeof sdk.query !== 'function') {
        throw new Error(
          'Claude Agent SDK module did not export query(); upgrade @anthropic-ai/claude-agent-sdk.',
        );
      }
      return sdk.query(args);
    })();

    return {
      async *[Symbol.asyncIterator]() {
        const handle = await handlePromise;
        for await (const message of handle) {
          yield message;
        }
      },
      async interrupt() {
        const handle = await handlePromise;
        if (typeof handle.interrupt === 'function') {
          await handle.interrupt();
        }
      },
    };
  };
}
