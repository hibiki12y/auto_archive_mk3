import { describe, expect, it } from 'vitest';

import {
  DiscordResearchMissionStore,
  InMemoryControlPlaneLedger,
  renderResearchMissionSummary,
  researchMissionToSummaryInput,
} from '../src/index.js';

describe('DiscordResearchMissionStore', () => {
  it('creates a draft mission with a plan draft and current-channel binding', () => {
    const store = new DiscordResearchMissionStore({
      idFactory: () => '20260510-a1',
      now: () => '2026-05-10T00:00:00.000Z',
    });

    const mission = store.createDraft({
      goal: 'OpenClaw/Hermes 대비 Auto Archive 연구 UX 개선',
      title: 'Auto Archive Mk3 Discord 연구 UX 개선',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });

    expect(mission).toMatchObject({
      missionId: 'R-20260510-a1',
      status: 'draft',
      phase: 'plan draft',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
      evidenceItemCount: 0,
      claims: { supported: 0, uncertain: 0, challenged: 0 },
      proof: { pass: 0, warn: 0 },
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:00.000Z',
    });
    expect(mission.discordThreadId).toBeUndefined();
    expect(mission.planDraft).toHaveLength(5);
    expect(mission.planDraft[0]).toEqual({
      label: 'Clarify scope for OpenClaw/Hermes 대비 Auto Archive 연구 UX 개선',
      state: 'current',
    });

    const summary = researchMissionToSummaryInput(mission);
    expect(summary).toMatchObject({
      missionId: 'R-20260510-a1',
      status: 'draft',
      phase: 'plan draft',
      owner: '@operator',
      threadLabel: 'research-runs',
      evidenceCount: 0,
    });
    expect(renderResearchMissionSummary(summary).content).toContain(
      'Next: [Approve plan] [Show plan] [Cancel]',
    );
  });

  it('binds a Discord thread and updates the summary thread label', () => {
    let tick = 0;
    const store = new DiscordResearchMissionStore({
      idFactory: () => '20260510-b2',
      now: () => `2026-05-10T00:00:0${tick++}.000Z`,
    });
    const mission = store.createDraft({
      goal: 'Thread binding proof',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });

    const bound = store.bindThread({
      missionId: mission.missionId,
      discordThreadId: 'R-20260510-b2',
      actorId: 'operator',
    });

    expect(bound?.discordThreadId).toBe('R-20260510-b2');
    expect(bound?.updatedAt).toBe('2026-05-10T00:00:01.000Z');
    expect(store.toSummaryInput(mission.missionId)?.threadLabel).toBe(
      'research-runs / R-20260510-b2',
    );
  });

  it('approves a mission and replays mission state from the control ledger', () => {
    let tick = 0;
    const ledger = new InMemoryControlPlaneLedger();
    const now = (): string => `2026-05-10T00:00:0${tick++}.000Z`;
    const producer = new DiscordResearchMissionStore({
      ledger,
      idFactory: () => '20260510-c3',
      now,
    });
    const mission = producer.createDraft({
      goal: 'Approve via existing research-plan orchestrator',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
      planDraft: [
        { label: 'Plan draft created', state: 'complete' },
        { label: 'Await operator approval', state: 'current' },
      ],
    });
    producer.bindThread({
      missionId: mission.missionId,
      discordThreadId: 'thread-c3',
      actorId: 'operator',
    });
    const approved = producer.approve({
      missionId: mission.missionId,
      planId: 'plan-c3',
      actorId: 'operator',
    });

    expect(approved).toMatchObject({
      status: 'approved',
      phase: 'approved',
      planId: 'plan-c3',
      approvedAt: '2026-05-10T00:00:02.000Z',
    });
    expect(
      ledger
        .loadAll()
        .map((event) => event.type)
        .filter((type) => type.startsWith('research.mission_')),
    ).toEqual([
      'research.mission_draft_created',
      'research.mission_thread_bound',
      'research.mission_approved',
    ]);

    const replayed = new DiscordResearchMissionStore({ ledger });
    expect(replayed.get(mission.missionId)).toEqual(approved);
    expect(replayed.toSummaryInput(mission.missionId)?.nextActions).toEqual([
      { verb: 'status', label: 'Status' },
      { verb: 'synthesize', label: 'Synthesize', style: 'primary' },
      { verb: 'show-evidence', label: 'Show evidence' },
      { verb: 'archive', label: 'Archive', style: 'danger' },
    ]);
  });

  it('records evidence and claim links with replayable mission summary counts', () => {
    let tick = 0;
    let id = 0;
    const ledger = new InMemoryControlPlaneLedger();
    const store = new DiscordResearchMissionStore({
      ledger,
      idFactory: () => `20260510-e${++id}`,
      now: () => `2026-05-10T00:00:0${tick++}.000Z`,
    });
    const mission = store.createDraft({
      goal: 'Evidence claim UX',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });

    const evidence = store.addEvidence({
      missionId: mission.missionId,
      summary: 'TerminalEvidence retained for baseline comparison',
      source: 'terminal:task-baseline',
      actorId: 'operator',
    });
    const claim = store.addClaim({
      missionId: mission.missionId,
      text: 'Discord mission summaries reduce intermediate state lookup time.',
      actorId: 'operator',
    });
    expect(evidence).toBeDefined();
    expect(claim).toBeDefined();
    if (evidence === undefined || claim === undefined) {
      throw new Error('expected evidence and claim to be created');
    }
    const linked = store.linkEvidenceToClaim({
      missionId: mission.missionId,
      claimId: claim.claim.claimId,
      evidenceId: evidence.evidence.evidenceId,
      mode: 'support',
      actorId: 'operator',
    });

    expect(evidence?.mission.evidenceItemCount).toBe(1);
    expect(claim?.mission.claims).toEqual({
      supported: 0,
      uncertain: 1,
      challenged: 0,
    });
    expect(linked).toMatchObject({
      status: 'linked',
      claim: {
        status: 'supported',
        supportEvidenceIds: [evidence.evidence.evidenceId],
      },
      mission: {
        claims: { supported: 1, uncertain: 0, challenged: 0 },
      },
    });
    expect(store.toSummaryInput(mission.missionId)).toMatchObject({
      evidenceCount: 1,
      claims: { supported: 1, uncertain: 0, challenged: 0 },
    });
    expect(
      ledger
        .loadAll()
        .map((event) => event.type)
        .filter((type) => type.startsWith('research.')),
    ).toEqual([
      'research.mission_draft_created',
      'research.evidence_added',
      'research.claim_added',
      'research.claim_supported',
    ]);

    const replayed = new DiscordResearchMissionStore({ ledger });
    expect(replayed.listEvidence(mission.missionId)).toEqual([
      evidence.evidence,
    ]);
    expect(replayed.listClaims(mission.missionId)).toEqual([
      expect.objectContaining({
        claimId: claim.claim.claimId,
        status: 'supported',
        supportEvidenceIds: [evidence.evidence.evidenceId],
      }),
    ]);
    expect(replayed.toSummaryInput(mission.missionId)).toMatchObject({
      evidenceCount: 1,
      claims: { supported: 1, uncertain: 0, challenged: 0 },
    });
  });

  it('generates replayable synthesis drafts from linked claims and evidence', () => {
    let tick = 0;
    let id = 0;
    const ledger = new InMemoryControlPlaneLedger();
    const store = new DiscordResearchMissionStore({
      ledger,
      idFactory: () => `20260510-s${++id}`,
      now: () => `2026-05-10T00:00:0${tick++}.000Z`,
    });
    const mission = store.createDraft({
      goal: 'Claim evidence synthesis',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });
    const evidence = store.addEvidence({
      missionId: mission.missionId,
      summary: 'TerminalEvidence retained for synthesis',
      source: 'terminal:collect',
      actorId: 'operator',
    });
    const claim = store.addClaim({
      missionId: mission.missionId,
      text: 'Mission summaries should be evidence-backed.',
      actorId: 'operator',
    });
    expect(evidence).toBeDefined();
    expect(claim).toBeDefined();
    if (evidence === undefined || claim === undefined) {
      throw new Error('expected evidence and claim to be created');
    }
    store.linkEvidenceToClaim({
      missionId: mission.missionId,
      claimId: claim.claim.claimId,
      evidenceId: evidence.evidence.evidenceId,
      mode: 'support',
      actorId: 'operator',
    });

    const synthesis = store.generateSynthesis({
      missionId: mission.missionId,
      actorId: 'operator',
    });

    expect(synthesis).toMatchObject({
      mission: {
        status: 'synthesizing',
        phase: 'claim/evidence synthesis',
        latestSynthesisId: 'S-20260510-s4',
      },
      synthesis: {
        synthesisId: 'S-20260510-s4',
        evidence: [
          {
            evidenceId: evidence.evidence.evidenceId,
            summary: 'TerminalEvidence retained for synthesis',
            source: 'terminal:collect',
          },
        ],
        claims: [
          expect.objectContaining({
            claimId: claim.claim.claimId,
            status: 'supported',
            supportEvidenceIds: [evidence.evidence.evidenceId],
          }),
        ],
      },
    });
    expect(synthesis?.synthesis.body).toContain('Evidence-backed synthesis draft');
    expect(synthesis?.synthesis.body).toContain(
      `support: ${evidence.evidence.evidenceId}`,
    );
    expect(store.getLatestSynthesis(mission.missionId)).toEqual(
      synthesis?.synthesis,
    );

    const replayed = new DiscordResearchMissionStore({ ledger });
    expect(replayed.get(mission.missionId)).toMatchObject({
      latestSynthesisId: 'S-20260510-s4',
      status: 'synthesizing',
    });
    expect(replayed.getLatestSynthesis(mission.missionId)).toEqual(
      synthesis?.synthesis,
    );
    expect(
      ledger
        .loadAll()
        .map((event) => event.type)
        .filter((type) => type.startsWith('research.')),
    ).toEqual([
      'research.mission_draft_created',
      'research.evidence_added',
      'research.claim_added',
      'research.claim_supported',
      'research.synthesis_generated',
    ]);
  });

  it('handles empty and repeated synthesis generation deterministically', () => {
    let id = 0;
    const ledger = new InMemoryControlPlaneLedger();
    const store = new DiscordResearchMissionStore({
      ledger,
      idFactory: () => `empty-s${++id}`,
      now: () => '2026-05-10T00:00:00.000Z',
    });
    const mission = store.createDraft({
      goal: 'Empty synthesis boundary',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });

    const first = store.generateSynthesis({
      missionId: mission.missionId,
      actorId: 'operator',
    });
    const second = store.generateSynthesis({
      missionId: mission.missionId,
      actorId: 'operator',
    });

    expect(first?.synthesis.synthesisId).toBe('S-empty-s2');
    expect(first?.synthesis.body).toContain('Evidence basis: 0 items.');
    expect(first?.synthesis.body).toContain('Supported claims (0):');
    expect(second?.synthesis.synthesisId).toBe('S-empty-s3');
    expect(store.get(mission.missionId)).toMatchObject({
      latestSynthesisId: 'S-empty-s3',
      status: 'synthesizing',
    });
    expect(store.getLatestSynthesis(mission.missionId)).toEqual(
      second?.synthesis,
    );
    expect(
      ledger.loadAll().filter((event) => event.type === 'research.synthesis_generated'),
    ).toHaveLength(2);

    const replayed = new DiscordResearchMissionStore({ ledger });
    expect(replayed.getLatestSynthesis(mission.missionId)).toEqual(
      second?.synthesis,
    );
  });

  it('links proof metadata idempotently and replays the latest proof link state', () => {
    let tick = 0;
    const ledger = new InMemoryControlPlaneLedger();
    const store = new DiscordResearchMissionStore({
      ledger,
      idFactory: () => '20260510-proof',
      now: () => `2026-05-10T00:00:0${tick++}.000Z`,
    });
    const mission = store.createDraft({
      goal: 'Proof link replay and relink',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });

    const first = store.linkProof({
      missionId: mission.missionId,
      proofId: 'discord-live-001',
      surface: 'discord-service',
      status: 'pass',
      artifactTokens: ['gateway-ready'],
      summary: 'first operator score',
      actorId: 'operator',
    });
    const second = store.linkProof({
      missionId: mission.missionId,
      proofId: 'discord-live-001',
      surface: 'discord-service',
      status: 'fail',
      artifactTokens: ['/tmp/private/live-proof.json', 'gateway-ready'],
      summary: 'rechecked /tmp/private/live-proof.json for @everyone',
      actorId: 'operator',
    });

    expect(first.status).toBe('linked');
    expect(second.status).toBe('linked');
    expect(store.get(mission.missionId)?.proof).toEqual({
      pass: 0,
      warn: 0,
      fail: 1,
    });
    expect(store.get(mission.missionId)?.proofLinks).toEqual([
      expect.objectContaining({
        proofId: 'discord-live-001',
        status: 'fail',
        artifactTokens: ['path', 'gateway-ready'],
        summary: 'rechecked [path] for @​everyone',
      }),
    ]);
    expect(
      ledger.loadAll().filter((event) => event.type === 'research.proof_linked'),
    ).toHaveLength(2);

    const replayed = new DiscordResearchMissionStore({ ledger });
    expect(replayed.get(mission.missionId)?.proof).toEqual({
      pass: 0,
      warn: 0,
      fail: 1,
    });
    expect(replayed.get(mission.missionId)?.proofLinks).toEqual([
      expect.objectContaining({
        proofId: 'discord-live-001',
        status: 'fail',
        artifactTokens: ['path', 'gateway-ready'],
      }),
    ]);
  });

  it('de-duplicates deterministic evidence and claim ids independently', () => {
    const store = new DiscordResearchMissionStore({
      idFactory: () => 'collision',
      now: () => '2026-05-10T00:00:00.000Z',
    });
    const mission = store.createDraft({
      goal: 'Deterministic id collision',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });

    store.addEvidence({
      missionId: mission.missionId,
      summary: 'First evidence',
      actorId: 'operator',
    });
    store.addEvidence({
      missionId: mission.missionId,
      summary: 'Second evidence',
      actorId: 'operator',
    });
    store.addClaim({
      missionId: mission.missionId,
      text: 'First claim',
      actorId: 'operator',
    });
    store.addClaim({
      missionId: mission.missionId,
      text: 'Second claim',
      actorId: 'operator',
    });

    expect(store.listEvidence(mission.missionId)?.map((item) => item.evidenceId))
      .toEqual(['E-collision', 'E-collision-2']);
    expect(store.listClaims(mission.missionId)?.map((item) => item.claimId))
      .toEqual(['C-collision', 'C-collision-2']);
  });

  it('keeps claim links mission-scoped and de-duplicates repeated support ids', () => {
    let id = 0;
    const store = new DiscordResearchMissionStore({
      idFactory: () => `scope-${++id}`,
      now: () => '2026-05-10T00:00:00.000Z',
    });
    const first = store.createDraft({
      goal: 'First mission',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });
    const second = store.createDraft({
      goal: 'Second mission',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });
    const firstEvidence = store.addEvidence({
      missionId: first.missionId,
      summary: 'Evidence belongs to the first mission only',
      actorId: 'operator',
    });
    const secondClaim = store.addClaim({
      missionId: second.missionId,
      text: 'Second mission claim',
      actorId: 'operator',
    });
    expect(firstEvidence).toBeDefined();
    expect(secondClaim).toBeDefined();
    if (firstEvidence === undefined || secondClaim === undefined) {
      throw new Error('expected scoped evidence and claim to be created');
    }

    expect(
      store.linkEvidenceToClaim({
        missionId: second.missionId,
        claimId: secondClaim.claim.claimId,
        evidenceId: firstEvidence.evidence.evidenceId,
        mode: 'support',
        actorId: 'operator',
      }),
    ).toMatchObject({
      status: 'evidence-not-found',
      missionId: second.missionId,
      claimId: secondClaim.claim.claimId,
      evidenceId: firstEvidence.evidence.evidenceId,
    });

    const secondEvidence = store.addEvidence({
      missionId: second.missionId,
      summary: 'Second mission evidence',
      actorId: 'operator',
    });
    expect(secondEvidence).toBeDefined();
    if (secondEvidence === undefined) {
      throw new Error('expected second evidence to be created');
    }
    for (const attempt of [1, 2]) {
      expect(
        store.linkEvidenceToClaim({
          missionId: second.missionId,
          claimId: secondClaim.claim.claimId,
          evidenceId: secondEvidence.evidence.evidenceId,
          mode: 'support',
          actorId: `operator-${attempt}`,
        }),
      ).toMatchObject({
        status: 'linked',
        claim: {
          supportEvidenceIds: [secondEvidence.evidence.evidenceId],
        },
        mission: {
          claims: { supported: 1, uncertain: 0, challenged: 0 },
        },
      });
    }
  });

  it('clones records and validates required text fields', () => {
    const store = new DiscordResearchMissionStore({
      idFactory: () => '20260510-d4',
      now: () => '2026-05-10T00:00:00.000Z',
    });
    const mission = store.createDraft({
      goal: 'Clone safety',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });

    (mission.planDraft as { label: string; state: string }[])[0]!.label =
      'mutated externally';

    expect(store.get(mission.missionId)?.planDraft[0]!.label).toBe(
      'Clarify scope for Clone safety',
    );
    expect(() =>
      store.createDraft({
        goal: '   ',
        ownerId: 'operator',
        discordChannelId: 'research-runs',
      }),
    ).toThrow('Research mission goal must be non-empty.');
    expect(store.bindThread({
      missionId: 'missing',
      discordThreadId: 'thread',
      actorId: 'operator',
    })).toBeUndefined();
  });
});
