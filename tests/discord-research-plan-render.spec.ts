import { describe, expect, it } from 'vitest';

import {
  humanizeResearchPlanCauseKind,
  renderResearchPlanAccepted,
  renderResearchPlanProgress,
  renderResearchPlanRetry,
} from '../src/discord/discord-result-renderer.js';

// UX-4 / UX-5 / UX-6 — research-plan renderer surface tests.

describe('renderResearchPlanAccepted (UX-6 enrichment)', () => {
  it('always announces real-time per-sub-task progress', () => {
    const payload = renderResearchPlanAccepted({
      planId: 'audit-1',
      subTaskCount: 12,
      provider: 'codex',
    });
    expect(payload.content).toContain('Research plan `audit-1` accepted');
    expect(payload.content).toContain('Per-sub-task progress will follow');
  });
  it('mentions retry budget when retryAttempts > 0', () => {
    const payload = renderResearchPlanAccepted({
      planId: 'audit-2',
      subTaskCount: 6,
      provider: 'claude-agent',
      maxTurns: 16,
      retryAttempts: 2,
    });
    expect(payload.content).toContain('auto-retry up to 2×');
  });
  it('omits retry mention when retryAttempts is 0 / undefined', () => {
    const payload = renderResearchPlanAccepted({
      planId: 'audit-3',
      subTaskCount: 6,
      provider: 'codex',
    });
    expect(payload.content).not.toContain('auto-retry');
    const payloadZero = renderResearchPlanAccepted({
      planId: 'audit-3z',
      subTaskCount: 6,
      provider: 'codex',
      retryAttempts: 0,
    });
    expect(payloadZero.content).not.toContain('auto-retry');
  });
  it('mentions subagent-roster surfaces when subagentRosterActive=true', () => {
    const payload = renderResearchPlanAccepted({
      planId: 'audit-4',
      subTaskCount: 12,
      provider: 'codex',
      subagentRosterActive: true,
    });
    expect(payload.content).toContain('/subagents list');
    expect(payload.content).toContain('/subagents kill');
  });
  it('omits subagent-roster line when flag is false / undefined', () => {
    const payload = renderResearchPlanAccepted({
      planId: 'audit-5',
      subTaskCount: 12,
      provider: 'codex',
    });
    expect(payload.content).not.toContain('/subagents list');
  });
  it('keeps the existing ~15-min interaction-window warning', () => {
    const payload = renderResearchPlanAccepted({
      planId: 'audit-6',
      subTaskCount: 12,
      provider: 'codex',
    });
    expect(payload.content).toContain('15-min');
    expect(payload.content).toContain('pnpm research:plan:run');
  });
});

describe('renderResearchPlanProgress (UX-5 humanized wording)', () => {
  it('renders success in friendly form (✅, "done")', () => {
    const payload = renderResearchPlanProgress({
      planId: 'audit-1',
      subTaskId: 'audit-01-env',
      index: 1,
      total: 12,
      causeKind: 'success',
      elapsedMs: 45200,
      toolUseCount: 12,
    });
    expect(payload.content).toContain('✅');
    expect(payload.content).toContain('1/12');
    expect(payload.content).toContain('done');
    expect(payload.content).toContain('12 tool uses');
    expect(payload.content).toContain('45.2s');
    // The dense `cause=success` format must be gone now.
    expect(payload.content).not.toContain('cause=');
  });
  it('renders provider-failure with humanized label', () => {
    const payload = renderResearchPlanProgress({
      planId: 'audit-2',
      subTaskId: 'audit-02',
      index: 2,
      total: 12,
      causeKind: 'provider-failure',
      elapsedMs: 1500,
      toolUseCount: 0,
    });
    expect(payload.content).toContain('⛔');
    expect(payload.content).toContain('provider error');
    expect(payload.content).toContain('0 tool uses');
  });
  it('renders driver-threw with 💥 + humanized label', () => {
    const payload = renderResearchPlanProgress({
      planId: 'audit-3',
      subTaskId: 'audit-03',
      index: 3,
      total: 12,
      causeKind: 'driver-threw',
      elapsedMs: 200,
      toolUseCount: 0,
    });
    expect(payload.content).toContain('💥');
    expect(payload.content).toContain('driver threw');
  });
  it('singularizes "1 tool use" but pluralizes other counts', () => {
    const one = renderResearchPlanProgress({
      planId: 'p',
      subTaskId: 's',
      index: 1,
      total: 1,
      causeKind: 'success',
      elapsedMs: 1000,
      toolUseCount: 1,
    });
    expect(one.content).toContain('1 tool use ·');
    expect(one.content).not.toContain('1 tool uses');
    const zero = renderResearchPlanProgress({
      planId: 'p',
      subTaskId: 's',
      index: 1,
      total: 1,
      causeKind: 'success',
      elapsedMs: 1000,
      toolUseCount: 0,
    });
    expect(zero.content).toContain('0 tool uses');
  });
});

describe('humanizeResearchPlanCauseKind', () => {
  it('maps known cause kinds to human labels', () => {
    expect(humanizeResearchPlanCauseKind('success')).toBe('success');
    expect(humanizeResearchPlanCauseKind('provider-failure')).toBe(
      'provider error',
    );
    expect(humanizeResearchPlanCauseKind('runtime-veto')).toBe('advisor veto');
    expect(humanizeResearchPlanCauseKind('external-cancel')).toBe('cancelled');
    expect(humanizeResearchPlanCauseKind('timeout')).toBe('timeout');
    expect(humanizeResearchPlanCauseKind('driver-threw')).toBe('driver threw');
  });
  it('falls through to the raw label for unknown kinds', () => {
    expect(humanizeResearchPlanCauseKind('unexpected-novel')).toBe(
      'unexpected-novel',
    );
  });
});

describe('renderResearchPlanRetry (UX-4 retry surface)', () => {
  it('renders retry shape with attempt N/M and humanized cause', () => {
    const payload = renderResearchPlanRetry({
      planId: 'audit-1',
      subTaskId: 'audit-01',
      kind: 'retry',
      attempt: 2,
      maxAttempts: 3,
      previousCauseKind: 'provider-failure',
      previousCauseClassification: 'rate-limit',
    });
    expect(payload.content).toContain('🔁');
    expect(payload.content).toContain('retry 2/3');
    expect(payload.content).toContain('provider error');
    expect(payload.content).toContain('(rate-limit)');
  });
  it('appends a truncated driver-throw preview when supplied', () => {
    const longDriverError =
      'Error: Codex SDK fetch failed: ' + 'A'.repeat(300);
    const payload = renderResearchPlanRetry({
      planId: 'audit-2',
      subTaskId: 'audit-02',
      kind: 'retry',
      attempt: 1,
      maxAttempts: 2,
      previousCauseKind: 'driver-threw',
      previousDriverThrew: longDriverError,
    });
    // Truncated preview must end with the ellipsis sentinel and the
    // total inline message must remain comfortably under Discord's 2k
    // char limit (the retry preview cap is 120 chars).
    expect(payload.content).toContain('…');
    expect(payload.content.length).toBeLessThan(500);
  });
  it('renders fast-fail shape with 🛑 and "no retry" guidance', () => {
    const payload = renderResearchPlanRetry({
      planId: 'audit-3',
      subTaskId: 'audit-03',
      kind: 'fast-fail',
      attempt: 1,
      maxAttempts: 2,
      previousCauseKind: 'provider-failure',
      previousCauseClassification: 'permanent-auth',
    });
    expect(payload.content).toContain('🛑');
    expect(payload.content).toContain('fast-failed');
    expect(payload.content).toContain('permanent-auth');
    expect(payload.content).toContain('no retry');
  });
});
