import { describe, expect, it } from 'vitest';

import {
  createTraitUsageTelemetryBumpUseHook,
  InMemoryTraitUsageTelemetry,
} from '../src/core/trait-usage-telemetry.js';

describe('Trait usage telemetry', () => {
  it('increments use_count-compatible stats without mutating caller snapshots', () => {
    const telemetry = new InMemoryTraitUsageTelemetry([], () =>
      new Date('2026-05-05T00:00:00.000Z'),
    );

    const first = telemetry.bumpUse({
      taskId: 'task-1',
      bumpedTraitModuleId: 'trait.methodology.agent-methodology-origin.v1',
    });
    const snapshot = telemetry.snapshot();
    const second = telemetry.bumpUse(
      {
        taskId: 'task-2',
        bumpedTraitModuleId: 'trait.methodology.agent-methodology-origin.v1',
      },
      { observedAt: '2026-05-05T00:00:01.000Z' },
    );

    expect(first).toMatchObject({
      useCount: 1,
      firstUsedAt: '2026-05-05T00:00:00.000Z',
      lastUsedAt: '2026-05-05T00:00:00.000Z',
      lastTaskId: 'task-1',
    });
    expect(snapshot[0]).toMatchObject({ useCount: 1, lastTaskId: 'task-1' });
    expect(second).toMatchObject({
      useCount: 2,
      firstUsedAt: '2026-05-05T00:00:00.000Z',
      lastUsedAt: '2026-05-05T00:00:01.000Z',
      lastTaskId: 'task-2',
    });
    expect(snapshot[0]).toMatchObject({ useCount: 1, lastTaskId: 'task-1' });
    expect(telemetry.snapshot()[0]).toMatchObject({
      useCount: 2,
      lastTaskId: 'task-2',
    });
  });

  it('returns snapshots sorted by traitModuleId for deterministic consumers', () => {
    const telemetry = new InMemoryTraitUsageTelemetry();

    telemetry.bumpUse({
      taskId: 'task-z',
      bumpedTraitModuleId: 'trait.zeta.demo.v1',
    });
    telemetry.bumpUse({
      taskId: 'task-a',
      bumpedTraitModuleId: 'trait.alpha.demo.v1',
    });

    expect(telemetry.snapshot().map((entry) => entry.traitModuleId)).toEqual([
      'trait.alpha.demo.v1',
      'trait.zeta.demo.v1',
    ]);
  });

  it('adapts skillBumpUse hooks into the telemetry sidecar', async () => {
    const telemetry = new InMemoryTraitUsageTelemetry();
    const hook = createTraitUsageTelemetryBumpUseHook(telemetry);

    await hook(
      {
        moduleId: 'trait.methodology.agent-methodology-origin.v1',
        moduleVersion: '1.0.0',
        observedAt: '2026-05-05T00:00:02.000Z',
      },
      {
        taskId: 'task-hook',
        bumpedTraitModuleId: 'trait.methodology.agent-methodology-origin.v1',
      },
    );

    expect(telemetry.snapshot()).toEqual([
      {
        traitModuleId: 'trait.methodology.agent-methodology-origin.v1',
        useCount: 1,
        firstUsedAt: '2026-05-05T00:00:02.000Z',
        lastUsedAt: '2026-05-05T00:00:02.000Z',
        lastTaskId: 'task-hook',
      },
    ]);
  });
});
