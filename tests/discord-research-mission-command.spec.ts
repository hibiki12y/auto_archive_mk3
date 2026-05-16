import { describe, expect, it, vi } from 'vitest';

import {
  DiscordCommandHandlers,
  DiscordResearchMissionStore,
  DiscordResearchPlanStore,
  InMemoryControlPlaneLedger,
  SubagentOperatorSurface,
  type SubagentDescriptor,
  type SubagentRoster,
  type RuntimeDriver,
  type RuntimeDriverResult,
  type RuntimeExecutionContext,
} from '../src/index.js';
import { DiscordAccessPolicy } from '../src/discord/discord-access-policy.js';
import { FakeDiscordInteraction, flushDiscordAsyncWork } from './helpers/discord.js';

const VALID_RESEARCH_PLAN = {
  subTasks: [
    { taskId: 'collect', instruction: 'collect' },
    { taskId: 'audit', instruction: 'audit' },
  ],
  synthesis: {
    taskId: 'synthesize',
    instructionTemplate: 'combine {{subTaskOutputs}}',
  },
  runtimeSettings: {
    networkProfile: 'provider-only',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
  },
  resources: {
    requested: {
      cpuCores: 1,
      memoryMiB: 128,
      wallTimeSec: 60,
      gpuCards: 0,
    },
  },
} as const;

function makeResearchPlanDriver(): RuntimeDriver {
  const run = vi.fn(async (context: RuntimeExecutionContext) => {
    await context.emit({
      kind: 'item.completed',
      item: { type: 'agent_message', text: `${context.plan.taskId}-done` },
    } as never);
    return {
      cause: {
        kind: 'success' as const,
        taskId: context.instance.taskId,
        runtimeInstanceId: context.instance.instanceId,
        observedAt: '2026-05-10T01:00:00.000Z',
        provenance: 'research-mission-command-test',
      },
      provenance: 'research-mission-command-test',
      reason: 'ok',
    } satisfies RuntimeDriverResult;
  });
  return { run };
}

function makeReasonOnlyResearchPlanDriver(): RuntimeDriver {
  const run = vi.fn(async (context: RuntimeExecutionContext) => ({
    cause: {
      kind: 'success' as const,
      taskId: context.instance.taskId,
      runtimeInstanceId: context.instance.instanceId,
      observedAt: '2026-05-10T01:00:00.000Z',
      provenance: 'research-mission-command-test',
    },
    provenance: 'research-mission-command-test',
    reason: `${context.plan.taskId}-reason-only`,
  }));
  return { run };
}

function makeThrowingResearchPlanDriver(): RuntimeDriver {
  const run = vi.fn(async (context: RuntimeExecutionContext) => {
    throw new Error(`${context.plan.taskId} driver exploded`);
  });
  return { run };
}

function createHandlers(options: {
  readonly researchPlans?: DiscordResearchPlanStore;
  readonly researchPlanRuntimeDriver?: RuntimeDriver;
  readonly liveProofReport?: {
    readonly proofPath: string;
    readonly maxProofBytes: number;
    readonly reportStatus?: 'complete' | 'warn' | 'fail' | 'no-proof';
    readonly completeProofCount?: number;
    readonly warnProofCount?: number;
    readonly failProofCount?: number;
    readonly missingRequiredArtifactCount?: number;
  };
  readonly activeRuntimeProvider?: 'codex' | 'claude-agent';
  readonly runtimeProviderScope?: 'codex-sdk-only' | 'multi-provider' | 'unknown';
  readonly subagentOperator?: SubagentOperatorSurface;
  readonly accessPolicy?: DiscordAccessPolicy;
} = {}) {
  const ledger = new InMemoryControlPlaneLedger();
  const researchMissions = new DiscordResearchMissionStore({
    ledger,
    idFactory: () => '20260510-cmd',
    now: () => '2026-05-10T01:00:00.000Z',
  });
  const handlers = new DiscordCommandHandlers({
    arona: {} as never,
    dispatcher: {} as never,
    requestFactory: {} as never,
    controlLedger: ledger,
    researchMissions,
    ...(options.researchPlans === undefined
      ? {}
      : { researchPlans: options.researchPlans }),
    ...(options.researchPlanRuntimeDriver === undefined
      ? {}
      : { researchPlanRuntimeDriver: options.researchPlanRuntimeDriver }),
    ...(options.subagentOperator === undefined
      ? {}
      : { subagentOperator: options.subagentOperator }),
    ...(options.accessPolicy === undefined
      ? {}
      : { accessPolicy: options.accessPolicy }),
    doctorStatus: {
      ...(options.liveProofReport === undefined
        ? {}
        : { liveProofReport: options.liveProofReport }),
      ...(options.activeRuntimeProvider === undefined
        ? {}
        : { activeRuntimeProvider: options.activeRuntimeProvider }),
      ...(options.runtimeProviderScope === undefined
        ? {}
        : { runtimeProviderScope: options.runtimeProviderScope }),
    },
  });
  return { handlers, ledger, researchMissions };
}

function createStubRoster(
  descriptors: readonly SubagentDescriptor[] = [],
): SubagentRoster {
  return {
    spawn: vi.fn(),
    terminate: vi.fn(),
    terminateAll: vi.fn(),
    events: {
      [Symbol.asyncIterator]: () =>
        ({
          next: () => Promise.resolve({ value: undefined, done: true as const }),
        }) as AsyncIterator<never>,
    },
    snapshot: () => Object.freeze([...descriptors]),
  } as unknown as SubagentRoster;
}

function subagentDescriptor(
  override: Partial<SubagentDescriptor>,
): SubagentDescriptor {
  return Object.freeze({
    subagentId: override.subagentId ?? 'subagent-1',
    role: override.role ?? 'explorer',
    parent: Object.freeze({
      taskId:
        override.parent?.taskId ??
        'discord-research-mission-plan-R-20260510-cmd-001',
      instanceId: override.parent?.instanceId ?? 'parent-inst',
    }),
    createdAt: override.createdAt ?? '2026-05-10T01:00:00.000Z',
    state: override.state ?? 'active',
    envelope: override.envelope ?? Object.freeze({
      requested: { cpuCores: 1, memoryMiB: 128, wallTimeSec: 60, gpuCards: 0 },
      derived: { cpuCores: 1, memoryMiB: 128, wallTimeSec: 60, gpuCards: 0 },
    }),
  }) as SubagentDescriptor;
}

describe('/research mission command MVP', () => {
  it('creates a draft mission summary from /research action:new', async () => {
    const { handlers, ledger } = createHandlers();
    const interaction = new FakeDiscordInteraction(
      'research',
      {
        action: 'new',
        instruction: 'OpenClaw/Hermes 대비 Auto Archive 연구 UX 개선',
        title: 'Auto Archive Mk3 Discord 연구 UX 개선',
      },
      'operator',
      'research-runs',
    );

    await handlers.handleInteraction(interaction);

    expect(interaction.deferredReplies).toHaveLength(1);
    expect(interaction.editedReplies[0]?.content).toContain(
      'Research Mission `R-20260510-cmd`',
    );
    expect(interaction.editedReplies[0]?.content).toContain('Status: draft');
    expect(interaction.editedReplies[0]?.content).toContain(
      'Thread: research-runs',
    );
    expect(interaction.editedReplies[0]?.content).toContain(
      'Next: [Approve plan] [Show plan] [Cancel]',
    );
    expect(interaction.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(interaction.editedReplies[0]?.components?.[0]?.components).toEqual([
      expect.objectContaining({
        customId: 'research-mission:approve:R-20260510-cmd',
        label: 'Approve plan',
      }),
      expect.objectContaining({
        customId: 'research-mission:show-plan:R-20260510-cmd',
        label: 'Show plan',
      }),
      expect.objectContaining({
        customId: 'research-mission:cancel:R-20260510-cmd',
        label: 'Cancel',
      }),
    ]);
    expect(
      ledger
        .loadAll()
        .map((event) => event.type)
        .filter((type) => type.startsWith('research.mission_')),
    ).toEqual(['research.mission_draft_created']);
  });

  it('shows and approves a mission while retaining control-plane replay evidence', async () => {
    const { handlers, ledger } = createHandlers();
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'mission command replay' },
        'operator',
        'research-runs',
      ),
    );

    const show = new FakeDiscordInteraction(
      'research',
      { action: 'show', mission_id: 'R-20260510-cmd' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(show);
    expect(show.editedReplies[0]?.content).toContain('Status: draft');

    const approve = new FakeDiscordInteraction(
      'research',
      {
        action: 'approve',
        mission_id: 'R-20260510-cmd',
        plan_id: 'plan-20260510-cmd',
      },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(approve);

    expect(approve.editedReplies[0]?.content).toContain('Status: approved');
    expect(approve.editedReplies[0]?.content).toContain(
      'Phase: approved (/research-plan plan-id:plan-20260510-cmd)',
    );
    expect(approve.editedReplies[0]?.content).toContain(
      'Next: [Status] [Synthesize] [Show evidence] [Archive]',
    );
    expect(
      ledger
        .loadAll()
        .map((event) => event.type)
        .filter((type) => type.startsWith('research.mission_')),
    ).toEqual([
      'research.mission_draft_created',
      'research.mission_approved',
    ]);

    const replayed = new DiscordResearchMissionStore({ ledger });
    expect(replayed.get('R-20260510-cmd')).toMatchObject({
      status: 'approved',
      planId: 'plan-20260510-cmd',
    });
  });

  it('pauses, resumes, and completes a mission through lifecycle actions', async () => {
    const { handlers, ledger } = createHandlers();
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'mission lifecycle controls' },
        'operator',
        'research-runs',
      ),
    );

    const pause = new FakeDiscordInteraction(
      'research',
      { action: 'pause', mission_id: 'R-20260510-cmd' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(pause);
    expect(pause.editedReplies[0]?.content).toContain('Status: blocked');
    expect(pause.editedReplies[0]?.content).toContain('Phase: paused by operator');

    const resume = new FakeDiscordInteraction(
      'research',
      { action: 'resume', mission_id: 'R-20260510-cmd' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(resume);
    expect(resume.editedReplies[0]?.content).toContain('Status: running');
    expect(resume.editedReplies[0]?.content).toContain('Phase: running');

    const complete = new FakeDiscordInteraction(
      'research',
      { action: 'complete', mission_id: 'R-20260510-cmd' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(complete);
    expect(complete.editedReplies[0]?.content).toContain('Status: completed');
    expect(complete.editedReplies[0]?.content).toContain(
      'Phase: completed closeout-ready',
    );
    expect(complete.editedReplies[0]?.content).toContain(
      'Next: [Status] [Synthesize] [Show evidence] [Archive]',
    );

    expect(
      ledger
        .loadAll()
        .map((event) => event.type)
        .filter((type) => type.startsWith('research.mission_')),
    ).toEqual([
      'research.mission_draft_created',
      'research.mission_status_updated',
      'research.mission_status_updated',
      'research.mission_status_updated',
    ]);

    const replayed = new DiscordResearchMissionStore({ ledger });
    expect(replayed.get('R-20260510-cmd')).toMatchObject({
      status: 'completed',
      phase: 'completed closeout-ready',
    });
  });

  it('limits mission lifecycle transitions to the mission owner or a Discord admin', async () => {
    const { handlers, ledger, researchMissions } = createHandlers({
      accessPolicy: new DiscordAccessPolicy({
        allowDms: true,
        adminUserIds: ['admin-user'],
      }),
    });
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'mission lifecycle owner guard' },
        'owner-user',
        'research-runs',
      ),
    );

    const denied = new FakeDiscordInteraction(
      'research',
      { action: 'pause', mission_id: 'R-20260510-cmd' },
      'other-user',
      'research-runs',
    );
    await handlers.handleInteraction(denied);
    const deniedContent = denied.editedReplies[0]?.content ?? '';
    expect(deniedContent).toContain(
      'Research mission `R-20260510-cmd` was not changed.',
    );
    expect(deniedContent).toContain(
      'Only the mission owner or a Discord admin',
    );
    expect(deniedContent).not.toContain('owner-user');
    expect(denied.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(researchMissions.get('R-20260510-cmd')).toMatchObject({
      status: 'draft',
      phase: 'plan draft',
    });

    const admin = new FakeDiscordInteraction(
      'research',
      { action: 'complete', mission_id: 'R-20260510-cmd' },
      'admin-user',
      'research-runs',
    );
    await handlers.handleInteraction(admin);
    expect(admin.editedReplies[0]?.content).toContain('Status: completed');
    expect(admin.editedReplies[0]?.content).toContain(
      'Phase: completed closeout-ready',
    );
    expect(
      ledger
        .loadAll()
        .map((event) => event.type)
        .filter((type) => type.startsWith('research.mission_')),
    ).toEqual([
      'research.mission_draft_created',
      'research.mission_status_updated',
    ]);
  });

  it('keeps read-only mission inspection available to authorized non-owners', async () => {
    const { handlers } = createHandlers({
      accessPolicy: new DiscordAccessPolicy({ allowDms: true }),
    });
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'read-only mission inspection' },
        'owner-user',
        'research-runs',
      ),
    );

    const show = new FakeDiscordInteraction(
      'research',
      { action: 'show', mission_id: 'R-20260510-cmd' },
      'other-user',
      'research-runs',
    );
    await handlers.handleInteraction(show);
    expect(show.editedReplies[0]?.content).toContain(
      'Research Mission `R-20260510-cmd`',
    );

    const status = new FakeDiscordInteraction(
      'research',
      { action: 'status', mission_id: 'R-20260510-cmd' },
      'other-user',
      'research-runs',
    );
    await handlers.handleInteraction(status);
    expect(status.editedReplies[0]?.content).toContain('Status: draft');

    const pin = new FakeDiscordInteraction(
      'research',
      { action: 'pin', mission_id: 'R-20260510-cmd' },
      'other-user',
      'research-runs',
    );
    await handlers.handleInteraction(pin);
    expect(pin.editedReplies[0]?.content).toContain(
      '📌 Research Mission Pin `R-20260510-cmd`',
    );
  });

  it('defaults lifecycle transitions to owner-only when no access policy is configured', async () => {
    const { handlers, ledger, researchMissions } = createHandlers();
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'owner only lifecycle default' },
        'owner-user',
        'research-runs',
      ),
    );

    const denied = new FakeDiscordInteraction(
      'research',
      { action: 'complete', mission_id: 'R-20260510-cmd' },
      'other-user',
      'research-runs',
    );
    await handlers.handleInteraction(denied);
    expect(denied.editedReplies[0]?.content).toContain(
      'Only the mission owner or a Discord admin',
    );
    expect(denied.editedReplies[0]?.content).not.toContain('owner-user');
    expect(researchMissions.get('R-20260510-cmd')).toMatchObject({
      status: 'draft',
    });

    const owner = new FakeDiscordInteraction(
      'research',
      { action: 'pause', mission_id: 'R-20260510-cmd' },
      'owner-user',
      'research-runs',
    );
    await handlers.handleInteraction(owner);
    expect(owner.editedReplies[0]?.content).toContain('Status: blocked');
    expect(
      ledger
        .loadAll()
        .map((event) => event.type)
        .filter((type) => type.startsWith('research.mission_')),
    ).toEqual([
      'research.mission_draft_created',
      'research.mission_status_updated',
    ]);
  });

  it('shows mission-scoped subagent role state in the mission summary when an operator roster is wired', async () => {
    const subagentOperator = new SubagentOperatorSurface({
      roster: createStubRoster([
        subagentDescriptor({
          subagentId: 'subagent-collector-1',
          role: 'collector' as SubagentDescriptor['role'],
          state: 'active',
          parent: {
            taskId: 'discord-research-mission-plan-R-20260510-cmd-001',
            instanceId: 'parent-inst',
          },
        }),
        subagentDescriptor({
          subagentId: 'subagent-critic-1',
          role: 'critic' as SubagentDescriptor['role'],
          state: 'reserved',
          parent: {
            taskId: 'discord-research-mission-plan-R-20260510-cmd-001',
            instanceId: 'parent-inst',
          },
        }),
        subagentDescriptor({
          subagentId: 'subagent-other-mission',
          role: 'collector' as SubagentDescriptor['role'],
          state: 'active',
          parent: {
            taskId: 'discord-research-mission-plan-R-other-001',
            instanceId: 'parent-inst',
          },
        }),
      ]),
    });
    const { handlers } = createHandlers({ subagentOperator });
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'mission subagent role state' },
        'operator',
        'research-runs',
      ),
    );

    const show = new FakeDiscordInteraction(
      'research',
      { action: 'show', mission_id: 'R-20260510-cmd' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(show);

    const content = show.editedReplies[0]?.content ?? '';
    expect(content).toContain('Subagents: 2 mission matches');
    expect(content).toContain(
      'Subagent roles: collector 1 active; critic 1 reserved',
    );
    expect(content).not.toContain('subagent-other-mission');
    expect(content).not.toContain('R-other');
  });

  it('renders a pin-ready mission card from /research action:pin', async () => {
    const { handlers } = createHandlers();
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'mission pin summary' },
        'operator',
        'research-runs',
      ),
    );

    const pin = new FakeDiscordInteraction(
      'research',
      { action: 'pin', mission_id: 'R-20260510-cmd' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(pin);

    expect(pin.editedReplies[0]?.content).toContain(
      '📌 Research Mission Pin `R-20260510-cmd`',
    );
    expect(pin.editedReplies[0]?.content).toContain(
      'Progress: 0/5 plan steps complete',
    );
    expect(pin.editedReplies[0]?.content).toContain(
      'Current: Clarify scope for mission pin summary',
    );
    expect(pin.editedReplies[0]?.content).toContain(
      'Next: [Approve plan] [Show plan] [Cancel]',
    );
    expect(pin.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
  });

  it('shows configured live-proof report status in mission summary and pin cards', async () => {
    const { handlers } = createHandlers({
      liveProofReport: {
        proofPath: '/tmp/private/live-proof.json',
        maxProofBytes: 10000,
        reportStatus: 'warn',
        completeProofCount: 1,
        warnProofCount: 2,
        failProofCount: 0,
        missingRequiredArtifactCount: 3,
      },
    });
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'mission proof report bridge' },
        'operator',
        'research-runs',
      ),
    );

    const show = new FakeDiscordInteraction(
      'research',
      { action: 'show', mission_id: 'R-20260510-cmd' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(show);

    expect(show.editedReplies[0]?.content).toContain('Proof: 0 PASS, 0 WARN');
    expect(show.editedReplies[0]?.content).toContain(
      'Proof report: warn (configured live-proof manifest (global; mission-scoped linking later))',
    );
    expect(show.editedReplies[0]?.content).toContain(
      'Proof report counts: 1 complete, 2/0 warn/fail, 3 missing artifact tokens',
    );
    expect(show.editedReplies[0]?.content).not.toContain('/tmp/private');

    const pin = new FakeDiscordInteraction(
      'research',
      { action: 'pin', mission_id: 'R-20260510-cmd' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(pin);

    expect(pin.editedReplies[0]?.content).toContain(
      'Proof: 0 PASS, 0 WARN · Report: warn, 3 missing',
    );
    expect(pin.editedReplies[0]?.content).not.toContain('/tmp/private');
  });

  it('renders a research closeout preflight checklist from /research action:archive', async () => {
    const { handlers } = createHandlers({
      liveProofReport: {
        proofPath: '/tmp/private/live-proof.json',
        maxProofBytes: 10000,
        reportStatus: 'warn',
        completeProofCount: 1,
        warnProofCount: 2,
        failProofCount: 0,
        missingRequiredArtifactCount: 3,
      },
    });
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'closeout preflight mission' },
        'operator',
        'research-runs',
      ),
    );
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        {
          action: 'approve',
          mission_id: 'R-20260510-cmd',
          plan_id: 'closeout-plan',
        },
        'operator',
        'research-runs',
      ),
    );
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'evidence',
        {
          action: 'add',
          mission_id: 'R-20260510-cmd',
          summary: 'Retained evidence for closeout',
          source: 'terminal:closeout',
        },
        'operator',
        'research-runs',
      ),
    );
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'claim',
        {
          action: 'add',
          mission_id: 'R-20260510-cmd',
          text: 'Closeout checklist makes missing proof visible.',
        },
        'operator',
        'research-runs',
      ),
    );
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'claim',
        {
          action: 'support',
          mission_id: 'R-20260510-cmd',
          claim_id: 'C-20260510-cmd',
          evidence_id: 'E-20260510-cmd',
        },
        'operator',
        'research-runs',
      ),
    );
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'synthesize', mission_id: 'R-20260510-cmd' },
        'operator',
        'research-runs',
      ),
    );

    const archive = new FakeDiscordInteraction(
      'research',
      { action: 'archive', mission_id: 'R-20260510-cmd' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(archive);

    const content = archive.editedReplies[0]?.content ?? '';
    expect(content).toContain('Closeout preflight for `R-20260510-cmd`');
    expect(content).toContain('✓ research plan approved (closeout-plan)');
    expect(content).toContain('✓ synthesis report exists (S-20260510-cmd)');
    expect(content).toContain('✓ evidence ledger retained (1 item)');
    expect(content).toContain('✓ claims resolved');
    expect(content).toContain(
      '! proof report warn: 1 complete, 2/0 warn/fail, 3 missing artifact tokens',
    );
    expect(content).toContain(
      '- Run /proof action:status and capture missing live-proof artifacts',
    );
    expect(content).toContain(
      'Actions: [Archive anyway] [Run missing proof] [Cancel]',
    );
    expect(content).not.toContain('/tmp/private');
    expect(archive.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(archive.editedReplies[0]?.components?.[0]?.components).toEqual([
      expect.objectContaining({
        customId: 'research-closeout:archive-anyway:R-20260510-cmd',
        label: 'Archive anyway',
      }),
      expect.objectContaining({
        customId: 'research-closeout:run-missing-proof:R-20260510-cmd',
        label: 'Run missing proof',
      }),
      expect.objectContaining({
        customId: 'research-closeout:cancel:R-20260510-cmd',
        label: 'Cancel',
      }),
    ]);
  });

  it('approves a mission when a configured plan store finds the plan_id', async () => {
    const researchPlans = new DiscordResearchPlanStore({
      loadPlan: () => VALID_RESEARCH_PLAN as never,
      resolvePlanPath: () => '/configured/research-plan.json',
    });
    const { handlers, ledger } = createHandlers({ researchPlans });
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'validated approval path' },
        'operator',
        'research-runs',
      ),
    );

    const approve = new FakeDiscordInteraction(
      'research',
      {
        action: 'approve',
        mission_id: 'R-20260510-cmd',
        plan_id: 'validated-plan',
      },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(approve);

    expect(approve.editedReplies[0]?.content).toContain('Status: approved');
    expect(approve.editedReplies[0]?.content).toContain(
      'Phase: approved (/research-plan plan-id:validated-plan)',
    );
    expect(
      ledger
        .loadAll()
        .map((event) => event.type)
        .filter((type) => type.startsWith('research.mission_')),
    ).toEqual([
      'research.mission_draft_created',
      'research.mission_approved',
    ]);
  });

  it('dispatches the approved plan through the research-plan orchestrator when a driver is wired', async () => {
    const driver = makeResearchPlanDriver();
    const researchPlans = new DiscordResearchPlanStore({
      loadPlan: () => VALID_RESEARCH_PLAN as never,
      resolvePlanPath: () => '/configured/research-plan.json',
    });
    const { handlers, researchMissions } = createHandlers({
      researchPlans,
      researchPlanRuntimeDriver: driver,
    });
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'approved plan dispatch bridge' },
        'operator',
        'research-runs',
      ),
    );

    const approve = new FakeDiscordInteraction(
      'research',
      {
        action: 'approve',
        mission_id: 'R-20260510-cmd',
        plan_id: 'connected-plan',
      },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(approve);
    await flushDiscordAsyncWork();

    expect(approve.editedReplies[0]?.content).toContain('Status: approved');
    expect(approve.followUpReplies[0]?.content).toContain(
      'Research plan `connected-plan` accepted.',
    );
    expect(approve.followUpReplies[0]?.content).toContain('Sub-tasks queued: **2**');
    expect(driver.run).toHaveBeenCalledTimes(3);
    expect(researchMissions.listEvidence('R-20260510-cmd')).toEqual([
      expect.objectContaining({
        evidenceId: 'E-20260510-cmd',
        source: 'research-plan:connected-plan/collect',
        summary:
          'Research-plan sub-task collect completed with success: collect-done',
      }),
      expect.objectContaining({
        evidenceId: 'E-20260510-cmd-2',
        source: 'research-plan:connected-plan/audit',
        summary: 'Research-plan sub-task audit completed with success: audit-done',
      }),
    ]);
    const show = new FakeDiscordInteraction(
      'research',
      { action: 'show', mission_id: 'R-20260510-cmd' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(show);
    expect(show.editedReplies[0]?.content).toContain('Evidence: 2 items');
  });

  it('records approved sub-task evidence from result reasons when no final text is emitted', async () => {
    const driver = makeReasonOnlyResearchPlanDriver();
    const researchPlans = new DiscordResearchPlanStore({
      loadPlan: () => VALID_RESEARCH_PLAN as never,
      resolvePlanPath: () => '/configured/research-plan.json',
    });
    const { handlers, researchMissions } = createHandlers({
      researchPlans,
      researchPlanRuntimeDriver: driver,
    });
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'reason-only evidence bridge' },
        'operator',
        'research-runs',
      ),
    );

    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        {
          action: 'approve',
          mission_id: 'R-20260510-cmd',
          plan_id: 'reason-only-plan',
        },
        'operator',
        'research-runs',
      ),
    );
    await flushDiscordAsyncWork();

    expect(driver.run).toHaveBeenCalledTimes(3);
    expect(researchMissions.listEvidence('R-20260510-cmd')).toEqual([
      expect.objectContaining({
        source: 'research-plan:reason-only-plan/collect',
        summary:
          'Research-plan sub-task collect completed with success: collect-reason-only',
      }),
      expect.objectContaining({
        source: 'research-plan:reason-only-plan/audit',
        summary:
          'Research-plan sub-task audit completed with success: audit-reason-only',
      }),
    ]);
  });

  it('records approved sub-task evidence from driver-threw text on early stop', async () => {
    const driver = makeThrowingResearchPlanDriver();
    const researchPlans = new DiscordResearchPlanStore({
      loadPlan: () => VALID_RESEARCH_PLAN as never,
      resolvePlanPath: () => '/configured/research-plan.json',
    });
    const { handlers, researchMissions } = createHandlers({
      researchPlans,
      researchPlanRuntimeDriver: driver,
    });
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'driver-threw evidence bridge' },
        'operator',
        'research-runs',
      ),
    );

    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        {
          action: 'approve',
          mission_id: 'R-20260510-cmd',
          plan_id: 'driver-threw-plan',
        },
        'operator',
        'research-runs',
      ),
    );
    await flushDiscordAsyncWork();

    expect(driver.run).toHaveBeenCalledTimes(1);
    expect(researchMissions.listEvidence('R-20260510-cmd')).toEqual([
      expect.objectContaining({
        evidenceId: 'E-20260510-cmd',
        source: 'research-plan:driver-threw-plan/collect',
        summary:
          'Research-plan sub-task collect completed with driver-threw: Error: collect driver exploded',
      }),
    ]);
  });

  it('redacts filesystem paths from mission approval plan-load failures', async () => {
    const researchPlans = new DiscordResearchPlanStore({
      loadPlan: () => {
        throw new Error(
          'plan missing at /tmp/private/research-plans/missing.json for @everyone and `inline`',
        );
      },
      resolvePlanPath: () => '/unused/plan.json',
    });
    const { handlers } = createHandlers({ researchPlans });
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'path redaction gate' },
        'operator',
        'research-runs',
      ),
    );

    const approve = new FakeDiscordInteraction(
      'research',
      {
        action: 'approve',
        mission_id: 'R-20260510-cmd',
        plan_id: 'missing-plan',
      },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(approve);

    expect(approve.editedReplies[0]?.content).toContain('[path]');
    expect(approve.editedReplies[0]?.content).not.toContain('/tmp/private');
    expect(approve.editedReplies[0]?.content).toContain('@\u200Beveryone');
    expect(approve.editedReplies[0]?.content).toContain('ʼinlineʼ');
    expect(approve.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
  });

  it('responds gracefully for missing mission command inputs', async () => {
    const { handlers } = createHandlers();
    const missingInstruction = new FakeDiscordInteraction(
      'research',
      { action: 'new' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(missingInstruction);
    expect(missingInstruction.editedReplies[0]?.content).toContain(
      '`/research action:new` requires option `instruction`.',
    );
    expect(missingInstruction.editedReplies[0]?.allowedMentions).toEqual({
      parse: [],
    });

    const unknown = new FakeDiscordInteraction(
      'research',
      { action: 'status', mission_id: 'R-missing-@everyone`' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(unknown);
    expect(unknown.editedReplies[0]?.content).toContain(
      'Research mission `R-missing-@\u200Beveryoneʼ` is not tracked',
    );
    expect(unknown.editedReplies[0]?.content).not.toContain('@everyone');
    expect(unknown.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
  });

  it('sanitizes unsupported action names and preserves legacy instruction dispatch', async () => {
    const { handlers } = createHandlers();
    const unsupported = new FakeDiscordInteraction(
      'research',
      { action: 'bad-@everyone`' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(unsupported);
    expect(unsupported.editedReplies[0]?.content).toContain(
      '`/research action:bad-@\u200Beveryoneʼ` requires option `action`.',
    );
    expect(unsupported.editedReplies[0]?.content).not.toContain('@everyone');
    expect(unsupported.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });

    const createdInstructions: string[] = [];
    const legacyHandlers = new DiscordCommandHandlers({
      arona: {
        requestDispatch: async () => ({
          kind: 'vetoed',
          veto: { reason: 'legacy-dispatch-test', provenance: 'test' },
        }),
      } as never,
      dispatcher: {} as never,
      requestFactory: {
        createAskTaskRequest(seed) {
          createdInstructions.push(seed.instruction);
          return {
            taskId: 'discord-task-legacy-research',
            instruction: seed.instruction,
            resources: {
              requested: {
                cpuCores: 1,
                memoryMiB: 128,
                wallTimeSec: 60,
                gpuCards: 0,
              },
            },
            runtimeSettings: {
              networkProfile: 'provider-only',
              sandboxMode: 'workspace-write',
              approvalPolicy: 'on-request',
            },
          } as never;
        },
      },
    });
    const legacy = new FakeDiscordInteraction(
      'research',
      {
        instruction: 'legacy research task',
        title: 'ignored mission-only title',
        mission_id: 'ignored-mission',
        plan_id: 'ignored-plan',
      },
      'operator',
      'research-runs',
    );
    await legacyHandlers.handleInteraction(legacy);

    expect(createdInstructions).toEqual(['legacy research task']);
    expect(legacy.editedReplies[0]?.content).toContain(
      'Dispatch vetoed for task `discord-task-legacy-research`.',
    );
  });

  it('rejects mission approval before ledger mutation when a configured plan store cannot load plan_id', async () => {
    const researchPlans = new DiscordResearchPlanStore({
      loadPlan: () => {
        throw new Error('plan missing for @everyone and `inline`');
      },
      resolvePlanPath: () => '/unused/plan.json',
    });
    const { handlers, ledger } = createHandlers({ researchPlans });
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'plan validation gate' },
        'operator',
        'research-runs',
      ),
    );

    const approve = new FakeDiscordInteraction(
      'research',
      {
        action: 'approve',
        mission_id: 'R-20260510-cmd',
        plan_id: 'missing-plan',
      },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(approve);

    expect(approve.editedReplies[0]?.content).toContain(
      'Research plan `missing-plan` could not be loaded for mission approval.',
    );
    expect(approve.editedReplies[0]?.content).toContain('@\u200Beveryone');
    expect(approve.editedReplies[0]?.content).toContain('ʼinlineʼ');
    expect(approve.editedReplies[0]?.content).not.toContain('@everyone');
    expect(approve.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(
      ledger
        .loadAll()
        .map((event) => event.type)
        .filter((type) => type.startsWith('research.mission_')),
    ).toEqual(['research.mission_draft_created']);
  });

  it('adds evidence and links it to mission claims through Discord commands', async () => {
    const { handlers, ledger, researchMissions } = createHandlers();
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'evidence claim mission' },
        'operator',
        'research-runs',
      ),
    );

    const evidenceAdd = new FakeDiscordInteraction(
      'evidence',
      {
        action: 'add',
        mission_id: 'R-20260510-cmd',
        summary: 'TerminalEvidence retained for baseline comparison',
        source: 'terminal:task-baseline',
      },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(evidenceAdd);
    expect(evidenceAdd.editedReplies[0]?.content).toContain(
      'Evidence `E-20260510-cmd` added',
    );
    expect(evidenceAdd.editedReplies[0]?.content).toContain(
      'Mission evidence count: 1',
    );
    expect(evidenceAdd.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });

    const claimAdd = new FakeDiscordInteraction(
      'claim',
      {
        action: 'add',
        mission_id: 'R-20260510-cmd',
        text: 'Pinned summaries reduce intermediate state lookup time.',
      },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(claimAdd);
    expect(claimAdd.editedReplies[0]?.content).toContain(
      'Claim `C-20260510-cmd` added',
    );
    expect(claimAdd.editedReplies[0]?.content).toContain(
      'Mission claims: 0 supported, 1 uncertain, 0 challenged',
    );

    const support = new FakeDiscordInteraction(
      'claim',
      {
        action: 'support',
        mission_id: 'R-20260510-cmd',
        claim_id: 'C-20260510-cmd',
        evidence_id: 'E-20260510-cmd',
      },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(support);
    expect(support.editedReplies[0]?.content).toContain(
      'Evidence `E-20260510-cmd` now supports claim `C-20260510-cmd`',
    );
    expect(support.editedReplies[0]?.content).toContain(
      'Mission claims: 1 supported, 0 uncertain, 0 challenged',
    );

    const evidenceList = new FakeDiscordInteraction(
      'evidence',
      { action: 'list', mission_id: 'R-20260510-cmd' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(evidenceList);
    expect(evidenceList.editedReplies[0]?.content).toContain(
      '1. `E-20260510-cmd` — TerminalEvidence retained for baseline comparison',
    );

    const claimList = new FakeDiscordInteraction(
      'claim',
      { action: 'list', mission_id: 'R-20260510-cmd' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(claimList);
    expect(claimList.editedReplies[0]?.content).toContain(
      '1. `C-20260510-cmd` [supported]',
    );

    const show = new FakeDiscordInteraction(
      'research',
      { action: 'show', mission_id: 'R-20260510-cmd' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(show);
    expect(show.editedReplies[0]?.content).toContain('Evidence: 1 item');
    expect(show.editedReplies[0]?.content).toContain(
      'Claims: 1 supported, 0 uncertain, 0 challenged',
    );

    const synthesize = new FakeDiscordInteraction(
      'research',
      { action: 'synthesize', mission_id: 'R-20260510-cmd' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(synthesize);
    expect(synthesize.editedReplies[0]?.content).toContain(
      'Synthesis draft `S-20260510-cmd`',
    );
    expect(synthesize.editedReplies[0]?.content).toContain('Evidence basis: 1 item');
    expect(synthesize.editedReplies[0]?.content).toContain(
      'Claims: 1 supported, 0 uncertain, 0 challenged',
    );
    expect(synthesize.editedReplies[0]?.content).toContain(
      'support: E-20260510-cmd',
    );
    expect(researchMissions.getLatestSynthesis('R-20260510-cmd')).toEqual(
      expect.objectContaining({
        synthesisId: 'S-20260510-cmd',
        missionId: 'R-20260510-cmd',
      }),
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

  it('renders a read-only critique preflight without mutating mission evidence', async () => {
    const { handlers, ledger } = createHandlers();
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'critique preflight mission' },
        'operator',
        'research-runs',
      ),
    );
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'evidence',
        {
          action: 'add',
          mission_id: 'R-20260510-cmd',
          summary: 'Evidence retained for critique review',
          source: 'terminal:critique',
        },
        'operator',
        'research-runs',
      ),
    );
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'claim',
        {
          action: 'add',
          mission_id: 'R-20260510-cmd',
          text: 'Evidence lens should be first-class in Discord.',
        },
        'operator',
        'research-runs',
      ),
    );
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'claim',
        {
          action: 'support',
          mission_id: 'R-20260510-cmd',
          claim_id: 'C-20260510-cmd',
          evidence_id: 'E-20260510-cmd',
        },
        'operator',
        'research-runs',
      ),
    );
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'claim',
        {
          action: 'add',
          mission_id: 'R-20260510-cmd',
          text: 'Counterarguments still need review.',
        },
        'operator',
        'research-runs',
      ),
    );
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'synthesize', mission_id: 'R-20260510-cmd' },
        'operator',
        'research-runs',
      ),
    );
    const researchEventsBeforeCritique = ledger
      .loadAll()
      .map((event) => event.type)
      .filter((type) => type.startsWith('research.'));

    const critique = new FakeDiscordInteraction(
      'critique',
      {
        mission_id: 'R-20260510-cmd',
        lens: 'counterargument',
      },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(critique);

    const content = critique.editedReplies[0]?.content ?? '';
    expect(content).toContain(
      'Critique preflight for research mission `R-20260510-cmd`',
    );
    expect(content).toContain('Lens: counterargument');
    expect(content).toContain('Evidence: 1 item');
    expect(content).toContain('Claims: 1 supported, 1 uncertain, 0 challenged');
    expect(content).toContain('Synthesis: `S-20260510-cmd`');
    expect(content).toContain('! 1 uncertain claim(s) need review');
    expect(content).toContain('Boundary: read-only preflight only');
    expect(content).toContain('no external critic invoked');
    expect(critique.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(
      ledger
        .loadAll()
        .map((event) => event.type)
        .filter((type) => type.startsWith('research.')),
    ).toEqual(researchEventsBeforeCritique);
  });

  it('renders a mission-scoped doctor without mutating research state', async () => {
    const { handlers, ledger } = createHandlers({
      activeRuntimeProvider: 'codex',
      runtimeProviderScope: 'multi-provider',
      liveProofReport: {
        proofPath: '/tmp/private/live-proof.json',
        maxProofBytes: 10000,
        reportStatus: 'warn',
        completeProofCount: 1,
        warnProofCount: 1,
        failProofCount: 0,
        missingRequiredArtifactCount: 2,
      },
    });
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'new', instruction: 'mission doctor research integrity' },
        'operator',
        'research-runs',
      ),
    );
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        {
          action: 'approve',
          mission_id: 'R-20260510-cmd',
          plan_id: 'plan-20260510-cmd',
        },
        'operator',
        'research-runs',
      ),
    );
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'evidence',
        {
          action: 'add',
          mission_id: 'R-20260510-cmd',
          summary: 'Mission doctor evidence retained',
          source: 'terminal:doctor',
        },
        'operator',
        'research-runs',
      ),
    );
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'claim',
        {
          action: 'add',
          mission_id: 'R-20260510-cmd',
          text: 'Mission doctor should surface unresolved claims.',
        },
        'operator',
        'research-runs',
      ),
    );
    await handlers.handleInteraction(
      new FakeDiscordInteraction(
        'research',
        { action: 'synthesize', mission_id: 'R-20260510-cmd' },
        'operator',
        'research-runs',
      ),
    );
    const researchEventsBeforeDoctor = ledger
      .loadAll()
      .map((event) => event.type)
      .filter((type) => type.startsWith('research.'));

    const doctor = new FakeDiscordInteraction(
      'doctor',
      { mission_id: 'R-20260510-cmd' },
      'operator',
      'research-runs',
    );
    await handlers.handleInteraction(doctor);

    const content = doctor.editedReplies[0]?.content ?? '';
    expect(doctor.deferredReplies).toEqual([{ ephemeral: true }]);
    expect(doctor.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(content).toContain('Research Mission Doctor `R-20260510-cmd`');
    expect(content).toContain(
      'Status: synthesizing · Phase: claim/evidence synthesis',
    );
    expect(content).toContain('✓ provider: codex (scope: multi-provider)');
    expect(content).toContain('! mission thread: current channel only');
    expect(content).toContain('✓ plan approved: plan-20260510-cmd');
    expect(content).toContain('✓ synthesis: S-20260510-cmd');
    expect(content).toContain('✓ evidence retained: 1 item');
    expect(content).toContain('! claims unresolved: 1 uncertain, 0 challenged');
    expect(content).toContain(
      '! global proof report warn: 1 complete, 1/0 warn/fail, 2 missing artifact tokens',
    );
    expect(content).toContain('Mission-local proof: 0 PASS, 0 WARN, 0 FAIL');
    expect(content).toContain(
      'Recommended next action: /critique mission_id:R-20260510-cmd lens:counterargument',
    );
    expect(content).toContain('Boundary: read-only mission doctor');
    expect(content).not.toContain('/tmp/private');
    expect(
      ledger
        .loadAll()
        .map((event) => event.type)
        .filter((type) => type.startsWith('research.')),
    ).toEqual(researchEventsBeforeDoctor);
  });
});
