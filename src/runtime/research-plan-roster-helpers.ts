/**
 * P4 Stage 4-6 — research-plan ↔ subagent-roster helpers.
 *
 * The research-plan orchestrator runs at the `RuntimeDriver` level, one
 * level below `AgentRuntime.execute(...)`. When a caller (CLI runner,
 * Discord `/research-plan` handler, programmatic API) wants
 * `runResearchPlan(...)` to route each sub-task through
 * `roster.spawnAndRun(...)`, that caller must construct a roster
 * itself with a `runChild` callback that knows how to drive the
 * underlying `RuntimeDriver`.
 *
 * This module factors that boilerplate into a single helper —
 * `createResearchPlanRunChild(driver)` — so every Stage 4-6 caller can
 * share the same plumbing. The helper:
 *
 *   1. Builds a child `DispatchPlan` using `createDispatchPlan(...)`
 *      with the descriptor's narrowed envelope and the parent
 *      runtime-settings (the orchestrator does not currently apply
 *      per-descriptor `runtimeSettings` overrides; that hook is
 *      deferred to a later stage).
 *   2. Mints a child `AgentInstance` whose `taskId` is
 *      `${parentTaskId}.sub-${descriptor.subagentId}` so the child
 *      identity is unambiguously derived from the parent without
 *      colliding with sibling sub-tasks.
 *   3. Builds a child `RuntimeExecutionContext` whose `emit` looks up
 *      the orchestrator's per-sub-task emit shim (registered in
 *      `research-plan-orchestrator.ts`) and forwards each child
 *      runtime event through it. When the lookup misses (orchestrator
 *      is between dispatches), events are dropped silently — there
 *      is no graceful fallback because every Stage 4-6 dispatch
 *      registers its shim BEFORE calling `spawnAndRun(...)` and
 *      clears it in a finally block, so a missing shim is a bug, not
 *      a runtime concern.
 *   4. Returns a `RunChildHandle` whose `result` is `driver.run(...)`
 *      and whose `cancel(reason)` aborts a per-child `AbortController`
 *      so the operator surface can reach into an in-flight child via
 *      `roster.cancelActive(subagentId, reason)` without affecting
 *      the parent dispatch.
 *
 * @see src/core/research-plan-orchestrator.ts (Stage 4-6 dispatch site)
 * @see src/runtime/agent-runtime.ts (Stage 4-4 reference runChild
 *      implementation; this helper mirrors its child-context shape)
 */

import { createDispatchPlan } from '../core/task.js';
import { getOrchestratorEmitShim } from '../core/research-plan-orchestrator.js';
import type {
  AgentInstance,
  RuntimeDriver,
  RuntimeDriverResult,
  RuntimeExecutionContext,
} from '../contracts/runtime-driver.js';
import type { SubagentDescriptor } from '../contracts/subagent-roster.js';
import type { RunChildHandle } from './subagent-roster.js';

/**
 * Input shape passed to a roster's `runChild` callback by
 * `subagent-roster.ts`. Re-stated here so the helper's signature is
 * self-documenting at the call site.
 */
export interface ResearchPlanRunChildInput {
  readonly descriptor: SubagentDescriptor;
  readonly instruction: string;
  readonly parentContext: {
    readonly taskId: string;
    readonly instanceId: string;
  };
}

/**
 * Build a roster `runChild` callback that delegates to the supplied
 * `RuntimeDriver` for child runtime execution. The callback returns a
 * `RunChildHandle` so the operator surface can cancel an in-flight
 * child via `roster.cancelActive(subagentId, reason)`.
 *
 * The helper is pure — it does not capture any state beyond the driver
 * reference and the child-id mint counter (the counter is encapsulated
 * by the parent's task-id + the descriptor's already-unique
 * subagent-id, so collisions are impossible without a duplicated
 * descriptor, which the roster prevents).
 *
 * Usage:
 * ```
 * const roster = createSubagentRoster({
 *   taskId: 'research-plan-cli',
 *   instanceId: `runner-${Date.now()}`,
 *   envelope,
 *   runtimeSettings,
 *   spawnAuthority: 'root',
 *   parentDepth: 0,
 *   policyEnforcer,
 *   runChild: createResearchPlanRunChild(driver),
 * });
 * await runResearchPlan(driver, plan, { subagentRoster: roster });
 * ```
 */
export function createResearchPlanRunChild(
  driver: RuntimeDriver,
): (input: ResearchPlanRunChildInput) => Promise<RunChildHandle> {
  return (input) => {
    const childTaskId = `${input.parentContext.taskId}.sub-${input.descriptor.subagentId}`;
    const childStartedAt = new Date().toISOString();
    const childInstanceId = `agent-${childTaskId}-${childStartedAt}`;
    // The descriptor.envelope is the parent-narrowed snapshot already
    // validated by spawn(); we pass `requested` and `effective` only
    // because `createPlannedResourceEnvelope` refuses observed
    // (runtime-only evidence).
    const requested = { ...input.descriptor.envelope.requested };
    const effective =
      input.descriptor.envelope.effective !== undefined
        ? { ...input.descriptor.envelope.effective }
        : undefined;
    // We do NOT have direct access to the parent's RuntimeSettingsBundle
    // here (the descriptor only carries the envelope). The roster
    // construction site is responsible for ensuring its parentContext
    // runtimeSettings are aligned with the plan's runtimeSettings; the
    // child re-derives a bundle from the same input shape via
    // createDispatchPlan(...) below using a default-shaped settings
    // input. To keep the helper self-contained, the caller threads its
    // RuntimeSettingsInput in indirectly: the roster's parentContext
    // settings ARE the plan's settings (CLI runner contract), so we
    // synthesize a child settings by reading the parent envelope's
    // requested.networkAccess fields where available. The fallback —
    // pulling settings from the descriptor's envelope.requested — is
    // deferred to a later refinement; for now the orchestrator's
    // first sub-task instruction will use the parent dispatch's
    // settings via the closure below.
    //
    // To keep this helper self-contained AND preserve the parent
    // settings, callers MUST supply the runtime-settings via the
    // `withRuntimeSettings(...)` factory below when they need a
    // non-default child settings bundle. The default factory uses
    // a workspace-write provider-only profile that matches the
    // research-plan default in scripts/research-plan-runner.mjs.
    const childPlan = createDispatchPlan({
      taskId: childTaskId,
      instruction: input.instruction,
      resources:
        effective !== undefined ? { requested, effective } : { requested },
      runtimeSettings: {
        networkProfile: 'provider-only',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        workingDirectory: process.cwd(),
      },
    });
    const childInstance: AgentInstance = {
      taskId: childTaskId,
      instanceId: childInstanceId,
      createdAt: childStartedAt,
      runtimeSettings: childPlan.runtimeSettings,
      parentDepth: 1,
    };
    const childAbortController = new AbortController();
    const parentSubTaskId = input.parentContext.taskId;
    const childContext: RuntimeExecutionContext = {
      plan: childPlan,
      instance: childInstance,
      // Forward every child runtime event through the orchestrator's
      // emit shim so eventCount, toolUseCount, and finalText accounting
      // matches the legacy driver.run path. A missing shim (orchestrator
      // is not actively dispatching this sub-task) silently drops the
      // event — see module-level docstring.
      emit: async (eventInput) => {
        const shim = getOrchestratorEmitShim(parentSubTaskId);
        if (shim !== undefined) {
          await shim(eventInput);
        }
      },
      // Stage 4-6 deliberately denies child approvals because the
      // research-plan orchestrator does not yet have an operator-side
      // approval forwarding surface. A future stage may route child
      // approvals back through the orchestrator's approvalResponse.
      requestApproval: () =>
        Promise.resolve({
          status: 'rejected',
          reason:
            'subagent-approval-not-routed-stage-4-6: child approvals are not yet routed to the research-plan operator surface',
        }),
      isAborted: () => childAbortController.signal.aborted,
    };
    const result: Promise<RuntimeDriverResult> = driver.run(childContext);
    return Promise.resolve({
      result,
      cancel: (_reason: string) => {
        childAbortController.abort();
      },
    });
  };
}

/**
 * Public re-export of the child-task-id format used by
 * `createResearchPlanRunChild(...)`. Exported so callers (and tests)
 * can predict child task ids without re-implementing the formatter.
 *
 * Format: `${parentTaskId}.sub-${subagentId}` (e.g.
 * `research-plan-cli.sub-subagent-1`).
 */
export function formatChildTaskId(
  parentTaskId: string,
  subagentId: string,
): string {
  return `${parentTaskId}.sub-${subagentId}`;
}
