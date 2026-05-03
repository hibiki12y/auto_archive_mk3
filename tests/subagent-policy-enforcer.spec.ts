/**
 * M4 — SubagentPolicyEnforcer unit tests + roster integration test.
 *
 * Coverage:
 *   - Construction validation (depth, concurrent, allowedRoles, warnAtPercent)
 *   - Role allowlist denial
 *   - Depth cap denial
 *   - Concurrent / per-role cap denial
 *   - 80% utilization warning emission (concurrent + per-role)
 *   - Roster integration: enforcer denial throws RuntimeVetoError before
 *     existing roster caps fire
 *   - Roster integration: enforcer warning logs but spawn proceeds
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SubagentPolicyEnforcer,
  createSubagentPolicyEnforcer,
  type SubagentPolicy,
} from '../src/runtime/subagent-policy-enforcer.js';
import { createSubagentRoster } from '../src/runtime/subagent-roster.js';
import type { ResourceEnvelope } from '../src/contracts/resource-envelope.js';

const BASE_POLICY: SubagentPolicy = {
  maxDepth: 1,
  maxConcurrent: 4,
  allowedRoles: ['explorer', 'coder', 'verifier'],
};

function buildEnvelope(): ResourceEnvelope {
  return {
    requested: {
      cpuCores: 4,
      memoryMiB: 8192,
      wallTimeSec: 900,
      gpuCards: 0,
    },
    effective: {
      cpuCores: 4,
      memoryMiB: 8192,
      wallTimeSec: 900,
      gpuCards: 0,
    },
    observed: {},
  };
}

describe('SubagentPolicyEnforcer construction validation', () => {
  it('rejects maxDepth < 1', () => {
    expect(
      () =>
        new SubagentPolicyEnforcer({
          policy: { ...BASE_POLICY, maxDepth: 0 },
        }),
    ).toThrow(RangeError);
  });

  it('rejects maxConcurrent < 1', () => {
    expect(
      () =>
        new SubagentPolicyEnforcer({
          policy: { ...BASE_POLICY, maxConcurrent: 0 },
        }),
    ).toThrow(RangeError);
  });

  it('rejects empty allowedRoles', () => {
    expect(
      () =>
        new SubagentPolicyEnforcer({
          policy: { ...BASE_POLICY, allowedRoles: [] },
        }),
    ).toThrow(RangeError);
  });

  it('rejects warnAtPercent outside (0, 1)', () => {
    expect(
      () =>
        new SubagentPolicyEnforcer({
          policy: { ...BASE_POLICY, warnAtPercent: 0 },
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new SubagentPolicyEnforcer({
          policy: { ...BASE_POLICY, warnAtPercent: 1 },
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new SubagentPolicyEnforcer({
          policy: { ...BASE_POLICY, warnAtPercent: -0.5 },
        }),
    ).toThrow(RangeError);
  });
});

describe('SubagentPolicyEnforcer.evaluate()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows a spawn within all caps', () => {
    const enforcer = createSubagentPolicyEnforcer({ policy: BASE_POLICY });
    const decision = enforcer.evaluate({
      role: 'explorer',
      depth: 1,
      currentConcurrent: 0,
      currentPerRole: 0,
    });
    expect(decision.status).toBe('allowed');
    expect(decision.warnings).toEqual([]);
  });

  it('denies a role not in the allowlist', () => {
    const enforcer = createSubagentPolicyEnforcer({ policy: BASE_POLICY });
    const decision = enforcer.evaluate({
      role: 'executor',
      depth: 1,
      currentConcurrent: 0,
      currentPerRole: 0,
    });
    expect(decision.status).toBe('denied');
    expect(decision.reason).toContain('not in policy allowlist');
  });

  it('denies depth above maxDepth', () => {
    const enforcer = createSubagentPolicyEnforcer({ policy: BASE_POLICY });
    const decision = enforcer.evaluate({
      role: 'explorer',
      depth: 2,
      currentConcurrent: 0,
      currentPerRole: 0,
    });
    expect(decision.status).toBe('denied');
    expect(decision.reason).toContain('exceeds maxDepth');
  });

  it('denies when concurrent has reached maxConcurrent', () => {
    const enforcer = createSubagentPolicyEnforcer({ policy: BASE_POLICY });
    const decision = enforcer.evaluate({
      role: 'explorer',
      depth: 1,
      currentConcurrent: 4,
      currentPerRole: 0,
    });
    expect(decision.status).toBe('denied');
    expect(decision.reason).toContain('reached maxConcurrent');
  });

  it('denies when per-role count has reached the role cap', () => {
    const enforcer = createSubagentPolicyEnforcer({
      policy: { ...BASE_POLICY, perRoleCaps: { explorer: 2 } },
    });
    const decision = enforcer.evaluate({
      role: 'explorer',
      depth: 1,
      currentConcurrent: 1,
      currentPerRole: 2,
    });
    expect(decision.status).toBe('denied');
    expect(decision.reason).toContain('reached cap 2');
  });

  it('emits a warning at 80% concurrent utilization', () => {
    const logSpy = vi.fn();
    const enforcer = createSubagentPolicyEnforcer({
      policy: { ...BASE_POLICY, maxConcurrent: 5 },
      logger: logSpy,
    });
    // After spawn projection: 4/5 = 0.8 — warning threshold.
    const decision = enforcer.evaluate({
      role: 'explorer',
      depth: 1,
      currentConcurrent: 3,
      currentPerRole: 0,
    });
    expect(decision.status).toBe('allowed-with-warning');
    expect(decision.warnings.length).toBeGreaterThan(0);
    expect(decision.warnings[0]).toContain('concurrent utilization');
    const warnCall = logSpy.mock.calls.find(
      ([label]) => label === 'subagent-policy-warn',
    );
    expect(warnCall?.[1]).toMatchObject({ kind: 'concurrent-utilization' });
  });

  it('emits a warning at 80% per-role utilization', () => {
    const logSpy = vi.fn();
    const enforcer = createSubagentPolicyEnforcer({
      policy: {
        ...BASE_POLICY,
        maxConcurrent: 10,
        perRoleCaps: { explorer: 5 },
      },
      logger: logSpy,
    });
    // After spawn projection: 4/5 = 0.8 — warning threshold for explorer.
    const decision = enforcer.evaluate({
      role: 'explorer',
      depth: 1,
      currentConcurrent: 1,
      currentPerRole: 3,
    });
    expect(decision.status).toBe('allowed-with-warning');
    expect(
      decision.warnings.some((w) => w.includes('per-role utilization')),
    ).toBe(true);
    const warnCall = logSpy.mock.calls.find(
      ([label]) => label === 'subagent-policy-warn',
    );
    expect(warnCall?.[1]).toMatchObject({ kind: 'per-role-utilization' });
  });

  it('honors a custom warnAtPercent', () => {
    const enforcer = createSubagentPolicyEnforcer({
      policy: { ...BASE_POLICY, maxConcurrent: 10, warnAtPercent: 0.5 },
    });
    const decision = enforcer.evaluate({
      role: 'explorer',
      depth: 1,
      currentConcurrent: 4,
      currentPerRole: 0,
    });
    expect(decision.status).toBe('allowed-with-warning');
  });
});

describe('M4 integration — policy enforcer wired into createSubagentRoster', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws RuntimeVetoError when policy denies a disallowed role', async () => {
    const enforcer = createSubagentPolicyEnforcer({
      policy: {
        maxDepth: 1,
        maxConcurrent: 4,
        allowedRoles: ['explorer'],
      },
    });
    const roster = createSubagentRoster({
      taskId: 'task-policy-test',
      instanceId: 'instance-policy-test',
      envelope: buildEnvelope(),
      policyEnforcer: enforcer,
      parentDepth: 0,
    });

    await expect(roster.spawn({ role: 'verifier' })).rejects.toThrow(
      /subagent-policy-denied|not in policy allowlist/,
    );
  });

  it('proceeds with spawn when policy returns allowed-with-warning', async () => {
    const logSpy = vi.fn();
    const enforcer = createSubagentPolicyEnforcer({
      policy: {
        maxDepth: 1,
        maxConcurrent: 5,
        allowedRoles: ['explorer'],
      },
      logger: logSpy,
    });
    const roster = createSubagentRoster(
      {
        taskId: 'task-warning',
        instanceId: 'instance-warning',
        envelope: buildEnvelope(),
        policyEnforcer: enforcer,
        parentDepth: 0,
      },
      { maxConcurrent: 5 },
    );
    // Pre-fill with 3 explorers; the 4th will hit 80% utilization.
    await roster.spawn({ role: 'explorer' });
    await roster.spawn({ role: 'explorer' });
    await roster.spawn({ role: 'explorer' });
    const fourth = await roster.spawn({ role: 'explorer' });
    expect(fourth.role).toBe('explorer');

    const warnCall = logSpy.mock.calls.find(
      ([label]) => label === 'subagent-policy-warn',
    );
    expect(warnCall).toBeDefined();
  });

  it('omitting the policy enforcer leaves the roster behavior unchanged', async () => {
    const roster = createSubagentRoster({
      taskId: 'task-no-policy',
      instanceId: 'instance-no-policy',
      envelope: buildEnvelope(),
    });
    const descriptor = await roster.spawn({ role: 'verifier' });
    expect(descriptor.role).toBe('verifier');
  });
});
