/**
 * Runtime driver factory.
 *
 * Single bootstrap-time selection seam between the two providers registered
 * by `specs/CLARIFICATIONS/multi-provider-scope.md`:
 *   - `'codex'`        → `CodexRuntimeDriver` (default)
 *   - `'claude-agent'` → `ClaudeAgentRuntimeDriver`
 *
 * Selection is read once from `AUTO_ARCHIVE_RUNTIME_PROVIDER`. Mid-flight
 * provider switching is explicitly out of scope for the current spec.
 *
 * The Claude Agent path imports `query` from `@anthropic-ai/claude-agent-sdk`
 * lazily so build environments without that peer dependency continue to
 * resolve as long as the operator stays on the default `'codex'` provider.
 *
 * ## Lazy SDK import (M7a — Hermes Agent v0.12.0 pattern)
 *
 * By default, `createRuntimeDriverFromEnvAsync` defers loading the adapter
 * modules (which in turn import `@openai/codex-sdk` / the Anthropic SDK) until
 * the first call.  This mirrors the _OpenAIProxy lazy-import pattern from
 * `resource/hermes-agent/run_agent.py:75-90`, saving ~240 ms of cold-start
 * cost on Discord bot revives and letting tests that never touch the runtime
 * run without resolving SDK peer dependencies.
 *
 * Set `AUTO_ARCHIVE_EAGER_SDK_IMPORT=1` to opt out and restore eager-load
 * behaviour (e.g. when latency does not matter but a fast fail on a missing
 * peer is desirable).  When the flag is set, `createRuntimeDriverFromEnvAsync`
 * skips the dynamic-import machinery and uses the already-loaded modules from
 * the static imports at the top of this file — zero overhead, same result.
 *
 * ### Migration path for callers
 * The synchronous `createRuntimeDriverFromEnv` is unchanged and continues to
 * use the static (eager) imports; it exists for callers that cannot yet await.
 * New callers should prefer `createRuntimeDriverFromEnvAsync`, which is the
 * primary lazy entry point.  M7b will migrate `discord-service-bootstrap.ts`
 * to the async API to realise the full cold-start benefit.
 */

import { BoundaryValidationError } from '../contracts/boundary-validators.js';
import {
  CodexRuntimeDriver,
  type CodexRuntimeDriverOptions,
} from './codex-runtime-adapter.js';
import {
  ClaudeAgentRuntimeDriver,
  type ClaudeAgentQueryFactory,
  type ClaudeAgentRuntimeDriverOptions,
} from './claude-agent-runtime-adapter.js';
import {
  resolveClaudeAgentBootstrapResolution,
  type ClaudeAgentBootstrapResolution,
} from './claude-agent-bootstrap-settings.js';
import { bindAgentHarnessDriver } from './agent-harness-registry.js';
import type {
  AgentHarnessPlugin,
  AgentHarnessSelectionSource,
} from '../contracts/agent-harness-plugin.js';
import type { RuntimeDriver } from '../contracts/runtime-driver.js';

// ---------------------------------------------------------------------------
// Env constants
// ---------------------------------------------------------------------------

export const RUNTIME_PROVIDER_ENV = 'AUTO_ARCHIVE_RUNTIME_PROVIDER';

/**
 * Rollback knob.  Set to `'1'` to force eager static import behaviour for
 * `createRuntimeDriverFromEnvAsync`, bypassing the dynamic-import cache path.
 * Useful in environments where a fast-fail on a missing peer dependency is
 * preferred over cold-start latency savings.
 */
export const EAGER_SDK_IMPORT_ENV = 'AUTO_ARCHIVE_EAGER_SDK_IMPORT';

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

export type RuntimeProvider = 'codex' | 'claude-agent';

const RUNTIME_PROVIDER_VALUES: readonly RuntimeProvider[] = [
  'codex',
  'claude-agent',
];

export function resolveRuntimeProvider(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeProvider {
  const raw = env[RUNTIME_PROVIDER_ENV];
  if (raw === undefined) return 'codex';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'codex';
  if (!RUNTIME_PROVIDER_VALUES.includes(trimmed as RuntimeProvider)) {
    throw new BoundaryValidationError(
      'B-SET',
      `${RUNTIME_PROVIDER_ENV} must be one of: ${RUNTIME_PROVIDER_VALUES.join(', ')}.`,
    );
  }
  return trimmed as RuntimeProvider;
}

// ---------------------------------------------------------------------------
// Shared input type
// ---------------------------------------------------------------------------

export interface RuntimeDriverFactoryHookBinding {
  readonly moduleId: string;
  readonly moduleVersion: string;
  readonly providerSelectObserve: import('../contracts/trait-runtime-hook.js').TraitProviderSelectObserveHook;
}

export interface CreateRuntimeDriverInput {
  /**
   * Codex driver wiring inputs (resolved by `resolveCodexBootstrapResolution`
   * upstream). Only consumed when the active provider is `'codex'`.
   */
  readonly codex?: Pick<
    CodexRuntimeDriverOptions,
    'codexOptions' | 'codexRuntimeConfig'
  >;
  /**
   * Claude Agent driver wiring inputs. Only consumed when the active provider
   * is `'claude-agent'`. The `queryFactory` field is required in this branch.
   */
  readonly claudeAgent?: {
    readonly queryFactory: ClaudeAgentQueryFactory;
    readonly resolution?: ClaudeAgentBootstrapResolution;
    readonly extraOptions?: Pick<
      ClaudeAgentRuntimeDriverOptions,
      'systemPrompt' | 'thinking' | 'extraEnv'
    >;
  };
  /**
   * Optional bootstrap-time harness plugins.  When supplied, the selected
   * plugin wraps the already-created provider driver; it does not select or
   * switch providers mid-flight.
   */
  readonly harnessPlugins?: ReadonlyArray<AgentHarnessPlugin>;
  /** M5c — fires when the factory resolves to a provider. */
  readonly observeHooks?: ReadonlyArray<RuntimeDriverFactoryHookBinding>;
}

/**
 * In-flight `providerSelectObserve` hook chains. Each chain is already
 * `.catch()`-contained so it never rejects — the set tracks completion,
 * not failure. Tests and shutdown handlers can call
 * {@link drainPendingProviderSelectHooks} to await all pending chains
 * (audit 2026-05-03 / F5). The synchronous factory path
 * (`createRuntimeDriverFromEnv`) cannot block on hook completion — the
 * fire-and-forget surface there is preserved for back-compat — so the
 * drain is opt-in.
 */
const pendingProviderSelectHooks = new Set<Promise<void>>();

function fireProviderSelectHooks(
  hooks: ReadonlyArray<RuntimeDriverFactoryHookBinding>,
  provider: string,
  source: 'eager' | 'lazy',
): void {
  if (hooks.length === 0) return;
  const observedAt = new Date().toISOString();
  for (const binding of hooks) {
    const chain: Promise<void> = Promise.resolve()
      .then(() =>
        binding.providerSelectObserve(
          {
            moduleId: binding.moduleId as never,
            moduleVersion: binding.moduleVersion,
            observedAt,
          },
          { provider, resolvedAt: observedAt, source },
        ),
      )
      .catch((error: unknown) => {
        console.warn(
          'trait-runtime-hook-threw',
          JSON.stringify({
            hook: 'providerSelectObserve',
            moduleId: binding.moduleId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      })
      .finally(() => {
        pendingProviderSelectHooks.delete(chain);
      });
    pendingProviderSelectHooks.add(chain);
  }
}

/**
 * Resolve once every in-flight `providerSelectObserve` chain spawned by
 * `fireProviderSelectHooks` has settled. Each chain is `.catch()`-contained,
 * so this never rejects. Intended for shutdown handlers and tests that
 * want to assert no hook leaked past the factory call.
 */
export async function drainPendingProviderSelectHooks(): Promise<void> {
  if (pendingProviderSelectHooks.size === 0) return;
  await Promise.allSettled(Array.from(pendingProviderSelectHooks));
}

function bindOptionalHarness(
  driver: RuntimeDriver,
  input: CreateRuntimeDriverInput,
  provider: RuntimeProvider,
  source: AgentHarnessSelectionSource,
): RuntimeDriver {
  return bindAgentHarnessDriver({
    driver,
    plugins: input.harnessPlugins ?? [],
    context: {
      provider,
      source,
      selectedAt: new Date().toISOString(),
    },
  });
}

// ---------------------------------------------------------------------------
// Synchronous factory (legacy / eager path)
// ---------------------------------------------------------------------------

/**
 * Construct the active runtime driver by reading
 * `AUTO_ARCHIVE_RUNTIME_PROVIDER` and applying the matching wiring inputs.
 *
 * Uses the static (eager) imports at the top of this file.  Callers that can
 * await should prefer `createRuntimeDriverFromEnvAsync` which defers the
 * heavyweight SDK load to the first invocation.
 *
 * Callers SHOULD pass both `codex` and `claudeAgent` blocks pre-resolved so
 * that this factory remains a pure switch — failing fast when the selected
 * provider lacks its wiring rather than reaching into env state from inside
 * the runtime layer.
 */
export function createRuntimeDriverFromEnv(
  env: NodeJS.ProcessEnv,
  input: CreateRuntimeDriverInput,
): RuntimeDriver {
  const provider = resolveRuntimeProvider(env);
  fireProviderSelectHooks(input.observeHooks ?? [], provider, 'eager');
  if (provider === 'claude-agent') {
    if (input.claudeAgent === undefined) {
      throw new BoundaryValidationError(
        'B-SET',
        `${RUNTIME_PROVIDER_ENV}=claude-agent requires claudeAgent wiring (queryFactory missing).`,
      );
    }
    const resolution =
      input.claudeAgent.resolution ?? resolveClaudeAgentBootstrapResolution(env);
    const options: ClaudeAgentRuntimeDriverOptions = {
      queryFactory: input.claudeAgent.queryFactory,
      ...(resolution.model === undefined ? {} : { model: resolution.model }),
      ...(resolution.fallbackModel === undefined
        ? {}
        : { fallbackModel: resolution.fallbackModel }),
      ...(resolution.effort === undefined
        ? {}
        : { effort: resolution.effort }),
      ...(resolution.maxTurns === undefined
        ? {}
        : { maxTurns: resolution.maxTurns }),
      ...(resolution.maxBudgetUsd === undefined
        ? {}
        : { maxBudgetUsd: resolution.maxBudgetUsd }),
      ...(resolution.pathToClaudeCodeExecutable === undefined
        ? {}
        : {
            pathToClaudeCodeExecutable: resolution.pathToClaudeCodeExecutable,
          }),
      ...(resolution.anthropicApiKey === undefined
        ? {}
        : { anthropicApiKey: resolution.anthropicApiKey }),
      ...(resolution.permissionMode === undefined
        ? {}
        : { permissionMode: resolution.permissionMode }),
      ...(input.claudeAgent.extraOptions?.systemPrompt === undefined
        ? {}
        : { systemPrompt: input.claudeAgent.extraOptions.systemPrompt }),
      ...(input.claudeAgent.extraOptions?.thinking === undefined
        ? {}
        : { thinking: input.claudeAgent.extraOptions.thinking }),
      ...(input.claudeAgent.extraOptions?.extraEnv === undefined
        ? {}
        : { extraEnv: input.claudeAgent.extraOptions.extraEnv }),
    };
    return bindOptionalHarness(
      new ClaudeAgentRuntimeDriver(options),
      input,
      provider,
      'eager',
    );
  }

  if (input.codex === undefined) {
    throw new BoundaryValidationError(
      'B-SET',
      `${RUNTIME_PROVIDER_ENV}=codex requires codex wiring (codexOptions missing).`,
    );
  }
  return bindOptionalHarness(
    new CodexRuntimeDriver({
      codexOptions: input.codex.codexOptions,
      codexRuntimeConfig: input.codex.codexRuntimeConfig,
    }),
    input,
    provider,
    'eager',
  );
}

// ---------------------------------------------------------------------------
// Async lazy factory (M7a — preferred for new callers)
// ---------------------------------------------------------------------------

/** Opaque cache entry that holds the lazily loaded adapter modules. */
interface _AdapterModules {
  readonly CodexRuntimeDriver: typeof CodexRuntimeDriver;
  readonly ClaudeAgentRuntimeDriver: typeof ClaudeAgentRuntimeDriver;
  readonly resolveClaudeAgentBootstrapResolution: typeof resolveClaudeAgentBootstrapResolution;
}

/**
 * Single-flight Promise.  Once started, subsequent calls to
 * `createRuntimeDriverFromEnvAsync` share the same in-flight import rather
 * than spawning duplicate dynamic imports.  Set to `null` until the first call.
 */
let _adapterLoadPromise: Promise<_AdapterModules> | null = null;

/**
 * Resolved cache.  Populated after the first successful call and reused by all
 * subsequent invocations so the `Promise` round-trip is skipped entirely.
 */
let _adapterCache: _AdapterModules | null = null;

/**
 * Load (or return the already-loaded) adapter modules.
 *
 * When `AUTO_ARCHIVE_EAGER_SDK_IMPORT=1` the static imports at the top of
 * this file are already resident; we just alias them into the cache structure
 * so the same code path applies regardless of the flag.  In the default lazy
 * mode, `import()` is used and its result is memoised.
 */
async function _loadAdapters(
  env: NodeJS.ProcessEnv,
): Promise<_AdapterModules> {
  // Fast path: cache already populated (common after the first call).
  if (_adapterCache !== null) return _adapterCache;

  // Single-flight: if a load is already in progress, await the same Promise.
  if (_adapterLoadPromise !== null) return _adapterLoadPromise;

  const eagerMode = (env[EAGER_SDK_IMPORT_ENV] ?? process.env[EAGER_SDK_IMPORT_ENV]) === '1';

  if (eagerMode) {
    // Rollback path: the static imports are already loaded; alias them.
    // `import()` of a module that is already in the ESM module registry is a
    // synchronous hit on the registry — effectively free.
    _adapterLoadPromise = Promise.resolve().then(() => {
      const mods: _AdapterModules = {
        CodexRuntimeDriver,
        ClaudeAgentRuntimeDriver,
        resolveClaudeAgentBootstrapResolution,
      };
      _adapterCache = mods;
      return mods;
    });
  } else {
    // Lazy path: dynamic import — deferred until now.
    _adapterLoadPromise = Promise.all([
      import('./codex-runtime-adapter.js'),
      import('./claude-agent-runtime-adapter.js'),
      import('./claude-agent-bootstrap-settings.js'),
    ] as const).then(([codexMod, claudeMod, claudeBootstrapMod]) => {
      const mods: _AdapterModules = {
        CodexRuntimeDriver: codexMod.CodexRuntimeDriver,
        ClaudeAgentRuntimeDriver: claudeMod.ClaudeAgentRuntimeDriver,
        resolveClaudeAgentBootstrapResolution:
          claudeBootstrapMod.resolveClaudeAgentBootstrapResolution,
      };
      _adapterCache = mods;
      return mods;
    });
  }

  return _adapterLoadPromise;
}

/**
 * Async variant of `createRuntimeDriverFromEnv`.
 *
 * Defers loading `@openai/codex-sdk` / `@anthropic-ai/claude-agent-sdk` until
 * the first invocation (default).  Subsequent calls skip the dynamic-import
 * machinery and return from the in-memory cache.
 *
 * Set `AUTO_ARCHIVE_EAGER_SDK_IMPORT=1` to skip dynamic imports entirely and
 * use the already-loaded static modules.
 *
 * @param env  - Process environment snapshot (defaults to `process.env`).
 * @param input - Pre-resolved wiring inputs (same shape as the sync overload).
 */
export async function createRuntimeDriverFromEnvAsync(
  env: NodeJS.ProcessEnv,
  input: CreateRuntimeDriverInput,
): Promise<RuntimeDriver> {
  const adapters = await _loadAdapters(env);
  const provider = resolveRuntimeProvider(env);
  fireProviderSelectHooks(input.observeHooks ?? [], provider, 'lazy');

  if (provider === 'claude-agent') {
    if (input.claudeAgent === undefined) {
      throw new BoundaryValidationError(
        'B-SET',
        `${RUNTIME_PROVIDER_ENV}=claude-agent requires claudeAgent wiring (queryFactory missing).`,
      );
    }
    const resolution =
      input.claudeAgent.resolution ??
      adapters.resolveClaudeAgentBootstrapResolution(env);
    const options: ClaudeAgentRuntimeDriverOptions = {
      queryFactory: input.claudeAgent.queryFactory,
      ...(resolution.model === undefined ? {} : { model: resolution.model }),
      ...(resolution.fallbackModel === undefined
        ? {}
        : { fallbackModel: resolution.fallbackModel }),
      ...(resolution.effort === undefined
        ? {}
        : { effort: resolution.effort }),
      ...(resolution.maxTurns === undefined
        ? {}
        : { maxTurns: resolution.maxTurns }),
      ...(resolution.maxBudgetUsd === undefined
        ? {}
        : { maxBudgetUsd: resolution.maxBudgetUsd }),
      ...(resolution.pathToClaudeCodeExecutable === undefined
        ? {}
        : {
            pathToClaudeCodeExecutable: resolution.pathToClaudeCodeExecutable,
          }),
      ...(resolution.anthropicApiKey === undefined
        ? {}
        : { anthropicApiKey: resolution.anthropicApiKey }),
      ...(resolution.permissionMode === undefined
        ? {}
        : { permissionMode: resolution.permissionMode }),
      ...(input.claudeAgent.extraOptions?.systemPrompt === undefined
        ? {}
        : { systemPrompt: input.claudeAgent.extraOptions.systemPrompt }),
      ...(input.claudeAgent.extraOptions?.thinking === undefined
        ? {}
        : { thinking: input.claudeAgent.extraOptions.thinking }),
      ...(input.claudeAgent.extraOptions?.extraEnv === undefined
        ? {}
        : { extraEnv: input.claudeAgent.extraOptions.extraEnv }),
    };
    return bindOptionalHarness(
      new adapters.ClaudeAgentRuntimeDriver(options),
      input,
      provider,
      'lazy',
    );
  }

  if (input.codex === undefined) {
    throw new BoundaryValidationError(
      'B-SET',
      `${RUNTIME_PROVIDER_ENV}=codex requires codex wiring (codexOptions missing).`,
    );
  }
  return bindOptionalHarness(
    new adapters.CodexRuntimeDriver({
      codexOptions: input.codex.codexOptions,
      codexRuntimeConfig: input.codex.codexRuntimeConfig,
    }),
    input,
    provider,
    'lazy',
  );
}

/**
 * Exposed for testing only: resets the lazy-load cache so tests can observe
 * the first-call behaviour in isolation.  Do NOT call in production code.
 */
export function _resetAdapterCacheForTesting(): void {
  _adapterCache = null;
  _adapterLoadPromise = null;
}
