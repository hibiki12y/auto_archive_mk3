import { describe, expect, it } from 'vitest';

import {
  renderResearchMissionPinnedSummary,
  renderResearchMissionSummary,
} from '../src/discord/discord-result-renderer.js';

describe('renderResearchMissionSummary', () => {
  it('renders the mission summary sections from the §11.1 wireframe with mention-safe content', () => {
    const payload = renderResearchMissionSummary({
      missionId: 'R-20260509-a1',
      title: 'Auto Archive Mk3 Discord 연구 UX 개선',
      status: 'running',
      phase: 'evidence synthesis',
      owner: '@operator',
      threadLabel: '#research-runs / R-20260509-a1',
      plan: [
        { label: 'Hermes/OpenClaw baseline', state: 'complete' },
        { label: 'Auto Archive current audit', state: 'complete' },
        { label: 'Gap analysis', state: 'current' },
        { label: 'Discord-first proposal', state: 'pending' },
        { label: 'Implementation roadmap', state: 'pending' },
      ],
      evidenceCount: 9,
      claims: {
        supported: 6,
        uncertain: 2,
        challenged: 1,
      },
      proof: {
        pass: 3,
        warn: 4,
      },
      subagents: {
        total: 2,
        roles: [
          {
            role: 'collector',
            reserved: 0,
            spawning: 0,
            active: 1,
            terminating: 0,
            terminated: 0,
            failed: 0,
          },
          {
            role: 'critic',
            reserved: 1,
            spawning: 0,
            active: 0,
            terminating: 0,
            terminated: 0,
            failed: 0,
          },
        ],
      },
      nextActions: [
        { verb: 'run-critique', label: 'Run critique', style: 'primary' },
        { verb: 'synthesize', label: 'Synthesize', style: 'success' },
        { verb: 'show-evidence', label: 'Show evidence' },
        { verb: 'archive', label: 'Archive', style: 'danger' },
      ],
    });

    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.content).toContain('Research Mission `R-20260509-a1`');
    expect(payload.content).toContain(
      'Title: Auto Archive Mk3 Discord 연구 UX 개선',
    );
    expect(payload.content).toContain('Status: running');
    expect(payload.content).toContain('Phase: evidence synthesis');
    expect(payload.content).toContain('Owner: @\u200Boperator');
    expect(payload.content).toContain('Thread: #research-runs / R-20260509-a1');
    expect(payload.content).toContain('Plan:');
    expect(payload.content).toContain('✓ 1. Hermes/OpenClaw baseline');
    expect(payload.content).toContain('✓ 2. Auto Archive current audit');
    expect(payload.content).toContain('▶ 3. Gap analysis');
    expect(payload.content).toContain('□ 4. Discord-first proposal');
    expect(payload.content).toContain('□ 5. Implementation roadmap');
    expect(payload.content).toContain('Evidence: 9 items');
    expect(payload.content).toContain('Claims: 6 supported, 2 uncertain, 1 challenged');
    expect(payload.content).toContain('Proof: 3 PASS, 4 WARN');
    expect(payload.content).toContain('Subagents: 2 mission matches');
    expect(payload.content).toContain(
      'Subagent roles: collector 1 active; critic 1 reserved',
    );
    expect(payload.content).toContain(
      'Next: [Run critique] [Synthesize] [Show evidence] [Archive]',
    );

    expect(payload.components).toBeDefined();
    expect(payload.components).toHaveLength(1);
    expect(payload.components![0]?.components).toHaveLength(4);
    expect(payload.components![0]?.components[0]).toEqual({
      kind: 'button',
      customId: 'research-mission:run-critique:R-20260509-a1',
      label: 'Run critique',
      style: 'primary',
    });
    expect(payload.components![0]?.components[1]).toEqual({
      kind: 'button',
      customId: 'research-mission:synthesize:R-20260509-a1',
      label: 'Synthesize',
      style: 'success',
    });
    expect(payload.components![0]?.components[2]).toEqual({
      kind: 'button',
      customId: 'research-mission:show-evidence:R-20260509-a1',
      label: 'Show evidence',
      style: 'secondary',
    });
    expect(payload.components![0]?.components[3]).toEqual({
      kind: 'button',
      customId: 'research-mission:archive:R-20260509-a1',
      label: 'Archive',
      style: 'danger',
    });
  });

  it('omits components and renders a no-actions hint when no next actions are supplied', () => {
    const payload = renderResearchMissionSummary({
      missionId: 'R-20260509-b2',
      title: 'Proof sweep',
      status: 'blocked',
      phase: 'proof capture',
      owner: '@reviewer',
      threadLabel: '#research-control / proof-sweep',
      plan: [{ label: 'Collect missing proof rows', state: 'current' }],
      evidenceCount: 1,
      claims: {
        supported: 0,
        uncertain: 1,
        challenged: 0,
      },
      proof: {
        pass: 0,
        warn: 1,
        fail: 2,
      },
    });

    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.components).toBeUndefined();
    expect(payload.content).toContain('▶ 1. Collect missing proof rows');
    expect(payload.content).toContain('Evidence: 1 item');
    expect(payload.content).toContain('Claims: 0 supported, 1 uncertain, 0 challenged');
    expect(payload.content).toContain('Proof: 0 PASS, 1 WARN, 2 FAIL');
    expect(payload.content).toContain('Next: none queued.');
    expect(payload.content).toContain('Owner: @\u200Breviewer');
  });

  it('can surface a configured live-proof report status without replacing mission proof counts', () => {
    const payload = renderResearchMissionSummary({
      missionId: 'R-20260510-proof-report',
      title: 'Proof report bridge',
      status: 'running',
      phase: 'proof review',
      owner: '@operator',
      threadLabel: '#research-runs / proof-report',
      plan: [{ label: 'Review configured proof manifest', state: 'current' }],
      evidenceCount: 2,
      claims: {
        supported: 1,
        uncertain: 1,
        challenged: 0,
      },
      proof: {
        pass: 0,
        warn: 0,
      },
      proofReport: {
        reportStatus: 'warn',
        completeProofCount: 1,
        warnProofCount: 1,
        failProofCount: 0,
        missingRequiredArtifactCount: 3,
        sourceLabel:
          'configured live-proof manifest (global; mission-scoped linking later)',
      },
    });

    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.content).toContain('Proof: 0 PASS, 0 WARN');
    expect(payload.content).toContain(
      'Proof report: warn (configured live-proof manifest (global; mission-scoped linking later))',
    );
    expect(payload.content).toContain(
      'Proof report counts: 1 complete, 1/0 warn/fail, 3 missing artifact tokens',
    );
  });

  it('keeps research-mission button customIds parse-safe and within Discord limits', () => {
    const payload = renderResearchMissionSummary({
      missionId: `R:20260509:${'very-long-mission-id-'.repeat(5)}`,
      title: 'Mission id normalization',
      status: 'draft',
      phase: 'planning',
      owner: '@operator',
      threadLabel: '#research-control',
      plan: [],
      evidenceCount: 0,
      claims: {
        supported: 0,
        uncertain: 0,
        challenged: 0,
      },
      proof: {
        pass: 0,
        warn: 0,
      },
      nextActions: [
        {
          verb: 'run:critique/with spaces and extra long suffix',
          label: 'Run critique',
        },
      ],
    });

    expect(payload.content).toContain('Plan:');
    expect(payload.content).toContain('Evidence: 0 items');
    expect(payload.content).toContain('Next: [Run critique]');
    const customId = payload.components![0]!.components[0]!.customId;
    expect(customId).toMatch(/^research-mission:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/u);
    expect(customId).toBe(
      'research-mission:run-critique-with-spaces-and-ext:R-20260509-very-long-mission-id-very-long-missio',
    );
    expect(customId.length).toBeLessThanOrEqual(100);
  });

  it('renders a compact pin-ready mission summary with progress and no mentions', () => {
    const payload = renderResearchMissionPinnedSummary({
      missionId: 'R-20260509-pin',
      title: 'Pinned 연구 작전실',
      status: 'running',
      phase: 'evidence synthesis',
      owner: '@operator',
      threadLabel: '#research-runs / @mission-thread',
      plan: [
        { label: 'Baseline comparison', state: 'complete' },
        { label: 'Current audit', state: 'complete' },
        { label: 'Gap analysis', state: 'current' },
        { label: 'Roadmap', state: 'pending' },
      ],
      evidenceCount: 3,
      claims: {
        supported: 2,
        uncertain: 1,
        challenged: 0,
      },
      proof: {
        pass: 1,
        warn: 2,
      },
      subagents: {
        total: 1,
        roles: [
          {
            role: 'collector',
            reserved: 0,
            spawning: 0,
            active: 1,
            terminating: 0,
            terminated: 0,
            failed: 0,
          },
        ],
      },
      nextActions: [
        { verb: 'status', label: 'Status' },
        { verb: 'archive', label: 'Archive', style: 'danger' },
      ],
    });

    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.content).toContain('📌 Research Mission Pin `R-20260509-pin`');
    expect(payload.content).toContain('Status: running · Phase: evidence synthesis');
    expect(payload.content).toContain('Thread: #research-runs / @\u200Bmission-thread');
    expect(payload.content).toContain('Progress: 2/4 plan steps complete');
    expect(payload.content).toContain('Current: Gap analysis');
    expect(payload.content).toContain(
      'Evidence: 3 items · Claims: 2 supported, 1 uncertain, 0 challenged · Proof: 1 PASS, 2 WARN · Subagents: collector 1 active',
    );
    expect(payload.content).toContain('Next: [Status] [Archive]');
    expect(payload.components?.[0]?.components).toEqual([
      expect.objectContaining({ customId: 'research-mission:status:R-20260509-pin' }),
      expect.objectContaining({ customId: 'research-mission:archive:R-20260509-pin' }),
    ]);
  });

  it('can surface the configured live-proof report status in the pin-ready card', () => {
    const payload = renderResearchMissionPinnedSummary({
      missionId: 'R-20260510-pin-proof',
      title: 'Pinned proof report',
      status: 'running',
      phase: 'proof review',
      owner: '@operator',
      threadLabel: '#research-runs / proof-report',
      plan: [{ label: 'Review configured proof manifest', state: 'current' }],
      evidenceCount: 2,
      claims: {
        supported: 1,
        uncertain: 1,
        challenged: 0,
      },
      proof: {
        pass: 0,
        warn: 0,
      },
      proofReport: {
        reportStatus: 'warn',
        completeProofCount: 1,
        warnProofCount: 1,
        failProofCount: 0,
        missingRequiredArtifactCount: 3,
        sourceLabel:
          'configured live-proof manifest (global; mission-scoped linking later)',
      },
    });

    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.content).toContain(
      'Proof: 0 PASS, 0 WARN · Report: warn, 3 missing',
    );
  });

  it('keeps the pin-ready card compact and sanitizes hostile dynamic fields', () => {
    const payload = renderResearchMissionPinnedSummary({
      missionId: 'R-`@everyone',
      title: `${'title '.repeat(80)}\`@everyone`,
      status: 'running`@everyone',
      phase: `${'phase '.repeat(50)}\`@everyone`,
      owner: '@operator',
      threadLabel: `${'#research-runs/'.repeat(30)}\`@everyone`,
      plan: [
        { label: 'done', state: 'complete' },
        { label: `${'current '.repeat(50)}\`@everyone`, state: 'current' },
      ],
      evidenceCount: 123,
      claims: {
        supported: 45,
        uncertain: 6,
        challenged: 7,
      },
      proof: {
        pass: 8,
        warn: 9,
        fail: 10,
      },
      nextActions: Array.from({ length: 12 }, (_, index) => ({
        verb: `action-${index}`,
        label: `${index}-${'label '.repeat(20)}`,
      })),
    });

    expect(payload.content.length).toBeLessThan(2000);
    expect(payload.content).not.toContain('@everyone');
    expect(payload.content).not.toContain('`@');
    expect(payload.content).toContain('R-ʼ@\u200Beveryone');
    expect(payload.content).toContain('Proof: 8 PASS, 9 WARN, 10 FAIL');
    expect(payload.content).toContain('[0-label');
    expect(payload.content).toContain('[4-label');
    expect(payload.content).not.toContain('[5-label');
    expect(payload.components).toHaveLength(1);
    expect(payload.components?.[0]?.components).toHaveLength(5);
  });
});
