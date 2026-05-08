import type { RuntimeDriver } from './runtime-driver.js';

/**
 * Agent harness plugin contract.
 *
 * The current branch keeps runtime-provider selection bootstrap-only.  A
 * harness plugin therefore does not select or switch providers mid-flight; it
 * binds to the already-selected provider and wraps the resulting
 * `RuntimeDriver` at the factory boundary.  The v1 registry selects exactly
 * one plugin; `source` is an audit/informational field, not permission to
 * diverge provider semantics between sync and async factory paths.
 */

export type AgentHarnessPluginId = string;

export type AgentHarnessSelectionSource = 'eager' | 'lazy';

export interface AgentHarnessSupportContext {
  readonly provider: string;
  readonly source: AgentHarnessSelectionSource;
  readonly selectedAt: string;
}

export type AgentHarnessSupportResult =
  | {
      readonly supported: true;
      /** Higher values win; default is 0. Ties preserve declaration order. */
      readonly priority?: number;
      readonly reason?: string;
    }
  | {
      readonly supported: false;
      readonly reason: string;
    };

export interface AgentHarnessDriverBinding {
  readonly harnessId: AgentHarnessPluginId;
  readonly provider: string;
  readonly source: AgentHarnessSelectionSource;
  readonly boundAt: string;
}

export interface AgentHarnessWrapDriverInput {
  readonly driver: RuntimeDriver;
  readonly context: AgentHarnessSupportContext;
  readonly binding: AgentHarnessDriverBinding;
}

export interface AgentHarnessPlugin {
  readonly id: AgentHarnessPluginId;
  readonly label?: string;
  supports(context: AgentHarnessSupportContext): AgentHarnessSupportResult;
  wrapDriver(input: AgentHarnessWrapDriverInput): RuntimeDriver;
  reset?(binding: AgentHarnessDriverBinding): Promise<void> | void;
}
