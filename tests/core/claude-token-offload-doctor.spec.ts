import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { JsonlClaudeOffloadLedger } from '../../src/core/claude-token-offload-ledger.js';
import {
  AUTO_ARCHIVE_CLAUDE_OFFLOAD_LEDGER_PATH,
  AUTO_ARCHIVE_CLAUDE_OFFLOAD_MAX_LEDGER_BYTES,
  buildDoctorReportFromEnv,
  renderDoctorReport,
  resolveClaudeOffloadReportDoctorStatusFromEnv,
} from '../../src/core/doctor.js';
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
    tokenUsage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 80 },
    sections: {
      status: ['ok'],
      findings: [],
      blockingGaps: [],
      memoryCandidates: ['m1'],
      residualRisk: [],
    },
    blockingGapCount: 0,
    memoryCandidateCount: 1,
  };
  return { ...base, ...overrides };
}

function appendOk(ledger: JsonlClaudeOffloadLedger, id: string): void {
  ledger.append({
    result: makeResult(),
    sourceRefCount: 1,
    acceptanceCheckCount: 1,
    recordId: id,
    createdAt: '2026-05-06T00:00:00.000Z',
  });
}

function appendWarn(ledger: JsonlClaudeOffloadLedger, id: string): void {
  ledger.append({
    result: makeResult({
      routeStatus: 'offload-route-warn',
      errorCategory: 'tool-use-degraded',
    }),
    sourceRefCount: 1,
    acceptanceCheckCount: 0,
    recordId: id,
    createdAt: '2026-05-06T00:01:00.000Z',
  });
}

describe('core/doctor — Claude token offload section', () => {
  it('omits the section when AUTO_ARCHIVE_CLAUDE_OFFLOAD_LEDGER_PATH is unset', () => {
    expect(resolveClaudeOffloadReportDoctorStatusFromEnv({})).toBeUndefined();
    const text = renderDoctorReport(buildDoctorReportFromEnv({}));
    expect(text).not.toContain('Claude token offload report');
  });

  it('renders a PASS section with route status counts and read-only banners', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-offload-doctor-pass-'));
    try {
      const ledgerPath = join(dir, 'offload.jsonl');
      const ledger = new JsonlClaudeOffloadLedger(ledgerPath);
      appendOk(ledger, 'rec-pass-1');
      appendOk(ledger, 'rec-pass-2');

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_CLAUDE_OFFLOAD_LEDGER_PATH]: ledgerPath,
          [AUTO_ARCHIVE_CLAUDE_OFFLOAD_MAX_LEDGER_BYTES]: '10000',
        }),
      );

      expect(text).toContain('[PASS] Claude token offload report');
      expect(text).toContain('Records: 2');
      expect(text).toContain('Route status: ok=2 warn=0 fail=0');
      expect(text).toContain('Decision role: advisory-only');
      expect(text).toContain('Raw prompts: not rendered');
      expect(text).toContain('Raw responses: not rendered');
      expect(text).toContain('Live service contact: none');
      // Path is shown only via the redacted basename#hash summary, not the workspace path.
      expect(text).not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders WARN when offload-route-warn records are present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-offload-doctor-warn-'));
    try {
      const ledgerPath = join(dir, 'offload.jsonl');
      const ledger = new JsonlClaudeOffloadLedger(ledgerPath);
      appendOk(ledger, 'rec-ok');
      appendWarn(ledger, 'rec-warn');

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_CLAUDE_OFFLOAD_LEDGER_PATH]: ledgerPath,
        }),
      );

      expect(text).toContain('[WARN] Claude token offload report');
      expect(text).toContain('Route status: ok=1 warn=1 fail=0');
      expect(text).toContain(
        'Review offload-route-warn entries; degraded categories include',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders WARN with a redacted error message when the ledger path is missing', () => {
    const status = resolveClaudeOffloadReportDoctorStatusFromEnv({
      [AUTO_ARCHIVE_CLAUDE_OFFLOAD_LEDGER_PATH]: '/tmp/__claude_offload_does_not_exist__.jsonl',
    });
    expect(status).toBeDefined();
    expect(status?.error).toBeDefined();
    expect(status?.recordCount).toBeUndefined();

    const text = renderDoctorReport(
      buildDoctorReportFromEnv({
        [AUTO_ARCHIVE_CLAUDE_OFFLOAD_LEDGER_PATH]:
          '/tmp/__claude_offload_does_not_exist__.jsonl',
      }),
    );
    expect(text).toContain('[WARN] Claude token offload report');
    expect(text).toContain('Replay status: failed');
  });

  it('rejects malformed AUTO_ARCHIVE_CLAUDE_OFFLOAD_MAX_LEDGER_BYTES via the section error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-offload-doctor-bad-bytes-'));
    try {
      const ledgerPath = join(dir, 'offload.jsonl');
      const ledger = new JsonlClaudeOffloadLedger(ledgerPath);
      appendOk(ledger, 'rec-1');

      const status = resolveClaudeOffloadReportDoctorStatusFromEnv({
        [AUTO_ARCHIVE_CLAUDE_OFFLOAD_LEDGER_PATH]: ledgerPath,
        [AUTO_ARCHIVE_CLAUDE_OFFLOAD_MAX_LEDGER_BYTES]: 'not-a-number',
      });
      expect(status?.error).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders PASS for an empty (zero-record) ledger file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-offload-doctor-empty-'));
    try {
      const ledgerPath = join(dir, 'offload.jsonl');
      writeFileSync(ledgerPath, '', 'utf8');
      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_CLAUDE_OFFLOAD_LEDGER_PATH]: ledgerPath,
        }),
      );
      expect(text).toContain('[PASS] Claude token offload report');
      expect(text).toContain('Records: 0');
      expect(text).toContain('Route status: ok=0 warn=0 fail=0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders WARN when malformed lines are skipped during replay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-offload-doctor-malformed-'));
    try {
      const ledgerPath = join(dir, 'offload.jsonl');
      const ledger = new JsonlClaudeOffloadLedger(ledgerPath);
      appendOk(ledger, 'rec-clean');
      // Append a torn line that JSON.parse cannot decode.
      appendFileSync(ledgerPath, '{not-json\n', 'utf8');

      const status = resolveClaudeOffloadReportDoctorStatusFromEnv({
        [AUTO_ARCHIVE_CLAUDE_OFFLOAD_LEDGER_PATH]: ledgerPath,
      });
      expect(status?.skippedMalformedLineCount).toBe(1);
      expect(status?.skippedUnsafeLineCount).toBe(0);

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_CLAUDE_OFFLOAD_LEDGER_PATH]: ledgerPath,
        }),
      );
      expect(text).toContain('[WARN] Claude token offload report');
      expect(text).toContain('Records: 1');
      expect(text).toContain('Malformed/torn lines: 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders FAIL when unsafe lines (banned-key contamination) are skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-offload-doctor-unsafe-'));
    try {
      const ledgerPath = join(dir, 'offload.jsonl');
      const ledger = new JsonlClaudeOffloadLedger(ledgerPath);
      appendOk(ledger, 'rec-clean');
      // Append a structurally well-formed JSON line that carries a
      // banned key — the ledger replay must reject it as unsafe rather
      // than parsing it as a record.
      const unsafeLine = `${JSON.stringify({
        schemaVersion: 1,
        recordId: 'rec-tampered',
        purpose: 'checkpoint-synthesis',
        routeStatus: 'offload-route-ok',
        errorCategory: 'none',
        sourceRefCount: 1,
        acceptanceCheckCount: 1,
        blockingGapCount: 0,
        memoryCandidateCount: 0,
        createdAt: '2026-05-06T00:00:00.000Z',
        provenance: 'claude-token-offload',
        decisionRole: 'advisory-only',
        rawPrompt: 'leaked-prompt-body',
      })}\n`;
      appendFileSync(ledgerPath, unsafeLine, 'utf8');

      const status = resolveClaudeOffloadReportDoctorStatusFromEnv({
        [AUTO_ARCHIVE_CLAUDE_OFFLOAD_LEDGER_PATH]: ledgerPath,
      });
      expect(status?.skippedUnsafeLineCount).toBe(1);
      expect(status?.recordCount).toBe(1);

      const text = renderDoctorReport(
        buildDoctorReportFromEnv({
          [AUTO_ARCHIVE_CLAUDE_OFFLOAD_LEDGER_PATH]: ledgerPath,
        }),
      );
      expect(text).toContain('[FAIL] Claude token offload report');
      expect(text).toContain('Unsafe replay lines: 1');
      // The retained advisory tag is always rendered, even on FAIL.
      expect(text).toContain('Decision role: advisory-only');
      // The leaked prose must not survive into the section render.
      expect(text).not.toContain('leaked-prompt-body');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
