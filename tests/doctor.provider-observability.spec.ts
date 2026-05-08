import { describe, expect, it } from 'vitest';

import {
  buildDoctorReport,
  buildDoctorReportFromEnv,
  resolveProviderObservabilityDoctorStatus,
  type ProviderObservabilityProbe,
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

function makeProbe(
  selection: ReturnType<ProviderObservabilityProbe['resolveActiveProvider']>,
  snapshot: ReturnType<ProviderObservabilityProbe['observabilitySnapshot']>,
): ProviderObservabilityProbe {
  return {
    resolveActiveProvider: () => selection,
    observabilitySnapshot: () => snapshot,
  };
}

describe('Provider/advisor observability doctor section (P2-A)', () => {
  it('omits the section entirely when neither probe is supplied', () => {
    const status = resolveProviderObservabilityDoctorStatus({});
    expect(status).toBeUndefined();
    const report = buildDoctorReport(baseInput());
    const section = report.sections.find(
      (entry) => entry.name === 'Provider/advisor observability',
    );
    expect(section).toBeUndefined();
  });

  it('reports both roles as pass when there are no observer failures and no broken fallbacks', () => {
    const runtimeDriver = makeProbe(
      { provider: 'codex', source: 'override' },
      { observerFailureCount: 0, lastSelectionSource: 'override' },
    );
    const planaAdvisor = makeProbe(
      { provider: 'claude-agent', source: 'default' },
      { observerFailureCount: 0, lastSelectionSource: 'default' },
    );
    const status = resolveProviderObservabilityDoctorStatus({
      runtimeDriver,
      runtimeDefaultProvider: 'codex',
      planaAdvisor,
      planaDefaultProvider: 'claude-agent',
    });
    expect(status).toBeDefined();
    expect(status!.roles).toHaveLength(2);
    const report = buildDoctorReport({
      ...baseInput(),
      providerObservability: status,
    });
    const section = report.sections.find(
      (entry) => entry.name === 'Provider/advisor observability',
    );
    expect(section).toBeDefined();
    expect(section!.status).toBe('pass');
    expect(section!.remediation).toBeUndefined();
    expect(
      section!.details.some((detail) =>
        detail.includes('arona-runtime: active=codex source=override'),
      ),
    ).toBe(true);
    expect(
      section!.details.some((detail) =>
        detail.includes('plana-advisor: active=claude-agent source=default'),
      ),
    ).toBe(true);
    expect(
      section!.details.every((detail) => detail.includes('observer-failures=0')),
    ).toBe(true);
    expect(
      section!.details.every((detail) => detail.includes('last-fallback=none')),
    ).toBe(true);
  });

  it("warns when a role reports a fallback reason of 'settings-read-threw'", () => {
    const runtimeDriver = makeProbe(
      {
        provider: 'codex',
        source: 'default',
        fallbackReason: 'settings-read-threw',
      },
      {
        observerFailureCount: 0,
        lastFallbackReason: 'settings-read-threw',
        lastSelectionSource: 'default',
      },
    );
    const status = resolveProviderObservabilityDoctorStatus({
      runtimeDriver,
      runtimeDefaultProvider: 'codex',
    });
    const report = buildDoctorReport({
      ...baseInput(),
      providerObservability: status,
    });
    const section = report.sections.find(
      (entry) => entry.name === 'Provider/advisor observability',
    );
    expect(section).toBeDefined();
    expect(section!.status).toBe('warn');
    expect(section!.remediation).toContain('persona settings store');
    expect(
      section!.details[0]!.includes('last-fallback=settings-read-threw'),
    ).toBe(true);
  });

  it("warns when observer failures have been recorded even if the active selection is healthy", () => {
    const runtimeDriver = makeProbe(
      { provider: 'claude-agent', source: 'override' },
      {
        observerFailureCount: 3,
        lastSelectionSource: 'override',
      },
    );
    const status = resolveProviderObservabilityDoctorStatus({
      runtimeDriver,
      runtimeDefaultProvider: 'codex',
    });
    const report = buildDoctorReport({
      ...baseInput(),
      providerObservability: status,
    });
    const section = report.sections.find(
      (entry) => entry.name === 'Provider/advisor observability',
    );
    expect(section).toBeDefined();
    expect(section!.status).toBe('warn');
    expect(section!.remediation).toContain('onProviderSelected');
    expect(
      section!.details[0]!.includes('observer-failures=3'),
    ).toBe(true);
  });

  it("override-missing alone is treated as an informational pass (legacy 'no opinion' path)", () => {
    const planaAdvisor = makeProbe(
      {
        provider: 'claude-agent',
        source: 'default',
        fallbackReason: 'override-missing',
      },
      {
        observerFailureCount: 0,
        lastFallbackReason: 'override-missing',
        lastSelectionSource: 'default',
      },
    );
    const status = resolveProviderObservabilityDoctorStatus({
      planaAdvisor,
      planaDefaultProvider: 'claude-agent',
    });
    const report = buildDoctorReport({
      ...baseInput(),
      providerObservability: status,
    });
    const section = report.sections.find(
      (entry) => entry.name === 'Provider/advisor observability',
    );
    expect(section).toBeDefined();
    expect(section!.status).toBe('pass');
    expect(
      section!.details[0]!.includes('last-fallback=override-missing'),
    ).toBe(true);
  });

  it("omits a role from the doctor panel when the probe itself throws", () => {
    const brokenProbe: ProviderObservabilityProbe = {
      resolveActiveProvider: () => {
        throw new Error('probe broken');
      },
      observabilitySnapshot: () => ({ observerFailureCount: 0 }),
    };
    const healthy = makeProbe(
      { provider: 'codex', source: 'override' },
      { observerFailureCount: 0, lastSelectionSource: 'override' },
    );
    const status = resolveProviderObservabilityDoctorStatus({
      runtimeDriver: brokenProbe,
      runtimeDefaultProvider: 'codex',
      planaAdvisor: healthy,
      planaDefaultProvider: 'claude-agent',
    });
    expect(status).toBeDefined();
    expect(status!.roles).toHaveLength(1);
    expect(status!.roles[0]!.role).toBe('plana-advisor');
  });

  it("env-only doctor (buildDoctorReportFromEnv) does NOT include the new section", () => {
    const report = buildDoctorReportFromEnv({});
    const section = report.sections.find(
      (entry) => entry.name === 'Provider/advisor observability',
    );
    expect(section).toBeUndefined();
  });
});
