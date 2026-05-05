import { describe, expect, it } from 'vitest';

import {
  buildDoctorReport,
  buildDoctorReportFromEnv,
  resolveShellHookDoctorStatusFromEnv,
} from '../src/core/doctor.js';

const FIXED_AT = '2026-05-04T00:00:00.000Z';

function baseInput() {
  return {
    ledgerEnabled: true,
    accessPolicyEnabled: true,
    authDatabaseEnabled: true,
    runtimeProviderScope: 'codex-sdk-only' as const,
    approvalRegistryEnabled: true,
    executionApprovalPolicy: 'single-use' as const,
    toolLoopDetectorEnabled: true,
    generatedAt: FIXED_AT,
  };
}

describe('TLS CA certificate doctor section', () => {
  it('is pass when both vars are unset (system roots)', () => {
    const report = buildDoctorReport(baseInput());
    const section = report.sections.find((s) => s.name === 'TLS CA certificate');
    expect(section).toBeDefined();
    expect(section!.status).toBe('pass');
    expect(section!.remediation).toBeUndefined();
    expect(section!.details.some((d) => d.includes('system roots'))).toBe(true);
  });

  it('is pass when SSL_CERT_FILE is set and present=true, details mention redacted path', () => {
    const report = buildDoctorReport({
      ...baseInput(),
      sslCertFile: '/opt/ai-gateway/certs/root-ca.pem',
      sslCertFilePresent: true,
    });
    const section = report.sections.find((s) => s.name === 'TLS CA certificate');
    expect(section).toBeDefined();
    expect(section!.status).toBe('pass');
    expect(section!.remediation).toBeUndefined();
    // Should mention a redacted summary (basename#sha256-12hex), not the full path
    const detail = section!.details.find((d) => d.startsWith('SSL_CERT_FILE:'));
    expect(detail).toBeDefined();
    expect(detail).toContain('root-ca.pem#');
    expect(detail).not.toContain('/opt/ai-gateway/certs/root-ca.pem');
    expect(detail).toContain('present');
  });

  it('is fail when SSL_CERT_FILE is set and present=false', () => {
    const report = buildDoctorReport({
      ...baseInput(),
      sslCertFile: '/opt/ai-gateway/certs/root-ca.pem',
      sslCertFilePresent: false,
    });
    const section = report.sections.find((s) => s.name === 'TLS CA certificate');
    expect(section).toBeDefined();
    expect(section!.status).toBe('fail');
    expect(section!.remediation).toContain('missing');
    const detail = section!.details.find((d) => d.startsWith('SSL_CERT_FILE:'));
    expect(detail).toBeDefined();
    expect(detail).toContain('MISSING');
  });

  it('is fail when CODEX_CA_CERTIFICATE is set and present=false', () => {
    const report = buildDoctorReport({
      ...baseInput(),
      codexCaCertificate: '/run/secrets/codex-ca.pem',
      codexCaCertificatePresent: false,
    });
    const section = report.sections.find((s) => s.name === 'TLS CA certificate');
    expect(section).toBeDefined();
    expect(section!.status).toBe('fail');
    expect(section!.remediation).toContain('missing');
    const detail = section!.details.find((d) => d.startsWith('CODEX_CA_CERTIFICATE:'));
    expect(detail).toBeDefined();
    expect(detail).toContain('MISSING');
  });

  it('is fail when both vars set and both missing — single section (not double-counted)', () => {
    const report = buildDoctorReport({
      ...baseInput(),
      sslCertFile: '/opt/ai-gateway/certs/root-ca.pem',
      sslCertFilePresent: false,
      codexCaCertificate: '/run/secrets/codex-ca.pem',
      codexCaCertificatePresent: false,
    });
    const tlsSections = report.sections.filter((s) => s.name === 'TLS CA certificate');
    expect(tlsSections).toHaveLength(1);
    expect(tlsSections[0]!.status).toBe('fail');
    expect(tlsSections[0]!.remediation).toContain('missing');
    const sslDetail = tlsSections[0]!.details.find((d) => d.startsWith('SSL_CERT_FILE:'));
    const codexDetail = tlsSections[0]!.details.find((d) => d.startsWith('CODEX_CA_CERTIFICATE:'));
    expect(sslDetail).toContain('MISSING');
    expect(codexDetail).toContain('MISSING');
  });

  it('buildDoctorReportFromEnv({}) does not throw (smoke test)', () => {
    expect(() => buildDoctorReportFromEnv({})).not.toThrow();
  });
});

describe('Shell-hook bridge doctor section', () => {
  it('uses one exact env-derivation helper for shell-hook doctor state', () => {
    expect(resolveShellHookDoctorStatusFromEnv({})).toEqual({
      shellHooksMode: 'off',
      shellHookAcceptMode: 'unset',
    });
    expect(
      resolveShellHookDoctorStatusFromEnv({
        AUTO_ARCHIVE_SHELL_HOOKS: 'on',
        AUTO_ARCHIVE_ACCEPT_HOOKS: '1',
      }),
    ).toEqual({
      shellHooksMode: 'on',
      shellHookAcceptMode: 'literal-1',
    });
    expect(
      resolveShellHookDoctorStatusFromEnv({
        AUTO_ARCHIVE_SHELL_HOOKS: ' on',
        AUTO_ARCHIVE_ACCEPT_HOOKS: ' 1',
      }),
    ).toEqual({
      shellHooksMode: 'off',
      shellHookAcceptMode: 'invalid-set',
    });
  });

  it('reports the default-off shell-hook bridge as non-executable', () => {
    const report = buildDoctorReportFromEnv({});
    const section = report.sections.find((s) => s.name === 'Shell-hook bridge');

    expect(section).toBeDefined();
    expect(section!.status).toBe('pass');
    expect(section!.details).toContain('Master gate: disabled');
    expect(section!.details).toContain('Non-interactive consent: unset');
    expect(section!.details).toContain(
      'No shell hooks are executable while the master gate is off.',
    );
  });

  it('warns when accept env is set but the master shell-hook gate is off', () => {
    const report = buildDoctorReportFromEnv({
      AUTO_ARCHIVE_ACCEPT_HOOKS: '1',
    });
    const section = report.sections.find((s) => s.name === 'Shell-hook bridge');

    expect(section).toBeDefined();
    expect(section!.status).toBe('warn');
    expect(section!.details).toContain(
      'Non-interactive consent: AUTO_ARCHIVE_ACCEPT_HOOKS=1',
    );
    expect(section!.remediation).toContain('ignored while AUTO_ARCHIVE_SHELL_HOOKS');
  });

  it('warns when accept env is not the exact literal 1', () => {
    const report = buildDoctorReportFromEnv({
      AUTO_ARCHIVE_SHELL_HOOKS: 'on',
      AUTO_ARCHIVE_ACCEPT_HOOKS: ' 1',
    });
    const section = report.sections.find((s) => s.name === 'Shell-hook bridge');

    expect(section).toBeDefined();
    expect(section!.status).toBe('warn');
    expect(section!.details).toContain('Master gate: enabled');
    expect(section!.details).toContain('Non-interactive consent: invalid/ignored');
    expect(section!.remediation).toContain('exactly "1"');
  });

  it('documents in-memory consent when both hook env gates are explicit', () => {
    const report = buildDoctorReportFromEnv({
      AUTO_ARCHIVE_SHELL_HOOKS: 'on',
      AUTO_ARCHIVE_ACCEPT_HOOKS: '1',
    });
    const section = report.sections.find((s) => s.name === 'Shell-hook bridge');

    expect(section).toBeDefined();
    expect(section!.status).toBe('pass');
    expect(section!.details).toContain('Master gate: enabled');
    expect(section!.details).toContain(
      'Non-interactive consent: AUTO_ARCHIVE_ACCEPT_HOOKS=1',
    );
    expect(section!.details).toContain(
      'Execution still requires an exact (event, command) allowlist match.',
    );
    expect(section!.details).toContain(
      'Consent persistence: in-memory only; persist the resolved allowlist explicitly with saveAllowlist if durable consent is desired.',
    );
    expect(section!.remediation).toBeUndefined();
  });
});
