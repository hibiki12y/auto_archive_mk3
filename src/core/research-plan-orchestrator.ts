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

/** Token replaced inside the synthesis instruction with the joined sub-task outputs. */
export const RESEARCH_PLAN_SUBTASK_OUTPUTS_TOKEN =
  '{{subTaskOutputs}}';

export interface ResearchSubTask {
  readonly taskId: string;
  readonly instruction: string;
  readonly artifactLocation?: string;
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
}

export interface ResearchPlan {
  readonly subTasks: readonly ResearchSubTask[];
  readonly synthesis: ResearchPlanSynthesis;
  /**
   * Runtime settings + resource envelope shared by every dispatch in the plan.
   * Per-sub-task overrides are intentionally NOT supported in this MVP — keep
   * the surface small until usage confirms the need.
   */
  readonly runtimeSettings: RuntimeSettingsInput;
  readonly resources: PlanningResourceEnvelopeInput;
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
  /** Override `Date.now()` for deterministic tests. */
  readonly now?: () => number;
  /** Override `new Date().toISOString()` for deterministic tests. */
  readonly nowIso?: () => string;
  /** Override `randomUUID`-shape instance-id minting for deterministic tests. */
  readonly mintInstanceId?: (subTaskId: string) => string;
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

  for (const subTask of plan.subTasks) {
    const outcome = await runOneDispatch(
      driver,
      {
        taskId: subTask.taskId,
        instruction: subTask.instruction,
        ...(subTask.artifactLocation !== undefined
          ? { artifactLocation: subTask.artifactLocation }
          : {}),
        runtimeSettings: plan.runtimeSettings,
        resources: plan.resources,
      },
      approvalResponse,
      options.onEvent,
      mintInstanceId,
      nowIso,
    );
    subTaskOutcomes.push(outcome);
    if (outcome.causeKind !== 'success') {
      // Halt the plan on first failure so the operator decides whether to
      // resume. Synthesis is intentionally NOT attempted with partial data.
      return {
        subTaskOutcomes,
        synthesisOutcome: undefined,
        totalElapsedMs: now() - start,
        aggregatedReport: '',
        stoppedEarly: true,
      };
    }
  }

  const synthesisInstruction = applyOutputsToken(
    plan.synthesis.instructionTemplate,
    subTaskOutcomes,
  );
  const synthesisOutcome = await runOneDispatch(
    driver,
    {
      taskId: plan.synthesis.taskId,
      instruction: synthesisInstruction,
      ...(plan.synthesis.artifactLocation !== undefined
        ? { artifactLocation: plan.synthesis.artifactLocation }
        : {}),
      runtimeSettings: plan.runtimeSettings,
      resources: plan.resources,
    },
    approvalResponse,
    options.onEvent,
    mintInstanceId,
    nowIso,
  );

  return {
    subTaskOutcomes,
    synthesisOutcome,
    totalElapsedMs: now() - start,
    aggregatedReport: synthesisOutcome.finalText,
    stoppedEarly: synthesisOutcome.causeKind !== 'success',
  };
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

async function runOneDispatch(
  driver: RuntimeDriver,
  request: TaskRequest,
  approvalResponse: NonNullable<RunResearchPlanOptions['approvalResponse']>,
  onEvent: RunResearchPlanOptions['onEvent'],
  mintInstanceId: (subTaskId: string) => string,
  nowIso: () => string,
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
    result = await driver.run(context);
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
