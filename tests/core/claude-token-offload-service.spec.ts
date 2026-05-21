import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createClaudeOffloadBundle } from '../../src/contracts/claude-token-offload.js';
import type {
  ClaudeOffloadGateway,
  ClaudeOffloadGatewayEnvelope,
  ClaudeOffloadGatewayRequest,
} from '../../src/contracts/claude-token-offload-gateway.js';
import { JsonlClaudeOffloadLedger } from '../../src/core/claude-token-offload-ledger.js';
import {
  runClaudeOffloadTurn,
  type ClaudeOffloadTurnTrace,
} from '../../src/core/claude-token-offload-service.js';

function makeBundle() {
  return createClaudeOffloadBundle({
    purpose: 'checkpoint-synthesis',
    sourceRefs: [
      'specs/ARCHIVE/midpoint-checkpoint-2026-05-05.md',
      'specs/ARCHIVE/live-proof-matrix.md',
    ],
    acceptanceChecks: ['no live-proof promotion from static evidence'],
    content: 'Summarize current static parity state.',
  });
}

function fakeGateway(
  envelope: ClaudeOffloadGatewayEnvelope,
  capture?: (req: ClaudeOffloadGatewayRequest) => void,
): ClaudeOffloadGateway {
  return {
    async consult(req) {
      capture?.(req);
      return envelope;
    },
  };
}

const FROZEN_NOW = '2026-05-05T22:30:00.000Z';
const FROZEN_ID = 'rec-frozen';

describe('core/claude-token-offload-service', () => {
  it('drives bundle → prompt → gateway → result on the happy path', async () => {
    const captured: ClaudeOffloadGatewayRequest[] = [];
    const gateway = fakeGateway(
      {
        status: 'ok',
        model: 'claude-opus-4-7',
        latencyMs: 700,
        costUsd: 0.003,
        tokenUsage: {
          inputTokens: 400,
          cachedInputTokens: 200,
          outputTokens: 250,
        },
        responseText: JSON.stringify({
          status: 'static parity substantially complete',
          findings: ['16 operator-gated rows remain'],
          blockingGaps: ['discord-service', 'gitlab-recording'],
          memoryCandidates: ['specs/ARCHIVE/live-proof-matrix.md'],
          residualRisk: 'live proof gates remain operator-owned',
        }),
      },
      (req) => captured.push(req),
    );

    const outcome = await runClaudeOffloadTurn(makeBundle(), {
      gateway,
      modelPreference: 'claude-opus-4-7',
      timeoutMs: 15_000,
      clock: () => FROZEN_NOW,
      idFactory: () => FROZEN_ID,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      purpose: 'checkpoint-synthesis',
      modelPreference: 'claude-opus-4-7',
      timeoutMs: 15_000,
    });
    expect(captured[0]?.prompt).toContain('You are a read-only Claude');

    expect(outcome.result.routeStatus).toBe('offload-route-ok');
    expect(outcome.result.errorCategory).toBe('none');
    expect(outcome.result.blockingGapCount).toBe(2);
    expect(outcome.result.memoryCandidateCount).toBe(1);

    expect(outcome.prompt.purpose).toBe('checkpoint-synthesis');
    expect(outcome.trace).toEqual({
      recordedAt: FROZEN_NOW,
      purpose: 'checkpoint-synthesis',
      routeStatus: 'offload-route-ok',
      errorCategory: 'none',
      model: 'claude-opus-4-7',
      latencyMs: 700,
      blockingGapCount: 2,
      memoryCandidateCount: 1,
    });
    expect(outcome.ledgerRecord).toBeUndefined();
  });

  it('appends a metadata-only ledger record when a ledger is supplied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-offload-svc-'));
    const ledger = new JsonlClaudeOffloadLedger(join(dir, 'ledger.jsonl'));
    const gateway = fakeGateway({
      status: 'ok',
      model: 'claude-opus-4-7',
      latencyMs: 800,
      tokenUsage: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 80 },
      responseText: JSON.stringify({
        status: 'ok',
        findings: [],
        blockingGaps: ['gap-a'],
        memoryCandidates: ['mem-a', 'mem-b'],
        residualRisk: 'low',
      }),
    });

    const outcome = await runClaudeOffloadTurn(makeBundle(), {
      gateway,
      ledger,
      clock: () => FROZEN_NOW,
      idFactory: () => FROZEN_ID,
    });

    expect(outcome.ledgerRecord).toMatchObject({
      recordId: FROZEN_ID,
      createdAt: FROZEN_NOW,
      purpose: 'checkpoint-synthesis',
      sourceRefCount: 2,
      acceptanceCheckCount: 1,
      routeStatus: 'offload-route-ok',
      blockingGapCount: 1,
      memoryCandidateCount: 2,
      provenance: 'claude-token-offload',
      decisionRole: 'advisory-only',
    });

    const replay = ledger.loadAll();
    expect(replay).toHaveLength(1);
    expect(replay[0].recordId).toBe(FROZEN_ID);
  });

  it('normalizes gateway error envelopes to WARN with stable category', async () => {
    const gateway = fakeGateway({
      status: 'error',
      errorCategory: 'quota-exhausted',
      errorMessage: 'gateway reported quota exhaustion',
      model: 'claude-opus-4-7',
    });

    const outcome = await runClaudeOffloadTurn(makeBundle(), { gateway });
    expect(outcome.result.routeStatus).toBe('offload-route-warn');
    expect(outcome.result.errorCategory).toBe('quota-exhausted');
    expect(outcome.result.degradedReason).toBe(
      'gateway reported quota exhaustion',
    );
    expect(outcome.result.sections).toBeUndefined();
    expect(outcome.trace.errorCategory).toBe('quota-exhausted');
  });

  it('flags tool-use requests as WARN tool-use-degraded', async () => {
    const gateway = fakeGateway({
      status: 'ok',
      toolUseRequested: true,
      responseText: JSON.stringify({ status: 'ignored' }),
    });

    const outcome = await runClaudeOffloadTurn(makeBundle(), { gateway });
    expect(outcome.result.routeStatus).toBe('offload-route-warn');
    expect(outcome.result.errorCategory).toBe('tool-use-degraded');
  });

  it('treats partial responses as WARN partial-result and persists counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-offload-svc-'));
    const ledger = new JsonlClaudeOffloadLedger(join(dir, 'ledger.jsonl'));
    const gateway = fakeGateway({
      status: 'ok',
      model: 'claude-opus-4-7',
      responseText: JSON.stringify({
        status: 'partial',
        findings: ['one'],
        // missing blockingGaps, memoryCandidates, residualRisk
      }),
    });

    const outcome = await runClaudeOffloadTurn(makeBundle(), {
      gateway,
      ledger,
      clock: () => FROZEN_NOW,
      idFactory: () => FROZEN_ID,
    });

    expect(outcome.result.routeStatus).toBe('offload-route-warn');
    expect(outcome.result.errorCategory).toBe('partial-result');
    expect(outcome.ledgerRecord?.errorCategory).toBe('partial-result');
    expect(outcome.ledgerRecord?.degradedReason).toMatch(
      /missing-sections:.*blockingGaps/,
    );
  });

  it('fails open with WARN unknown when the gateway throws', async () => {
    const gateway: ClaudeOffloadGateway = {
      async consult() {
        throw new Error('network exploded');
      },
    };

    const outcome = await runClaudeOffloadTurn(makeBundle(), { gateway });
    expect(outcome.result.routeStatus).toBe('offload-route-warn');
    expect(outcome.result.errorCategory).toBe('unknown');
    expect(outcome.result.degradedReason).toMatch(
      /gateway-threw:network exploded/,
    );
  });

  it('emits a single trace via onTurnObserved when configured', async () => {
    const observed: ClaudeOffloadTurnTrace[] = [];
    const gateway = fakeGateway({
      status: 'ok',
      model: 'claude-opus-4-7',
      latencyMs: 50,
      responseText: JSON.stringify({
        status: 'ok',
        findings: [],
        blockingGaps: [],
        memoryCandidates: [],
        residualRisk: 'none',
      }),
    });
    await runClaudeOffloadTurn(makeBundle(), {
      gateway,
      clock: () => FROZEN_NOW,
      onTurnObserved: (trace) => observed.push(trace),
    });
    expect(observed).toHaveLength(1);
    expect(observed[0].purpose).toBe('checkpoint-synthesis');
    expect(observed[0].routeStatus).toBe('offload-route-ok');
  });

  it('renders the prompt deterministically per purpose for the gateway', async () => {
    const captures: string[] = [];
    const gateway = fakeGateway(
      {
        status: 'ok',
        responseText: JSON.stringify({
          status: 'ok',
          findings: [],
          blockingGaps: [],
          memoryCandidates: [],
          residualRisk: 'none',
        }),
      },
      (req) => captures.push(req.prompt),
    );
    const a = await runClaudeOffloadTurn(makeBundle(), { gateway });
    const b = await runClaudeOffloadTurn(makeBundle(), { gateway });
    expect(captures[0]).toBe(captures[1]);
    expect(a.prompt.text).toBe(b.prompt.text);
  });

  it('does not append to the ledger when no ledger is configured', async () => {
    const ledgerAppend = vi.fn();
    const gateway = fakeGateway({
      status: 'ok',
      responseText: JSON.stringify({
        status: 'ok',
        findings: [],
        blockingGaps: [],
        memoryCandidates: [],
        residualRisk: 'none',
      }),
    });
    const outcome = await runClaudeOffloadTurn(makeBundle(), { gateway });
    expect(ledgerAppend).not.toHaveBeenCalled();
    expect(outcome.ledgerRecord).toBeUndefined();
  });
});
