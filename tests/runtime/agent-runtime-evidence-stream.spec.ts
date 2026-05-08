/**
 * P4 Stage 4-3 — `AgentRuntime` subagent roster evidence stream wiring.
 *
 * Verifies the optional `subagentEvidenceLedgerSink` consumer attached
 * to the dispatch-scoped roster event stream:
 *   - With no sink wired, dispatch lifecycle still completes cleanly
 *     and the swallow counter stays at 0.
 *   - With a sink wired, a synthetic spawn + terminate sequence on the
 *     dispatch's roster fan-outs every event to the sink in order.
 *   - A throwing sink does not destabilize dispatch and increments
 *     the cumulative `subagentEvidenceObserverErrorCount()`.
 *   - Each event is forwarded at most once even when many events are
 *     emitted in tight succession (no double-subscription).
 *
 * Stage 4-1 production code never invokes `roster.spawn(...)`, so the
 * event-fan-out tests deliberately call `roster.spawn` and
 * `roster.terminate` from within the capturing driver — mid-dispatch,
 * while the runtime's `for-await` consumer is live — to exercise the
 * subscription path against the real roster contract.
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
import type { RosterEvent } from '../../src/contracts/subagent-roster-event.js';
import type { SubagentRoster } from '../../src/runtime/subagent-roster.js';
import { Plana } from '../../src/core/plana.js';
import { createDispatchPlan } from '../../src/core/task.js';
import { AgentRuntime } from '../../src/runtime/agent-runtime.js';
import { SubagentPolicyEnforcer } from '../../src/runtime/subagent-policy-enforcer.js';

function createPlan(taskId: string) {
  return createDispatchPlan({
    taskId,
    instruction: 'exercise subagent evidence stream wiring',
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
        provenance: 'agent-runtime-evidence-stream-test-boundary',
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

interface PassThroughDriver {
  readonly driver: RuntimeDriver;
  readonly observed: AgentInstance[];
}

function createPassThroughDriver(
  beforeReturn?: (instance: AgentInstance) => void | Promise<void>,
): PassThroughDriver {
  const observed: AgentInstance[] = [];
  const driver: RuntimeDriver = {
    async run(context: RuntimeExecutionContext): Promise<RuntimeDriverResult> {
      observed.push(context.instance);
      if (beforeReturn !== undefined) {
        await beforeReturn(context.instance);
      }
      return {
        reason: 'evidence-stream-driver-success',
        provenance: 'evidence-stream-driver',
        cause: {
          kind: 'success',
          taskId: context.plan.taskId,
          runtimeInstanceId: context.instance.instanceId,
          observedAt: new Date().toISOString(),
          provenance: 'evidence-stream-driver',
        },
      };
    },
  };
  return { driver, observed };
}

function createPolicyEnforcer(): SubagentPolicyEnforcer {
  return new SubagentPolicyEnforcer({
    policy: {
      maxDepth: 1,
      maxConcurrent: 4,
      allowedRoles: ['explorer', 'coder', 'writer', 'verifier'],
    },
    logger: () => {
      // Silence; tests inspect the sink fan-out, not the warn channel.
    },
  });
}

async function flushMicrotasks(): Promise<void> {
  // The roster event stream is push-based and the for-await consumer
  // resolves through Promise microtasks. Awaiting setImmediate is the
  // simplest reliable way to let the consumer drain its current queue
  // before the test inspects the sink.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function emitSpawnAndTerminate(
  roster: SubagentRoster,
  role: 'explorer' | 'coder',
): Promise<void> {
  const descriptor = await roster.spawn({ role });
  // Allow the for-await consumer to drain the spawn event before we
  // fire the terminal one — otherwise both push() awaits stay queued
  // until iterator.next() pulls them, which is fine for correctness
  // but makes the per-event ordering observable for the assertions.
  await flushMicrotasks();
  await roster.terminate(descriptor.subagentId, {
    kind: 'success',
    taskId: descriptor.parent.taskId,
    runtimeInstanceId: descriptor.parent.instanceId,
    observedAt: new Date().toISOString(),
    provenance: 'agent-runtime-evidence-stream-test',
  });
  await flushMicrotasks();
}

describe('AgentRuntime — subagent roster evidence stream (Stage 4-3)', () => {
  it('completes dispatch cleanly when no sink is wired', async () => {
    const { driver } = createPassThroughDriver();
    const runtime = new AgentRuntime(driver, {
      subagentPolicyEnforcer: createPolicyEnforcer(),
    });
    const plan = createPlan('task-evidence-stream-no-sink');
    const evidence = await runtime.execute(
      plan,
      new Plana(),
      createNeutralBoundary(plan.taskId),
    );
    expect(evidence.cause.kind).toBe('success');
    expect(runtime.subagentEvidenceObserverErrorCount()).toBe(0);
  });

  it('forwards every roster lifecycle event to the wired sink in order', async () => {
    const sinkEvents: RosterEvent[] = [];
    const { driver } = createPassThroughDriver(async (instance) => {
      const roster = instance.subagentRoster;
      if (roster === undefined) {
        throw new Error('expected roster to be wired for this dispatch');
      }
      await emitSpawnAndTerminate(roster, 'explorer');
    });
    const runtime = new AgentRuntime(driver, {
      subagentPolicyEnforcer: createPolicyEnforcer(),
      subagentEvidenceLedgerSink: (event) => {
        sinkEvents.push(event);
      },
    });
    const plan = createPlan('task-evidence-stream-fanout');
    const evidence = await runtime.execute(
      plan,
      new Plana(),
      createNeutralBoundary(plan.taskId),
    );
    expect(evidence.cause.kind).toBe('success');

    // Expect at least: spawned, completed, roster.progress (terminate
    // emits the terminal event then a roster.progress sample).
    const kinds = sinkEvents.map((event) => event.kind);
    expect(kinds).toContain('subagent.spawned');
    expect(kinds).toContain('subagent.completed');
    expect(kinds).toContain('roster.progress');
    // Spawned must precede completed; completed must precede the final
    // roster.progress sample emitted from terminate().
    const spawnedIndex = kinds.indexOf('subagent.spawned');
    const completedIndex = kinds.indexOf('subagent.completed');
    const lastProgressIndex = kinds.lastIndexOf('roster.progress');
    expect(spawnedIndex).toBeLessThan(completedIndex);
    expect(completedIndex).toBeLessThan(lastProgressIndex);
    expect(runtime.subagentEvidenceObserverErrorCount()).toBe(0);
  });

  it('swallows sink errors and increments the observer error counter', async () => {
    const observed: RosterEvent[] = [];
    const { driver } = createPassThroughDriver(async (instance) => {
      const roster = instance.subagentRoster;
      if (roster === undefined) {
        throw new Error('expected roster to be wired for this dispatch');
      }
      await emitSpawnAndTerminate(roster, 'coder');
    });
    const runtime = new AgentRuntime(driver, {
      subagentPolicyEnforcer: createPolicyEnforcer(),
      subagentEvidenceLedgerSink: (event) => {
        observed.push(event);
        // Every invocation throws; the runtime must continue to drain
        // the stream and forward every subsequent event regardless.
        throw new Error('synthetic sink failure');
      },
    });
    expect(runtime.subagentEvidenceObserverErrorCount()).toBe(0);
    const plan = createPlan('task-evidence-stream-throwing-sink');
    const evidence = await runtime.execute(
      plan,
      new Plana(),
      createNeutralBoundary(plan.taskId),
    );
    expect(evidence.cause.kind).toBe('success');
    // Sink was invoked at least once per event we expect to observe.
    expect(observed.length).toBeGreaterThanOrEqual(3);
    expect(runtime.subagentEvidenceObserverErrorCount()).toBe(observed.length);
  });

  it('invokes the sink at most once per emitted event (no double-subscription)', async () => {
    const sinkInvocations: RosterEvent[] = [];
    const { driver } = createPassThroughDriver(async (instance) => {
      const roster = instance.subagentRoster;
      if (roster === undefined) {
        throw new Error('expected roster to be wired for this dispatch');
      }
      // Two independent spawn+terminate cycles on the same roster.
      await emitSpawnAndTerminate(roster, 'explorer');
      await emitSpawnAndTerminate(roster, 'coder');
    });
    const runtime = new AgentRuntime(driver, {
      subagentPolicyEnforcer: createPolicyEnforcer(),
      subagentEvidenceLedgerSink: (event) => {
        sinkInvocations.push(event);
      },
    });
    const plan = createPlan('task-evidence-stream-no-double-subscribe');
    await runtime.execute(
      plan,
      new Plana(),
      createNeutralBoundary(plan.taskId),
    );
    // Each emitted event maps to exactly one sink invocation. We assert
    // identity via reference: every reference appears at most once in
    // the captured array.
    const references = new Set<RosterEvent>();
    for (const event of sinkInvocations) {
      expect(references.has(event)).toBe(false);
      references.add(event);
    }
    // Expect 2 spawn events, 2 completed events, plus at least one
    // roster.progress sample per terminate (i.e. >= 6 total).
    expect(sinkInvocations.length).toBeGreaterThanOrEqual(6);
    const spawnedCount = sinkInvocations.filter(
      (event) => event.kind === 'subagent.spawned',
    ).length;
    const completedCount = sinkInvocations.filter(
      (event) => event.kind === 'subagent.completed',
    ).length;
    expect(spawnedCount).toBe(2);
    expect(completedCount).toBe(2);
    expect(runtime.subagentEvidenceObserverErrorCount()).toBe(0);
  });
});
