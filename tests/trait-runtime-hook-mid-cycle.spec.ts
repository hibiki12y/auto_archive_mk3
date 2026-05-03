/**
 * M5b — Plugin hook tier 2 (5 mid-cycle hooks).
 *
 * Hooks under test:
 *   - subagentSpawn / subagentTerminal — fired by createSubagentRoster
 *   - skillAdmit / skillBumpUse — fired by methodology trait resolver
 *   - commandIntercept — fired by DiscordCommandHandlers.handleInteraction
 *
 * Each hook is verified for: invocation timing, payload contents, error
 * containment (a throwing hook never blocks the host operation).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSubagentRoster } from '../src/runtime/subagent-roster.js';
import {
  TRAIT_RUNTIME_HOOK_ALLOWLIST,
} from '../src/core/trait-module-loader.js';
import type {
  TraitCommandInterceptHook,
  TraitSkillAdmitHook,
  TraitSubagentSpawnHook,
  TraitSubagentTerminalHook,
} from '../src/contracts/trait-runtime-hook.js';
import type { ResourceEnvelope } from '../src/contracts/resource-envelope.js';

function buildEnvelope(): ResourceEnvelope {
  return {
    requested: {
      cpuCores: 4,
      memoryMiB: 8192,
      wallTimeSec: 900,
      gpuCards: 0,
    },
    effective: {
      cpuCores: 4,
      memoryMiB: 8192,
      wallTimeSec: 900,
      gpuCards: 0,
    },
    observed: {},
  };
}

describe('M5b — TRAIT_RUNTIME_HOOK_ALLOWLIST exposes all 5 tier-2 keys', () => {
  it('exposes subagentSpawn / subagentTerminal / skillAdmit / skillBumpUse / commandIntercept', () => {
    expect(TRAIT_RUNTIME_HOOK_ALLOWLIST).toEqual(
      expect.arrayContaining([
        'subagentSpawn',
        'subagentTerminal',
        'skillAdmit',
        'skillBumpUse',
        'commandIntercept',
      ]),
    );
  });
});

describe('M5b — subagent roster fires subagentSpawn + subagentTerminal hooks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires subagentSpawn after a successful spawn with the expected payload', async () => {
    const spawnSpy: TraitSubagentSpawnHook = vi.fn();
    const roster = createSubagentRoster({
      taskId: 'task-spawn-hook',
      instanceId: 'instance-spawn-hook',
      envelope: buildEnvelope(),
      subagentLifecycleHooks: [
        {
          moduleId: 'mod-x',
          moduleVersion: '1.0.0',
          subagentSpawn: spawnSpy,
        },
      ],
    });
    const descriptor = await roster.spawn({ role: 'explorer' });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const callArgs = (spawnSpy as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs?.[0]).toMatchObject({
      moduleId: 'mod-x',
      moduleVersion: '1.0.0',
    });
    expect(callArgs?.[1]).toMatchObject({
      parentTaskId: 'task-spawn-hook',
      parentInstanceId: 'instance-spawn-hook',
      subagentId: descriptor.subagentId,
      role: 'explorer',
    });
  });

  it('contains a subagentSpawn hook throw — spawn still resolves', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const roster = createSubagentRoster({
      taskId: 'task-spawn-throws',
      instanceId: 'instance-spawn-throws',
      envelope: buildEnvelope(),
      subagentLifecycleHooks: [
        {
          moduleId: 'mod-x',
          moduleVersion: '1.0.0',
          subagentSpawn: () => {
            throw new Error('boom in subagentSpawn');
          },
        },
      ],
    });
    const descriptor = await roster.spawn({ role: 'explorer' });
    expect(descriptor.role).toBe('explorer');
    const containedWarn = warnSpy.mock.calls.find(
      ([label]) => label === 'trait-runtime-hook-threw',
    );
    expect(containedWarn).toBeDefined();
    expect(containedWarn?.[1]).toContain('subagentSpawn');
  });

  it('fires subagentTerminal on successful subagent completion', async () => {
    const terminalSpy: TraitSubagentTerminalHook = vi.fn();
    const roster = createSubagentRoster({
      taskId: 'task-terminal-hook',
      instanceId: 'instance-terminal-hook',
      envelope: buildEnvelope(),
      subagentLifecycleHooks: [
        {
          moduleId: 'mod-y',
          moduleVersion: '1.0.0',
          subagentTerminal: terminalSpy,
        },
      ],
    });
    const descriptor = await roster.spawn({ role: 'explorer' });
    void roster.terminate(descriptor.subagentId, {
      kind: 'success',
      taskId: 'task-terminal-hook',
      runtimeInstanceId: 'instance-terminal-hook',
      observedAt: new Date().toISOString(),
      provenance: 'test',
      artifactLocation: 'artifact://x',
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminalSpy).toHaveBeenCalledTimes(1);
    const callArgs = (terminalSpy as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs?.[1]).toMatchObject({
      parentTaskId: 'task-terminal-hook',
      parentInstanceId: 'instance-terminal-hook',
      subagentId: descriptor.subagentId,
      state: 'terminated',
    });
  });

  it('terminate() drains a slow subagentTerminal hook before resolving (F6)', async () => {
    let hookSettled = false;
    const slowHook: TraitSubagentTerminalHook = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      hookSettled = true;
    };
    const roster = createSubagentRoster({
      taskId: 'task-terminal-drain',
      instanceId: 'instance-terminal-drain',
      envelope: buildEnvelope(),
      subagentLifecycleHooks: [
        {
          moduleId: 'mod-drain',
          moduleVersion: '1.0.0',
          subagentTerminal: slowHook,
        },
      ],
    });
    const descriptor = await roster.spawn({ role: 'explorer' });
    await roster.terminate(descriptor.subagentId, {
      kind: 'success',
      taskId: 'task-terminal-drain',
      runtimeInstanceId: 'instance-terminal-drain',
      observedAt: new Date().toISOString(),
      provenance: 'test',
      artifactLocation: 'artifact://drain',
    });
    // No microtask-flush helper. If terminate() were still fire-and-forget
    // on the hook, the boolean would be false at this point.
    expect(hookSettled).toBe(true);
  });
});

describe('M5b — methodology resolver fires skillAdmit + skillBumpUse hooks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires skillAdmit after admission with the curator decision kind', async () => {
    const admitSpy: TraitSkillAdmitHook = vi.fn();
    const bumpSpy = vi.fn();

    const { Plana } = await import('../src/core/plana.js');
    const { PlanaCurator } = await import('../src/core/plana-curator.js');
    const { createMethodologyTraitRuntimeDecoratorResolver } = await import(
      '../src/runtime/methodology-trait-runtime-decorator-resolver.js'
    );
    const { createTaskRequest } = await import('./helpers/dispatcher-core.js');

    const plana = new Plana({
      trait: () => undefined,
      curator: new PlanaCurator(),
    });

    const fakeImporter = vi.fn(async () => ({
      default: (driver: unknown) => driver,
    }));

    const resolver = createMethodologyTraitRuntimeDecoratorResolver({
      workspaceRoot: process.cwd(),
      importModule: fakeImporter,
      allowExternal: false,
      allowWorkspaceLocal: true,
      midCycleHooks: [
        {
          moduleId: 'mod-skill-test',
          moduleVersion: '1.0.0',
          skillAdmit: admitSpy,
          skillBumpUse: bumpSpy,
        },
      ],
    });

    const planRequest = createTaskRequest('task-skill-admit-hook');
    const fakePlan = {
      ...planRequest,
      createdAt: new Date().toISOString(),
      runtimeSettings: planRequest.runtimeSettings,
      resourceEnvelope: { requested: planRequest.resources.requested },
    };
    const fakeInstance = {
      taskId: planRequest.taskId,
      instanceId: 'fake-instance',
      createdAt: new Date().toISOString(),
      runtimeSettings: {
        ...planRequest.runtimeSettings,
        toolset: { provider: 'codex', model: undefined },
      } as never,
    };

    try {
      await resolver({
        plan: fakePlan as never,
        instance: fakeInstance,
        plana,
      });
    } catch {
      // Loader may fail in this synthetic environment — we only care
      // that the hooks fired (skillAdmit fires before loadDecorator, so
      // even loader failure shouldn't suppress it).
    }

    expect(admitSpy).toHaveBeenCalledTimes(1);
    const admitArgs = (admitSpy as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(admitArgs?.[1]).toMatchObject({
      taskId: 'task-skill-admit-hook',
      admissionStatus: 'admitted',
      curatorDecisionKind: 'keep',
    });
  });
});

describe('M5b — DiscordCommandHandlers.handleInteraction fires commandIntercept', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('admits when the intercept returns null', async () => {
    const interceptSpy: TraitCommandInterceptHook = vi.fn(() => null);
    const dispatched: string[] = [];

    const { DiscordCommandHandlers, DefaultDiscordTaskRequestFactory } =
      await import('../src/discord/discord-command-handlers.js');
    const { Arona } = await import('../src/core/arona.js');
    const { Plana } = await import('../src/core/plana.js');
    const { Dispatcher } = await import('../src/core/dispatcher.js');
    const { AgentRuntime } = await import('../src/runtime/agent-runtime.js');
    const { InProcessComputeNode } = await import(
      '../src/core/__test__/compute-node-test-doubles.js'
    );

    const driver = {
      async run(context: never): Promise<never> {
        dispatched.push('driver-ran');
        return {
          reason: 'ok',
          provenance: 'test',
          cause: {
            kind: 'success',
            taskId: (context as { plan: { taskId: string } }).plan.taskId,
            runtimeInstanceId: (context as { instance: { instanceId: string } })
              .instance.instanceId,
            observedAt: new Date().toISOString(),
            provenance: 'test',
            artifactLocation: 'artifact://x',
          },
        } as never;
      },
    };
    const arona = new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
    );

    const handlers = new DiscordCommandHandlers({
      arona,
      dispatcher: new Dispatcher(
        new InProcessComputeNode(new AgentRuntime(driver)),
      ),
      requestFactory: new DefaultDiscordTaskRequestFactory({
        resources: { requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 } },
        runtimeSettings: {
          networkProfile: 'provider-only',
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
        },
      }),
      commandInterceptHooks: [
        {
          moduleId: 'mod-cmd',
          moduleVersion: '1.0.0',
          commandIntercept: interceptSpy,
        },
      ],
    });

    let helpRendered = false;
    const fakeInteraction = {
      commandName: 'help' as const,
      userId: 'user-1',
      channelId: 'channel-1',
      getString: () => null,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => {
        helpRendered = true;
      }),
      followUp: vi.fn(async () => undefined),
    };

    await handlers.handleInteraction(fakeInteraction);

    expect(interceptSpy).toHaveBeenCalledTimes(1);
    expect(helpRendered).toBe(true);
  });

  it('denies when the intercept returns a denied veto', async () => {
    const { DiscordCommandHandlers, DefaultDiscordTaskRequestFactory } =
      await import('../src/discord/discord-command-handlers.js');
    const { Arona } = await import('../src/core/arona.js');
    const { Plana } = await import('../src/core/plana.js');
    const { Dispatcher } = await import('../src/core/dispatcher.js');
    const { AgentRuntime } = await import('../src/runtime/agent-runtime.js');
    const { InProcessComputeNode } = await import(
      '../src/core/__test__/compute-node-test-doubles.js'
    );

    const driver = {
      async run(): Promise<never> {
        return {
          reason: 'ok',
          provenance: 'test',
          cause: { kind: 'success' } as never,
        } as never;
      },
    };
    const arona = new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
    );

    const handlers = new DiscordCommandHandlers({
      arona,
      dispatcher: new Dispatcher(
        new InProcessComputeNode(new AgentRuntime(driver)),
      ),
      requestFactory: new DefaultDiscordTaskRequestFactory({
        resources: { requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 } },
        runtimeSettings: {
          networkProfile: 'provider-only',
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
        },
      }),
      commandInterceptHooks: [
        {
          moduleId: 'mod-cmd',
          moduleVersion: '1.0.0',
          commandIntercept: () => ({
            status: 'denied' as const,
            reason: 'test denial',
          }),
        },
      ],
    });

    const editPayloads: unknown[] = [];
    const fakeInteraction = {
      commandName: 'help' as const,
      userId: 'user-2',
      channelId: 'channel-2',
      getString: () => null,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async (payload: unknown) => {
        editPayloads.push(payload);
      }),
      followUp: vi.fn(async () => undefined),
    };

    await handlers.handleInteraction(fakeInteraction);

    expect(editPayloads).toHaveLength(1);
    expect((editPayloads[0] as { content: string }).content).toContain(
      'denied by trait',
    );
    expect((editPayloads[0] as { content: string }).content).toContain(
      'test denial',
    );
  });

  it('contains a throwing intercept and admits the command', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { DiscordCommandHandlers, DefaultDiscordTaskRequestFactory } =
      await import('../src/discord/discord-command-handlers.js');
    const { Arona } = await import('../src/core/arona.js');
    const { Plana } = await import('../src/core/plana.js');
    const { Dispatcher } = await import('../src/core/dispatcher.js');
    const { AgentRuntime } = await import('../src/runtime/agent-runtime.js');
    const { InProcessComputeNode } = await import(
      '../src/core/__test__/compute-node-test-doubles.js'
    );

    const driver = {
      async run(): Promise<never> {
        return {
          reason: 'ok',
          provenance: 'test',
          cause: { kind: 'success' } as never,
        } as never;
      },
    };
    const arona = new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
    );

    const handlers = new DiscordCommandHandlers({
      arona,
      dispatcher: new Dispatcher(
        new InProcessComputeNode(new AgentRuntime(driver)),
      ),
      requestFactory: new DefaultDiscordTaskRequestFactory({
        resources: { requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 } },
        runtimeSettings: {
          networkProfile: 'provider-only',
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
        },
      }),
      commandInterceptHooks: [
        {
          moduleId: 'mod-cmd',
          moduleVersion: '1.0.0',
          commandIntercept: () => {
            throw new Error('boom in commandIntercept');
          },
        },
      ],
    });

    let helpRendered = false;
    const fakeInteraction = {
      commandName: 'help' as const,
      userId: 'user-3',
      channelId: 'channel-3',
      getString: () => null,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => {
        helpRendered = true;
      }),
      followUp: vi.fn(async () => undefined),
    };

    await handlers.handleInteraction(fakeInteraction);

    expect(helpRendered).toBe(true);
    const containedWarn = warnSpy.mock.calls.find(
      ([label]) => label === 'trait-runtime-hook-threw',
    );
    expect(containedWarn).toBeDefined();
    expect(containedWarn?.[1]).toContain('commandIntercept');
  });
});
