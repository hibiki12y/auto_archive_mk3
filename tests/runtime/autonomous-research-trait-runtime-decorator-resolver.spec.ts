import { describe, expect, it, vi } from 'vitest';

import {
  composeTraitRuntimeDriver as composeAutonomousResearchTraitRuntimeDriver,
} from '../../src/runtime/autonomous-research-runtime-driver.js';
import {
  AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION,
  createAutonomousResearchTraitRuntimeAgentOptionsFromEnv,
  resolveAutonomousResearchTraitRuntimeDecorationMode,
} from '../../src/runtime/autonomous-research-trait-runtime-decorator-resolver.js';
import {
  AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION,
} from '../../src/runtime/methodology-trait-runtime-decorator-resolver.js';
import {
  createRepositoryTraitRuntimeAgentOptionsFromEnv,
} from '../../src/runtime/repository-trait-runtime-decorator-resolver.js';
import type {
  RuntimeCancellationBoundary,
  RuntimeDriver,
  RuntimeDriverResult,
  RuntimeTerminalCause,
} from '../../src/contracts/runtime-driver.js';
import { Plana, vetoTrait } from '../../src/core/plana.js';
import { createDispatchPlan } from '../../src/core/task.js';
import { AgentRuntime } from '../../src/runtime/agent-runtime.js';
import {
  composeTraitRuntimeDriver as composeMethodologyTraitRuntimeDriver,
} from '../../src/runtime/methodology-skill-runtime-driver.js';

function createPlan(taskId = 'task-autonomous-research-trait-resolver') {
  return createDispatchPlan({
    taskId,
    instruction: 'exercise autonomous research trait runtime resolver',
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
        provenance: 'autonomous-research-trait-resolver-test-boundary',
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

function transcriptText(
  evidence: Awaited<ReturnType<AgentRuntime['execute']>>,
): string[] {
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

describe('autonomous research TraitModule runtime decorator resolver', () => {
  it('keeps autonomous research runtime decoration off unless explicitly requested', () => {
    expect(resolveAutonomousResearchTraitRuntimeDecorationMode({})).toBe('off');
    expect(
      resolveAutonomousResearchTraitRuntimeDecorationMode({
        [AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION]: 'false',
      }),
    ).toBe('off');
    expect(createAutonomousResearchTraitRuntimeAgentOptionsFromEnv({})).toEqual(
      {},
    );
  });

  it('does not emit autonomous research checkpoints through the repository helper when env is unset', async () => {
    const driver: RuntimeDriver = {
      run: vi.fn(createSuccessfulDriver().run),
    };
    const plan = createPlan('task-repository-trait-resolver-autonomous-off');
    const runtime = new AgentRuntime(
      driver,
      createRepositoryTraitRuntimeAgentOptionsFromEnv({}),
    );

    const evidence = await runtime.execute(
      plan,
      new Plana({ trait: () => undefined }),
      createNeutralBoundary(plan.taskId),
    );

    expect(driver.run).toHaveBeenCalledTimes(1);
    expect(evidence.cause.kind).toBe('success');
    expect(transcriptText(evidence).join('\n')).not.toContain(
      'autonomous-research.checkpoint',
    );
  });

  it('parses bounded-evidence opt-in aliases and rejects unknown values', () => {
    expect(
      resolveAutonomousResearchTraitRuntimeDecorationMode({
        [AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION]: 'on',
      }),
    ).toBe('bounded-evidence');
    expect(
      resolveAutonomousResearchTraitRuntimeDecorationMode({
        [AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION]:
          '  BOUNDED-EVIDENCE  ',
      }),
    ).toBe('bounded-evidence');
    expect(() =>
      resolveAutonomousResearchTraitRuntimeDecorationMode({
        [AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION]:
          'unbounded-runner',
      }),
    ).toThrow(/AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION/);
  });

  it('uses Plana admission and the TraitModule loader before wiring the decorator', async () => {
    const driver: RuntimeDriver = {
      run: vi.fn(createSuccessfulDriver().run),
    };
    const traitHook = vi.fn(() => undefined);
    const plana = new Plana({ trait: traitHook });
    const plan = createPlan('task-autonomous-research-trait-resolver-admitted');
    const runtime = new AgentRuntime(
      driver,
      createAutonomousResearchTraitRuntimeAgentOptionsFromEnv(
        {
          [AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION]:
            'bounded-evidence',
        },
        {
          workspaceRoot: process.cwd(),
          importModule: async (specifier) => {
            if (specifier.includes('methodology-skill-runtime-driver')) {
              return {
                composeTraitRuntimeDriver: composeMethodologyTraitRuntimeDriver,
              };
            }
            return {
              composeTraitRuntimeDriver:
                composeAutonomousResearchTraitRuntimeDriver,
            };
          },
        },
      ),
    );

    const evidence = await runtime.execute(
      plan,
      plana,
      createNeutralBoundary(plan.taskId),
    );

    expect(traitHook).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'trait-module',
        taskId: plan.taskId,
        requested: true,
        selectedTraitId: 'autonomous-research-goal-loop',
        selectedProfileId: 'dgm-bounded-archive-runtime',
        runtimeDecorationIntent: 'bounded-archive-evidence',
        runtimeDecorationEnforcement: 'required',
      }),
    );
    expect(driver.run).toHaveBeenCalledTimes(1);
    expect(evidence.cause.kind).toBe('success');
    expect(
      transcriptText(evidence).some((text) =>
        text.includes('checkpoint=runtime-decoration-complete'),
      ),
    ).toBe(true);
  });

  it('fails closed before delegate execution when Plana vetoes the trait', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const driver: RuntimeDriver = {
      run: vi.fn(createSuccessfulDriver().run),
    };
    const plana = new Plana({
      trait: () => vetoTrait('blocked autonomous research trait', 'test-plana-trait'),
    });
    const plan = createPlan('task-autonomous-research-trait-resolver-vetoed');
    const runtime = new AgentRuntime(
      driver,
      createAutonomousResearchTraitRuntimeAgentOptionsFromEnv(
        {
          [AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION]: 'on',
        },
        {
          workspaceRoot: process.cwd(),
          importModule: async (specifier) => {
            if (specifier.includes('methodology-skill-runtime-driver')) {
              return {
                composeTraitRuntimeDriver: composeMethodologyTraitRuntimeDriver,
              };
            }
            return {
              composeTraitRuntimeDriver:
                composeAutonomousResearchTraitRuntimeDriver,
            };
          },
        },
      ),
    );

    const evidence = await runtime.execute(
      plan,
      plana,
      createNeutralBoundary(plan.taskId),
    );

    expect(driver.run).not.toHaveBeenCalled();
    expect(evidence.provenance).toBe('agent-runtime-fail-closed');
    expect(evidence.cause.kind).toBe('driver-failure');
    expect((evidence.cause as { readonly phase?: string }).phase).toBe(
      'trait runtime decorator admission',
    );
    expect(evidence.reason).toContain(
      'Autonomous Research TraitModule runtime decorator vetoed',
    );
    expect(evidence.reason).toContain('blocked autonomous research trait');
  });

  it('composes repository methodology and autonomous research trait resolvers together', async () => {
    const driver: RuntimeDriver = {
      run: vi.fn(createSuccessfulDriver().run),
    };
    const plan = createPlan('task-repository-trait-resolver-composed');
    const runtime = new AgentRuntime(
      driver,
      createRepositoryTraitRuntimeAgentOptionsFromEnv(
        {
          [AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION]: 'on',
          [AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION]: 'on',
        },
        {
          workspaceRoot: process.cwd(),
          importModule: async (specifier) => {
            if (specifier.includes('methodology-skill-runtime-driver')) {
              return {
                composeTraitRuntimeDriver: composeMethodologyTraitRuntimeDriver,
              };
            }
            return {
              composeTraitRuntimeDriver:
                composeAutonomousResearchTraitRuntimeDriver,
            };
          },
        },
      ),
    );

    const evidence = await runtime.execute(
      plan,
      new Plana({ trait: () => undefined }),
      createNeutralBoundary(plan.taskId),
    );

    expect(driver.run).toHaveBeenCalledTimes(1);
    const text = transcriptText(evidence).join('\n');
    expect(text).toContain('methodology-skill.checkpoint');
    expect(text).toContain('autonomous-research.checkpoint');
  });

  it('allows one shared importer to expose both repository decorator exports', async () => {
    const options = createRepositoryTraitRuntimeAgentOptionsFromEnv(
      {
        [AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION]: 'on',
        [AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION]: 'on',
      },
      {
        workspaceRoot: process.cwd(),
        importModule: async (specifier) => {
          if (specifier.includes('methodology-skill-runtime-driver')) {
            return {
              composeTraitRuntimeDriver: composeMethodologyTraitRuntimeDriver,
            };
          }
          return {
            composeTraitRuntimeDriver:
              composeAutonomousResearchTraitRuntimeDriver,
          };
        },
      },
    );

    expect(options.traitRuntimeDecoratorResolver).toBeDefined();
  });
});
