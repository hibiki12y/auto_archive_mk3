/**
 * P4 Stage 4-4 — `AgentRuntime` spawn-path activation.
 *
 * Verifies that when `AgentRuntime` is constructed with a
 * `SubagentPolicyEnforcer`, `instance.subagentRoster.spawnAndRun(...)`
 * routes a child runtime through the parent's RuntimeDriver:
 *
 *   - Round-trip happy path: spawnAndRun returns a SubagentRunResult
 *     whose `result.cause.kind === 'success'`, and the capturing
 *     driver observes both parent + child invocations.
 *   - Child task-id format is `${parentTaskId}.sub-${subagentId}` —
 *     deterministic and parseable.
 *   - Child instance does NOT carry its own subagentRoster
 *     (depth cap = 1; no grandchildren).
 *   - Child failure is propagated through spawnAndRun's rethrow path.
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
import type { SubagentRoster } from '../../src/runtime/subagent-roster.js';
import { Plana } from '../../src/core/plana.js';
import { createDispatchPlan } from '../../src/core/task.js';
import { AgentRuntime } from '../../src/runtime/agent-runtime.js';
import { SubagentPolicyEnforcer } from '../../src/runtime/subagent-policy-enforcer.js';

function createPlan(taskId: string) {
  return createDispatchPlan({
    taskId,
    instruction: 'parent: orchestrate a child via spawnAndRun',
    resources: {
      requested: {
        cpuCores: 1,
        memoryMiB: 512,
        wallTimeSec: 60,
        gpuCards: 0,
      },
    },
    runtimeSettings: {
      networkProfile: 'provider-only',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    },
  });
}

function createNeutralBoundary(taskId: string): RuntimeCancellationBoundary {
  let terminalCause: RuntimeTerminalCause | undefined;
  return {
    cancel(veto) {
      const receipt = {
        taskId,
        reason: veto.reason,
        provenance: 'agent-runtime-spawn-path-test-boundary',
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
      // Silence — these tests only assert spawn-path wiring.
    },
  });
}

interface ChildAwareDriver {
  readonly driver: RuntimeDriver;
  readonly observed: AgentInstance[];
  readonly contexts: RuntimeExecutionContext[];
}

/**
 * Driver stub that:
 *  - On the parent invocation: drives one `spawnAndRun(...)` against
 *    the parent's `instance.subagentRoster`, then returns success.
 *  - On the child invocation: returns the configured cause (success
 *    by default, or the cause supplied via the second argument).
 *
 * The driver receives BOTH parent and child contexts; it distinguishes
 * by the presence of `instance.subagentRoster` (only the parent has
 * one — Stage 4-4 explicitly forbids grandchildren).
 */
function createChildAwareDriver(options: {
  childInstruction: string;
  childCause?: 'success' | 'provider-failure' | 'throw';
}): ChildAwareDriver {
  const observed: AgentInstance[] = [];
  const contexts: RuntimeExecutionContext[] = [];
  const driver: RuntimeDriver = {
    async run(context: RuntimeExecutionContext): Promise<RuntimeDriverResult> {
      observed.push(context.instance);
      contexts.push(context);

      const isChild = context.instance.subagentRoster === undefined;
      if (!isChild) {
        // Parent path: drive a child via spawnAndRun.
        const roster = context.instance.subagentRoster;
        if (roster === undefined) {
          throw new Error('expected parent context to have a subagentRoster');
        }
        try {
          const out = await roster.spawnAndRun({
            options: { role: 'explorer' },
            instruction: options.childInstruction,
          });
          // Echo the child cause back via a parent-level success.
          return {
            reason: 'parent-driver-success-after-child',
            provenance: 'spawn-path-test-driver',
            cause: {
              kind: 'success',
              taskId: context.plan.taskId,
              runtimeInstanceId: context.instance.instanceId,
              observedAt: new Date().toISOString(),
              provenance: 'spawn-path-test-driver',
              artifactLocation: out.descriptor.subagentId,
            },
          };
        } catch {
          // Translate a child failure into a parent provider-failure
          // so the dispatch finalizes (otherwise the runtime stalls).
          return {
            reason: 'parent-driver-success-after-child-failure',
            provenance: 'spawn-path-test-driver',
            cause: {
              kind: 'success',
              taskId: context.plan.taskId,
              runtimeInstanceId: context.instance.instanceId,
              observedAt: new Date().toISOString(),
              provenance: 'spawn-path-test-driver',
              artifactLocation: 'child-rethrew',
            },
          };
        }
      }

      // Child path.
      if (options.childCause === 'throw') {
        throw new Error('child-driver-blew-up');
      }
      if (options.childCause === 'provider-failure') {
        return {
          reason: 'child-driver-provider-failure',
          provenance: 'spawn-path-test-child-driver',
          cause: {
            kind: 'provider-failure',
            taskId: context.plan.taskId,
            runtimeInstanceId: context.instance.instanceId,
            observedAt: new Date().toISOString(),
            provenance: 'spawn-path-test-child-driver',
            provider: 'codex',
            classification: 'unknown',
            retryable: false,
            message: 'simulated child provider-failure',
          },
        };
      }
      return {
        reason: 'child-driver-success',
        provenance: 'spawn-path-test-child-driver',
        cause: {
          kind: 'success',
          taskId: context.plan.taskId,
          runtimeInstanceId: context.instance.instanceId,
          observedAt: new Date().toISOString(),
          provenance: 'spawn-path-test-child-driver',
        },
      };
    },
  };
  return { driver, observed, contexts };
}

function createPlana(): Plana {
  return new Plana();
}

describe('AgentRuntime — spawn path (Stage 4-4)', () => {
  it('routes spawnAndRun through the parent driver and returns a successful child result', async () => {
    const { driver, observed, contexts } = createChildAwareDriver({
      childInstruction: 'reply with a one-line greeting',
      childCause: 'success',
    });
    const runtime = new AgentRuntime(driver, {
      subagentPolicyEnforcer: createPolicyEnforcer(),
    });
    const plan = createPlan('task-spawn-path-success');

    const evidence = await runtime.execute(
      plan,
      createPlana(),
      createNeutralBoundary(plan.taskId),
    );

    expect(evidence.cause.kind).toBe('success');
    // Both parent + child were driven by the SAME RuntimeDriver
    // instance (Stage 4-4 architectural pre-decision: same driver
    // reused, no per-child driver pool).
    expect(observed).toHaveLength(2);
    const [parentCtx, childCtx] = contexts;
    expect(parentCtx?.instance.subagentRoster).toBeDefined();
    // The first observed context was the parent (it has a roster);
    // the second was the child (no roster, since depth cap = 1).
    expect(childCtx?.instance.subagentRoster).toBeUndefined();
  });

  it('builds the child task-id with the deterministic ${parentTaskId}.sub-${subagentId} format', async () => {
    const { driver, contexts } = createChildAwareDriver({
      childInstruction: 'inspect-task-id',
      childCause: 'success',
    });
    const runtime = new AgentRuntime(driver, {
      subagentPolicyEnforcer: createPolicyEnforcer(),
    });
    const plan = createPlan('task-spawn-path-task-id');
    await runtime.execute(plan, createPlana(), createNeutralBoundary(plan.taskId));

    expect(contexts).toHaveLength(2);
    const childCtx = contexts[1]!;
    // The child plan's taskId is the parent's plan id with the
    // descriptor's subagent id appended via `.sub-`.
    expect(childCtx.plan.taskId).toBe(`${plan.taskId}.sub-subagent-1`);
    // The child's instanceId follows the existing AgentRuntime
    // pattern: `agent-${childTaskId}-${childStartedAt}`.
    expect(childCtx.instance.instanceId.startsWith(
      `agent-${plan.taskId}.sub-subagent-1-`,
    )).toBe(true);
  });

  it('marks the child instance with parentDepth=1 and no subagentRoster (no grandchildren)', async () => {
    const { driver, observed } = createChildAwareDriver({
      childInstruction: 'inspect-instance',
      childCause: 'success',
    });
    const runtime = new AgentRuntime(driver, {
      subagentPolicyEnforcer: createPolicyEnforcer(),
    });
    const plan = createPlan('task-spawn-path-no-grandchildren');
    await runtime.execute(plan, createPlana(), createNeutralBoundary(plan.taskId));

    expect(observed).toHaveLength(2);
    const parentInstance = observed[0]!;
    const childInstance = observed[1]!;

    expect(parentInstance.subagentRoster).toBeDefined();
    expect(parentInstance.parentDepth).toBe(0);

    // Stage 4-4 invariant: the child has no roster of its own. The
    // depth cap is enforced by SubagentPolicyEnforcer (maxDepth = 1
    // by default) which is consulted with `depth = parentDepth + 1`,
    // but Stage 4-4 wires this defense-in-depth at the AgentRuntime
    // boundary too — the child's AgentInstance simply omits the
    // roster, so any `child.instance.subagentRoster?.spawn(...)` is
    // a no-op (undefined chain).
    expect(childInstance.subagentRoster).toBeUndefined();
    expect(childInstance.parentDepth).toBe(1);

    // Belt-and-suspenders sanity: the SubagentRoster type would let
    // a misuser cast and call spawn, but the runtime never gives
    // them one to cast. Confirm by direct identity check.
    const childRoster: SubagentRoster | undefined =
      childInstance.subagentRoster;
    expect(childRoster).toBeUndefined();
  });

  it('propagates a thrown child runtime error through spawnAndRun (rethrow path)', async () => {
    const { driver, observed } = createChildAwareDriver({
      childInstruction: 'will-throw',
      childCause: 'throw',
    });
    const runtime = new AgentRuntime(driver, {
      subagentPolicyEnforcer: createPolicyEnforcer(),
    });
    const plan = createPlan('task-spawn-path-child-throws');
    const evidence = await runtime.execute(
      plan,
      createPlana(),
      createNeutralBoundary(plan.taskId),
    );
    // The driver-stub catches the rethrow internally and finalizes
    // the parent dispatch with a success — the assertion here is
    // that the rethrow happened (visible in the contexts: the parent
    // returned its "success-after-child-failure" branch only when
    // spawnAndRun rejected).
    expect(observed).toHaveLength(2);
    expect(evidence.cause.kind).toBe('success');
    // The parent driver's artifact-location encodes the rethrow path
    // (set in the test driver's catch branch) for an assertion handle.
    if (evidence.cause.kind === 'success') {
      expect(evidence.cause.artifactLocation).toBe('child-rethrew');
    }
  });
});
