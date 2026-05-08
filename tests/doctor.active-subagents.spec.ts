/**
 * P4 Stage 4-2 — `/doctor` active-subagent panel.
 *
 * Verifies the new `Active subagents` doctor section sourced from a
 * duck-typed `SubagentRosterRegistry` probe. Mirrors the
 * env-omission pattern of `provider-observability` and
 * `per-advisor health`: when no probe is supplied, the section is
 * omitted bit-for-bit.
 */
import { describe, expect, it } from 'vitest';

import {
  buildDoctorReport,
  resolveActiveSubagentDoctorStatus,
  type ActiveSubagentRegistryProbe,
  type ActiveSubagentRegistryProbeRegistration,
} from '../src/core/doctor.js';

const FIXED_AT = '2026-05-08T00:00:00.000Z';

function baseInput() {
  return {
    ledgerEnabled: true,
    accessPolicyEnabled: true,
    authDatabaseEnabled: true,
    runtimeProviderScope: 'multi-provider' as const,
    activeRuntimeProvider: 'codex' as const,
    approvalRegistryEnabled: true,
    executionApprovalPolicy: 'single-use' as const,
    toolLoopDetectorEnabled: true,
    generatedAt: FIXED_AT,
  };
}

function probeFromRegistrations(
  registrations: readonly ActiveSubagentRegistryProbeRegistration[],
): ActiveSubagentRegistryProbe {
  return {
    list: () => registrations,
    totals: () => {
      let active = 0;
      let spawning = 0;
      let reserved = 0;
      for (const registration of registrations) {
        try {
          for (const descriptor of registration.roster.snapshot()) {
            if (descriptor.state === 'active') active += 1;
            else if (descriptor.state === 'spawning') spawning += 1;
            else if (descriptor.state === 'reserved') reserved += 1;
          }
        } catch {
          /* ignore */
        }
      }
      return { active, spawning, reserved };
    },
  };
}

function dispatch(
  taskId: string,
  instanceId: string,
  states: readonly string[],
): ActiveSubagentRegistryProbeRegistration {
  return {
    taskId,
    instanceId,
    roster: {
      snapshot: () => states.map((state) => ({ state })),
    },
  };
}

function brokenDispatch(
  taskId: string,
  instanceId: string,
): ActiveSubagentRegistryProbeRegistration {
  return {
    taskId,
    instanceId,
    roster: {
      snapshot: () => {
        throw new Error('snapshot exploded');
      },
    },
  };
}

describe('Active subagents doctor section (P4 Stage 4-2)', () => {
  it('omits the section entirely when no registry probe is supplied', () => {
    const status = resolveActiveSubagentDoctorStatus({});
    expect(status).toBeUndefined();
    const report = buildDoctorReport(baseInput());
    const found = report.sections.find(
      (entry) => entry.name === 'Active subagents',
    );
    expect(found).toBeUndefined();
  });

  it('registry with 0 active dispatches → totals all zero, section status PASS', () => {
    const probe = probeFromRegistrations([]);
    const status = resolveActiveSubagentDoctorStatus({
      subagentRosterRegistry: probe,
    });
    expect(status).toBeDefined();
    expect(status!.status).toBe('pass');
    expect(status!.dispatchCount).toBe(0);
    expect(status!.active).toBe(0);
    expect(status!.spawning).toBe(0);
    expect(status!.reserved).toBe(0);

    const report = buildDoctorReport({
      ...baseInput(),
      activeSubagents: status,
    });
    const section = report.sections.find(
      (entry) => entry.name === 'Active subagents',
    );
    expect(section).toBeDefined();
    expect(section!.status).toBe('pass');
    expect(
      section!.details.some((detail) => detail === 'Active dispatches: 0'),
    ).toBe(true);
    expect(
      section!.details.some(
        (detail) => detail === 'Subagent totals: active=0 spawning=0 reserved=0',
      ),
    ).toBe(true);
    expect(
      section!.details.some(
        (detail) => detail === 'No dispatches currently registered.',
      ),
    ).toBe(true);
  });

  it('registry with 2 active dispatches and 0 subagents each → status PASS with per-dispatch breakdown', () => {
    const probe = probeFromRegistrations([
      dispatch('task-A', 'inst-A', []),
      dispatch('task-B', 'inst-B', []),
    ]);
    const status = resolveActiveSubagentDoctorStatus({
      subagentRosterRegistry: probe,
    });
    expect(status).toBeDefined();
    expect(status!.status).toBe('pass');
    expect(status!.dispatchCount).toBe(2);
    expect(status!.dispatches).toHaveLength(2);
    expect(status!.dispatches[0]?.taskId).toBe('task-A');
    expect(status!.dispatches[0]?.active).toBe(0);
    expect(status!.dispatches[1]?.taskId).toBe('task-B');

    const report = buildDoctorReport({
      ...baseInput(),
      activeSubagents: status,
    });
    const section = report.sections.find(
      (entry) => entry.name === 'Active subagents',
    );
    expect(section).toBeDefined();
    expect(section!.status).toBe('pass');
    expect(
      section!.details.some((detail) =>
        detail.includes('task-A (inst-A): active=0 spawning=0 reserved=0'),
      ),
    ).toBe(true);
    expect(
      section!.details.some((detail) =>
        detail.includes('task-B (inst-B): active=0 spawning=0 reserved=0'),
      ),
    ).toBe(true);
  });

  it('broken roster in registry → row marked probeError and section status WARN, surface still rendered', () => {
    const probe = probeFromRegistrations([
      brokenDispatch('task-broken', 'inst-broken'),
      dispatch('task-ok', 'inst-ok', ['active']),
    ]);
    const status = resolveActiveSubagentDoctorStatus({
      subagentRosterRegistry: probe,
    });
    expect(status).toBeDefined();
    expect(status!.status).toBe('warn');
    expect(status!.active).toBe(1); // ok dispatch contributes 1
    expect(status!.dispatches).toHaveLength(2);
    expect(status!.dispatches[0]?.probeError).toBe(true);
    expect(status!.dispatches[1]?.probeError).toBeUndefined();

    const report = buildDoctorReport({
      ...baseInput(),
      activeSubagents: status,
    });
    const section = report.sections.find(
      (entry) => entry.name === 'Active subagents',
    );
    expect(section).toBeDefined();
    expect(section!.status).toBe('warn');
    expect(
      section!.details.some((detail) =>
        detail.includes(
          'task-broken (inst-broken): roster snapshot threw — counts unavailable',
        ),
      ),
    ).toBe(true);
    expect(
      section!.details.some((detail) =>
        detail.includes('task-ok (inst-ok): active=1 spawning=0 reserved=0'),
      ),
    ).toBe(true);
  });

  it('registry list() throws → status FAIL with registryError flag', () => {
    const probe: ActiveSubagentRegistryProbe = {
      list: () => {
        throw new Error('registry exploded');
      },
      totals: () => ({ active: 0, spawning: 0, reserved: 0 }),
    };
    const status = resolveActiveSubagentDoctorStatus({
      subagentRosterRegistry: probe,
    });
    expect(status).toBeDefined();
    expect(status!.status).toBe('fail');
    expect(status!.registryError).toBe(true);
    expect(status!.dispatchCount).toBe(0);

    const report = buildDoctorReport({
      ...baseInput(),
      activeSubagents: status,
    });
    const section = report.sections.find(
      (entry) => entry.name === 'Active subagents',
    );
    expect(section).toBeDefined();
    expect(section!.status).toBe('fail');
    expect(
      section!.details.some((detail) =>
        detail.includes('Subagent roster registry probe threw'),
      ),
    ).toBe(true);
  });
});
