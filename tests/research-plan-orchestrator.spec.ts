import { describe, expect, it, vi } from 'vitest';

import {
  RESEARCH_PLAN_SUBTASK_OUTPUTS_TOKEN,
  mergeResources,
  mergeRuntimeSettings,
  runResearchPlan,
  type ResearchPlan,
} from '../src/core/research-plan-orchestrator.js';
import type {
  RuntimeDriver,
  RuntimeDriverResult,
  RuntimeExecutionContext,
} from '../src/contracts/runtime-driver.js';

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
      instructionTemplate: `Combine these:\n${RESEARCH_PLAN_SUBTASK_OUTPUTS_TOKEN}\nEnd with sentinel-OK`,
    },
    runtimeSettings: RUNTIME_SETTINGS,
    resources: RESOURCES,
    ...overrides,
  };
}

function makeDriver(
  emitsBySubTask: Record<string, Array<{ kind: string; item?: { type: string; text?: string; summary?: string } }>>,
  resultsBySubTask: Record<string, RuntimeDriverResult>,
): RuntimeDriver {
  const run = vi.fn(async (context: RuntimeExecutionContext) => {
    const id = context.plan.taskId;
    const emits = emitsBySubTask[id] ?? [];
    for (const e of emits) {
      await context.emit(e as never);
    }
    return resultsBySubTask[id] ?? {
      cause: { kind: 'success' as const },
      provenance: 'stub',
      reason: `${id}-ok`,
    };
  });
  return { run };
}

describe('runResearchPlan', () => {
  it('runs sub-tasks sequentially and aggregates outputs into synthesis', async () => {
    const driver = makeDriver(
      {
        'task-st1': [
          { kind: 'item.completed', item: { type: 'agent_message', text: 'st1-result' } },
        ],
        'task-st2': [
          { kind: 'item.completed', item: { type: 'agent_message', text: 'st2-result' } },
        ],
        'task-synth': [
          { kind: 'item.completed', item: { type: 'agent_message', text: 'final synthesis sentinel-OK' } },
        ],
      },
      {},
    );
    let synthesisInstruction = '';
    const wrappedRun = driver.run as unknown as ReturnType<typeof vi.fn>;
    wrappedRun.mockImplementation(async (context: RuntimeExecutionContext) => {
      const id = context.plan.taskId;
      if (id === 'task-synth') {
        synthesisInstruction = context.plan.instruction;
      }
      const emits =
        id === 'task-st1'
          ? [{ kind: 'item.completed', item: { type: 'agent_message', text: 'st1-result' } }]
          : id === 'task-st2'
            ? [{ kind: 'item.completed', item: { type: 'agent_message', text: 'st2-result' } }]
            : [{ kind: 'item.completed', item: { type: 'agent_message', text: 'final synthesis sentinel-OK' } }];
      for (const e of emits) await context.emit(e as never);
      return {
        cause: { kind: 'success' as const },
        provenance: 'stub',
        reason: `${id}-ok`,
      };
    });
    const result = await runResearchPlan(driver, plan());
    expect(driver.run).toHaveBeenCalledTimes(3);
    expect(result.subTaskOutcomes.map((o) => o.subTaskId)).toEqual([
      'task-st1',
      'task-st2',
    ]);
    expect(result.subTaskOutcomes[0].finalText).toBe('st1-result');
    expect(result.subTaskOutcomes[1].finalText).toBe('st2-result');
    expect(result.synthesisOutcome?.subTaskId).toBe('task-synth');
    expect(result.aggregatedReport).toBe('final synthesis sentinel-OK');
    expect(result.stoppedEarly).toBe(false);
    // The synthesis instruction must have the per-sub-task outputs interpolated.
    expect(synthesisInstruction).toContain('## subTaskId: task-st1');
    expect(synthesisInstruction).toContain('st1-result');
    expect(synthesisInstruction).toContain('## subTaskId: task-st2');
    expect(synthesisInstruction).toContain('st2-result');
  });

  it('halts the plan on first sub-task failure and never runs synthesis', async () => {
    const driver = makeDriver({}, {});
    const wrappedRun = driver.run as unknown as ReturnType<typeof vi.fn>;
    wrappedRun.mockImplementation(async (context: RuntimeExecutionContext) => {
      const id = context.plan.taskId;
      await context.emit({
        kind: 'item.completed',
        item: { type: 'agent_message', text: `${id}-output` },
      } as never);
      if (id === 'task-st1') {
        return {
          cause: {
            kind: 'provider-failure' as const,
            classification: 'rate_limit_exceeded',
            provider: 'codex',
          },
          provenance: 'stub',
          reason: 'st1-failed',
        };
      }
      return {
        cause: { kind: 'success' as const },
        provenance: 'stub',
        reason: 'never-reached',
      };
    });
    const result = await runResearchPlan(driver, plan());
    expect(driver.run).toHaveBeenCalledTimes(1);
    expect(result.subTaskOutcomes).toHaveLength(1);
    expect(result.subTaskOutcomes[0].causeKind).toBe('provider-failure');
    expect(result.synthesisOutcome).toBeUndefined();
    expect(result.aggregatedReport).toBe('');
    expect(result.stoppedEarly).toBe(true);
  });

  it('appends sub-task outputs to the synthesis prompt when the token is missing', async () => {
    const driver = makeDriver({}, {});
    const wrappedRun = driver.run as unknown as ReturnType<typeof vi.fn>;
    let synthesisInstruction = '';
    wrappedRun.mockImplementation(async (context: RuntimeExecutionContext) => {
      const id = context.plan.taskId;
      if (id === 'task-synth') synthesisInstruction = context.plan.instruction;
      await context.emit({
        kind: 'item.completed',
        item: { type: 'agent_message', text: `${id}-text` },
      } as never);
      return {
        cause: { kind: 'success' as const },
        provenance: 'stub',
        reason: 'ok',
      };
    });
    const result = await runResearchPlan(
      driver,
      plan({
        synthesis: {
          taskId: 'task-synth',
          instructionTemplate: 'Just synthesise. No token here.',
        },
      }),
    );
    expect(result.aggregatedReport).toBe('task-synth-text');
    expect(synthesisInstruction).toContain('--- sub-task outputs ---');
    expect(synthesisInstruction).toContain('## subTaskId: task-st1');
    expect(synthesisInstruction).toContain('task-st1-text');
  });

  it('streams events through the optional onEvent observer', async () => {
    const driver = makeDriver({}, {});
    const wrappedRun = driver.run as unknown as ReturnType<typeof vi.fn>;
    wrappedRun.mockImplementation(async (context: RuntimeExecutionContext) => {
      const id = context.plan.taskId;
      await context.emit({ kind: 'turn.started' } as never);
      await context.emit({
        kind: 'item.completed',
        item: { type: 'agent_message', text: `${id}-final` },
      } as never);
      return {
        cause: { kind: 'success' as const },
        provenance: 'stub',
        reason: 'ok',
      };
    });
    const observed: string[] = [];
    await runResearchPlan(driver, plan(), {
      onEvent: ({ subTaskId, event }) => {
        observed.push(`${subTaskId}:${event.kind}`);
      },
    });
    expect(observed.filter((s) => s.endsWith(':turn.started'))).toHaveLength(3);
    expect(observed.filter((s) => s.endsWith(':item.completed'))).toHaveLength(3);
  });

  it('counts tool-use items per sub-task', async () => {
    const driver = makeDriver({}, {});
    const wrappedRun = driver.run as unknown as ReturnType<typeof vi.fn>;
    wrappedRun.mockImplementation(async (context: RuntimeExecutionContext) => {
      const id = context.plan.taskId;
      if (id === 'task-st1') {
        await context.emit({
          kind: 'item.completed',
          item: { type: 'command_execution', summary: 'ls' },
        } as never);
        await context.emit({
          kind: 'item.completed',
          item: { type: 'command_execution', summary: 'cat' },
        } as never);
      }
      await context.emit({
        kind: 'item.completed',
        item: { type: 'agent_message', text: `${id}-final` },
      } as never);
      return {
        cause: { kind: 'success' as const },
        provenance: 'stub',
        reason: 'ok',
      };
    });
    const result = await runResearchPlan(driver, plan());
    expect(result.subTaskOutcomes[0].toolUseCount).toBe(2);
    expect(result.subTaskOutcomes[1].toolUseCount).toBe(0);
  });

  it('rejects an empty plan', async () => {
    const driver = makeDriver({}, {});
    await expect(
      runResearchPlan(
        driver,
        plan({ subTasks: [] }),
      ),
    ).rejects.toThrow(/at least one sub-task/);
  });

  it('retries a sub-task that fails on first attempt and recovers on the retry', async () => {
    const driver = makeDriver({}, {});
    const wrappedRun = driver.run as unknown as ReturnType<typeof vi.fn>;
    const callCounts: Record<string, number> = {};
    wrappedRun.mockImplementation(async (context: RuntimeExecutionContext) => {
      const id = context.plan.taskId;
      callCounts[id] = (callCounts[id] ?? 0) + 1;
      // task-st1 fails the first time, succeeds the second.
      if (id === 'task-st1' && callCounts[id] === 1) {
        return {
          cause: {
            kind: 'provider-failure' as const,
            classification: 'rate_limit_exceeded',
            provider: 'codex',
          },
          provenance: 'stub',
          reason: 'transient',
        };
      }
      await context.emit({
        kind: 'item.completed',
        item: { type: 'agent_message', text: `${id}-success` },
      } as never);
      return {
        cause: { kind: 'success' as const },
        provenance: 'stub',
        reason: 'ok',
      };
    });
    const onRetry = vi.fn();
    const result = await runResearchPlan(driver, plan(), {
      retryAttempts: 2,
      onRetry,
    });
    // task-st1 ran twice (1 fail + 1 retry success); task-st2 + synth ran once each.
    expect(callCounts['task-st1']).toBe(2);
    expect(callCounts['task-st2']).toBe(1);
    expect(callCounts['task-synth']).toBe(1);
    expect(result.stoppedEarly).toBe(false);
    expect(result.subTaskOutcomes[0].causeKind).toBe('success');
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        subTaskId: 'task-st1',
        attempt: 2,
        maxAttempts: 3,
        previousCauseKind: 'provider-failure',
      }),
    );
  });

  it('halts after retryAttempts is exhausted', async () => {
    const driver = makeDriver({}, {});
    const wrappedRun = driver.run as unknown as ReturnType<typeof vi.fn>;
    let calls = 0;
    wrappedRun.mockImplementation(async () => {
      calls += 1;
      throw new Error(`persistent boom ${calls}`);
    });
    const onRetry = vi.fn();
    const result = await runResearchPlan(driver, plan(), {
      retryAttempts: 2,
      onRetry,
    });
    // 1 first attempt + 2 retries = 3 calls on st1, then halt.
    expect(calls).toBe(3);
    expect(result.stoppedEarly).toBe(true);
    expect(result.subTaskOutcomes).toHaveLength(1);
    expect(result.subTaskOutcomes[0].causeKind).toBe('driver-threw');
    expect(result.subTaskOutcomes[0].driverThrew).toContain('persistent boom 3');
    // onRetry fires once per retry attempt (i.e. attempts 2 and 3, not 1).
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ attempt: 2, maxAttempts: 3 }),
    );
    expect(onRetry).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ attempt: 3, maxAttempts: 3 }),
    );
  });

  it('fast-fails on permanent-auth without further retry', async () => {
    const driver = makeDriver({}, {});
    const wrappedRun = driver.run as unknown as ReturnType<typeof vi.fn>;
    let calls = 0;
    wrappedRun.mockImplementation(async (context: RuntimeExecutionContext) => {
      calls += 1;
      const id = context.plan.taskId;
      await context.emit({
        kind: 'item.completed',
        item: { type: 'agent_message', text: `${id}-output` },
      } as never);
      return {
        cause: {
          kind: 'provider-failure' as const,
          classification: 'permanent-auth' as const,
          provider: 'codex' as const,
          message: 'invalid API key',
          retryable: false,
        },
        provenance: 'stub',
        reason: 'auth-fail',
      };
    });
    const onRetry = vi.fn();
    const result = await runResearchPlan(driver, plan(), {
      retryAttempts: 5,
      onRetry,
    });
    // Fast-fail: only 1 dispatch attempt despite retryAttempts=5.
    expect(calls).toBe(1);
    expect(result.stoppedEarly).toBe(true);
    expect(result.subTaskOutcomes).toHaveLength(1);
    expect(result.subTaskOutcomes[0].causeKind).toBe('provider-failure');
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        subTaskId: 'task-st1',
        previousCauseKind: 'provider-failure',
        previousCauseClassification: 'permanent-auth',
        previousCauseFastFailed: true,
      }),
    );
  });

  it('still retries on rate-limit transient up to retryAttempts', async () => {
    const driver = makeDriver({}, {});
    const wrappedRun = driver.run as unknown as ReturnType<typeof vi.fn>;
    const callCounts: Record<string, number> = {};
    wrappedRun.mockImplementation(async (context: RuntimeExecutionContext) => {
      const id = context.plan.taskId;
      callCounts[id] = (callCounts[id] ?? 0) + 1;
      // task-st1: persistently rate-limited (transient classification, so retry).
      if (id === 'task-st1') {
        return {
          cause: {
            kind: 'provider-failure' as const,
            classification: 'rate-limit' as const,
            provider: 'codex' as const,
            message: '429 Too Many Requests',
            retryable: true,
          },
          provenance: 'stub',
          reason: 'rate-limit',
        };
      }
      await context.emit({
        kind: 'item.completed',
        item: { type: 'agent_message', text: `${id}-success` },
      } as never);
      return {
        cause: { kind: 'success' as const },
        provenance: 'stub',
        reason: 'ok',
      };
    });
    const onRetry = vi.fn();
    const result = await runResearchPlan(driver, plan(), {
      retryAttempts: 2,
      onRetry,
    });
    // Rate-limit is transient, so all 3 attempts (1 + 2 retries) burned.
    expect(callCounts['task-st1']).toBe(3);
    expect(result.stoppedEarly).toBe(true);
    expect(result.subTaskOutcomes[0].causeKind).toBe('provider-failure');
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        previousCauseClassification: 'rate-limit',
        previousCauseFastFailed: false,
      }),
    );
  });

  it('marks stoppedEarly=true when synthesis itself fails', async () => {
    const driver = makeDriver({}, {});
    const wrappedRun = driver.run as unknown as ReturnType<typeof vi.fn>;
    wrappedRun.mockImplementation(async (context: RuntimeExecutionContext) => {
      const id = context.plan.taskId;
      await context.emit({
        kind: 'item.completed',
        item: { type: 'agent_message', text: `${id}-text` },
      } as never);
      if (id === 'task-synth') {
        return {
          cause: {
            kind: 'provider-failure' as const,
            classification: 'rate_limit_exceeded',
            provider: 'codex',
          },
          provenance: 'stub',
          reason: 'synth-failed',
        };
      }
      return {
        cause: { kind: 'success' as const },
        provenance: 'stub',
        reason: 'ok',
      };
    });
    const result = await runResearchPlan(driver, plan());
    expect(result.subTaskOutcomes).toHaveLength(2);
    expect(result.synthesisOutcome).toBeDefined();
    expect(result.synthesisOutcome?.causeKind).toBe('provider-failure');
    expect(result.stoppedEarly).toBe(true);
  });

  it('shallow-merges per-sub-task runtimeSettings + resources over plan defaults', async () => {
    const driver = makeDriver({}, {});
    const wrappedRun = driver.run as unknown as ReturnType<typeof vi.fn>;
    const observed: Array<{
      taskId: string;
      sandboxMode: string;
      networkProfile: string;
      requestedCpu: number;
      requestedWall: number;
      gpuCards: number;
    }> = [];
    wrappedRun.mockImplementation(async (context: RuntimeExecutionContext) => {
      const id = context.plan.taskId;
      observed.push({
        taskId: id,
        sandboxMode: context.plan.runtimeSettings.sandboxMode,
        networkProfile: context.plan.runtimeSettings.networkProfile,
        requestedCpu: context.plan.resourceEnvelope.requested.cpuCores,
        requestedWall: context.plan.resourceEnvelope.requested.wallTimeSec,
        gpuCards: context.plan.resourceEnvelope.requested.gpuCards,
      });
      await context.emit({
        kind: 'item.completed',
        item: { type: 'agent_message', text: `${id}-final` },
      } as never);
      return {
        cause: { kind: 'success' as const },
        provenance: 'stub',
        reason: 'ok',
      };
    });
    const result = await runResearchPlan(
      driver,
      plan({
        subTasks: [
          {
            taskId: 'task-st1',
            instruction: 'override sandbox + cpu',
            runtimeSettings: { sandboxMode: 'read-only' },
            resources: { requested: { cpuCores: 4 } },
          },
          {
            taskId: 'task-st2',
            instruction: 'no override — inherit plan defaults',
          },
        ],
        synthesis: {
          taskId: 'task-synth',
          instructionTemplate: 'synth — override wallTimeSec only',
          resources: { requested: { wallTimeSec: 600 } },
        },
      }),
    );
    expect(result.stoppedEarly).toBe(false);
    expect(observed).toEqual([
      // st1: override sandbox + cpu, keep network + memory + wall + gpu.
      {
        taskId: 'task-st1',
        sandboxMode: 'read-only',
        networkProfile: 'provider-only',
        requestedCpu: 4,
        requestedWall: 60,
        gpuCards: 0,
      },
      // st2: no override, inherits plan-level defaults verbatim.
      {
        taskId: 'task-st2',
        sandboxMode: 'workspace-write',
        networkProfile: 'provider-only',
        requestedCpu: 1,
        requestedWall: 60,
        gpuCards: 0,
      },
      // synth: override wallTimeSec only.
      {
        taskId: 'task-synth',
        sandboxMode: 'workspace-write',
        networkProfile: 'provider-only',
        requestedCpu: 1,
        requestedWall: 600,
        gpuCards: 0,
      },
    ]);
  });

  it('rejects per-sub-task override that produces an invalid bundle after merge', async () => {
    const driver = makeDriver({}, {});
    const wrappedRun = driver.run as unknown as ReturnType<typeof vi.fn>;
    wrappedRun.mockImplementation(async () => ({
      cause: { kind: 'success' as const },
      provenance: 'stub',
      reason: 'ok',
    }));
    await expect(
      runResearchPlan(
        driver,
        plan({
          subTasks: [
            {
              taskId: 'task-st1',
              instruction: 'invalid sandbox',
              runtimeSettings: {
                // Deliberately invalid — must trip the bundle validator at
                // dispatch time even though loader-shape was OK.
                sandboxMode: 'no-such-mode' as never,
              },
            },
          ],
        }),
      ),
    ).rejects.toThrow(/sandboxMode/);
  });

  it('with allowPartialSynthesis=true, runs synthesis on the successful subset and skips the failed sub-task', async () => {
    const driver = makeDriver({}, {});
    const wrappedRun = driver.run as unknown as ReturnType<typeof vi.fn>;
    let synthesisInstruction = '';
    wrappedRun.mockImplementation(async (context: RuntimeExecutionContext) => {
      const id = context.plan.taskId;
      if (id === 'task-st2') {
        // st2 fails persistently.
        return {
          cause: {
            kind: 'provider-failure' as const,
            classification: 'transient-server' as const,
            provider: 'codex' as const,
            message: '502',
            retryable: true,
          },
          provenance: 'stub',
          reason: 'fail',
        };
      }
      if (id === 'task-synth') synthesisInstruction = context.plan.instruction;
      await context.emit({
        kind: 'item.completed',
        item: { type: 'agent_message', text: `${id}-final` },
      } as never);
      return {
        cause: { kind: 'success' as const },
        provenance: 'stub',
        reason: 'ok',
      };
    });
    const result = await runResearchPlan(
      driver,
      plan({
        subTasks: [
          { taskId: 'task-st1', instruction: 'a' },
          { taskId: 'task-st2', instruction: 'b — will fail' },
          { taskId: 'task-st3', instruction: 'c — will not run' },
        ],
      }),
      { allowPartialSynthesis: true },
    );
    expect(result.stoppedEarly).toBe(true);
    expect(result.partialSynthesis).toBe(true);
    expect(result.skippedSubTaskIds).toEqual(['task-st2', 'task-st3']);
    // Synthesis was actually invoked and succeeded.
    expect(result.synthesisOutcome?.causeKind).toBe('success');
    expect(result.aggregatedReport).toBe('task-synth-final');
    // Synthesis instruction included the partial-synthesis header listing
    // skipped sub-tasks AND the successful-subset outputs.
    expect(synthesisInstruction).toContain('PARTIAL SYNTHESIS');
    expect(synthesisInstruction).toContain('- task-st2');
    expect(synthesisInstruction).toContain('- task-st3');
    expect(synthesisInstruction).toContain('## subTaskId: task-st1');
    // Failed sub-task output is NOT in the synthesis inputs.
    expect(synthesisInstruction).not.toContain('## subTaskId: task-st2');
  });

  it('with allowPartialSynthesis=true but no successful sub-tasks, halts without synthesis', async () => {
    const driver = makeDriver({}, {});
    const wrappedRun = driver.run as unknown as ReturnType<typeof vi.fn>;
    wrappedRun.mockImplementation(async () => ({
      cause: {
        kind: 'provider-failure' as const,
        classification: 'transient-server' as const,
        provider: 'codex' as const,
        message: 'fail',
        retryable: true,
      },
      provenance: 'stub',
      reason: 'fail',
    }));
    const result = await runResearchPlan(driver, plan(), {
      allowPartialSynthesis: true,
    });
    expect(result.stoppedEarly).toBe(true);
    expect(result.partialSynthesis).toBe(false);
    expect(result.synthesisOutcome).toBeUndefined();
    expect(result.skippedSubTaskIds).toEqual(['task-st1', 'task-st2']);
  });
});

describe('mergeRuntimeSettings', () => {
  const base = {
    networkProfile: 'provider-only' as const,
    sandboxMode: 'workspace-write' as const,
    approvalPolicy: 'on-request' as const,
    workingDirectory: '/base',
  };
  it('returns base unchanged when override is undefined', () => {
    expect(mergeRuntimeSettings(base, undefined)).toEqual(base);
  });
  it('overrides per-key while keeping non-overridden defaults', () => {
    expect(
      mergeRuntimeSettings(base, { sandboxMode: 'read-only' }),
    ).toEqual({ ...base, sandboxMode: 'read-only' });
  });
  it('ignores undefined override keys (does not clear defaults)', () => {
    expect(
      mergeRuntimeSettings(base, { sandboxMode: undefined }),
    ).toEqual(base);
  });
});

describe('mergeResources', () => {
  const base = {
    requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
  };
  it('returns base unchanged when override is undefined', () => {
    expect(mergeResources(base, undefined)).toEqual(base);
  });
  it('per-key merges requested', () => {
    expect(
      mergeResources(base, { requested: { cpuCores: 4 } }),
    ).toEqual({
      requested: { cpuCores: 4, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
    });
  });
  it('per-key merges effective on top of an existing effective default', () => {
    const baseWithEffective = {
      requested: { cpuCores: 4, memoryMiB: 1024, wallTimeSec: 600, gpuCards: 0 },
      effective: { cpuCores: 2, memoryMiB: 512 },
    };
    expect(
      mergeResources(baseWithEffective, {
        effective: { cpuCores: 1 },
      }),
    ).toEqual({
      requested: baseWithEffective.requested,
      effective: { cpuCores: 1, memoryMiB: 512 },
    });
  });
});
