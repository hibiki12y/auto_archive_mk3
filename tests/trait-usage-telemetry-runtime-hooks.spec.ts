import { describe, expect, it } from 'vitest';

import { METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST } from '../src/contracts/methodology-skill.js';
import { InMemoryTraitUsageTelemetry } from '../src/core/trait-usage-telemetry.js';
import { createMethodologyTraitUsageTelemetryMidCycleHooks } from '../src/runtime/trait-usage-telemetry-runtime-hooks.js';

describe('trait usage telemetry runtime hooks', () => {
  it('binds methodology TraitModule bump_use events to the in-memory sidecar', async () => {
    const telemetry = new InMemoryTraitUsageTelemetry();
    const hooks = createMethodologyTraitUsageTelemetryMidCycleHooks(telemetry);

    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      moduleId: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.id,
      moduleVersion: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.version,
    });
    expect(Object.keys(hooks[0] ?? {}).sort()).toEqual([
      'moduleId',
      'moduleVersion',
      'skillBumpUse',
    ]);

    await hooks[0]?.skillBumpUse?.(
      {
        moduleId: hooks[0].moduleId as never,
        moduleVersion: hooks[0].moduleVersion,
        observedAt: '2026-05-05T00:00:01.000Z',
      },
      {
        taskId: 'discord-task-usage-1',
        bumpedTraitModuleId: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.id,
      },
    );
    await hooks[0]?.skillBumpUse?.(
      {
        moduleId: hooks[0].moduleId as never,
        moduleVersion: hooks[0].moduleVersion,
        observedAt: '2026-05-05T00:00:02.000Z',
      },
      {
        taskId: 'discord-task-usage-2',
        bumpedTraitModuleId: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.id,
      },
    );

    expect(telemetry.snapshot()).toEqual([
      {
        traitModuleId: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.id,
        useCount: 2,
        firstUsedAt: '2026-05-05T00:00:01.000Z',
        lastUsedAt: '2026-05-05T00:00:02.000Z',
        lastTaskId: 'discord-task-usage-2',
      },
    ]);
  });
});
