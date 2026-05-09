import { describe, expect, it, vi } from 'vitest';

import {
  RESEARCH_PLAN_SUBTASK_OUTPUTS_TOKEN,
  runResearchPlan,
  type ResearchPlan,
  type ResearchPlanApprovalGate,
  type ResearchPlanApprovalGateOutcome,
} from '../src/core/research-plan-orchestrator.js';
import type {
  RuntimeDriver,
  RuntimeDriverResult,
  RuntimeExecutionContext,
} from '../src/contracts/runtime-driver.js';

// UX-16 — opt-in pre-dispatch approval gate. The orchestrator gains an
// `approvalGate?: ResearchPlanApprovalGate` option. When provided, the
// gate fires once BEFORE the first sub-task and blocks every dispatch
// until the gate resolves. On approve → run proceeds. On deny / expire
// → return a clean stoppedEarly result with NO sub-tasks attempted, NO
// synthesis, and `skippedSubTaskIds` listing every sub-task plus the
// synthesis. Default (no gate option) preserves the legacy behaviour
// bit-for-bit so non-opt-in callers see no change.

const RUNTIME_SETTINGS = {
  networkProfile: 'provider-only',
  sandboxMode: 'workspace-write',
  approvalPolicy: 'on-request',
  workingDirectory: process.cwd(),
} as const;

const RESOURCES = {
  requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
};

function plan(overrides: Partial<ResearchPlan> = {}): ResearchPlan {
  return {
    subTasks: [
      { taskId: 'st-1', instruction: 'sub-task 1' },
      { taskId: 'st-2', instruction: 'sub-task 2' },
    ],
    synthesis: {
      taskId: 'synth-1',
      instructionTemplate: `Combine: ${RESEARCH_PLAN_SUBTASK_OUTPUTS_TOKEN} sentinel-OK`,
    },
    runtimeSettings: RUNTIME_SETTINGS,
    resources: RESOURCES,
    ...overrides,
  };
}

function makeDriver(): RuntimeDriver {
  const run = vi.fn(
    async (context: RuntimeExecutionContext): Promise<RuntimeDriverResult> => {
      await context.emit({
        kind: 'item.completed',
        item: { type: 'agent_message', text: `${context.plan.taskId}-out` },
      } as never);
      return {
        cause: {
          kind: 'success',
          taskId: context.plan.taskId,
          runtimeInstanceId: context.instance.instanceId,
          observedAt: new Date().toISOString(),
          provenance: 'stub',
        },
        provenance: 'stub',
        reason: `${context.plan.taskId}-ok`,
      };
    },
  );
  return { run };
}

function constantGate(
  outcome: ResearchPlanApprovalGateOutcome,
): ResearchPlanApprovalGate & { calls: number } {
  const gate = {
    calls: 0,
    async requestApproval(): Promise<ResearchPlanApprovalGateOutcome> {
      gate.calls += 1;
      return outcome;
    },
  };
  return gate;
}

describe('runResearchPlan approvalGate (UX-16)', () => {
  it('runs the plan unchanged when no gate is supplied (bit-stable default)', async () => {
    const driver = makeDriver();
    const result = await runResearchPlan(driver, plan());
    expect(driver.run).toHaveBeenCalledTimes(3); // 2 sub-tasks + synthesis
    expect(result.stoppedEarly).toBe(false);
    expect(result.subTaskOutcomes).toHaveLength(2);
    expect(result.synthesisOutcome).toBeDefined();
  });

  it('approves once and proceeds with the full plan', async () => {
    const driver = makeDriver();
    const gate = constantGate({ status: 'approved' });
    const result = await runResearchPlan(driver, plan(), { approvalGate: gate });
    expect(gate.calls).toBe(1);
    expect(driver.run).toHaveBeenCalledTimes(3);
    expect(result.stoppedEarly).toBe(false);
    expect(result.subTaskOutcomes).toHaveLength(2);
    expect(result.synthesisOutcome).toBeDefined();
  });

  it('halts the plan on deny BEFORE the first sub-task runs', async () => {
    const driver = makeDriver();
    const gate = constantGate({
      status: 'denied',
      reason: 'operator declined',
    });
    const result = await runResearchPlan(driver, plan(), { approvalGate: gate });
    expect(gate.calls).toBe(1);
    expect(driver.run).not.toHaveBeenCalled();
    expect(result.stoppedEarly).toBe(true);
    expect(result.subTaskOutcomes).toHaveLength(0);
    expect(result.synthesisOutcome).toBeUndefined();
    expect(result.partialSynthesis).toBe(false);
    expect(result.aggregatedReport).toBe('');
  });

  it('halts the plan on expire BEFORE the first sub-task runs', async () => {
    const driver = makeDriver();
    const gate = constantGate({ status: 'expired', reason: 'timeout' });
    const result = await runResearchPlan(driver, plan(), { approvalGate: gate });
    expect(gate.calls).toBe(1);
    expect(driver.run).not.toHaveBeenCalled();
    expect(result.stoppedEarly).toBe(true);
    expect(result.subTaskOutcomes).toHaveLength(0);
    expect(result.synthesisOutcome).toBeUndefined();
  });

  it('on deny, lists every sub-task AND the synthesis as skipped', async () => {
    const driver = makeDriver();
    const gate = constantGate({ status: 'denied' });
    const result = await runResearchPlan(driver, plan(), { approvalGate: gate });
    expect(result.skippedSubTaskIds).toEqual([
      'st-1',
      'st-2',
      'synth-1',
    ]);
  });

  it('passes plan metadata to the gate request payload', async () => {
    const driver = makeDriver();
    const seen: Array<{
      planSubTaskCount: number;
      synthesisTaskId: string;
      firstSubTaskId: string;
    }> = [];
    const result = await runResearchPlan(driver, plan(), {
      approvalGate: {
        async requestApproval(request) {
          seen.push({ ...request });
          return { status: 'approved' };
        },
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      planSubTaskCount: 2,
      synthesisTaskId: 'synth-1',
      firstSubTaskId: 'st-1',
    });
    expect(result.subTaskOutcomes).toHaveLength(2);
  });

  it('awaits the gate Promise (the gate can take an async pause)', async () => {
    const driver = makeDriver();
    let dispatchedAtGateResolution = false;
    const gate: ResearchPlanApprovalGate = {
      async requestApproval() {
        // After this Promise resolves the gate must NOT have dispatched
        // anything yet — runResearchPlan awaits the gate FIRST.
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            dispatchedAtGateResolution =
              (driver.run as unknown as { mock: { calls: unknown[] } }).mock
                .calls.length === 0;
            resolve();
          }, 5);
        });
        return { status: 'approved' };
      },
    };
    const result = await runResearchPlan(driver, plan(), { approvalGate: gate });
    expect(dispatchedAtGateResolution).toBe(true);
    expect(result.stoppedEarly).toBe(false);
    expect(driver.run).toHaveBeenCalledTimes(3);
  });
});
