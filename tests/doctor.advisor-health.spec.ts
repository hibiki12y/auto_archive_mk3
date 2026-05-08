import { describe, expect, it } from 'vitest';

import {
  buildDoctorReport,
  buildDoctorReportFromEnv,
  resolveAdvisorHealthDoctorStatus,
  type AdvisorHealthProbe,
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

function makeAdvisorProbe(
  consecutive: number,
  counts: {
    advisorErrorFailOpen: number;
    advisorErrorFailClosed: number;
    capReached?: number;
  },
): AdvisorHealthProbe {
  return {
    consecutiveAdvisorErrors: () => consecutive,
    consultationCounts: () => counts,
  };
}

describe('Per-advisor health doctor section (P2-D)', () => {
  it('omits the section entirely when neither advisor probe is supplied', () => {
    const status = resolveAdvisorHealthDoctorStatus({});
    expect(status).toBeUndefined();
    const report = buildDoctorReport(baseInput());
    const found = report.sections.find(
      (entry) => entry.name === 'Per-advisor health',
    );
    expect(found).toBeUndefined();
  });

  it('advisor health probe surfaces consecutive errors and counts', () => {
    const claudeAdvisor = makeAdvisorProbe(0, {
      advisorErrorFailOpen: 0,
      advisorErrorFailClosed: 0,
      capReached: 0,
    });
    const codexAdvisor = makeAdvisorProbe(1, {
      advisorErrorFailOpen: 1,
      advisorErrorFailClosed: 0,
      capReached: 2,
    });
    const status = resolveAdvisorHealthDoctorStatus({
      claudeAdvisor,
      codexAdvisor,
    });
    expect(status).toBeDefined();
    expect(status!.roles).toHaveLength(2);
    expect(status!.thresholds).toEqual([3, 10]);
    const report = buildDoctorReport({
      ...baseInput(),
      advisorHealth: status,
    });
    const sec = report.sections.find(
      (entry) => entry.name === 'Per-advisor health',
    );
    expect(sec).toBeDefined();
    // claude is OK (consecutive=0), codex is WARN (consecutive=1 < 3)
    expect(sec!.status).toBe('warn');
    expect(
      sec!.details.some((detail) =>
        detail.includes(
          'claude: status=PASS consecutive=0 fail-open=0 fail-closed=0 cap-reached=0',
        ),
      ),
    ).toBe(true);
    expect(
      sec!.details.some((detail) =>
        detail.includes(
          'codex: status=WARN consecutive=1 fail-open=1 fail-closed=0 cap-reached=2',
        ),
      ),
    ).toBe(true);
    // thresholds rendered in role rows so operator sees the gate
    const roleRows = sec!.details.filter(
      (detail) => !detail.startsWith('recommendation: '),
    );
    expect(roleRows.length).toBeGreaterThan(0);
    expect(
      roleRows.every((detail) => detail.includes('thresholds=[3, 10]')),
    ).toBe(true);
  });

  it('FAIL status when consecutive error count crosses default threshold', () => {
    const codexAdvisor = makeAdvisorProbe(3, {
      advisorErrorFailOpen: 5,
      advisorErrorFailClosed: 0,
    });
    const status = resolveAdvisorHealthDoctorStatus({ codexAdvisor });
    expect(status).toBeDefined();
    expect(status!.roles).toHaveLength(1);
    expect(status!.roles[0]!.status).toBe('fail');
    const report = buildDoctorReport({
      ...baseInput(),
      advisorHealth: status,
    });
    const sec = report.sections.find(
      (entry) => entry.name === 'Per-advisor health',
    );
    expect(sec).toBeDefined();
    expect(sec!.status).toBe('fail');
    expect(sec!.details[0]!.includes('codex: status=FAIL consecutive=3')).toBe(
      true,
    );
    expect(sec!.remediation).toContain('FAIL threshold');
  });

  it('respects a caller-supplied thresholds override', () => {
    const claudeAdvisor = makeAdvisorProbe(2, {
      advisorErrorFailOpen: 0,
      advisorErrorFailClosed: 0,
    });
    const status = resolveAdvisorHealthDoctorStatus({
      claudeAdvisor,
      thresholds: [2, 5],
    });
    expect(status).toBeDefined();
    expect(status!.thresholds).toEqual([2, 5]);
    expect(status!.roles[0]!.status).toBe('fail');
  });

  it('broken probe omits its row but does not break the entire doctor section', () => {
    const broken: AdvisorHealthProbe = {
      consecutiveAdvisorErrors: () => {
        throw new Error('probe broken');
      },
      consultationCounts: () => ({
        advisorErrorFailOpen: 0,
        advisorErrorFailClosed: 0,
      }),
    };
    const healthy = makeAdvisorProbe(0, {
      advisorErrorFailOpen: 0,
      advisorErrorFailClosed: 0,
    });
    const status = resolveAdvisorHealthDoctorStatus({
      claudeAdvisor: broken,
      codexAdvisor: healthy,
    });
    expect(status).toBeDefined();
    expect(status!.roles).toHaveLength(1);
    expect(status!.roles[0]!.role).toBe('codex');
    const report = buildDoctorReport({
      ...baseInput(),
      advisorHealth: status,
    });
    const sec = report.sections.find(
      (entry) => entry.name === 'Per-advisor health',
    );
    expect(sec).toBeDefined();
    expect(sec!.status).toBe('pass');
  });

  it('returns undefined when every supplied probe throws', () => {
    const broken: AdvisorHealthProbe = {
      consecutiveAdvisorErrors: () => {
        throw new Error('boom');
      },
      consultationCounts: () => {
        throw new Error('boom');
      },
    };
    const status = resolveAdvisorHealthDoctorStatus({
      claudeAdvisor: broken,
      codexAdvisor: broken,
    });
    expect(status).toBeUndefined();
  });

  it('buildDoctorReportFromEnv({}) does not include advisor-health section', () => {
    const report = buildDoctorReportFromEnv({});
    const sec = report.sections.find(
      (entry) => entry.name === 'Per-advisor health',
    );
    expect(sec).toBeUndefined();
  });
});

describe('Per-advisor health recommendation lines (P2-D commit 2)', () => {
  it('emits a WARN recommendation when consecutive errors are below the FAIL threshold', () => {
    const claudeAdvisor = makeAdvisorProbe(2, {
      advisorErrorFailOpen: 2,
      advisorErrorFailClosed: 0,
    });
    const status = resolveAdvisorHealthDoctorStatus({ claudeAdvisor });
    expect(status).toBeDefined();
    expect(status!.recommendations.length).toBeGreaterThan(0);
    expect(
      status!.recommendations.some((line) =>
        line.includes('Watch claude advisor'),
      ),
    ).toBe(true);
    const report = buildDoctorReport({
      ...baseInput(),
      advisorHealth: status,
    });
    const sec = report.sections.find(
      (entry) => entry.name === 'Per-advisor health',
    );
    expect(sec).toBeDefined();
    expect(
      sec!.details.some((d) =>
        d.startsWith('recommendation: Watch claude advisor'),
      ),
    ).toBe(true);
  });

  it('emits FAIL + fail-closed recommendations when both signals are present', () => {
    const codexAdvisor = makeAdvisorProbe(4, {
      advisorErrorFailOpen: 0,
      advisorErrorFailClosed: 2,
    });
    const status = resolveAdvisorHealthDoctorStatus({ codexAdvisor });
    expect(status).toBeDefined();
    expect(
      status!.recommendations.some((line) =>
        line.includes('Investigate codex advisor'),
      ),
    ).toBe(true);
    expect(
      status!.recommendations.some((line) =>
        line.includes('advisor-error-fail-closed veto'),
      ),
    ).toBe(true);
  });

  it('emits an empty recommendations array when every role is OK and free of fail-closed', () => {
    const claudeAdvisor = makeAdvisorProbe(0, {
      advisorErrorFailOpen: 0,
      advisorErrorFailClosed: 0,
    });
    const status = resolveAdvisorHealthDoctorStatus({ claudeAdvisor });
    expect(status).toBeDefined();
    expect(status!.recommendations).toEqual([]);
  });
});
