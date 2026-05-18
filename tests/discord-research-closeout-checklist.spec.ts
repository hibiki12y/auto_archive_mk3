import { describe, expect, it } from 'vitest';

import { renderResearchCloseoutChecklist } from '../src/discord/discord-result-renderer.js';

describe('renderResearchCloseoutChecklist', () => {
  it('renders the closeout checklist sections from the §11.3 wireframe', () => {
    const payload = renderResearchCloseoutChecklist({
      missionId: 'R-20260509-a1',
      required: [
        { text: 'all subtasks terminal', state: 'complete' },
        { text: 'synthesis report exists', state: 'complete' },
        { text: 'evidence ledger retained', state: 'complete' },
        { text: 'proof has WARN rows', state: 'warning' },
        { text: 'one claim remains uncertain', state: 'warning' },
      ],
      evalSignals: [
        { text: 'acceptance coverage 4/5 plan steps complete', state: 'warning' },
        { text: 'unresolved claims 1', state: 'warning' },
        { text: 'constraint reports 0 recorded (unavailable)', state: 'pending' },
        { text: 'live-proof linkage 1 mission-local proof link', state: 'complete' },
      ],
      recommended: [
        'Run /critique lens:counterargument',
        'Capture durable-task-archive proof',
        'Record GitLab closeout',
      ],
      actions: [
        { verb: 'archive-anyway', label: 'Archive anyway', style: 'danger' },
        { verb: 'run-missing-proof', label: 'Run missing proof', style: 'primary' },
        { verb: 'cancel', label: 'Cancel' },
      ],
    });

    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.content).toContain('Closeout for `R-20260509-a1`');
    expect(payload.content).toContain('Required:');
    expect(payload.content).toContain('✓ all subtasks terminal');
    expect(payload.content).toContain('✓ synthesis report exists');
    expect(payload.content).toContain('✓ evidence ledger retained');
    expect(payload.content).toContain('! proof has WARN rows');
    expect(payload.content).toContain('! one claim remains uncertain');
    expect(payload.content).toContain('Eval:');
    expect(payload.content).toContain('! acceptance coverage 4/5 plan steps complete');
    expect(payload.content).toContain('! unresolved claims 1');
    expect(payload.content).toContain('□ constraint reports 0 recorded (unavailable)');
    expect(payload.content).toContain('✓ live-proof linkage 1 mission-local proof link');
    expect(payload.content).toContain('Recommended:');
    expect(payload.content).toContain('- Run /critique lens:counterargument');
    expect(payload.content).toContain('- Capture durable-task-archive proof');
    expect(payload.content).toContain('- Record GitLab closeout');
    expect(payload.content).toContain(
      'Actions: [Archive anyway] [Run missing proof] [Cancel]',
    );

    expect(payload.components).toBeDefined();
    expect(payload.components).toHaveLength(1);
    expect(payload.components![0]!.components).toHaveLength(3);
    expect(payload.components![0]!.components[0]).toEqual({
      kind: 'button',
      customId: 'research-closeout:archive-anyway:R-20260509-a1',
      label: 'Archive anyway',
      style: 'danger',
    });
    expect(payload.components![0]!.components[1]).toEqual({
      kind: 'button',
      customId: 'research-closeout:run-missing-proof:R-20260509-a1',
      label: 'Run missing proof',
      style: 'primary',
    });
    expect(payload.components![0]!.components[2]).toEqual({
      kind: 'button',
      customId: 'research-closeout:cancel:R-20260509-a1',
      label: 'Cancel',
      style: 'secondary',
    });
  });

  it('keeps mission/check text mention-safe and omits components without actions', () => {
    const payload = renderResearchCloseoutChecklist({
      missionId: '@everyone',
      required: [{ text: '@operator approval recorded', state: 'pending' }],
    });

    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.components).toBeUndefined();
    expect(payload.content).toContain('Closeout for `@\u200Beveryone`');
    expect(payload.content).toContain('□ @\u200Boperator approval recorded');
    expect(payload.content).toContain('Eval:');
    expect(payload.content).toContain('□ no eval signals supplied');
    expect(payload.content).toContain('Recommended:');
    expect(payload.content).toContain('- none');
    expect(payload.content).toContain('Actions: none queued.');
  });

  it('normalizes research-closeout customIds and keeps them within Discord limits', () => {
    const payload = renderResearchCloseoutChecklist({
      missionId: `R:20260510:${'very-long-mission-id-'.repeat(5)}`,
      required: [],
      actions: [
        {
          verb: 'archive:anyway/with spaces and extra long suffix',
          label: 'Archive anyway',
        },
        {
          verb: '🔥🔥🔥',
          label: 'Fallback action',
        },
      ],
    });

    const [archiveAnyway, fallback] = payload.components![0]!.components;
    expect(archiveAnyway!.customId).toBe(
      'research-closeout:archive-anyway-with-spaces-and-e:R-20260510-very-long-mission-id-very-long-missio',
    );
    expect(archiveAnyway!.customId).toMatch(
      /^research-closeout:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/u,
    );
    expect(archiveAnyway!.customId.length).toBeLessThanOrEqual(100);
    expect(fallback!.customId).toBe(
      'research-closeout:action:R-20260510-very-long-mission-id-very-long-missio',
    );

    const fallbackMissionId = renderResearchCloseoutChecklist({
      missionId: '🔥🔥🔥',
      required: [],
      actions: [{ verb: 'cancel', label: 'Cancel' }],
    });
    expect(fallbackMissionId.components![0]!.components[0]!.customId).toBe(
      'research-closeout:cancel:mission',
    );
  });

  it('caps dense checklist text while preserving component rows', () => {
    const payload = renderResearchCloseoutChecklist({
      missionId: 'dense-closeout',
      required: Array.from({ length: 12 }, (_, index) => ({
        text: `required-${index}-${'x'.repeat(400)}`,
        state: index % 2 === 0 ? 'complete' : 'warning',
      })),
      recommended: Array.from(
        { length: 9 },
        (_, index) => `recommendation-${index}-${'y'.repeat(400)}`,
      ),
      evalSignals: Array.from({ length: 8 }, (_, index) => ({
        text: `eval-${index}-${'e'.repeat(400)}`,
        state: index % 2 === 0 ? 'complete' : 'warning',
      })),
      actions: Array.from({ length: 10 }, (_, index) => ({
        verb: `action-${index}`,
        label: `Action ${index} ${'z'.repeat(120)}`,
      })),
    });

    expect(payload.content.length).toBeLessThanOrEqual(2000);
    expect(payload.content).toContain('□ … 7 more required checks omitted');
    expect(payload.content).toContain('□ … 4 more eval signals omitted');
    expect(payload.content).toContain('- … 6 more recommendations omitted');
    expect(payload.content).toContain('(+7 more actions)');
    expect(payload.components).toHaveLength(2);
    expect(payload.components![0]!.components).toHaveLength(5);
    expect(payload.components![1]!.components).toHaveLength(5);
  });
});
