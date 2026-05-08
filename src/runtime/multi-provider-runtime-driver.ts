/**
 * Multi-provider runtime driver.
 *
 * Dispatch-boundary provider hot-swap (multi-provider-scope.md §1.4.0). When
 * the bootstrap can authenticate BOTH `codex` and `claude-agent`, the driver
 * factory wraps the two sub-drivers in this class so the operator can switch
 * Arona's active provider via `/config set persona:arona key:provider`
 * without restarting the service.
 *
 * Invariants:
 *
 *   - One dispatch uses exactly ONE sub-driver. The wrapper consults the
 *     settings provider on `run()` entry and delegates wholesale; it never
 *     fans out, never spawns the other sub-driver, and never preempts a
 *     running dispatch.
 *   - The bootstrap-time `defaultProvider` is the fallback when the settings
 *     provider has no override or returns a value the wrapper does not know
 *     about. This preserves the historical "single bootstrap-time provider"
 *     semantic for environments that never use `/config set`.
 *   - Plana advisor provider remains pinned to its bootstrap config — the
 *     wrapper is intentionally Arona-scoped only (spec §1.4 OOS).
 */

import type {
  RuntimeDriver,
  RuntimeDriverResult,
  RuntimeExecutionContext,
} from '../contracts/runtime-driver.js';
import type { RuntimeProvider } from './runtime-driver-factory.js';

export interface MultiProviderSettingsSnapshot {
  readonly provider?: RuntimeProvider;
}

export interface MultiProviderSettingsProvider {
  /** Returns the operator's `arona.provider` override snapshot, or {} if none. */
  readSettings(): MultiProviderSettingsSnapshot;
}

/**
 * Reason classification for a `source: 'default'` outcome.
 *
 * Set ONLY when the wrapper consulted a settings provider (i.e. one was
 * supplied). When no settings provider is wired at all, the absence of an
 * override is the historical "no opinion" path and `fallbackReason` is left
 * undefined — that is not an observability incident.
 *
 *   - `override-missing` — settings provider returned `{}` (no `provider`).
 *   - `override-unknown-literal` — settings provider returned a `provider`
 *     value that is neither `codex` nor `claude-agent`.
 *   - `settings-read-threw` — `readSettings()` threw; we recovered to default.
 */
export type MultiProviderRuntimeFallbackReason =
  | 'override-missing'
  | 'override-unknown-literal'
  | 'settings-read-threw';

export interface MultiProviderRuntimeProviderSelection {
  readonly provider: RuntimeProvider;
  readonly source: 'override' | 'default';
  readonly fallbackReason?: MultiProviderRuntimeFallbackReason;
}

export interface MultiProviderRuntimeObservabilitySnapshot {
  readonly observerFailureCount: number;
  readonly lastFallbackReason?: MultiProviderRuntimeFallbackReason;
  readonly lastSelectionSource?: 'override' | 'default';
}

export interface MultiProviderRuntimeDriverOptions {
  readonly codexDriver: RuntimeDriver;
  readonly claudeAgentDriver: RuntimeDriver;
  readonly defaultProvider: RuntimeProvider;
  /**
   * Optional settings provider — when omitted, the wrapper always uses
   * `defaultProvider`. Tests use the in-memory variant; production wires the
   * persona-settings-store-backed provider so `/config set` lands here.
   */
  readonly settingsProvider?: MultiProviderSettingsProvider;
  /**
   * Optional observer fired whenever a dispatch is routed. Useful for audit
   * ledger entries or metrics — does NOT affect dispatch outcome. Failures
   * inside the observer are swallowed so they never break a dispatch.
   */
  readonly onProviderSelected?: (selection: {
    readonly provider: RuntimeProvider;
    readonly source: 'override' | 'default';
    readonly defaultProvider: RuntimeProvider;
    readonly fallbackReason?: MultiProviderRuntimeFallbackReason;
  }) => void;
  /**
   * Optional sink for `onProviderSelected` failures. The default behavior
   * (swallow) is preserved for callers that do not opt in. Errors thrown by
   * `onObserverError` itself are also swallowed — the dispatch invariant is
   * "audit hooks NEVER break a dispatch".
   */
  readonly onObserverError?: (error: unknown) => void;
}

export class MultiProviderRuntimeDriver implements RuntimeDriver {
  private readonly codexDriver: RuntimeDriver;
  private readonly claudeAgentDriver: RuntimeDriver;
  private readonly defaultProvider: RuntimeProvider;
  private readonly settingsProvider:
    | MultiProviderSettingsProvider
    | undefined;
  private readonly onProviderSelected:
    | MultiProviderRuntimeDriverOptions['onProviderSelected']
    | undefined;
  private readonly onObserverError:
    | MultiProviderRuntimeDriverOptions['onObserverError']
    | undefined;
  private observerFailureCount = 0;
  private lastFallbackReason: MultiProviderRuntimeFallbackReason | undefined;
  private lastSelectionSource: 'override' | 'default' | undefined;

  constructor(options: MultiProviderRuntimeDriverOptions) {
    this.codexDriver = options.codexDriver;
    this.claudeAgentDriver = options.claudeAgentDriver;
    this.defaultProvider = options.defaultProvider;
    this.settingsProvider = options.settingsProvider;
    this.onProviderSelected = options.onProviderSelected;
    this.onObserverError = options.onObserverError;
  }

  resolveActiveProvider(): MultiProviderRuntimeProviderSelection {
    // We only emit a `fallbackReason` when there was a settings provider to
    // consult. Without one, "no override" is the historical pass-through and
    // not an observability event.
    if (this.settingsProvider === undefined) {
      const selection: MultiProviderRuntimeProviderSelection = {
        provider: this.defaultProvider,
        source: 'default',
      };
      this.lastFallbackReason = undefined;
      this.lastSelectionSource = 'default';
      return selection;
    }
    let snapshot: MultiProviderSettingsSnapshot;
    let readThrew = false;
    try {
      snapshot = this.settingsProvider.readSettings() ?? {};
    } catch {
      snapshot = {};
      readThrew = true;
    }
    if (snapshot.provider === 'codex' || snapshot.provider === 'claude-agent') {
      this.lastFallbackReason = undefined;
      this.lastSelectionSource = 'override';
      return { provider: snapshot.provider, source: 'override' };
    }
    const fallbackReason: MultiProviderRuntimeFallbackReason = readThrew
      ? 'settings-read-threw'
      : snapshot.provider === undefined
        ? 'override-missing'
        : 'override-unknown-literal';
    this.lastFallbackReason = fallbackReason;
    this.lastSelectionSource = 'default';
    return {
      provider: this.defaultProvider,
      source: 'default',
      fallbackReason,
    };
  }

  observabilitySnapshot(): MultiProviderRuntimeObservabilitySnapshot {
    return {
      observerFailureCount: this.observerFailureCount,
      ...(this.lastFallbackReason === undefined
        ? {}
        : { lastFallbackReason: this.lastFallbackReason }),
      ...(this.lastSelectionSource === undefined
        ? {}
        : { lastSelectionSource: this.lastSelectionSource }),
    };
  }

  async run(context: RuntimeExecutionContext): Promise<RuntimeDriverResult> {
    const selection = this.resolveActiveProvider();
    if (this.onProviderSelected !== undefined) {
      try {
        this.onProviderSelected({
          provider: selection.provider,
          source: selection.source,
          defaultProvider: this.defaultProvider,
          ...(selection.fallbackReason === undefined
            ? {}
            : { fallbackReason: selection.fallbackReason }),
        });
      } catch (error) {
        // Swallow observer failures — never let audit hooks break dispatch.
        this.observerFailureCount += 1;
        if (this.onObserverError !== undefined) {
          try {
            this.onObserverError(error);
          } catch {
            // The observer-error sink itself failed; preserve the
            // "hooks NEVER break a dispatch" invariant.
          }
        }
      }
    }
    const sub =
      selection.provider === 'claude-agent'
        ? this.claudeAgentDriver
        : this.codexDriver;
    return sub.run(context);
  }
}
