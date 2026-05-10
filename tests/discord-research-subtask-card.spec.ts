import { describe, expect, it } from 'vitest';

import { renderResearchSubtaskCard } from '../src/discord/discord-result-renderer.js';

describe('renderResearchSubtaskCard', () => {
  it('renders the subtask card sections from the §11.2 wireframe', () => {
    const payload = renderResearchSubtaskCard({
      subtaskId: 'R-20260509-a1-subtask-03-gap-analysis',
      index: 3,
      total: 5,
      title: 'Gap analysis',
      status: 'running',
      role: 'critic',
      provider: 'codex',
      startedAt: '2026-05-09T14:00:00.000Z',
      recentEvents: [
        { text: 'source compared: OpenClaw subagents' },
        { text: 'claim challenged: "manual archive is enough"' },
        { text: 'evidence added: E-007' },
      ],
      actions: [
        { verb: 'status', label: 'Status' },
        { verb: 'steer', label: 'Steer', style: 'primary' },
        { verb: 'cancel', label: 'Cancel', style: 'danger' },
        { verb: 'open-history', label: 'Open history' },
      ],
    });

    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.content).toContain('Subtask 3/5: Gap analysis');
    expect(payload.content).toContain('Status: running');
    expect(payload.content).toContain('Role: critic');
    expect(payload.content).toContain('Provider: codex');
    expect(payload.content).toContain('Started: 2026-05-09T14:00:00.000Z');
    expect(payload.content).toContain('Recent events:');
    expect(payload.content).toContain('- source compared: OpenClaw subagents');
    expect(payload.content).toContain(
      '- claim challenged: "manual archive is enough"',
    );
    expect(payload.content).toContain('- evidence added: E-007');
    expect(payload.content).toContain(
      'Actions: [Status] [Steer] [Cancel] [Open history]',
    );

    expect(payload.components).toBeDefined();
    expect(payload.components).toHaveLength(1);
    expect(payload.components![0]!.components).toHaveLength(4);
    expect(payload.components![0]!.components[0]).toEqual({
      kind: 'button',
      customId:
        'research-subtask:status:R-20260509-a1-subtask-03-gap-analysis',
      label: 'Status',
      style: 'secondary',
    });
    expect(payload.components![0]!.components[1]).toEqual({
      kind: 'button',
      customId:
        'research-subtask:steer:R-20260509-a1-subtask-03-gap-analysis',
      label: 'Steer',
      style: 'primary',
    });
    expect(payload.components![0]!.components[2]).toEqual({
      kind: 'button',
      customId:
        'research-subtask:cancel:R-20260509-a1-subtask-03-gap-analysis',
      label: 'Cancel',
      style: 'danger',
    });
    expect(payload.components![0]!.components[3]).toEqual({
      kind: 'button',
      customId:
        'research-subtask:open-history:R-20260509-a1-subtask-03-gap-analysis',
      label: 'Open history',
      style: 'secondary',
    });
  });

  it('keeps free-form fields mention-safe and omits components without actions', () => {
    const payload = renderResearchSubtaskCard({
      subtaskId: 'subtask-1',
      index: 1,
      total: 1,
      title: '@everyone proof sweep',
      status: 'blocked',
      role: '@critic',
      provider: 'claude-agent',
      startedAt: 'not-started',
    });

    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.components).toBeUndefined();
    expect(payload.content).toContain('Subtask 1/1: @\u200Beveryone proof sweep');
    expect(payload.content).toContain('Role: @\u200Bcritic');
    expect(payload.content).toContain('Recent events:');
    expect(payload.content).toContain('- none yet');
    expect(payload.content).toContain('Actions: none queued.');
  });

  it('normalizes research-subtask customIds and keeps them within Discord limits', () => {
    const payload = renderResearchSubtaskCard({
      subtaskId: `S:20260510:${'very-long-subtask-id-'.repeat(5)}`,
      index: 1,
      total: 2,
      title: 'Custom id normalization',
      status: 'queued',
      role: 'planner',
      provider: 'codex',
      startedAt: '2026-05-10T00:00:00.000Z',
      recentEvents: [],
      actions: [
        {
          verb: 'open:history/with spaces and extra long suffix',
          label: 'Open history',
        },
        {
          verb: '🔥🔥🔥',
          label: 'Fallback action',
        },
      ],
    });

    const [openHistory, fallback] = payload.components![0]!.components;
    expect(openHistory!.customId).toBe(
      'research-subtask:open-history-with-spaces-and-ext:S-20260510-very-long-subtask-id-very-long-subtas',
    );
    expect(openHistory!.customId).toMatch(
      /^research-subtask:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/u,
    );
    expect(openHistory!.customId.length).toBeLessThanOrEqual(100);
    expect(fallback!.customId).toBe(
      'research-subtask:action:S-20260510-very-long-subtask-id-very-long-subtas',
    );
    expect(fallback!.customId.length).toBeLessThanOrEqual(100);

    const fallbackSubtaskId = renderResearchSubtaskCard({
      subtaskId: '🔥🔥🔥',
      index: 1,
      total: 1,
      title: 'Fallback subtask id',
      status: 'queued',
      role: 'planner',
      provider: 'codex',
      startedAt: '2026-05-10T00:00:00.000Z',
      actions: [{ verb: 'status', label: 'Status' }],
    });
    expect(fallbackSubtaskId.components![0]!.components[0]!.customId).toBe(
      'research-subtask:status:subtask',
    );
  });

  it('caps dense event/action text while preserving component rows', () => {
    const payload = renderResearchSubtaskCard({
      subtaskId: 'subtask-dense-card',
      index: 12,
      total: 20,
      title: 'T'.repeat(400),
      status: 'running'.repeat(20),
      role: '@critic'.repeat(20),
      provider: 'codex'.repeat(40),
      startedAt: '2026-05-10T00:00:00.000Z'.repeat(10),
      recentEvents: Array.from({ length: 9 }, (_, index) => ({
        text: `event-${index}-${'x'.repeat(400)}`,
      })),
      actions: Array.from({ length: 10 }, (_, index) => ({
        verb: `action-${index}`,
        label: `Action ${index} ${'y'.repeat(120)}`,
      })),
    });

    expect(payload.content.length).toBeLessThanOrEqual(2000);
    expect(payload.content).toContain('- … 6 more events omitted');
    expect(payload.content).toContain('(+6 more actions)');
    expect(payload.components).toHaveLength(2);
    expect(payload.components![0]!.components).toHaveLength(5);
    expect(payload.components![1]!.components).toHaveLength(5);
  });
});
