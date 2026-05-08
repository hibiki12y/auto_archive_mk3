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
