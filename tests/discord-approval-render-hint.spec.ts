import { describe, expect, it } from 'vitest';

import {
  buildApprovalResolutionHint,
  renderApprovalResolved,
  renderApprovalResolutionFailed,
} from '../src/discord/discord-result-renderer.js';

// UX-19 — actionable hints for /approve and /deny resolution failures.

describe('buildApprovalResolutionHint', () => {
  it('returns a /feed kind:approval hint for unknown approval ids', () => {
    const hint = buildApprovalResolutionHint(
      'unknown',
      'No approval with that id is pending.',
    );
    expect(hint).toContain('No such approval id');
    expect(hint).toContain('/feed kind:approval');
  });
  it('returns a "already resolved" hint for duplicate status', () => {
    const hint = buildApprovalResolutionHint('duplicate', 'already resolved');
    expect(hint).toContain('already resolved');
    expect(hint).toContain('/feed kind:approval');
  });
  it('also matches "already resolved" via reason text alone', () => {
    const hint = buildApprovalResolutionHint(
      'unexpected',
      'approval was already resolved by another operator',
    );
    expect(hint).toContain('already resolved');
  });
  it('returns an "expired" hint for expired approvals', () => {
    const hint = buildApprovalResolutionHint('expired', 'past deadline');
    expect(hint).toContain('expired before you responded');
    expect(hint).toContain('/status task_id');
  });
  it('also matches "expired" via reason text alone', () => {
    const hint = buildApprovalResolutionHint(
      'unexpected',
      'this approval has expired',
    );
    expect(hint).toContain('expired');
  });
  it('returns undefined for unrecognised status / reason combinations', () => {
    expect(
      buildApprovalResolutionHint('novel-status', 'nothing to recognise here'),
    ).toBeUndefined();
  });
});

describe('renderApprovalResolutionFailed includes the hint when applicable', () => {
  it('appends the hint line under the reason for known failure shapes', () => {
    const payload = renderApprovalResolutionFailed({
      approvalId: 'app-1',
      status: 'unknown',
      reason: 'No approval with that id is pending.',
    });
    expect(payload.content).toContain('Approval `app-1` was not resolved.');
    expect(payload.content).toContain('Status: unknown');
    expect(payload.content).toContain(
      'Reason: No approval with that id is pending.',
    );
    expect(payload.content).toContain('💡 No such approval id');
  });
  it('omits the hint line for unrecognised statuses', () => {
    const payload = renderApprovalResolutionFailed({
      approvalId: 'app-2',
      status: 'unexpected',
      reason: 'something novel',
    });
    expect(payload.content).toContain('Status: unexpected');
    expect(payload.content).not.toContain('💡');
  });
});

describe('renderApprovalResolved (UX-19 keeps the success path bit-stable)', () => {
  it('keeps the resolved-success message format unchanged', () => {
    const payload = renderApprovalResolved({
      approvalId: 'app-3',
      decision: 'approved',
      note: '  approved by maintainer ',
    });
    expect(payload.content).toContain('Approval `app-3` approved.');
    expect(payload.content).toContain('Note: approved by maintainer');
    // No hint surface on the success path.
    expect(payload.content).not.toContain('💡');
  });
  it('omits the note line when the note is whitespace or absent', () => {
    const payload = renderApprovalResolved({
      approvalId: 'app-4',
      decision: 'denied',
    });
    expect(payload.content).toContain('Approval `app-4` denied.');
    expect(payload.content).not.toContain('Note:');
  });
});
