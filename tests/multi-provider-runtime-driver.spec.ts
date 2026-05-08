import { describe, expect, it, vi } from 'vitest';

import type {
  RuntimeDriverResult,
  RuntimeExecutionContext,
} from '../src/contracts/runtime-driver.js';
import { createDispatchPlan } from '../src/core/task.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';
import {
  MultiProviderRuntimeDriver,
  type MultiProviderSettingsProvider,
} from '../src/runtime/multi-provider-runtime-driver.js';

function trivialContext(): RuntimeExecutionContext {
  const plan = createDispatchPlan(createTaskRequest('task-mp'));
  return {
    plan,
    instance: {
      taskId: plan.taskId,
      instanceId: 'instance-mp',
      createdAt: '2026-05-07T00:00:00.000Z',
      runtimeSettings: plan.runtimeSettings,
    },
    emit: async () => {},
    requestApproval: async () => ({ status: 'approved' }),
    isAborted: () => false,
  };
}

function stubDriver(label: string) {
  const result: RuntimeDriverResult = {
    cause: {
      kind: 'success',
      taskId: 'task-mp',
      runtimeInstanceId: 'instance-mp',
      observedAt: '2026-05-07T00:00:00.000Z',
      provenance: label,
    },
    provenance: label,
    reason: `${label}-ok`,
  };
  const run = vi.fn().mockResolvedValue(result);
  return { run };
}

describe('MultiProviderRuntimeDriver (spec §1.4.0)', () => {
  it('routes to the codex sub-driver when no override is set', async () => {
    const codex = stubDriver('codex-runtime-driver');
    const claude = stubDriver('claude-agent-runtime-driver');
    const driver = new MultiProviderRuntimeDriver({
      codexDriver: codex,
      claudeAgentDriver: claude,
      defaultProvider: 'codex',
    });
    const result = await driver.run(trivialContext());
    expect(codex.run).toHaveBeenCalledTimes(1);
    expect(claude.run).not.toHaveBeenCalled();
    expect(result.provenance).toBe('codex-runtime-driver');
  });

  it('routes to claude-agent when override is set', async () => {
    const codex = stubDriver('codex-runtime-driver');
    const claude = stubDriver('claude-agent-runtime-driver');
    const provider: MultiProviderSettingsProvider = {
      readSettings: () => ({ provider: 'claude-agent' }),
    };
    const driver = new MultiProviderRuntimeDriver({
      codexDriver: codex,
      claudeAgentDriver: claude,
      defaultProvider: 'codex',
      settingsProvider: provider,
    });
    await driver.run(trivialContext());
    expect(codex.run).not.toHaveBeenCalled();
    expect(claude.run).toHaveBeenCalledTimes(1);
  });

  it('toggles per call as the override flips', async () => {
    const codex = stubDriver('codex-runtime-driver');
    const claude = stubDriver('claude-agent-runtime-driver');
    let active: 'codex' | 'claude-agent' | undefined = undefined;
    const driver = new MultiProviderRuntimeDriver({
      codexDriver: codex,
      claudeAgentDriver: claude,
      defaultProvider: 'codex',
      settingsProvider: {
        readSettings: () => (active === undefined ? {} : { provider: active }),
      },
    });
    await driver.run(trivialContext());
    active = 'claude-agent';
    await driver.run(trivialContext());
    active = 'codex';
    await driver.run(trivialContext());
    active = undefined;
    await driver.run(trivialContext());
    expect(codex.run).toHaveBeenCalledTimes(3);
    expect(claude.run).toHaveBeenCalledTimes(1);
  });

  it('falls back to default when the settings provider throws', async () => {
    const codex = stubDriver('codex-runtime-driver');
    const claude = stubDriver('claude-agent-runtime-driver');
    const driver = new MultiProviderRuntimeDriver({
      codexDriver: codex,
      claudeAgentDriver: claude,
      defaultProvider: 'claude-agent',
      settingsProvider: {
        readSettings: () => {
          throw new Error('store broken');
        },
      },
    });
    await driver.run(trivialContext());
    expect(claude.run).toHaveBeenCalledTimes(1);
    expect(codex.run).not.toHaveBeenCalled();
  });

  it('emits the optional onProviderSelected hook with the source attribution', async () => {
    const codex = stubDriver('codex-runtime-driver');
    const claude = stubDriver('claude-agent-runtime-driver');
    const observed: Array<Record<string, unknown>> = [];
    const driver = new MultiProviderRuntimeDriver({
      codexDriver: codex,
      claudeAgentDriver: claude,
      defaultProvider: 'codex',
      settingsProvider: { readSettings: () => ({ provider: 'claude-agent' }) },
      onProviderSelected: (sel) => observed.push({ ...sel }),
    });
    await driver.run(trivialContext());
    expect(observed).toEqual([
      {
        provider: 'claude-agent',
        source: 'override',
        defaultProvider: 'codex',
      },
    ]);
  });

  it('swallows observer errors so dispatch is never broken by audit failures', async () => {
    const codex = stubDriver('codex-runtime-driver');
    const claude = stubDriver('claude-agent-runtime-driver');
    const driver = new MultiProviderRuntimeDriver({
      codexDriver: codex,
      claudeAgentDriver: claude,
      defaultProvider: 'codex',
      onProviderSelected: () => {
        throw new Error('audit hook broken');
      },
    });
    const result = await driver.run(trivialContext());
    expect(result.cause.kind).toBe('success');
  });

  it('rejects unknown override values with a fallback to default', async () => {
    const codex = stubDriver('codex-runtime-driver');
    const claude = stubDriver('claude-agent-runtime-driver');
    const driver = new MultiProviderRuntimeDriver({
      codexDriver: codex,
      claudeAgentDriver: claude,
      defaultProvider: 'codex',
      settingsProvider: {
        // @ts-expect-error testing wide-input branch
        readSettings: () => ({ provider: 'gemini' }),
      },
    });
    await driver.run(trivialContext());
    expect(codex.run).toHaveBeenCalledTimes(1);
    expect(claude.run).not.toHaveBeenCalled();
  });

  describe('P2-A observability surface', () => {
    it("fallbackReason='override-unknown-literal' when settings provider returns invalid provider", () => {
      const codex = stubDriver('codex-runtime-driver');
      const claude = stubDriver('claude-agent-runtime-driver');
      const driver = new MultiProviderRuntimeDriver({
        codexDriver: codex,
        claudeAgentDriver: claude,
        defaultProvider: 'codex',
        settingsProvider: {
          // @ts-expect-error testing wide-input branch
          readSettings: () => ({ provider: 'gemini' }),
        },
      });
      const selection = driver.resolveActiveProvider();
      expect(selection).toEqual({
        provider: 'codex',
        source: 'default',
        fallbackReason: 'override-unknown-literal',
      });
      expect(driver.observabilitySnapshot()).toEqual({
        observerFailureCount: 0,
        lastFallbackReason: 'override-unknown-literal',
        lastSelectionSource: 'default',
      });
    });

    it("fallbackReason='settings-read-threw' when readSettings throws", () => {
      const codex = stubDriver('codex-runtime-driver');
      const claude = stubDriver('claude-agent-runtime-driver');
      const driver = new MultiProviderRuntimeDriver({
        codexDriver: codex,
        claudeAgentDriver: claude,
        defaultProvider: 'claude-agent',
        settingsProvider: {
          readSettings: () => {
            throw new Error('store broken');
          },
        },
      });
      const selection = driver.resolveActiveProvider();
      expect(selection.fallbackReason).toBe('settings-read-threw');
      expect(selection.source).toBe('default');
      expect(selection.provider).toBe('claude-agent');
      expect(driver.observabilitySnapshot().lastFallbackReason).toBe(
        'settings-read-threw',
      );
    });

    it('no fallbackReason when override is valid', () => {
      const codex = stubDriver('codex-runtime-driver');
      const claude = stubDriver('claude-agent-runtime-driver');
      const driver = new MultiProviderRuntimeDriver({
        codexDriver: codex,
        claudeAgentDriver: claude,
        defaultProvider: 'codex',
        settingsProvider: { readSettings: () => ({ provider: 'claude-agent' }) },
      });
      const selection = driver.resolveActiveProvider();
      expect(selection).toEqual({
        provider: 'claude-agent',
        source: 'override',
      });
      expect(selection.fallbackReason).toBeUndefined();
      expect(driver.observabilitySnapshot()).toEqual({
        observerFailureCount: 0,
        lastSelectionSource: 'override',
      });
    });

    it('omits fallbackReason when no settings provider is wired (legacy bootstrap)', () => {
      const codex = stubDriver('codex-runtime-driver');
      const claude = stubDriver('claude-agent-runtime-driver');
      const driver = new MultiProviderRuntimeDriver({
        codexDriver: codex,
        claudeAgentDriver: claude,
        defaultProvider: 'codex',
      });
      const selection = driver.resolveActiveProvider();
      expect(selection.source).toBe('default');
      expect(selection.fallbackReason).toBeUndefined();
      expect(driver.observabilitySnapshot().lastFallbackReason).toBeUndefined();
    });

    it('onObserverError fires when onProviderSelected throws; observerFailureCount increments', async () => {
      const codex = stubDriver('codex-runtime-driver');
      const claude = stubDriver('claude-agent-runtime-driver');
      const observerErrors: unknown[] = [];
      const driver = new MultiProviderRuntimeDriver({
        codexDriver: codex,
        claudeAgentDriver: claude,
        defaultProvider: 'codex',
        onProviderSelected: () => {
          throw new Error('audit hook broken');
        },
        onObserverError: (error) => observerErrors.push(error),
      });
      const result = await driver.run(trivialContext());
      expect(result.cause.kind).toBe('success');
      expect(observerErrors).toHaveLength(1);
      expect((observerErrors[0] as Error).message).toBe('audit hook broken');
      expect(driver.observabilitySnapshot().observerFailureCount).toBe(1);
      // Second call also increments.
      await driver.run(trivialContext());
      expect(driver.observabilitySnapshot().observerFailureCount).toBe(2);
      expect(observerErrors).toHaveLength(2);
    });

    it('still preserves the legacy swallow when onObserverError is not supplied', async () => {
      const codex = stubDriver('codex-runtime-driver');
      const claude = stubDriver('claude-agent-runtime-driver');
      const driver = new MultiProviderRuntimeDriver({
        codexDriver: codex,
        claudeAgentDriver: claude,
        defaultProvider: 'codex',
        onProviderSelected: () => {
          throw new Error('audit hook broken');
        },
      });
      const result = await driver.run(trivialContext());
      expect(result.cause.kind).toBe('success');
      expect(driver.observabilitySnapshot().observerFailureCount).toBe(1);
    });

    it('forwards fallbackReason into the onProviderSelected payload', async () => {
      const codex = stubDriver('codex-runtime-driver');
      const claude = stubDriver('claude-agent-runtime-driver');
      const observed: Array<Record<string, unknown>> = [];
      const driver = new MultiProviderRuntimeDriver({
        codexDriver: codex,
        claudeAgentDriver: claude,
        defaultProvider: 'codex',
        settingsProvider: {
          // @ts-expect-error testing wide-input branch
          readSettings: () => ({ provider: 'gemini' }),
        },
        onProviderSelected: (sel) => observed.push({ ...sel }),
      });
      await driver.run(trivialContext());
      expect(observed).toEqual([
        {
          provider: 'codex',
          source: 'default',
          defaultProvider: 'codex',
          fallbackReason: 'override-unknown-literal',
        },
      ]);
    });
  });
});
