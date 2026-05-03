/**
 * Runtime driver port (contract layer).
 *
 * This module hosts the **port** declarations for the runtime-driver seam:
 * the `RuntimeDriver` interface plus its directly-associated value-types and
 * cause-side types. Concrete drivers (e.g. the Codex SDK adapter at
 * `src/runtime/codex-runtime-adapter.ts`) implement this port; the
 * lifecycle/orchestrator consumes it.
 *
 * Origin: extracted from `src/runtime/agent-runtime.ts` per
 * `specs/wu-scaffold-cleanup-bundle.md` §A (WU-A) — see the back-reference
 * to `specs/CLARIFICATIONS/scaffold-adapter-driver-trait-definitions.md`
 * §6.2 WU-A.
 *
 * Constraints inherited from §0 of the bundle:
 *  - C1: Codex SDK is the only LLM provider on this branch. This port stays
 *    single-provider in shape; no `LLMProvider` abstraction.
 *  - C3: HARD REJECT generalizing the port to multi-provider shape.
 *
 * Note (layering): this port references `DispatchPlan` from `core/task.ts`
 * to preserve the original `RuntimeExecutionContext` shape verbatim. The
 * import inversion is pre-existing (the original definition lived in
 * `runtime/`, also outside `core/`); cleaning it up is out of scope for
 * WU-A and would require its own work order.
 */

import type { DispatchPlan } from '../core/task.js';
import type { ObservedResourceSummary } from './resource-envelope.js';
import type {
  ApprovalDecision,
  RuntimeApprovalRequest,
  RuntimeEvent,
  RuntimeEventInput,
} from './runtime-event.js';
import type { RuntimeSettingsBundle } from './runtime-settings.js';
import type {
  CancelMode,
  CancelModeDetail,
  TerminalCauseExternalCancel,
  TerminalCauseProviderFailure,
  TerminalCauseRuntimeVeto,
  TerminalCauseSuccess,
  TerminalCauseTimeout,
} from './terminal-cause.js';
import type { VetoPath } from './veto.js';

export interface AgentInstance {
  taskId: string;
  instanceId: string;
  createdAt: string;
  runtimeSettings: RuntimeSettingsBundle;
}

export interface RuntimeDriverResult {
  reason: string;
  provenance: string;
  artifactLocation?: string;
  observedSummary?: ObservedResourceSummary;
  /**
   * WU-V Phase 5 (closure): structured cause is the SOLE terminal-state
   * carrier on the driver contract. The legacy `outcome` field has been
   * retired; outcome derivation now happens exclusively at the
   * agent-runtime boundary via `deriveOutcomeFromCause` (see
   * `src/core/derive-outcome.ts` and the consumer at
   * `src/runtime/agent-runtime.ts`).
   *
   * Producers MUST populate `cause`. The cause kinds available to the
   * driver port are intentionally narrower than the full
   * `TerminalCause` union — `external-cancel` is preserved as a
   * Phase 4b deviation (driver-direct operator cancellation) until a
   * separate spec amendment revisits it.
   *
   * Mapping (consumed by `deriveOutcomeFromCause` at the boundary):
   *   cause.kind === 'success'          ⇒ outcome 'success'
   *   cause.kind === 'provider-failure' ⇒ outcome 'failure'
   *   cause.kind === 'timeout'          ⇒ outcome 'timeout'
   *   cause.kind === 'runtime-veto'     ⇒ outcome 'abort' (lifted at boundary)
   *   cause.kind === 'external-cancel'  ⇒ outcome 'abort' (lifted at boundary)
   *
   * @see specs/wu-v-terminal-cause-tightening.md §3 Phase 5, §4 mapping
   */
  cause:
    | TerminalCauseSuccess
    | TerminalCauseProviderFailure
    | TerminalCauseTimeout
    | TerminalCauseRuntimeVeto
    | TerminalCauseExternalCancel;
}

export interface RuntimeExecutionContext {
  plan: DispatchPlan;
  instance: AgentInstance;
  emit(
    event: RuntimeEventInput & Partial<Pick<RuntimeEvent, 'timestamp'>>,
  ): Promise<void>;
  requestApproval(input: {
    request: RuntimeApprovalRequest;
    deadline?: string;
  }): Promise<ApprovalDecision>;
  isAborted(): boolean;
}

export interface RuntimeDriver {
  run(context: RuntimeExecutionContext): Promise<RuntimeDriverResult>;
}

export interface RuntimeCancellationReceipt {
  taskId: string;
  reason: string;
  provenance: string;
  requestedAt: string;
}

export interface RuntimeCancellationBoundary {
  cancel(veto: VetoPath): RuntimeCancellationReceipt;
  latchRuntimeVeto?(veto: VetoPath): RuntimeTerminalCause;
  currentTerminalCause?(): RuntimeTerminalCause | undefined;
  whenTerminalCause?(): Promise<RuntimeTerminalCause>;
  closeExternalCancellation?(): void;
}

export interface RuntimeExternalCancellationCause
  extends RuntimeCancellationReceipt {
  kind: 'external-cancel';
  /** WU-K metadata (optional; pass-through to TerminalCause). */
  cancelMode?: CancelMode;
  /** WU-K structured cancel-origin detail (optional; pass-through). */
  cancelDetail?: CancelModeDetail;
}

export interface RuntimeVetoTerminalCause {
  kind: 'runtime-veto';
  taskId: string;
  reason: string;
  provenance: string;
  requestedAt: string;
  veto: VetoPath;
  cancellation?: RuntimeCancellationReceipt & {
    /** WU-K metadata (optional; pass-through to TerminalCause). */
    cancelMode?: CancelMode;
    /** WU-K structured cancel-origin detail (optional; pass-through). */
    cancelDetail?: CancelModeDetail;
  };
}

export type RuntimeTerminalCause =
  | RuntimeExternalCancellationCause
  | RuntimeVetoTerminalCause;
