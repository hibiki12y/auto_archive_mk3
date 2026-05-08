import { describe, expect, it } from 'vitest';

import {
  buildDoctorReport,
  buildDoctorReportFromEnv,
  resolveAuthFreshnessDoctorStatus,
  type AdvisorAuthFreshnessProbe,
  type AdvisorAuthFreshnessProbeFingerprint,
  type AdvisorAuthFreshnessProbeSnapshot,
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
  snapshot: AdvisorAuthFreshnessProbeSnapshot,
): AdvisorAuthFreshnessProbe {
  return {
    authFreshnessSnapshot: () => snapshot,
  };
}

const CLAUDE_API_KEY_FP: AdvisorAuthFreshnessProbeFingerprint = {
  authSource: 'api-key',
  apiKeyEnvVarName: 'AUTO_ARCHIVE_ANTHROPIC_API_KEY',
};

const CODEX_CLI_FP: AdvisorAuthFreshnessProbeFingerprint = {
  authSource: 'codex-cli',
  cliPath: '/usr/local/bin/codex',
  settingsFilePath: '/home/operator/.codex/auth.json',
};

const CODEX_CLI_FP_DRIFTED: AdvisorAuthFreshnessProbeFingerprint = {
  authSource: 'codex-cli',
  cliPath: '/usr/local/bin/codex',
  settingsFilePath: '/home/different/.codex/auth.json',
};

describe('Advisor auth-freshness doctor section (P2-C-2 commit 3)', () => {
  it('omits the section entirely when neither advisor probe is supplied', () => {
    const status = resolveAuthFreshnessDoctorStatus({});
    expect(status).toBeUndefined();
    const report = buildDoctorReport(baseInput());
    const found = report.sections.find(
      (entry) => entry.name === 'Advisor auth freshness',
    );
    expect(found).toBeUndefined();
  });

  it('reports PASS for both roles when neither is stale', () => {
    const claudeAdvisor = makeProbe({
      stale: false,
      bootstrap: CLAUDE_API_KEY_FP,
    });
    const codexAdvisor = makeProbe({
      stale: false,
      bootstrap: CODEX_CLI_FP,
      current: CODEX_CLI_FP,
    });
    const status = resolveAuthFreshnessDoctorStatus({
      claudeAdvisor,
      codexAdvisor,
    });
    expect(status).toBeDefined();
    expect(status!.roles).toHaveLength(2);
    expect(status!.roles.every((r) => r.status === 'pass')).toBe(true);
    expect(status!.recommendations).toEqual([]);
    const report = buildDoctorReport({
      ...baseInput(),
      authFreshness: status,
    });
    const sec = report.sections.find(
      (entry) => entry.name === 'Advisor auth freshness',
    );
    expect(sec).toBeDefined();
    expect(sec!.status).toBe('pass');
    expect(sec!.remediation).toBeUndefined();
    // PASS rows omit the `current` rendering (no drift to highlight).
    expect(sec!.details.every((d) => !d.includes('current={'))).toBe(true);
  });

  it('reports WARN with a restart recommendation when only claude is stale', () => {
    const claudeAdvisor = makeProbe({
      stale: true,
      bootstrap: CLAUDE_API_KEY_FP,
      current: {
        authSource: 'claude-cli',
        cliPath: '/usr/local/bin/claude',
      },
    });
    const codexAdvisor = makeProbe({
      stale: false,
      bootstrap: CODEX_CLI_FP,
      current: CODEX_CLI_FP,
    });
    const status = resolveAuthFreshnessDoctorStatus({
      claudeAdvisor,
      codexAdvisor,
    });
    expect(status).toBeDefined();
    expect(status!.recommendations).toEqual([
      'Restart the service to pick up the rotated claude credential.',
    ]);
    const report = buildDoctorReport({
      ...baseInput(),
      authFreshness: status,
    });
    const sec = report.sections.find(
      (entry) => entry.name === 'Advisor auth freshness',
    );
    expect(sec).toBeDefined();
    expect(sec!.status).toBe('warn');
    expect(sec!.remediation).toContain('auth-freshness-warn');
    // claude row carries both bootstrap and current fingerprints.
    expect(
      sec!.details.some(
        (d) =>
          d.startsWith('claude: status=WARN stale=true') &&
          d.includes('bootstrap={') &&
          d.includes('current={'),
      ),
    ).toBe(true);
    // codex row stays PASS without a drift current rendering.
    expect(
      sec!.details.some(
        (d) =>
          d.startsWith('codex: status=PASS stale=false') &&
          !d.includes('current={'),
      ),
    ).toBe(true);
    // Recommendation rendered as a detail line.
    expect(
      sec!.details.some((d) =>
        d.startsWith(
          'recommendation: Restart the service to pick up the rotated claude credential.',
        ),
      ),
    ).toBe(true);
  });

  it('emits a recommendation per stale role when both advisors drift', () => {
    const claudeAdvisor = makeProbe({
      stale: true,
      bootstrap: CLAUDE_API_KEY_FP,
      current: {
        authSource: 'api-key',
        apiKeyEnvVarName: 'ANTHROPIC_API_KEY',
      },
    });
    const codexAdvisor = makeProbe({
      stale: true,
      bootstrap: CODEX_CLI_FP,
      current: CODEX_CLI_FP_DRIFTED,
    });
    const status = resolveAuthFreshnessDoctorStatus({
      claudeAdvisor,
      codexAdvisor,
    });
    expect(status).toBeDefined();
    expect(status!.recommendations).toEqual([
      'Restart the service to pick up the rotated claude credential.',
      'Restart the service to pick up the rotated codex credential.',
    ]);
    const report = buildDoctorReport({
      ...baseInput(),
      authFreshness: status,
    });
    const sec = report.sections.find(
      (entry) => entry.name === 'Advisor auth freshness',
    );
    expect(sec!.status).toBe('warn');
  });

  it('drops a broken probe row but keeps the section for the surviving advisor', () => {
    const broken: AdvisorAuthFreshnessProbe = {
      authFreshnessSnapshot: () => {
        throw new Error('probe broken');
      },
    };
    const healthy = makeProbe({
      stale: false,
      bootstrap: CODEX_CLI_FP,
      current: CODEX_CLI_FP,
    });
    const status = resolveAuthFreshnessDoctorStatus({
      claudeAdvisor: broken,
      codexAdvisor: healthy,
    });
    expect(status).toBeDefined();
    expect(status!.roles).toHaveLength(1);
    expect(status!.roles[0]!.role).toBe('codex');
    const report = buildDoctorReport({
      ...baseInput(),
      authFreshness: status,
    });
    const sec = report.sections.find(
      (entry) => entry.name === 'Advisor auth freshness',
    );
    expect(sec).toBeDefined();
    expect(sec!.status).toBe('pass');
    expect(sec!.details.some((d) => d.startsWith('claude:'))).toBe(false);
  });

  it('returns undefined when every supplied probe throws', () => {
    const broken: AdvisorAuthFreshnessProbe = {
      authFreshnessSnapshot: () => {
        throw new Error('boom');
      },
    };
    const status = resolveAuthFreshnessDoctorStatus({
      claudeAdvisor: broken,
      codexAdvisor: broken,
    });
    expect(status).toBeUndefined();
  });

  it('buildDoctorReportFromEnv({}) does not include the auth-freshness section', () => {
    const report = buildDoctorReportFromEnv({});
    const sec = report.sections.find(
      (entry) => entry.name === 'Advisor auth freshness',
    );
    expect(sec).toBeUndefined();
  });

  it('emits PASS row even when probe returns undefined current (no probe configured)', () => {
    // The advisor returns `current: undefined` both for the
    // unconfigured-probe and probe-throws paths. In both cases stale is
    // false and the doctor row should be PASS without a `current={...}`
    // rendering.
    const claudeAdvisor = makeProbe({
      stale: false,
      bootstrap: CLAUDE_API_KEY_FP,
      // No `current` field — simulates "callback not configured" path.
    });
    const status = resolveAuthFreshnessDoctorStatus({ claudeAdvisor });
    expect(status).toBeDefined();
    expect(status!.roles[0]!.status).toBe('pass');
    expect(status!.roles[0]!.current).toBeUndefined();
    const report = buildDoctorReport({
      ...baseInput(),
      authFreshness: status,
    });
    const sec = report.sections.find(
      (entry) => entry.name === 'Advisor auth freshness',
    );
    expect(sec!.status).toBe('pass');
    expect(sec!.details[0]).toMatch(
      /^claude: status=PASS stale=false bootstrap=\{source=api-key /,
    );
  });
});
