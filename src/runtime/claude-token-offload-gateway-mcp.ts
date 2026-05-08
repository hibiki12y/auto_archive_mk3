/**
 * `ClaudeOffloadGatewayMcpAdapter` — MCP-backed implementation of the
 * `ClaudeOffloadGateway` port. Wraps the `claude-gateway` MCP server's
 * `claude_prompt` tool with offload-safe defaults and translates the
 * gateway envelope into the narrow `ClaudeOffloadGatewayEnvelope` shape
 * that the offload service consumes.
 *
 * Why this lives in `runtime/`:
 *   - `core/` defines the port (`ClaudeOffloadGateway`) and must stay
 *     transport-free per the hexagonal microkernel boundary.
 *   - The actual MCP plumbing (stdio frames, MCP client) is supplied by
 *     the host harness at construction time via an `invoker` callback,
 *     mirroring the `ClaudeAgentRuntimeDriver.queryFactory` injection
 *     pattern. Tests bind synthetic invokers; production wiring binds the
 *     real `claude_prompt` MCP tool call.
 *
 * Offload-safe defaults (per
 * `specs/CURRENT/claude-token-offload-implementation-plan-2026-05-05.md`):
 *   - `tool_mode: 'disabled'` — Claude must answer from the bundle alone;
 *     it is an advisor lens, not a tool-using agent.
 *   - `max_turns: 1` — single response. Tool-use turns are advisor-
 *     contract violations and surface as
 *     `errorCategory: 'tool-use-degraded'`.
 *   - `json_mode: true` — the offload prompt requires a JSON object with
 *     the five canonical sections, so the MCP attempts strict JSON
 *     parsing on the response.
 *
 * Error category mapping (claude-gateway → offload):
 *   - `tool_use_requested[_max_turns]` → toolUseRequested = true
 *     (the result-normalizer turns this into
 *     `errorCategory: 'tool-use-degraded'`).
 *   - `mcp_tool_call_timeout`, `timeout_exceeds_tool_host_limit` →
 *     `errorCategory: 'timeout'`.
 *   - `external_auth` → `'auth-failed'`.
 *   - `external_network` → `'network'`.
 *   - `external_service` (covers 429/503/quota/rate-limit) →
 *     `'quota-exhausted'`. The operator-visible meaning is "back off,
 *     retry later" in either case, so we collapse to the most actionable
 *     category.
 *   - `external_model_availability` → `'model-unavailable'`.
 *   - `max_turns_exhausted` → `'partial-result'`.
 *   - everything else (request, repo_config, local_cli, undetermined,
 *     unknown values) → `'unknown'`.
 *
 * The adapter does not retain raw prompts/responses. The MCP `response`
 * string is passed through as `responseText` for the normalizer to parse;
 * after normalization the orchestrator discards it.
 */

import type {
  ClaudeOffloadGateway,
  ClaudeOffloadGatewayRequest,
} from '../contracts/claude-token-offload-gateway.js';
import type {
  ClaudeOffloadErrorCategory,
  ClaudeOffloadGatewayEnvelope,
  ClaudeOffloadTokenUsage,
} from '../core/claude-token-offload-result.js';

export const CLAUDE_OFFLOAD_MCP_TOOL_MODE = 'disabled' as const;
export const CLAUDE_OFFLOAD_MCP_MAX_TURNS = 1 as const;
export const CLAUDE_OFFLOAD_MCP_JSON_MODE = true as const;
export const CLAUDE_OFFLOAD_MCP_DEFAULT_TIMEOUT_SECONDS = 120;
export const CLAUDE_OFFLOAD_MCP_MIN_TIMEOUT_SECONDS = 5;

export interface ClaudeGatewayMcpRequest {
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: string;
  readonly json_mode?: boolean;
  readonly timeout?: number;
  readonly max_turns?: number;
  readonly tool_mode?: string;
}

/**
 * Subset of the `claude-gateway` `claude_prompt` envelope this adapter
 * reads. Defining a narrow interface here keeps the adapter decoupled
 * from gateway-side schema evolution and lets tests inject minimal
 * stubs.
 */
export interface ClaudeGatewayMcpEnvelope {
  readonly success?: boolean;
  readonly response?: string | null;
  readonly model?: string | null;
  readonly tokens?: ClaudeGatewayMcpTokens | null;
  readonly latency_ms?: number | null;
  readonly cost_usd?: number | null;
  readonly error?: string | null;
  readonly error_category?: string | null;
  readonly routing_status?: string | null;
  readonly [extra: string]: unknown;
}

export interface ClaudeGatewayMcpTokens {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly [extra: string]: unknown;
}

export type ClaudeGatewayMcpInvoker = (
  request: ClaudeGatewayMcpRequest,
) => Promise<ClaudeGatewayMcpEnvelope>;

export interface ClaudeOffloadGatewayMcpAdapterOptions {
  /**
   * Production wiring binds this to the host MCP `claude_prompt` tool
   * call. Tests bind a deterministic fake.
   */
  readonly invoker: ClaudeGatewayMcpInvoker;
  readonly defaultModel?: string;
  readonly defaultEffort?: string;
  readonly defaultTimeoutSeconds?: number;
}

const ERROR_CATEGORY_MAP: ReadonlyMap<string, ClaudeOffloadErrorCategory> =
  new Map<string, ClaudeOffloadErrorCategory>([
    ['mcp_tool_call_timeout', 'timeout'],
    ['timeout_exceeds_tool_host_limit', 'timeout'],
    ['external_auth', 'auth-failed'],
    ['external_network', 'network'],
    ['external_service', 'quota-exhausted'],
    ['external_model_availability', 'model-unavailable'],
    ['max_turns_exhausted', 'partial-result'],
  ]);

const TOOL_USE_CATEGORIES: ReadonlySet<string> = new Set<string>([
  'tool_use_requested',
  'tool_use_requested_max_turns',
]);

function mapErrorCategory(raw: unknown): ClaudeOffloadErrorCategory {
  if (typeof raw !== 'string' || raw.length === 0) {
    return 'unknown';
  }
  const mapped = ERROR_CATEGORY_MAP.get(raw);
  return mapped ?? 'unknown';
}

function isToolUseCategory(raw: unknown): boolean {
  return typeof raw === 'string' && TOOL_USE_CATEGORIES.has(raw);
}

function safePositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function buildTokenUsage(
  tokens: ClaudeGatewayMcpTokens | null | undefined,
): Partial<ClaudeOffloadTokenUsage> | undefined {
  if (tokens === null || tokens === undefined) {
    return undefined;
  }
  // Anthropic billing semantics (preserved through the offload contract):
  //   - `input_tokens` are fresh tokens the model processed.
  //   - `cache_creation_input_tokens` are also processed-as-fresh by the
  //     model on this call; the cache write is a side effect. They count
  //     toward `inputTokens`, not toward `cachedInputTokens`.
  //   - `cache_read_input_tokens` are the actual cache hits — i.e. the
  //     tokens the operator saved on this call. They are the only ones
  //     mapped to `cachedInputTokens`.
  const freshInput = safePositiveNumber(tokens.input_tokens) ?? 0;
  const cacheWrite = safePositiveNumber(tokens.cache_creation_input_tokens) ?? 0;
  const inputTokens = freshInput + cacheWrite;
  const cachedInputTokens = safePositiveNumber(tokens.cache_read_input_tokens) ?? 0;
  const outputTokens = safePositiveNumber(tokens.output_tokens) ?? 0;
  if (inputTokens === 0 && outputTokens === 0 && cachedInputTokens === 0) {
    return undefined;
  }
  return { inputTokens, cachedInputTokens, outputTokens };
}

function clampTimeoutSeconds(
  timeoutMs: number | undefined,
  fallback: number,
): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fallback;
  }
  const seconds = Math.ceil(timeoutMs / 1000);
  return seconds < CLAUDE_OFFLOAD_MCP_MIN_TIMEOUT_SECONDS
    ? CLAUDE_OFFLOAD_MCP_MIN_TIMEOUT_SECONDS
    : seconds;
}

export class ClaudeOffloadGatewayMcpAdapter implements ClaudeOffloadGateway {
  private readonly invoker: ClaudeGatewayMcpInvoker;
  private readonly defaultModel: string | undefined;
  private readonly defaultEffort: string | undefined;
  private readonly defaultTimeoutSeconds: number;

  constructor(options: ClaudeOffloadGatewayMcpAdapterOptions) {
    if (typeof options.invoker !== 'function') {
      throw new TypeError(
        'ClaudeOffloadGatewayMcpAdapter requires an invoker callback.',
      );
    }
    this.invoker = options.invoker;
    this.defaultModel = options.defaultModel;
    this.defaultEffort = options.defaultEffort;
    this.defaultTimeoutSeconds =
      options.defaultTimeoutSeconds !== undefined &&
      options.defaultTimeoutSeconds >= CLAUDE_OFFLOAD_MCP_MIN_TIMEOUT_SECONDS
        ? options.defaultTimeoutSeconds
        : CLAUDE_OFFLOAD_MCP_DEFAULT_TIMEOUT_SECONDS;
  }

  async consult(
    request: ClaudeOffloadGatewayRequest,
  ): Promise<ClaudeOffloadGatewayEnvelope> {
    const model = request.modelPreference ?? this.defaultModel;
    const timeoutSeconds = clampTimeoutSeconds(
      request.timeoutMs,
      this.defaultTimeoutSeconds,
    );

    const mcpRequest: ClaudeGatewayMcpRequest = {
      prompt: request.prompt,
      json_mode: CLAUDE_OFFLOAD_MCP_JSON_MODE,
      tool_mode: CLAUDE_OFFLOAD_MCP_TOOL_MODE,
      max_turns: CLAUDE_OFFLOAD_MCP_MAX_TURNS,
      timeout: timeoutSeconds,
      ...(model === undefined ? {} : { model }),
      ...(this.defaultEffort === undefined ? {} : { effort: this.defaultEffort }),
    };

    const raw = await this.invoker(mcpRequest);
    return translateEnvelope(raw);
  }
}

/**
 * Pure mapping from the claude-gateway MCP envelope to the offload port
 * envelope. Exposed so the orchestrator/tests can verify mapping in
 * isolation.
 */
export function translateEnvelope(
  raw: ClaudeGatewayMcpEnvelope,
): ClaudeOffloadGatewayEnvelope {
  const model = typeof raw.model === 'string' && raw.model.length > 0
    ? raw.model
    : undefined;
  const latencyMs = safePositiveNumber(raw.latency_ms);
  const costUsd = safePositiveNumber(raw.cost_usd);
  const tokenUsage = buildTokenUsage(raw.tokens ?? undefined);

  if (raw.success === true && !isToolUseCategory(raw.error_category)) {
    const responseText = typeof raw.response === 'string' ? raw.response : undefined;
    return {
      status: 'ok',
      ...(model === undefined ? {} : { model }),
      ...(latencyMs === undefined ? {} : { latencyMs }),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
      ...(responseText === undefined ? {} : { responseText }),
    };
  }

  if (isToolUseCategory(raw.error_category)) {
    return {
      status: 'ok',
      toolUseRequested: true,
      ...(model === undefined ? {} : { model }),
      ...(latencyMs === undefined ? {} : { latencyMs }),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
    };
  }

  const errorCategory = mapErrorCategory(raw.error_category);
  const errorMessage = typeof raw.error === 'string' && raw.error.length > 0
    ? raw.error
    : undefined;

  return {
    status: 'error',
    errorCategory,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(model === undefined ? {} : { model }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  };
}
