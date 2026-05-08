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
  }) => void;
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

  constructor(options: MultiProviderRuntimeDriverOptions) {
    this.codexDriver = options.codexDriver;
    this.claudeAgentDriver = options.claudeAgentDriver;
    this.defaultProvider = options.defaultProvider;
    this.settingsProvider = options.settingsProvider;
    this.onProviderSelected = options.onProviderSelected;
  }

  resolveActiveProvider(): {
    readonly provider: RuntimeProvider;
    readonly source: 'override' | 'default';
  } {
    let snapshot: MultiProviderSettingsSnapshot;
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

  async run(context: RuntimeExecutionContext): Promise<RuntimeDriverResult> {
    const selection = this.resolveActiveProvider();
    if (this.onProviderSelected !== undefined) {
      try {
        this.onProviderSelected({
          provider: selection.provider,
          source: selection.source,
          defaultProvider: this.defaultProvider,
        });
      } catch {
        // Swallow observer failures — never let audit hooks break dispatch.
      }
    }
    const sub =
      selection.provider === 'claude-agent'
        ? this.claudeAgentDriver
        : this.codexDriver;
    return sub.run(context);
  }
}
