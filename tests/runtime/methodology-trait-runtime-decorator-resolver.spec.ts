import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  RuntimeCancellationBoundary,
  RuntimeDriver,
  RuntimeDriverResult,
  RuntimeTerminalCause,
} from '../../src/contracts/runtime-driver.js';
import { Plana, vetoTrait } from '../../src/core/plana.js';
import { createDispatchPlan } from '../../src/core/task.js';
import { AgentRuntime } from '../../src/runtime/agent-runtime.js';
import { composeTraitRuntimeDriver } from '../../src/runtime/methodology-skill-runtime-driver.js';
import {
  AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION,
  createMethodologyTraitRuntimeAgentOptionsFromEnv,
  resolveMethodologyTraitRuntimeDecorationMode,
} from '../../src/runtime/methodology-trait-runtime-decorator-resolver.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');

function createPlan(taskId = 'task-methodology-trait-resolver') {
  return createDispatchPlan({
    taskId,
    instruction: 'exercise methodology trait runtime resolver',
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
        provenance: 'methodology-trait-resolver-test-boundary',
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

function readRepoText(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('methodology TraitModule runtime decorator resolver', () => {
  it('keeps methodology runtime decoration off unless explicitly requested by env', () => {
    expect(resolveMethodologyTraitRuntimeDecorationMode({})).toBe('off');
    expect(
      resolveMethodologyTraitRuntimeDecorationMode({
        [AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION]: 'false',
      }),
    ).toBe('off');
    expect(
      createMethodologyTraitRuntimeAgentOptionsFromEnv({}),
    ).toEqual({});
  });

  it('parses evidence-only opt-in aliases and rejects unknown values', () => {
    expect(
      resolveMethodologyTraitRuntimeDecorationMode({
        [AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION]: '1',
      }),
    ).toBe('evidence-only');
    expect(
      resolveMethodologyTraitRuntimeDecorationMode({
        [AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION]: '  EVIDENCE-ONLY  ',
      }),
    ).toBe('evidence-only');
    expect(() =>
      resolveMethodologyTraitRuntimeDecorationMode({
        [AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION]: 'provider-switch',
      }),
    ).toThrow(/AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION/);
  });

  it('keeps all runtime bootstrap entry points wired to the methodology resolver helper', () => {
    for (const relativePath of [
      'src/discord/discord-service-bootstrap.ts',
      'src/discord/discord-smoke-bootstrap.ts',
      'src/runtime/agent-instance-entry.ts',
    ]) {
      expect(readRepoText(relativePath)).toContain(
        'createMethodologyTraitRuntimeAgentOptionsFromEnv',
      );
    }
  });

  it('uses Plana admission and the TraitModule loader before wiring the decorator into AgentRuntime', async () => {
    const driver: RuntimeDriver = {
      run: vi.fn(createSuccessfulDriver().run),
    };
    const traitHook = vi.fn(() => undefined);
    const plana = new Plana({ trait: traitHook });
    const plan = createPlan('task-methodology-trait-resolver-admitted');
    const runtime = new AgentRuntime(
      driver,
      createMethodologyTraitRuntimeAgentOptionsFromEnv(
        {
          [AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION]: 'evidence-only',
        },
        {
          workspaceRoot: process.cwd(),
          importModule: async () => ({
            composeTraitRuntimeDriver,
          }),
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
        selectedSkillId: 'agent-methodology-origin',
        selectedProfileId: 'evidence-only-runtime',
        runtimeDecorationIntent: 'evidence-only',
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

  it('fails closed before delegate execution when Plana vetoes the methodology TraitModule', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const driver: RuntimeDriver = {
      run: vi.fn(createSuccessfulDriver().run),
    };
    const plana = new Plana({
      trait: () => vetoTrait('blocked methodology trait', 'test-plana-trait'),
    });
    const plan = createPlan('task-methodology-trait-resolver-vetoed');
    const runtime = new AgentRuntime(
      driver,
      createMethodologyTraitRuntimeAgentOptionsFromEnv(
        {
          [AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION]: 'on',
        },
        {
          workspaceRoot: process.cwd(),
          importModule: async () => ({
            composeTraitRuntimeDriver,
          }),
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
    expect(evidence.reason).toContain('trait runtime decorator admission');
    expect(evidence.reason).toContain('Methodology TraitModule runtime decorator vetoed');
    expect(evidence.reason).toContain('blocked methodology trait');
  });

  it('does not pin a transient decorator load failure after the first failed dispatch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const driver: RuntimeDriver = {
      run: vi.fn(createSuccessfulDriver().run),
    };
    let importAttempts = 0;
    const runtime = new AgentRuntime(
      driver,
      createMethodologyTraitRuntimeAgentOptionsFromEnv(
        {
          [AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION]: 'on',
        },
        {
          workspaceRoot: process.cwd(),
          importModule: async () => {
            importAttempts += 1;
            if (importAttempts === 1) {
              throw new Error('transient decorator import failure');
            }
            return {
              composeTraitRuntimeDriver,
            };
          },
        },
      ),
    );

    // Wire an explicit permissive trait hook so the test exercises the
    // decorator-import retry path rather than tripping `Plana.consumeTrait`'s
    // default-deny for `kind:'trait-module'` admissions.
    const permissiveTraitHook = () => undefined;
    const firstPlan = createPlan('task-methodology-trait-load-retry-first');
    const firstEvidence = await runtime.execute(
      firstPlan,
      new Plana({ trait: permissiveTraitHook }),
      createNeutralBoundary(firstPlan.taskId),
    );

    expect(firstEvidence.provenance).toBe('agent-runtime-fail-closed');
    expect((firstEvidence.cause as { readonly phase?: string }).phase).toBe(
      'trait runtime decorator loading',
    );
    expect(firstEvidence.reason).toContain('trait runtime decorator loading');
    expect(firstEvidence.reason).toContain('transient decorator import failure');
    expect(driver.run).not.toHaveBeenCalled();

    const secondPlan = createPlan('task-methodology-trait-load-retry-second');
    const secondEvidence = await runtime.execute(
      secondPlan,
      new Plana({ trait: permissiveTraitHook }),
      createNeutralBoundary(secondPlan.taskId),
    );

    expect(importAttempts).toBe(2);
    expect(driver.run).toHaveBeenCalledTimes(1);
    expect(secondEvidence.cause.kind).toBe('success');
    expect(
      transcriptText(secondEvidence).some((text) =>
        text.includes('checkpoint=runtime-decoration-complete'),
      ),
    ).toBe(true);
  });
});
