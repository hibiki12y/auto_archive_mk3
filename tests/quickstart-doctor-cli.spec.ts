import { describe, expect, it } from 'vitest';

import {
  buildQuickstartDoctorReportFromEnv,
  parseQuickstartDoctorCliArgs,
  renderQuickstartDoctorReport,
  runQuickstartDoctorCli,
} from '../src/index.js';

function makeIo(): {
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
  stdoutText(): string;
  stderrText(): string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    stdoutText: () => stdout.join(''),
    stderrText: () => stderr.join(''),
  };
}

describe('quickstart doctor CLI', () => {
  it('renders first-run onboarding commands without environment values', () => {
    const report = buildQuickstartDoctorReportFromEnv(
      {
        AUTO_ARCHIVE_RUNTIME_PROVIDER: 'codex',
        AUTO_ARCHIVE_CONTROL_LEDGER_PATH: '/secret/runtime/control-ledger.jsonl',
        AUTO_ARCHIVE_DISCORD_AUTH_DB_PATH: '',
        AUTO_ARCHIVE_CODEX_API_KEY: 'SECRET_SHOULD_NOT_RENDER',
      },
      {
        profile: 'first-run',
        generatedAt: '2026-05-18T12:00:00.000Z',
      },
    );
    const text = renderQuickstartDoctorReport(report);

    expect(text).toContain('Quickstart doctor — first-run');
    expect(text).toContain('AUTO_ARCHIVE_CONTROL_LEDGER_PATH');
    expect(text).toContain('[configured] AUTO_ARCHIVE_CONTROL_LEDGER_PATH');
    expect(text).toContain('[missing] AUTO_ARCHIVE_DISCORD_AUTH_DB_PATH');
    expect(text).toContain('pnpm doctor');
    expect(text).toContain('pnpm runtime:driver:check -- --pretty');
    expect(text).toContain(
      'pnpm live:proof:report -- --print-template --surface codex-runtime-provider --pretty',
    );
    expect(text).toContain('pnpm runtime:provider:smoke -- --provider codex');
    expect(text).toContain('liveServiceContact=true');
    expect(text).not.toContain('/secret/runtime/control-ledger.jsonl');
    expect(text).not.toContain('SECRET_SHOULD_NOT_RENDER');
    expect(report.boundary).toEqual({
      environmentValuesRendered: false,
      credentialFilesRead: false,
      providerContacted: false,
      liveServicesContacted: false,
      filesMutated: false,
    });
  });

  it('switches the proof surface and provider commands for claude-agent', () => {
    const report = buildQuickstartDoctorReportFromEnv(
      { AUTO_ARCHIVE_RUNTIME_PROVIDER: 'claude-agent' },
      {
        profile: 'first-run',
        generatedAt: '2026-05-18T12:01:00.000Z',
      },
    );
    const text = renderQuickstartDoctorReport(report);

    expect(report.activeProvider).toBe('claude-agent');
    expect(text).toContain('--surface claude-agent-runtime-provider');
    expect(text).toContain('runtime:provider:smoke -- --provider claude-agent');
  });

  it('parses only the bounded first-run profile', () => {
    expect(parseQuickstartDoctorCliArgs(['--', '--profile', 'first-run'])).toEqual({
      profile: 'first-run',
    });
    expect(() => parseQuickstartDoctorCliArgs(['--profile', 'advanced'])).toThrow(
      /--profile must be first-run/,
    );
  });

  it('runs the CLI with deterministic generatedAt and help output', () => {
    const io = makeIo();
    const exitCode = runQuickstartDoctorCli(
      ['--profile', 'first-run', '--generated-at', '2026-05-18T12:02:00.000Z'],
      io,
      {},
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    expect(io.stdoutText()).toContain('Generated: 2026-05-18T12:02:00.000Z');

    const helpIo = makeIo();
    expect(runQuickstartDoctorCli(['--help'], helpIo, {})).toBe(0);
    expect(helpIo.stdoutText()).toContain('Usage: pnpm quickstart:doctor');
  });
});
