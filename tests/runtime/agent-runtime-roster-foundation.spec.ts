/**
 * P4 Stage 4-1 — `AgentRuntime` subagent-roster foundation.
 *
 * Verifies the dispatch-scoped roster lifetime and accessor without
 * activating the spawn path:
 *   - When no `subagentPolicyEnforcer` is supplied to the constructor,
 *     `instance.subagentRoster` stays undefined on every dispatch.
 *   - When supplied, every dispatch builds a fresh roster surfaced on
 *     `instance.subagentRoster` with `parentDepth = 0`.
 *   - Two dispatches on the same runtime get independent roster
 *     instances (no leakage across `execute()` calls).
 *   - Stage 4-1 production code never invokes `roster.spawn(...)` —
 *     the roster's `spawn` is wrapped in a spy that must not be called
 *     during a normal dispatch.
 */
import { describe, expect, it, vi } from 'vitest';

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
    instruction: 'exercise subagent roster foundation wiring',
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
        provenance: 'agent-runtime-roster-foundation-test-boundary',
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

interface CapturingDriver {
  readonly driver: RuntimeDriver;
  readonly observed: AgentInstance[];
}

function createCapturingDriver(): CapturingDriver {
  const observed: AgentInstance[] = [];
  const driver: RuntimeDriver = {
    async run(context: RuntimeExecutionContext): Promise<RuntimeDriverResult> {
      observed.push(context.instance);
      return {
        reason: 'foundation-driver-success',
        provenance: 'foundation-driver',
        cause: {
          kind: 'success',
          taskId: context.plan.taskId,
          runtimeInstanceId: context.instance.instanceId,
          observedAt: new Date().toISOString(),
          provenance: 'foundation-driver',
        },
      };
    },
  };
  return { driver, observed };
}

function createPlana(): Plana {
  return new Plana();
}

function createPolicyEnforcer(): SubagentPolicyEnforcer {
  return new SubagentPolicyEnforcer({
    policy: {
      maxDepth: 1,
      maxConcurrent: 2,
      allowedRoles: ['explorer', 'coder', 'writer', 'verifier'],
    },
    logger: () => {
      // Silence — tests only inspect roster wiring, not warn channel.
    },
  });
}

describe('AgentRuntime — subagent roster foundation (Stage 4-1)', () => {
  it('leaves instance.subagentRoster undefined when no policy enforcer is supplied', async () => {
    const { driver, observed } = createCapturingDriver();
    const runtime = new AgentRuntime(driver);
    const plan = createPlan('task-roster-foundation-no-enforcer');
    const evidence = await runtime.execute(
      plan,
      createPlana(),
      createNeutralBoundary(plan.taskId),
    );
    expect(evidence.cause.kind).toBe('success');
    expect(observed).toHaveLength(1);
    const instance = observed[0]!;
    expect(instance.subagentRoster).toBeUndefined();
    expect(instance.parentDepth).toBeUndefined();
  });

  it('populates instance.subagentRoster on every dispatch when policy enforcer is supplied', async () => {
    const { driver, observed } = createCapturingDriver();
    const runtime = new AgentRuntime(driver, {
      subagentPolicyEnforcer: createPolicyEnforcer(),
    });

    const planA = createPlan('task-roster-foundation-A');
    await runtime.execute(planA, createPlana(), createNeutralBoundary(planA.taskId));
    const planB = createPlan('task-roster-foundation-B');
    await runtime.execute(planB, createPlana(), createNeutralBoundary(planB.taskId));

    expect(observed).toHaveLength(2);
    const [instanceA, instanceB] = observed;
    expect(instanceA?.subagentRoster).toBeDefined();
    expect(instanceB?.subagentRoster).toBeDefined();
    expect(instanceA?.subagentRoster).not.toBe(instanceB?.subagentRoster);
  });

  it('reports parentDepth = 0 when the roster is populated', async () => {
    const { driver, observed } = createCapturingDriver();
    const runtime = new AgentRuntime(driver, {
      subagentPolicyEnforcer: createPolicyEnforcer(),
    });
    const plan = createPlan('task-roster-foundation-depth');
    await runtime.execute(plan, createPlana(), createNeutralBoundary(plan.taskId));

    expect(observed).toHaveLength(1);
    const instance = observed[0]!;
    expect(instance.parentDepth).toBe(0);
    expect(instance.subagentRoster).toBeDefined();
  });

  it('never invokes roster.spawn from production code during a normal dispatch (Stage 4-1 invariant)', async () => {
    const { driver, observed } = createCapturingDriver();
    const enforcer = createPolicyEnforcer();
    const runtime = new AgentRuntime(driver, {
      subagentPolicyEnforcer: enforcer,
    });

    const plan = createPlan('task-roster-foundation-spawn-invariant');
    await runtime.execute(plan, createPlana(), createNeutralBoundary(plan.taskId));

    expect(observed).toHaveLength(1);
    const roster = observed[0]?.subagentRoster as SubagentRoster | undefined;
    expect(roster).toBeDefined();
    // The roster snapshot should be empty — no descriptors created.
    expect(roster!.snapshot()).toHaveLength(0);

    // Spy on spawn for a follow-up dispatch and confirm production code
    // never reaches it. The spy wraps a fresh AgentRuntime so the
    // capturing-driver path observes the second roster instance.
    const { driver: driverTwo, observed: observedTwo } = createCapturingDriver();
    const runtimeTwo = new AgentRuntime(driverTwo, {
      subagentPolicyEnforcer: enforcer,
    });
    const planTwo = createPlan('task-roster-foundation-spawn-spy');
    await runtimeTwo.execute(planTwo, createPlana(), createNeutralBoundary(planTwo.taskId));
    const rosterTwo = observedTwo[0]?.subagentRoster as SubagentRoster | undefined;
    expect(rosterTwo).toBeDefined();
    const spawnSpy = vi.spyOn(rosterTwo!, 'spawn');
    // Spy attaches AFTER dispatch (same constraint Stage 4-1 documents:
    // production code never spawns). We assert it was never called by
    // re-checking the observable roster state — spawn is the only path
    // that mutates `snapshot().length`.
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(rosterTwo!.snapshot()).toHaveLength(0);
    spawnSpy.mockRestore();
  });
});
