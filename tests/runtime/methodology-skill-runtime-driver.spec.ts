import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  RuntimeDriver,
  RuntimeDriverResult,
  RuntimeExecutionContext,
} from '../../src/contracts/runtime-driver.js';
import { METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST } from '../../src/contracts/methodology-skill.js';
import { createDispatchPlan } from '../../src/core/task.js';
import {
  MethodologySkillRuntimeDriver,
  composeTraitRuntimeDriver,
  createMethodologySkillRuntimeDriver,
} from '../../src/runtime/methodology-skill-runtime-driver.js';

function createContext() {
  const emitted: Array<{ kind: string; step?: string; detail?: string }> = [];
  const plan = createDispatchPlan({
    taskId: 'task-methodology-runtime',
    instruction: 'do work',
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
  const context: RuntimeExecutionContext = {
    plan,
    instance: {
      taskId: 'task-methodology-runtime',
      instanceId: 'instance-methodology-runtime',
      createdAt: '2026-04-27T00:00:00.000Z',
      runtimeSettings: plan.runtimeSettings,
    },
    async emit(event) {
      emitted.push({
        kind: event.kind,
        ...('step' in event ? { step: event.step } : {}),
        ...('detail' in event ? { detail: event.detail } : {}),
      });
    },
    async requestApproval() {
      return { status: 'approved' };
    },
    isAborted: () => false,
  };

  return { context, emitted };
}

const SELECTION = {
  requested: true,
  selectedSkillId: 'agent-methodology-origin',
  selectedProfileId: 'evidence-only-runtime',
  runtimeDecorationIntent: 'evidence-only',
  runtimeDecorationEnforcement: 'required',
} as const;

describe('MethodologySkillRuntimeDriver', () => {
  it('passes through the delegate result unchanged while emitting start/completion evidence', async () => {
    const { context, emitted } = createContext();
    const result: RuntimeDriverResult = {
      reason: 'delegate-complete',
      provenance: 'delegate-driver',
      cause: {
        kind: 'success',
        taskId: context.plan.taskId,
        runtimeInstanceId: context.instance.instanceId,
        observedAt: '2026-04-27T00:00:01.000Z',
        provenance: 'delegate-driver',
      },
    };
    const delegate: RuntimeDriver = {
      run: vi.fn(async () => result),
    };

    const driver = new MethodologySkillRuntimeDriver(delegate, SELECTION);
    const actual = await driver.run(context);

    expect(actual).toBe(result);
    expect(delegate.run).toHaveBeenCalledWith(context);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({
      kind: 'agent-step',
      step: 'methodology-skill.checkpoint',
    });
    expect(emitted[0]?.detail).toContain('checkpoint=runtime-decoration-start');
    expect(emitted[1]?.detail).toContain('checkpoint=runtime-decoration-complete');
    expect(emitted[1]?.detail).toContain('causeKind=success');
  });

  it('emits error evidence and rethrows the delegate error unchanged', async () => {
    const { context, emitted } = createContext();
    const failure = new Error('delegate exploded');
    const delegate: RuntimeDriver = {
      run: vi.fn(async () => {
        throw failure;
      }),
    };

    await expect(
      new MethodologySkillRuntimeDriver(delegate, SELECTION).run(context),
    ).rejects.toBe(failure);

    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.detail).toContain('checkpoint=runtime-decoration-error');
    expect(emitted[1]?.detail).toContain('completionStatus=delegate-threw');
  });

  it('treats checkpoint emission as best-effort so emit failures do not alter delegate semantics', async () => {
    const result: RuntimeDriverResult = {
      reason: 'delegate-complete',
      provenance: 'delegate-driver',
      cause: {
        kind: 'success',
        taskId: 'task-methodology-runtime',
        runtimeInstanceId: 'instance-methodology-runtime',
        observedAt: '2026-04-27T00:00:01.000Z',
        provenance: 'delegate-driver',
      },
    };
    const delegate: RuntimeDriver = {
      run: vi.fn(async () => result),
    };
    const context = {
      ...createContext().context,
      emit: vi.fn(async () => {
        throw new Error('emit failed');
      }),
    } satisfies RuntimeExecutionContext;

    const actual = await createMethodologySkillRuntimeDriver(
      delegate,
      SELECTION,
    ).run(context);

    expect(actual).toBe(result);
    expect(delegate.run).toHaveBeenCalledWith(context);
  });

  it('logs a structured methodology-evidence-emit-failed event when context.emit throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result: RuntimeDriverResult = {
        reason: 'delegate-complete',
        provenance: 'delegate-driver',
        cause: {
          kind: 'success',
          taskId: 'task-methodology-runtime',
          runtimeInstanceId: 'instance-methodology-runtime',
          observedAt: '2026-04-27T00:00:01.000Z',
          provenance: 'delegate-driver',
        },
      };
      const delegate: RuntimeDriver = {
        run: vi.fn(async () => result),
      };
      const context = {
        ...createContext().context,
        emit: vi.fn(async () => {
          throw new Error('emit failed');
        }),
      } satisfies RuntimeExecutionContext;

      const actual = await createMethodologySkillRuntimeDriver(
        delegate,
        SELECTION,
      ).run(context);

      expect(actual).toBe(result);
      expect(errorSpy).toHaveBeenCalled();
      const messages = errorSpy.mock.calls.map((call) => String(call[0]));
      const matching = messages.filter((m) =>
        m.includes('methodology-evidence-emit-failed'),
      );
      expect(matching.length).toBeGreaterThan(0);
      const firstMatch = matching[0];
      const jsonStart = firstMatch.indexOf('{');
      expect(jsonStart).toBeGreaterThanOrEqual(0);
      const payload = JSON.parse(firstMatch.slice(jsonStart)) as {
        readonly event: string;
        readonly taskId: string;
        readonly checkpoint: string;
        readonly errorMessage: string;
      };
      expect(payload.event).toBe('methodology-evidence-emit-failed');
      expect(payload.taskId).toBe('task-methodology-runtime');
      expect(payload.checkpoint).toBe('runtime-decoration-start');
      expect(payload.errorMessage).toBe('emit failed');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('composeTraitRuntimeDriver is an explicit opt-in evidence decorator helper', async () => {
    const { context } = createContext();
    const result: RuntimeDriverResult = {
      reason: 'delegate-complete',
      provenance: 'delegate-driver',
      cause: {
        kind: 'success',
        taskId: context.plan.taskId,
        runtimeInstanceId: context.instance.instanceId,
        observedAt: '2026-04-27T00:00:01.000Z',
        provenance: 'delegate-driver',
      },
    };
    const delegate: RuntimeDriver = {
      run: vi.fn(async () => result),
    };

    const passthrough = composeTraitRuntimeDriver(delegate, {
      manifest: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
      requested: false,
    });
    expect(passthrough).toBe(delegate);

    const wrapped = composeTraitRuntimeDriver(delegate, {
      manifest: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
      requested: true,
    });
    expect(wrapped).toBeInstanceOf(MethodologySkillRuntimeDriver);
  });

  it('does not retain the old methodology-specific composer export name', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/runtime/methodology-skill-runtime-driver.ts'),
      'utf8',
    );

    expect(source).toContain('export function composeTraitRuntimeDriver');
    expect(source).not.toContain('composeMethodologySkillRuntimeDriver');
  });
});
