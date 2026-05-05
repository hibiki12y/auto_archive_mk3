import { describe, expect, it } from 'vitest';

import {
  CLAUDE_OFFLOAD_RESULT_SCHEMA_VERSION,
  normalizeClaudeOffloadResult,
  type ClaudeOffloadGatewayEnvelope,
} from '../../src/core/claude-token-offload-result.js';

const PURPOSE = 'checkpoint-synthesis' as const;

function envelopeOK(
  responseObject: Record<string, unknown>,
  overrides: Partial<ClaudeOffloadGatewayEnvelope> = {},
): ClaudeOffloadGatewayEnvelope {
  return {
    status: 'ok',
    model: 'claude-opus-4-7',
    latencyMs: 1234,
    costUsd: 0.012,
    tokenUsage: {
      inputTokens: 800,
      cachedInputTokens: 400,
      outputTokens: 600,
    },
    responseText: JSON.stringify(responseObject),
    ...overrides,
  };
}

describe('core/claude-token-offload-result', () => {
  it('normalizes a fully-shaped success response into OK', () => {
    const envelope = envelopeOK({
      status: 'static parity substantially complete',
      findings: ['16 operator-gated rows remain'],
      blockingGaps: ['discord-service live proof', 'gitlab-recording proof'],
      memoryCandidates: [
        'specs/CURRENT/midpoint-checkpoint-2026-05-05.md',
      ],
      residualRisk: 'live proof gates remain operator-owned',
    });

    const result = normalizeClaudeOffloadResult(envelope, { purpose: PURPOSE });

    expect(result.schemaVersion).toBe(CLAUDE_OFFLOAD_RESULT_SCHEMA_VERSION);
    expect(result.routeStatus).toBe('offload-route-ok');
    expect(result.errorCategory).toBe('none');
    expect(result.model).toBe('claude-opus-4-7');
    expect(result.latencyMs).toBe(1234);
    expect(result.costUsd).toBe(0.012);
    expect(result.tokenUsage).toEqual({
      inputTokens: 800,
      cachedInputTokens: 400,
      outputTokens: 600,
    });
    expect(result.sections?.status).toEqual([
      'static parity substantially complete',
    ]);
    expect(result.blockingGapCount).toBe(2);
    expect(result.memoryCandidateCount).toBe(1);
  });

  it('marks quota / auth / model errors as WARN with stable category', () => {
    for (const errorCategory of [
      'quota-exhausted',
      'auth-failed',
      'model-unavailable',
      'timeout',
      'network',
    ] as const) {
      const result = normalizeClaudeOffloadResult(
        {
          status: 'error',
          errorCategory,
          errorMessage: `gateway reported ${errorCategory}`,
          model: 'claude-opus-4-7',
        },
        { purpose: PURPOSE },
      );
      expect(result.routeStatus).toBe('offload-route-warn');
      expect(result.errorCategory).toBe(errorCategory);
      expect(result.degradedReason).toBe(`gateway reported ${errorCategory}`);
      expect(result.sections).toBeUndefined();
    }
  });

  it('flags tool-use requests as WARN tool-use-degraded', () => {
    const result = normalizeClaudeOffloadResult(
      {
        status: 'ok',
        toolUseRequested: true,
        responseText: JSON.stringify({ status: 'whatever' }),
      },
      { purpose: PURPOSE },
    );
    expect(result.routeStatus).toBe('offload-route-warn');
    expect(result.errorCategory).toBe('tool-use-degraded');
    expect(result.sections).toBeUndefined();
  });

  it('flags non-JSON or non-object responses as parse-failure', () => {
    const nonJson = normalizeClaudeOffloadResult(
      { status: 'ok', responseText: 'plain text reply' },
      { purpose: PURPOSE },
    );
    expect(nonJson.routeStatus).toBe('offload-route-warn');
    expect(nonJson.errorCategory).toBe('parse-failure');
    expect(nonJson.degradedReason).toBe('non-json-response');

    const nonObject = normalizeClaudeOffloadResult(
      { status: 'ok', responseText: '"just a string"' },
      { purpose: PURPOSE },
    );
    expect(nonObject.errorCategory).toBe('parse-failure');
    expect(nonObject.degradedReason).toBe('response-not-object');

    const empty = normalizeClaudeOffloadResult(
      { status: 'ok', responseText: '' },
      { purpose: PURPOSE },
    );
    expect(empty.errorCategory).toBe('parse-failure');
    expect(empty.degradedReason).toBe('empty-response');
  });

  it('strips ```json fences before parsing the response object', () => {
    const inner = JSON.stringify({
      status: ['ok'],
      findings: [],
      blockingGaps: [],
      memoryCandidates: [],
      residualRisk: [],
    });
    const fenced = `\`\`\`json\n${inner}\n\`\`\``;
    const result = normalizeClaudeOffloadResult(
      { status: 'ok', responseText: fenced },
      { purpose: PURPOSE },
    );
    expect(result.routeStatus).toBe('offload-route-ok');
    expect(result.errorCategory).toBe('none');
    expect(result.sections?.status).toEqual(['ok']);
  });

  it('strips bare ``` fences (no language tag) before parsing', () => {
    const inner = JSON.stringify({
      status: ['ok'],
      findings: [],
      blockingGaps: [],
      memoryCandidates: [],
      residualRisk: [],
    });
    const fenced = `\`\`\`\n${inner}\n\`\`\``;
    const result = normalizeClaudeOffloadResult(
      { status: 'ok', responseText: fenced },
      { purpose: PURPOSE },
    );
    expect(result.routeStatus).toBe('offload-route-ok');
  });

  it('extracts a single top-level {...} region when prose surrounds it', () => {
    const inner = JSON.stringify({
      status: ['ok'],
      findings: [],
      blockingGaps: [],
      memoryCandidates: [],
      residualRisk: [],
    });
    const wrapped = `Here is my response:\n\n${inner}\n\nLet me know if you need anything else.`;
    const result = normalizeClaudeOffloadResult(
      { status: 'ok', responseText: wrapped },
      { purpose: PURPOSE },
    );
    expect(result.routeStatus).toBe('offload-route-ok');
    expect(result.errorCategory).toBe('none');
  });

  it('still rejects banned keys after fence stripping', () => {
    const inner = JSON.stringify({
      status: ['leaked'],
      findings: [],
      blockingGaps: [],
      memoryCandidates: [],
      residualRisk: [],
      rawPrompt: 'should not survive',
    });
    const fenced = `\`\`\`json\n${inner}\n\`\`\``;
    const result = normalizeClaudeOffloadResult(
      { status: 'ok', responseText: fenced },
      { purpose: PURPOSE },
    );
    expect(result.routeStatus).toBe('offload-route-warn');
    expect(result.errorCategory).toBe('parse-failure');
    expect(result.degradedReason).toBe('response-contains-banned-key');
  });

  it('flags partial responses as WARN partial-result and lists missing sections', () => {
    const result = normalizeClaudeOffloadResult(
      envelopeOK({
        status: 'ok',
        findings: ['ok'],
        // blockingGaps, memoryCandidates, residualRisk missing
      }),
      { purpose: PURPOSE },
    );
    expect(result.routeStatus).toBe('offload-route-warn');
    expect(result.errorCategory).toBe('partial-result');
    expect(result.degradedReason).toMatch(
      /missing-sections:.*blockingGaps.*memoryCandidates.*residualRisk/,
    );
    expect(result.sections?.status).toEqual(['ok']);
    expect(result.blockingGapCount).toBe(0);
  });

  it('rejects a response that contains a banned key as parse-failure', () => {
    const result = normalizeClaudeOffloadResult(
      envelopeOK({
        status: 'leaked',
        findings: [],
        blockingGaps: [],
        memoryCandidates: [],
        residualRisk: '',
        secret: 'oops',
      }),
      { purpose: PURPOSE },
    );
    expect(result.routeStatus).toBe('offload-route-warn');
    expect(result.errorCategory).toBe('parse-failure');
    expect(result.degradedReason).toBe('response-contains-banned-key');
  });

  it('coerces single-string section values into a one-element array', () => {
    const result = normalizeClaudeOffloadResult(
      envelopeOK({
        status: 'ok',
        findings: 'one finding',
        blockingGaps: [],
        memoryCandidates: [],
        residualRisk: 'low',
      }),
      { purpose: PURPOSE },
    );
    expect(result.routeStatus).toBe('offload-route-ok');
    expect(result.sections?.findings).toEqual(['one finding']);
    expect(result.sections?.residualRisk).toEqual(['low']);
  });

  it('rejects non-string array entries as missing sections', () => {
    const result = normalizeClaudeOffloadResult(
      envelopeOK({
        status: 'ok',
        findings: [1, 2, 3],
        blockingGaps: [],
        memoryCandidates: [],
        residualRisk: 'low',
      }),
      { purpose: PURPOSE },
    );
    expect(result.routeStatus).toBe('offload-route-warn');
    expect(result.errorCategory).toBe('partial-result');
    expect(result.degradedReason).toMatch(/findings/);
  });

  it('drops zero-only token usage rather than retaining a sentinel record', () => {
    const result = normalizeClaudeOffloadResult(
      {
        status: 'ok',
        responseText: JSON.stringify({
          status: 'ok',
          findings: [],
          blockingGaps: [],
          memoryCandidates: [],
          residualRisk: 'none',
        }),
        tokenUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      },
      { purpose: PURPOSE },
    );
    expect(result.tokenUsage).toBeUndefined();
  });
});
