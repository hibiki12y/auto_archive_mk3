import type { RuntimeDriver } from './runtime-driver.js';
import type { TerminalEvidence } from './terminal-evidence.js';
import type { TraitModuleId, TraitModuleManifest } from './trait-module.js';

/**
 * TraitModule runtime hook contracts.
 *
 * TraitModule runtime code has two deliberately separate shapes:
 *
 * - `module-entrypoint`: a bounded one-shot hook that returns structured
 *   evidence about its own invocation.
 * - `evidence-decorator`: a runtime-driver decorator that may append
 *   observable evidence but must not switch providers or rewrite terminal
 *   causes.
 *
 * Tier-1 lifecycle hooks (M5a) add three new hook types that the
 * AgentRuntime calls at well-defined dispatch boundaries. See
 * TRAIT_RUNTIME_HOOK_ALLOWLIST in src/core/trait-module-loader.ts.
 */

export interface TraitRuntimeEntrypointContext {
  readonly moduleId: TraitModuleId;
  readonly moduleVersion: string;
  readonly scheduleId?: string;
  readonly input?: unknown;
}

export interface TraitRuntimeHookResult {
  readonly status: 'ok' | 'skipped' | 'failed';
  readonly summary: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
}

export type TraitRuntimeHookEntrypoint = (
  context: TraitRuntimeEntrypointContext,
) => TraitRuntimeHookResult | Promise<TraitRuntimeHookResult>;

export interface TraitRuntimeDecoratorContext {
  readonly manifest: TraitModuleManifest;
  readonly requested: boolean;
  readonly input?: unknown;
}

export type TraitRuntimeDriverDecorator = (
  delegate: RuntimeDriver,
  context: TraitRuntimeDecoratorContext,
) => RuntimeDriver;

export type TraitRuntimeModuleImporter = (
  specifier: string,
) => Promise<Readonly<Record<string, unknown>>>;

// ---------------------------------------------------------------------------
// M5a Tier-1 lifecycle hooks
// ---------------------------------------------------------------------------

/**
 * Context passed to all three tier-1 lifecycle hooks. All fields are
 * readonly — hooks must not attempt to mutate this object.
 */
export interface TraitDispatchHookContext {
  readonly taskId: string;
  readonly runtimeInstanceId: string;
  readonly moduleId: TraitModuleId;
  readonly moduleVersion: string;
  readonly observedAt: string;
}

/**
 * Optional return value from `beforeDispatch`. The `kind` discriminant is
 * `'annotation-only'` to make it structurally impossible for a hook to claim
 * a broader modification surface. Any field outside this shape must be
 * ignored by the runtime.
 */
export interface TraitDispatchModification {
  readonly kind: 'annotation-only';
  readonly note: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
}

/**
 * Optional return value from `onTerminalEvidence`. Provides a separate
 * annotation channel so traits can attach observation evidence without
 * mutating the canonical TerminalEvidence.
 */
export interface TraitEvidenceAnnotation {
  readonly note: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
}

/**
 * Called after `observeSystemPrompt` and before runtime-decorator composition.
 * Return `null` (or `Promise<null>`) if no annotation is needed.
 * MUST NOT rewrite plan.taskId, plan.instruction, terminal cause, runtime
 * provider, or any kernel-authority field.
 */
export type TraitBeforeDispatchHook = (
  context: TraitDispatchHookContext,
) => TraitDispatchModification | null | Promise<TraitDispatchModification | null>;

/**
 * Called immediately after TerminalEvidence is finalized. Strictly
 * observe-only — return type void. Throwing or returning is a no-op for the
 * runtime (errors are contained via console.warn).
 */
export type TraitAfterDispatchHook = (
  context: TraitDispatchHookContext,
  evidence: TerminalEvidence,
) => void | Promise<void>;

/**
 * Called after `afterDispatch` returns. Provides a separate annotation
 * channel so traits can attach observation evidence per dispatch without
 * mutating the canonical TerminalEvidence. Return value goes into the
 * evidence-annotation log per task.
 */
export type TraitOnTerminalEvidenceHook = (
  context: TraitDispatchHookContext,
  evidence: TerminalEvidence,
) => TraitEvidenceAnnotation | null | Promise<TraitEvidenceAnnotation | null>;

// ---------------------------------------------------------------------------
// M5b Tier-2 mid-cycle hooks
// ---------------------------------------------------------------------------

/**
 * Common context passed to every tier-2 mid-cycle hook. Each hook also
 * receives a payload specific to its trigger.
 */
export interface TraitMidCycleHookContext {
  readonly moduleId: TraitModuleId;
  readonly moduleVersion: string;
  readonly observedAt: string;
}

export interface TraitSubagentSpawnPayload {
  readonly parentTaskId: string;
  readonly parentInstanceId: string;
  readonly subagentId: string;
  readonly role: string;
}

export interface TraitSubagentTerminalPayload {
  readonly parentTaskId: string;
  readonly parentInstanceId: string;
  readonly subagentId: string;
  readonly state: string;
  readonly reason?: string;
}

export interface TraitSkillAdmitPayload {
  readonly taskId: string;
  readonly traitModuleId: TraitModuleId;
  readonly admissionStatus: 'admitted' | 'curator-pruned';
  readonly curatorDecisionKind?: 'keep' | 'consolidate' | 'prune';
  readonly curatorReason?: string;
}

export interface TraitSkillBumpUsePayload {
  readonly taskId: string;
  readonly bumpedTraitModuleId: TraitModuleId;
}

export interface TraitCommandInterceptPayload {
  readonly commandName: string;
  readonly userId: string;
  readonly channelId?: string;
  readonly source?: 'slash-command' | 'natural-language' | 'slash-text';
}

export interface TraitCommandInterceptVeto {
  readonly status: 'denied';
  readonly reason: string;
}

/**
 * Called after a subagent enters the spawning state and a descriptor is
 * created. Strictly observe-only.
 */
export type TraitSubagentSpawnHook = (
  context: TraitMidCycleHookContext,
  payload: TraitSubagentSpawnPayload,
) => void | Promise<void>;

/**
 * Called when a subagent reaches a terminal state (terminated/failed).
 * Strictly observe-only.
 */
export type TraitSubagentTerminalHook = (
  context: TraitMidCycleHookContext,
  payload: TraitSubagentTerminalPayload,
) => void | Promise<void>;

/**
 * Called after a methodology trait module is admitted (and after the
 * curator has been consulted). Replaces the M2 console.warn channel.
 * Strictly observe-only.
 */
export type TraitSkillAdmitHook = (
  context: TraitMidCycleHookContext,
  payload: TraitSkillAdmitPayload,
) => void | Promise<void>;

/**
 * Called when a trait module's runtime decorator is composed into a
 * dispatch (i.e., the trait is "used"). The Hermes analog is `bump_use`
 * on `.usage.json`; auto_archive_mk3 surfaces this as an event hook for
 * consumers (curator rubrics, telemetry sidecars) to subscribe to.
 * Strictly observe-only.
 */
export type TraitSkillBumpUseHook = (
  context: TraitMidCycleHookContext,
  payload: TraitSkillBumpUsePayload,
) => void | Promise<void>;

/**
 * Called immediately before a Discord command is dispatched. Returning
 * `null` admits the command; returning a `TraitCommandInterceptVeto`
 * denies it (the runtime emits an access-denied response and aborts
 * dispatch). Hooks that throw are contained: they do not block dispatch.
 */
export type TraitCommandInterceptHook = (
  context: TraitMidCycleHookContext,
  payload: TraitCommandInterceptPayload,
) =>
  | null
  | TraitCommandInterceptVeto
  | Promise<null | TraitCommandInterceptVeto>;

// ---------------------------------------------------------------------------
// M5c Tier-3 observe-only hooks (smallest blast radius)
// ---------------------------------------------------------------------------

/**
 * Common context for all tier-3 observe-only hooks. The trait module is
 * told it must NOT mutate any field it receives; all return types are
 * `void` to enforce this at the type level.
 */
export interface TraitObserveHookContext {
  readonly moduleId: TraitModuleId;
  readonly moduleVersion: string;
  readonly observedAt: string;
}

export interface TraitProviderSelectPayload {
  readonly provider: 'codex' | 'claude-agent' | (string & {});
  readonly resolvedAt: string;
  readonly source: 'eager' | 'lazy';
}

export interface TraitPromptCacheBreakpointPayload {
  readonly taskId: string;
  readonly promptHash: string;
  readonly turn: number;
}

export interface TraitLedgerAppendPayload {
  readonly eventId: string;
  readonly eventType: string;
  readonly taskId?: string;
}

export interface TraitInsightsSnapshotPayload {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly totalTasks: number;
  readonly successRate: number;
}

export interface TraitDoctorProbePayload {
  readonly probeName: string;
  readonly status: 'ok' | 'warn' | 'fail' | 'unknown';
  readonly detail?: string;
}

/** Fires when the runtime-driver factory resolves an SDK provider. */
export type TraitProviderSelectObserveHook = (
  context: TraitObserveHookContext,
  payload: TraitProviderSelectPayload,
) => void | Promise<void>;

/** Fires whenever the M3 prompt-cache invariant freezes a system prompt. */
export type TraitPromptCacheBreakpointObserveHook = (
  context: TraitObserveHookContext,
  payload: TraitPromptCacheBreakpointPayload,
) => void | Promise<void>;

/** Fires after a successful append to the control-plane ledger. */
export type TraitLedgerAppendObserveHook = (
  context: TraitObserveHookContext,
  payload: TraitLedgerAppendPayload,
) => void | Promise<void>;

/** Fires when InsightsEngine.snapshot() returns a snapshot. */
export type TraitInsightsSnapshotObserveHook = (
  context: TraitObserveHookContext,
  payload: TraitInsightsSnapshotPayload,
) => void | Promise<void>;

/** Fires for each Doctor probe result during a /doctor invocation. */
export type TraitDoctorProbeObserveHook = (
  context: TraitObserveHookContext,
  payload: TraitDoctorProbePayload,
) => void | Promise<void>;
