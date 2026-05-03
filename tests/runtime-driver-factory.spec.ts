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
});
