import type {
  LifecycleAuthorityAuditEntry,
  LifecycleAuthorityAuditSink,
  LifecycleObserverDescriptor,
  LifecycleObserverInput,
  LifecyclePhaseObservation,
} from '../contracts/dispatch-lifecycle.js';
import { cloneExecutionCheckpoint } from '../contracts/execution-checkpoint.js';
import type { ObservedResourceSummary } from '../contracts/resource-envelope.js';
import {
  type ApprovalDecision,
  type ApprovalHookDecision,
  type ApprovalRequestedEvent,
  canonicalizeObservedSummary,
  createRuntimeEvent,
  type RuntimeEvent,
} from '../contracts/runtime-event.js';
import { createRuntimeEventStream } from '../contracts/runtime-event-stream.js';
import type { RuntimeSettingsBundle } from '../contracts/runtime-settings.js';
import {
  type AgentInstance,
  type RuntimeCancellationBoundary,
  type RuntimeCancellationReceipt,
  type RuntimeDriver,
  type RuntimeDriverResult,
  type RuntimeExecutionContext,
  type RuntimeExternalCancellationCause,
  type RuntimeTerminalCause,
} from '../contracts/runtime-driver.js';
import type {
  TraitAfterDispatchHook,
  TraitBeforeDispatchHook,
  TraitDispatchHookContext,
  TraitEvidenceAnnotation,
  TraitOnTerminalEvidenceHook,
  TraitRuntimeDecoratorContext,
  TraitRuntimeDriverDecorator,
} from '../contracts/trait-runtime-hook.js';
import type { TraitModuleId } from '../contracts/trait-module.js';
import type {
  TerminalCauseDriverFailure,
  TerminalCauseProviderFailure,
  TerminalCauseTimeout,
} from '../contracts/terminal-cause.js';
import type { AgentRuntimePort } from '../contracts/agent-runtime-port.js';
import {
  createTerminalEvidence,
  type RuntimeWarningEvidence,
  type SettingsReviewSnapshot,
  type TerminalEvidence,
  type TerminalEvidenceTranscript,
  type TerminalExecutionContextSnapshot,
} from '../contracts/terminal-evidence.js';
import { createVetoPath, type VetoPath } from '../contracts/veto.js';
import { createTerminalEvidenceFromTerminalCause } from '../core/terminal-cause-evidence.js';
import type { Plana } from '../core/plana.js';
import type {
  ApprovalResponsePort,
  PlanaStreamTerminalReport,
} from '../core/plana.js';
import type { ReviewDecision } from '../core/plana.js';
import { createDispatchPlan, type DispatchPlan } from '../core/task.js';
import {
  CodexRuntimeDriver,
  extractCodexProviderFailureCause,
  extractDriverAdapterFailureCause,
} from './codex-runtime-adapter.js';
import type { PromptCacheInvariantPort } from './prompt-cache-invariant.js';
import type { SubagentPolicyEnforcer } from './subagent-policy-enforcer.js';
import {
  createSubagentRoster,
  type SubagentRoster,
} from './subagent-roster.js';
import type { SubagentRosterRegistry } from './subagent-roster-registry.js';
import type { RosterEvent } from '../contracts/subagent-roster-event.js';
import type { TerminalCause } from '../contracts/terminal-cause.js';

/**
 * P4 Stage 4-3 — optional sink that receives every roster lifecycle event
 * (`subagent.spawned`, `subagent.completed`, `subagent.aborted`,
 * `subagent.failed`, `roster.progress`) when the per-dispatch
 * `SubagentRoster` is wired (i.e. when `subagentPolicyEnforcer` is also
 * supplied). Sinks are observation-only: throws are caught and counted
 * via `subagentEvidenceObserverErrorCount()`, never propagated outward.
 *
 * Sinks remain decoupled from any concrete ledger class — composition
 * roots can wire `JsonlSubagentOperatorEvidenceLedger.append(...)` (or
 * an in-memory analog for tests) into a thin lambda without dragging
 * the ledger into the runtime contract.
 */
export type SubagentEvidenceLedgerSink = (event: RosterEvent) => void;

type RuntimeExecutionTerminalResolution =
  | { kind: 'boundary'; cause: RuntimeTerminalCause }
  | { kind: 'driver-result'; result: RuntimeDriverResult }
  | { kind: 'driver-error'; error: unknown }
  | { kind: 'timeout'; deadlineMs: number; firedAt: string };

export const AGENT_RUNTIME_TERMINAL_TRANSCRIPT_EVENT_LIMIT = 64;
const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;

export interface AgentRuntimeTraitRuntimeDecoratorBinding {
  readonly decorator: TraitRuntimeDriverDecorator;
  readonly context: TraitRuntimeDecoratorContext;
}

export interface AgentRuntimeTraitRuntimeDecoratorResolverInput {
  readonly plan: DispatchPlan;
  readonly instance: AgentInstance;
  readonly plana: Plana;
}

export type AgentRuntimeTraitRuntimeDecoratorResolver = (
  input: AgentRuntimeTraitRuntimeDecoratorResolverInput,
) =>
  | readonly AgentRuntimeTraitRuntimeDecoratorBinding[]
  | Promise<readonly AgentRuntimeTraitRuntimeDecoratorBinding[]>;

export type AgentRuntimeTraitRuntimeDecoratorFailurePhase =
  | 'trait runtime decorator admission'
  | 'trait runtime decorator loading'
  | 'trait runtime decorator composition';

export class AgentRuntimeTraitRuntimeDecoratorError extends Error {
  readonly traitRuntimeDecoratorPhase: AgentRuntimeTraitRuntimeDecoratorFailurePhase;

  constructor(
    phase: AgentRuntimeTraitRuntimeDecoratorFailurePhase,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'AgentRuntimeTraitRuntimeDecoratorError';
    this.traitRuntimeDecoratorPhase = phase;
    Object.setPrototypeOf(this, AgentRuntimeTraitRuntimeDecoratorError.prototype);
  }
}

/**
 * M5a — per-module lifecycle hook registration entry.
 *
 * Hooks are invoked in manifest-declaration order (the order they appear in
 * this array) at the three tier-1 dispatch boundaries. All hooks are
 * error-contained: a throwing hook logs console.warn and execution continues.
 */
export interface AgentRuntimeTraitLifecycleHookBinding {
  readonly moduleId: TraitModuleId;
  readonly moduleVersion: string;
  readonly beforeDispatch?: TraitBeforeDispatchHook;
  readonly afterDispatch?: TraitAfterDispatchHook;
  readonly onTerminalEvidence?: TraitOnTerminalEvidenceHook;
}

export interface AgentRuntimeOptions {
  /**
   * Optional TraitModule runtime decorators admitted by the caller.
   *
   * The AgentRuntime never discovers or auto-enables TraitModules on its own:
   * admission, manifest loading, and policy decisions stay outside the
   * microkernel. At dispatch time the runtime composes this pre-admitted list
   * around the base driver so evidence-decorator modules can observe the run
   * without changing provider authority or terminal-cause semantics.
   */
  readonly traitRuntimeDecorators?: readonly AgentRuntimeTraitRuntimeDecoratorBinding[];
  /**
   * Optional per-dispatch resolver for composition roots that need plan-aware
   * admission (for example, Plana TraitModule evaluation) before handing a
   * pre-admitted decorator list to the runtime. The AgentRuntime invokes the
   * resolver inside execute(); it still does not discover TraitModules or make
   * admission decisions on its own.
   */
  readonly traitRuntimeDecoratorResolver?: AgentRuntimeTraitRuntimeDecoratorResolver;
  /**
   * Optional prompt-cache invariant tracker (M3).
   *
   * When supplied, the runtime calls `observeSystemPrompt` with the plan's
   * instruction (the task-level directive that must not change mid-conversation
   * for a given taskId) and then `freezeSystemPrompt` just before the driver
   * starts. In `warn` mode (the default) violations are logged only; in
   * `enforce` mode they throw. In `off` mode the hook is a no-op. Omitting
   * this option disables the invariant entirely for this runtime instance.
   *
   * @see src/runtime/prompt-cache-invariant.ts
   */
  readonly promptCacheInvariant?: PromptCacheInvariantPort;
  /**
   * M5a — Optional tier-1 lifecycle hook registrations.
   *
   * Hooks are called in array order at three well-defined dispatch boundaries:
   * `beforeDispatch` (after observeSystemPrompt, before decorator composition),
   * `afterDispatch` (after TerminalEvidence is finalized), and
   * `onTerminalEvidence` (after afterDispatch, provides annotation channel).
   *
   * All hooks are error-contained: throwing hooks log console.warn and
   * execution continues. Hooks must not be used to rewrite task identity,
   * runtime provider, or terminal cause.
   */
  readonly traitLifecycleHooks?: ReadonlyArray<AgentRuntimeTraitLifecycleHookBinding>;
  /**
   * P4 Stage 4-1 — optional subagent policy enforcer.
   *
   * When supplied, every dispatch constructs a root-owned
   * `SubagentRoster` bound to that dispatch's identity and surfaces it
   * on the resulting `AgentInstance`. Stage 4-1 only establishes the
   * roster lifetime and accessor; production callers do not yet invoke
   * `roster.spawn(...)`. When omitted (the default), the runtime
   * remains backward-compatible and `instance.subagentRoster` stays
   * undefined.
   *
   * @see src/runtime/subagent-policy-enforcer.ts
   * @see src/runtime/subagent-roster.ts
   */
  readonly subagentPolicyEnforcer?: SubagentPolicyEnforcer;
  /**
   * P4 Stage 4-2 — optional registry that tracks every dispatch's
   * roster while the dispatch is in flight. When supplied, each
   * `execute(...)` call registers the dispatch-scoped roster
   * immediately after construction and unregisters it in the `finally`
   * block alongside `roster.terminateAll(...)`. The registry is the
   * bridge between the dispatch-scoped `SubagentRoster` and
   * service-scope consumers (Discord operator surface,
   * `/doctor` active-subagent panel). Backward-compatible: when
   * omitted, the runtime is a no-op against the registry.
   *
   * @see src/runtime/subagent-roster-registry.ts
   */
  readonly subagentRosterRegistry?: SubagentRosterRegistry;
  /**
   * P4 Stage 4-3 — optional roster lifecycle event sink.
   *
   * When supplied alongside `subagentPolicyEnforcer`, every dispatch
   * subscribes a fire-and-forget consumer to the roster event stream
   * the moment the roster is constructed and forwards each `RosterEvent`
   * to the sink. Sink errors never propagate; they are caught and
   * counted via `subagentEvidenceObserverErrorCount()` so tests and
   * doctor surfaces can detect a misbehaving sink without destabilizing
   * the runtime. When `subagentPolicyEnforcer` is undefined no roster
   * is constructed and the sink is never invoked.
   *
   * @see src/runtime/subagent-roster-event-stream.ts
   */
  readonly subagentEvidenceLedgerSink?: SubagentEvidenceLedgerSink;
}

export class UnknownApprovalRequestIdError extends Error {
  readonly code = 'unknown-approval-request-id';

  constructor(approvalRequestId: string) {
    super(`Unknown approvalRequestId: ${approvalRequestId}`);
    this.name = 'UnknownApprovalRequestIdError';
  }
}

export class DuplicateApprovalResponseError extends Error {
  readonly code = 'duplicate-approval-response';

  constructor(approvalRequestId: string) {
    super(`Duplicate approval response for requestId: ${approvalRequestId}`);
    this.name = 'DuplicateApprovalResponseError';
  }
}

export class LateApprovalResponseError extends Error {
  readonly code = 'late-approval-response';

  constructor(approvalRequestId: string) {
    super(`Late approval response for requestId: ${approvalRequestId}`);
    this.name = 'LateApprovalResponseError';
  }
}

interface PendingApprovalEntry {
  readonly approvalRequestId: string;
  readonly deadline: string;
  readonly settleDecision: (decision: ApprovalDecision) => void;
  settled:
    | { readonly state: 'pending' }
    | { readonly state: 'responded' }
    | { readonly state: 'timeout' };
  timeoutHandle: ReturnType<typeof setTimeout>;
}

function stringifyRuntimeFailureValue(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '<uninspectable thrown value>';
  }
}

function describeRuntimeFailure(error: unknown): string {
  try {
    if (error instanceof Error) {
      try {
        return typeof error.message === 'string'
          ? error.message
          : stringifyRuntimeFailureValue(error.message);
      } catch {
        return 'Error with unreadable message';
      }
    }
  } catch {
    // Fall through to the non-Error description path.
  }

  return `non-Error rejection: ${stringifyRuntimeFailureValue(error)}`;
}

function cloneRuntimeSettings(
  runtimeSettings: RuntimeSettingsBundle,
): RuntimeSettingsBundle {
  return {
    networkProfile: runtimeSettings.networkProfile,
    sandboxMode: runtimeSettings.sandboxMode,
    approvalPolicy: runtimeSettings.approvalPolicy,
    networkProjection: {
      ...runtimeSettings.networkProjection,
    },
    ...(runtimeSettings.workingDirectory === undefined
      ? {}
      : { workingDirectory: runtimeSettings.workingDirectory }),
    ...(runtimeSettings.deadlineMs === undefined
      ? {}
      : { deadlineMs: runtimeSettings.deadlineMs }),
  };
}

function cloneTranscriptEvent(event: RuntimeEvent): RuntimeEvent {
  return createRuntimeEvent(event);
}

function toApprovalDeadlineIso(
  explicitDeadline: string | undefined,
  defaultApprovalTimeoutMs: number,
): string {
  if (explicitDeadline !== undefined) {
    if (Number.isNaN(Date.parse(explicitDeadline))) {
      throw new TypeError('Approval request deadline must be a valid ISO 8601 string.');
    }
    return explicitDeadline;
  }

  return new Date(Date.now() + defaultApprovalTimeoutMs).toISOString();
}

/**
 * Build the authoritative `TerminalCause*` for an agent-runtime fail-closed.
 *
 * Resolution order — see specs/wu-w-driver-fail-closed-origination.md
 * §3 Phase 2/3 + §5 AC-W3/AC-W4/AC-W5:
 *
 *   1. PRIMARY (Phase 2) — driver-originated cause extracted from a
 *      `CodexDriverFailureError` throwable. The driver-adapter pre-built
 *      the cause with rich context (stack, requestContext, accurate phase)
 *      and we trust it verbatim, including its `'driver-adapter'`
 *      provenance and observedAt.
 *
 *   2. SECONDARY (Phase 2) — provider-failure cause extracted from a
 *      `CodexProviderFailureError` throwable (rate-limit / quota / SDK
 *      classification). Re-stamped with the agent-runtime endedAt and
 *      identity but with the provider-originated provenance preserved.
 *
 *   3. FALLBACK (Phase 3) — synthesis from the raw error. **Defense-in-
 *      depth ONLY**: this branch is intentionally retained forever to
 *      cover non-codex adapters that fail to originate a structured
 *      cause, but for the codex adapter it should be unreachable in
 *      practice. The synthesized cause carries the dedicated sentinel
 *      provenance `'agent-runtime-fail-closed-fallback'` so observers
 *      (Discord, validators, log consumers) can distinguish originated
 *      vs synthesized causes per AC-W4. A structured `console.warn`
 *      event `wu-w-fallback-synthesis` is emitted on entry to this
 *      branch (OQ-W2 v1 — counter metric deferred).
 *
 * Detection is duck-typed (NOT `instanceof`) to remain robust against
 * hostile throwables (Proxy traps, frozen primitives, etc.) — see
 * tests/dispatcher-core.runtime-events.spec.ts hostile-rejection case.
 */
function buildFailClosedCause(params: {
  taskId: string;
  runtimeInstanceId: string;
  endedAt: string;
  phase: string;
  error: unknown;
  reason: string;
}): TerminalCauseDriverFailure | TerminalCauseProviderFailure {
  const driverPartial = extractDriverAdapterFailureCause(params.error);
  if (driverPartial) {
    // Driver-originated cause already carries final identity + observedAt
    // (the driver populated them via buildDriverFailureFromError). Trust
    // verbatim; do NOT overwrite with the agent-runtime endedAt.
    return driverPartial;
  }
  const providerPartial = extractCodexProviderFailureCause(params.error);
  if (providerPartial) {
    const providerCause: TerminalCauseProviderFailure = {
      kind: 'provider-failure',
      taskId: params.taskId,
      runtimeInstanceId: params.runtimeInstanceId,
      observedAt: params.endedAt,
      provenance: providerPartial.provenance,
      provider: providerPartial.provider,
      classification: providerPartial.classification,
      retryable: providerPartial.retryable,
      message: providerPartial.message,
      ...(providerPartial.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: providerPartial.retryAfterMs }),
      ...(providerPartial.attemptsExhausted === undefined
        ? {}
        : { attemptsExhausted: providerPartial.attemptsExhausted }),
      ...(providerPartial.sdkErrorCode === undefined
        ? {}
        : { sdkErrorCode: providerPartial.sdkErrorCode }),
    };
    return providerCause;
  }
  // WU-W Phase 3 — FALLBACK synthesis branch (defense-in-depth only).
  // Emit a structured observability signal so downstream log consumers
  // (Discord, validators) can filter / alert when the codex adapter or
  // any other adapter fails to originate a structured cause. OQ-W2 v1:
  // structured-log only; counter metric deferred.
  try {
     
    console.warn(
      `wu-w-fallback-synthesis ${JSON.stringify({
        event: 'wu-w-fallback-synthesis',
        taskId: params.taskId,
        runtimeInstanceId: params.runtimeInstanceId,
        errorMessage: describeRuntimeFailure(params.error),
        errorName:
          params.error instanceof Error ? params.error.name : 'non-error',
      })}`,
    );
  } catch {
    // Stringification failure is itself non-fatal — never let the
    // observability hook block the fail-closed path.
  }
  const driverCause: TerminalCauseDriverFailure = {
    kind: 'driver-failure',
    taskId: params.taskId,
    runtimeInstanceId: params.runtimeInstanceId,
    observedAt: params.endedAt,
    provenance: 'agent-runtime-fail-closed-fallback',
    phase: params.phase,
    message: params.reason,
  };
  return driverCause;
}

function createFailClosedEvidence(params: {
  taskId: string;
  runtimeInstanceId: string;
  executionContext: TerminalExecutionContextSnapshot;
  resourceEnvelope: RuntimeExecutionContext['plan']['resourceEnvelope'];
  observedSummary?: ObservedResourceSummary;
  transcript?: TerminalEvidenceTranscript;
  runtimeWarnings?: RuntimeWarningEvidence[];
  startedAt: string;
  endedAt: string;
  artifactLocation?: string;
  phase: string;
  error: unknown;
}): TerminalEvidence {
  const reason = `agent runtime fail-closed during ${params.phase}: ${describeRuntimeFailure(params.error)}`;
  const cause = buildFailClosedCause({
    taskId: params.taskId,
    runtimeInstanceId: params.runtimeInstanceId,
    endedAt: params.endedAt,
    phase: params.phase,
    error: params.error,
    reason,
  });
  const evidenceInput = {
    taskId: params.taskId,
    runtimeInstanceId: params.runtimeInstanceId,
    reason,
    provenance: 'agent-runtime-fail-closed',
    executionContext: params.executionContext,
    resourceEnvelope: params.resourceEnvelope,
    observedSummary: params.observedSummary,
    transcript: params.transcript,
    runtimeWarnings: params.runtimeWarnings,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    artifactLocation: params.artifactLocation,
    cause,
  };

  try {
    return createTerminalEvidence(evidenceInput);
  } catch {
    return {
      ...evidenceInput,
      executionContext: {
        planCreatedAt: params.executionContext.planCreatedAt,
        runtimeSettings: cloneRuntimeSettings(params.executionContext.runtimeSettings),
        ...(params.executionContext.executionCheckpoint === undefined
          ? {}
          : {
              executionCheckpoint: cloneExecutionCheckpoint(
                params.executionContext.executionCheckpoint,
              ),
            }),
      },
      resourceEnvelope: {
        requested: { ...params.resourceEnvelope.requested },
        effective: { ...params.resourceEnvelope.effective },
      },
      transcript: params.transcript,
      runtimeWarnings: params.runtimeWarnings,
    };
  }
}

function normalizeObserverInput(
  input:
    | LifecycleObserverInput
    | readonly LifecycleObserverInput[]
    | undefined,
): readonly LifecycleObserverDescriptor[] {
  if (input === undefined) {
    return [];
  }
  const arr: readonly LifecycleObserverInput[] =
    typeof input === 'function' || isLifecycleObserverDescriptor(input)
      ? [input]
      : input;
  const out: LifecycleObserverDescriptor[] = [];
  for (const entry of arr) {
    if (typeof entry === 'function') {
      // Bare function ⇒ ADVISORY by BC-1. No `authoritative` field is set.
      out.push({ id: 'anonymous-observer', notify: entry });
    } else if (isLifecycleObserverDescriptor(entry)) {
      // BC-6 / I-N2: snapshot the authority declaration at registration
      // time. We re-emit a fresh descriptor whose `authoritative` field is
      // the strict-equality coercion of the supplied value (only literal
      // `true` selects authoritative; any other value — including truthy
      // non-boolean values — collapses to advisory per BC-2). Because the
      // returned object is a copy, post-registration mutation of the
      // caller's descriptor cannot retroactively change authority.
      out.push({
        id: entry.id,
        notify: entry.notify,
        authoritative: entry.authoritative === true,
      });
    }
  }
  return out;
}

function isLifecycleObserverDescriptor(
  value: unknown,
): value is LifecycleObserverDescriptor {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { notify?: unknown }).notify === 'function'
  );
}

function isTraitRuntimeDecoratorFailurePhase(
  value: unknown,
): value is AgentRuntimeTraitRuntimeDecoratorFailurePhase {
  return (
    value === 'trait runtime decorator admission' ||
    value === 'trait runtime decorator loading' ||
    value === 'trait runtime decorator composition'
  );
}

function resolveTraitRuntimeDecoratorFailurePhase(
  error: unknown,
): AgentRuntimeTraitRuntimeDecoratorFailurePhase {
  if (typeof error === 'object' && error !== null) {
    const phase = (error as { traitRuntimeDecoratorPhase?: unknown })
      .traitRuntimeDecoratorPhase;
    if (isTraitRuntimeDecoratorFailurePhase(phase)) {
      return phase;
    }
  }
  return 'trait runtime decorator composition';
}

export function composeTraitRuntimeDriverDecorators(
  baseDriver: RuntimeDriver,
  bindings: readonly AgentRuntimeTraitRuntimeDecoratorBinding[],
): RuntimeDriver {
  // Declaration order is observable: the first binding is the outermost
  // decorator, so it sees run() before later bindings and completes after them.
  return bindings.reduceRight<RuntimeDriver>(
    (driver, binding) => binding.decorator(driver, binding.context),
    baseDriver,
  );
}

export class AgentRuntime implements AgentRuntimePort {
  private readonly driver: RuntimeDriver;
  private readonly traitRuntimeDecorators: readonly AgentRuntimeTraitRuntimeDecoratorBinding[];
  private readonly traitRuntimeDecoratorResolver:
    | AgentRuntimeTraitRuntimeDecoratorResolver
    | undefined;
  private readonly promptCacheInvariant: PromptCacheInvariantPort | undefined;
  private readonly traitLifecycleHooks: ReadonlyArray<AgentRuntimeTraitLifecycleHookBinding>;
  /**
   * P4 Stage 4-1 — optional admission gate for subagent spawn requests.
   * When undefined, the runtime does not construct a per-dispatch
   * `SubagentRoster` and `instance.subagentRoster` stays undefined
   * (backward-compatible default).
   */
  private readonly subagentPolicyEnforcer: SubagentPolicyEnforcer | undefined;
  /**
   * P4 Stage 4-2 — optional service-scope registry for dispatch-scoped
   * rosters. When undefined, the runtime never touches the registry
   * (fully backward-compatible). When defined, every dispatch
   * registers on roster construction and unregisters in `finally`.
   */
  private readonly subagentRosterRegistry: SubagentRosterRegistry | undefined;
  /**
   * P4 Stage 4-3 — optional sink wired to the dispatch-scoped roster
   * event stream. Stays undefined when omitted, in which case the
   * `for-await` consumer attached to the roster (if any) is a no-op.
   */
  private readonly subagentEvidenceLedgerSink:
    | SubagentEvidenceLedgerSink
    | undefined;
  /**
   * P4 Stage 4-3 — count of swallowed sink errors observed across every
   * dispatch on this runtime. Tests and doctor surfaces can read this
   * via `subagentEvidenceObserverErrorCount()` to detect a misbehaving
   * sink without destabilizing dispatch flow.
   */
  private subagentEvidenceObserverErrorCounter = 0;

  constructor(
    driver: RuntimeDriver = new CodexRuntimeDriver(),
    options: AgentRuntimeOptions = {},
  ) {
    this.driver = driver;
    this.traitRuntimeDecorators = [
      ...(options.traitRuntimeDecorators ?? []),
    ];
    this.traitRuntimeDecoratorResolver = options.traitRuntimeDecoratorResolver;
    this.promptCacheInvariant = options.promptCacheInvariant;
    this.traitLifecycleHooks = [...(options.traitLifecycleHooks ?? [])];
    this.subagentPolicyEnforcer = options.subagentPolicyEnforcer;
    this.subagentRosterRegistry = options.subagentRosterRegistry;
    this.subagentEvidenceLedgerSink = options.subagentEvidenceLedgerSink;
  }

  /**
   * P4 Stage 4-3 — read the cumulative number of sink errors swallowed
   * across every dispatch on this runtime instance. The counter is
   * never reset; tests typically take a snapshot before exercising the
   * sink and compare deltas. When no sink is wired the counter stays
   * at 0 indefinitely.
   */
  subagentEvidenceObserverErrorCount(): number {
    return this.subagentEvidenceObserverErrorCounter;
  }

  /**
   * P4 Stage 4-3 — attach a fire-and-forget consumer to the roster's
   * event stream and forward every event to the configured sink.
   *
   * The roster's `events` is an `AsyncIterable` whose underlying
   * stream is open until either the iterator's `return()` is called
   * or the stream's owner closes it. Since the roster never auto-
   * closes on `terminateAll`, we hold the iterator handle here so the
   * dispatch's `finally` block can call `iterator.return()` and
   * unblock the loop.
   *
   * Sink errors are caught per-event and counted via the shared
   * `subagentEvidenceObserverErrorCounter` so tests and doctor
   * surfaces can detect a misbehaving sink without destabilizing
   * dispatch flow. The consumer never throws outward and never
   * cancels the iterator on its own — only the dispatch lifecycle
   * controls iterator lifetime.
   */
  private attachSubagentRosterEventConsumer(roster: SubagentRoster): {
    readonly iterator: AsyncIterator<RosterEvent, undefined, undefined>;
    readonly settled: Promise<void>;
  } {
    const sink = this.subagentEvidenceLedgerSink;
    const iterator = roster.events[Symbol.asyncIterator]() as AsyncIterator<
      RosterEvent,
      undefined,
      undefined
    >;
    const settled = (async (): Promise<void> => {
      try {
        for (;;) {
          const result = await iterator.next();
          if (result.done === true) {
            return;
          }
          if (sink === undefined) {
            continue;
          }
          try {
            sink(result.value);
          } catch {
            this.subagentEvidenceObserverErrorCounter += 1;
          }
        }
      } catch {
        // The iterator only rejects when its owner tears down via
        // `throw()` — defensive fall-through; treat as termination.
      }
    })();
    // Detach unhandled-rejection liability defensively. The IIFE above
    // already swallows every internal throw, but a future refactor of
    // the iterator could surface a rejection before we await `settled`
    // in the `finally` block.
    settled.catch(() => undefined);
    return { iterator, settled };
  }

  async execute(
    plan: DispatchPlan,
    plana: Plana,
    cancellationBoundary: RuntimeCancellationBoundary,
    observer?: LifecycleObserverInput | readonly LifecycleObserverInput[],
    authorityAudit?: LifecycleAuthorityAuditSink,
  ): Promise<TerminalEvidence> {
    /**
     * WU-N observer fan-out. Bare-function observers normalize to advisory
     * descriptors per BC-1; descriptor authority is frozen at execute()
     * entry per BC-6 (no mid-flight promotion).
     */
    const observerDescriptors: readonly LifecycleObserverDescriptor[] =
      normalizeObserverInput(observer);

    // M3 — Prompt-cache invariant: record the task-level instruction (our
    // analog of Hermes's "system prompt") so a subsequent execute() with the
    // same taskId but a different instruction is flagged as a violation.
    this.promptCacheInvariant?.observeSystemPrompt(
      plan.taskId,
      0,
      plan.instruction,
    );

    // The dispatch identity (`startedAt`, `runtimeInstanceId`) is materialized
    // once here so every tier-1 lifecycle hook context, the AgentInstance
    // built downstream, and the lifecycle observer fan-out all carry the
    // same id for a single execute() call. Constructing the id inline at
    // each site lets independent `Date.now()` calls drift by the time it
    // takes JS to execute the intervening statements, which surfaces as a
    // beforeDispatch-vs-afterDispatch instanceId mismatch (BC: agent-node
    // audit 2026-05-03 / F3).
    const startedAt = new Date().toISOString();
    const runtimeInstanceId = `agent-${plan.taskId}-${startedAt}`;

    // M5a — Tier-1 lifecycle hooks: invoke beforeDispatch in declaration order.
    // Hooks are observation-only (annotation results are emitted as warnings
    // when supplied; they cannot rewrite the plan). Throws are contained.
    const traitHookContext: TraitDispatchHookContext = {
      taskId: plan.taskId,
      runtimeInstanceId,
      moduleId: '__pending__' as TraitModuleId,
      moduleVersion: '__pending__',
      observedAt: startedAt,
    };
    for (const binding of this.traitLifecycleHooks) {
      const beforeDispatch = binding.beforeDispatch;
      if (beforeDispatch === undefined) continue;
      try {
        const perBindingContext: TraitDispatchHookContext = {
          ...traitHookContext,
          moduleId: binding.moduleId,
          moduleVersion: binding.moduleVersion,
        };
        const result = await beforeDispatch(perBindingContext);
        if (result !== null && result !== undefined) {
          console.warn(
            'trait-runtime-hook-beforeDispatch-annotation',
            JSON.stringify({
              moduleId: binding.moduleId,
              moduleVersion: binding.moduleVersion,
              taskId: plan.taskId,
              note: result.note,
            }),
          );
        }
      } catch (error) {
        console.warn(
          'trait-runtime-hook-threw',
          JSON.stringify({
            hook: 'beforeDispatch',
            moduleId: binding.moduleId,
            moduleVersion: binding.moduleVersion,
            taskId: plan.taskId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    /**
     * First-wins latch for authoritative observer throws (BC-4 / I-N5).
     * The id of the first authoritative observer that successfully latched
     * a runtime-veto cause is recorded; subsequent authoritative throws
     * within the same execute() are still audit-logged but do NOT reopen
     * the latch.
     */
    let authoritativeWinnerId: string | undefined;

    /**
     * Forward-reference to the runtime-veto latch (defined further down
     * once `terminalResolution` plumbing exists). Authoritative throws
     * that arrive before the helper is installed (e.g., at the very first
     * `runtime-entering` notification) stash their resulting `VetoPath`
     * here and the runtime applies it once the helper is ready. The
     * BC-3 documented-surface invariant holds — every observer-originated
     * veto still routes through `latchRuntimeVetoCause`.
     */
    let observerLatchHook: ((veto: VetoPath) => void) | undefined = undefined;
    let pendingObserverVeto: VetoPath | undefined;

    const recordAudit = (entry: LifecycleAuthorityAuditEntry): void => {
      if (!authorityAudit) {
        return;
      }
      try {
        authorityAudit(entry);
      } catch {
        // Audit sink is observation-only (BC-3): a throwing sink MUST NOT
        // affect dispatch state.
      }
    };

    const emitAdvisoryWarn = (
      observerId: string,
      observation: LifecyclePhaseObservation,
      error: unknown,
    ): void => {
      try {
        // Structured warn line. Replaces the prior silent-swallow comment
        // ("// Lifecycle observer errors are silently swallowed by
        // design.") — visibility loss is acceptable, silent loss is not.
         
        console.warn(
          `lifecycle.observer.advisory-throw ${JSON.stringify({
            observerId,
            phase: observation.phase,
            // taskId relayed verbatim per BC-5/BC-6 — never decomposed.
            taskId: observation.taskId,
            error: describeRuntimeFailure(error),
          })}`,
        );
      } catch {
        // Stringification failure is itself non-fatal.
      }
    };

    const safeNotifyLifecycle = (
      observation: LifecyclePhaseObservation,
    ): void => {
      if (observerDescriptors.length === 0) {
        return;
      }
      for (const descriptor of observerDescriptors) {
        const observerId = descriptor.id ?? 'anonymous-observer';
        const isAuthoritative = descriptor.authoritative === true;
        const recordedAt = new Date().toISOString();
        try {
          descriptor.notify(observation);
          recordAudit({
            phase: observation.phase,
            observerId,
            authority: isAuthoritative ? 'authoritative' : 'advisory',
            recordedAt,
            taskId: observation.taskId,
            outcome: 'notified',
          });
        } catch (error) {
          if (!isAuthoritative) {
            emitAdvisoryWarn(observerId, observation, error);
            recordAudit({
              phase: observation.phase,
              observerId,
              authority: 'advisory',
              recordedAt,
              taskId: observation.taskId,
              outcome: 'advisory-suppressed',
              error: describeRuntimeFailure(error),
            });
            continue;
          }

          // AUTHORITATIVE throw path. First-wins per BC-4 / I-N5.
          if (authoritativeWinnerId === undefined) {
            authoritativeWinnerId = observerId;
            const reason = `authoritative observer veto: ${describeRuntimeFailure(error)}`;
            const provenance = `observer-authority:${observerId}`;
            const observerVeto: VetoPath = createVetoPath(
              'runtime',
              reason,
              provenance,
            );
            // Documented authority surface (BC-3): route through the
            // runtime-veto latch (WU-J) which emits a WU-H `runtime-veto`
            // terminal cause. No side-channel mutation. If the latch is
            // not yet installed (very-early-phase throw), defer.
            if (observerLatchHook) {
              try {
                observerLatchHook(observerVeto);
              } catch {
                // Defensive — fail-closed path will still surface a
                // terminal driver-failure cause if latching breaks.
              }
            } else {
              pendingObserverVeto = observerVeto;
            }
            recordAudit({
              phase: observation.phase,
              observerId,
              authority: 'authoritative',
              recordedAt,
              taskId: observation.taskId,
              outcome: 'authority-committed',
              error: describeRuntimeFailure(error),
            });
          } else {
            recordAudit({
              phase: observation.phase,
              observerId,
              authority: 'authoritative',
              recordedAt,
              taskId: observation.taskId,
              outcome: 'authority-suppressed',
              error: describeRuntimeFailure(error),
            });
          }
        }
      }
    };

    /**
     * P4 Stage 4-1 — dispatch-scoped subagent roster construction.
     *
     * The roster is created exactly once per `execute(...)` call when the
     * service composition wired a `SubagentPolicyEnforcer` into the
     * runtime constructor. The roster's lifetime is bounded to this
     * dispatch (cleaned up in the `finally` block via
     * `roster.terminateAll(...)`). Stage 4-1 establishes the lifetime and
     * accessor; production callers do not yet invoke `roster.spawn(...)`
     * (deferred to Stage 4-4). When the enforcer is undefined, the
     * roster is skipped entirely and `instance.subagentRoster` stays
     * undefined for backward compatibility with every existing caller.
     */
    let subagentRoster: SubagentRoster | undefined;
    /**
     * P4 Stage 4-3 — `for-await` consumer iterator handle. Held so the
     * `finally` block can call `iterator.return()` and unblock the
     * background loop after dispatch terminates (the roster's event
     * stream does not auto-close on `terminateAll`).
     */
    let rosterEventConsumer:
      | {
          readonly iterator: AsyncIterator<RosterEvent, undefined, undefined>;
          readonly settled: Promise<void>;
        }
      | undefined;
    if (this.subagentPolicyEnforcer !== undefined) {
      /**
       * P4 Stage 4-4 — runChild wires the parent's RuntimeDriver as
       * the launch path for `roster.spawnAndRun(...)`. The closure is
       * captured here at roster-construction time but only invoked
       * lazily at child spawn time (well after the parent's emit /
       * approval / cancellation closures have been initialized below),
       * so referring to `currentTerminalCause` and `this.driver`
       * inside the closure is safe (and the reference site is a
       * closed-over name, not a TDZ access).
       *
       * Architectural note (RuntimeExecutionContext sharing):
       * The child gets a *fresh* RuntimeExecutionContext rather than
       * reusing the parent's. The parent's `emit` augments every
       * event with the parent's `instance.instanceId`, so reusing it
       * would mis-tag child runtime events with the parent identity
       * and corrupt evidence. For Stage 4-4 (capability only) the
       * child's emit is a no-op — child runtime events are dropped
       * on the floor — and `requestApproval` returns a synchronous
       * `denied` decision because Stage 4-4 has no operator-side
       * approval surface for children. Stage 4-6 (research-plan
       * migration) will design proper child evidence routing and
       * approval forwarding once a real production caller exists.
       *
       * `isAborted()` mirrors the parent's terminal-cause latch so
       * an in-flight child driver short-circuits when the parent
       * dispatch has already terminated (matches the existing
       * `parentTerminationSignal` cleanup path at the roster side).
       */
      const driver = this.driver;
      // P4 Stage 4-5 — runChild now returns a `RunChildHandle` (the
      // result promise plus a per-child cancel hook) rather than the
      // bare `Promise<RuntimeDriverResult>` of Stage 4-4. The body
      // does not itself `await` (the driver run is kicked off and its
      // promise threaded through `handle.result`), so this is a
      // non-async function that returns a Promise via the roster
      // callback contract — the roster's `spawnAndRun(...)` awaits
      // the outer promise then awaits `handle.result` separately.
      const runChild = (input: {
        readonly descriptor: import('../contracts/subagent-roster.js').SubagentDescriptor;
        readonly instruction: string;
        readonly parentContext: {
          readonly taskId: string;
          readonly instanceId: string;
        };
      }): Promise<import('./subagent-roster.js').RunChildHandle> => {
        const childTaskId = `${plan.taskId}.sub-${input.descriptor.subagentId}`;
        const childStartedAt = new Date().toISOString();
        const childInstanceId = `agent-${childTaskId}-${childStartedAt}`;
        const childPlan = createDispatchPlan({
          taskId: childTaskId,
          instruction: input.instruction,
          // The descriptor.envelope is the parent-narrowed snapshot
          // already validated by spawn(); we pass `requested` and
          // `effective` only because `createPlannedResourceEnvelope`
          // refuses observed (runtime-only evidence).
          resources: {
            requested: { ...input.descriptor.envelope.requested },
            effective: { ...input.descriptor.envelope.effective },
          },
          // The descriptor does not carry a runtime-settings override
          // for Stage 4-4; reuse the parent's narrowed bundle. Stage
          // 4-5/4-6 may carry a per-descriptor narrowed bundle if the
          // sandbox-override path becomes load-bearing for production
          // callers.
          runtimeSettings: { ...plan.runtimeSettings },
        });
        const childInstance: AgentInstance = {
          taskId: childTaskId,
          instanceId: childInstanceId,
          createdAt: childStartedAt,
          runtimeSettings: childPlan.runtimeSettings,
          // No subagentRoster on the child — depth cap = 1 is enforced
          // by SubagentPolicyEnforcer; Stage 4-4 explicitly does not
          // allow grandchildren. parentDepth is therefore 1 (this
          // child is one level below the root dispatch).
          parentDepth: 1,
        };
        // P4 Stage 4-5 — per-child AbortController fed into the
        // child's `isAborted()` lookup. When the operator surface
        // calls `roster.cancelActive(subagentId, reason)`, the
        // roster invokes the handle's `cancel(...)` (below) which
        // aborts this controller. The child's `isAborted()` ORs the
        // local controller with the parent's terminal-cause latch,
        // so:
        //   - parent abort → still aborts every child (Stage 4-4
        //     invariant preserved)
        //   - per-child cancel → only this child's `isAborted()`
        //     flips true; the parent dispatch continues normally
        const childAbortController = new AbortController();
        const childContext: RuntimeExecutionContext = {
          plan: childPlan,
          instance: childInstance,
          emit: () => {
            // Stage 4-4 capability-only: drop child runtime events.
            // Re-using the parent's emit would mis-tag child events
            // with the parent instanceId (see context note above);
            // building a separate child runtime-event stream is
            // deferred to Stage 4-6's research-plan migration.
            return Promise.resolve();
          },
          requestApproval: () =>
            Promise.resolve({
              status: 'rejected',
              reason:
                'subagent-approval-not-routed-stage-4-4: child approvals are not yet routed to the operator surface',
            }),
          isAborted: () =>
            currentTerminalCause() !== undefined ||
            childAbortController.signal.aborted,
        };
        const result = driver.run(childContext);
        return Promise.resolve({
          result,
          cancel: (_reason: string) => {
            // Best-effort: AbortController.abort() is idempotent so
            // repeated cancels (e.g. operator + parent abort race)
            // are safe. The child driver observes the flip on its
            // next `isAborted()` poll and surfaces a runtime-veto /
            // external-cancel cause through its normal terminal
            // path; the roster maps that to `subagent.aborted`.
            //
            // We intentionally do NOT call any
            // `RuntimeCancellationBoundary.cancel(...)` here: the
            // child's runtime drives its own cancellation receipts
            // through the driver-side observer, and the per-child
            // cancel signal IS the boundary for this Stage. The
            // boundary-direct path would be needed if/when child
            // dispatches gain their own boundaries (deferred to
            // Stage 4-6's research-plan migration).
            childAbortController.abort();
          },
        });
      };
      subagentRoster = createSubagentRoster({
        taskId: plan.taskId,
        instanceId: runtimeInstanceId,
        envelope: plan.resourceEnvelope,
        runtimeSettings: plan.runtimeSettings,
        spawnAuthority: 'root',
        parentDepth: 0,
        policyEnforcer: this.subagentPolicyEnforcer,
        runChild,
      });
      rosterEventConsumer = this.attachSubagentRosterEventConsumer(subagentRoster);

      // P4 Stage 4-2 — surface this dispatch's roster on the
      // service-scope registry (when wired) so the Discord operator
      // surface and `/doctor` active-subagent panel can enumerate
      // currently-active dispatches without holding a direct roster
      // reference. The matching `unregister` lives in the `finally`
      // block alongside `terminateAll`.
      this.subagentRosterRegistry?.register({
        taskId: plan.taskId,
        instanceId: runtimeInstanceId,
        roster: subagentRoster,
      });
    }

    const instance: AgentInstance = {
      taskId: plan.taskId,
      instanceId: runtimeInstanceId,
      createdAt: startedAt,
      runtimeSettings: plan.runtimeSettings,
      ...(subagentRoster === undefined
        ? {}
        : { subagentRoster, parentDepth: 0 }),
    };

    recordAudit({
      phase: 'runtime-entering',
      observerId: 'plana-runtime-review',
      authority: 'authoritative',
      recordedAt: new Date().toISOString(),
      taskId: plan.taskId,
      outcome: 'notified',
    });

    safeNotifyLifecycle({
      phase: 'runtime-entering',
      taskId: plan.taskId,
      observedAt: new Date().toISOString(),
      instanceId: instance.instanceId,
    });

    // M5a — Tier-1 lifecycle hooks: afterDispatch + onTerminalEvidence.
    // The hook chains are still .catch()-error-contained — a thrown hook
    // never escapes the runtime — but they are now drained inside the
    // execute() finally block before the call returns. The previous
    // fire-and-forget model let a slow or stuck hook from the prior
    // dispatch overlap the next execute() invocation on the same runtime
    // instance and gave callers no way to know when hooks had settled.
    // Tracking promises here closes both gaps without changing the
    // observation-only contract (audit 2026-05-03 / F1).
    const pendingTraitLifecycleHooks: Promise<void>[] = [];

    /**
     * P4 Stage 4-1 — captures the authoritative terminal cause exactly
     * once when this dispatch finalizes. The roster cleanup in `finally`
     * uses this to terminate any still-active subagents with the same
     * cause. Stage 4-1 production code never spawns subagents, so this
     * is defense-in-depth for stages 4-4+ — keeping the cleanup wired
     * here from day one prevents a future regression where the
     * lifetime gap is reintroduced.
     */
    let dispatchTerminalCause: TerminalCause | undefined;

    const finalizeEvidence = (
      build: () => TerminalEvidence,
    ): TerminalEvidence => {
      safeNotifyLifecycle({
        phase: 'settling',
        taskId: plan.taskId,
        observedAt: new Date().toISOString(),
        instanceId: instance.instanceId,
      });
      const evidence = build();
      if (dispatchTerminalCause === undefined) {
        dispatchTerminalCause = evidence.cause;
      }
      safeNotifyLifecycle({
        phase: 'terminal',
        taskId: plan.taskId,
        observedAt: new Date().toISOString(),
        instanceId: instance.instanceId,
        // WU-V Phase 6: structured `cause` is the SOLE terminal-state
        // field on lifecycle observations. Cause is required on
        // TerminalEvidence post-Phase-4b, so pass-through is unconditional.
        cause: evidence.cause,
      });

      for (const binding of this.traitLifecycleHooks) {
        const perBindingContext: TraitDispatchHookContext = {
          taskId: plan.taskId,
          runtimeInstanceId: instance.instanceId,
          moduleId: binding.moduleId,
          moduleVersion: binding.moduleVersion,
          observedAt: new Date().toISOString(),
        };
        const afterDispatch = binding.afterDispatch;
        if (afterDispatch !== undefined) {
          pendingTraitLifecycleHooks.push(
            Promise.resolve()
              .then(() => afterDispatch(perBindingContext, evidence))
              .catch((error: unknown) => {
                console.warn(
                  'trait-runtime-hook-threw',
                  JSON.stringify({
                    hook: 'afterDispatch',
                    moduleId: binding.moduleId,
                    moduleVersion: binding.moduleVersion,
                    taskId: plan.taskId,
                    error:
                      error instanceof Error ? error.message : String(error),
                  }),
                );
              }),
          );
        }
        const onTerminalEvidence = binding.onTerminalEvidence;
        if (onTerminalEvidence !== undefined) {
          pendingTraitLifecycleHooks.push(
            Promise.resolve()
              .then(() => onTerminalEvidence(perBindingContext, evidence))
              .then(
                (annotation: TraitEvidenceAnnotation | null | undefined) => {
                  if (annotation === null || annotation === undefined) return;
                  console.warn(
                    'trait-runtime-hook-onTerminalEvidence-annotation',
                    JSON.stringify({
                      moduleId: binding.moduleId,
                      moduleVersion: binding.moduleVersion,
                      taskId: plan.taskId,
                      note: annotation.note,
                    }),
                  );
                },
              )
              .catch((error: unknown) => {
                console.warn(
                  'trait-runtime-hook-threw',
                  JSON.stringify({
                    hook: 'onTerminalEvidence',
                    moduleId: binding.moduleId,
                    moduleVersion: binding.moduleVersion,
                    taskId: plan.taskId,
                    error:
                      error instanceof Error ? error.message : String(error),
                  }),
                );
              }),
          );
        }
      }
      return evidence;
    };
    const closeExternalCancellation = (): void => {
      cancellationBoundary.closeExternalCancellation?.();
    };

    let observedSummary = plan.resourceEnvelope.observed;
    let veto: VetoPath | undefined;
    let artifactLocation = plan.artifactLocation;
    let terminalResolution: RuntimeExecutionTerminalResolution | undefined;
    const transcriptEvents: RuntimeEvent[] = [];
    const runtimeWarnings: RuntimeWarningEvidence[] = [];
    let transcriptDroppedCount = 0;
    const runtimeEventStream = createRuntimeEventStream();
    const planaConsumerAbortController = new AbortController();
    const pendingApprovals = new Map<string, PendingApprovalEntry>();
    const respondedApprovalIds = new Set<string>();
    const timedOutApprovalIds = new Set<string>();
    let approvalRequestSequence = 0;
    let activeTurnSequence = 1;
    const executionStartedAt = instance.createdAt;
    let executionContext: TerminalExecutionContextSnapshot = {
      planCreatedAt: plan.createdAt,
      runtimeSettings: instance.runtimeSettings,
      executionStartedAt,
      ...(plan.executionCheckpoint === undefined
        ? {}
        : { executionCheckpoint: plan.executionCheckpoint }),
    };

    const latchTerminalResolution = (
      resolution: RuntimeExecutionTerminalResolution,
    ): RuntimeExecutionTerminalResolution => {
      if (!terminalResolution) {
        terminalResolution = resolution;
      }

      return terminalResolution;
    };

    const recordTranscriptEvent = (event: RuntimeEvent): void => {
      if (
        transcriptEvents.length === AGENT_RUNTIME_TERMINAL_TRANSCRIPT_EVENT_LIMIT
      ) {
        transcriptEvents.shift();
        transcriptDroppedCount += 1;
      }
      transcriptEvents.push(cloneTranscriptEvent(event));
    };

    const snapshotTranscript = (): TerminalEvidenceTranscript | undefined =>
      transcriptEvents.length === 0 && transcriptDroppedCount === 0
        ? undefined
        : {
            events: transcriptEvents.map((event) => cloneTranscriptEvent(event)),
            droppedCount: transcriptDroppedCount,
          };
    const snapshotRuntimeWarnings = (): RuntimeWarningEvidence[] | undefined =>
      runtimeWarnings.length === 0
        ? undefined
        : runtimeWarnings.map((warning) => ({ ...warning }));

    const currentTerminalCause = (): RuntimeTerminalCause | undefined => {
      if (
        terminalResolution?.kind === 'driver-result' ||
        terminalResolution?.kind === 'driver-error' ||
        terminalResolution?.kind === 'timeout'
      ) {
        return undefined;
      }

      const boundaryCause = cancellationBoundary.currentTerminalCause?.();
      if (boundaryCause) {
        const resolution = latchTerminalResolution({
          kind: 'boundary',
          cause: boundaryCause,
        });
        if (resolution.kind === 'boundary') {
          return resolution.cause;
        }
        return undefined;
      }

      return terminalResolution?.kind === 'boundary'
        ? terminalResolution.cause
        : undefined;
    };

    const matchesCancellationReceipt = (
      cause: RuntimeTerminalCause | undefined,
      cancellation: RuntimeCancellationReceipt | undefined,
    ): cause is RuntimeExternalCancellationCause =>
      cause?.kind === 'external-cancel' &&
      cancellation !== undefined &&
      cause.taskId === cancellation.taskId &&
      cause.reason === cancellation.reason &&
      cause.provenance === cancellation.provenance &&
      cause.requestedAt === cancellation.requestedAt;

    const latchRuntimeVetoCause = (
      runtimeVeto: VetoPath,
      cancellation?: RuntimeCancellationReceipt,
    ): RuntimeTerminalCause => {
      if (terminalResolution?.kind === 'boundary') {
        if (!matchesCancellationReceipt(terminalResolution.cause, cancellation)) {
          return terminalResolution.cause;
        }

        terminalResolution = undefined;
      }

      const boundaryCause = cancellationBoundary.currentTerminalCause?.();
      if (boundaryCause?.kind === 'runtime-veto') {
        const resolution = latchTerminalResolution({
          kind: 'boundary',
          cause: boundaryCause,
        });
        return resolution.kind === 'boundary' ? resolution.cause : boundaryCause;
      }
      if (
        boundaryCause?.kind === 'external-cancel' &&
        !matchesCancellationReceipt(boundaryCause, cancellation)
      ) {
        const resolution = latchTerminalResolution({
          kind: 'boundary',
          cause: boundaryCause,
        });
        return resolution.kind === 'boundary' ? resolution.cause : boundaryCause;
      }

      const boundaryRuntimeVeto = cancellationBoundary.latchRuntimeVeto?.(runtimeVeto);
      const latchedCause =
        boundaryRuntimeVeto?.kind === 'runtime-veto'
          ? {
              ...boundaryRuntimeVeto,
              cancellation: boundaryRuntimeVeto.cancellation ?? cancellation,
            }
          : {
              kind: 'runtime-veto' as const,
              taskId: plan.taskId,
              reason: runtimeVeto.reason,
              provenance: runtimeVeto.provenance,
              requestedAt: cancellation?.requestedAt ?? new Date().toISOString(),
              veto: runtimeVeto,
              cancellation,
            };

      const resolution = latchTerminalResolution({
        kind: 'boundary',
        cause: latchedCause,
      });
      return resolution.kind === 'boundary' ? resolution.cause : latchedCause;
    };

    // WU-N: install the forward-referenced observer→latch hook now that
    // `latchRuntimeVetoCause` exists. Drain any pending veto captured by
    // an authoritative observer that threw before the hook was installed.
    observerLatchHook = (veto: VetoPath): void => {
      latchRuntimeVetoCause(veto);
    };
    if (pendingObserverVeto !== undefined) {
      const veto = pendingObserverVeto;
      try {
        observerLatchHook(veto);
      } catch {
        // Same fail-closed posture as the inline catch above.
      }
    }

    const reviewedAt = new Date().toISOString();
    let settingsReviewResult: ReviewDecision;
    try {
      settingsReviewResult = plana.reviewRuntimeSettings({ plan, instance });
    } catch (error) {
      closeExternalCancellation();
      return finalizeEvidence(() =>
        createFailClosedEvidence({
          taskId: plan.taskId,
          runtimeInstanceId: instance.instanceId,
          executionContext,
          resourceEnvelope: plan.resourceEnvelope,
          observedSummary,
          runtimeWarnings: snapshotRuntimeWarnings(),
          startedAt,
          endedAt: new Date().toISOString(),
          artifactLocation,
          phase: 'runtime settings review',
          error,
        }),
      );
    }

    const settingsReviewSnapshot: SettingsReviewSnapshot =
      settingsReviewResult.status === 'vetoed'
        ? {
            status: 'vetoed',
            reviewedAt,
            provenance: settingsReviewResult.veto.provenance,
          }
        : { status: 'approved', reviewedAt };
    executionContext = {
      ...executionContext,
      settingsReview: settingsReviewSnapshot,
    };

    if (settingsReviewResult.status === 'vetoed') {
      try {
        veto = settingsReviewResult.veto;
        let cancellation: RuntimeCancellationReceipt | undefined;
        if (veto.propagation.requestsCancellation) {
          cancellation = cancellationBoundary.cancel(veto);
        }
        latchRuntimeVetoCause(veto, cancellation);
        const settingsTerminalCause = currentTerminalCause();
        if (settingsTerminalCause) {
          closeExternalCancellation();
          return finalizeEvidence(() =>
            createTerminalEvidenceFromTerminalCause({
              taskId: plan.taskId,
              runtimeInstanceId: instance.instanceId,
              terminalCause: settingsTerminalCause,
              executionContext,
              resourceEnvelope: plan.resourceEnvelope,
              observedSummary,
              transcript: snapshotTranscript(),
              runtimeWarnings: snapshotRuntimeWarnings(),
              startedAt,
              endedAt: new Date().toISOString(),
              artifactLocation,
            }),
          );
        }
      } catch (error) {
        closeExternalCancellation();
        return finalizeEvidence(() =>
          createFailClosedEvidence({
            taskId: plan.taskId,
            runtimeInstanceId: instance.instanceId,
            executionContext,
            resourceEnvelope: plan.resourceEnvelope,
            observedSummary,
            transcript: snapshotTranscript(),
            runtimeWarnings: snapshotRuntimeWarnings(),
            startedAt,
            endedAt: new Date().toISOString(),
            artifactLocation,
            phase: 'settings veto application',
            error,
          }),
        );
      }
    }

    const approvalResponsePort: ApprovalResponsePort = {
      // eslint-disable-next-line @typescript-eslint/require-await -- ApprovalResponsePort.respond contract requires Promise<void>; settlement is sync after PR #10.
      async respond(
        approvalRequestId: string,
        decision: ApprovalHookDecision,
        responseMeta?: {
          readonly respondedAt?: string;
          readonly provenance: 'plana-approval';
        },
      ): Promise<void> {
        const entry = pendingApprovals.get(approvalRequestId);
        if (!entry) {
          if (respondedApprovalIds.has(approvalRequestId)) {
            throw new DuplicateApprovalResponseError(approvalRequestId);
          }
          if (timedOutApprovalIds.has(approvalRequestId)) {
            throw new LateApprovalResponseError(approvalRequestId);
          }
          throw new UnknownApprovalRequestIdError(approvalRequestId);
        }
        if (entry.settled.state === 'responded') {
          throw new DuplicateApprovalResponseError(approvalRequestId);
        }
        if (entry.settled.state === 'timeout') {
          throw new LateApprovalResponseError(approvalRequestId);
        }
        entry.settled = { state: 'responded' };
        clearTimeout(entry.timeoutHandle);
        pendingApprovals.delete(approvalRequestId);
        respondedApprovalIds.add(approvalRequestId);
        timedOutApprovalIds.delete(approvalRequestId);

        // Audit 2026-05-03 / signature drift: prior implementation only
        // accepted (id, decision) and silently dropped the optional
        // `responseMeta` declared by `ApprovalResponsePort`. We now
        // honor the contract by surfacing a structured log line when
        // meta is supplied (currently provenance ∈ {'plana-approval'}),
        // preserving the audit trail without changing approval
        // settlement semantics.
        if (responseMeta !== undefined) {
          try {
            const respondedAt =
              responseMeta.respondedAt ?? new Date().toISOString();
            console.warn(
              `agent-runtime.approval-response ${JSON.stringify({
                event: 'agent-runtime.approval-response',
                approvalRequestId,
                provenance: responseMeta.provenance,
                respondedAt,
                decisionStatus: decision.status,
                instanceId: instance.instanceId,
                taskId: plan.taskId,
              })}`,
            );
          } catch {
            // Stringification must never break approval settlement.
          }
        }

        entry.settleDecision(decision);
      },
    };

    const clearPendingApprovals = (): void => {
      for (const entry of pendingApprovals.values()) {
        clearTimeout(entry.timeoutHandle);
      }
      pendingApprovals.clear();
      respondedApprovalIds.clear();
      timedOutApprovalIds.clear();
    };

    const makeApprovalRequestId = (): string => {
      approvalRequestSequence += 1;
      return `approval-${instance.instanceId}-${approvalRequestSequence}`;
    };

    const emit: RuntimeExecutionContext['emit'] = async (eventInput) => {
      const augmented = {
        ...(eventInput as Record<string, unknown>),
        instanceId: instance.instanceId,
      } as Parameters<typeof createRuntimeEvent>[0];
      if (
        (augmented as { kind?: unknown }).kind === 'runtime-initialized' &&
        plana.hasRuntimeSettingsHook() &&
        settingsReviewSnapshot.reviewedAt !== undefined
      ) {
        (augmented as { settingsReviewedAt?: string }).settingsReviewedAt =
          settingsReviewSnapshot.reviewedAt;
      }
      const event = createRuntimeEvent(augmented);
      if (event.observedSummary !== undefined) {
        observedSummary = event.observedSummary;
      }
      if (event.kind === 'turn.started') {
        activeTurnSequence = event.turnSequence;
      }
      recordTranscriptEvent(event);
      await runtimeEventStream.push(event);
    };

    const ctxDefaultApprovalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS;

    const requestApproval: RuntimeExecutionContext['requestApproval'] = async ({
      request,
      deadline,
    }) => {
      const approvalRequestId = makeApprovalRequestId();
      const timeoutMs = Math.max(
        1,
        ctxDefaultApprovalTimeoutMs,
      );
      const resolvedDeadline = toApprovalDeadlineIso(deadline, timeoutMs);
      const msUntilDeadline = Math.max(
        0,
        Date.parse(resolvedDeadline) - Date.now(),
      );

      let settleDecision!: (decision: ApprovalDecision) => void;
      const decisionPromise = new Promise<ApprovalDecision>((resolve) => {
        settleDecision = resolve;
      });

      const timeoutHandle = setTimeout(() => {
        const entry = pendingApprovals.get(approvalRequestId);
        if (!entry || entry.settled.state !== 'pending') {
          return;
        }
        entry.settled = { state: 'timeout' };
        pendingApprovals.delete(approvalRequestId);
        timedOutApprovalIds.add(approvalRequestId);
        entry.settleDecision({
          status: 'timeout',
          reason: 'deadline-elapsed',
          deadline: resolvedDeadline,
        });
      }, msUntilDeadline);

      pendingApprovals.set(approvalRequestId, {
        approvalRequestId,
        deadline: resolvedDeadline,
        settleDecision,
        settled: { state: 'pending' },
        timeoutHandle,
      });

      try {
        const approvalEvent: ApprovalRequestedEvent = {
          kind: 'approval.requested',
          timestamp: new Date().toISOString(),
          instanceId: instance.instanceId,
          turnSequence: activeTurnSequence,
          approvalRequestId,
          deadline: resolvedDeadline,
          request,
          provenance: {
            producer: 'codex-runtime-driver',
            sdkEventType: 'approval.requested',
            threadId: null,
          },
        };
        await emit(approvalEvent);
      } catch (error) {
        const entry = pendingApprovals.get(approvalRequestId);
        if (entry) {
          clearTimeout(entry.timeoutHandle);
          pendingApprovals.delete(approvalRequestId);
        }
        throw error;
      }

      return decisionPromise;
    };
    let planaConsumerPromise: Promise<PlanaStreamTerminalReport> | undefined;

    try {
      planaConsumerPromise = plana.consumeRuntimeStream(runtimeEventStream, {
        plan,
        instance,
        cancellationBoundary,
        approvalResponsePort,
        defaultApprovalTimeoutMs: ctxDefaultApprovalTimeoutMs,
        onRuntimeWarning: (warning) => {
          runtimeWarnings.push(warning);
        },
        signal: planaConsumerAbortController.signal,
      });

      await emit({
        kind: 'runtime-initialized',
        message: 'agent instance created',
      });

      const initialTerminalCause = currentTerminalCause();
      if (initialTerminalCause) {
        closeExternalCancellation();
        return finalizeEvidence(() =>
          createTerminalEvidenceFromTerminalCause({
            taskId: plan.taskId,
            runtimeInstanceId: instance.instanceId,
            terminalCause: initialTerminalCause,
            executionContext,
            resourceEnvelope: plan.resourceEnvelope,
            observedSummary,
            transcript: snapshotTranscript(),
            runtimeWarnings: snapshotRuntimeWarnings(),
            startedAt,
            endedAt: new Date().toISOString(),
            artifactLocation,
          }),
        );
      }

      safeNotifyLifecycle({
        phase: 'runtime-running',
        taskId: plan.taskId,
        observedAt: new Date().toISOString(),
        instanceId: instance.instanceId,
      });

      let activeDriver: RuntimeDriver;
      try {
        const resolvedTraitRuntimeDecorators =
          this.traitRuntimeDecoratorResolver === undefined
            ? []
            : await this.traitRuntimeDecoratorResolver({ plan, instance, plana });
        // Static constructor bindings intentionally precede per-dispatch
        // resolver bindings. With reduceRight composition, static bindings are
        // outermost and composition-root bindings wrap closer to the delegate.
        activeDriver = composeTraitRuntimeDriverDecorators(
          this.driver,
          [
            ...this.traitRuntimeDecorators,
            ...resolvedTraitRuntimeDecorators,
          ],
        );
      } catch (error) {
        closeExternalCancellation();
        return finalizeEvidence(() =>
          createFailClosedEvidence({
            taskId: plan.taskId,
            runtimeInstanceId: instance.instanceId,
            executionContext,
            resourceEnvelope: plan.resourceEnvelope,
            observedSummary,
            transcript: snapshotTranscript(),
            runtimeWarnings: snapshotRuntimeWarnings(),
            startedAt,
            endedAt: new Date().toISOString(),
            artifactLocation,
            phase: resolveTraitRuntimeDecoratorFailurePhase(error),
            error,
          }),
        );
      }

      // M3 — Freeze the task instruction immediately before driver invocation.
      // After this point, any further observeSystemPrompt for this taskId with
      // a different prompt is recorded as a system-prompt-mutation violation.
      this.promptCacheInvariant?.freezeSystemPrompt(plan.taskId);

      const driverExecution = Promise.resolve()
        .then(() =>
          activeDriver.run({
            plan,
            instance,
            emit,
            requestApproval,
            isAborted: () =>
              currentTerminalCause() !== undefined ||
              terminalResolution?.kind === 'timeout',
          }),
        )
        .then(
          (driverResult): RuntimeExecutionTerminalResolution => {
            const cause = currentTerminalCause();
            if (cause === undefined) {
              return latchTerminalResolution({
                kind: 'driver-result',
                result: driverResult,
              });
            }
            // Cause was latched on the boundary; mirror it as a boundary
            // resolution. `latchTerminalResolution` is idempotent — if a
            // resolution is already pinned (e.g. by the boundary's own
            // .then) it returns that instead.
            return latchTerminalResolution({ kind: 'boundary', cause });
          },
          (error): RuntimeExecutionTerminalResolution => {
            const cause = currentTerminalCause();
            if (cause === undefined) {
              return latchTerminalResolution({
                kind: 'driver-error',
                error,
              });
            }
            return latchTerminalResolution({ kind: 'boundary', cause });
          },
        );
      const boundaryExecution = cancellationBoundary.whenTerminalCause?.().then(
        (boundaryCause) =>
          latchTerminalResolution({
            kind: 'boundary',
            cause: boundaryCause,
          }),
      );

      const deadlineMs = plan.runtimeSettings.deadlineMs;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let deadlineExecution: Promise<RuntimeExecutionTerminalResolution> | undefined;
      if (deadlineMs !== undefined) {
        deadlineExecution = new Promise<RuntimeExecutionTerminalResolution>(
          (resolveDeadline) => {
            deadlineTimer = setTimeout(() => {
              resolveDeadline(
                latchTerminalResolution({
                  kind: 'timeout',
                  deadlineMs,
                  firedAt: new Date().toISOString(),
                }),
              );
            }, deadlineMs);
          },
        );
      }

      let executionResolution: RuntimeExecutionTerminalResolution;
      try {
        const racers: Promise<RuntimeExecutionTerminalResolution>[] = [
          driverExecution,
        ];
        if (boundaryExecution) {
          racers.push(boundaryExecution);
        }
        if (deadlineExecution) {
          racers.push(deadlineExecution);
        }
        executionResolution =
          racers.length === 1 ? await racers[0] : await Promise.race(racers);
      } finally {
        if (deadlineTimer !== undefined) {
          clearTimeout(deadlineTimer);
        }
      }

      closeExternalCancellation();

      if (executionResolution.kind === 'boundary') {
        return finalizeEvidence(() =>
          createTerminalEvidenceFromTerminalCause({
            taskId: plan.taskId,
            runtimeInstanceId: instance.instanceId,
            terminalCause: executionResolution.cause,
            executionContext,
            resourceEnvelope: plan.resourceEnvelope,
            observedSummary,
            transcript: snapshotTranscript(),
            runtimeWarnings: snapshotRuntimeWarnings(),
            startedAt,
            endedAt: new Date().toISOString(),
            artifactLocation,
          }),
        );
      }

      if (executionResolution.kind === 'timeout') {
        const timeoutCause: TerminalCauseTimeout = {
          kind: 'timeout',
          taskId: plan.taskId,
          runtimeInstanceId: instance.instanceId,
          observedAt: executionResolution.firedAt,
          provenance: 'agent-runtime-deadline',
          deadlineMs: executionResolution.deadlineMs,
          firedAt: executionResolution.firedAt,
        };
        return finalizeEvidence(() =>
          createTerminalEvidence({
            taskId: plan.taskId,
            runtimeInstanceId: instance.instanceId,
            reason: `agent runtime deadline of ${executionResolution.deadlineMs}ms exceeded`,
            provenance: 'agent-runtime-deadline',
            executionContext,
            resourceEnvelope: plan.resourceEnvelope,
            observedSummary,
            transcript: snapshotTranscript(),
            runtimeWarnings: snapshotRuntimeWarnings(),
            startedAt,
            endedAt: executionResolution.firedAt,
            artifactLocation,
            cause: timeoutCause,
          }),
        );
      }

      if (executionResolution.kind === 'driver-error') {
        throw executionResolution.error;
      }

      const result = executionResolution.result;

      artifactLocation = result.artifactLocation ?? artifactLocation;

      const endedAt = new Date().toISOString();
      const resultObservedSummary = canonicalizeObservedSummary(
        result.observedSummary,
        'Runtime driver result field',
      );

      const terminalCause = currentTerminalCause();
      if (terminalCause) {
        closeExternalCancellation();
        return finalizeEvidence(() =>
          createTerminalEvidenceFromTerminalCause({
            taskId: plan.taskId,
            runtimeInstanceId: instance.instanceId,
            terminalCause,
            executionContext,
            resourceEnvelope: plan.resourceEnvelope,
            observedSummary: resultObservedSummary ?? observedSummary,
            transcript: snapshotTranscript(),
            runtimeWarnings: snapshotRuntimeWarnings(),
            startedAt,
            endedAt,
            artifactLocation,
          }),
        );
      }

      // WU-V Phase 6: driver `cause` is the SOLE terminal-state carrier.
      // Outcome derivation happens at presentation time only (Discord
      // renderer); the factory no longer accepts an `outcome` field.
      // See specs/wu-v-terminal-cause-tightening.md §3 Phase 6, §4 mapping.
      const driverCause = result.cause;
      return finalizeEvidence(() =>
        createTerminalEvidence({
          taskId: plan.taskId,
          runtimeInstanceId: instance.instanceId,
          reason: result.reason,
          provenance: result.provenance,
          executionContext,
          resourceEnvelope: plan.resourceEnvelope,
          observedSummary: resultObservedSummary ?? observedSummary,
          transcript: snapshotTranscript(),
          runtimeWarnings: snapshotRuntimeWarnings(),
          startedAt,
          endedAt,
          artifactLocation,
          cause: driverCause,
        }),
      );
    } catch (error) {
      const terminalCause = currentTerminalCause();
      if (terminalCause) {
        closeExternalCancellation();
        return finalizeEvidence(() =>
          createTerminalEvidenceFromTerminalCause({
            taskId: plan.taskId,
            runtimeInstanceId: instance.instanceId,
            terminalCause,
            executionContext,
            resourceEnvelope: plan.resourceEnvelope,
            observedSummary,
            transcript: snapshotTranscript(),
            runtimeWarnings: snapshotRuntimeWarnings(),
            startedAt,
            endedAt: new Date().toISOString(),
            artifactLocation,
          }),
        );
      }

      closeExternalCancellation();
      return finalizeEvidence(() =>
        createFailClosedEvidence({
          taskId: plan.taskId,
          runtimeInstanceId: instance.instanceId,
          executionContext,
          resourceEnvelope: plan.resourceEnvelope,
          observedSummary,
          transcript: snapshotTranscript(),
          runtimeWarnings: snapshotRuntimeWarnings(),
          startedAt,
          endedAt: new Date().toISOString(),
          artifactLocation,
          phase:
            veto !== undefined
              ? `runtime processing after veto from ${veto.provenance}`
              : 'runtime execution',
          error,
        }),
      );
    } finally {
      runtimeEventStream.close();
      clearPendingApprovals();
      planaConsumerAbortController.abort();
      if (planaConsumerPromise !== undefined) {
        try {
          await planaConsumerPromise;
        } catch {
          // Swallow consumer teardown errors; terminal evidence is sourced
          // from the runtime execution resolution path.
        }
      }
      // F1 drain: every afterDispatch / onTerminalEvidence chain attached
      // by finalizeEvidence has its own .catch() so allSettled cannot
      // reject. We still wait so a subsequent execute() on the same
      // runtime instance cannot race a stale hook from this dispatch.
      if (pendingTraitLifecycleHooks.length > 0) {
        await Promise.allSettled(pendingTraitLifecycleHooks);
      }
      // P4 Stage 4-1 — dispatch-bounded subagent roster cleanup.
      // `terminateAll` is idempotent (the roster latches on first call)
      // and only iterates active descriptors, so this is a no-op when
      // no subagents were ever spawned. Stage 4-1 production code does
      // not spawn subagents; this cleanup path exists so the lifetime
      // contract is correct on day one for stages 4-4+. We synthesize a
      // best-effort cleanup cause when the dispatch resolved before
      // `finalizeEvidence` ran (defensive for unexpected throw paths).
      if (subagentRoster !== undefined) {
        const rosterCleanupCause: TerminalCause =
          dispatchTerminalCause ?? {
            kind: 'driver-failure',
            taskId: plan.taskId,
            runtimeInstanceId: instance.instanceId,
            observedAt: new Date().toISOString(),
            provenance: 'agent-runtime-roster-cleanup',
            phase: 'runtime cleanup',
            message:
              'subagent roster cleanup invoked without an authoritative terminal cause',
          };
        try {
          await subagentRoster.terminateAll(rosterCleanupCause);
        } catch (error) {
          console.warn(
            'agent-runtime.subagent-roster-terminate-all-threw',
            JSON.stringify({
              taskId: plan.taskId,
              runtimeInstanceId: instance.instanceId,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        // P4 Stage 4-2 — unregister from the service-scope registry.
        // Idempotent: missing entries are a no-op, so it is safe to
        // run unconditionally inside the roster-defined branch even
        // when the registry was not wired at construction time.
        this.subagentRosterRegistry?.unregister(plan.taskId);
      }
      // P4 Stage 4-3 — drain the dispatch-scoped roster event consumer.
      // The roster's event stream stays open after `terminateAll`, so we
      // explicitly call `iterator.return()` to unblock the for-await
      // loop, then await the consumer task so a subsequent execute() on
      // this runtime cannot race a stale event from this dispatch (mirrors
      // the F1 trait-lifecycle drain immediately above).
      if (rosterEventConsumer !== undefined) {
        try {
          await rosterEventConsumer.iterator.return?.();
        } catch {
          // Iterator teardown is best effort; the loop already swallows
          // upstream throws via its own try/catch.
        }
        try {
          await rosterEventConsumer.settled;
        } catch {
          // Defense-in-depth — the IIFE inside the consumer never
          // rejects, but a future refactor must not destabilize
          // dispatch teardown.
        }
      }
      // Audit 2026-05-03 follow-up: drop per-task state from the
      // prompt-cache invariant so a long-running runtime instance does
      // not accumulate TaskState + rotation log entries forever (analog
      // to PR #18 / PR #19 unbounded-map fixes). `forgetTask` is
      // optional on the port for backward compatibility with mocks that
      // pre-date this addition.
      this.promptCacheInvariant?.forgetTask?.(plan.taskId);
    }
  }
}
