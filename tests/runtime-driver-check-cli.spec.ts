import { describe, expect, it } from 'vitest';

import {
  buildRuntimeDriverCheckReport,
  parseRuntimeDriverCheckCliArgs,
  runRuntimeDriverCheckCli,
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
    stdout: {
      write: (chunk: string) => {
        stdout.push(chunk);
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr.push(chunk);
      },
    },
    stdoutText: () => stdout.join(''),
    stderrText: () => stderr.join(''),
  };
}

describe('runtime driver check CLI', () => {
  it('prints a static Codex run-plan without reading credential files or rendering secrets', () => {
    const env = {
      AUTO_ARCHIVE_CODEX_AUTH_SOURCE: 'api-key',
      AUTO_ARCHIVE_CODEX_API_KEY: 'SECRET-codex-key',
      AUTO_ARCHIVE_CODEX_MODEL: 'gpt-5.5',
      AUTO_ARCHIVE_CODEX_MODEL_FALLBACK: 'gpt-5.4',
      AUTO_ARCHIVE_CODEX_REASONING_EFFORT: 'xhigh',
      AUTO_ARCHIVE_CODEX_CLI_PATH: '/secret/home/bin/codex',
      AUTO_ARCHIVE_CODEX_CLI_HOME_MODE: 'isolated-auth',
      AUTO_ARCHIVE_CODEX_ISOLATED_HOME: '/secret/home/.auto-archive/codex-home',
    };
    const io = makeIo();

    const exitCode = runRuntimeDriverCheckCli(
      ['--generated-at', '2026-05-17T10:00:00.000Z', '--pretty'],
      io,
      env,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    const report = JSON.parse(io.stdoutText()) as {
      readonly generatedAt: string;
      readonly status: string;
      readonly statusReasonCode: string;
      readonly providerSelection: {
        readonly provider: string;
        readonly source: string;
        readonly providerSwitching: boolean;
      };
      readonly runPlan: {
        readonly provider: string;
        readonly driverProvenance: string;
        readonly auth: {
          readonly classification: string;
          readonly status: string;
          readonly credentialValuesRendered: boolean;
          readonly credentialFilesRead: boolean;
          readonly settingsFilesRead: boolean;
        };
        readonly model: {
          readonly primary: { readonly value: string };
          readonly fallback: { readonly value: string };
          readonly reasoningEffort: { readonly value: string };
        };
        readonly codex: {
          readonly cliPath: {
            readonly configured: boolean;
            readonly valueRendered: boolean;
          };
          readonly isolatedHome: {
            readonly configured: boolean;
            readonly valueRendered: boolean;
          };
          readonly cliHomeMode: { readonly value: string };
        };
      };
      readonly boundary: {
        readonly runtimeDriverInstantiated: boolean;
        readonly providerContacted: boolean;
        readonly credentialFilesRead: boolean;
        readonly settingsFilesRead: boolean;
        readonly secretValuesRendered: boolean;
      };
    };
    expect(report.generatedAt).toBe('2026-05-17T10:00:00.000Z');
    expect(report.status).toBe('ready');
    expect(report.statusReasonCode).toBe('ready');
    expect(report.providerSelection).toMatchObject({
      provider: 'codex',
      source: 'default',
      providerSwitching: false,
    });
    expect(report.runPlan).toMatchObject({
      provider: 'codex',
      driverProvenance: 'codex-runtime-driver',
      auth: {
        classification: 'api-key-env-present',
        status: 'configured',
        credentialValuesRendered: false,
        credentialFilesRead: false,
        settingsFilesRead: false,
      },
      model: {
        primary: { value: 'gpt-5.5' },
        fallback: { value: 'gpt-5.4' },
        reasoningEffort: { value: 'xhigh' },
      },
      codex: {
        cliPath: { configured: true, valueRendered: false },
        isolatedHome: { configured: true, valueRendered: false },
        cliHomeMode: { value: 'isolated-auth' },
      },
    });
    expect(report.boundary).toMatchObject({
      runtimeDriverInstantiated: false,
      providerContacted: false,
      credentialFilesRead: false,
      settingsFilesRead: false,
      secretValuesRendered: false,
    });
    expect(io.stdoutText()).not.toContain('SECRET-codex-key');
    expect(io.stdoutText()).not.toContain('/secret/home');
    expect(io.stdoutText()).not.toContain('raw prompt');
  });

  it('warns for default Codex auto-auth because credential files are intentionally not inspected', () => {
    const report = buildRuntimeDriverCheckReport({
      env: {},
      generatedAt: '2026-05-17T10:01:00.000Z',
    });

    expect(report.status).toBe('warn');
    expect(report.statusReasonCode).toBe('codex-auto-auth-not-inspected');
    expect(report.providerSelection).toMatchObject({
      provider: 'codex',
      source: 'default',
      providerSwitching: false,
      runtimeFanOut: false,
    });
    expect(report.runPlan.auth).toMatchObject({
      classification: 'auto-codex-cli-default-candidate-unverified',
      status: 'unverified',
      credentialFilesRead: false,
      settingsFilesRead: false,
    });
    expect(report.runPlan.codex?.authPreference).toMatchObject({
      configured: false,
      value: 'auto',
    });
    expect(report.runPlan.codex?.cliHomeMode).toMatchObject({
      configured: false,
      value: 'default',
    });
    expect(report.recommendations.join('\n')).toContain(
      'runtime:provider:evidence:report',
    );
  });

  it('prints a Claude Agent run-plan without rendering API keys or CLI paths', () => {
    const io = makeIo();
    const env = {
      AUTO_ARCHIVE_RUNTIME_PROVIDER: 'claude-agent',
      AUTO_ARCHIVE_ANTHROPIC_API_KEY: 'SECRET-anthropic-key',
      AUTO_ARCHIVE_CLAUDE_CLI_PATH: '/secret/bin/claude',
      AUTO_ARCHIVE_CLAUDE_MODEL: 'claude-opus-4-7',
      AUTO_ARCHIVE_CLAUDE_FALLBACK_MODEL: 'claude-sonnet-4-7',
      AUTO_ARCHIVE_CLAUDE_REASONING_EFFORT: 'max',
      AUTO_ARCHIVE_CLAUDE_PERMISSION_MODE: 'plan',
      AUTO_ARCHIVE_CLAUDE_MAX_TURNS: '12',
      AUTO_ARCHIVE_CLAUDE_MAX_BUDGET_USD: '1.25',
    };

    expect(
      runRuntimeDriverCheckCli(
        ['--generated-at', '2026-05-17T10:02:00.000Z'],
        io,
        env,
      ),
    ).toBe(0);

    const report = JSON.parse(io.stdoutText()) as {
      readonly status: string;
      readonly providerSelection: { readonly provider: string; readonly source: string };
      readonly runPlan: {
        readonly provider: string;
        readonly auth: { readonly classification: string; readonly status: string };
        readonly model: {
          readonly primary: { readonly value: string };
          readonly fallback: { readonly value: string };
          readonly reasoningEffort: { readonly value: string };
        };
        readonly permission: {
          readonly mode: { readonly value: string };
          readonly maxTurns: { readonly value: number };
          readonly maxBudgetUsd: { readonly value: number };
        };
        readonly claudeAgent: {
          readonly cliPath: {
            readonly configured: boolean;
            readonly valueRendered: boolean;
          };
        };
      };
    };
    expect(report.status).toBe('ready');
    expect(report.providerSelection).toEqual({
      provider: 'claude-agent',
      envVarName: 'AUTO_ARCHIVE_RUNTIME_PROVIDER',
      source: 'env',
      providerSwitching: false,
      runtimeFanOut: false,
    });
    expect(report.runPlan).toMatchObject({
      provider: 'claude-agent',
      auth: { classification: 'api-key-env-present', status: 'configured' },
      model: {
        primary: { value: 'claude-opus-4-7' },
        fallback: { value: 'claude-sonnet-4-7' },
        reasoningEffort: { value: 'max' },
      },
      permission: {
        mode: { value: 'plan' },
        maxTurns: { value: 12 },
        maxBudgetUsd: { value: 1.25 },
      },
      claudeAgent: {
        cliPath: { configured: true, valueRendered: false },
      },
    });
    expect(io.stdoutText()).not.toContain('SECRET-anthropic-key');
    expect(io.stdoutText()).not.toContain('/secret/bin/claude');
  });

  it('reports missing Claude Agent auth as static run-plan failure without contacting providers', () => {
    const report = buildRuntimeDriverCheckReport({
      env: { AUTO_ARCHIVE_RUNTIME_PROVIDER: 'claude-agent' },
      generatedAt: '2026-05-17T10:03:00.000Z',
    });

    expect(report.status).toBe('fail');
    expect(report.statusReasonCode).toBe('missing-auth-signal');
    expect(report.runPlan.auth).toMatchObject({
      classification: 'none',
      status: 'missing',
      credentialValuesRendered: false,
      credentialFilesRead: false,
    });
    expect(report.boundary.providerContacted).toBe(false);
    expect(report.recommendations.join('\n')).toContain(
      'Configure an auth signal',
    );
  });

  it('validates CLI and model configuration arguments', () => {
    expect(parseRuntimeDriverCheckCliArgs(['--help'])).toBe('help');
    expect(
      parseRuntimeDriverCheckCliArgs([
        '--generated-at',
        '2026-05-17T10:04:00.000Z',
        '--pretty',
      ]),
    ).toEqual({
      generatedAt: '2026-05-17T10:04:00.000Z',
      pretty: true,
    });
    expect(() =>
      parseRuntimeDriverCheckCliArgs(['--generated-at', 'not-an-instant']),
    ).toThrow(/--generated-at must be a valid ISO-8601 UTC timestamp/);
    expect(() => parseRuntimeDriverCheckCliArgs(['--unknown'])).toThrow(
      /Unknown argument: --unknown/,
    );
    expect(() =>
      buildRuntimeDriverCheckReport({
        env: { AUTO_ARCHIVE_RUNTIME_PROVIDER: 'gemini' },
      }),
    ).toThrow(/AUTO_ARCHIVE_RUNTIME_PROVIDER must be one of/);
    expect(() =>
      buildRuntimeDriverCheckReport({
        env: {
          AUTO_ARCHIVE_CODEX_MODEL: 'gpt-5.5',
          AUTO_ARCHIVE_CODEX_MODEL_FALLBACK: 'gpt-5.5',
        },
      }),
    ).toThrow(/AUTO_ARCHIVE_CODEX_MODEL_FALLBACK must differ/);
    expect(() =>
      buildRuntimeDriverCheckReport({
        env: {
          AUTO_ARCHIVE_RUNTIME_PROVIDER: 'claude-agent',
          AUTO_ARCHIVE_CLAUDE_REASONING_EFFORT: 'ultra',
        },
      }),
    ).toThrow(/AUTO_ARCHIVE_CLAUDE_REASONING_EFFORT must be one of/);

    const helpIo = makeIo();
    expect(runRuntimeDriverCheckCli(['--help'], helpIo, {})).toBe(0);
    expect(helpIo.stdoutText()).toContain('runtime:driver:check');
    expect(helpIo.stdoutText()).toMatch(/does not\s+instantiate RuntimeDrivers/u);
    expect(helpIo.stdoutText()).toContain('Exit code:');

    const invalidIo = makeIo();
    expect(
      runRuntimeDriverCheckCli(
        ['--generated-at', 'not-an-instant'],
        invalidIo,
        {},
      ),
    ).toBe(1);
    expect(invalidIo.stderrText()).toContain(
      '--generated-at must be a valid ISO-8601 UTC timestamp',
    );
  });
});
