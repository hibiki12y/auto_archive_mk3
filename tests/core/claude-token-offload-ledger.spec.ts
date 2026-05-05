import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_OFFLOAD_LEDGER_DECISION_ROLE,
  CLAUDE_OFFLOAD_LEDGER_PROVENANCE,
  CLAUDE_OFFLOAD_LEDGER_RECORD_FIELDS,
  CLAUDE_OFFLOAD_LEDGER_SCHEMA_VERSION,
  ClaudeOffloadLedgerError,
  JsonlClaudeOffloadLedger,
  buildClaudeOffloadLedgerScorecard,
  projectClaudeOffloadResultToLedgerRecord,
  type ClaudeOffloadLedgerRecord,
} from '../../src/core/claude-token-offload-ledger.js';
import type { ClaudeOffloadResult } from '../../src/core/claude-token-offload-result.js';

const FROZEN_NOW = '2026-05-05T22:00:00.000Z';

function makeResult(
  overrides: Partial<ClaudeOffloadResult> = {},
): ClaudeOffloadResult {
  const base: ClaudeOffloadResult = {
    schemaVersion: 1,
    purpose: 'checkpoint-synthesis',
    routeStatus: 'offload-route-ok',
    errorCategory: 'none',
    model: 'claude-opus-4-7',
    latencyMs: 800,
    costUsd: 0.005,
    tokenUsage: {
      inputTokens: 200,
      cachedInputTokens: 100,
      outputTokens: 150,
    },
    sections: {
      status: ['ok'],
      findings: [],
      blockingGaps: ['gap a'],
      memoryCandidates: ['mem b', 'mem c'],
      residualRisk: ['low'],
    },
    blockingGapCount: 1,
    memoryCandidateCount: 2,
  };
  return { ...base, ...overrides };
}

describe('core/claude-token-offload-ledger', () => {
  it('publishes the canonical retained-field allowlist and constants', () => {
    expect(CLAUDE_OFFLOAD_LEDGER_SCHEMA_VERSION).toBe(1);
    expect(CLAUDE_OFFLOAD_LEDGER_PROVENANCE).toBe('claude-token-offload');
    expect(CLAUDE_OFFLOAD_LEDGER_DECISION_ROLE).toBe('advisory-only');
    expect([...CLAUDE_OFFLOAD_LEDGER_RECORD_FIELDS]).toEqual([
      'schemaVersion',
      'recordId',
      'createdAt',
      'purpose',
      'sourceRefCount',
      'acceptanceCheckCount',
      'routeStatus',
      'errorCategory',
      'degradedReason',
      'blockingGapCount',
      'memoryCandidateCount',
      'model',
      'latencyMs',
      'costUsd',
      'inputTokens',
      'cachedInputTokens',
      'outputTokens',
      'provenance',
      'decisionRole',
    ]);
  });

  it('projects a result into a metadata-only retained record', () => {
    const record = projectClaudeOffloadResultToLedgerRecord({
      result: makeResult(),
      sourceRefCount: 3,
      acceptanceCheckCount: 2,
      recordId: 'rec-1',
      createdAt: FROZEN_NOW,
    });

    expect(record).toMatchObject({
      schemaVersion: 1,
      recordId: 'rec-1',
      createdAt: FROZEN_NOW,
      purpose: 'checkpoint-synthesis',
      sourceRefCount: 3,
      acceptanceCheckCount: 2,
      routeStatus: 'offload-route-ok',
      errorCategory: 'none',
      blockingGapCount: 1,
      memoryCandidateCount: 2,
      model: 'claude-opus-4-7',
      inputTokens: 200,
      cachedInputTokens: 100,
      outputTokens: 150,
      provenance: 'claude-token-offload',
      decisionRole: 'advisory-only',
    });

    // Section bodies must NOT appear in the retained record.
    const recordObject = record as unknown as Record<string, unknown>;
    expect(recordObject.sections).toBeUndefined();
    expect(recordObject.status).toBeUndefined();
    expect(recordObject.findings).toBeUndefined();
  });

  it('rejects records that exceed the per-record byte cap', () => {
    expect(() =>
      projectClaudeOffloadResultToLedgerRecord({
        result: makeResult({
          degradedReason: 'x'.repeat(8 * 1024),
        }),
        sourceRefCount: 1,
        acceptanceCheckCount: 1,
      }),
    ).toThrow(ClaudeOffloadLedgerError);
  });

  it('appends and replays JSONL records faithfully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-offload-ledger-'));
    const path = join(dir, 'ledger.jsonl');
    const ledger = new JsonlClaudeOffloadLedger(path);

    const a = ledger.append({
      result: makeResult(),
      sourceRefCount: 2,
      acceptanceCheckCount: 1,
      recordId: 'rec-a',
      createdAt: '2026-05-05T22:00:00.000Z',
    });
    const b = ledger.append({
      result: makeResult({
        routeStatus: 'offload-route-warn',
        errorCategory: 'partial-result',
        degradedReason: 'missing-sections:residualRisk',
        blockingGapCount: 0,
        memoryCandidateCount: 0,
      }),
      sourceRefCount: 1,
      acceptanceCheckCount: 0,
      recordId: 'rec-b',
      createdAt: '2026-05-05T22:01:00.000Z',
    });

    const replay = ledger.loadWithAudit();
    expect(replay.records.map((r) => r.recordId)).toEqual(['rec-a', 'rec-b']);
    expect(replay.replayAudit).toMatchObject({
      source: 'jsonl',
      totalLineCount: 2,
      emptyLineCount: 0,
      parsedRecordCount: 2,
      skippedMalformedLineCount: 0,
      skippedUnsafeLineCount: 0,
    });
    expect(a.recordId).toBe('rec-a');
    expect(b.routeStatus).toBe('offload-route-warn');

    const fileText = readFileSync(path, 'utf8');
    // Banned keys must never appear in the on-disk text.
    expect(fileText).not.toMatch(/rawPrompt|rawResponse|rawInstruction/);
    expect(fileText).not.toMatch(/"sections"/);
  });

  it('skips torn JSONL lines but does not crash replay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-offload-ledger-'));
    const path = join(dir, 'ledger.jsonl');
    const ledger = new JsonlClaudeOffloadLedger(path);
    ledger.append({
      result: makeResult(),
      sourceRefCount: 1,
      acceptanceCheckCount: 1,
      recordId: 'rec-good',
      createdAt: FROZEN_NOW,
    });
    // Append a torn JSON line.
    mkdirSync(dir, { recursive: true });
    const torn = `${readFileSync(path, 'utf8')}{"schemaVersion":1,"recordId":"rec-bad","createdAt":\n`;
    writeFileSync(path, torn, 'utf8');

    const replay = ledger.loadWithAudit();
    expect(replay.records.map((r) => r.recordId)).toEqual(['rec-good']);
    expect(replay.replayAudit.skippedMalformedLineCount).toBe(1);
  });

  it('skips lines that contain banned keys at the top or nested level', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-offload-ledger-'));
    const path = join(dir, 'ledger.jsonl');
    // Manually write a syntactically-valid line that carries a banned key.
    const malicious = JSON.stringify({
      schemaVersion: 1,
      recordId: 'rec-bad',
      createdAt: FROZEN_NOW,
      purpose: 'checkpoint-synthesis',
      sourceRefCount: 1,
      acceptanceCheckCount: 1,
      routeStatus: 'offload-route-ok',
      errorCategory: 'none',
      blockingGapCount: 0,
      memoryCandidateCount: 0,
      provenance: 'claude-token-offload',
      decisionRole: 'advisory-only',
      secret: 'leaked',
    });
    writeFileSync(path, `${malicious}\n`, 'utf8');
    const ledger = new JsonlClaudeOffloadLedger(path);
    const replay = ledger.loadWithAudit();
    expect(replay.records).toEqual([]);
    expect(replay.replayAudit.skippedUnsafeLineCount).toBe(1);
    expect(replay.replayAudit.parsedRecordCount).toBe(0);
  });

  it('rejects unknown extra fields during replay shape validation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-offload-ledger-'));
    const path = join(dir, 'ledger.jsonl');
    const extra = JSON.stringify({
      schemaVersion: 1,
      recordId: 'rec-extra',
      createdAt: FROZEN_NOW,
      purpose: 'checkpoint-synthesis',
      sourceRefCount: 1,
      acceptanceCheckCount: 1,
      routeStatus: 'offload-route-ok',
      errorCategory: 'none',
      blockingGapCount: 0,
      memoryCandidateCount: 0,
      provenance: 'claude-token-offload',
      decisionRole: 'advisory-only',
      somethingExtra: 'not allowed',
    });
    writeFileSync(path, `${extra}\n`, 'utf8');
    const replay = new JsonlClaudeOffloadLedger(path).loadWithAudit();
    expect(replay.records).toEqual([]);
    expect(replay.replayAudit.skippedMalformedLineCount).toBe(1);
  });

  it('refuses replay when ledger exceeds maxBytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-offload-ledger-'));
    const path = join(dir, 'ledger.jsonl');
    writeFileSync(path, 'x'.repeat(1024), 'utf8');
    expect(() =>
      new JsonlClaudeOffloadLedger(path).loadWithAudit({ maxBytes: 512 }),
    ).toThrow(/maxBytes/);
  });

  it('builds a scorecard with status/category/purpose counts and recency', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-offload-ledger-'));
    const path = join(dir, 'ledger.jsonl');
    const ledger = new JsonlClaudeOffloadLedger(path);
    ledger.append({
      result: makeResult(),
      sourceRefCount: 1,
      acceptanceCheckCount: 1,
      recordId: 'rec-1',
      createdAt: '2026-05-05T22:00:00.000Z',
    });
    ledger.append({
      result: makeResult({
        routeStatus: 'offload-route-warn',
        errorCategory: 'partial-result',
        purpose: 'memory-compaction-draft',
      }),
      sourceRefCount: 2,
      acceptanceCheckCount: 0,
      recordId: 'rec-2',
      createdAt: '2026-05-05T22:01:00.000Z',
    });
    const scorecard = buildClaudeOffloadLedgerScorecard(
      ledger.loadWithAudit().records,
    );
    expect(scorecard.recordCount).toBe(2);
    expect(scorecard.statusCounts['offload-route-ok']).toBe(1);
    expect(scorecard.statusCounts['offload-route-warn']).toBe(1);
    expect(scorecard.errorCategoryCounts.none).toBe(1);
    expect(scorecard.errorCategoryCounts['partial-result']).toBe(1);
    expect(scorecard.purposeCounts['checkpoint-synthesis']).toBe(1);
    expect(scorecard.purposeCounts['memory-compaction-draft']).toBe(1);
    expect(scorecard.totalBlockingGaps).toBe(2);
    expect(scorecard.totalMemoryCandidates).toBe(4);
    expect(scorecard.recency.firstRecordedAt).toBe('2026-05-05T22:00:00.000Z');
    expect(scorecard.recency.lastRecordedAt).toBe('2026-05-05T22:01:00.000Z');
  });

  it('returns an empty replay result when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-offload-ledger-'));
    const ledger = new JsonlClaudeOffloadLedger(join(dir, 'no-such-file.jsonl'));
    const replay = ledger.loadWithAudit();
    expect(replay.records).toEqual([]);
    expect(replay.replayAudit.parsedRecordCount).toBe(0);
  });

  it('typed record carries provenance and decisionRole literals', () => {
    const record: ClaudeOffloadLedgerRecord = projectClaudeOffloadResultToLedgerRecord({
      result: makeResult(),
      sourceRefCount: 1,
      acceptanceCheckCount: 1,
      recordId: 'rec-typed',
      createdAt: FROZEN_NOW,
    });
    expect(record.provenance).toBe('claude-token-offload');
    expect(record.decisionRole).toBe('advisory-only');
  });
});
