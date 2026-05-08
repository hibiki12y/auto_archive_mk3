/**
 * P4 Stage 4-5 (Commit 2) — `AgentRuntime` returns a `RunChildHandle`
 * with a per-child `AbortController` so the operator surface (via
 * `roster.cancelActive(...)`) can cancel an in-flight child without
 * aborting the parent dispatch.
 *
 * Verifies:
 *   - Per-child cancel: while the child driver is polling `isAborted()`,
 *     calling `roster.cancelActive(subagentId, ...)` flips the child's
 *     `isAborted()` to true. The child driver exits via that path and
 *     surfaces a runtime-veto cause; the parent dispatch is unaffected
 *     (its terminal cause stays as a normal success).
 *   - Parent-abort cascades to the child (Stage 4-4 regression). When
 *     the parent's terminal-cause latch flips, the child's
 *     `isAborted()` ALSO flips even though the per-child controller
 *     was never aborted directly. This is the legacy invariant the
 *     Stage 4-5 changes must preserve.
 *   - Per-child cancel does NOT abort the parent: after a per-child
 *     cancel, the parent's `currentTerminalCause()` remains undefined
 *     until the parent's own driver terminates.
 */
import { describe, expect, it } from 'vitest';

import type {
  AgentInstance,
  RuntimeCancellationBoundary,
  RuntimeDriver,
  RuntimeDriverResult,
  RuntimeExecutionContext,
  RuntimeTerminalCause,
} from '../../src/contracts/runtime-driver.js';
import { Plana } from '../../src/core/plana.js';
import { createDispatchPlan } from '../../src/core/task.js';
import { AgentRuntime } from '../../src/runtime/agent-runtime.js';
import { SubagentPolicyEnforcer } from '../../src/runtime/subagent-policy-enforcer.js';

function createPlan(taskId: string) {
  return createDispatchPlan({
    taskId,
    instruction: 'parent: orchestrate a child via spawnAndRun (cancel test)',
    resources: {
      requested: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
    },
    runtimeSettings: {
      networkProfile: 'provider-only',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    },
  });
}

function createNeutralBoundary(taskId: string): RuntimeCancellationBoundary & {
  forceLatchVeto: (reason: string) => void;
} {
  let terminalCause: RuntimeTerminalCause | undefined;
  return {
    cancel(veto) {
      const receipt = {
        taskId,
        reason: veto.reason,
        provenance: 'agent-runtime-spawn-cancel-test-boundary',
        requestedAt: new Date().toISOString(),
      };
      terminalCause ??= { kind: 'external-cancel', ...receipt };
      return receipt;
    },
    latchRuntimeVeto(veto) {
      const cause: RuntimeTerminalCause = {
        kind: 'runtime-veto',
        taskId,
        reason: veto.reason,
        provenance: veto.provenance,
        requestedAt: new Date().toISOString(),
        veto,
      };
      terminalCause ??= cause;
      return cause;
    },
    currentTerminalCause: () =>
      terminalCause === undefined ? undefined : { ...terminalCause },
    // Test helper: force the latch to flip (without going through the
    // public `cancel` / `latchRuntimeVeto` ports) so we can simulate
    // the parent's termination latch firing while the child is still
    // mid-flight in its `isAborted()` poll loop. The actual latch
    // shape mirrors `latchRuntimeVeto`.
    forceLatchVeto(reason: string) {
      terminalCause ??= {
        kind: 'runtime-veto',
        taskId,
        reason,
        provenance: 'spawn-cancel-test',
        requestedAt: new Date().toISOString(),
        veto: {
          origin: 'runtime',
          reason,
          provenance: 'spawn-cancel-test',
          propagation: {
            blocksSubmission: false,
            requestsCancellation: true,
            requestsTermination: true,
          },
        },
      };
    },
  };
}

function createPolicyEnforcer(): SubagentPolicyEnforcer {
  return new SubagentPolicyEnforcer({
    policy: {
      maxDepth: 1,
      maxConcurrent: 2,
      allowedRoles: ['explorer', 'coder', 'writer', 'verifier'],
    },
    logger: () => {
      // Silence test logger.
    },
  });
}

/**
 * A driver that on the parent path drives a child via `spawnAndRun`
 * and on the child path enters a polling loop that watches
 * `isAborted()`. The child resolves with a runtime-veto result when
 * the abort is observed (so the roster maps it to subagent.aborted).
 *
 * `parentTrigger` is a hook that runs on the parent path AFTER the
 * child has been kicked off but BEFORE the parent awaits the child's
 * result. Tests use it to call `roster.cancelActive(...)` or to
 * simulate a parent-abort latch flip mid-flight.
 */
function createDriverWithCancellableChild(options: {
  parentTrigger: (input: {
    parentInstance: AgentInstance;
    childPromise: Promise<unknown>;
  }) => Promise<void>;
}): {
  driver: RuntimeDriver;
  observed: AgentInstance[];
  childAborted: { value: boolean };
} {
  const observed: AgentInstance[] = [];
  const childAborted = { value: false };
  const driver: RuntimeDriver = {
    async run(context: RuntimeExecutionContext): Promise<RuntimeDriverResult> {
      observed.push(context.instance);
      const isChild = context.instance.subagentRoster === undefined;
      if (isChild) {
        // Child polls isAborted. We yield via setTimeout(0) repeatedly
        // so the parent path has a chance to call cancelActive. After
        // up to 200 iterations we time out (test failure path).
        for (let i = 0; i < 200; i += 1) {
          if (context.isAborted()) {
            childAborted.value = true;
            return {
              reason: 'child-runtime-veto-from-abort',
              provenance: 'spawn-cancel-test-child-driver',
              cause: {
                kind: 'runtime-veto',
                taskId: context.plan.taskId,
                runtimeInstanceId: context.instance.instanceId,
                observedAt: new Date().toISOString(),
                provenance: 'spawn-cancel-test-child-driver',
                reason: 'child-isAborted',
                veto: {
                  origin: 'runtime',
                  reason: 'child-isAborted',
                  provenance: 'spawn-cancel-test-child-driver',
                  propagation: {
                    blocksSubmission: false,
                    requestsCancellation: true,
                    requestsTermination: true,
                  },
                },
                cancellation: {
                  requestedAt: new Date().toISOString(),
                  cancelMode: 'preemptive',
                  cancelDetail: { originPort: 'plana-runtime-review' },
                },
              },
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        // Never aborted — child finishes normally.
        return {
          reason: 'child-driver-success-no-abort',
          provenance: 'spawn-cancel-test-child-driver',
          cause: {
            kind: 'success',
            taskId: context.plan.taskId,
            runtimeInstanceId: context.instance.instanceId,
            observedAt: new Date().toISOString(),
            provenance: 'spawn-cancel-test-child-driver',
          },
        };
      }
      // Parent path.
      const roster = context.instance.subagentRoster;
      if (roster === undefined) {
        throw new Error('expected parent context to have a subagentRoster');
      }
      const childPromise = roster.spawnAndRun({
        options: { role: 'explorer' },
        instruction: 'cancel-test-child',
      });
      // Run the test-supplied trigger BEFORE awaiting the child.
      await options.parentTrigger({
        parentInstance: context.instance,
        childPromise,
      });
      try {
        await childPromise;
      } catch {
        // child rethrow — fall through to a parent success
      }
      return {
        reason: 'parent-driver-success',
        provenance: 'spawn-cancel-test-parent-driver',
        cause: {
          kind: 'success',
          taskId: context.plan.taskId,
          runtimeInstanceId: context.instance.instanceId,
          observedAt: new Date().toISOString(),
          provenance: 'spawn-cancel-test-parent-driver',
        },
      };
    },
  };
  return { driver, observed, childAborted };
}

describe('AgentRuntime — per-child cancel (Stage 4-5 Commit 2)', () => {
  it('roster.cancelActive flips the child isAborted() to true and the child exits', async () => {
    const { driver, observed, childAborted } = createDriverWithCancellableChild({
      async parentTrigger({ parentInstance }) {
        const roster = parentInstance.subagentRoster!;
        // Wait until the child has registered its handle; the roster
        // sets the active-handle entry synchronously after the child
        // promise resolves the runChild callback. A few microtask
        // yields are enough.
        for (let i = 0; i < 10; i += 1) {
          if (roster.cancelActive('subagent-1', 'op kill from test')) return;
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        throw new Error('cancelActive never returned true');
      },
    });
    const runtime = new AgentRuntime(driver, {
      subagentPolicyEnforcer: createPolicyEnforcer(),
    });
    const plan = createPlan('task-spawn-cancel-active');
    const evidence = await runtime.execute(
      plan,
      new Plana(),
      createNeutralBoundary(plan.taskId),
    );
    expect(observed).toHaveLength(2);
    expect(childAborted.value).toBe(true);
    // Parent's own terminal cause is still success: per-child cancel
    // did not poison the parent dispatch.
    expect(evidence.cause.kind).toBe('success');
  });

  it('parent abort still cascades to the child (Stage 4-4 regression)', async () => {
    const boundary = createNeutralBoundary('task-spawn-cancel-parent');
    const { driver, observed, childAborted } = createDriverWithCancellableChild({
      async parentTrigger() {
        // Force the parent's terminal-cause latch to flip mid-flight.
        // Stage 4-4's invariant: the child's isAborted() ORs in the
        // parent latch via `currentTerminalCause()`; my Stage 4-5
        // change must preserve this. The child poll loop should pick
        // it up on the next tick.
        boundary.forceLatchVeto('test-parent-abort');
      },
    });
    const runtime = new AgentRuntime(driver, {
      subagentPolicyEnforcer: createPolicyEnforcer(),
    });
    const plan = createPlan('task-spawn-cancel-parent');
    await runtime.execute(plan, new Plana(), boundary);
    expect(observed).toHaveLength(2);
    expect(childAborted.value).toBe(true);
  });

  it('per-child cancel does NOT abort the parent (parent latch stays clear)', async () => {
    const boundary = createNeutralBoundary('task-spawn-cancel-isolation');
    const { driver, observed, childAborted } = createDriverWithCancellableChild({
      async parentTrigger({ parentInstance }) {
        const roster = parentInstance.subagentRoster!;
        for (let i = 0; i < 10; i += 1) {
          if (roster.cancelActive('subagent-1', 'op kill from test')) {
            // After cancelActive succeeded, assert the parent's
            // terminal-cause boundary did NOT latch (per-child cancel
            // is isolated from the parent dispatch).
            expect(boundary.currentTerminalCause?.()).toBeUndefined();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        throw new Error('cancelActive never returned true');
      },
    });
    const runtime = new AgentRuntime(driver, {
      subagentPolicyEnforcer: createPolicyEnforcer(),
    });
    const plan = createPlan('task-spawn-cancel-isolation');
    const evidence = await runtime.execute(plan, new Plana(), boundary);
    expect(observed).toHaveLength(2);
    expect(childAborted.value).toBe(true);
    expect(evidence.cause.kind).toBe('success');
  });
});
