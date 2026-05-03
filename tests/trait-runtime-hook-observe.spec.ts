/**
 * M5c — Plugin hook tier 3 (5 observe-only hooks).
 *
 * Hooks under test:
 *   - providerSelectObserve — fired by createRuntimeDriverFromEnv*
 *   - promptCacheBreakpointObserve — fired by freezeSystemPrompt
 *   - ledgerAppendObserve — fired by control-plane ledger append
 *   - insightsSnapshotObserve — fired by InsightsEngine.snapshot
 *   - doctorProbeObserve — fired by DiscordCommandHandlers.handleDoctor
 *
 * All 5 hooks are observe-only (return type `void | Promise<void>`).
 * Errors must be contained — a throwing hook never disrupts the host
 * operation. The fire pattern is fire-and-forget via
 * `Promise.resolve().then().catch()`, so each test flushes the microtask
 * queue with `setImmediate` before asserting on hook calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TRAIT_RUNTIME_HOOK_ALLOWLIST } from '../src/core/trait-module-loader.js';
import {
  createRuntimeDriverFromEnv,
  createRuntimeDriverFromEnvAsync,
  _resetAdapterCacheForTesting,
} from '../src/runtime/runtime-driver-factory.js';
import { createPromptCacheInvariant } from '../src/runtime/prompt-cache-invariant.js';
import {
  InMemoryControlPlaneLedger,
  type ControlPlaneEventInput,
} from '../src/control/control-plane-ledger.js';
import { InsightsEngine } from '../src/runtime/insights-engine.js';

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('M5c — TRAIT_RUNTIME_HOOK_ALLOWLIST exposes all 5 tier-3 keys', () => {
  it('exposes all 5 tier-3 observe hook keys', () => {
    expect(TRAIT_RUNTIME_HOOK_ALLOWLIST).toEqual(
      expect.arrayContaining([
        'providerSelectObserve',
        'promptCacheBreakpointObserve',
        'ledgerAppendObserve',
        'insightsSnapshotObserve',
        'doctorProbeObserve',
      ]),
    );
  });
});

describe('M5c — providerSelectObserve fires when factory resolves a provider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _resetAdapterCacheForTesting();
  });

  it('fires (eager / sync factory) with provider + source=eager', async () => {
    const observeSpy = vi.fn();
    createRuntimeDriverFromEnv(
      { AUTO_ARCHIVE_RUNTIME_PROVIDER: 'codex' },
      {
        codex: {
          codexOptions: {},
          codexRuntimeConfig: {},
        },
        observeHooks: [
          {
            moduleId: 'mod-provider-eager',
            moduleVersion: '1.0.0',
            providerSelectObserve: observeSpy,
          },
        ],
      },
    );

    await flushMicrotasks();
    expect(observeSpy).toHaveBeenCalledTimes(1);
    const args = observeSpy.mock.calls[0];
    expect(args?.[0]).toMatchObject({
      moduleId: 'mod-provider-eager',
      moduleVersion: '1.0.0',
    });
    expect(args?.[1]).toMatchObject({ provider: 'codex', source: 'eager' });
  });

  it('fires (lazy / async factory) with source=lazy', async () => {
    const observeSpy = vi.fn();
    await createRuntimeDriverFromEnvAsync(
      {
        AUTO_ARCHIVE_RUNTIME_PROVIDER: 'codex',
        AUTO_ARCHIVE_EAGER_SDK_IMPORT: '1',
      },
      {
        codex: {
          codexOptions: {},
          codexRuntimeConfig: {},
        },
        observeHooks: [
          {
            moduleId: 'mod-provider-lazy',
            moduleVersion: '1.0.0',
            providerSelectObserve: observeSpy,
          },
        ],
      },
    );

    await flushMicrotasks();
    expect(observeSpy).toHaveBeenCalledTimes(1);
    const args = observeSpy.mock.calls[0];
    expect(args?.[1]).toMatchObject({ provider: 'codex', source: 'lazy' });
  });

  it('contains a throwing providerSelectObserve hook', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createRuntimeDriverFromEnv(
      { AUTO_ARCHIVE_RUNTIME_PROVIDER: 'codex' },
      {
        codex: {
          codexOptions: {},
          codexRuntimeConfig: {},
        },
        observeHooks: [
          {
            moduleId: 'mod-provider-throws',
            moduleVersion: '1.0.0',
            providerSelectObserve: () => {
              throw new Error('boom in providerSelectObserve');
            },
          },
        ],
      },
    );

    await flushMicrotasks();
    const containedWarn = warnSpy.mock.calls.find(
      ([label]) => label === 'trait-runtime-hook-threw',
    );
    expect(containedWarn).toBeDefined();
    expect(containedWarn?.[1]).toContain('providerSelectObserve');
  });
});

describe('M5c — promptCacheBreakpointObserve fires on freezeSystemPrompt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires when a system prompt is frozen, with taskId + promptHash + turn', async () => {
    const observeSpy = vi.fn();
    const invariant = createPromptCacheInvariant({
      mode: 'warn',
      observeHooks: [
        {
          moduleId: 'mod-prompt-cache',
          moduleVersion: '1.0.0',
          promptCacheBreakpointObserve: observeSpy,
        },
      ],
    });

    invariant.observeSystemPrompt('task-pc-1', 3, 'system prompt body');
    invariant.freezeSystemPrompt('task-pc-1');

    await flushMicrotasks();
    expect(observeSpy).toHaveBeenCalledTimes(1);
    const args = observeSpy.mock.calls[0];
    expect(args?.[0]).toMatchObject({ moduleId: 'mod-prompt-cache' });
    expect(args?.[1]).toMatchObject({ taskId: 'task-pc-1', turn: 3 });
    expect((args?.[1] as { promptHash: string }).promptHash).toMatch(/^fnv1a:/);
  });

  it('contains a throwing promptCacheBreakpointObserve hook', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invariant = createPromptCacheInvariant({
      mode: 'warn',
      observeHooks: [
        {
          moduleId: 'mod-prompt-cache-throws',
          moduleVersion: '1.0.0',
          promptCacheBreakpointObserve: () => {
            throw new Error('boom in promptCacheBreakpointObserve');
          },
        },
      ],
    });

    invariant.observeSystemPrompt('task-pc-2', 1, 'sp');
    invariant.freezeSystemPrompt('task-pc-2');

    await flushMicrotasks();
    const containedWarn = warnSpy.mock.calls.find(
      ([label]) => label === 'trait-runtime-hook-threw',
    );
    expect(containedWarn).toBeDefined();
  });
});

describe('M5c — ledgerAppendObserve fires on every ledger append', () => {
  function buildEvent(taskId: string): ControlPlaneEventInput {
    return {
      type: 'task.requested',
      actor: { kind: 'system' },
      channel: { kind: 'system' },
      taskId,
      trust: { source: 'system', inputTrust: 'trusted' },
      payload: { instruction: 'i' },
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires after a successful append with the event id and type', async () => {
    const observeSpy = vi.fn();
    const ledger = new InMemoryControlPlaneLedger([], [
      {
        moduleId: 'mod-ledger',
        moduleVersion: '1.0.0',
        ledgerAppendObserve: observeSpy,
      },
    ]);

    const event = ledger.append(buildEvent('task-ledger-1'));

    await flushMicrotasks();
    expect(observeSpy).toHaveBeenCalledTimes(1);
    const args = observeSpy.mock.calls[0];
    expect(args?.[0]).toMatchObject({ moduleId: 'mod-ledger' });
    expect(args?.[1]).toMatchObject({
      eventId: event.eventId,
      eventType: 'task.requested',
      taskId: 'task-ledger-1',
    });
  });

  it('contains a throwing ledgerAppendObserve hook — append still succeeds', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ledger = new InMemoryControlPlaneLedger([], [
      {
        moduleId: 'mod-ledger-throws',
        moduleVersion: '1.0.0',
        ledgerAppendObserve: () => {
          throw new Error('boom in ledgerAppendObserve');
        },
      },
    ]);

    const event = ledger.append(buildEvent('task-ledger-2'));
    expect(event.eventId).toBeDefined();

    await flushMicrotasks();
    const containedWarn = warnSpy.mock.calls.find(
      ([label]) => label === 'trait-runtime-hook-threw',
    );
    expect(containedWarn).toBeDefined();
    expect(containedWarn?.[1]).toContain('ledgerAppendObserve');
  });
});

describe('M5c — insightsSnapshotObserve fires on InsightsEngine.snapshot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires when snapshot returns, with windowStart/End + totals', async () => {
    const observeSpy = vi.fn();
    const ledger = new InMemoryControlPlaneLedger();
    const engine = new InsightsEngine(ledger, {
      clock: () => new Date('2026-05-01T12:00:00.000Z'),
      observeHooks: [
        {
          moduleId: 'mod-insights',
          moduleVersion: '1.0.0',
          insightsSnapshotObserve: observeSpy,
        },
      ],
    });

    engine.snapshot('7d');

    await flushMicrotasks();
    expect(observeSpy).toHaveBeenCalledTimes(1);
    const args = observeSpy.mock.calls[0];
    expect(args?.[0]).toMatchObject({ moduleId: 'mod-insights' });
    expect(args?.[1]).toMatchObject({ totalTasks: 0 });
    expect(typeof (args?.[1] as { windowStart: string }).windowStart).toBe(
      'string',
    );
    expect(typeof (args?.[1] as { windowEnd: string }).windowEnd).toBe(
      'string',
    );
  });
});

describe('M5c — doctorProbeObserve fires on /doctor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires once per probe with probeName + status + observe context', async () => {
    const observeSpy = vi.fn();

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
        resources: {
          requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
        },
        runtimeSettings: {
          networkProfile: 'provider-only',
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
        },
      }),
      doctorStatus: {
        runtimeProviderScope: 'codex-sdk-only',
        activeRuntimeProvider: 'codex',
        computeMode: 'in-process',
        modelOverride: undefined,
        messageContentIntent: false,
        anthropicAuthSource: 'api-key',
        anthropicCliPath: undefined,
        claudeModelOverride: undefined,
        planaAdvisorProvider: undefined,
        planaAdvisorModel: undefined,
        planaAdvisorMaxCalls: undefined,
      },
      doctorProbeHooks: [
        {
          moduleId: 'mod-doctor',
          moduleVersion: '1.0.0',
          doctorProbeObserve: observeSpy,
        },
      ],
    });

    const fakeInteraction = {
      commandName: 'doctor' as const,
      userId: 'user-doctor',
      channelId: 'channel-doctor',
      getString: () => null,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };

    await handlers.handleDoctor(fakeInteraction);

    await flushMicrotasks();
    expect(observeSpy.mock.calls.length).toBeGreaterThanOrEqual(5);
    const probeNames = observeSpy.mock.calls.map(
      (call) => (call[1] as { probeName: string }).probeName,
    );
    expect(probeNames).toEqual(
      expect.arrayContaining([
        'control-ledger',
        'access-policy',
        'auth-database',
        'approval-registry',
        'runtime-provider',
      ]),
    );
    const runtimeProbe = observeSpy.mock.calls.find(
      (call) => (call[1] as { probeName: string }).probeName === 'runtime-provider',
    );
    expect((runtimeProbe?.[1] as { status: string }).status).toBe('ok');
  });

  it('contains a throwing doctorProbeObserve hook — doctor still renders', async () => {
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
        resources: {
          requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
        },
        runtimeSettings: {
          networkProfile: 'provider-only',
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
        },
      }),
      doctorProbeHooks: [
        {
          moduleId: 'mod-doctor-throws',
          moduleVersion: '1.0.0',
          doctorProbeObserve: () => {
            throw new Error('boom in doctorProbeObserve');
          },
        },
      ],
    });

    let doctorRendered = false;
    const fakeInteraction = {
      commandName: 'doctor' as const,
      userId: 'user-doctor-throws',
      channelId: 'channel-doctor-throws',
      getString: () => null,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => {
        doctorRendered = true;
      }),
      followUp: vi.fn(async () => undefined),
    };

    await handlers.handleDoctor(fakeInteraction);
    await flushMicrotasks();

    expect(doctorRendered).toBe(true);
    const containedWarn = warnSpy.mock.calls.find(
      ([label]) => label === 'trait-runtime-hook-threw',
    );
    expect(containedWarn).toBeDefined();
    expect(containedWarn?.[1]).toContain('doctorProbeObserve');
  });
});
