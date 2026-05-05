import { describe, expect, it } from 'vitest';

import { BoundaryValidationError } from '../src/contracts/boundary-validators.js';
import {
  createRuntimeDriverFromEnv,
  drainPendingProviderSelectHooks,
  resolveRuntimeProvider,
  RUNTIME_PROVIDER_ENV,
} from '../src/runtime/runtime-driver-factory.js';
import { ClaudeAgentRuntimeDriver } from '../src/runtime/claude-agent-runtime-adapter.js';
import { CodexRuntimeDriver } from '../src/runtime/codex-runtime-adapter.js';
import type { TraitProviderSelectObserveHook } from '../src/contracts/trait-runtime-hook.js';
import type {
  AgentHarnessPlugin,
  AgentHarnessSupportContext,
} from '../src/contracts/agent-harness-plugin.js';
import type { RuntimeDriver } from '../src/contracts/runtime-driver.js';

describe('resolveRuntimeProvider', () => {
  it('defaults to "codex" when env is unset or blank', () => {
    expect(resolveRuntimeProvider({})).toBe('codex');
    expect(resolveRuntimeProvider({ [RUNTIME_PROVIDER_ENV]: '' })).toBe('codex');
    expect(resolveRuntimeProvider({ [RUNTIME_PROVIDER_ENV]: '   ' })).toBe(
      'codex',
    );
  });

  it('returns "claude-agent" when env requests it', () => {
    expect(
      resolveRuntimeProvider({ [RUNTIME_PROVIDER_ENV]: 'claude-agent' }),
    ).toBe('claude-agent');
  });

  it('rejects unknown provider literals at boundary', () => {
    expect(() =>
      resolveRuntimeProvider({ [RUNTIME_PROVIDER_ENV]: 'gemini' }),
    ).toThrow(BoundaryValidationError);
  });
});

describe('createRuntimeDriverFromEnv', () => {
  it('builds a CodexRuntimeDriver when codex wiring is supplied', () => {
    const driver = createRuntimeDriverFromEnv(
      {},
      {
        codex: {
          codexOptions: {},
          codexRuntimeConfig: {},
        },
      },
    );
    expect(driver).toBeInstanceOf(CodexRuntimeDriver);
  });

  it('treats an explicit empty harness plugin list as an unwrapped factory path', () => {
    const driver = createRuntimeDriverFromEnv(
      {},
      {
        codex: {
          codexOptions: {},
          codexRuntimeConfig: {},
        },
        harnessPlugins: [],
      },
    );
    expect(driver).toBeInstanceOf(CodexRuntimeDriver);
  });

  it('builds a ClaudeAgentRuntimeDriver when env selects claude-agent', () => {
    const driver = createRuntimeDriverFromEnv(
      { [RUNTIME_PROVIDER_ENV]: 'claude-agent' },
      {
        claudeAgent: {
          queryFactory: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: 'result', subtype: 'success', result: 'ok' };
            },
          }),
        },
      },
    );
    expect(driver).toBeInstanceOf(ClaudeAgentRuntimeDriver);
  });

  it('refuses claude-agent selection without claudeAgent wiring', () => {
    expect(() =>
      createRuntimeDriverFromEnv(
        { [RUNTIME_PROVIDER_ENV]: 'claude-agent' },
        {},
      ),
    ).toThrow(BoundaryValidationError);
  });

  it('refuses codex selection without codex wiring', () => {
    expect(() => createRuntimeDriverFromEnv({}, {})).toThrow(
      BoundaryValidationError,
    );
  });

  it('reports missing provider wiring before validating harness plugins', () => {
    let supportsCalled = false;
    const invalidHarness: AgentHarnessPlugin = {
      id: ' ',
      supports() {
        supportsCalled = true;
        return { supported: true, priority: 1 };
      },
      wrapDriver(input) {
        return input.driver;
      },
    };

    expect(() =>
      createRuntimeDriverFromEnv(
        {},
        {
          harnessPlugins: [invalidHarness],
        },
      ),
    ).toThrow(
      `${RUNTIME_PROVIDER_ENV}=codex requires codex wiring (codexOptions missing).`,
    );
    expect(supportsCalled).toBe(false);
  });

  it('passes claude bootstrap resolution into the driver options', () => {
    const driver = createRuntimeDriverFromEnv(
      {
        [RUNTIME_PROVIDER_ENV]: 'claude-agent',
        AUTO_ARCHIVE_CLAUDE_MODEL: 'claude-sonnet-4-6',
        AUTO_ARCHIVE_CLAUDE_FALLBACK_MODEL: 'claude-haiku-4-5',
      },
      {
        claudeAgent: {
          queryFactory: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: 'result', subtype: 'success', result: 'ok' };
            },
          }),
        },
      },
    );
    expect(driver).toBeInstanceOf(ClaudeAgentRuntimeDriver);
  });

  it('drainPendingProviderSelectHooks awaits in-flight provider-select hooks (F5)', async () => {
    let hookSettled = false;
    const slowObserve: TraitProviderSelectObserveHook = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      hookSettled = true;
    };
    createRuntimeDriverFromEnv(
      {},
      {
        codex: { codexOptions: {}, codexRuntimeConfig: {} },
        observeHooks: [
          {
            moduleId: 'mod-drain-f5',
            moduleVersion: '1.0.0',
            providerSelectObserve: slowObserve,
          },
        ],
      },
    );
    // Synchronous factory cannot block; the hook chain is still in flight.
    expect(hookSettled).toBe(false);
    await drainPendingProviderSelectHooks();
    expect(hookSettled).toBe(true);
    // A subsequent drain when nothing is in flight resolves immediately.
    await drainPendingProviderSelectHooks();
  });

  it('applies an explicit harness plugin wrapper after provider selection', () => {
    const wrappedDriver: RuntimeDriver = {
      async run() {
        throw new Error('not exercised');
      },
    };
    let observedContext: AgentHarnessSupportContext | undefined;
    const harness: AgentHarnessPlugin = {
      id: 'harness.codex.test',
      supports(context) {
        observedContext = context;
        if (context.provider !== 'codex') {
          return { supported: false, reason: 'codex only' };
        }
        return { supported: true, priority: 10 };
      },
      wrapDriver(input) {
        expect(input.driver).toBeInstanceOf(CodexRuntimeDriver);
        expect(input.binding.harnessId).toBe('harness.codex.test');
        expect(input.binding.provider).toBe('codex');
        expect(input.binding.source).toBe('eager');
        return wrappedDriver;
      },
    };

    const driver = createRuntimeDriverFromEnv(
      {},
      {
        codex: { codexOptions: {}, codexRuntimeConfig: {} },
        harnessPlugins: [harness],
      },
    );

    expect(driver).toBe(wrappedDriver);
    expect(observedContext?.provider).toBe('codex');
    expect(observedContext?.source).toBe('eager');
  });

  it('fails closed when configured harness plugins do not support the provider', () => {
    const unsupported: AgentHarnessPlugin = {
      id: 'harness.unsupported.test',
      supports() {
        return { supported: false, reason: 'only supports another provider' };
      },
      wrapDriver(input) {
        return input.driver;
      },
    };

    expect(() =>
      createRuntimeDriverFromEnv(
        {},
        {
          codex: { codexOptions: {}, codexRuntimeConfig: {} },
          harnessPlugins: [unsupported],
        },
      ),
    ).toThrow(BoundaryValidationError);
  });
});
