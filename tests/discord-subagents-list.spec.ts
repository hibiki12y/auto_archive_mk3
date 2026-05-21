/**
 * P4 Stage 4-2 — `/subagents list` integration with the registry-aware
 * `SubagentOperatorSurface`.
 *
 * The Stage 4-1 baseline kept the operator surface unwired in the
 * Discord service bootstrap, so `/subagents list` always rendered the
 * "not configured" message. Stage 4-2 wires the registry-aware
 * operator into the bootstrap; these tests exercise the bot-side
 * surface through the same `DiscordCommandHandlers.handleSubagents`
 * method the user-facing `/subagents` command invokes, with the
 * registry kept in test-controlled state.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  Arona,
  DefaultDiscordTaskRequestFactory,
  DiscordCommandHandlers,
  DiscordTaskRegistry,
  Dispatcher,
  Plana,
} from '../src/index.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import { AgentRuntime } from '../src/runtime/agent-runtime.js';
import type { RuntimeDriverResult } from '../src/contracts/runtime-driver.js';
import type { SubagentDescriptor } from '../src/contracts/subagent-roster.js';
import type { SubagentRoster } from '../src/runtime/subagent-roster.js';
import { SubagentOperatorSurface } from '../src/runtime/subagent-operator.js';
import {
  createSubagentRosterRegistry,
  type SubagentRosterRegistry,
} from '../src/runtime/subagent-roster-registry.js';
import { DiscordResearchMissionStore } from '../src/discord/discord-research-mission.js';
import { FakeDiscordInteraction } from './helpers/discord.js';

const factoryOptions = {
  resources: {
    requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
  },
  runtimeSettings: {
    networkProfile: 'provider-only' as const,
    sandboxMode: 'workspace-write' as const,
    approvalPolicy: 'on-request' as const,
    workingDirectory: 'results/task-artifacts',
  },
  artifactLocation: 'results/task-artifacts',
};

function createOfflineHandlers(options: {
  subagentOperator?: SubagentOperatorSurface;
  researchMissions?: DiscordResearchMissionStore;
}): DiscordCommandHandlers {
  const dispatcher = new Dispatcher(
    new InProcessComputeNode(
      new AgentRuntime({
        async run(context): Promise<RuntimeDriverResult> {
          return {
            cause: {
              kind: 'success',
              taskId: context.instance.taskId,
              runtimeInstanceId: context.instance.instanceId,
              observedAt: '2026-05-08T00:00:00.000Z',
              provenance: 'offline',
            },
            provenance: 'offline',
            reason: 'ok',
          };
        },
      }),
    ),
  );
  return new DiscordCommandHandlers({
    arona: new Arona(new Plana(), dispatcher),
    dispatcher,
    taskRegistry: new DiscordTaskRegistry(),
    requestFactory: new DefaultDiscordTaskRequestFactory({
      ...factoryOptions,
      taskIdFactory: () => 'fixed',
    }),
    ...(options.researchMissions === undefined
      ? {}
      : { researchMissions: options.researchMissions }),
    ...(options.subagentOperator === undefined
      ? {}
      : { subagentOperator: options.subagentOperator }),
  });
}

function replyText(interaction: FakeDiscordInteraction): string {
  const last = interaction.editedReplies[interaction.editedReplies.length - 1];
  return last?.content ?? JSON.stringify(last);
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

function frozenDescriptor(
  override: Partial<SubagentDescriptor>,
): SubagentDescriptor {
  return Object.freeze({
    subagentId: override.subagentId ?? 'subagent-1',
    role: override.role ?? 'explorer',
    parent: Object.freeze({
      taskId: override.parent?.taskId ?? 'task-A',
      instanceId: override.parent?.instanceId ?? 'inst-A',
    }),
    createdAt: override.createdAt ?? '2026-05-08T00:00:00.000Z',
    state: override.state ?? 'active',
    envelope: override.envelope ?? Object.freeze({
      requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
      derived: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
    }),
  }) as SubagentDescriptor;
}

function buildRegistryAwareOperator(
  registry: SubagentRosterRegistry,
): SubagentOperatorSurface {
  return new SubagentOperatorSurface({ rosterRegistry: registry });
}

describe('/subagents list — registry-aware operator surface (Stage 4-2)', () => {
  it('with no active dispatch, returns the empty-state message instead of "not configured"', async () => {
    const registry = createSubagentRosterRegistry();
    const handlers = createOfflineHandlers({
      subagentOperator: buildRegistryAwareOperator(registry),
    });
    const interaction = new FakeDiscordInteraction('subagents', {
      action: 'list',
    });
    await handlers.handleInteraction(interaction);

    const text = replyText(interaction);
    // The new empty-state message — not the legacy "not configured"
    // fallback that fires only when `subagentOperator` is undefined.
    expect(text).toContain('No active subagent dispatches.');
    expect(text).not.toContain('Subagent operator surface is not configured');
  });

  it('with one active dispatch and 0 subagents in its roster, /subagents list shows the empty-roster dispatch count', async () => {
    const registry = createSubagentRosterRegistry();
    registry.register({
      taskId: 'task-A',
      instanceId: 'inst-A',
      roster: createStubRoster(),
    });
    const handlers = createOfflineHandlers({
      subagentOperator: buildRegistryAwareOperator(registry),
    });
    const interaction = new FakeDiscordInteraction('subagents', {
      action: 'list',
    });
    await handlers.handleInteraction(interaction);

    const text = replyText(interaction);
    expect(text).toContain('No subagents in 1 active dispatch.');
    expect(text).not.toContain('Subagent operator surface is not configured');
  });

  it('with one active dispatch and one descriptor, surfaces the descriptor row', async () => {
    const registry = createSubagentRosterRegistry();
    registry.register({
      taskId: 'task-A',
      instanceId: 'inst-A',
      roster: createStubRoster([
        frozenDescriptor({
          subagentId: 'subagent-1',
          role: 'explorer',
          state: 'active',
          parent: { taskId: 'task-A', instanceId: 'inst-A' },
        }),
      ]),
    });
    const handlers = createOfflineHandlers({
      subagentOperator: buildRegistryAwareOperator(registry),
    });
    const interaction = new FakeDiscordInteraction('subagents', {
      action: 'list',
    });
    await handlers.handleInteraction(interaction);

    const text = replyText(interaction);
    // Descriptor summary line shape: "subagent-1 explorer active parent=task-A/inst-A"
    expect(text).toContain('subagent-1 explorer active parent=task-A/inst-A');
    // Regression: the unwired-operator branch must remain reachable
    // only when `subagentOperator` is undefined.
    expect(text).not.toContain('Subagent operator surface is not configured');
  });

  it('regression: unwired operator (legacy) still shows the "not configured" fallback', async () => {
    const handlers = createOfflineHandlers({});
    const interaction = new FakeDiscordInteraction('subagents', {
      action: 'list',
    });
    await handlers.handleInteraction(interaction);

    const text = replyText(interaction);
    expect(text).toContain('Subagent operator surface is not configured');
  });
});

describe('/subagents tree — research mission role preflight', () => {
  function missionStore(): DiscordResearchMissionStore {
    const store = new DiscordResearchMissionStore({
      idFactory: () => '20260510-tree',
      now: () => '2026-05-10T00:00:00.000Z',
    });
    store.createDraft({
      goal: 'Research subagent role UX',
      title: 'Research subagent role UX',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });
    return store;
  }

  it('requires mission_id before rendering a research-role tree', async () => {
    const handlers = createOfflineHandlers({
      researchMissions: missionStore(),
      subagentOperator: buildRegistryAwareOperator(createSubagentRosterRegistry()),
    });
    const interaction = new FakeDiscordInteraction('subagents', {
      action: 'tree',
    });

    await handlers.handleInteraction(interaction);

    const text = replyText(interaction);
    expect(interaction.deferredReplies).toEqual([{ ephemeral: true }]);
    expect(text).toContain('Subagent operator request was not applied.');
    expect(text).toContain('mission_id is required for tree');
  });

  it('renders a mission-scoped read-only research subagent tree preflight', async () => {
    const registry = createSubagentRosterRegistry();
    registry.register({
      taskId: 'discord-research-mission-plan-R-20260510-tree-001',
      instanceId: 'parent-inst',
      roster: createStubRoster([
        frozenDescriptor({
          subagentId: 'subagent-collector-1',
          role: 'collector' as SubagentDescriptor['role'],
          state: 'active',
          parent: {
            taskId: 'discord-research-mission-plan-R-20260510-tree-001',
            instanceId: 'parent-inst',
          },
        }),
        frozenDescriptor({
          subagentId: 'subagent-other-1',
          role: 'critic' as SubagentDescriptor['role'],
          state: 'active',
          parent: {
            taskId: 'discord-research-mission-plan-R-other-001',
            instanceId: 'parent-inst',
          },
        }),
      ]),
    });
    const handlers = createOfflineHandlers({
      researchMissions: missionStore(),
      subagentOperator: buildRegistryAwareOperator(registry),
    });
    const interaction = new FakeDiscordInteraction('subagents', {
      action: 'tree',
      mission_id: 'R-20260510-tree',
    });

    await handlers.handleInteraction(interaction);

    const text = replyText(interaction);
    expect(text).toContain(
      'Research subagent tree preflight for `R-20260510-tree`',
    );
    expect(text).toContain('- planner:');
    expect(text).toContain('- collector:');
    expect(text).toContain('- experimenter:');
    expect(text).toContain('- critic:');
    expect(text).toContain('- synthesizer:');
    expect(text).toContain('- archivist:');
    expect(text).toContain('Expected child output: summary, claims, evidence');
    expect(text).toContain(
      '- subagent-collector-1 role=collector state=active parent=discord-research-mission-plan-R-20260510-tree-001/parent-inst',
    );
    expect(text).not.toContain('subagent-other-1');
    expect(text).toContain('no spawn, kill, steer, log read');
    expect(text).toContain('no proof mutation');
    expect(text).toContain('no archive mutation');
    expect(text).toContain('no live service contact');
  });

  it('does not leak prefix-colliding mission descriptors', async () => {
    const ids = ['1', '10'];
    const store = new DiscordResearchMissionStore({
      idFactory: () => ids.shift() ?? 'unexpected',
      now: () => '2026-05-10T00:00:00.000Z',
    });
    store.createDraft({
      goal: 'Prefix collision R-1',
      title: 'Prefix collision R-1',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });
    store.createDraft({
      goal: 'Prefix collision R-10',
      title: 'Prefix collision R-10',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });
    const registry = createSubagentRosterRegistry();
    registry.register({
      taskId: 'discord-research-mission-plan-R-prefix-collision-parent',
      instanceId: 'parent-inst',
      roster: createStubRoster([
        frozenDescriptor({
          subagentId: 'subagent-r1',
          role: 'collector' as SubagentDescriptor['role'],
          parent: {
            taskId: 'discord-research-mission-plan-R-1-001',
            instanceId: 'parent-inst',
          },
        }),
        frozenDescriptor({
          subagentId: 'subagent-r10',
          role: 'collector' as SubagentDescriptor['role'],
          parent: {
            taskId: 'discord-research-mission-plan-R-10-001',
            instanceId: 'parent-inst',
          },
        }),
      ]),
    });
    const handlers = createOfflineHandlers({
      researchMissions: store,
      subagentOperator: buildRegistryAwareOperator(registry),
    });
    const interaction = new FakeDiscordInteraction('subagents', {
      action: 'tree',
      mission_id: 'R-1',
    });

    await handlers.handleInteraction(interaction);

    const text = replyText(interaction);
    expect(text).toContain('subagent-r1');
    expect(text).toContain('parent=discord-research-mission-plan-R-1-001');
    expect(text).not.toContain('subagent-r10');
    expect(text).not.toContain('discord-research-mission-plan-R-10-001');
  });

  it('does not leak dash-nested mission descriptors', async () => {
    const ids = ['20260510', '20260510-tree'];
    const store = new DiscordResearchMissionStore({
      idFactory: () => ids.shift() ?? 'unexpected',
      now: () => '2026-05-10T00:00:00.000Z',
    });
    store.createDraft({
      goal: 'Dash nested root',
      title: 'Dash nested root',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });
    store.createDraft({
      goal: 'Dash nested child',
      title: 'Dash nested child',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });
    const registry = createSubagentRosterRegistry();
    registry.register({
      taskId: 'discord-research-mission-plan-R-dash-nested-parent',
      instanceId: 'parent-inst',
      roster: createStubRoster([
        frozenDescriptor({
          subagentId: 'subagent-root',
          role: 'collector' as SubagentDescriptor['role'],
          parent: {
            taskId: 'discord-research-mission-plan-R-20260510-001',
            instanceId: 'parent-inst',
          },
        }),
        frozenDescriptor({
          subagentId: 'subagent-child',
          role: 'collector' as SubagentDescriptor['role'],
          parent: {
            taskId: 'discord-research-mission-plan-R-20260510-tree-001',
            instanceId: 'parent-inst',
          },
        }),
      ]),
    });
    const handlers = createOfflineHandlers({
      researchMissions: store,
      subagentOperator: buildRegistryAwareOperator(registry),
    });
    const interaction = new FakeDiscordInteraction('subagents', {
      action: 'tree',
      mission_id: 'R-20260510',
    });

    await handlers.handleInteraction(interaction);

    const text = replyText(interaction);
    expect(text).toContain('subagent-root');
    expect(text).toContain('parent=discord-research-mission-plan-R-20260510-001');
    expect(text).not.toContain('subagent-child');
    expect(text).not.toContain('discord-research-mission-plan-R-20260510-tree-001');
  });

  it('keeps mission_id inert for non-tree subagent actions', async () => {
    const registry = createSubagentRosterRegistry();
    registry.register({
      taskId: 'task-A',
      instanceId: 'inst-A',
      roster: createStubRoster([
        frozenDescriptor({
          subagentId: 'subagent-list-1',
          role: 'explorer',
          state: 'active',
          parent: { taskId: 'task-A', instanceId: 'inst-A' },
        }),
      ]),
    });
    const handlers = createOfflineHandlers({
      researchMissions: missionStore(),
      subagentOperator: buildRegistryAwareOperator(registry),
    });
    const interaction = new FakeDiscordInteraction('subagents', {
      action: 'list',
      mission_id: 'R-20260510-tree',
    });

    await handlers.handleInteraction(interaction);

    const text = replyText(interaction);
    expect(text).toContain('subagent-list-1 explorer active parent=task-A/inst-A');
    expect(text).not.toContain('Research subagent tree preflight');
    expect(text).not.toContain('Research roles:');
  });

  it('uses the existing mission-not-found card for unknown mission ids', async () => {
    const handlers = createOfflineHandlers({
      researchMissions: missionStore(),
      subagentOperator: buildRegistryAwareOperator(createSubagentRosterRegistry()),
    });
    const interaction = new FakeDiscordInteraction('subagents', {
      action: 'tree',
      mission_id: 'R-missing-@everyone`',
    });

    await handlers.handleInteraction(interaction);

    const text = replyText(interaction);
    expect(text).toContain(
      'Research mission `R-missing-@​everyoneʼ` is not tracked',
    );
    expect(text).not.toContain('@everyone');
    expect(interaction.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
  });
});

describe('/subagents spawn — research role envelope preflight', () => {
  function missionStore(): DiscordResearchMissionStore {
    const store = new DiscordResearchMissionStore({
      idFactory: () => '20260510-spawn',
      now: () => '2026-05-10T00:00:00.000Z',
    });
    store.createDraft({
      goal: 'Research subagent spawn UX',
      title: 'Research subagent spawn UX',
      ownerId: 'operator',
      discordChannelId: 'research-runs',
    });
    return store;
  }

  it('renders a mission-scoped role envelope preview without live spawn', async () => {
    const handlers = createOfflineHandlers({
      researchMissions: missionStore(),
      subagentOperator: buildRegistryAwareOperator(createSubagentRosterRegistry()),
    });
    const interaction = new FakeDiscordInteraction('subagents', {
      action: 'spawn',
      mission_id: 'R-20260510-spawn',
      role: 'collector' as SubagentDescriptor['role'],
      text: 'OpenClaw subagent UX 근거 정리',
    });

    await handlers.handleInteraction(interaction);

    const text = replyText(interaction);
    expect(interaction.deferredReplies).toEqual([{ ephemeral: true }]);
    expect(text).toContain(
      'Research subagent spawn preflight for `R-20260510-spawn`',
    );
    expect(text).toContain('Role: collector');
    expect(text).toContain('Task: OpenClaw subagent UX 근거 정리');
    expect(text).toContain('Planned child output schema');
    expect(text).toContain('summary, claims[], evidence[]');
    expect(text).toContain('no subagent spawn');
    expect(text).toContain('no provider session');
    expect(text).toContain('no live service contact');
  });

  it('requires mission, role, and task before rendering spawn preflight', async () => {
    const handlers = createOfflineHandlers({
      researchMissions: missionStore(),
    });

    const noMission = new FakeDiscordInteraction('subagents', {
      action: 'spawn',
      role: 'collector' as SubagentDescriptor['role'],
      text: 'Collect evidence',
    });
    await handlers.handleInteraction(noMission);
    expect(replyText(noMission)).toContain('mission_id is required for spawn');

    const noRole = new FakeDiscordInteraction('subagents', {
      action: 'spawn',
      mission_id: 'R-20260510-spawn',
      text: 'Collect evidence',
    });
    await handlers.handleInteraction(noRole);
    expect(replyText(noRole)).toContain('role must be one of planner');

    const noTask = new FakeDiscordInteraction('subagents', {
      action: 'spawn',
      mission_id: 'R-20260510-spawn',
      role: 'collector' as SubagentDescriptor['role'],
    });
    await handlers.handleInteraction(noTask);
    expect(replyText(noTask)).toContain('text is required for spawn task');
  });

  it('uses the existing mission-not-found card for unknown spawn mission ids', async () => {
    const handlers = createOfflineHandlers({
      researchMissions: missionStore(),
      subagentOperator: buildRegistryAwareOperator(createSubagentRosterRegistry()),
    });
    const interaction = new FakeDiscordInteraction('subagents', {
      action: 'spawn',
      mission_id: 'R-missing-@everyone`',
      role: 'critic' as SubagentDescriptor['role'],
      text: '@everyone `challenge`',
    });

    await handlers.handleInteraction(interaction);

    const text = replyText(interaction);
    expect(text).toContain(
      'Research mission `R-missing-@​everyoneʼ` is not tracked',
    );
    expect(text).not.toContain('@everyone');
    expect(interaction.editedReplies[0]?.allowedMentions).toEqual({ parse: [] });
  });
});
