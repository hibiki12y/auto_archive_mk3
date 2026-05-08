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
  }) => void;
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

  constructor(options: MultiProviderPlanaAdvisorOptions) {
    this.codexAdvisor = options.codexAdvisor;
    this.claudeAdvisor = options.claudeAdvisor;
    this.defaultProvider = options.defaultProvider;
    this.settingsProvider = options.settingsProvider;
    this.onProviderSelected = options.onProviderSelected;
  }

  resolveActiveProvider(): {
    readonly provider: RuntimeProvider;
    readonly source: 'override' | 'default';
  } {
    let snapshot: MultiProviderPlanaSettingsSnapshot;
    try {
      snapshot = this.settingsProvider?.readSettings() ?? {};
    } catch {
      snapshot = {};
    }
    if (snapshot.provider === 'codex' || snapshot.provider === 'claude-agent') {
      return { provider: snapshot.provider, source: 'override' };
    }
    return { provider: this.defaultProvider, source: 'default' };
  }

  async review(input: PlanaAdvisorInput): Promise<PlanaAdvisorVerdict> {
    const selection = this.resolveActiveProvider();
    if (this.onProviderSelected !== undefined) {
      try {
        this.onProviderSelected({
          provider: selection.provider,
          source: selection.source,
          defaultProvider: this.defaultProvider,
        });
      } catch {
        // Observer failures are contained; fail-open contract is owned by the
        // sub-advisors.
      }
    }
    const sub =
      selection.provider === 'claude-agent'
        ? this.claudeAdvisor
        : this.codexAdvisor;
    return sub.review(input);
  }
}
