import { describe, expect, it } from 'vitest';

import {
  DiscordAccessPolicy,
  DiscordCommandHandlers,
  InMemoryControlPlaneLedger,
  LIVE_PROOF_SURFACES,
} from '../src/index.js';
import { DiscordResearchMissionStore } from '../src/discord/discord-research-mission.js';
import { FakeDiscordInteraction } from './helpers/discord.js';

function createHandlers(options: {
  readonly accessPolicy?: DiscordAccessPolicy;
  readonly liveProofReport?: {
    readonly proofPath: string;
    readonly maxProofBytes: number;
    readonly reportStatus?: 'complete' | 'warn' | 'fail' | 'no-proof';
    readonly proofRecordCount?: number;
    readonly completeProofCount?: number;
    readonly warnProofCount?: number;
    readonly failProofCount?: number;
    readonly operatorApprovedCount?: number;
    readonly unsafeBoundaryCount?: number;
    readonly missingRequiredArtifactCount?: number;
    readonly qualityScore?: number;
    readonly qualityScoreMax?: number;
    readonly recommendation?: string;
    readonly error?: string;
  };
  readonly researchMissions?: DiscordResearchMissionStore;
} = {}): DiscordCommandHandlers {
  return new DiscordCommandHandlers({
    arona: {} as never,
    dispatcher: {} as never,
    requestFactory: {} as never,
    ...(options.researchMissions === undefined
      ? {}
      : { researchMissions: options.researchMissions }),
    ...(options.accessPolicy === undefined
      ? {}
      : { accessPolicy: options.accessPolicy }),
    doctorStatus:
      options.liveProofReport === undefined
        ? {}
        : { liveProofReport: options.liveProofReport },
  });
}

describe('/proof command', () => {
  it('renders no-proof guidance when no manifest is configured', async () => {
    const handlers = createHandlers();
    const interaction = new FakeDiscordInteraction('proof', {});

    await handlers.handleInteraction(interaction);

    expect(interaction.deferredReplies).toEqual([{ ephemeral: true }]);
    expect(interaction.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(interaction.editedReplies[0]?.content).toContain('Proof status');
    expect(interaction.editedReplies[0]?.content).toContain(
      'Configured manifest: none',
    );
    expect(interaction.editedReplies[0]?.content).toContain(
      'Report status: no-proof',
    );
    expect(interaction.editedReplies[0]?.content).toContain(
      'AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH',
    );
    expect(interaction.editedReplies[0]?.content).toContain(
      'no live services are contacted',
    );
  });

  it('renders configured live-proof scorecard without raw paths or summaries', async () => {
    const handlers = createHandlers({
      liveProofReport: {
        proofPath: '/tmp/private/live-proof.json',
        maxProofBytes: 10000,
        reportStatus: 'warn',
        proofRecordCount: 2,
        completeProofCount: 1,
        warnProofCount: 1,
        failProofCount: 0,
        operatorApprovedCount: 2,
        unsafeBoundaryCount: 0,
        missingRequiredArtifactCount: 3,
        qualityScore: 82,
        qualityScoreMax: 100,
        recommendation:
          'Add 3 missing live-proof artifact token(s) from specs/ARCHIVE/live-proof-matrix.md.',
      },
    });
    const interaction = new FakeDiscordInteraction('proof', {
      action: 'status',
      mission_id: 'R-20260510-proof',
    });

    await handlers.handleInteraction(interaction);

    const content = interaction.editedReplies[0]?.content ?? '';
    expect(interaction.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(content).toContain('Mission: R-20260510-proof');
    expect(content).toContain('mission not tracked for local proof links');
    expect(content).toContain('Report status: warn');
    expect(content).toContain('Proof records: 2');
    expect(content).toContain('Complete proofs: 1');
    expect(content).toContain('Warn/fail proofs: 1/0');
    expect(content).toContain('Missing artifact tokens: 3');
    expect(content).toContain('Quality score: 82/100');
    expect(content).toContain('Raw summaries: not rendered');
    expect(content).toContain('Raw correlation ids: not rendered');
    expect(content).toContain('Live service contact: none');
    expect(content).not.toContain('/tmp/private');
  });

  it('renders tracked mission-local proof counters alongside global proof status', async () => {
    const missions = new DiscordResearchMissionStore({
      idFactory: () => '20260510-proof',
      now: () => '2026-05-10T00:00:00.000Z',
    });
    missions.createDraft({
      goal: 'Mission proof status bridge',
      title: 'Mission proof status bridge',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });
    const handlers = createHandlers({
      researchMissions: missions,
      liveProofReport: {
        proofPath: '/tmp/private/live-proof.json',
        maxProofBytes: 10000,
        reportStatus: 'warn',
        proofRecordCount: 2,
        completeProofCount: 1,
        warnProofCount: 1,
        failProofCount: 0,
        operatorApprovedCount: 2,
        unsafeBoundaryCount: 0,
        missingRequiredArtifactCount: 3,
        qualityScore: 82,
        qualityScoreMax: 100,
      },
    });
    const interaction = new FakeDiscordInteraction('proof', {
      action: 'status',
      mission_id: 'R-20260510-proof',
    });

    await handlers.handleInteraction(interaction);

    const content = interaction.editedReplies[0]?.content ?? '';
    expect(interaction.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(content).toContain('Mission: R-20260510-proof (draft · plan draft)');
    expect(content).toContain('Mission-local proof: 0 PASS, 0 WARN, 0 FAIL');
    expect(content).toContain('Mission proof links: 0 linked artifacts.');
    expect(content).toContain('Report status: warn');
    expect(content).toContain('Proof records: 2');
    expect(content).toContain('Warn/fail proofs: 1/0');
    expect(content).toContain('Missing artifact tokens: 3');
    expect(content).toContain('Manifest: [path]');
    expect(content).toContain('Raw summaries: not rendered');
    expect(content).toContain('Raw correlation ids: not rendered');
    expect(content).toContain('Live service contact: none');
    expect(content).not.toContain('/tmp/private');
  });

  it('links redacted operator proof metadata to a tracked mission', async () => {
    const missions = new DiscordResearchMissionStore({
      idFactory: () => '20260510-proof',
      now: () => '2026-05-10T00:00:00.000Z',
    });
    missions.createDraft({
      goal: 'Mission proof link bridge',
      title: 'Mission proof link bridge',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });
    const handlers = createHandlers({ researchMissions: missions });
    const interaction = new FakeDiscordInteraction(
      'proof',
      {
        action: 'link',
        mission_id: 'R-20260510-proof',
        surface: 'discord-service',
        proof_id: 'discord-service-live-001',
        status: 'pass',
        artifact_tokens: 'gateway-ready, command-registration, gateway-ready',
        summary: 'Compared /tmp/private/live-proof.json for @everyone',
      },
      'operator',
    );

    await handlers.handleInteraction(interaction);

    const content = interaction.editedReplies[0]?.content ?? '';
    expect(interaction.deferredReplies).toEqual([{ ephemeral: true }]);
    expect(interaction.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(content).toContain('Proof link');
    expect(content).toContain('Status: linked');
    expect(content).toContain('Mission: R-20260510-proof');
    expect(content).toContain('Surface: discord-service');
    expect(content).toContain('Proof: discord-service-live-001 [pass]');
    expect(content).toContain(
      'Artifact tokens: 2 (gateway-ready, command-registration)',
    );
    expect(content).toContain('Summary: Compared [path] for @​everyone');
    expect(content).toContain('operator-owned metadata link only');
    expect(content).not.toContain('/tmp/private');
    expect(content).not.toContain('@everyone');

    const mission = missions.get('R-20260510-proof');
    expect(mission?.proof).toEqual({ pass: 1, warn: 0, fail: 0 });
    expect(mission?.proofLinks).toEqual([
      expect.objectContaining({
        proofId: 'discord-service-live-001',
        surface: 'discord-service',
        status: 'pass',
        artifactTokens: ['gateway-ready', 'command-registration'],
        summary: 'Compared [path] for @​everyone',
      }),
    ]);
  });

  it('replays linked proof metadata through the mission control ledger', () => {
    const ledger = new InMemoryControlPlaneLedger();
    const missions = new DiscordResearchMissionStore({
      ledger,
      idFactory: () => '20260510-proof',
      now: () => '2026-05-10T00:00:00.000Z',
    });
    missions.createDraft({
      goal: 'Mission proof replay',
      title: 'Mission proof replay',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });
    missions.linkProof({
      missionId: 'R-20260510-proof',
      proofId: 'discord-service-live-001',
      surface: 'discord-service',
      status: 'warn',
      artifactTokens: ['gateway-ready'],
      summary: 'operator-scored warning',
      actorId: 'operator',
    });

    const replayed = new DiscordResearchMissionStore({ ledger });

    expect(
      ledger.loadAll().map((event) => event.type),
    ).toContain('research.proof_linked');
    expect(replayed.get('R-20260510-proof')?.proof).toEqual({
      pass: 0,
      warn: 1,
      fail: 0,
    });
    expect(replayed.get('R-20260510-proof')?.proofLinks).toEqual([
      expect.objectContaining({
        proofId: 'discord-service-live-001',
        status: 'warn',
      }),
    ]);
  });

  it('rejects proof links with missing fields or invalid surface/status without mutating mission state', async () => {
    const missions = new DiscordResearchMissionStore({
      idFactory: () => '20260510-proof',
      now: () => '2026-05-10T00:00:00.000Z',
    });
    missions.createDraft({
      goal: 'Mission proof validation',
      title: 'Mission proof validation',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });
    const handlers = createHandlers({ researchMissions: missions });

    const missing = new FakeDiscordInteraction('proof', { action: 'link' });
    await handlers.handleInteraction(missing);
    expect(missing.editedReplies[0]?.content).toContain(
      'Reason: /proof action:link requires `mission_id`.',
    );

    const invalidSurface = new FakeDiscordInteraction('proof', {
      action: 'link',
      mission_id: 'R-20260510-proof',
      surface: '@everyone',
      proof_id: 'proof-1',
      status: 'pass',
    });
    await handlers.handleInteraction(invalidSurface);
    expect(invalidSurface.editedReplies[0]?.content).toContain(
      'Surface: invalid (@​everyone)',
    );
    expect(invalidSurface.editedReplies[0]?.content).not.toContain('@everyone');

    const invalidStatus = new FakeDiscordInteraction('proof', {
      action: 'link',
      mission_id: 'R-20260510-proof',
      surface: 'discord-service',
      proof_id: 'proof-1',
      status: 'done',
    });
    await handlers.handleInteraction(invalidStatus);
    expect(invalidStatus.editedReplies[0]?.content).toContain(
      'Proof status: invalid (done)',
    );
    expect(missions.get('R-20260510-proof')?.proofLinks).toEqual([]);
  });

  it('redacts filesystem paths from live-proof errors and recommendations', async () => {
    const recommendationHandlers = createHandlers({
      liveProofReport: {
        proofPath: '/tmp/private/live-proof.json',
        maxProofBytes: 10000,
        reportStatus: 'warn',
        recommendation:
          'Compare /tmp/private/live-proof.json with specs/ARCHIVE/live-proof-matrix.md.',
      },
    });
    const recommendationInteraction = new FakeDiscordInteraction('proof', {
      action: 'status',
    });

    await recommendationHandlers.handleInteraction(recommendationInteraction);

    const recommendationContent =
      recommendationInteraction.editedReplies[0]?.content ?? '';
    expect(recommendationContent).toContain('Manifest: [path]');
    expect(recommendationContent).toContain('Next: Compare [path]');
    expect(recommendationContent).toContain(
      'specs/ARCHIVE/live-proof-matrix.md',
    );
    expect(recommendationContent).not.toContain('/tmp/private');

    const errorHandlers = createHandlers({
      liveProofReport: {
        proofPath: '/tmp/private/live-proof.json',
        maxProofBytes: 10000,
        error: 'Failed to read /tmp/private/live-proof.json',
      },
    });
    const errorInteraction = new FakeDiscordInteraction('proof', {
      action: 'status',
    });

    await errorHandlers.handleInteraction(errorInteraction);

    const errorContent = errorInteraction.editedReplies[0]?.content ?? '';
    expect(errorContent).toContain('Report status: failed');
    expect(errorContent).toContain('Failed to read [path]');
    expect(errorContent).not.toContain('/tmp/private');
  });

  it('exports a live-proof manifest template for one selected surface', async () => {
    const handlers = createHandlers();
    const interaction = new FakeDiscordInteraction('proof', {
      action: 'export',
      mission_id: 'R-20260510-proof',
      surface: 'discord-service',
    });

    await handlers.handleInteraction(interaction);

    const content = interaction.editedReplies[0]?.content ?? '';
    expect(interaction.deferredReplies).toEqual([{ ephemeral: true }]);
    expect(interaction.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).toContain('Proof export template');
    expect(content).toContain('Mission: R-20260510-proof');
    expect(content).toContain('Surface: discord-service');
    expect(content).toContain('Status: template-only WARN');
    expect(content).toContain('"schemaVersion": 1');
    expect(content).toContain('"surface": "discord-service"');
    expect(content).toContain('"proofId": "discord-service-proof-template"');
    expect(content).toContain('"status": "warn"');
    expect(content).toContain('"operatorApproved": false');
    expect(content).toContain('"gateway-ready"');
    expect(content).toContain('"correlated-command-reply"');
    expect(content).toContain('live:proof:report');
    expect(content).toContain('no proof files read/written');
    expect(content).toContain('no live services contacted');
  });

  it('keeps every one-surface proof export template within one Discord message', async () => {
    for (const surface of LIVE_PROOF_SURFACES) {
      const handlers = createHandlers();
      const interaction = new FakeDiscordInteraction('proof', {
        action: 'export',
        surface,
      });

      await handlers.handleInteraction(interaction);

      const content = interaction.editedReplies[0]?.content ?? '';
      expect(content, surface).toContain(`Surface: ${surface}`);
      expect(content, surface).toContain(`"surface": "${surface}"`);
      expect(content, surface).toContain('Status: template-only WARN');
      expect(content.length, surface).toBeLessThanOrEqual(2000);
    }
  });

  it('sanitizes export mission headers and invalid surface responses', async () => {
    const missionHandlers = createHandlers();
    const missionInteraction = new FakeDiscordInteraction('proof', {
      action: 'export',
      mission_id: '<@1234567890> `proof`',
      surface: 'discord-service',
    });

    await missionHandlers.handleInteraction(missionInteraction);

    const missionContent = missionInteraction.editedReplies[0]?.content ?? '';
    expect(missionContent).toContain('Mission: <@​1234567890> ʼproofʼ');
    expect(missionContent).not.toContain('<@1234567890>');
    expect(missionContent).not.toContain('`proof`');

    const invalidHandlers = createHandlers();
    const invalidInteraction = new FakeDiscordInteraction('proof', {
      action: 'export',
      surface: '@everyone',
    });

    await invalidHandlers.handleInteraction(invalidInteraction);

    const invalidContent = invalidInteraction.editedReplies[0]?.content ?? '';
    expect(invalidContent).toContain('Surface: invalid (@​everyone)');
    expect(invalidContent).not.toContain('@everyone');
  });

  it('requires a live-proof surface before exporting a template', async () => {
    const handlers = createHandlers();
    const interaction = new FakeDiscordInteraction('proof', { action: 'export' });

    await handlers.handleInteraction(interaction);

    const content = interaction.editedReplies[0]?.content ?? '';
    expect(interaction.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(content).toContain('Proof export template');
    expect(content).toContain('Surface: missing');
    expect(content).toContain('/proof action:export surface:<surface>');
    expect(content).toContain('discord-service');
    expect(content).toContain('Boundary: template-only Discord export');
  });

  it('renders an operator-owned proof capture preflight for one selected surface', async () => {
    const handlers = createHandlers();
    const interaction = new FakeDiscordInteraction('proof', {
      action: 'capture',
      mission_id: 'R-20260510-proof',
      surface: 'durable-task-archive-ux',
    });

    await handlers.handleInteraction(interaction);

    const content = interaction.editedReplies[0]?.content ?? '';
    expect(interaction.deferredReplies).toEqual([{ ephemeral: true }]);
    expect(interaction.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(content).toContain('Proof capture preflight');
    expect(content).toContain('Mission: R-20260510-proof');
    expect(content).toContain('Surface: durable-task-archive-ux');
    expect(content).toContain(
      'Status: operator-capture preflight; no live proof artifact has been captured by Discord.',
    );
    expect(content).toContain('Operator steps:');
    expect(content).toContain(
      'pnpm live:proof:report -- --print-template --surface durable-task-archive-ux --pretty',
    );
    expect(content).toContain('pnpm live:proof:report -- --proof <path>');
    expect(content).toContain('no proof files are read/written');
    expect(content).toContain('no live services contacted');
    expect(content).toContain('no manifest mutation performed');
    expect(content).toContain('no mission proof link is created');
    expect(content.length).toBeLessThanOrEqual(2000);
  });

  it('requires a live-proof surface before rendering capture preflight', async () => {
    const handlers = createHandlers();
    const interaction = new FakeDiscordInteraction('proof', {
      action: 'capture',
      mission_id: '<@1234567890> `proof`',
    });

    await handlers.handleInteraction(interaction);

    const content = interaction.editedReplies[0]?.content ?? '';
    expect(interaction.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(content).toContain('Proof capture preflight');
    expect(content).toContain('Mission: <@​1234567890> ʼproofʼ');
    expect(content).toContain('Surface: missing');
    expect(content).toContain('/proof action:capture surface:<surface>');
    expect(content).toContain('Boundary: operator-capture preflight only');
    expect(content).not.toContain('<@1234567890>');
  });

  it('sanitizes invalid capture surfaces without reading or mutating proof state', async () => {
    const handlers = createHandlers();
    const interaction = new FakeDiscordInteraction('proof', {
      action: 'capture',
      surface: '@everyone',
    });

    await handlers.handleInteraction(interaction);

    const content = interaction.editedReplies[0]?.content ?? '';
    expect(interaction.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(content).toContain('Proof capture preflight');
    expect(content).toContain('Surface: invalid (@​everyone)');
    expect(content).toContain('Known surfaces:');
    expect(content).toContain('discord-service');
    expect(content).toContain('Boundary: operator-capture preflight only');
    expect(content).toContain('no proof files are read or written');
    expect(content).toContain('no manifests are mutated');
    expect(content).toContain('no live services are contacted');
    expect(content).not.toContain('@everyone');
  });

  it('renders an operator-start proof preflight for one selected surface', async () => {
    const handlers = createHandlers();
    const interaction = new FakeDiscordInteraction('proof', {
      action: 'start',
      mission_id: 'R-20260510-proof',
      surface: 'discord-service',
    });

    await handlers.handleInteraction(interaction);

    const content = interaction.editedReplies[0]?.content ?? '';
    expect(interaction.deferredReplies).toEqual([{ ephemeral: true }]);
    expect(interaction.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(content).toContain('Proof start preflight');
    expect(content).toContain('Mission: R-20260510-proof');
    expect(content).toContain('Surface: discord-service');
    expect(content).toContain(
      'Status: operator-start preflight; Discord has not executed live proof.',
    );
    expect(content).toContain('Start plan:');
    expect(content).toContain(
      'Confirm the surface checklist in `specs/ARCHIVE/live-proof-matrix.md`.',
    );
    expect(content).toContain('/proof action:export surface:discord-service');
    expect(content).toContain('/proof action:capture surface:discord-service');
    expect(content).toContain(
      'pnpm live:proof:report -- --proof <path> --surface discord-service --pretty',
    );
    expect(content).toContain('no proof process is spawned');
    expect(content).toContain('no proof files are read/written');
    expect(content).toContain('no manifests are mutated');
    expect(content).toContain('no live services contacted');
    expect(content).toContain('no mission proof link is created');
    expect(content.length).toBeLessThanOrEqual(2000);
  });

  it('requires a live-proof surface before rendering start preflight', async () => {
    const handlers = createHandlers();
    const interaction = new FakeDiscordInteraction('proof', {
      action: 'start',
      mission_id: '<@1234567890> `proof`',
    });

    await handlers.handleInteraction(interaction);

    const content = interaction.editedReplies[0]?.content ?? '';
    expect(interaction.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(content).toContain('Proof start preflight');
    expect(content).toContain('Mission: <@​1234567890> ʼproofʼ');
    expect(content).toContain('Surface: missing');
    expect(content).toContain('/proof action:start surface:<surface>');
    expect(content).toContain('Boundary: start preflight only');
    expect(content).not.toContain('<@1234567890>');
  });

  it('sanitizes invalid start surfaces without spawning proof work', async () => {
    const handlers = createHandlers();
    const interaction = new FakeDiscordInteraction('proof', {
      action: 'start',
      surface: '@everyone',
    });

    await handlers.handleInteraction(interaction);

    const content = interaction.editedReplies[0]?.content ?? '';
    expect(interaction.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(content).toContain('Proof start preflight');
    expect(content).toContain('Surface: invalid (@​everyone)');
    expect(content).toContain('Known surfaces:');
    expect(content).toContain('discord-service');
    expect(content).toContain('no proof process is spawned');
    expect(content).toContain('no proof files are read or written');
    expect(content).toContain('no manifests are mutated');
    expect(content).toContain('no live services are contacted');
    expect(content).not.toContain('@everyone');
  });

  it('keeps unknown future proof actions explicit instead of pretending they are wired', async () => {
    const handlers = createHandlers();
    const interaction = new FakeDiscordInteraction('proof', { action: 'doctor' });

    await handlers.handleInteraction(interaction);

    expect(interaction.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(interaction.editedReplies[0]?.content).toContain(
      'Proof action `doctor` is not implemented yet.',
    );
    expect(interaction.editedReplies[0]?.content).toContain(
      'Supported actions in this slice: `/proof action:status`, `/proof action:start surface:<surface>`, `/proof action:export surface:<surface>`, `/proof action:capture surface:<surface>`, and `/proof action:link mission_id:<id> surface:<surface> proof_id:<id> status:<pass|warn|fail>`.',
    );
  });

  it('requires Discord admin because proof status is an operator gate surface', async () => {
    const handlers = createHandlers({
      accessPolicy: new DiscordAccessPolicy({
        allowDms: true,
        adminUserIds: ['discord-admin-1'],
      }),
    });
    const interaction = new FakeDiscordInteraction('proof', {}, 'discord-user-1');

    await handlers.handleInteraction(interaction);

    expect(interaction.deferredReplies).toEqual([{ ephemeral: true }]);
    expect(interaction.editedReplies[0]?.content).toContain(
      'Discord request denied for `proof`.',
    );
    expect(interaction.editedReplies[0]?.content).toContain('admin-required');
  });

  it('requires Discord admin before exporting a proof template', async () => {
    const handlers = createHandlers({
      accessPolicy: new DiscordAccessPolicy({
        allowDms: true,
        adminUserIds: ['discord-admin-1'],
      }),
    });
    const interaction = new FakeDiscordInteraction(
      'proof',
      { action: 'export', surface: 'discord-service' },
      'discord-user-1',
    );

    await handlers.handleInteraction(interaction);

    expect(interaction.deferredReplies).toEqual([{ ephemeral: true }]);
    expect(interaction.editedReplies[0]?.content).toContain(
      'Discord request denied for `proof`.',
    );
    expect(interaction.editedReplies[0]?.content).toContain('admin-required');
    expect(interaction.editedReplies[0]?.content).not.toContain(
      'Proof export template',
    );
  });

  it('requires Discord admin before rendering proof start preflight', async () => {
    const handlers = createHandlers({
      accessPolicy: new DiscordAccessPolicy({
        allowDms: true,
        adminUserIds: ['discord-admin-1'],
      }),
    });
    const interaction = new FakeDiscordInteraction(
      'proof',
      { action: 'start', surface: 'discord-service' },
      'discord-user-1',
    );

    await handlers.handleInteraction(interaction);

    expect(interaction.deferredReplies).toEqual([{ ephemeral: true }]);
    expect(interaction.editedReplies[0]?.content).toContain(
      'Discord request denied for `proof`.',
    );
    expect(interaction.editedReplies[0]?.content).toContain('admin-required');
    expect(interaction.editedReplies[0]?.content).not.toContain(
      'Proof start preflight',
    );
  });

  it('requires Discord admin before linking proof metadata', async () => {
    const handlers = createHandlers({
      accessPolicy: new DiscordAccessPolicy({
        allowDms: true,
        adminUserIds: ['discord-admin-1'],
      }),
    });
    const interaction = new FakeDiscordInteraction(
      'proof',
      {
        action: 'link',
        mission_id: 'R-20260510-proof',
        surface: 'discord-service',
        proof_id: 'proof-1',
        status: 'pass',
      },
      'discord-user-1',
    );

    await handlers.handleInteraction(interaction);

    expect(interaction.deferredReplies).toEqual([{ ephemeral: true }]);
    expect(interaction.editedReplies[0]?.content).toContain(
      'Discord request denied for `proof`.',
    );
    expect(interaction.editedReplies[0]?.content).toContain('admin-required');
    expect(interaction.editedReplies[0]?.content).not.toContain('Proof link');
  });
});
