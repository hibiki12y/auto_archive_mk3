import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DiscordAccessPolicy,
  DiscordCommandHandlers,
  DISCORD_ESCALATION_REASON_MAX_LENGTH,
  SeededDiscordAuthDatabase,
  DiscordTaskRegistry,
  InMemoryControlPlaneLedger,
  InMemoryTraitUsageTelemetry,
  renderDoctor,
  traitModuleRegistryKey,
  type TraitModuleManifest,
  type TraitModuleRegistry,
  type TerminalEvidence,
} from '../src/index.js';
import { FakeDiscordInteraction } from './helpers/discord.js';

const TEST_ADMIN_USER_ID = 'admin-1';

const acceptance = {
  taskId: 'discord-task-1' as never,
  acceptedAt: '2026-04-26T00:00:00.000Z',
  boundary: 'dispatcher' as const,
};

const terminalEvidence: TerminalEvidence = {
  taskId: 'discord-task-1',
  runtimeInstanceId: 'runtime-1',
  reason: 'done',
  provenance: 'test',
  executionContext: {
    planCreatedAt: '2026-04-26T00:00:00.000Z',
    runtimeSettings: {
      networkProfile: 'provider-only',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkProjection: { networkAccessEnabled: true, webSearchMode: 'provider' },
    },
  },
  resourceEnvelope: {
    requested: { cpuCores: 1, memoryMiB: 128, wallTimeSec: 60, gpuCards: 0 },
    effective: { cpuCores: 1, memoryMiB: 128, wallTimeSec: 60, gpuCards: 0 },
  },
  startedAt: '2026-04-26T00:00:00.000Z',
  endedAt: '2026-04-26T00:00:01.000Z',
  artifactLocation: 'results/task-artifacts',
  cause: {
    kind: 'success',
    taskId: 'discord-task-1',
    runtimeInstanceId: 'runtime-1',
    observedAt: '2026-04-26T00:00:01.000Z',
    provenance: 'test',
  },
};

function createTestTraitModuleRegistry(): TraitModuleRegistry {
  const manifest: TraitModuleManifest = {
    schemaVersion: 1,
    id: 'trait.test.discovery.v1',
    name: 'test-@everyone-discovery',
    version: '1.0.0',
    trustBoundary: 'repository-owned',
    layout: {
      root: 'traits/test-discovery',
      manifest: 'trait.json',
      instruction: 'TRAIT.md',
      runtimeDir: 'runtime',
      schedulesDir: 'schedules',
    },
    instructions: {
      entrypoint: 'TRAIT.md',
      format: 'markdown',
      summary: 'test-only `trait` discovery manifest',
    },
    schedule: { mode: 'none' },
    runtime: {
      hook: 'evidence-decorator',
      modulePath: 'src/runtime/test-trait-runtime-driver.ts',
      exportName: 'composeTraitRuntimeDriver',
      enforcement: 'required',
      summary: 'test-only runtime decorator summary',
    },
    admission: {
      defaultRequested: false,
      requiredCapabilityFlags: [],
      forbiddenCapabilityFlags: ['network-access'],
      provenance: 'test-trait-discovery',
    },
    sourceMapIds: ['test-source'],
  };
  const registryKey = traitModuleRegistryKey(manifest);
  const entry = {
    manifest,
    manifestPath: 'traits/test-discovery/trait.json',
    rootPath: 'traits/test-discovery',
    instructionPath: 'traits/test-discovery/TRAIT.md',
    registryKey,
  };
  return {
    entries: [entry],
    byRegistryKey: new Map([[registryKey, entry]]),
    byId: new Map([[manifest.id, [entry]]]),
  };
}

describe('discord always-on control plane slice', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays task registry state from the control ledger', () => {
    const ledger = new InMemoryControlPlaneLedger();
    const firstRegistry = new DiscordTaskRegistry({ ledger });
    firstRegistry.registerTask({
      taskId: 'discord-task-1',
      instruction: '[Discord instruction envelope]\n[Current task instruction]\nresearch',
      userId: 'user-1',
      channelId: 'chan-1',
      acceptance,
    });
    firstRegistry.observeLifecycle({
      taskId: 'discord-task-1',
      phase: 'runtime-running',
      observedAt: '2026-04-26T00:00:00.500Z',
    });
    firstRegistry.markTerminal('discord-task-1', terminalEvidence);

    const replayed = new DiscordTaskRegistry({ ledger });
    expect(replayed.get('discord-task-1')).toMatchObject({
      taskId: 'discord-task-1',
      coarseState: 'terminal',
      terminalEvidence: { reason: 'done' },
    });
    expect(replayed.list({ state: 'terminal' })).toHaveLength(1);
  });

  it('blocks unauthorized Discord commands before dispatch handlers run', async () => {
    const handlers = new DiscordCommandHandlers({
      arona: { requestDispatch: async () => { throw new Error('must not dispatch'); } } as never,
      dispatcher: {} as never,
      requestFactory: { createAskTaskRequest: () => { throw new Error('must not create'); } },
      accessPolicy: new DiscordAccessPolicy({
        allowedGuildIds: ['guild-1'],
        allowedUserIds: ['allowed-user'],
      }),
    });
    const interaction = new FakeDiscordInteraction(
      'ask',
      { instruction: 'do work' },
      'blocked-user',
      'chan-1',
      'guild-1',
    );

    await handlers.handleInteraction(interaction);

    expect(interaction.editedReplies[0]?.content).toContain('user-not-allowed');
  });

  it('handles /escalate denial, unavailable-ledger, unknown-task, and channel scope without task mutation', async () => {
    const deniedLedger = new InMemoryControlPlaneLedger();
    const deniedHandlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      controlLedger: deniedLedger,
      accessPolicy: new DiscordAccessPolicy({
        allowedUserIds: ['allowed-user'],
      }),
    });
    const denied = new FakeDiscordInteraction(
      'escalate',
      { reason: 'needs operator review' },
      'blocked-user',
      'chan-1',
      'guild-1',
    );

    await deniedHandlers.handleInteraction(denied);

    expect(denied.editedReplies[0]?.content).toContain('user-not-allowed');
    expect(deniedLedger.loadAll().some((event) => event.type === 'escalation.requested')).toBe(false);

    const unknownLedger = new InMemoryControlPlaneLedger();
    const unknownHandlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      controlLedger: unknownLedger,
      taskRegistry: new DiscordTaskRegistry({ ledger: unknownLedger }),
    });
    const unknown = new FakeDiscordInteraction(
      'escalate',
      { task_id: 'discord-task-missing', reason: 'operator please check' },
      'user-1',
      'chan-2',
    );

    await unknownHandlers.handleInteraction(unknown);

    expect(unknown.editedReplies[0]?.content).toContain(
      'Task `discord-task-missing` is not tracked',
    );
    expect(unknownLedger.loadAll().some((event) => event.type === 'escalation.requested')).toBe(false);

    const unavailable = new FakeDiscordInteraction(
      'escalate',
      { reason: 'operator please check' },
      'user-1',
      'chan-3',
    );

    await new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
    }).handleInteraction(unavailable);

    expect(unavailable.editedReplies[0]?.content).toContain(
      'Operator escalation was not recorded.',
    );
    expect(unavailable.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });

    const channelLedger = new InMemoryControlPlaneLedger();
    const channelHandlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      controlLedger: channelLedger,
    });
    const longReason = 'x'.repeat(DISCORD_ESCALATION_REASON_MAX_LENGTH + 12);
    const channelScoped = new FakeDiscordInteraction(
      'escalate',
      { reason: longReason },
      'user-1',
      'chan-4',
    );

    await channelHandlers.handleInteraction(channelScoped);

    const escalationEvent = channelLedger
      .loadAll()
      .find((event) => event.type === 'escalation.requested');
    const payload = escalationEvent?.payload as
      | { readonly scope?: string; readonly reason?: string }
      | undefined;
    expect(escalationEvent).toEqual(
      expect.objectContaining({
        conversationId: 'chan-4',
      }),
    );
    expect(escalationEvent?.taskId).toBeUndefined();
    expect(payload).toMatchObject({
      scope: 'channel',
      reason: longReason.slice(0, DISCORD_ESCALATION_REASON_MAX_LENGTH),
    });
    expect(payload?.reason).toHaveLength(DISCORD_ESCALATION_REASON_MAX_LENGTH);
    expect(channelScoped.editedReplies[0]?.content).toContain(
      'Operator escalation requested.',
    );
    expect(channelScoped.editedReplies[0]?.content).toContain('Channel: chan-4');
    expect(channelScoped.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
  });

  it('serves /feed as a bounded sanitized Discord-only control-plane tail', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T00:10:00.000Z'));
    const ledger = new InMemoryControlPlaneLedger();
    ledger.append({
      type: 'task.accepted',
      timestamp: '2026-05-05T00:06:00.000Z',
      actor: { kind: 'discord-user', userId: 'user-1' },
      channel: { kind: 'discord', channelId: 'chan-1' },
      conversationId: 'chan-1',
      taskId: 'discord-task-feed-1',
      trust: { source: 'discord', inputTrust: 'trusted' },
      payload: { phase: 'accepted' },
    });
    ledger.append({
      type: 'escalation.requested',
      timestamp: '2026-05-05T00:07:00.000Z',
      actor: { kind: 'discord-user', userId: 'user-1' },
      channel: { kind: 'discord', channelId: 'chan-1' },
      conversationId: 'chan-1',
      taskId: 'discord-task-feed-1',
      trust: { source: 'discord', inputTrust: 'untrusted' },
      payload: { reason: 'operator ping for @everyone and `inline code`' },
    });
    ledger.append({
      type: 'approval.resolved',
      timestamp: '2026-05-05T00:08:00.000Z',
      actor: { kind: 'discord-user', userId: 'user-2' },
      channel: { kind: 'discord', channelId: 'chan-1' },
      conversationId: 'chan-1',
      trust: { source: 'discord', inputTrust: 'operator-approved' },
      payload: { approvalId: 'approval-1' },
    });
    for (let index = 0; index < 210; index += 1) {
      ledger.append({
        type: 'task.lifecycle_observed',
        timestamp: `2026-05-05T00:09:${String(index % 60).padStart(2, '0')}.000Z`,
        actor: { kind: 'system' },
        channel: { kind: 'discord', channelId: 'chan-1' },
        conversationId: 'chan-1',
        taskId: `discord-task-noisy-${index}`,
        trust: { source: 'system', inputTrust: 'trusted' },
        payload: { phase: 'runtime-running' },
      });
    }
    ledger.append({
      type: 'task.terminal',
      timestamp: '2026-05-04T23:00:00.000Z',
      actor: { kind: 'system' },
      channel: { kind: 'system' },
      trust: { source: 'system', inputTrust: 'trusted' },
      payload: { phase: 'terminal' },
    });
    const handlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      controlLedger: ledger,
    });

    const feed = new FakeDiscordInteraction(
      'feed',
      { since: '5m', kind: 'escalation' },
      'user-1',
      'chan-1',
    );
    await handlers.handleInteraction(feed);

    expect(feed.editedReplies[0]?.content).toContain(
      'Control-plane feed (1, read-only, untrusted)',
    );
    expect(feed.editedReplies[0]?.content).toContain('escalation.requested');
    expect(feed.editedReplies[0]?.content).toContain('@\u200Beveryone');
    expect(feed.editedReplies[0]?.content).toContain('ʼinline codeʼ');
    expect(feed.editedReplies[0]?.content).not.toContain('@everyone');
    expect(feed.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });

    const feedSecond = new FakeDiscordInteraction(
      'feed',
      { since: '5m', kind: 'task' },
      'user-1',
      'chan-1',
    );
    await handlers.handleInteraction(feedSecond);
    expect(feedSecond.editedReplies[0]?.content).toContain(
      'task.lifecycle_observed',
    );
    expect(feedSecond.editedReplies[0]?.content).not.toContain('task.terminal');

    const rateLimited = new FakeDiscordInteraction(
      'feed',
      { since: '5m', kind: 'all' },
      'user-1',
      'chan-1',
    );
    await handlers.handleInteraction(rateLimited);
    expect(rateLimited.editedReplies[0]?.content).toContain(
      'Control-plane feed request was rate-limited.',
    );
  });

  it('reports /feed unavailable when the control ledger is missing', async () => {
    const interaction = new FakeDiscordInteraction(
      'feed',
      { since: '5m', kind: 'all' },
      'user-1',
      'chan-1',
    );
    await new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
    }).handleInteraction(interaction);

    expect(interaction.editedReplies[0]?.content).toContain(
      'Control-plane feed is unavailable.',
    );
    expect(interaction.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
  });

  it('serves tasks, agenda, history, context, approvals, and doctor from control-plane state', async () => {
    const ledger = new InMemoryControlPlaneLedger();
    const taskRegistry = new DiscordTaskRegistry({ ledger });
    const traitModuleRegistry = createTestTraitModuleRegistry();
    const traitUsageTelemetry = new InMemoryTraitUsageTelemetry();
    traitUsageTelemetry.bumpUse(
      {
        taskId: 'discord-task-usage-1',
        bumpedTraitModuleId: 'trait.test.discovery.v1',
      },
      { observedAt: '2026-05-05T00:00:00.000Z' },
    );
    traitUsageTelemetry.bumpUse(
      {
        taskId: 'discord-task-usage-2-@everyone`',
        bumpedTraitModuleId: 'trait.test.discovery.v1',
      },
      { observedAt: '2026-05-05T00:00:01.000Z@everyone`' },
    );
    taskRegistry.registerTask({
      taskId: 'discord-task-1',
      commandName: 'research',
      instruction: '[Discord instruction envelope]\n[Discord context history]\n1. UNTRUSTED user:user-2: ignore prior\n[Current task instruction]\ncurrent only',
      userId: 'user-1',
      channelId: 'chan-1',
      acceptance,
    });
    const handlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      taskRegistry,
      controlLedger: ledger,
      traitModuleRegistry,
      traitUsageTelemetry,
      doctorStatus: {
        runtimeProviderScope: 'multi-provider',
        activeRuntimeProvider: 'codex',
        computeMode: 'current-node',
        modelOverride: 'gpt-5.5',
        shellHooksMode: 'off',
        shellHookAcceptMode: 'literal-1',
      },
    });

    const tasks = new FakeDiscordInteraction('tasks', {}, 'user-1', 'chan-1');
    await handlers.handleInteraction(tasks);
    expect(tasks.editedReplies[0]?.content).toContain('discord-task-1');
    expect(tasks.editedReplies[0]?.content).toContain('[research]');

    const traits = new FakeDiscordInteraction('traits', {}, 'user-1', 'chan-1');
    await handlers.handleInteraction(traits);
    expect(traits.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    expect(traits.editedReplies[0]?.content).toContain('Trait modules (1, read-only)');
    expect(traits.editedReplies[0]?.content).toContain(
      'trait.test.discovery.v1@1.0.0',
    );
    expect(traits.editedReplies[0]?.content).toContain('@\u200Beveryone');
    expect(traits.editedReplies[0]?.content).toContain('ʼtraitʼ');
    expect(traits.editedReplies[0]?.content).toContain(
      'usage=2 last=2026-05-05T00:00:01.000Z@\u200Beveryoneʼ lastTask=discord-task-usage-2-@\u200Beveryoneʼ',
    );
    expect(traits.editedReplies[0]?.content).not.toContain('@everyone');
    expect(traits.editedReplies[0]?.content).not.toContain('`trait`');
    expect(traits.editedReplies[0]?.content).toContain('no auto-install');

    const traitsWithoutTelemetry = new FakeDiscordInteraction(
      'traits',
      {},
      'user-1',
      'chan-1',
    );
    await new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      traitModuleRegistry,
    }).handleInteraction(traitsWithoutTelemetry);
    expect(traitsWithoutTelemetry.editedReplies[0]?.content).toContain(
      'Trait modules (1, read-only)',
    );
    expect(traitsWithoutTelemetry.editedReplies[0]?.content).not.toContain('usage=');

    const agendaAdd = new FakeDiscordInteraction(
      'agenda',
      { action: 'add', text: 'Compare OpenClaw session reuse' },
      'user-1',
      'chan-1',
    );
    await handlers.handleInteraction(agendaAdd);
    expect(agendaAdd.editedReplies[0]?.content).toContain(
      'Research agenda item added',
    );
    const agendaId =
      agendaAdd.editedReplies[0]?.content.match(/research-agenda-[A-Za-z0-9_-]+/u)?.[0] ??
      '';

    const agendaList = new FakeDiscordInteraction(
      'agenda',
      { action: 'list', status: 'open' },
      'user-1',
      'chan-1',
    );
    await handlers.handleInteraction(agendaList);
    expect(agendaList.editedReplies[0]?.content).toContain(
      'Compare OpenClaw session reuse',
    );

    const agendaDone = new FakeDiscordInteraction(
      'agenda',
      { action: 'done', item_id: agendaId },
      'user-1',
      'chan-1',
    );
    await handlers.handleInteraction(agendaDone);
    expect(agendaDone.editedReplies[0]?.content).toContain(
      'Research agenda item completed',
    );

    const cadence = new FakeDiscordInteraction(
      'agenda',
      { action: 'cadence', text: 'daily review after terminal research tasks' },
      'user-1',
      'chan-1',
    );
    await handlers.handleInteraction(cadence);
    expect(cadence.editedReplies[0]?.content).toContain(
      'daily review after terminal research tasks',
    );
    expect(
      ledger.loadAll().some((event) => event.type === 'research.cadence_set'),
    ).toBe(true);

    const status = new FakeDiscordInteraction(
      'status',
      { task_id: 'discord-task-1' },
      'user-1',
      'chan-1',
    );
    await handlers.handleInteraction(status);
    expect(status.editedReplies[0]?.content).toContain('Command: research');
    expect(status.editedReplies[0]?.content).toContain('Research progress: accepted');

    const history = new FakeDiscordInteraction('history', { task_id: 'discord-task-1' }, 'user-1', 'chan-1');
    await handlers.handleInteraction(history);
    expect(history.editedReplies[0]?.content).toContain('History');
    expect(history.editedReplies[0]?.content).toContain('task.accepted');
    expect(history.editedReplies[0]?.content).not.toContain('Discord talk history');

    ledger.append({
      type: 'conversation.message_observed',
      actor: { kind: 'discord-user', userId: 'user-2' },
      channel: { kind: 'discord', channelId: 'chan-1' },
      conversationId: 'chan-1',
      trust: { source: 'discord', inputTrust: 'untrusted' },
      payload: {
        content: 'follow-up talk with @everyone and `inline code`',
        authorIsBot: false,
      },
    });
    const talkHistory = new FakeDiscordInteraction(
      'history',
      { view: 'talk', limit: '5' },
      'user-1',
      'chan-1',
    );
    await handlers.handleInteraction(talkHistory);
    expect(talkHistory.editedReplies[0]?.content).toContain(
      'Discord talk history (1, read-only, untrusted)',
    );
    expect(talkHistory.editedReplies[0]?.content).toContain('@\u200Beveryone');
    expect(talkHistory.editedReplies[0]?.content).toContain('ʼinline codeʼ');
    expect(talkHistory.editedReplies[0]?.content).not.toContain('@everyone');
    expect(talkHistory.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });

    const taskScopedTalkHistory = new FakeDiscordInteraction(
      'history',
      { task_id: 'discord-task-1', view: 'talk', limit: '5' },
      'user-1',
      'other-channel',
    );
    await handlers.handleInteraction(taskScopedTalkHistory);
    expect(taskScopedTalkHistory.editedReplies[0]?.content).toContain(
      'Discord talk history (1, read-only, untrusted)',
    );
    expect(taskScopedTalkHistory.editedReplies[0]?.content).toContain(
      'channel=chan-1',
    );

    const emptyTalkHistory = new FakeDiscordInteraction(
      'history',
      { view: 'talk', limit: '5' },
      'user-1',
      'empty-channel',
    );
    await handlers.handleInteraction(emptyTalkHistory);
    expect(emptyTalkHistory.editedReplies[0]?.content).toContain(
      'No Discord talk history matched that query.',
    );
    expect(emptyTalkHistory.editedReplies[0]?.allowedMentions).toEqual({
      parse: [],
    });

    const context = new FakeDiscordInteraction('context', { task_id: 'discord-task-1' }, 'user-1', 'chan-1');
    await handlers.handleInteraction(context);
    expect(context.editedReplies[0]?.content).toContain('UNTRUSTED');

    const escalate = new FakeDiscordInteraction(
      'escalate',
      {
        task_id: 'discord-task-1',
        reason: 'needs operator review for @everyone and `inline code`',
      },
      'user-1',
      'chan-1',
    );
    await handlers.handleInteraction(escalate);
    expect(escalate.editedReplies[0]?.content).toContain(
      'Operator escalation requested.',
    );
    expect(escalate.editedReplies[0]?.content).toContain('Task: discord-task-1');
    expect(escalate.editedReplies[0]?.content).toContain('@\u200Beveryone');
    expect(escalate.editedReplies[0]?.content).toContain('ʼinline codeʼ');
    expect(escalate.editedReplies[0]?.content).not.toContain('@everyone');
    expect(escalate.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
    const escalationEvent = ledger
      .loadAll()
      .find((event) => event.type === 'escalation.requested');
    expect(escalationEvent).toEqual(
      expect.objectContaining({
        taskId: 'discord-task-1',
        conversationId: 'chan-1',
      }),
    );
    expect(escalationEvent?.payload).toMatchObject({
      commandName: 'escalate',
      scope: 'task',
      reason: 'needs operator review for @everyone and `inline code`',
    });

    const approve = new FakeDiscordInteraction('approve', { approval_id: 'approval-1', note: 'ok' }, 'user-1', 'chan-1');
    await handlers.handleInteraction(approve);
    expect(approve.editedReplies[0]?.content).toContain('approved');
    expect(ledger.loadAll().some((event) => event.type === 'approval.resolved')).toBe(true);

    const doctor = new FakeDiscordInteraction('doctor', {}, 'user-1', 'chan-1');
    await handlers.handleInteraction(doctor);
    expect(doctor.editedReplies[0]?.content).toContain('Multi-provider');
    expect(doctor.editedReplies[0]?.content).toContain('active: codex');
    expect(doctor.editedReplies[0]?.content).toContain('gpt-5.5');
    expect(doctor.editedReplies[0]?.content).toContain('Shell-hook bridge');
    expect(doctor.editedReplies[0]?.content).toContain(
      'AUTO_ARCHIVE_ACCEPT_HOOKS is ignored while AUTO_ARCHIVE_SHELL_HOOKS',
    );
    expect(doctor.editedReplies[0]?.content).not.toContain('Codex SDK only');

    const claudeDoctor = renderDoctor({
      ledgerEnabled: true,
      accessPolicyEnabled: false,
      runtimeProviderScope: 'multi-provider',
      activeRuntimeProvider: 'claude-agent',
      anthropicAuthSource: 'none',
    }).content;
    expect(claudeDoctor).toContain('Multi-provider');
    expect(claudeDoctor).toContain('active: claude-agent');
    expect(claudeDoctor).toContain('[FAIL] Anthropic auth / Claude model override');
  });

  it('reports a configured Claude Agent provider through the doctor command', async () => {
    const handlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      doctorStatus: {
        runtimeProviderScope: 'multi-provider',
        activeRuntimeProvider: 'claude-agent',
        anthropicAuthSource: 'api-key',
        claudeModelOverride: 'claude-opus-4-7',
      },
    });

    const doctor = new FakeDiscordInteraction('doctor', {}, 'user-1', 'chan-1');
    await handlers.handleInteraction(doctor);

    expect(doctor.editedReplies[0]?.content).toContain('Multi-provider');
    expect(doctor.editedReplies[0]?.content).toContain('active: claude-agent');
    expect(doctor.editedReplies[0]?.content).toContain(
      '[PASS] Anthropic auth / Claude model override',
    );
    expect(doctor.editedReplies[0]?.content).toContain('claude-opus-4-7');
  });

  it('reports task-health in-flight stall problems through the doctor command', async () => {
    const handlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      doctorStatus: {
        runtimeProviderScope: 'multi-provider',
        activeRuntimeProvider: 'codex',
        taskHealthObserverEnabled: true,
        inFlightProblems: [
          {
            taskId: 'task-stalled-via-doctor',
            kind: 'stall',
            observedAt: '2026-05-05T00:00:05.000Z',
            lastProgressAt: '2026-05-05T00:00:00.000Z',
            thresholdMs: 5000,
          },
        ],
      },
    });

    const doctor = new FakeDiscordInteraction('doctor', {}, 'user-1', 'chan-1');
    await handlers.handleInteraction(doctor);

    expect(doctor.editedReplies[0]?.content).toContain(
      '[WARN] Task health observer status',
    );
    expect(doctor.editedReplies[0]?.content).toContain(
      'task-stalled-via-doctor',
    );
    expect(doctor.editedReplies[0]?.content).toContain('/escalate');
  });

  it('lets an explicitly configured admin mutate the Discord auth database', async () => {
    const authDatabase = new SeededDiscordAuthDatabase({
      allowedGuildIds: ['guild-1'],
      adminUserIds: [TEST_ADMIN_USER_ID],
    });
    const handlers = new DiscordCommandHandlers({
      arona: {} as never,
      dispatcher: {} as never,
      requestFactory: {} as never,
      authDatabase,
      accessPolicy: new DiscordAccessPolicy({
        authDatabase,
      }),
    });

    const allowUser = new FakeDiscordInteraction(
      'auth',
      { action: 'allow_user', subject_id: 'user-2' },
      TEST_ADMIN_USER_ID,
      'chan-1',
      'guild-1',
    );
    await handlers.handleInteraction(allowUser);
    expect(allowUser.editedReplies[0]?.content).toContain('allow_user');
    expect(authDatabase.isUserAllowed('user-2')).toBe(true);

    const list = new FakeDiscordInteraction(
      'auth',
      { action: 'list' },
      TEST_ADMIN_USER_ID,
      'chan-1',
      'guild-1',
    );
    await handlers.handleInteraction(list);
    expect(list.editedReplies[0]?.content).toContain('Allowed users: user-2');

    const removeSelf = new FakeDiscordInteraction(
      'auth',
      { action: 'remove_admin', subject_id: TEST_ADMIN_USER_ID },
      TEST_ADMIN_USER_ID,
      'chan-1',
      'guild-1',
    );
    await handlers.handleInteraction(removeSelf);
    expect(removeSelf.editedReplies[0]?.content).toContain('remove_admin');
    expect(authDatabase.isAdminUser(TEST_ADMIN_USER_ID)).toBe(false);
  });
});
