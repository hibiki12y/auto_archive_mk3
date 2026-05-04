import { describe, expect, it } from 'vitest';

import { buildDoctorReport, buildDoctorReportFromEnv } from '../src/core/doctor.js';

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
