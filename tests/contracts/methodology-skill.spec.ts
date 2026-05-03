import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  METHODOLOGY_SKILL_IDS,
  METHODOLOGY_SKILL_PROFILE_IDS,
  METHODOLOGY_SKILL_PROFILES,
  METHODOLOGY_SKILL_SOURCE_MAP,
  METHODOLOGY_SKILL_TRAIT_MODULE_ID,
  METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
  createMethodologySkillEvidenceCheckpoint,
  formatMethodologySkillEvidenceCheckpointDetail,
  getMethodologySkillProfile,
  isMethodologySkillId,
  isMethodologySkillProfileId,
  type MethodologySkillEvidenceCheckpoint,
  type MethodologySkillId,
  type MethodologySkillProfileId,
} from '../../src/contracts/methodology-skill.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT_SOURCE = readFileSync(
  resolve(HERE, '../../src/contracts/methodology-skill.ts'),
  'utf8',
);
const REPO_ROOT = resolve(HERE, '../..');

describe('contracts/methodology-skill', () => {
  it('exports the canonical skill/profile identifiers', () => {
    expectTypeOf<MethodologySkillId>().toEqualTypeOf<'agent-methodology-origin'>();
    expectTypeOf<MethodologySkillProfileId>().toEqualTypeOf<'evidence-only-runtime'>();
    expect([...METHODOLOGY_SKILL_IDS]).toEqual(['agent-methodology-origin']);
    expect([...METHODOLOGY_SKILL_PROFILE_IDS]).toEqual(['evidence-only-runtime']);
  });

  it('exposes repository-owned source-map URLs without external imports', () => {
    expect(METHODOLOGY_SKILL_SOURCE_MAP['chain-of-thought-2201.11903']).toBe(
      'https://arxiv.org/abs/2201.11903',
    );
    expect(METHODOLOGY_SKILL_SOURCE_MAP['react-2210.03629']).toBe(
      'https://arxiv.org/abs/2210.03629',
    );
    expect(Object.keys(METHODOLOGY_SKILL_SOURCE_MAP)).toHaveLength(8);
  });

  it('publishes the evidence-only runtime profile contract', () => {
    const profile = getMethodologySkillProfile('evidence-only-runtime');
    expect(profile).toEqual(METHODOLOGY_SKILL_PROFILES[0]);
    expect(profile.skillId).toBe('agent-methodology-origin');
    expect(profile.runtimeDecorationIntent).toBe('evidence-only');
    expect(profile.criteria).toContain('observable-summary-only');
  });

  it('publishes methodology as a repository-owned TraitModule manifest', () => {
    expect(METHODOLOGY_SKILL_TRAIT_MODULE_ID).toBe(
      'trait.methodology.agent-methodology-origin.v1',
    );
    expect(METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.id).toBe(
      METHODOLOGY_SKILL_TRAIT_MODULE_ID,
    );
    expect(METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.trustBoundary).toBe(
      'repository-owned',
    );
    expect(METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.instructions.entrypoint).toBe(
      'TRAIT.md',
    );
    expect(METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.runtime.hook).toBe(
      'evidence-decorator',
    );
    expect(METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.runtime).toMatchObject({
      exportName: 'composeTraitRuntimeDriver',
    });
    expect(
      METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.admission.requiredCapabilityFlags,
    ).toEqual([]);
    expect(
      METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.admission.forbiddenCapabilityFlags,
    ).toContain('network-access');
  });

  it('keeps the physical methodology trait manifest in sync with the contract export', () => {
    const physicalManifest = JSON.parse(
      readFileSync(
        resolve(REPO_ROOT, 'traits/methodology-agent-origin/trait.json'),
        'utf8',
      ),
    ) as unknown;
    const traitText = readFileSync(
      resolve(REPO_ROOT, 'traits/methodology-agent-origin/TRAIT.md'),
      'utf8',
    );

    expect(physicalManifest).toEqual(METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST);
    expect(traitText).toContain('evidence-only runtime decorator');
    expect(traitText).toContain('not a provider switch');
    expect(traitText).toContain('must not rewrite `TerminalCause`');
  });

  it('builds evidence checkpoints with observable-only metadata', () => {
    const checkpoint = createMethodologySkillEvidenceCheckpoint({
      taskId: 'task-methodology-1',
      requested: true,
      selectedSkillId: 'agent-methodology-origin',
      selectedProfileId: 'evidence-only-runtime',
      runtimeDecorationIntent: 'evidence-only',
      runtimeDecorationEnforcement: 'required',
      checkpoint: 'runtime-decoration-complete',
      completionStatus: 'delegate-returned',
      causeKind: 'success',
    });

    expectTypeOf(checkpoint).toEqualTypeOf<MethodologySkillEvidenceCheckpoint>();
    expect(checkpoint.summary).toContain('completed');
    expect(checkpoint.criteria).toContain('criteria-and-checkpoints-only');
    expect(checkpoint.sourceMapIds).toContain('process-supervision-2305.20050');
    expect(formatMethodologySkillEvidenceCheckpointDetail(checkpoint)).toContain(
      'checkpoint=runtime-decoration-complete',
    );
  });

  it('guards the declared skill/profile identifiers', () => {
    expect(isMethodologySkillId('agent-methodology-origin')).toBe(true);
    expect(isMethodologySkillId('templerun')).toBe(false);
    expect(isMethodologySkillProfileId('evidence-only-runtime')).toBe(true);
    expect(isMethodologySkillProfileId('full-prompt-capture')).toBe(false);
  });

  it('imports only contract types and contains no templerun reference', () => {
    const importLines = CONTRACT_SOURCE.split('\n').filter((line) =>
      /^\s*import\s/.test(line),
    );
    expect(importLines).toEqual([
      "import type { TraitModuleId, TraitModuleManifest } from './trait-module.js';",
    ]);
    expect(/templerun/i.test(CONTRACT_SOURCE)).toBe(false);
  });
});
