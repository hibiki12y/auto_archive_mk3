import { describe, expect, it } from 'vitest';

import {
  DiscordAccessPolicy,
  DiscordCommandHandlers,
  SeededDiscordAuthDatabase,
  DiscordTaskRegistry,
  InMemoryControlPlaneLedger,
  renderDoctor,
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

describe('discord always-on control plane slice', () => {
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

  it('serves tasks, agenda, history, context, approvals, and doctor from control-plane state', async () => {
    const ledger = new InMemoryControlPlaneLedger();
    const taskRegistry = new DiscordTaskRegistry({ ledger });
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
      doctorStatus: {
        runtimeProviderScope: 'multi-provider',
        activeRuntimeProvider: 'codex',
        computeMode: 'current-node',
        modelOverride: 'gpt-5.5',
      },
    });

    const tasks = new FakeDiscordInteraction('tasks', {}, 'user-1', 'chan-1');
    await handlers.handleInteraction(tasks);
    expect(tasks.editedReplies[0]?.content).toContain('discord-task-1');
    expect(tasks.editedReplies[0]?.content).toContain('[research]');

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
    expect(history.editedReplies[0]?.content).toContain('task.accepted');

    const context = new FakeDiscordInteraction('context', { task_id: 'discord-task-1' }, 'user-1', 'chan-1');
    await handlers.handleInteraction(context);
    expect(context.editedReplies[0]?.content).toContain('UNTRUSTED');

    const approve = new FakeDiscordInteraction('approve', { approval_id: 'approval-1', note: 'ok' }, 'user-1', 'chan-1');
    await handlers.handleInteraction(approve);
    expect(approve.editedReplies[0]?.content).toContain('approved');
    expect(ledger.loadAll().some((event) => event.type === 'approval.resolved')).toBe(true);

    const doctor = new FakeDiscordInteraction('doctor', {}, 'user-1', 'chan-1');
    await handlers.handleInteraction(doctor);
    expect(doctor.editedReplies[0]?.content).toContain('Multi-provider');
    expect(doctor.editedReplies[0]?.content).toContain('active: codex');
    expect(doctor.editedReplies[0]?.content).toContain('gpt-5.5');
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
