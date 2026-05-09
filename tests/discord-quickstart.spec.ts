import { describe, expect, it } from 'vitest';

import { renderQuickstart } from '../src/discord/discord-result-renderer.js';

// UX-12 — onboarding card surface for /quickstart.

describe('renderQuickstart', () => {
  it('opens with a "first 60 seconds" Quickstart heading', () => {
    const payload = renderQuickstart({
      recentTerminalTaskIds: [],
      recentActiveTaskIds: [],
    });
    expect(payload.content).toContain('Quickstart — first 60 seconds');
  });

  it('teaches the four primary onboarding actions', () => {
    const payload = renderQuickstart({
      recentTerminalTaskIds: [],
      recentActiveTaskIds: [],
    });
    // 1. mention the bot
    expect(payload.content).toContain('Mention the bot');
    // 2. /tasks discovery
    expect(payload.content).toContain('/tasks');
    // 3. /status fastest-check
    expect(payload.content).toContain('/status task_id:<id>');
    // 4. /research-plan multi-sub-task
    expect(payload.content).toContain('/research-plan plan-id:<id>');
  });

  it('shows the empty-state hint when no recent tasks exist', () => {
    const payload = renderQuickstart({
      recentTerminalTaskIds: [],
      recentActiveTaskIds: [],
    });
    expect(payload.content).toContain('mention the bot to start one');
    expect(payload.content).toContain('In flight: (none');
  });

  it('renders up to 3 recent terminal task ids when supplied', () => {
    const payload = renderQuickstart({
      recentTerminalTaskIds: [
        'discord-task-aaa',
        'discord-task-bbb',
        'discord-task-ccc',
        'discord-task-ddd-cap',
      ],
      recentActiveTaskIds: [],
    });
    expect(payload.content).toContain('`discord-task-aaa`');
    expect(payload.content).toContain('`discord-task-bbb`');
    expect(payload.content).toContain('`discord-task-ccc`');
    // Capped at 3 — the fourth must NOT appear.
    expect(payload.content).not.toContain('`discord-task-ddd-cap`');
  });

  it('renders up to 3 active in-flight task ids when supplied', () => {
    const payload = renderQuickstart({
      recentTerminalTaskIds: [],
      recentActiveTaskIds: ['discord-task-active-1', 'discord-task-active-2'],
    });
    expect(payload.content).toContain('In flight:');
    expect(payload.content).toContain('`discord-task-active-1`');
    expect(payload.content).toContain('`discord-task-active-2`');
  });

  it('points operators to /help for the full surface', () => {
    const payload = renderQuickstart({
      recentTerminalTaskIds: [],
      recentActiveTaskIds: [],
    });
    expect(payload.content).toContain('💡');
    expect(payload.content).toContain('/help');
  });

  it('lists the most-used inspection + control verbs operators reach for', () => {
    const payload = renderQuickstart({
      recentTerminalTaskIds: [],
      recentActiveTaskIds: [],
    });
    for (const surface of [
      '/tasks',
      '/status task_id:<id>',
      '/history task_id:<id>',
      '/feed',
      '/cancel task_id:<id>',
      '/rerun task_id:<id>',
      '/archive task_id:<id>',
    ]) {
      expect(payload.content).toContain(surface);
    }
  });
});
