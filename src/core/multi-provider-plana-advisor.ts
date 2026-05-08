/**
 * Multi-provider Plana runtime advisor.
 *
 * Sibling of `MultiProviderRuntimeDriver`. When the bootstrap can authenticate
 * BOTH `codex` and `claude-agent`, the bootstrap wraps the two Plana sub-
 * advisors in this class so the operator can hot-swap Plana's provider via
 * `/config set persona:plana key:provider value:<codex|claude-agent>` without
 * restarting the service (multi-provider-scope.md §1.5.0).
 *
 * Invariants (mirror MultiProviderRuntimeDriver):
 *
 *   - One advisor `review()` call uses exactly ONE sub-advisor. The wrapper
 *     consults the settings provider on every `review()` entry and delegates
 *     wholesale; it never fans out, never spawns the other sub-advisor, and
 *     never preempts an in-flight call.
 *   - The bootstrap-time `defaultProvider` is the fallback when the settings
 *     provider has no override or returns an unknown value. This preserves
 *     the historical "single bootstrap-time advisor" semantic for environments
 *     that never use `/config set`.
 *   - Plana's advisor invariants (single-shot, no tools, no recursion, fail-
 *     open) are owned by the sub-advisors themselves; this wrapper does not
 *     short-circuit `shouldConsult` / call cap / fail-open behavior.
 */

import type {
  PlanaAdvisorInput,
  PlanaAdvisorVerdict,
  PlanaRuntimeAdvisor,
} from './plana-runtime-advisor.js';
import type { RuntimeProvider } from '../runtime/runtime-driver-factory.js';

export interface MultiProviderPlanaSettingsSnapshot {
  readonly provider?: RuntimeProvider;
}

export interface MultiProviderPlanaSettingsProvider {
  /** Returns the operator's `plana.provider` override snapshot, or {} if none. */
  readSettings(): MultiProviderPlanaSettingsSnapshot;
}

/**
 * Reason classification for a `source: 'default'` outcome on the Plana
 * advisor wrapper. Mirrors `MultiProviderRuntimeFallbackReason`. Only set
 * when a settings provider was supplied — without one, the absence of an
 * override is the historical pass-through and not an observability event.
 *
 *   - `override-missing` — settings provider returned `{}` (no `provider`).
 *   - `override-unknown-literal` — settings provider returned a `provider`
 *     value that is neither `codex` nor `claude-agent`.
 *   - `settings-read-threw` — `readSettings()` threw; we recovered to default.
 */
export type MultiProviderPlanaFallbackReason =
  | 'override-missing'
  | 'override-unknown-literal'
  | 'settings-read-threw';

export interface MultiProviderPlanaProviderSelection {
  readonly provider: RuntimeProvider;
  readonly source: 'override' | 'default';
  readonly fallbackReason?: MultiProviderPlanaFallbackReason;
}

export interface MultiProviderPlanaObservabilitySnapshot {
  readonly observerFailureCount: number;
  readonly lastFallbackReason?: MultiProviderPlanaFallbackReason;
  readonly lastSelectionSource?: 'override' | 'default';
}

export interface MultiProviderPlanaAdvisorOptions {
  readonly codexAdvisor: PlanaRuntimeAdvisor;
  readonly claudeAdvisor: PlanaRuntimeAdvisor;
  readonly defaultProvider: RuntimeProvider;
  readonly settingsProvider?: MultiProviderPlanaSettingsProvider;
  /**
   * Optional observer fired whenever an advisor call is routed. Errors inside
   * the observer are swallowed so they never break the advisor's fail-open
   * contract.
   */
  readonly onProviderSelected?: (selection: {
    readonly provider: RuntimeProvider;
    readonly source: 'override' | 'default';
    readonly defaultProvider: RuntimeProvider;
    readonly fallbackReason?: MultiProviderPlanaFallbackReason;
  }) => void;
  /**
   * Optional sink for `onProviderSelected` failures. The default behavior
   * (swallow) is preserved for callers that do not opt in. Errors thrown by
   * `onObserverError` itself are also swallowed — the fail-open contract is
   * "audit hooks NEVER break a review".
   */
  readonly onObserverError?: (error: unknown) => void;
}

export class MultiProviderPlanaAdvisor implements PlanaRuntimeAdvisor {
  private readonly codexAdvisor: PlanaRuntimeAdvisor;
  private readonly claudeAdvisor: PlanaRuntimeAdvisor;
  private readonly defaultProvider: RuntimeProvider;
  private readonly settingsProvider:
    | MultiProviderPlanaSettingsProvider
    | undefined;
  private readonly onProviderSelected:
    | MultiProviderPlanaAdvisorOptions['onProviderSelected']
    | undefined;
  private readonly onObserverError:
    | MultiProviderPlanaAdvisorOptions['onObserverError']
    | undefined;
  private observerFailureCount = 0;
  private lastFallbackReason: MultiProviderPlanaFallbackReason | undefined;
  private lastSelectionSource: 'override' | 'default' | undefined;

  constructor(options: MultiProviderPlanaAdvisorOptions) {
    this.codexAdvisor = options.codexAdvisor;
    this.claudeAdvisor = options.claudeAdvisor;
    this.defaultProvider = options.defaultProvider;
    this.settingsProvider = options.settingsProvider;
    this.onProviderSelected = options.onProviderSelected;
    this.onObserverError = options.onObserverError;
  }

  resolveActiveProvider(): MultiProviderPlanaProviderSelection {
    if (this.settingsProvider === undefined) {
      this.lastFallbackReason = undefined;
      this.lastSelectionSource = 'default';
      return { provider: this.defaultProvider, source: 'default' };
    }
    let snapshot: MultiProviderPlanaSettingsSnapshot;
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
    const fallbackReason: MultiProviderPlanaFallbackReason = readThrew
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

  observabilitySnapshot(): MultiProviderPlanaObservabilitySnapshot {
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

  async review(input: PlanaAdvisorInput): Promise<PlanaAdvisorVerdict> {
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
        // Observer failures are contained; fail-open contract is owned by the
        // sub-advisors.
        this.observerFailureCount += 1;
        if (this.onObserverError !== undefined) {
          try {
            this.onObserverError(error);
          } catch {
            // The observer-error sink itself failed; preserve the
            // "audit hooks NEVER break a review" invariant.
          }
        }
      }
    }
    const sub =
      selection.provider === 'claude-agent'
        ? this.claudeAdvisor
        : this.codexAdvisor;
    return sub.review(input);
  }
}
