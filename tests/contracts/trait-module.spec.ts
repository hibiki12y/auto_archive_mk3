import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { CapabilityFlag } from '../../src/contracts/capability-flag.js';
import {
  METHODOLOGY_SKILL_TRAIT_MODULE_ID,
  METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
} from '../../src/contracts/methodology-skill.js';
import {
  TRAIT_MODULE_SCHEMA_VERSION,
  isTraitModuleId,
  isTraitModuleManifest,
  type TraitModuleId,
  type TraitModuleManifest,
} from '../../src/contracts/trait-module.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRAIT_MODULE_SOURCE = readFileSync(
  resolve(HERE, '../../src/contracts/trait-module.ts'),
  'utf8',
);

describe('contracts/trait-module — Auto Archive TraitModule manifest', () => {
  it('defines TraitModuleId as the trait.<name>.vN namespace', () => {
    expectTypeOf<TraitModuleId>().toMatchTypeOf<`trait.${string}.v${number}`>();
    expect(isTraitModuleId('trait.methodology.agent-methodology-origin.v1')).toBe(
      true,
    );
    expect(isTraitModuleId('methodology-skill')).toBe(false);
    expect(isTraitModuleId('network-access')).toBe(false);
  });

  it('keeps capability flags separate from TraitModule identity', () => {
    const capabilityFlag: CapabilityFlag = 'network-access';
    const moduleId: TraitModuleId = METHODOLOGY_SKILL_TRAIT_MODULE_ID;

    expect(capabilityFlag).toBe('network-access');
    expect(moduleId).toBe('trait.methodology.agent-methodology-origin.v1');
    expect(METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.admission.requiredCapabilityFlags)
      .toEqual([]);
    expect(METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.admission.forbiddenCapabilityFlags)
      .toContain('network-access');
  });

  it('validates the built-in methodology manifest shape', () => {
    const manifest: TraitModuleManifest = METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST;
    expect(
      isTraitModuleManifest(METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST),
    ).toBe(true);
    expect(manifest.schemaVersion).toBe(
      TRAIT_MODULE_SCHEMA_VERSION,
    );
    expect(manifest.layout.manifest).toBe(
      'trait.json',
    );
    expect(manifest.instructions.entrypoint).toBe(
      'TRAIT.md',
    );
  });

  it('represents scheduler/runtime as declarations, not live execution', () => {
    expect(METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.schedule.mode).toBe('none');
    expect(METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.runtime).toMatchObject({
      hook: 'evidence-decorator',
      modulePath: 'src/runtime/methodology-skill-runtime-driver.ts',
      exportName: 'composeTraitRuntimeDriver',
      enforcement: 'required',
    });
  });

  it('does not import core/runtime loaders or encode provider switching', () => {
    expect(TRAIT_MODULE_SOURCE).not.toMatch(/from\s+['"].*src\/core/);
    expect(TRAIT_MODULE_SOURCE).not.toMatch(/from\s+['"].*src\/runtime/);
    expect(TRAIT_MODULE_SOURCE).not.toMatch(/provider switch/i);
    expect(TRAIT_MODULE_SOURCE).not.toMatch(/codex|openai|templerun/i);
    expect(TRAIT_MODULE_SOURCE).toContain('not an ambient surface deny-list');
  });
});
