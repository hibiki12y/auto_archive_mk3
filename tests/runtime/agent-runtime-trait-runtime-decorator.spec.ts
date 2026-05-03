import { afterEach, describe, expect, it, vi } from 'vitest';

import { METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST } from '../../src/contracts/methodology-skill.js';
import type {
  RuntimeCancellationBoundary,
  RuntimeDriver,
  RuntimeDriverResult,
  RuntimeTerminalCause,
} from '../../src/contracts/runtime-driver.js';
import type { TraitRuntimeDriverDecorator } from '../../src/contracts/trait-runtime-hook.js';
import { loadTraitRuntimeDriverDecorator } from '../../src/core/trait-module-loader.js';
import { Plana } from '../../src/core/plana.js';
import { createDispatchPlan } from '../../src/core/task.js';
import {
  AgentRuntime,
  composeTraitRuntimeDriverDecorators,
} from '../../src/runtime/agent-runtime.js';
import { composeTraitRuntimeDriver } from '../../src/runtime/methodology-skill-runtime-driver.js';

function createPlan(taskId = 'task-agent-runtime-trait-decorator') {
  return createDispatchPlan({
    taskId,
    instruction: 'exercise trait runtime decorator wiring',
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
        provenance: 'agent-runtime-trait-decorator-test-boundary',
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
      return cause as Extract<RuntimeTerminalCause, { kind: 'runtime-veto' }>;
    },
    currentTerminalCause: () =>
      terminalCause === undefined ? undefined : { ...terminalCause },
  };
}

function createSuccessfulDriver(): RuntimeDriver {
  return {
    async run(context): Promise<RuntimeDriverResult> {
      return {
        reason: 'delegate-complete',
        provenance: 'delegate-driver',
        cause: {
          kind: 'success',
          taskId: context.plan.taskId,
          runtimeInstanceId: context.instance.instanceId,
          observedAt: new Date().toISOString(),
          provenance: 'delegate-driver',
        },
      };
    },
  };
}

async function executeWithDecorator(input: {
  readonly requested: boolean;
  readonly driver?: RuntimeDriver;
}) {
  const loaded = await loadTraitRuntimeDriverDecorator(
    METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
    {
      workspaceRoot: process.cwd(),
      importModule: async () => ({
        composeTraitRuntimeDriver,
      }),
    },
  );
  if (loaded.status !== 'loaded' || loaded.decorator === undefined) {
    throw new Error(`test setup failed to load decorator: ${loaded.errorMessage}`);
  }

  const plan = createPlan(
    input.requested
      ? 'task-agent-runtime-trait-requested'
      : 'task-agent-runtime-trait-not-requested',
  );
  const runtime = new AgentRuntime(input.driver ?? createSuccessfulDriver(), {
    traitRuntimeDecorators: [
      {
        decorator: loaded.decorator,
        context: {
          manifest: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
          requested: input.requested,
        },
      },
    ],
  });

  return runtime.execute(plan, new Plana({}), createNeutralBoundary(plan.taskId));
}

function transcriptDetails(evidence: Awaited<ReturnType<typeof executeWithDecorator>>) {
  return (
    evidence.transcript?.events
      .map((event) => (event as { readonly detail?: unknown }).detail)
      .filter((detail): detail is string => typeof detail === 'string') ?? []
  );
}

function transcriptText(evidence: Awaited<ReturnType<typeof executeWithDecorator>>) {
  return (
    evidence.transcript?.events.map((event) =>
      [
        (event as { readonly step?: unknown }).step,
        (event as { readonly detail?: unknown }).detail,
      ]
        .filter((field): field is string => typeof field === 'string')
        .join(' '),
    ) ?? []
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentRuntime TraitRuntimeDriverDecorator wiring', () => {
  it('preserves existing constructor behavior when no decorator options are supplied', async () => {
    const driver: RuntimeDriver = {
      run: vi.fn(createSuccessfulDriver().run),
    };
    const plan = createPlan('task-agent-runtime-trait-no-options');

    const evidence = await new AgentRuntime(driver).execute(
      plan,
      new Plana({}),
      createNeutralBoundary(plan.taskId),
    );

    expect(driver.run).toHaveBeenCalledTimes(1);
    expect(evidence.provenance).toBe('delegate-driver');
    expect(evidence.cause.kind).toBe('success');
    expect(
      transcriptText(evidence).some((text) =>
        text.includes('runtime-decoration-'),
      ),
    ).toBe(false);
  });

  it('composes a loaded evidence-decorator at dispatch time and preserves delegate terminal cause', async () => {
    const evidence = await executeWithDecorator({ requested: true });
    const details = transcriptDetails(evidence);

    expect(evidence.provenance).toBe('delegate-driver');
    expect(evidence.cause.kind).toBe('success');
    expect(evidence.cause.provenance).toBe('delegate-driver');
    expect(
      details.some((detail) =>
        detail.includes('checkpoint=runtime-decoration-start'),
      ),
    ).toBe(true);
    expect(
      details.some((detail) =>
        detail.includes('checkpoint=runtime-decoration-complete'),
      ),
    ).toBe(true);
    expect(
      details.some((detail) => detail.includes('causeKind=success')),
    ).toBe(true);
  });

  it('keeps an unrequested evidence-decorator inert while still dispatching the base driver', async () => {
    const driver: RuntimeDriver = {
      run: vi.fn(createSuccessfulDriver().run),
    };
    const evidence = await executeWithDecorator({ requested: false, driver });

    expect(driver.run).toHaveBeenCalledTimes(1);
    expect(evidence.cause.kind).toBe('success');
    expect(
      transcriptText(evidence).some((text) =>
        text.includes('methodology-skill.checkpoint'),
      ),
    ).toBe(false);
    expect(
      transcriptText(evidence).some((text) =>
        text.includes('runtime-decoration-'),
      ),
    ).toBe(false);
  });

  it('fails closed as TerminalEvidence if decorator composition itself throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plan = createPlan('task-agent-runtime-trait-composition-failure');
    const throwingDecorator: TraitRuntimeDriverDecorator = () => {
      throw new Error('decorator composition exploded');
    };
    const runtime = new AgentRuntime(createSuccessfulDriver(), {
      traitRuntimeDecorators: [
        {
          decorator: throwingDecorator,
          context: {
            manifest: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
            requested: true,
          },
        },
      ],
    });

    const evidence = await runtime.execute(
      plan,
      new Plana({}),
      createNeutralBoundary(plan.taskId),
    );

    expect(evidence.provenance).toBe('agent-runtime-fail-closed');
    expect(evidence.cause.kind).toBe('driver-failure');
    expect((evidence.cause as { readonly phase?: string }).phase).toBe(
      'trait runtime decorator composition',
    );
    expect(evidence.reason).toContain('trait runtime decorator composition');
    expect(evidence.reason).toContain('decorator composition exploded');
  });

  it('documents composition order: the first binding is the outermost runtime decorator', async () => {
    const order: string[] = [];
    const baseDriver = createSuccessfulDriver();
    const makeDecorator =
      (label: string): TraitRuntimeDriverDecorator =>
      (delegate) => ({
        async run(context) {
          order.push(`${label}:before`);
          try {
            return await delegate.run(context);
          } finally {
            order.push(`${label}:after`);
          }
        },
      });

    const composed = composeTraitRuntimeDriverDecorators(baseDriver, [
      {
        decorator: makeDecorator('outer'),
        context: {
          manifest: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
          requested: true,
        },
      },
      {
        decorator: makeDecorator('inner'),
        context: {
          manifest: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
          requested: true,
        },
      },
    ]);

    const plan = createPlan('task-agent-runtime-trait-order');
    await composed.run({
      plan,
      instance: {
        taskId: plan.taskId,
        instanceId: 'instance-agent-runtime-trait-order',
        createdAt: new Date().toISOString(),
        runtimeSettings: plan.runtimeSettings,
      },
      async emit() {
        return undefined;
      },
      async requestApproval() {
        return { status: 'approved' };
      },
      isAborted: () => false,
    });

    expect(order).toEqual([
      'outer:before',
      'inner:before',
      'inner:after',
      'outer:after',
    ]);
  });

  it('plan-level deadlineMs bounds a slow trait decorator (DT Audit H3 backstop)', async () => {
    // Per microkernel-module-boundary §"TraitModule decorator execution
    // bounding": there is no per-decorator timeout in
    // `composeTraitRuntimeDriverDecorators`. A misbehaving or slow trait
    // runtime decorator MUST be bounded by `plan.runtimeSettings.deadlineMs`
    // — the plan-level deadline is the documented backstop.
    const slowDecorator: TraitRuntimeDriverDecorator = (delegate) => ({
      async run(context) {
        await new Promise(() => {
          // Hang past any reasonable deadline; the plan-level deadlineMs
          // must latch the terminal cause as 'timeout'.
        });
        return delegate.run(context);
      },
    });
    const plan = createDispatchPlan({
      taskId: 'task-agent-runtime-trait-decorator-deadline-backstop',
      instruction: 'verify plan-level deadlineMs bounds slow trait decorators',
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
        deadlineMs: 100,
      },
    });
    const runtime = new AgentRuntime(createSuccessfulDriver(), {
      traitRuntimeDecorators: [
        {
          decorator: slowDecorator,
          context: {
            manifest: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
            requested: true,
          },
        },
      ],
    });

    const startedAt = Date.now();
    const evidence = await runtime.execute(
      plan,
      new Plana({ trait: () => undefined }),
      createNeutralBoundary(plan.taskId),
    );
    const elapsedMs = Date.now() - startedAt;

    expect(evidence.cause.kind).toBe('timeout');
    if (evidence.cause.kind === 'timeout') {
      expect(evidence.cause.deadlineMs).toBe(100);
      expect(evidence.cause.provenance).toBe('agent-runtime-deadline');
    }
    expect(evidence.provenance).toBe('agent-runtime-deadline');
    // Generous tolerance for slow CI; the assertion only verifies the
    // deadline backstop fires within bounded time, not exact timing.
    expect(elapsedMs).toBeLessThan(100 + 500);
  });

  it('composes constructor-supplied decorators outside resolver-supplied decorators', async () => {
    const order: string[] = [];
    const makeDecorator =
      (label: string): TraitRuntimeDriverDecorator =>
      (delegate) => ({
        async run(context) {
          order.push(`${label}:before`);
          try {
            return await delegate.run(context);
          } finally {
            order.push(`${label}:after`);
          }
        },
      });
    const plan = createPlan('task-agent-runtime-static-dynamic-order');
    const runtime = new AgentRuntime(createSuccessfulDriver(), {
      traitRuntimeDecorators: [
        {
          decorator: makeDecorator('static'),
          context: {
            manifest: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
            requested: true,
          },
        },
      ],
      traitRuntimeDecoratorResolver: () => [
        {
          decorator: makeDecorator('resolved'),
          context: {
            manifest: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
            requested: true,
          },
        },
      ],
    });

    const evidence = await runtime.execute(
      plan,
      new Plana({}),
      createNeutralBoundary(plan.taskId),
    );

    expect(evidence.cause.kind).toBe('success');
    expect(order).toEqual([
      'static:before',
      'resolved:before',
      'resolved:after',
      'static:after',
    ]);
  });
});
