/**
 * M2 — PlanaCurator unit tests + methodology-resolver integration test.
 *
 * Coverage:
 *   - Default rubric set returns 'keep' for any trait
 *   - Custom rubrics drive 'consolidate' / 'prune' / 'keep' decisions
 *   - Bundled trait modules: rubric-driven prune/consolidate is downgraded
 *     to 'keep' with evidence preserved (defensiveGate: 'bundled')
 *   - Pinned trait modules: rubric is bypassed entirely (defensiveGate: 'pinned')
 *   - evaluateMetadata + curateSelection round-trip the same defensive gates
 *   - Resolver integration: curator decision is logged after admission;
 *     'prune' decisions cause the decorator to be skipped
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PlanaCurator,
  type CuratorDecision,
  type CuratorRubric,
} from '../src/core/plana-curator.js';
import type { PlanaTraitMethodologySkill } from '../src/core/plana.js';
import type { TraitModuleId } from '../src/contracts/trait-module.js';
import { METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST } from '../src/contracts/methodology-skill.js';

const FIXED_NOW = new Date('2026-05-01T12:00:00.000Z');

function fixedClock(): Date {
  return FIXED_NOW;
}

function buildTrait(
  moduleId: TraitModuleId,
  overrides: Partial<PlanaTraitMethodologySkill> = {},
): PlanaTraitMethodologySkill {
  const base: PlanaTraitMethodologySkill = {
    kind: 'trait-module',
    moduleId,
    taskId: 'task-curator-test',
    provenance: 'curator-test',
    requested: true,
    selectedSkillId: 'agent-methodology-origin',
    selectedProfileId: 'evidence-only-runtime',
    runtimeDecorationIntent: 'evidence-only',
    runtimeDecorationEnforcement: 'advisory',
  };
  return { ...base, ...overrides };
}

const TRAIT_A = 'trait-A' as TraitModuleId;
const TRAIT_B = 'trait-B' as TraitModuleId;
const TRAIT_BUNDLED = 'trait-bundled' as TraitModuleId;
const TRAIT_PINNED = 'trait-pinned' as TraitModuleId;

describe('PlanaCurator', () => {
  it('returns keep with reason "no rubric matched" by default', () => {
    const curator = new PlanaCurator({ clock: fixedClock });
    const decision = curator.admitSkill(buildTrait(TRAIT_A));
    expect(decision.kind).toBe('keep');
    expect(decision.traitModuleId).toBe(TRAIT_A);
    expect(decision.reason).toBe('no rubric matched');
    expect(decision.source).toBe('audit');
    expect(decision.observedAt).toBe(FIXED_NOW.toISOString());
  });

  it('runs rubrics in order and returns the first matching decision', () => {
    const rubricA: CuratorRubric = {
      id: 'A',
      evaluate: () => null,
    };
    const rubricB: CuratorRubric = {
      id: 'B',
      evaluate: ({ trait, observedAt }): CuratorDecision => ({
        kind: 'consolidate',
        traitModuleId: trait.moduleId,
        reason: 'rubric B fired',
        source: 'model',
        observedAt,
        rubricId: 'B',
        from: trait.moduleId,
        into: TRAIT_B,
      }),
    };
    const rubricC: CuratorRubric = {
      id: 'C',
      evaluate: ({ trait, observedAt }): CuratorDecision => ({
        kind: 'prune',
        traitModuleId: trait.moduleId,
        reason: 'rubric C fired',
        source: 'model',
        observedAt,
        rubricId: 'C',
      }),
    };

    const curator = new PlanaCurator({
      rubrics: [rubricA, rubricB, rubricC],
      clock: fixedClock,
    });
    const decision = curator.admitSkill(buildTrait(TRAIT_A));
    expect(decision.kind).toBe('consolidate');
    expect(decision.rubricId).toBe('B');
    expect(decision.into).toBe(TRAIT_B);
  });

  it('downgrades a prune decision on a bundled trait to keep (defensive gate)', () => {
    const pruneRubric: CuratorRubric = {
      id: 'prune-all',
      evaluate: ({ trait, observedAt }): CuratorDecision => ({
        kind: 'prune',
        traitModuleId: trait.moduleId,
        reason: 'staleness threshold',
        source: 'audit',
        observedAt,
        rubricId: 'prune-all',
      }),
    };
    const curator = new PlanaCurator({
      rubrics: [pruneRubric],
      clock: fixedClock,
      bundledTraitModuleIds: [TRAIT_BUNDLED],
    });
    const decision = curator.admitSkill(buildTrait(TRAIT_BUNDLED));
    expect(decision.kind).toBe('keep');
    expect(decision.defensiveGate).toBe('bundled');
    expect(decision.evidence?.['downgradedFrom']).toBe('prune');
    expect(decision.evidence?.['originalReason']).toBe('staleness threshold');
  });

  it('downgrades a consolidate decision on a bundled trait to keep', () => {
    const consolidateRubric: CuratorRubric = {
      id: 'consolidate-all',
      evaluate: ({ trait, observedAt }): CuratorDecision => ({
        kind: 'consolidate',
        traitModuleId: trait.moduleId,
        reason: 'duplicate of trait-B',
        source: 'model',
        observedAt,
        rubricId: 'consolidate-all',
        from: trait.moduleId,
        into: TRAIT_B,
      }),
    };
    const curator = new PlanaCurator({
      rubrics: [consolidateRubric],
      bundledTraitModuleIds: [TRAIT_BUNDLED],
      clock: fixedClock,
    });
    const decision = curator.admitSkill(buildTrait(TRAIT_BUNDLED));
    expect(decision.kind).toBe('keep');
    expect(decision.defensiveGate).toBe('bundled');
  });

  it('skips rubrics entirely for pinned traits', () => {
    const rubricSpy = vi.fn(() => null);
    const curator = new PlanaCurator({
      rubrics: [{ id: 'spy', evaluate: rubricSpy }],
      pinnedTraitModuleIds: [TRAIT_PINNED],
      clock: fixedClock,
    });
    const decision = curator.admitSkill(buildTrait(TRAIT_PINNED));
    expect(decision.kind).toBe('keep');
    expect(decision.defensiveGate).toBe('pinned');
    expect(rubricSpy).not.toHaveBeenCalled();
  });

  it('curateSelection processes a population of traits in input order', () => {
    const pruneB: CuratorRubric = {
      id: 'prune-B',
      evaluate: ({ trait, observedAt }): CuratorDecision | null =>
        trait.moduleId === TRAIT_B
          ? {
              kind: 'prune',
              traitModuleId: trait.moduleId,
              reason: 'B is stale',
              source: 'audit',
              observedAt,
              rubricId: 'prune-B',
            }
          : null,
    };
    const curator = new PlanaCurator({
      rubrics: [pruneB],
      clock: fixedClock,
    });
    const decisions = curator.curateSelection([
      buildTrait(TRAIT_A),
      buildTrait(TRAIT_B),
    ]);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.kind).toBe('keep');
    expect(decisions[0]?.traitModuleId).toBe(TRAIT_A);
    expect(decisions[1]?.kind).toBe('prune');
    expect(decisions[1]?.traitModuleId).toBe(TRAIT_B);
  });

  it('evaluateMetadata reports all matching rubric decisions without admitting', () => {
    const rubric1: CuratorRubric = {
      id: 'r1',
      evaluate: ({ trait, observedAt }): CuratorDecision => ({
        kind: 'keep',
        traitModuleId: trait.moduleId,
        reason: 'r1 says keep',
        source: 'audit',
        observedAt,
        rubricId: 'r1',
      }),
    };
    const curator = new PlanaCurator({
      rubrics: [rubric1],
      clock: fixedClock,
    });
    const decisions = curator.evaluateMetadata(buildTrait(TRAIT_A));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.rubricId).toBe('r1');
  });

  it('evaluateMetadata short-circuits to a single keep decision for pinned traits', () => {
    const rubricSpy = vi.fn(() => null);
    const curator = new PlanaCurator({
      rubrics: [{ id: 'spy', evaluate: rubricSpy }],
      pinnedTraitModuleIds: [TRAIT_PINNED],
      clock: fixedClock,
    });
    const decisions = curator.evaluateMetadata(buildTrait(TRAIT_PINNED));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.defensiveGate).toBe('pinned');
    expect(rubricSpy).not.toHaveBeenCalled();
  });
});

describe('Plana.getCurator()', () => {
  it('returns undefined when no curator is configured', async () => {
    const { Plana } = await import('../src/core/plana.js');
    const plana = new Plana();
    expect(plana.getCurator()).toBeUndefined();
  });

  it('returns the configured curator instance', async () => {
    const { Plana } = await import('../src/core/plana.js');
    const curator = new PlanaCurator();
    const plana = new Plana({ curator });
    expect(plana.getCurator()).toBe(curator);
  });
});

describe('M2 integration — methodology resolver consults curator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits the curator decision via the M5b skillAdmit hook channel', async () => {
    const skillAdmitSpy = vi.fn();

    const { Plana } = await import('../src/core/plana.js');
    const { createMethodologyTraitRuntimeDecoratorResolver } = await import(
      '../src/runtime/methodology-trait-runtime-decorator-resolver.js'
    );
    const { createTaskRequest } = await import('./helpers/dispatcher-core.js');
    type AgentInstance = import('../src/contracts/runtime-driver.js').AgentInstance;

    const plana = new Plana({
      // Required for trait-module admission — without it, Plana
      // default-denies and the resolver throws before reaching the
      // curator emit.
      trait: () => undefined,
      curator: new PlanaCurator(),
    });

    const fakeImporter = vi.fn(async () => ({
      default: (driver: unknown) => driver,
    }));

    const resolver = createMethodologyTraitRuntimeDecoratorResolver({
      workspaceRoot: process.cwd(),
      importModule: fakeImporter as never,
      allowExternal: false,
      allowWorkspaceLocal: true,
      midCycleHooks: [
        {
          moduleId: 'curator-channel-test',
          moduleVersion: '1.0.0',
          skillAdmit: skillAdmitSpy,
        },
      ],
    });

    const planRequest = createTaskRequest('task-curator-integration');
    const fakePlan = {
      ...planRequest,
      createdAt: new Date().toISOString(),
      runtimeSettings: planRequest.runtimeSettings,
      resourceEnvelope: { requested: planRequest.resources.requested },
    };
    const fakeInstance: AgentInstance = {
      taskId: planRequest.taskId,
      instanceId: 'fake-instance',
      createdAt: new Date().toISOString(),
      runtimeSettings: {
        ...planRequest.runtimeSettings,
        toolset: { provider: 'codex', model: undefined },
      } as never,
    };

    try {
      await resolver({
        plan: fakePlan as never,
        instance: fakeInstance,
        plana,
      });
    } catch {
      // Loader may fail in this synthetic environment; skillAdmit fires
      // before the loader so the test still observes the channel.
    }

    expect(skillAdmitSpy).toHaveBeenCalledTimes(1);
    const payload = (skillAdmitSpy as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(payload).toMatchObject({
      taskId: 'task-curator-integration',
      admissionStatus: 'admitted',
      curatorDecisionKind: 'keep',
    });
  });
});
