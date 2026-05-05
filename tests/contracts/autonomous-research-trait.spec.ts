import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  AUTONOMOUS_RESEARCH_TRAIT_IDS,
  AUTONOMOUS_RESEARCH_TRAIT_MODULE_ID,
  AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST,
  AUTONOMOUS_RESEARCH_TRAIT_PROFILE_IDS,
  AUTONOMOUS_RESEARCH_TRAIT_PROFILES,
  AUTONOMOUS_RESEARCH_TRAIT_SOURCE_MAP,
  createAutonomousResearchEvidenceCheckpoint,
  formatAutonomousResearchEvidenceCheckpointDetail,
  getAutonomousResearchTraitProfile,
  isAutonomousResearchTraitId,
  isAutonomousResearchTraitProfileId,
  type AutonomousResearchEvidenceCheckpoint,
  type AutonomousResearchTraitId,
  type AutonomousResearchTraitProfileId,
} from '../../src/contracts/autonomous-research-trait.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT_SOURCE = readFileSync(
  resolve(HERE, '../../src/contracts/autonomous-research-trait.ts'),
  'utf8',
);
const REPO_ROOT = resolve(HERE, '../..');

describe('contracts/autonomous-research-trait', () => {
  it('exports the canonical trait/profile identifiers', () => {
    expectTypeOf<AutonomousResearchTraitId>().toEqualTypeOf<'autonomous-research-goal-loop'>();
    expectTypeOf<AutonomousResearchTraitProfileId>().toEqualTypeOf<'dgm-bounded-archive-runtime'>();
    expect([...AUTONOMOUS_RESEARCH_TRAIT_IDS]).toEqual([
      'autonomous-research-goal-loop',
    ]);
    expect([...AUTONOMOUS_RESEARCH_TRAIT_PROFILE_IDS]).toEqual([
      'dgm-bounded-archive-runtime',
    ]);
  });

  it('maps the DGM source without importing external reference code', () => {
    expect(
      AUTONOMOUS_RESEARCH_TRAIT_SOURCE_MAP['darwin-godel-machine-2505.22954'],
    ).toBe('https://arxiv.org/abs/2505.22954');
    expect(Object.keys(AUTONOMOUS_RESEARCH_TRAIT_SOURCE_MAP)).toHaveLength(1);
  });

  it('publishes the bounded archive runtime profile contract', () => {
    const profile = getAutonomousResearchTraitProfile(
      'dgm-bounded-archive-runtime',
    );
    expect(profile).toEqual(AUTONOMOUS_RESEARCH_TRAIT_PROFILES[0]);
    expect(profile.traitId).toBe('autonomous-research-goal-loop');
    expect(profile.runtimeDecorationIntent).toBe('bounded-archive-evidence');
    expect(profile.criteria).toContain(
      'explicit-goal-and-stop-condition-required',
    );
    expect(profile.criteria).toContain('empirical-evidence-gate-required');
  });

  it('publishes autonomous research as a repository-owned TraitModule manifest', () => {
    expect(AUTONOMOUS_RESEARCH_TRAIT_MODULE_ID).toBe(
      'trait.research.autonomous-goal-loop.v1',
    );
    expect(AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST.id).toBe(
      AUTONOMOUS_RESEARCH_TRAIT_MODULE_ID,
    );
    expect(AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST.trustBoundary).toBe(
      'repository-owned',
    );
    expect(AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST.runtime).toMatchObject({
      hook: 'evidence-decorator',
      exportName: 'composeTraitRuntimeDriver',
    });
    expect(
      AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST.admission.requiredCapabilityFlags,
    ).toEqual([]);
    expect(
      AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST.admission
        .forbiddenCapabilityFlags,
    ).toEqual([
      'network-access',
      'web-search-mode',
      'sandbox-mode',
      'approval-policy',
    ]);
  });

  it('keeps the physical autonomous research trait manifest in sync', () => {
    const physicalManifest = JSON.parse(
      readFileSync(
        resolve(REPO_ROOT, 'traits/autonomous-research-goal-loop/trait.json'),
        'utf8',
      ),
    ) as unknown;
    const traitText = readFileSync(
      resolve(REPO_ROOT, 'traits/autonomous-research-goal-loop/TRAIT.md'),
      'utf8',
    );

    expect(physicalManifest).toEqual(AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST);
    expect(traitText).toContain('Darwin Gödel Machine');
    expect(traitText).toContain('archive of research stepping stones');
    expect(traitText).toContain('not an unbounded autonomous runner');
    expect(traitText).toContain('completion audit');
  });

  it('builds evidence checkpoints with DGM archive-loop metadata', () => {
    const checkpoint = createAutonomousResearchEvidenceCheckpoint({
      taskId: 'task-autonomous-research-1',
      requested: true,
      selectedTraitId: 'autonomous-research-goal-loop',
      selectedProfileId: 'dgm-bounded-archive-runtime',
      runtimeDecorationIntent: 'bounded-archive-evidence',
      runtimeDecorationEnforcement: 'required',
      checkpoint: 'runtime-decoration-complete',
      completionStatus: 'delegate-returned',
      causeKind: 'success',
    });

    expectTypeOf(checkpoint).toEqualTypeOf<AutonomousResearchEvidenceCheckpoint>();
    expect(checkpoint.summary).toContain('completed');
    expect(checkpoint.criteria).toContain('archive-stepping-stones-recorded');
    expect(checkpoint.sourceMapIds).toContain(
      'darwin-godel-machine-2505.22954',
    );
    expect(
      formatAutonomousResearchEvidenceCheckpointDetail(checkpoint),
    ).toContain('checkpoint=runtime-decoration-complete');
  });

  it('guards declared trait/profile identifiers', () => {
    expect(isAutonomousResearchTraitId('autonomous-research-goal-loop')).toBe(
      true,
    );
    expect(isAutonomousResearchTraitId('darwin-godel-machine')).toBe(false);
    expect(
      isAutonomousResearchTraitProfileId('dgm-bounded-archive-runtime'),
    ).toBe(true);
    expect(isAutonomousResearchTraitProfileId('unbounded-runner')).toBe(false);
  });

  it('imports only contract types and avoids provider/runtime authority claims', () => {
    const importLines = CONTRACT_SOURCE.split('\n').filter((line) =>
      /^\s*import\s/.test(line),
    );
    expect(importLines).toEqual([
      "import type { TraitModuleId, TraitModuleManifest } from './trait-module.js';",
    ]);
    expect(CONTRACT_SOURCE).not.toContain('provider-switch');
    expect(CONTRACT_SOURCE).not.toContain('full-auto');
  });
});
