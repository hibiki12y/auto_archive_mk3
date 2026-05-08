/**
 * Research-plan orchestrator.
 *
 * Empirical eval data 2026-05-07 (`scripts/deep-research-eval.mjs`) showed
 * single-shot ultra-deep research runs hit provider-side ceilings before final
 * synthesis: Codex emits a `502 Bad Gateway` from the remote `responses/compact`
 * endpoint after ~17 min of continuous thread activity; Claude exhausts
 * `max_turns` even at mt=80 on a 6-deliverable task. Neither ceiling is
 * locally-tunable — the loop detector (now env-knob-driven, commit `f24317c`)
 * was already proven NOT to be the bottleneck.
 *
 * The codebase already contains a full subagent roster + policy + retention
 * ledger surface (`src/contracts/subagent-roster.ts`,
 * `src/runtime/subagent-roster.ts`, etc.) but no production call site
 * instantiates it. This orchestrator is the minimum-viable seam: take a
 * decomposed research plan (N sub-tasks + 1 synthesis) and route each through
 * the EXISTING `RuntimeDriver`, capturing each sub-task's final
 * `agent_message`. After every sub-task completes, format their outputs into
 * the synthesis prompt and run one final dispatch whose final `agent_message`
 * is returned as the aggregated report.
 *
 * Invariants:
 *   - One `RuntimeDriver.run()` per sub-task; one for synthesis. No fan-out.
 *   - A sub-task failure (cause.kind !== 'success') stops the plan early and
 *     surfaces in the result so the operator can decide whether to resume.
 *   - `RuntimeDriver.run()` is called sequentially — the orchestrator never
 *     spawns parallel dispatches. Parallel research is a separate work unit.
 *   - Pure orchestration: no Plana stream, no advisor chain, no detector.
 *     Callers wanting those guarantees layer them at the driver factory.
 */

import {
  createDispatchPlan,
  type TaskRequest,
} from './task.js';
import type {
  AgentInstance,
  RuntimeDriver,
  RuntimeDriverResult,
  RuntimeExecutionContext,
} from '../contracts/runtime-driver.js';
import type {
  ApprovalDecision,
  RuntimeApprovalRequest,
  RuntimeEvent,
} from '../contracts/runtime-event.js';
import type { RuntimeSettingsInput } from '../contracts/runtime-settings.js';
import type { PlanningResourceEnvelopeInput } from '../contracts/resource-envelope.js';
import type { ProviderFailureClassification } from '../contracts/terminal-cause.js';
import type {
  SubagentRole,
} from '../contracts/subagent-roster.js';
import type { SubagentRoster } from '../runtime/subagent-roster.js';

/**
 * Provider-failure classifications that are NOT retryable: the failure is
 * caused by a permanent condition (auth/config/protocol drift) that another
 * dispatch attempt will not resolve. The orchestrator fast-fails these so
 * `retryAttempts` is not burned on hopeless retries.
 *
 * @see specs/wu-h-terminal-cause-taxonomy.md §6.12 (F6/F7/F8)
 */
const PERMANENT_PROVIDER_FAILURE_CLASSIFICATIONS: ReadonlySet<ProviderFailureClassification> =
  new Set<ProviderFailureClassification>([
    'permanent-auth',
    'permanent-config',
    'permanent-protocol',
  ]);

/** Token replaced inside the synthesis instruction with the joined sub-task outputs. */
export const RESEARCH_PLAN_SUBTASK_OUTPUTS_TOKEN =
  '{{subTaskOutputs}}';

/**
 * Partial-shaped per-sub-task override of the plan-level resources envelope.
 * Either `requested` or `effective` may be a partial map; missing keys fall
 * back to the plan-level envelope's value for that key. The merged envelope
 * is re-validated by `createPlannedResourceEnvelope` at dispatch time.
 */
export interface ResearchPlanResourcesOverride {
  readonly requested?: Partial<PlanningResourceEnvelopeInput['requested']>;
  readonly effective?: Partial<NonNullable<PlanningResourceEnvelopeInput['effective']>>;
}

export interface ResearchSubTask {
  readonly taskId: string;
  readonly instruction: string;
  readonly artifactLocation?: string;
  /**
   * Optional per-sub-task runtime-settings override. Shallow-merges over the
   * plan-level `runtimeSettings` (sub-task wins per key); the merged bundle
   * is re-validated by `createRuntimeSettingsBundle` at dispatch time, so
   * any invalid override surfaces as a normal validation error.
   */
  readonly runtimeSettings?: Partial<RuntimeSettingsInput>;
  /**
   * Optional per-sub-task resources override. Per-key shallow merge over the
   * plan-level `resources` for both `requested` and `effective` sub-fields.
   */
  readonly resources?: ResearchPlanResourcesOverride;
}

export interface ResearchPlanSynthesis {
  readonly taskId: string;
  /**
   * Synthesis instruction. May contain the literal token
   * `{{subTaskOutputs}}` which the orchestrator replaces with the joined
   * sub-task outputs (`## subTaskId: <id>\n<text>\n\n` blocks).
   */
  readonly instructionTemplate: string;
  readonly artifactLocation?: string;
  /** See `ResearchSubTask.runtimeSettings`. */
  readonly runtimeSettings?: Partial<RuntimeSettingsInput>;
  /** See `ResearchSubTask.resources`. */
  readonly resources?: ResearchPlanResourcesOverride;
}

export interface ResearchPlan {
  readonly subTasks: readonly ResearchSubTask[];
  readonly synthesis: ResearchPlanSynthesis;
  /**
   * Runtime settings + resource envelope shared by every dispatch in the
   * plan. Each sub-task (and the synthesis) may shallow-override these
   * defaults via its own `runtimeSettings` / `resources` partial — see
   * `mergeRuntimeSettings` / `mergeResources` for merge semantics.
   */
  readonly runtimeSettings: RuntimeSettingsInput;
  readonly resources: PlanningResourceEnvelopeInput;
}

/**
 * Shallow-merge a partial runtime-settings override onto the plan-level
 * defaults. Per-key precedence: override wins when defined; otherwise the
 * default value is kept. `undefined` keys in the override are ignored (i.e.
 * they do NOT clear the default value) so callers can omit unrelated fields.
 */
export function mergeRuntimeSettings(
  base: RuntimeSettingsInput,
  override: Partial<RuntimeSettingsInput> | undefined,
): RuntimeSettingsInput {
  if (override === undefined) return base;
  // Filter out undefined keys so callers can't accidentally clear a default
  // by setting a key to `undefined`. The merged object then satisfies
  // RuntimeSettingsInput because base is already a complete bundle and we
  // only overwrite with same-shape per-key values.
  return { ...base, ...filterDefined(override) };
}

/**
 * Per-key shallow-merge a partial resources override onto the plan-level
 * resources envelope. Both `requested` and `effective` are merged
 * independently; any missing override field falls back to the base value.
 */
export function mergeResources(
  base: PlanningResourceEnvelopeInput,
  override: ResearchPlanResourcesOverride | undefined,
): PlanningResourceEnvelopeInput {
  if (override === undefined) return base;
  const requested = override.requested
    ? { ...base.requested, ...filterDefined(override.requested) }
    : base.requested;
  const baseEffective = base.effective;
  const overrideEffective = override.effective
    ? filterDefined(override.effective)
    : undefined;
  let effective: PlanningResourceEnvelopeInput['effective'];
  if (overrideEffective !== undefined) {
    effective =
      baseEffective !== undefined
        ? { ...baseEffective, ...overrideEffective }
        : overrideEffective;
  } else {
    effective = baseEffective;
  }
  return effective === undefined
    ? { requested }
    : { requested, effective };
}

function filterDefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] !== undefined) {
      out[key] = value[key];
    }
  }
  return out;
}

export interface ResearchSubTaskOutcome {
  readonly subTaskId: string;
  readonly instanceId: string;
  readonly causeKind: string;
  readonly provenance: string | undefined;
  readonly elapsedMs: number;
  readonly eventCount: number;
  readonly toolUseCount: number;
  readonly finalText: string;
  readonly result: RuntimeDriverResult | undefined;
  readonly driverThrew: string | undefined;
}

export interface ResearchPlanResult {
  readonly subTaskOutcomes: readonly ResearchSubTaskOutcome[];
  readonly synthesisOutcome: ResearchSubTaskOutcome | undefined;
  readonly totalElapsedMs: number;
  readonly aggregatedReport: string;
  readonly stoppedEarly: boolean;
  /**
   * Sub-task ids that did NOT contribute to synthesis. Populated when
   * `allowPartialSynthesis` triggers (one or more sub-tasks failed but
   * synthesis ran on the successful subset) and when synthesis was skipped
   * because no sub-task succeeded. Empty array on a clean run.
   */
  readonly skippedSubTaskIds: readonly string[];
  /** True when `allowPartialSynthesis` triggered and synthesis ran on a subset. */
  readonly partialSynthesis: boolean;
}

export interface RunResearchPlanOptions {
  /**
   * Optional approval decision factory. Default approves every approval
   * request. The orchestrator does not interpose veto/cancel — callers that
   * want approval gating should layer it via the driver, not here.
   */
  readonly approvalResponse?: (
    request: RuntimeApprovalRequest,
  ) => Promise<ApprovalDecision> | ApprovalDecision;
  /**
   * Per-event observer fired during every sub-task and the synthesis. Useful
   * for streaming progress to a UI without buffering the whole run.
   */
  readonly onEvent?: (info: {
    readonly subTaskId: string;
    readonly event: RuntimeEvent | (Omit<RuntimeEvent, 'timestamp' | 'instanceId'>);
  }) => void;
  /**
   * Number of additional retries per sub-task (and per synthesis) when the
   * driver throws or returns a non-success cause.kind. Default 0 (legacy
   * "halt on first failure"). Long live runs across 10+ sub-tasks regularly
   * encounter transient SDK 502s and other backend blips that recover on
   * retry — set to 1-2 for ambitious decomposed audits. Each retry is a
   * fresh `driver.run()` call (which for Codex means a fresh thread, so
   * the compact ceiling is reset).
   */
  readonly retryAttempts?: number;
  /**
   * Optional observer fired before every retry attempt — and once when a
   * retry is *skipped* because the previous attempt's failure was classified
   * as permanent (in which case `previousCauseFastFailed` is `true` and
   * `attempt` equals the would-be next attempt number that did not run).
   * Useful for surfacing "Sub-task X failed, retrying (attempt Y/Z)…" progress
   * to operators, or noting "fast-failed: permanent-auth, no retry".
   */
  readonly onRetry?: (info: {
    readonly subTaskId: string;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly previousCauseKind: string;
    readonly previousDriverThrew: string | undefined;
    readonly previousCauseClassification?: string;
    readonly previousCauseFastFailed?: boolean;
  }) => void;
  /**
   * When `true` and a sub-task failure would otherwise trigger
   * `stoppedEarly`, run synthesis on the *successfully-completed* sub-tasks
   * only (provided at least one such sub-task exists) and prepend a header
   * to the synthesis instruction noting which sub-tasks were skipped (the
   * one that failed plus any that never ran). When no sub-task succeeded,
   * behaviour matches the default halt: synthesis is not attempted and
   * `stoppedEarly` is `true`. Default: `false` (legacy halt-on-first-failure).
   *
   * Use this for ambitious decomposed audits where a single lane failing
   * after retries is acceptable as long as the rest can still be
   * synthesised; the operator can re-run the failed lane separately.
   */
  readonly allowPartialSynthesis?: boolean;
  /** Override `Date.now()` for deterministic tests. */
  readonly now?: () => number;
  /** Override `new Date().toISOString()` for deterministic tests. */
  readonly nowIso?: () => string;
  /** Override `randomUUID`-shape instance-id minting for deterministic tests. */
  readonly mintInstanceId?: (subTaskId: string) => string;
  /**
   * P4 Stage 4-6 — optional subagent roster.
   *
   * When provided, each sub-task dispatch and the synthesis dispatch are
   * routed through `roster.spawnAndRun({options, instruction})` instead of
   * the bare `driver.run(...)` path. The roster is constructed by the
   * caller (CLI runner / Discord handler / programmatic API) so the same
   * roster instance is shared across the whole plan — operators see the
   * whole research-plan as one unit via `/subagents list`.
   *
   * When omitted, the orchestrator's behavior is unchanged from prior
   * stages (driver.run path). The orchestrator still runs the
   * `RuntimeExecutionContext.emit` accounting (event counts, tool-use
   * counters, final-text capture) by attaching its own context shim
   * around the roster call site so the resulting `ResearchSubTaskOutcome`
   * keeps the same shape regardless of dispatch path.
   *
   * @see specs/CURRENT/subagent-runtime-activation-2026-05-08.md
   */
  readonly subagentRoster?: SubagentRoster;
  /**
   * P4 Stage 4-6 — optional subagent role applied to every sub-task and
   * the synthesis dispatch. Defaults to 'explorer'. Must be in the
   * roster's policy `allowedRoles` list (the default policy allows
   * `[explorer, coder, writer, verifier]`).
   */
  readonly subagentRole?: SubagentRole;
}

export async function runResearchPlan(
  driver: RuntimeDriver,
  plan: ResearchPlan,
  options: RunResearchPlanOptions = {},
): Promise<ResearchPlanResult> {
  if (plan.subTasks.length === 0) {
    throw new Error('Research plan must have at least one sub-task.');
  }
  const now = options.now ?? (() => Date.now());
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const mintInstanceId =
    options.mintInstanceId ??
    ((subTaskId) => `agent-${subTaskId}-${now()}`);
  const approvalResponse =
    options.approvalResponse ??
    ((): ApprovalDecision => ({ status: 'approved' }));

  const start = now();
  const subTaskOutcomes: ResearchSubTaskOutcome[] = [];
  const retryAttempts = Math.max(0, Math.floor(options.retryAttempts ?? 0));
  const allowPartialSynthesis = options.allowPartialSynthesis === true;
  const subagentRoster = options.subagentRoster;
  const subagentRole: SubagentRole = options.subagentRole ?? 'explorer';

  let firstFailureIndex: number | undefined;
  for (let idx = 0; idx < plan.subTasks.length; idx++) {
    const subTask = plan.subTasks[idx];
    const outcome = await runWithRetries(
      driver,
      {
        taskId: subTask.taskId,
        instruction: subTask.instruction,
        ...(subTask.artifactLocation !== undefined
          ? { artifactLocation: subTask.artifactLocation }
          : {}),
        runtimeSettings: mergeRuntimeSettings(
          plan.runtimeSettings,
          subTask.runtimeSettings,
        ),
        resources: mergeResources(plan.resources, subTask.resources),
      },
      approvalResponse,
      options.onEvent,
      mintInstanceId,
      nowIso,
      retryAttempts,
      options.onRetry,
      subagentRoster,
      subagentRole,
    );
    subTaskOutcomes.push(outcome);
    if (outcome.causeKind !== 'success') {
      firstFailureIndex = idx;
      break;
    }
  }

  if (firstFailureIndex !== undefined) {
    const successful = subTaskOutcomes.filter((o) => o.causeKind === 'success');
    const failedOrUnrunIds: string[] = [];
    // The failing sub-task at `firstFailureIndex`.
    failedOrUnrunIds.push(plan.subTasks[firstFailureIndex].taskId);
    // Plus any sub-tasks that never ran.
    for (let j = firstFailureIndex + 1; j < plan.subTasks.length; j++) {
      failedOrUnrunIds.push(plan.subTasks[j].taskId);
    }
    if (!allowPartialSynthesis || successful.length === 0) {
      return {
        subTaskOutcomes,
        synthesisOutcome: undefined,
        totalElapsedMs: now() - start,
        aggregatedReport: '',
        stoppedEarly: true,
        skippedSubTaskIds: failedOrUnrunIds,
        partialSynthesis: false,
      };
    }
    // Partial-synthesis path: run synthesis on the successful subset only,
    // with a header noting the skipped sub-tasks.
    const partialInstruction = applyPartialSynthesisHeader(
      applyOutputsToken(plan.synthesis.instructionTemplate, successful),
      failedOrUnrunIds,
    );
    const synthesisOutcome = await runWithRetries(
      driver,
      {
        taskId: plan.synthesis.taskId,
        instruction: partialInstruction,
        ...(plan.synthesis.artifactLocation !== undefined
          ? { artifactLocation: plan.synthesis.artifactLocation }
          : {}),
        runtimeSettings: mergeRuntimeSettings(
          plan.runtimeSettings,
          plan.synthesis.runtimeSettings,
        ),
        resources: mergeResources(plan.resources, plan.synthesis.resources),
      },
      approvalResponse,
      options.onEvent,
      mintInstanceId,
      nowIso,
      retryAttempts,
      options.onRetry,
      subagentRoster,
      subagentRole,
    );
    return {
      subTaskOutcomes,
      synthesisOutcome,
      totalElapsedMs: now() - start,
      aggregatedReport: synthesisOutcome.finalText,
      // stoppedEarly remains true so callers know the run did not complete
      // every planned sub-task; partialSynthesis disambiguates the recovery.
      stoppedEarly: true,
      skippedSubTaskIds: failedOrUnrunIds,
      partialSynthesis: true,
    };
  }

  const synthesisInstruction = applyOutputsToken(
    plan.synthesis.instructionTemplate,
    subTaskOutcomes,
  );
  const synthesisOutcome = await runWithRetries(
    driver,
    {
      taskId: plan.synthesis.taskId,
      instruction: synthesisInstruction,
      ...(plan.synthesis.artifactLocation !== undefined
        ? { artifactLocation: plan.synthesis.artifactLocation }
        : {}),
      runtimeSettings: mergeRuntimeSettings(
        plan.runtimeSettings,
        plan.synthesis.runtimeSettings,
      ),
      resources: mergeResources(plan.resources, plan.synthesis.resources),
    },
    approvalResponse,
    options.onEvent,
    mintInstanceId,
    nowIso,
    retryAttempts,
    options.onRetry,
    subagentRoster,
    subagentRole,
  );

  return {
    subTaskOutcomes,
    synthesisOutcome,
    totalElapsedMs: now() - start,
    aggregatedReport: synthesisOutcome.finalText,
    stoppedEarly: synthesisOutcome.causeKind !== 'success',
    skippedSubTaskIds: [],
    partialSynthesis: false,
  };
}

function applyPartialSynthesisHeader(
  instruction: string,
  skippedSubTaskIds: readonly string[],
): string {
  const list = skippedSubTaskIds.map((id) => `- ${id}`).join('\n');
  return (
    `# PARTIAL SYNTHESIS — the following sub-tasks did not complete and are NOT in the inputs below:\n${list}\n\n` +
    instruction
  );
}

function applyOutputsToken(
  template: string,
  outcomes: readonly ResearchSubTaskOutcome[],
): string {
  const joined = outcomes
    .map(
      (o) =>
        `## subTaskId: ${o.subTaskId}\n${o.finalText.length > 0 ? o.finalText : '<no final text>'}`,
    )
    .join('\n\n');
  if (template.includes(RESEARCH_PLAN_SUBTASK_OUTPUTS_TOKEN)) {
    return template.split(RESEARCH_PLAN_SUBTASK_OUTPUTS_TOKEN).join(joined);
  }
  // No token: append the outputs as a block under a fixed delimiter so the
  // synthesis instruction always has the data it needs even if the operator
  // forgot the token.
  return `${template}\n\n--- sub-task outputs ---\n\n${joined}`;
}

async function runWithRetries(
  driver: RuntimeDriver,
  request: TaskRequest,
  approvalResponse: NonNullable<RunResearchPlanOptions['approvalResponse']>,
  onEvent: RunResearchPlanOptions['onEvent'],
  mintInstanceId: (subTaskId: string) => string,
  nowIso: () => string,
  retryAttempts: number,
  onRetry: RunResearchPlanOptions['onRetry'],
  subagentRoster: SubagentRoster | undefined,
  subagentRole: SubagentRole,
): Promise<ResearchSubTaskOutcome> {
  const maxAttempts = retryAttempts + 1;
  let lastOutcome: ResearchSubTaskOutcome | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const outcome = await runOneDispatch(
      driver,
      request,
      approvalResponse,
      onEvent,
      mintInstanceId,
      nowIso,
      subagentRoster,
      subagentRole,
    );
    if (outcome.causeKind === 'success') {
      return outcome;
    }
    lastOutcome = outcome;

    // Classification-aware fast-fail: a `provider-failure` cause whose
    // classification indicates a permanent condition (auth/config/protocol)
    // will not be resolved by another dispatch attempt. Fast-fail without
    // burning the remaining retryAttempts. Driver-thrown errors and other
    // cause kinds (timeout, runtime-veto, external-cancel) keep the legacy
    // retry-up-to-retryAttempts behaviour because the throw shape may carry
    // a transient SDK error.
    const classification = providerFailureClassification(outcome);
    const fastFail =
      classification !== undefined &&
      PERMANENT_PROVIDER_FAILURE_CLASSIFICATIONS.has(classification);

    if (fastFail) {
      try {
        onRetry?.({
          subTaskId: request.taskId,
          attempt: attempt + 1,
          maxAttempts,
          previousCauseKind: outcome.causeKind,
          previousDriverThrew: outcome.driverThrew,
          previousCauseClassification: classification,
          previousCauseFastFailed: true,
        });
      } catch {
        // Observer failures must never break the retry loop.
      }
      return outcome;
    }

    if (attempt < maxAttempts) {
      try {
        onRetry?.({
          subTaskId: request.taskId,
          attempt: attempt + 1,
          maxAttempts,
          previousCauseKind: outcome.causeKind,
          previousDriverThrew: outcome.driverThrew,
          ...(classification !== undefined
            ? { previousCauseClassification: classification }
            : {}),
          previousCauseFastFailed: false,
        });
      } catch {
        // Observer failures must never break the retry loop.
      }
    }
  }
  // Persistent failure — return the last failed outcome (carries driverThrew
  // and elapsedMs from the final attempt).
  return lastOutcome as ResearchSubTaskOutcome;
}

function providerFailureClassification(
  outcome: ResearchSubTaskOutcome,
): ProviderFailureClassification | undefined {
  if (outcome.causeKind !== 'provider-failure') return undefined;
  const cause = outcome.result?.cause;
  if (cause === undefined || cause.kind !== 'provider-failure') return undefined;
  return cause.classification;
}

async function runOneDispatch(
  driver: RuntimeDriver,
  request: TaskRequest,
  approvalResponse: NonNullable<RunResearchPlanOptions['approvalResponse']>,
  onEvent: RunResearchPlanOptions['onEvent'],
  mintInstanceId: (subTaskId: string) => string,
  nowIso: () => string,
  subagentRoster: SubagentRoster | undefined,
  subagentRole: SubagentRole,
): Promise<ResearchSubTaskOutcome> {
  const plan = createDispatchPlan(request);
  const instance: AgentInstance = {
    taskId: plan.taskId,
    instanceId: mintInstanceId(request.taskId),
    createdAt: nowIso(),
    runtimeSettings: plan.runtimeSettings,
  };

  let toolUseCount = 0;
  let eventCount = 0;
  let finalText = '';

  const context: RuntimeExecutionContext = {
    plan,
    instance,
    // The RuntimeExecutionContext interface declares `emit` as async so all
    // implementations share the same Promise-returning shape (some persist
    // events to disk and need the await). This in-process driver merely
    // updates counters synchronously, so there is no `await` to perform —
    // adding one would introduce an unnecessary microtask boundary that
    // existing test fixtures do not expect.
    // eslint-disable-next-line @typescript-eslint/require-await
    emit: async (eventInput) => {
      eventCount += 1;
      onEvent?.({ subTaskId: request.taskId, event: eventInput });
      if (eventInput.kind === 'item.completed') {
        const item = eventInput.item;
        const t = item.type;
        if (
          t === 'command_execution' ||
          t === 'file_change' ||
          t === 'mcp_tool_call' ||
          t === 'web_search'
        ) {
          toolUseCount += 1;
        }
        if (t === 'agent_message') {
          const text =
            (item as { text?: unknown }).text ??
            (item as { summary?: unknown }).summary ??
            '';
          if (typeof text === 'string') {
            finalText =
              finalText.length === 0 ? text : `${finalText}\n${text}`;
          }
        }
      }
    },
    requestApproval: async (approvalCtx) => approvalResponse(approvalCtx.request),
    isAborted: () => false,
  };

  const start = Date.now();
  let result: RuntimeDriverResult | undefined;
  let driverThrew: string | undefined;
  try {
    if (subagentRoster !== undefined) {
      // P4 Stage 4-6 — route the dispatch through the roster's
      // spawnAndRun(...) so operators see this sub-task as a registered
      // subagent in `/subagents list`. The roster admits a child
      // descriptor under the configured role, invokes the parent's
      // `runChild` callback (wired by the caller via
      // CreateSubagentRosterParentContext) which runs the underlying
      // RuntimeDriver, then returns `{descriptor, result}` once the
      // child terminates.
      //
      // The orchestrator's own `RuntimeExecutionContext` (with its
      // emit accounting) is NOT used by the roster path: the roster's
      // runChild callback constructs a fresh child context. This means
      // the orchestrator's per-sub-task event counters and final-text
      // capture would be empty under the roster path, which would
      // break parity with the legacy driver.run path.
      //
      // To preserve parity, the caller's runChild callback MUST install
      // a child emit shim that forwards events back to the orchestrator
      // (see `src/runtime/research-plan-roster-helpers.ts` Stage 4-6).
      // The helper accepts a per-sub-task `onEmit` callback whose
      // shape matches the context's emit; the orchestrator wires its
      // local emit shim through the helper so eventCount, toolUseCount,
      // and finalText are populated identically to the driver.run path.
      //
      // For this to work, the helper attaches its forwarding emit shim
      // to a per-call lookup table keyed off the child sub-task id; the
      // orchestrator publishes its emit there before calling
      // spawnAndRun and removes the registration after the call
      // resolves. See `registerOrchestratorEmitShim` in the helper
      // module.
      registerOrchestratorEmitShim(request.taskId, (eventInput) =>
        context.emit(eventInput),
      );
      try {
        const runResult = await subagentRoster.spawnAndRun({
          options: { role: subagentRole },
          instruction: request.instruction,
        });
        result = runResult.result;
      } finally {
        unregisterOrchestratorEmitShim(request.taskId);
      }
    } else {
      result = await driver.run(context);
    }
  } catch (error) {
    const e = error as { name?: string; message?: string } | undefined;
    driverThrew = `${e?.name ?? 'Error'}: ${e?.message ?? String(error)}`;
  }
  const elapsedMs = Date.now() - start;

  return {
    subTaskId: request.taskId,
    instanceId: instance.instanceId,
    causeKind: result?.cause.kind ?? 'driver-threw',
    provenance: result?.provenance,
    elapsedMs,
    eventCount,
    toolUseCount,
    finalText,
    result,
    driverThrew,
  };
}

/**
 * P4 Stage 4-6 — emit-shim registry for roster-routed dispatches.
 *
 * The roster path constructs its own child `RuntimeExecutionContext` (so
 * each child has a clean parent-tagged identity), which means the
 * orchestrator's local emit accounting closure cannot be passed in
 * directly through `roster.spawnAndRun(...)`. Instead the orchestrator
 * publishes its emit closure here, keyed by the parent sub-task id,
 * and the caller-supplied roster `runChild` callback (see
 * `src/runtime/research-plan-roster-helpers.ts`) looks it up at child
 * spawn time and forwards events through it.
 *
 * The registry is a module-scoped Map. Entries are short-lived —
 * registered immediately before the spawnAndRun call and removed in a
 * finally block — so cross-test bleed only occurs if a test forgets the
 * unregister, which the orchestrator's own finally block prevents.
 */
const orchestratorEmitShims = new Map<
  string,
  (
    eventInput: Parameters<RuntimeExecutionContext['emit']>[0],
  ) => Promise<void> | void
>();

function registerOrchestratorEmitShim(
  subTaskId: string,
  emit: RuntimeExecutionContext['emit'],
): void {
  orchestratorEmitShims.set(subTaskId, emit);
}

function unregisterOrchestratorEmitShim(subTaskId: string): void {
  orchestratorEmitShims.delete(subTaskId);
}

/**
 * Publicly-exported helper-side accessor (Stage 4-6). Returns the emit
 * shim a caller-built `runChild` callback should forward child runtime
 * events through, or `undefined` when no shim is registered for the
 * given parent sub-task id (which should never happen if the helper is
 * paired with the orchestrator's roster path).
 *
 * @internal — exposed for `src/runtime/research-plan-roster-helpers.ts`
 *             only; not part of the orchestrator's public surface.
 */
export function getOrchestratorEmitShim(
  subTaskId: string,
):
  | ((eventInput: Parameters<RuntimeExecutionContext['emit']>[0]) => Promise<void> | void)
  | undefined {
  return orchestratorEmitShims.get(subTaskId);
}
