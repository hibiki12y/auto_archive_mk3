import { describe, expect, it } from 'vitest';

import {
  DISCORD_MESSAGE_LIMIT,
  renderResearchClaimAdded,
  renderResearchClaimLinked,
  renderResearchClaimList,
  renderResearchEvidenceAdded,
  renderResearchEvidenceList,
  renderResearchStateOptionRequired,
  renderResearchSynthesis,
} from '../src/discord/discord-result-renderer.js';

describe('research evidence/claim renderers', () => {
  it('renders mention-safe evidence add/list payloads', () => {
    const evidence = {
      evidenceId: 'E-`@everyone',
      summary:
        'Terminal result supports `@everyone @here <@!123> <@&456> <#789> ```claim```',
      source: 'terminal:@operator <@123>',
      createdBy: 'operator',
      createdAt: '2026-05-10T02:00:00.000Z',
    };

    const added = renderResearchEvidenceAdded({
      missionId: 'R-`@everyone',
      evidence,
      evidenceCount: 1,
    });
    const listed = renderResearchEvidenceList({
      missionId: 'R-`@everyone',
      evidence: [evidence],
    });

    for (const payload of [added, listed]) {
      expect(payload.allowedMentions).toEqual({ parse: [] });
      expect(payload.content).not.toContain('@everyone');
      expect(payload.content).not.toContain('@here');
      expect(payload.content).not.toContain('<@!');
      expect(payload.content).not.toContain('<@&');
      expect(payload.content).not.toMatch(/<#[0-9]+>/u);
      expect(payload.content).not.toContain('`@');
      expect(payload.content).not.toContain('```');
    }
    expect(added.content).toContain('Mission evidence count: 1');
    expect(listed.content).toContain('Evidence for research mission');
  });

  it('renders claim add/link/list payloads with summary counts', () => {
    const claim = {
      claimId: 'C-claim-1',
      text: 'Pinned summaries reduce state lookup time.',
      status: 'supported',
      supportEvidenceIds: ['E-1'],
      challengeEvidenceIds: [],
    };

    const added = renderResearchClaimAdded({
      missionId: 'R-claim-1',
      claim: { ...claim, status: 'uncertain', supportEvidenceIds: [] },
      claims: { supported: 0, uncertain: 1, challenged: 0 },
    });
    const linked = renderResearchClaimLinked({
      missionId: 'R-claim-1',
      claim,
      evidenceId: 'E-1',
      mode: 'support',
      claims: { supported: 1, uncertain: 0, challenged: 0 },
    });
    const listed = renderResearchClaimList({
      missionId: 'R-claim-1',
      claims: [claim],
    });

    expect(added.allowedMentions).toEqual({ parse: [] });
    expect(added.content).toContain(
      'Mission claims: 0 supported, 1 uncertain, 0 challenged',
    );
    expect(linked.content).toContain('Evidence `E-1` now supports claim');
    expect(linked.content).toContain(
      'Mission claims: 1 supported, 0 uncertain, 0 challenged',
    );
    expect(listed.content).toContain('[supported]');
    expect(listed.content).toContain('(support:1, challenge:0)');
  });

  it('renders command option guidance without enabling mentions', () => {
    const payload = renderResearchStateOptionRequired({
      command: 'claim',
      action: 'support',
      option: 'evidence_id',
      hint: 'Use `/evidence action:list mission_id:<id>` to copy @everyone.',
    });

    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.content).toContain('`/claim action:support` requires option');
    expect(payload.content).not.toContain('@everyone');
  });

  it('renders claim/evidence synthesis drafts with mention-safe basis lines', () => {
    const payload = renderResearchSynthesis({
      missionId: 'R-`@everyone',
      synthesisId: 'S-1',
      body: [
        'Evidence-backed synthesis draft for R-`@everyone: hostile @everyone <@!123> ```',
        'Supported claims (1):',
        '- C-1 [supported] `@everyone claim` (support: E-1)',
        ...Array.from(
          { length: 12 },
          (_, index) => `extra synthesis line ${index + 1}`,
        ),
      ].join('\n'),
      evidenceCount: 1,
      claims: { supported: 1, uncertain: 0, challenged: 0 },
      createdBy: '@operator',
      createdAt: '2026-05-10T02:00:00.000Z',
    });

    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.content).toContain('Synthesis draft `S-1`');
    expect(payload.content).toContain('Evidence basis: 1 item');
    expect(payload.content).toContain(
      'Claims: 1 supported, 0 uncertain, 0 challenged',
    );
    expect(payload.content).toContain('support: E-1');
    expect(payload.content).toContain('… 3 more synthesis line(s) omitted.');
    expect(payload.content).not.toContain('@everyone');
    expect(payload.content).not.toContain('<@!');
    expect(payload.content).not.toContain('`@');
  });

  it('keeps synthesis drafts within the Discord message limit by omitting body lines', () => {
    const payload = renderResearchSynthesis({
      missionId: 'R-long',
      synthesisId: 'S-long',
      body: Array.from(
        { length: 12 },
        (_, index) => `long synthesis line ${index + 1} ${'x'.repeat(1_000)}`,
      ).join('\n'),
      evidenceCount: 12,
      claims: { supported: 12, uncertain: 0, challenged: 0 },
      createdBy: 'operator',
      createdAt: '2026-05-10T02:05:00.000Z',
    });

    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.content.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect(payload.content).toContain('more synthesis line(s) omitted.');
    expect(payload.content).toContain('archive closeout is a later slice');
  });
});
