import { describe, expect, it } from 'vitest';

import type { ClaudeOffloadGatewayRequest } from '../../src/contracts/claude-token-offload-gateway.js';
import {
  CLAUDE_OFFLOAD_MCP_DEFAULT_TIMEOUT_SECONDS,
  CLAUDE_OFFLOAD_MCP_JSON_MODE,
  CLAUDE_OFFLOAD_MCP_MAX_TURNS,
  CLAUDE_OFFLOAD_MCP_MIN_TIMEOUT_SECONDS,
  CLAUDE_OFFLOAD_MCP_TOOL_MODE,
  ClaudeOffloadGatewayMcpAdapter,
  translateEnvelope,
  type ClaudeGatewayMcpEnvelope,
  type ClaudeGatewayMcpInvoker,
  type ClaudeGatewayMcpRequest,
} from '../../src/runtime/claude-token-offload-gateway-mcp.js';

function makeRequest(
  overrides: Partial<ClaudeOffloadGatewayRequest> = {},
): ClaudeOffloadGatewayRequest {
  return {
    prompt: 'PROMPT_BODY',
    purpose: 'checkpoint-synthesis',
    ...overrides,
  };
}

function captureInvoker(envelope: ClaudeGatewayMcpEnvelope): {
  invoker: ClaudeGatewayMcpInvoker;
  calls: ClaudeGatewayMcpRequest[];
} {
  const calls: ClaudeGatewayMcpRequest[] = [];
  const invoker: ClaudeGatewayMcpInvoker = async (request) => {
    calls.push(request);
    return envelope;
  };
  return { invoker, calls };
}

describe('runtime/claude-token-offload-gateway-mcp', () => {
  describe('ClaudeOffloadGatewayMcpAdapter', () => {
    it('rejects construction without an invoker', () => {
      expect(
        () =>
          new ClaudeOffloadGatewayMcpAdapter({
            // @ts-expect-error intentional bad input
            invoker: undefined,
          }),
      ).toThrow(/requires an invoker/);
    });

    it('sends offload-safe defaults to the MCP', async () => {
      const { invoker, calls } = captureInvoker({
        success: true,
        response: '{"status":["ok"]}',
        model: 'claude-opus-4-7',
        latency_ms: 412,
        tokens: { input_tokens: 100, output_tokens: 80 },
      });
      const adapter = new ClaudeOffloadGatewayMcpAdapter({ invoker });
      await adapter.consult(makeRequest());
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        prompt: 'PROMPT_BODY',
        json_mode: CLAUDE_OFFLOAD_MCP_JSON_MODE,
        tool_mode: CLAUDE_OFFLOAD_MCP_TOOL_MODE,
        max_turns: CLAUDE_OFFLOAD_MCP_MAX_TURNS,
        timeout: CLAUDE_OFFLOAD_MCP_DEFAULT_TIMEOUT_SECONDS,
      });
    });

    it('forwards modelPreference and bound default effort', async () => {
      const { invoker, calls } = captureInvoker({ success: true, response: '' });
      const adapter = new ClaudeOffloadGatewayMcpAdapter({
        invoker,
        defaultModel: 'claude-sonnet-4-6',
        defaultEffort: 'medium',
      });
      await adapter.consult(makeRequest({ modelPreference: 'claude-opus-4-7' }));
      expect(calls[0]?.model).toBe('claude-opus-4-7');
      expect(calls[0]?.effort).toBe('medium');
    });

    it('uses defaultModel when no modelPreference is provided', async () => {
      const { invoker, calls } = captureInvoker({ success: true, response: '' });
      const adapter = new ClaudeOffloadGatewayMcpAdapter({
        invoker,
        defaultModel: 'claude-sonnet-4-6',
      });
      await adapter.consult(makeRequest());
      expect(calls[0]?.model).toBe('claude-sonnet-4-6');
    });

    it('clamps timeoutMs to seconds and to the minimum floor', async () => {
      const { invoker, calls } = captureInvoker({ success: true, response: '' });
      const adapter = new ClaudeOffloadGatewayMcpAdapter({ invoker });

      await adapter.consult(makeRequest({ timeoutMs: 30_000 }));
      expect(calls.at(-1)?.timeout).toBe(30);

      // 1.5s rounds up to 2, but the floor is 5
      await adapter.consult(makeRequest({ timeoutMs: 1500 }));
      expect(calls.at(-1)?.timeout).toBe(CLAUDE_OFFLOAD_MCP_MIN_TIMEOUT_SECONDS);

      // negative / zero / NaN fall back to default
      await adapter.consult(makeRequest({ timeoutMs: 0 }));
      expect(calls.at(-1)?.timeout).toBe(CLAUDE_OFFLOAD_MCP_DEFAULT_TIMEOUT_SECONDS);
    });

    it('translates a success envelope into status: ok with response and metadata', async () => {
      const { invoker } = captureInvoker({
        success: true,
        response: '{"status":["ok"]}',
        model: 'claude-opus-4-7',
        latency_ms: 800,
        cost_usd: 0.01,
        tokens: {
          input_tokens: 200,
          output_tokens: 90,
          cache_read_input_tokens: 50,
        },
      });
      const adapter = new ClaudeOffloadGatewayMcpAdapter({ invoker });
      const envelope = await adapter.consult(makeRequest());
      expect(envelope.status).toBe('ok');
      expect(envelope.responseText).toBe('{"status":["ok"]}');
      expect(envelope.model).toBe('claude-opus-4-7');
      expect(envelope.latencyMs).toBe(800);
      expect(envelope.costUsd).toBe(0.01);
      expect(envelope.tokenUsage).toEqual({
        inputTokens: 200,
        outputTokens: 90,
        cachedInputTokens: 50,
      });
      expect(envelope.toolUseRequested).toBeUndefined();
    });

    it('counts cache_creation_input_tokens as fresh inputTokens, not cachedInputTokens', () => {
      const envelope = translateEnvelope({
        success: true,
        response: '{}',
        tokens: {
          input_tokens: 100,
          cache_creation_input_tokens: 60,
          cache_read_input_tokens: 40,
          output_tokens: 20,
        },
      });
      // Fresh-input semantics: cache_creation tokens are processed-as-fresh
      // on this call, so inputTokens = 100 + 60 = 160. Only cache_read is
      // a real cache hit, so cachedInputTokens = 40.
      expect(envelope.tokenUsage).toEqual({
        inputTokens: 160,
        cachedInputTokens: 40,
        outputTokens: 20,
      });
    });
  });

  describe('translateEnvelope', () => {
    it('flags tool_use_requested as toolUseRequested with status ok', () => {
      const envelope = translateEnvelope({
        success: false,
        error: 'Claude requested tool use before producing a final answer.',
        error_category: 'tool_use_requested',
        model: 'claude-opus-4-7',
      });
      expect(envelope.status).toBe('ok');
      expect(envelope.toolUseRequested).toBe(true);
      // tool-use degradation does not stamp errorCategory at the port
      // layer — the result-normalizer assigns 'tool-use-degraded'.
      expect(envelope.errorCategory).toBeUndefined();
    });

    it('flags tool_use_requested_max_turns the same way', () => {
      const envelope = translateEnvelope({
        success: false,
        error: 'tool use + max_turns',
        error_category: 'tool_use_requested_max_turns',
      });
      expect(envelope.status).toBe('ok');
      expect(envelope.toolUseRequested).toBe(true);
    });

    it('maps timeout categories to errorCategory: timeout', () => {
      expect(
        translateEnvelope({ success: false, error: 't', error_category: 'mcp_tool_call_timeout' }),
      ).toMatchObject({ status: 'error', errorCategory: 'timeout' });
      expect(
        translateEnvelope({
          success: false,
          error: 't',
          error_category: 'timeout_exceeds_tool_host_limit',
        }),
      ).toMatchObject({ status: 'error', errorCategory: 'timeout' });
    });

    it('maps the four external_* categories', () => {
      expect(
        translateEnvelope({ success: false, error: 'a', error_category: 'external_auth' }),
      ).toMatchObject({ errorCategory: 'auth-failed' });
      expect(
        translateEnvelope({ success: false, error: 'a', error_category: 'external_network' }),
      ).toMatchObject({ errorCategory: 'network' });
      expect(
        translateEnvelope({ success: false, error: 'a', error_category: 'external_service' }),
      ).toMatchObject({ errorCategory: 'quota-exhausted' });
      expect(
        translateEnvelope({
          success: false,
          error: 'a',
          error_category: 'external_model_availability',
        }),
      ).toMatchObject({ errorCategory: 'model-unavailable' });
    });

    it('maps max_turns_exhausted to partial-result', () => {
      const envelope = translateEnvelope({
        success: false,
        error: 'max',
        error_category: 'max_turns_exhausted',
      });
      expect(envelope.status).toBe('error');
      expect(envelope.errorCategory).toBe('partial-result');
    });

    it('falls back to unknown for unmapped or missing categories', () => {
      expect(
        translateEnvelope({ success: false, error: 'x', error_category: 'undetermined' }),
      ).toMatchObject({ errorCategory: 'unknown' });
      expect(
        translateEnvelope({ success: false, error: 'x', error_category: 'made-up-category' }),
      ).toMatchObject({ errorCategory: 'unknown' });
      expect(translateEnvelope({ success: false, error: 'x' })).toMatchObject({
        errorCategory: 'unknown',
      });
    });

    it('preserves errorMessage as-is for the normalizer to scrub', () => {
      const envelope = translateEnvelope({
        success: false,
        error: 'auth_request: invalid api key (token sk-...)',
        error_category: 'external_auth',
      });
      expect(envelope.errorMessage).toBe(
        'auth_request: invalid api key (token sk-...)',
      );
    });

    it('omits tokenUsage when all token fields are zero/missing', () => {
      const envelope = translateEnvelope({
        success: true,
        response: '{}',
        tokens: { input_tokens: 0, output_tokens: 0 },
      });
      expect(envelope.tokenUsage).toBeUndefined();
    });

    it('treats unknown error_category as error (not tool-use)', () => {
      const envelope = translateEnvelope({
        success: false,
        error: 'oops',
        error_category: 'request',
      });
      expect(envelope.status).toBe('error');
      expect(envelope.toolUseRequested).toBeUndefined();
    });
  });
});
