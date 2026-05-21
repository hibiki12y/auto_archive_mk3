import { describe, expect, it } from 'vitest';

import {
  buildAccessDeniedHint,
  renderAccessDenied,
  renderHelp,
  renderTaskList,
} from '../src/discord/discord-result-renderer.js';

// UX-7 — /help is reorganized into discoverability-friendly sections.

describe('renderHelp (UX-7 reorganization)', () => {
  it('opens with a Quickstart section that mentions the bot + /status', () => {
    const payload = renderHelp();
    expect(payload.content).toContain('Quickstart');
    expect(payload.content).toContain('Mention the bot');
    expect(payload.content).toContain('/status task_id:');
  });
  it('groups read-only inspection commands under their own section', () => {
    const payload = renderHelp();
    expect(payload.content).toContain('Read-only inspection');
    for (const cmd of ['/tasks', '/history', '/context', '/feed', '/traits']) {
      expect(payload.content).toContain(cmd);
    }
  });
  it('groups owner/admin task changes (cancel/rerun/archive/unarchive/escalate)', () => {
    const payload = renderHelp();
    expect(payload.content).toContain('Owner / admin task changes');
    for (const cmd of [
      '/cancel',
      '/rerun',
      '/archive',
      '/unarchive',
      '/escalate',
    ]) {
      expect(payload.content).toContain(cmd);
    }
  });
  it('groups long-running research commands (research / evidence / claim / research-plan / agenda)', () => {
    const payload = renderHelp();
    expect(payload.content).toContain('Long-running research');
    for (const cmd of ['/research', '/evidence', '/claim', '/research-plan', '/agenda']) {
      expect(payload.content).toContain(cmd);
    }
  });
  it('groups admin-only ops with the admin-required note', () => {
    const payload = renderHelp();
    expect(payload.content).toContain('Admin-only ops');
    expect(payload.content).toContain('Discord admin');
    for (const cmd of [
      '/doctor',
      '/auth',
      '/approve',
      '/deny',
      '/subagents',
      '/proof',
      '/config',
    ]) {
      expect(payload.content).toContain(cmd);
    }
  });
  it('mentions the per-sub-task progress streaming for /research-plan (UX-1 cross-reference)', () => {
    const payload = renderHelp();
    expect(payload.content).toContain(
      'Per-sub-task progress streams',
    );
  });
});

// UX-8 — access-denied responses include actionable next-step hints.

describe('buildAccessDeniedHint', () => {
  it('returns an admin add-via-/auth hint for admin-required denials', () => {
    const hint = buildAccessDeniedHint('admin-required');
    expect(hint).toContain('admin-only');
    expect(hint).toContain('/auth add user_id');
    expect(hint).toContain('/status');
  });
  it('returns an allow-list hint for user-not-allowed denials', () => {
    const hint = buildAccessDeniedHint('user-not-allowed');
    expect(hint).toContain('not on the allow-list');
    expect(hint).toContain('/auth add user_id');
  });
  it('returns a server allow-list hint for guild-not-allowed denials', () => {
    const hint = buildAccessDeniedHint('guild-not-allowed');
    expect(hint).toContain('Discord server');
    expect(hint).toContain('/auth add guild_id');
  });
  it('returns a channel allow-list hint for channel-not-allowed denials', () => {
    const hint = buildAccessDeniedHint('channel-not-allowed');
    expect(hint).toContain('channel');
    expect(hint).toContain('/auth add channel_id');
  });
  it('returns a server-channel hint for dm-disabled denials', () => {
    const hint = buildAccessDeniedHint('dm-disabled');
    expect(hint).toContain('Direct messages');
    expect(hint).toContain('server channel');
  });
  it('returns a real-account hint for bot-authors-disabled denials', () => {
    const hint = buildAccessDeniedHint('bot-authors-disabled');
    expect(hint).toContain('other bots');
    expect(hint).toContain('real Discord user account');
  });
  it('returns undefined for unrecognised reasons (no fabricated hint)', () => {
    expect(buildAccessDeniedHint('something-novel')).toBeUndefined();
  });
});

describe('renderAccessDenied includes the hint when applicable', () => {
  it('appends the hint line under the bare reason for known reason kinds', () => {
    const payload = renderAccessDenied('subagents', {
      status: 'denied',
      reason: 'admin-required',
    });
    expect(payload.content).toContain(
      'Discord request denied for `subagents`.',
    );
    expect(payload.content).toContain('Reason: admin-required');
    expect(payload.content).toContain('💡 This command is admin-only');
  });
  it('omits the hint line when the reason is not recognised', () => {
    const payload = renderAccessDenied('whatever', {
      status: 'denied',
      reason: 'novel-reason',
    });
    expect(payload.content).toContain('Reason: novel-reason');
    expect(payload.content).not.toContain('💡');
  });
});

// UX-9 — /tasks empty state guides next action; archived view branches.

describe('renderTaskList empty state (UX-9)', () => {
  it('default view: hints at mentioning the bot or running /tasks archived', () => {
    const payload = renderTaskList([]);
    expect(payload.content).toContain('No visible Discord tasks');
    expect(payload.content).toContain('💡 Mention the bot');
    expect(payload.content).toContain('/tasks archived');
  });
  it('archived view: distinct empty wording + /archive guidance', () => {
    const payload = renderTaskList([], { archivedView: true });
    expect(payload.content).toContain('No archived Discord tasks');
    expect(payload.content).toContain('💡 `/tasks` (no `archived` argument)');
    expect(payload.content).toContain('/archive task_id:<id>');
    // Must NOT regress into the default-view wording.
    expect(payload.content).not.toContain('Mention the bot');
  });
});
