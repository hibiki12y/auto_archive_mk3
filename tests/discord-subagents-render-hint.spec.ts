import { describe, expect, it } from 'vitest';

import {
  buildSubagentOperatorActionHint,
  renderSubagentOperatorResult,
  renderSubagentOperatorUnavailable,
} from '../src/discord/discord-result-renderer.js';

// UX-3 — actionable hints in `/subagents` responses.

describe('buildSubagentOperatorActionHint', () => {
  it('returns a list/typo hint for not-found', () => {
    const hint = buildSubagentOperatorActionHint(
      'not-found',
      'Unknown subagent: foo-bar',
    );
    expect(hint).toContain('/subagents list');
    expect(hint).toContain('typos');
  });
  it('returns a kill-then-re-dispatch hint for the mid-flight injection denial', () => {
    const hint = buildSubagentOperatorActionHint(
      'denied',
      'mid-flight injection is not supported by current provider session shape; use /subagents kill <id> and re-dispatch',
    );
    expect(hint).toContain('Mid-flight provider injection');
    expect(hint).toContain('/subagents kill');
    expect(hint).toContain('re-dispatch');
  });
  it('returns an evidence-replay hint for kill-against-already-terminated subagent', () => {
    const hint = buildSubagentOperatorActionHint(
      'denied',
      'subagent is not in an active dispatch state',
    );
    expect(hint).toContain('terminated');
    expect(hint).toContain('/subagents log');
  });
  it('returns an approval-routing hint for the subagent-approval-not-routed denial', () => {
    const hint = buildSubagentOperatorActionHint(
      'denied',
      'subagent-approval-not-routed-stage-4-6: child approvals are not yet routed to the research-plan operator surface',
    );
    expect(hint).toContain('Approval routing');
    expect(hint).toContain('CLI runner');
  });
  it('falls back to generic /subagents list guidance for unrecognised denied reasons', () => {
    const hint = buildSubagentOperatorActionHint('denied', 'novel reason');
    expect(hint).toContain('/subagents list');
  });
});

describe('renderSubagentOperatorResult denied/not-found include hint', () => {
  it('appends a hint line under the reason for denied results', () => {
    const payload = renderSubagentOperatorResult({
      status: 'denied',
      reason: 'subagent is not in an active dispatch state',
    });
    expect(payload.content).toContain('Reason: subagent is not in an active');
    expect(payload.content).toContain('💡 The subagent has already terminated');
    expect(payload.content).toContain('/subagents log');
  });
  it('appends a hint line under the reason for not-found results', () => {
    const payload = renderSubagentOperatorResult({
      status: 'not-found',
      reason: 'Unknown subagent: subagent-3',
    });
    expect(payload.content).toContain('Reason: Unknown subagent: subagent-3');
    expect(payload.content).toContain('💡 Use `/subagents list`');
  });
  it('does not append a hint line for ok results (no hint surface needed)', () => {
    const payload = renderSubagentOperatorResult({
      status: 'ok',
      message: 'No active subagent dispatches.',
    });
    expect(payload.content).not.toContain('💡');
    expect(payload.content).toContain('No active subagent dispatches.');
  });
});

describe('renderSubagentOperatorUnavailable includes operator hint', () => {
  it('explains the env knob + bot-wiring requirement', () => {
    const payload = renderSubagentOperatorUnavailable();
    expect(payload.content).toContain(
      'Subagent operator surface is not configured',
    );
    expect(payload.content).toContain(
      'AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH',
    );
    expect(payload.content).toContain('bootstrapDiscordService');
  });
});
