/**
 * P4 Stage 4-2 — `SubagentRosterRegistry` contract.
 *
 * Verifies the service-scope registry that bridges dispatch-scoped
 * `SubagentRoster` instances with the Discord operator surface and the
 * `/doctor` active-subagent panel. The registry is a thin in-memory map
 * keyed by `taskId`; tests cover idempotent register/unregister, frozen
 * snapshots, totals aggregation, and resilience against a broken roster.
 */
import { describe, expect, it, vi } from 'vitest';

import type { SubagentDescriptor } from '../../src/contracts/subagent-roster.js';
import type { SubagentRoster } from '../../src/runtime/subagent-roster.js';
import {
  createSubagentRosterRegistry,
  type SubagentRosterRegistration,
} from '../../src/runtime/subagent-roster-registry.js';

function frozenDescriptor(
  override: Partial<SubagentDescriptor>,
): SubagentDescriptor {
  return Object.freeze({
    subagentId: override.subagentId ?? 'subagent-1',
    role: override.role ?? 'explorer',
    parent: Object.freeze({
      taskId: override.parent?.taskId ?? 'task-1',
      instanceId: override.parent?.instanceId ?? 'instance-1',
    }),
    createdAt: override.createdAt ?? '2026-05-08T00:00:00.000Z',
    state: override.state ?? 'active',
    envelope: override.envelope ?? Object.freeze({
      requested: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
      derived: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
    }),
  }) as SubagentDescriptor;
}

function createStubRoster(
  descriptors: readonly SubagentDescriptor[] = [],
): SubagentRoster {
  return {
    spawn: vi.fn(),
    terminate: vi.fn(),
    terminateAll: vi.fn(),
    events: {
      [Symbol.asyncIterator]: () =>
        ({
          next: () => Promise.resolve({ value: undefined, done: true as const }),
        }) as AsyncIterator<never>,
    },
    snapshot: () => Object.freeze([...descriptors]),
  } as unknown as SubagentRoster;
}

function createBrokenRoster(): SubagentRoster {
  return {
    spawn: vi.fn(),
    terminate: vi.fn(),
    terminateAll: vi.fn(),
    events: {
      [Symbol.asyncIterator]: () =>
        ({
          next: () => Promise.resolve({ value: undefined, done: true as const }),
        }) as AsyncIterator<never>,
    },
    snapshot: () => {
      throw new Error('snapshot exploded');
    },
  } as unknown as SubagentRoster;
}

describe('SubagentRosterRegistry — register/find/list/totals', () => {
  it('register/find/list happy path — round-trips a single registration', () => {
    const registry = createSubagentRosterRegistry();
    const roster = createStubRoster();
    registry.register({ taskId: 'task-A', instanceId: 'inst-A', roster });

    const found = registry.find('task-A');
    expect(found).toBeDefined();
    expect(found?.taskId).toBe('task-A');
    expect(found?.instanceId).toBe('inst-A');
    expect(found?.roster).toBe(roster);

    const listed = registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.taskId).toBe('task-A');
  });

  it('duplicate register replaces atomically — only the latest entry survives', () => {
    const registry = createSubagentRosterRegistry();
    const rosterA = createStubRoster();
    const rosterB = createStubRoster();
    registry.register({ taskId: 'task-dup', instanceId: 'inst-1', roster: rosterA });
    registry.register({ taskId: 'task-dup', instanceId: 'inst-2', roster: rosterB });

    expect(registry.list()).toHaveLength(1);
    const found = registry.find('task-dup');
    expect(found?.instanceId).toBe('inst-2');
    expect(found?.roster).toBe(rosterB);
  });

  it('unregister missing taskId is a no-op (idempotent)', () => {
    const registry = createSubagentRosterRegistry();
    expect(() => registry.unregister('never-registered')).not.toThrow();
    expect(registry.list()).toHaveLength(0);

    // Register, unregister twice — second call must not throw.
    registry.register({
      taskId: 'task-X',
      instanceId: 'inst-X',
      roster: createStubRoster(),
    });
    registry.unregister('task-X');
    expect(() => registry.unregister('task-X')).not.toThrow();
    expect(registry.find('task-X')).toBeUndefined();
  });

  it('totals aggregate across multiple rosters by descriptor state', () => {
    const registry = createSubagentRosterRegistry();
    registry.register({
      taskId: 'task-A',
      instanceId: 'inst-A',
      roster: createStubRoster([
        frozenDescriptor({ subagentId: 'a-1', state: 'active' }),
        frozenDescriptor({ subagentId: 'a-2', state: 'reserved' }),
      ]),
    });
    registry.register({
      taskId: 'task-B',
      instanceId: 'inst-B',
      roster: createStubRoster([
        frozenDescriptor({ subagentId: 'b-1', state: 'active' }),
        frozenDescriptor({ subagentId: 'b-2', state: 'spawning' }),
        // A terminated descriptor must NOT contribute to totals.
        frozenDescriptor({ subagentId: 'b-3', state: 'terminated' }),
      ]),
    });

    const totals = registry.totals();
    expect(totals).toEqual({ active: 2, spawning: 1, reserved: 1 });
  });

  it('broken roster (snapshot throws) does not break totals or list', () => {
    const registry = createSubagentRosterRegistry();
    registry.register({
      taskId: 'task-broken',
      instanceId: 'inst-broken',
      roster: createBrokenRoster(),
    });
    registry.register({
      taskId: 'task-ok',
      instanceId: 'inst-ok',
      roster: createStubRoster([
        frozenDescriptor({ subagentId: 'ok-1', state: 'active' }),
      ]),
    });

    // List still shows both registrations — the broken one is not
    // hidden from the operator surface; only its descriptor count is
    // treated as zero.
    expect(registry.list()).toHaveLength(2);

    const totals = registry.totals();
    expect(totals).toEqual({ active: 1, spawning: 0, reserved: 0 });
  });

  it('list returns a frozen snapshot — mutation does not leak into the registry', () => {
    const registry = createSubagentRosterRegistry();
    registry.register({
      taskId: 'task-frozen',
      instanceId: 'inst-frozen',
      roster: createStubRoster(),
    });
    const snapshot = registry.list();

    // The returned array is frozen — push/length-mutation throws in
    // strict mode (vitest runs ESM/strict).
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as SubagentRosterRegistration[]).push({
        taskId: 'spoof',
        instanceId: 'spoof',
        roster: createStubRoster(),
      });
    }).toThrow();

    // Internal state is unchanged.
    expect(registry.list()).toHaveLength(1);
    expect(registry.find('spoof')).toBeUndefined();
  });
});

