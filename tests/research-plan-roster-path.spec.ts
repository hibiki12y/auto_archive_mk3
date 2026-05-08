import { describe, expect, it, vi } from 'vitest';

import {
  RESEARCH_PLAN_SUBTASK_OUTPUTS_TOKEN,
  runResearchPlan,
  type ResearchPlan,
} from '../src/core/research-plan-orchestrator.js';
import type {
  RuntimeDriver,
  RuntimeExecutionContext,
} from '../src/contracts/runtime-driver.js';
import type {
  SubagentDescriptor,
  SubagentRunResult,
  SpawnOptions,
} from '../src/contracts/subagent-roster.js';
import type { SubagentRoster } from '../src/runtime/subagent-roster.js';

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
      { taskId: 'task-st1', instruction: 'sub-task 1' },
      { taskId: 'task-st2', instruction: 'sub-task 2' },
    ],
    synthesis: {
      taskId: 'task-synth',
      instructionTemplate: `Synth:\n${RESEARCH_PLAN_SUBTASK_OUTPUTS_TOKEN}\nDone`,
    },
    runtimeSettings: RUNTIME_SETTINGS,
    resources: RESOURCES,
    ...overrides,
  };
}

function makeBareDriver(): RuntimeDriver {
  const run = vi.fn(async (_context: RuntimeExecutionContext) => {
    return {
      cause: { kind: 'success' as const },
      provenance: 'driver-stub',
      reason: 'driver.run-was-called',
    };
  });
  return { run } as unknown as RuntimeDriver;
}

interface SpawnAndRunArgs {
  readonly options: SpawnOptions;
  readonly instruction: string;
}

interface StubRosterRecord {
  readonly calls: SpawnAndRunArgs[];
  readonly roster: SubagentRoster;
}

/**
 * Build a stub `SubagentRoster` whose `spawnAndRun` records each call and
 * returns a synthesized `SubagentRunResult`. The result's terminal cause is
 * configurable per-call via `causeBySubTaskId`. Unknown sub-task ids default
 * to a `success` cause.
 *
 * The stub does NOT exercise the real roster admission flow or the runChild
 * callback — Stage 4-6's orchestrator change is purely "if subagentRoster is
 * provided, route through spawnAndRun(...)", so the test verifies dispatch
 * routing only.
 */
function makeStubRoster(
  causeByInstruction: Record<string, { kind: string }> = {},
  failOnce?: { instruction: string; error: Error },
): StubRosterRecord {
  const calls: SpawnAndRunArgs[] = [];
  let failArmed = failOnce !== undefined;
  const spawnAndRun = vi.fn(async (input: SpawnAndRunArgs) => {
    calls.push(input);
    if (
      failArmed &&
      failOnce !== undefined &&
      input.instruction === failOnce.instruction
    ) {
      failArmed = false;
      throw failOnce.error;
    }
    const cause = causeByInstruction[input.instruction] ?? { kind: 'success' };
    const descriptor: SubagentDescriptor = {
      subagentId: `subagent-${calls.length}`,
      role: input.options.role,
      parent: { taskId: 'parent', instanceId: 'parent-instance' },
      createdAt: new Date().toISOString(),
      state: 'terminated',
      envelope: {
        requested: {
          cpuCores: 1,
          memoryMiB: 256,
          wallTimeSec: 60,
          gpuCards: 0,
        },
      } as never,
    };
    return {
      descriptor,
      result: {
        cause,
        provenance: 'roster-stub',
        reason: `roster-ran-${input.instruction}`,
      },
    } as unknown as SubagentRunResult;
  });
  const roster = {
    spawn: vi.fn(),
    spawnAndRun,
    terminate: vi.fn(),
    terminateAll: vi.fn(),
    cancelActive: vi.fn(() => false),
    events: (async function* () {
      // empty stream
    })(),
    snapshot: vi.fn(() => Object.freeze([])),
  } as unknown as SubagentRoster;
  return { calls, roster };
}

describe('runResearchPlan — Stage 4-6 roster path', () => {
  it('routes every sub-task and the synthesis through roster.spawnAndRun when subagentRoster is supplied', async () => {
    const driver = makeBareDriver();
    const { calls, roster } = makeStubRoster();
    const result = await runResearchPlan(driver, plan(), {
      subagentRoster: roster,
    });
    // 2 sub-tasks + 1 synthesis = 3 spawnAndRun calls; driver.run is never
    // invoked directly because the roster path replaces it.
    expect(calls).toHaveLength(3);
    expect((driver.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(calls[0].instruction).toBe('sub-task 1');
    expect(calls[1].instruction).toBe('sub-task 2');
    // The synthesis instruction has been interpolated and is the third call.
    expect(calls[2].instruction).toContain('Synth:');
    // Default role is 'explorer'.
    expect(calls.every((c) => c.options.role === 'explorer')).toBe(true);
    // Outcomes carry the success cause from the stub.
    expect(result.subTaskOutcomes.map((o) => o.causeKind)).toEqual([
      'success',
      'success',
    ]);
    expect(result.synthesisOutcome?.causeKind).toBe('success');
    expect(result.stoppedEarly).toBe(false);
  });

  it('preserves backward compatibility — without subagentRoster the orchestrator calls driver.run directly', async () => {
    const driver = makeBareDriver();
    const { calls, roster } = makeStubRoster();
    const result = await runResearchPlan(driver, plan());
    // Roster was constructed but never wired in via options → it must NOT
    // be touched. The orchestrator's pre-Stage-4-6 behaviour is unchanged.
    expect(calls).toHaveLength(0);
    expect(
      (roster.spawnAndRun as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
    expect((driver.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    expect(result.subTaskOutcomes.map((o) => o.causeKind)).toEqual([
      'success',
      'success',
    ]);
    expect(result.synthesisOutcome?.causeKind).toBe('success');
  });

  it('captures driverThrew when roster.spawnAndRun rejects on a sub-task (mirrors driver.run path)', async () => {
    const driver = makeBareDriver();
    const { calls, roster } = makeStubRoster({}, {
      instruction: 'sub-task 1',
      error: new Error('roster-blew-up'),
    });
    const result = await runResearchPlan(driver, plan(), {
      subagentRoster: roster,
    });
    expect(calls).toHaveLength(1);
    expect(result.subTaskOutcomes).toHaveLength(1);
    const failed = result.subTaskOutcomes[0];
    expect(failed.causeKind).toBe('driver-threw');
    expect(failed.driverThrew).toContain('roster-blew-up');
    // Plan halts early — no synthesis.
    expect(result.synthesisOutcome).toBeUndefined();
    expect(result.stoppedEarly).toBe(true);
  });

  it('threads every dispatch through the SAME shared roster instance (one unit per /subagents list)', async () => {
    const driver = makeBareDriver();
    const { roster } = makeStubRoster();
    const wrappedSpawn = roster.spawnAndRun as ReturnType<typeof vi.fn>;
    await runResearchPlan(driver, plan(), { subagentRoster: roster });
    // Every call landed on the same vi.fn instance (we never replaced the
    // roster between sub-tasks). vi.fn does not expose mock.instances for
    // arrow callbacks, but the call count equality + the fact that calls[]
    // captured every input is sufficient evidence the roster is shared.
    expect(wrappedSpawn.mock.calls).toHaveLength(3);
    // Verify no per-sub-task roster swap happened by checking that
    // spawnAndRun's `this` bind is the same across calls when the
    // implementation captures it. We sample first and last only — a
    // full deep-equal would require exposing internals.
    const firstThis = wrappedSpawn.mock.contexts[0];
    const lastThis = wrappedSpawn.mock.contexts[2];
    expect(firstThis).toBe(lastThis);
  });

  it('honours an explicit subagentRole override', async () => {
    const driver = makeBareDriver();
    const { calls, roster } = makeStubRoster();
    await runResearchPlan(driver, plan(), {
      subagentRoster: roster,
      subagentRole: 'verifier',
    });
    expect(calls.every((c) => c.options.role === 'verifier')).toBe(true);
  });
});
