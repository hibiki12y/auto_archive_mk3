/**
 * `runClaudeOffloadTurn` — orchestrator for one Claude offload turn.
 *
 * Wires the four building blocks defined by the
 * `claude-token-offload-implementation-plan-2026-05-05.md` into a single
 * advisor-only call:
 *
 *     bundle ─▶ buildClaudeOffloadPrompt ─▶ gateway.consult
 *                                              │
 *                                              ▼
 *               normalizeClaudeOffloadResult ─▶ ledger.append (optional)
 *                                              │
 *                                              ▼
 *                                  return ServiceOutcome
 *
 * Invariants:
 *   - The orchestrator does **not** write files, mutate memory, or make
 *     decisions. Codex remains the sole writer/decider.
 *   - The gateway port is the only side-effect surface. If the gateway
 *     throws, the orchestrator fails open with a `WARN unknown` result —
 *     a Claude advisor outage must never stall the parent.
 *   - The ledger append (when configured) carries metadata only; the
 *     ledger itself enforces banned-key filtering and the metadata-only
 *     projection.
 *   - The raw response text from the gateway is discarded after
 *     normalization; only the structured `sections` make it into the
 *     in-process result, and only counts make it into the ledger record.
 */

import { randomUUID } from 'node:crypto';

import type { ClaudeOffloadBundle } from '../contracts/claude-token-offload.js';
import type {
  ClaudeOffloadGateway,
  ClaudeOffloadGatewayRequest,
} from '../contracts/claude-token-offload-gateway.js';
import {
  buildClaudeOffloadPrompt,
  type ClaudeOffloadPrompt,
} from './claude-token-offload.js';
import {
  normalizeClaudeOffloadResult,
  type ClaudeOffloadGatewayEnvelope,
  type ClaudeOffloadResult,
} from './claude-token-offload-result.js';
import {
  type ClaudeOffloadLedger,
  type ClaudeOffloadLedgerRecord,
} from './claude-token-offload-ledger.js';

export interface ClaudeOffloadServiceOptions {
  readonly gateway: ClaudeOffloadGateway;
  readonly ledger?: ClaudeOffloadLedger;
  readonly modelPreference?: string;
  readonly timeoutMs?: number;
  readonly clock?: () => string;
  readonly idFactory?: () => string;
  /**
   * Optional structured logger. The orchestrator emits a single record
   * per turn so the parent can correlate offload activity with task
   * lifecycle events without having to replay the ledger.
   */
  readonly onTurnObserved?: (record: ClaudeOffloadTurnTrace) => void;
}

export interface ClaudeOffloadTurnTrace {
  readonly recordedAt: string;
  readonly purpose: ClaudeOffloadBundle['purpose'];
  readonly routeStatus: ClaudeOffloadResult['routeStatus'];
  readonly errorCategory: ClaudeOffloadResult['errorCategory'];
  readonly degradedReason?: string;
  readonly model?: string;
  readonly latencyMs?: number;
  readonly blockingGapCount: number;
  readonly memoryCandidateCount: number;
}

export interface ClaudeOffloadTurnOutcome {
  readonly result: ClaudeOffloadResult;
  readonly prompt: ClaudeOffloadPrompt;
  readonly ledgerRecord?: ClaudeOffloadLedgerRecord;
  readonly trace: ClaudeOffloadTurnTrace;
}

function defaultClock(): string {
  return new Date().toISOString();
}

function buildTrace(
  result: ClaudeOffloadResult,
  recordedAt: string,
): ClaudeOffloadTurnTrace {
  return Object.freeze({
    recordedAt,
    purpose: result.purpose,
    routeStatus: result.routeStatus,
    errorCategory: result.errorCategory,
    ...(result.degradedReason === undefined
      ? {}
      : { degradedReason: result.degradedReason }),
    ...(result.model === undefined ? {} : { model: result.model }),
    ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
    blockingGapCount: result.blockingGapCount,
    memoryCandidateCount: result.memoryCandidateCount,
  });
}

function failOpenEnvelope(error: unknown): ClaudeOffloadGatewayEnvelope {
  // Build a single, flat message. The result-normalizer (downstream) is
  // responsible for length-capping and banned-substring scrubbing via
  // `sanitizeDegradedReason`; we keep the raw text here so the scrub
  // sees the actual upstream content.
  const raw = error instanceof Error ? error.message : String(error);
  return {
    status: 'error',
    errorCategory: 'unknown',
    errorMessage: `gateway-threw:${raw}`,
  };
}

export async function runClaudeOffloadTurn(
  bundle: ClaudeOffloadBundle,
  options: ClaudeOffloadServiceOptions,
): Promise<ClaudeOffloadTurnOutcome> {
  const prompt = buildClaudeOffloadPrompt(bundle);
  const clock = options.clock ?? defaultClock;
  const idFactory = options.idFactory ?? randomUUID;

  const request: ClaudeOffloadGatewayRequest = {
    prompt: prompt.text,
    purpose: bundle.purpose,
    ...(options.modelPreference === undefined
      ? {}
      : { modelPreference: options.modelPreference }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  };

  let envelope: ClaudeOffloadGatewayEnvelope;
  try {
    envelope = await options.gateway.consult(request);
  } catch (error) {
    envelope = failOpenEnvelope(error);
  }

  const result = normalizeClaudeOffloadResult(envelope, {
    purpose: bundle.purpose,
  });

  const recordedAt = clock();
  const trace = buildTrace(result, recordedAt);
  options.onTurnObserved?.(trace);

  let ledgerRecord: ClaudeOffloadLedgerRecord | undefined;
  if (options.ledger !== undefined) {
    ledgerRecord = options.ledger.append({
      result,
      sourceRefCount: bundle.sourceRefs.length,
      acceptanceCheckCount: bundle.acceptanceChecks.length,
      recordId: idFactory(),
      createdAt: recordedAt,
    });
  }

  return Object.freeze({
    result,
    prompt,
    ...(ledgerRecord === undefined ? {} : { ledgerRecord }),
    trace,
  });
}
