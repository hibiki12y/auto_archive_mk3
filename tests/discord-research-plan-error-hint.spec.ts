import { describe, expect, it } from 'vitest';

import { buildResearchPlanEarlyStopHint } from '../src/discord/discord-command-handlers.js';
import { renderResearchPlanError } from '../src/discord/discord-result-renderer.js';

// UX-2 — actionable hints in `/research-plan` early-stop follow-ups.

describe('buildResearchPlanEarlyStopHint', () => {
  it('returns a permanent-failure hint for provider-failure + permanent-* classification', () => {
    const hint = buildResearchPlanEarlyStopHint(
      'provider-failure',
      'permanent-auth',
      'audit-1',
    );
    expect(hint).toContain('Permanent provider failure');
    expect(hint).toContain('permanent-auth');
    expect(hint).toContain('/doctor');
    expect(hint).not.toContain("'/research-plan plan-id:audit-1'");
  });
  it('returns a transient-failure hint for provider-failure + rate-limit', () => {
    const hint = buildResearchPlanEarlyStopHint(
      'provider-failure',
      'rate-limit',
      'audit-2',
    );
    expect(hint).toContain('Transient provider failure');
    expect(hint).toContain('audit-2');
  });
  it('returns a generic provider-failure hint when classification is undefined', () => {
    const hint = buildResearchPlanEarlyStopHint(
      'provider-failure',
      undefined,
      'audit-3',
    );
    expect(hint).toContain('Provider failure');
    expect(hint).toContain('audit-3');
    expect(hint).toContain('--retry-attempts');
  });
  it('returns an advisor-veto hint for runtime-veto', () => {
    const hint = buildResearchPlanEarlyStopHint(
      'runtime-veto',
      undefined,
      'audit-4',
    );
    expect(hint).toContain('Advisor vetoed');
    expect(hint).toContain('/doctor');
  });
  it('returns a wallTime hint for timeout', () => {
    const hint = buildResearchPlanEarlyStopHint(
      'timeout',
      undefined,
      'audit-5',
    );
    expect(hint).toContain('wallTime');
  });
  it('returns a driver-threw hint when the driver threw before producing a cause', () => {
    const hint = buildResearchPlanEarlyStopHint(
      'driver-threw',
      undefined,
      'audit-6',
    );
    expect(hint).toContain('Driver threw');
    expect(hint).toContain('/doctor');
  });
  it('returns undefined for external-cancel (operator already knows; no hint)', () => {
    const hint = buildResearchPlanEarlyStopHint(
      'external-cancel',
      undefined,
      'audit-7',
    );
    expect(hint).toBeUndefined();
  });
  it('falls through to generic re-run guidance for unrecognised cause kinds', () => {
    const hint = buildResearchPlanEarlyStopHint(
      'something-novel',
      undefined,
      'audit-8',
    );
    expect(hint).toContain('audit-8');
    expect(hint).toContain('--retry-attempts');
  });
});

describe('renderResearchPlanError with hint', () => {
  it('appends the hint on its own line after the bare error message', () => {
    const payload = renderResearchPlanError(
      'audit-9',
      'plan stopped early after 3/12 sub-tasks. Last cause: provider-failure (rate-limit).',
      'Transient provider failure — wait briefly, then re-run.',
    );
    expect(payload.content).toContain('Research plan `audit-9` rejected:');
    expect(payload.content).toContain('💡 Transient provider failure');
    // Hint sits on a separate line for readability.
    const lines = payload.content.split('\n');
    const hintLine = lines.find((l) => l.startsWith('💡'));
    expect(hintLine).toBeDefined();
  });
  it('omits the hint section when no hint is supplied (legacy callers)', () => {
    const payload = renderResearchPlanError(
      'audit-10',
      'runtime driver is not wired',
    );
    expect(payload.content).toContain('Research plan `audit-10` rejected:');
    expect(payload.content).not.toContain('💡');
  });
  it('omits the hint section when an empty-string hint is supplied', () => {
    const payload = renderResearchPlanError(
      'audit-11',
      'malformed plan-id',
      '',
    );
    expect(payload.content).not.toContain('💡');
  });
});
