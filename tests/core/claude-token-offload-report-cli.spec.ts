import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { JsonlClaudeOffloadLedger } from '../../src/core/claude-token-offload-ledger.js';
import {
  CLAUDE_OFFLOAD_REPORT_CLI_SCHEMA_VERSION,
  buildClaudeOffloadReportFromCliOptions,
  parseClaudeOffloadReportCliArgs,
  runClaudeOffloadReportCli,
} from '../../src/core/claude-token-offload-report-cli.js';
import type { ClaudeOffloadResult } from '../../src/core/claude-token-offload-result.js';

function makeResult(
  overrides: Partial<ClaudeOffloadResult> = {},
): ClaudeOffloadResult {
  const base: ClaudeOffloadResult = {
    schemaVersion: 1,
    purpose: 'checkpoint-synthesis',
    routeStatus: 'offload-route-ok',
    errorCategory: 'none',
    model: 'claude-opus-4-7',
    latencyMs: 500,
    costUsd: 0.001,
    tokenUsage: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 80 },
    sections: {
      status: ['ok'],
      findings: [],
      blockingGaps: [],
      memoryCandidates: ['mem'],
      residualRisk: ['none'],
    },
    blockingGapCount: 0,
    memoryCandidateCount: 1,
  };
  return { ...base, ...overrides };
}

class CapturedIo {
  out = '';
  err = '';
  stdout = { write: (chunk: string) => void (this.out += chunk) };
  stderr = { write: (chunk: string) => void (this.err += chunk) };
}

describe('core/claude-token-offload-report-cli', () => {
  it('parses --ledger / --max-bytes / --pretty / --help', () => {
    expect(parseClaudeOffloadReportCliArgs(['--help'])).toBe('help');
    const opts = parseClaudeOffloadReportCliArgs([
      '--ledger',
      '/tmp/ledger.jsonl',
      '--ledger',
      '/tmp/other.jsonl',
      '--max-bytes',
      '2048',
      '--pretty',
      '--generated-at',
      '2026-05-05T22:30:00.000Z',
    ]);
    expect(opts).toEqual({
      ledgerPaths: ['/tmp/ledger.jsonl', '/tmp/other.jsonl'],
      maxBytes: 2048,
      pretty: true,
      generatedAt: '2026-05-05T22:30:00.000Z',
    });
  });

  it('rejects missing --ledger or unknown args', () => {
    expect(() => parseClaudeOffloadReportCliArgs([])).toThrow(/at least one --ledger/);
    expect(() => parseClaudeOffloadReportCliArgs(['--foo'])).toThrow(/unknown argument/);
    expect(() =>
      parseClaudeOffloadReportCliArgs(['--ledger']),
    ).toThrow(/--ledger requires/);
    expect(() =>
      parseClaudeOffloadReportCliArgs(['--ledger', 'a', '--max-bytes', '0']),
    ).toThrow(/--max-bytes/);
  });

  it('builds a report with scorecard, source files, and read-only boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-offload-cli-'));
    const ledgerPath = join(dir, 'ledger.jsonl');
    const ledger = new JsonlClaudeOffloadLedger(ledgerPath);
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
        errorCategory: 'tool-use-degraded',
        purpose: 'live-proof-triage',
      }),
      sourceRefCount: 2,
      acceptanceCheckCount: 0,
      recordId: 'rec-2',
      createdAt: '2026-05-05T22:01:00.000Z',
    });

    const report = buildClaudeOffloadReportFromCliOptions({
      ledgerPaths: [ledgerPath],
      maxBytes: 64 * 1024,
      pretty: false,
      generatedAt: '2026-05-05T22:30:00.000Z',
    });

    expect(report.schemaVersion).toBe(CLAUDE_OFFLOAD_REPORT_CLI_SCHEMA_VERSION);
    expect(report.provenance).toBe('claude-token-offload');
    expect(report.source.files).toEqual([
      {
        path: ledgerPath,
        recordCount: 2,
        skippedMalformedLineCount: 0,
        skippedUnsafeLineCount: 0,
      },
    ]);
    expect(report.scorecard.recordCount).toBe(2);
    expect(report.scorecard.statusCounts['offload-route-ok']).toBe(1);
    expect(report.scorecard.statusCounts['offload-route-warn']).toBe(1);
    expect(report.scorecard.errorCategoryCounts['tool-use-degraded']).toBe(1);
    expect(report.scorecard.purposeCounts['live-proof-triage']).toBe(1);
    expect(report.scorecard.purposeCounts['checkpoint-synthesis']).toBe(1);
    expect(report.boundary.readOnly).toBe(true);
    expect(report.boundary.rawPromptsRendered).toBe(false);
    expect(report.boundary.rawResponsesRendered).toBe(false);
  });

  it('runs the CLI end to end and emits stdout JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-offload-cli-'));
    const ledgerPath = join(dir, 'ledger.jsonl');
    const ledger = new JsonlClaudeOffloadLedger(ledgerPath);
    ledger.append({
      result: makeResult(),
      sourceRefCount: 1,
      acceptanceCheckCount: 1,
      recordId: 'rec-cli',
      createdAt: '2026-05-05T22:00:00.000Z',
    });

    const io = new CapturedIo();
    const exit = runClaudeOffloadReportCli(
      [
        '--ledger',
        ledgerPath,
        '--pretty',
        '--generated-at',
        '2026-05-05T22:30:00.000Z',
      ],
      io,
    );
    expect(exit).toBe(0);
    const parsed = JSON.parse(io.out) as Record<string, unknown>;
    expect((parsed.scorecard as Record<string, unknown>).recordCount).toBe(1);
    expect(io.err).toBe('');
    // Boundary booleans like "rawPromptsRendered: false" are allowed
    // (they are negative-claim metadata). Ban only the bare leak shapes.
    expect(io.out).not.toMatch(/"rawPrompt":/);
    expect(io.out).not.toMatch(/"rawResponse":/);
    expect(io.out).not.toMatch(/"rawInstruction":/);
  });

  it('fails non-zero on missing ledger file', () => {
    const io = new CapturedIo();
    const exit = runClaudeOffloadReportCli(
      ['--ledger', '/tmp/__claude_offload_does_not_exist__.jsonl'],
      io,
    );
    expect(exit).toBe(1);
    expect(io.err).toMatch(/claude-token-offload-report failed/);
  });

  it('emits the help banner with --help', () => {
    const io = new CapturedIo();
    const exit = runClaudeOffloadReportCli(['--help'], io);
    expect(exit).toBe(0);
    expect(io.out).toMatch(/Usage: claude-token-offload-report/);
  });
});
