/**
 * P4 Stage 4-6 — `createResearchPlanRunChild(driver)` helper unit
 * tests. Verifies that the helper-produced `runChild` callback:
 *
 *   - Delegates to `driver.run(childContext)` exactly once per call.
 *   - Mints a child task-id with the `${parentTaskId}.sub-${subagentId}`
 *     format that operators can correlate against `/subagents list`.
 *   - Returns a `RunChildHandle` whose `result` resolves with the
 *     driver's result and whose `cancel(...)` flips the child's
 *     `isAborted()` to true.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createResearchPlanRunChild,
  formatChildTaskId,
} from '../../src/runtime/research-plan-roster-helpers.js';
import type {
  RuntimeDriver,
  RuntimeExecutionContext,
} from '../../src/contracts/runtime-driver.js';
import type { SubagentDescriptor } from '../../src/contracts/subagent-roster.js';

function makeDescriptor(
  subagentId: string,
  parentTaskId: string,
  parentInstanceId: string,
): SubagentDescriptor {
  return {
    subagentId,
    role: 'explorer',
    parent: { taskId: parentTaskId, instanceId: parentInstanceId },
    createdAt: new Date().toISOString(),
    state: 'active',
    envelope: {
      requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
      effective: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
    } as never,
  };
}

describe('createResearchPlanRunChild', () => {
  it('delegates to driver.run with a child RuntimeExecutionContext that uses the parent.sub-<subagentId> task-id', async () => {
    const captured: { context?: RuntimeExecutionContext } = {};
    const run = vi.fn(async (context: RuntimeExecutionContext) => {
      captured.context = context;
      return {
        cause: { kind: 'success' as const },
        provenance: 'driver-stub',
        reason: 'ok',
      };
    });
    const driver = { run } as unknown as RuntimeDriver;
    const runChild = createResearchPlanRunChild(driver);
    const handle = await runChild({
      descriptor: makeDescriptor('subagent-7', 'plan-task-1', 'plan-instance-1'),
      instruction: 'do the thing',
      parentContext: { taskId: 'plan-task-1', instanceId: 'plan-instance-1' },
    });
    const result = await handle.result;
    expect(run).toHaveBeenCalledTimes(1);
    expect(captured.context).toBeDefined();
    expect(captured.context!.plan.taskId).toBe('plan-task-1.sub-subagent-7');
    expect(captured.context!.instance.taskId).toBe('plan-task-1.sub-subagent-7');
    expect(captured.context!.plan.instruction).toBe('do the thing');
    expect(result.cause.kind).toBe('success');
  });

  it('formatChildTaskId produces the same shape used by the runChild callback (operators can predict child task ids)', () => {
    expect(formatChildTaskId('parent-1', 'subagent-3')).toBe('parent-1.sub-subagent-3');
    expect(formatChildTaskId('research-plan-cli', 'subagent-1')).toBe(
      'research-plan-cli.sub-subagent-1',
    );
  });

  it('cancel(reason) on the returned handle flips the child context isAborted() to true', async () => {
    // Use a "gated" driver that records the context and then waits on
    // a deferred promise so we can call handle.cancel() during the
    // gap. Verifying isAborted() flips from false→true across the
    // cancel proves the per-child AbortController is wired correctly.
    let release: () => void = () => {
      // initialised below
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let isAbortedBefore = true;
    let isAbortedAfter = false;
    const run = vi.fn(async (context: RuntimeExecutionContext) => {
      isAbortedBefore = context.isAborted();
      await gate;
      isAbortedAfter = context.isAborted();
      return {
        cause: { kind: 'success' as const },
        provenance: 'driver-stub',
        reason: 'ok',
      };
    });
    const driver = { run } as unknown as RuntimeDriver;
    const runChild = createResearchPlanRunChild(driver);
    const handle = await runChild({
      descriptor: makeDescriptor('subagent-10', 'plan-3', 'plan-3-instance'),
      instruction: 'watch',
      parentContext: { taskId: 'plan-3', instanceId: 'plan-3-instance' },
    });
    // Yield once so the gated run has a chance to read isAborted()
    // before we cancel.
    await Promise.resolve();
    handle.cancel('test cancel');
    release();
    await handle.result;
    expect(isAbortedBefore).toBe(false);
    expect(isAbortedAfter).toBe(true);
  });

  it('builds a child instance with parentDepth=1 (no grandchildren) and a parent-derived instance-id', async () => {
    const captured: { context?: RuntimeExecutionContext } = {};
    const run = vi.fn(async (context: RuntimeExecutionContext) => {
      captured.context = context;
      return {
        cause: { kind: 'success' as const },
        provenance: 'driver-stub',
        reason: 'ok',
      };
    });
    const driver = { run } as unknown as RuntimeDriver;
    const runChild = createResearchPlanRunChild(driver);
    const handle = await runChild({
      descriptor: makeDescriptor('subagent-1', 'parent-task', 'parent-inst'),
      instruction: 'do',
      parentContext: { taskId: 'parent-task', instanceId: 'parent-inst' },
    });
    await handle.result;
    expect(captured.context!.instance.parentDepth).toBe(1);
    expect(captured.context!.instance.instanceId).toContain(
      'parent-task.sub-subagent-1',
    );
  });
});
