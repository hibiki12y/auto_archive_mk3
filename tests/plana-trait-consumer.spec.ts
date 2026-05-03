/**
 * WU-G — Plana capability/TraitModule consumer tests.
 *
 * Spec: `specs/wu-g-trait-first-consumer-plana.md` §3, §5
 * (AC-G1..AC-G3, AC-G5, AC-G6).
 *
 * Acceptance criteria covered here:
 *   - AC-G1: Plana exposes `consumeTrait(trait): PlanaBehavior`.
 *   - AC-G2: `network-access` capability flag exercised end-to-end with both
 *            admit and veto branches; veto carries a `VetoPath` whose
 *            `provenance` identifies Plana as originator.
 *   - AC-G3: capability-surface comment block is co-located with the
 *            consumer surface (verified by source-text grep).
 *   - AC-G5: no `templerun` reference-type leak in capability/TraitModule
 *            contracts.
 *   - AC-G6: `CapabilityFlag`/`TraitModuleId` are imported from contracts —
 *            Plana does NOT redefine them.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  Plana,
  vetoTrait,
  type PlanaBehavior,
  type PlanaTrait,
  type PlanaTraitMethodologySkill,
  type PlanaTraitNetworkAccess,
} from '../src/core/plana.js';
import type { CapabilityFlag } from '../src/contracts/capability-flag.js';
import type { TraitModuleId } from '../src/contracts/trait-module.js';
import {
  METHODOLOGY_SKILL_PROFILES,
  METHODOLOGY_SKILL_TRAIT_MODULE_ID,
} from '../src/contracts/methodology-skill.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLANA_SOURCE = readFileSync(
  resolve(HERE, '../src/core/plana.ts'),
  'utf8',
);
const CAPABILITY_FLAG_SOURCE = readFileSync(
  resolve(HERE, '../src/contracts/capability-flag.ts'),
  'utf8',
);
const TRAIT_MODULE_SOURCE = readFileSync(
  resolve(HERE, '../src/contracts/trait-module.ts'),
  'utf8',
);

function netTrait(
  overrides: Partial<PlanaTraitNetworkAccess> = {},
): PlanaTraitNetworkAccess {
  return {
    kind: 'network-access',
    taskId: 'task-wu-g-1',
    provenance: 'wu-g-test',
    requested: true,
    profileName: 'open-egress',
    ...overrides,
  };
}

function methodologyTrait(
  overrides: Partial<PlanaTraitMethodologySkill> = {},
): PlanaTraitMethodologySkill {
  return {
    kind: 'trait-module',
    moduleId: METHODOLOGY_SKILL_TRAIT_MODULE_ID,
    taskId: 'task-methodology-1',
    provenance: 'wu-g-test',
    requested: true,
    selectedSkillId: 'agent-methodology-origin',
    selectedProfileId: METHODOLOGY_SKILL_PROFILES[0].id,
    runtimeDecorationIntent: 'evidence-only',
    runtimeDecorationEnforcement: 'required',
    ...overrides,
  };
}

describe('Plana.consumeTrait — AC-G1 surface', () => {
  it('exists with signature (trait: PlanaTrait) => PlanaBehavior', () => {
    const plana = new Plana();
    expectTypeOf(plana.consumeTrait).parameter(0).toEqualTypeOf<PlanaTrait>();
    expectTypeOf(plana.consumeTrait).returns.toEqualTypeOf<PlanaBehavior>();
  });

  it('admits when no trait hook is configured (default-permissive for network-access)', () => {
    const plana = new Plana();
    const result = plana.consumeTrait(netTrait());
    expect(result).toEqual({ status: 'approved' });
  });

  it("default-denies kind:'trait-module' when no trait hook is configured", () => {
    const plana = new Plana();
    const result = plana.consumeTrait(methodologyTrait());
    expect(result.status).toBe('vetoed');
    if (result.status !== 'vetoed') return;
    expect(result.veto.origin).toBe('pre-dispatch');
    expect(result.veto.provenance).toBe('plana-trait-module-default-deny');
    expect(result.veto.reason).toContain(
      "kind:'trait-module' admission requires an operator-configured policyHooks.trait",
    );
    expect(result.veto.reason).toContain('microkernel-module-boundary §3');
    expect(result.veto.propagation.blocksSubmission).toBe(true);
  });
});

describe('Plana.consumeTrait — AC-G2 network-access end-to-end', () => {
  // Inject the policy lookup per spec §3.3 / §5.1: a profileName →
  // allowsNetwork map. Production wiring is downstream (WU-S).
  const policy: Record<string, boolean> = {
    offline: false,
    'provider-only': false,
    'restricted-egress': true,
    'open-egress': true,
  };

  function buildPlana(): Plana {
    return new Plana({
      trait: (trait) => {
        if (trait.kind !== 'network-access') {
          return undefined;
        }
        if (!trait.requested) {
          return undefined;
        }
        const allowed = policy[trait.profileName] ?? false;
        if (allowed) {
          return undefined;
        }
        return vetoTrait(
          `network requested under profile '${trait.profileName}' which denies network`,
          'plana-trait-network-access',
        );
      },
    });
  }

  it('admit branch: requested=true under network-allowing profile', () => {
    const result = buildPlana().consumeTrait(
      netTrait({ requested: true, profileName: 'open-egress' }),
    );
    expect(result).toEqual({ status: 'approved' });
  });

  it('admit branch: requested=false (no network needed)', () => {
    const result = buildPlana().consumeTrait(
      netTrait({ requested: false, profileName: 'offline' }),
    );
    expect(result).toEqual({ status: 'approved' });
  });

  it('veto branch: requested=true under network-denying profile', () => {
    const result = buildPlana().consumeTrait(
      netTrait({ requested: true, profileName: 'offline' }),
    );
    expect(result.status).toBe('vetoed');
    if (result.status !== 'vetoed') return;
    expect(result.veto.origin).toBe('pre-dispatch');
    expect(result.veto.reason).toMatch(/offline.*denies network/);
    // AC-G2: provenance must identify Plana as originator.
    expect(result.veto.provenance).toMatch(/^plana-/);
    expect(result.veto.propagation).toEqual({
      blocksSubmission: true,
      requestsCancellation: false,
      requestsTermination: false,
    });
  });

  it('veto branch: requested=true under provider-only profile', () => {
    const result = buildPlana().consumeTrait(
      netTrait({ requested: true, profileName: 'provider-only' }),
    );
    expect(result.status).toBe('vetoed');
  });
});

describe('Plana.consumeTrait — methodology TraitModule admission/governance', () => {
  function buildPlana(): Plana {
    return new Plana({
      trait: (trait) => {
        if (trait.kind !== 'trait-module') {
          return undefined;
        }
        if (!trait.requested) {
          return undefined;
        }
        if (
          trait.selectedSkillId === 'agent-methodology-origin' &&
          trait.selectedProfileId === 'evidence-only-runtime' &&
          trait.runtimeDecorationIntent === 'evidence-only' &&
          trait.runtimeDecorationEnforcement === 'required'
        ) {
          return undefined;
        }
        return vetoTrait(
          `methodology TraitModule selection ${trait.selectedSkillId}/${trait.selectedProfileId} with enforcement ${trait.runtimeDecorationEnforcement} is not admitted`,
          'plana-trait-module-methodology-skill',
        );
      },
    });
  }

  it('admits the approved evidence-only runtime decoration profile', () => {
    const result = buildPlana().consumeTrait(methodologyTrait());
    expect(result).toEqual({ status: 'approved' });
  });

  it('admits when methodology decoration is not requested', () => {
    const result = buildPlana().consumeTrait(
      methodologyTrait({ requested: false }),
    );
    expect(result).toEqual({ status: 'approved' });
  });

  it('vetoes an unapproved methodology profile selection', () => {
    const result = buildPlana().consumeTrait(
      methodologyTrait({
        runtimeDecorationEnforcement: 'advisory',
      }),
    );
    expect(result.status).toBe('vetoed');
    if (result.status !== 'vetoed') return;
    expect(result.veto.provenance).toBe('plana-trait-module-methodology-skill');
    expect(result.veto.reason).toContain('advisory');
  });
});

describe('vetoTrait — Plana provenance constructor', () => {
  it('defaults provenance to "plana-trait" with pre-dispatch origin', () => {
    const veto = vetoTrait('blocked by policy');
    expect(veto.origin).toBe('pre-dispatch');
    expect(veto.provenance).toBe('plana-trait');
    expect(veto.reason).toBe('blocked by policy');
  });

  it('respects an explicit provenance override', () => {
    const veto = vetoTrait('blocked', 'plana-trait-network-access');
    expect(veto.provenance).toBe('plana-trait-network-access');
  });
});

describe('AC-G3 — capability surface comment block co-located with consumer', () => {
  it('plana.ts contains the WU-O capability handoff table', () => {
    expect(PLANA_SOURCE).toMatch(
      /Capability surface handoff to WU-O .*§3\.4/,
    );
    expect(PLANA_SOURCE).toContain('execution.hasNetwork');
    expect(PLANA_SOURCE).toContain('capabilityFlags');
    // The comment must explicitly name WU-O as the consumer of these
    // implied capabilities, per AC-G3.
    expect(PLANA_SOURCE).toMatch(/WU-O reads this/);
  });

  it('plana.ts disclaims any capability surface mutation (WU-G boundary)', () => {
    expect(PLANA_SOURCE).toMatch(/does NOT mutate `ComputeCapabilitySurface`/);
    expect(PLANA_SOURCE).toMatch(/does NOT enumerate Apptainer flags/);
  });
});

describe('AC-G5 — no templerun leak in TRAIT modules', () => {
  it('plana.ts contains no templerun reference (case-insensitive)', () => {
    expect(/templerun/i.test(PLANA_SOURCE)).toBe(false);
  });

  it('capability-flag.ts and trait-module.ts contain no templerun reference', () => {
    expect(/templerun/i.test(CAPABILITY_FLAG_SOURCE)).toBe(false);
    expect(/templerun/i.test(TRAIT_MODULE_SOURCE)).toBe(false);
  });
});

describe('AC-G6 — single source of truth: Plana imports CapabilityFlag/TraitModuleId', () => {
  it('plana.ts imports CapabilityFlag from contracts/capability-flag', () => {
    expect(PLANA_SOURCE).toMatch(
      /import\s+type\s+\{\s*CapabilityFlag\s*\}\s+from\s+['"]\.\.\/contracts\/capability-flag\.js['"]/,
    );
  });

  it('plana.ts imports TraitModuleId from contracts/trait-module', () => {
    expect(PLANA_SOURCE).toMatch(
      /import\s+type\s+\{\s*TraitModuleId\s*\}\s+from\s+['"]\.\.\/contracts\/trait-module\.js['"]/,
    );
  });

  it('plana.ts does NOT redefine the CapabilityFlag union locally', () => {
    // No `type CapabilityFlag =` (or `export type CapabilityFlag =`) in
    // plana.ts itself; the legitimate source is the contract import.
    expect(/^\s*export\s+type\s+CapabilityFlag\s*=/m.test(PLANA_SOURCE)).toBe(false);
    expect(/^\s*type\s+CapabilityFlag\s*=/m.test(PLANA_SOURCE)).toBe(false);
  });

  it('network Plana request kind is typed as the contract-owned CapabilityFlag union', () => {
    // Structural assertion: the network discriminator is assignable to
    // CapabilityFlag — confirming the union is sourced from the contract.
    const t: PlanaTraitNetworkAccess = {
      kind: 'network-access',
      taskId: 't',
      provenance: 'p',
      requested: false,
      profileName: 'offline',
    };
    const k: CapabilityFlag = t.kind;
    expect(k).toBe('network-access');
  });

  it('methodology is sourced from the contract-owned TraitModule id', () => {
    const t: PlanaTraitMethodologySkill = methodologyTrait();
    const moduleId: TraitModuleId = t.moduleId;
    expect(moduleId).toBe(METHODOLOGY_SKILL_TRAIT_MODULE_ID);
    expect(t.kind).toBe('trait-module');
  });
});
