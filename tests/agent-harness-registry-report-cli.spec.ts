import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AGENT_HARNESS_REGISTRY_REPORT_CLI_DEFAULT_MAX_DESCRIPTOR_BYTES,
  buildAgentHarnessRegistryDescriptorTemplateFromCliOptions,
  buildAgentHarnessRegistryReportFromCliOptions,
  parseAgentHarnessRegistryReportCliArgs,
  parseAgentHarnessRegistryReportDescriptorFile,
  runAgentHarnessRegistryReportCli,
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

function descriptorJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    plugins: [
      {
        id: 'harness.claude-only',
        label: 'Claude-only harness',
        defaultUnsupportedReason: 'claude-agent only',
        supports: [
          {
            provider: 'claude-agent',
            priority: 10,
            reason: 'claude-agent bootstrap wrapper',
          },
        ],
      },
      {
        id: 'harness.codex-low',
        supports: [
          {
            provider: 'codex',
            priority: 1,
            reason: 'fallback codex wrapper',
          },
        ],
      },
      {
        id: 'harness.codex-high',
        label: 'Codex research harness',
        supports: [
          {
            provider: 'codex',
            priority: 5,
            reason: 'research UX wrapper',
          },
        ],
      },
    ],
  });
}

describe('Agent harness registry report CLI', () => {
  it('builds a read-only registry report from a JSON descriptor', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agent-harness-report-cli-'));
    try {
      const descriptorPath = join(workspace, 'agent-harnesses.json');
      writeFileSync(descriptorPath, descriptorJson(), 'utf8');
      const originalDescriptorContent = readFileSync(descriptorPath, 'utf8');
      const originalDescriptorStat = statSync(descriptorPath);
      const originalWorkspaceEntries = readdirSync(workspace).sort();
      const argv = [
        '--',
        '--plugins',
        descriptorPath,
        '--provider',
        'codex',
        '--source',
        'lazy',
        '--selected-at',
        '2026-05-05T12:00:00.000Z',
        '--generated-at',
        '2026-05-05T12:01:00.000Z',
        '--pretty',
      ] as const;
      const io = makeIo();

      const exitCode = runAgentHarnessRegistryReportCli(argv, io);

      expect(exitCode).toBe(0);
      expect(io.stderrText()).toBe('');
      const report = JSON.parse(io.stdoutText()) as {
        readonly generatedAt: string;
        readonly status: string;
        readonly pluginCount: number;
        readonly selected: {
          readonly pluginId: string;
          readonly priority: number;
          readonly binding: {
            readonly harnessId: string;
            readonly provider: string;
            readonly source: string;
            readonly boundAt: string;
          };
        } | null;
        readonly entries: readonly {
          readonly pluginId: string;
          readonly supported: boolean;
          readonly reason?: string;
        }[];
        readonly boundary: {
          readonly readOnly: boolean;
          readonly wrapDriverCalled: boolean;
          readonly providerSwitching: boolean;
        };
      };
      expect(report.generatedAt).toBe('2026-05-05T12:01:00.000Z');
      expect(report.status).toBe('selected');
      expect(report.pluginCount).toBe(3);
      expect(report.selected).toEqual({
        pluginId: 'harness.codex-high',
        label: 'Codex research harness',
        declarationIndex: 2,
        priority: 5,
        reason: 'research UX wrapper',
        binding: {
          harnessId: 'harness.codex-high',
          provider: 'codex',
          source: 'lazy',
          boundAt: '2026-05-05T12:00:00.000Z',
        },
      });
      expect(report.entries[0]).toMatchObject({
        pluginId: 'harness.claude-only',
        supported: false,
        reason: 'claude-agent only',
      });
      expect(report.boundary).toEqual({
        readOnly: true,
        wrapDriverCalled: false,
        providerSwitching: false,
      });
      expect(io.stdoutText()).not.toContain('raw task instruction');
      expect(readFileSync(descriptorPath, 'utf8')).toBe(
        originalDescriptorContent,
      );
      expect(statSync(descriptorPath).size).toBe(originalDescriptorStat.size);
      expect(statSync(descriptorPath).mtimeMs).toBe(
        originalDescriptorStat.mtimeMs,
      );
      expect(readdirSync(workspace).sort()).toEqual(originalWorkspaceEntries);

      const secondIo = makeIo();
      const secondExitCode = runAgentHarnessRegistryReportCli(argv, secondIo);

      expect(secondExitCode).toBe(0);
      expect(secondIo.stderrText()).toBe('');
      expect(secondIo.stdoutText()).toBe(io.stdoutText());
      expect(readFileSync(descriptorPath, 'utf8')).toBe(
        originalDescriptorContent,
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });


  it('prints a read-only descriptor template that can feed the registry report', () => {
    const io = makeIo();

    const exitCode = runAgentHarnessRegistryReportCli(
      ['--print-template', '--provider', 'claude-agent', '--pretty'],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    const descriptor = parseAgentHarnessRegistryReportDescriptorFile(
      io.stdoutText(),
    );
    expect(descriptor.schemaVersion).toBe(1);
    expect(descriptor.plugins).toHaveLength(1);
    expect(descriptor.plugins[0]).toEqual({
      id: 'harness.claude-agent.research',
      label: 'claude-agent research harness',
      defaultUnsupportedReason:
        'provider is not declared by this operator-owned harness descriptor',
      supports: [
        {
          provider: 'claude-agent',
          priority: 10,
          reason:
            'operator-owned research harness wrapper; replace with host integration rationale before live use',
        },
      ],
    });
    expect(io.stdoutText()).not.toContain('SECRET');
    expect(io.stdoutText()).not.toContain('raw task instruction');

    const workspace = mkdtempSync(join(tmpdir(), 'agent-harness-template-cli-'));
    try {
      const descriptorPath = join(workspace, 'agent-harnesses.json');
      writeFileSync(descriptorPath, io.stdoutText(), 'utf8');
      const reportIo = makeIo();

      const reportExitCode = runAgentHarnessRegistryReportCli(
        [
          '--plugins',
          descriptorPath,
          '--provider',
          'claude-agent',
          '--selected-at',
          '2026-05-05T13:00:00.000Z',
          '--generated-at',
          '2026-05-05T13:01:00.000Z',
        ],
        reportIo,
      );

      expect(reportExitCode).toBe(0);
      const report = JSON.parse(reportIo.stdoutText()) as {
        readonly status: string;
        readonly pluginCount: number;
        readonly selected: { readonly pluginId: string } | null;
        readonly boundary: {
          readonly readOnly: boolean;
          readonly wrapDriverCalled: boolean;
          readonly providerSwitching: boolean;
        };
      };
      expect(report.status).toBe('selected');
      expect(report.pluginCount).toBe(1);
      expect(report.selected?.pluginId).toBe('harness.claude-agent.research');
      expect(report.boundary).toEqual({
        readOnly: true,
        wrapDriverCalled: false,
        providerSwitching: false,
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });


  it('uses safe default and sanitized provider ids for descriptor templates', () => {
    const defaultIo = makeIo();

    expect(runAgentHarnessRegistryReportCli(['--print-template'], defaultIo)).toBe(
      0,
    );
    const defaultDescriptor = parseAgentHarnessRegistryReportDescriptorFile(
      defaultIo.stdoutText(),
    );
    expect(defaultDescriptor.plugins[0]?.id).toBe('harness.codex.research');
    expect(defaultDescriptor.plugins[0]?.supports[0]?.provider).toBe('codex');

    const customDescriptor =
      buildAgentHarnessRegistryDescriptorTemplateFromCliOptions({
        provider: 'Claude.Agent/Local',
      });
    expect(customDescriptor.plugins[0]?.id).toBe(
      'harness.claude-agent-local.research',
    );
    expect(customDescriptor.plugins[0]?.supports[0]?.provider).toBe(
      'Claude.Agent/Local',
    );
  });

  it('returns failure exit codes for template/report mode conflicts', () => {
    const pluginsIo = makeIo();
    const reportOnlyIo = makeIo();

    expect(
      runAgentHarnessRegistryReportCli(
        ['--print-template', '--plugins', 'agent-harnesses.json'],
        pluginsIo,
      ),
    ).toBe(1);
    expect(pluginsIo.stderrText()).toContain(
      '--print-template cannot be combined with --plugins',
    );

    expect(
      runAgentHarnessRegistryReportCli(
        [
          '--print-template',
          '--generated-at',
          '2026-05-05T13:01:00.000Z',
        ],
        reportOnlyIo,
      ),
    ).toBe(1);
    expect(reportOnlyIo.stderrText()).toContain(
      '--print-template cannot be combined with report-only options',
    );
  });

  it('does not let report construction consume template-mode options', () => {
    expect(() =>
      buildAgentHarnessRegistryReportFromCliOptions({
        provider: 'codex',
        source: 'eager',
        maxDescriptorBytes:
          AGENT_HARNESS_REGISTRY_REPORT_CLI_DEFAULT_MAX_DESCRIPTOR_BYTES,
        pretty: false,
        printTemplate: true,
      }),
    ).toThrow(/Cannot build a registry report from --print-template options/);
  });

  it('prints help without requiring a descriptor path', () => {
    const io = makeIo();

    const exitCode = runAgentHarnessRegistryReportCli(['--help'], io);

    expect(exitCode).toBe(0);
    expect(io.stdoutText()).toContain(
      'Usage: pnpm agent:harness:registry:report',
    );
    expect(io.stdoutText()).toContain('--print-template');
    expect(io.stdoutText()).toContain('This command is read-only.');
    expect(io.stdoutText()).toContain('does not load plugin code');
    expect(io.stdoutText()).toContain(
      `--max-descriptor-bytes <n>      Fail closed before reading beyond this many bytes (default: ${String(AGENT_HARNESS_REGISTRY_REPORT_CLI_DEFAULT_MAX_DESCRIPTOR_BYTES)}).`,
    );
    expect(io.stderrText()).toBe('');
  });

  it('fails closed for missing arguments and invalid option values', () => {
    expect(() => parseAgentHarnessRegistryReportCliArgs([])).toThrow(
      /--plugins is required/,
    );
    expect(() =>
      parseAgentHarnessRegistryReportCliArgs([
        '--print-template',
        '--plugins',
        'agent-harnesses.json',
      ]),
    ).toThrow(/--print-template cannot be combined with --plugins/);
    expect(() =>
      parseAgentHarnessRegistryReportCliArgs([
        '--print-template',
        '--generated-at',
        '2026-05-05T13:01:00.000Z',
      ]),
    ).toThrow(/--print-template cannot be combined with report-only options/);
    expect(() =>
      parseAgentHarnessRegistryReportCliArgs([
        '--plugins',
        'agent-harnesses.json',
        '--provider',
        ' codex ',
      ]),
    ).toThrow(/--provider must be a non-empty string/);
    expect(() =>
      parseAgentHarnessRegistryReportCliArgs([
        '--plugins',
        'agent-harnesses.json',
        '--source',
        'unknown',
      ]),
    ).toThrow(/--source must be one of/);
    expect(() =>
      parseAgentHarnessRegistryReportCliArgs([
        '--plugins',
        'agent-harnesses.json',
        '--selected-at',
        'not-iso',
      ]),
    ).toThrow(/--selected-at must be a valid ISO-8601 UTC timestamp/);
    for (const invalidMaxDescriptorBytes of [
      '0',
      '-1',
      '1.5',
      'abc',
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      expect(() =>
        parseAgentHarnessRegistryReportCliArgs([
          '--plugins',
          'agent-harnesses.json',
          '--max-descriptor-bytes',
          invalidMaxDescriptorBytes,
        ]),
      ).toThrow(/--max-descriptor-bytes must be a positive safe integer/);
    }
  });

  it('validates descriptor shape before reporting', () => {
    expect(() =>
      parseAgentHarnessRegistryReportDescriptorFile(
        '{"schemaVersion":2,"plugins":[]}',
      ),
    ).toThrow(/schemaVersion must be 1/);
    expect(() =>
      parseAgentHarnessRegistryReportDescriptorFile('{"schemaVersion":1}'),
    ).toThrow(/plugins must be an array/);
    expect(() =>
      parseAgentHarnessRegistryReportDescriptorFile(
        '{"schemaVersion":1,"plugins":[{"id":"harness.test","supports":[{"provider":" codex "}]}]}',
      ),
    ).toThrow(/provider must be a non-empty string/);
    expect(() =>
      parseAgentHarnessRegistryReportDescriptorFile(
        '{"schemaVersion":1,"plugins":[{"id":"harness.test","supports":[{"provider":"codex","priority":"high"}]}]}',
      ),
    ).toThrow(/priority must be a number/);
  });

  it('fails closed for missing, directory, symlink, and oversized descriptor paths', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agent-harness-report-cli-'));
    try {
      const descriptorPath = join(workspace, 'agent-harnesses.json');
      const symlinkPath = join(workspace, 'agent-harnesses-link.json');
      writeFileSync(descriptorPath, descriptorJson(), 'utf8');
      symlinkSync(descriptorPath, symlinkPath);

      const missingIo = makeIo();
      expect(
        runAgentHarnessRegistryReportCli(
          ['--plugins', join(workspace, 'missing.json')],
          missingIo,
        ),
      ).toBe(1);
      expect(missingIo.stderrText()).toContain('--plugins path does not exist');

      const directoryIo = makeIo();
      expect(
        runAgentHarnessRegistryReportCli(['--plugins', workspace], directoryIo),
      ).toBe(1);
      expect(directoryIo.stderrText()).toContain(
        '--plugins path is not a regular file',
      );

      const symlinkIo = makeIo();
      expect(
        runAgentHarnessRegistryReportCli(['--plugins', symlinkPath], symlinkIo),
      ).toBe(1);
      expect(symlinkIo.stderrText()).toContain(
        '--plugins path is not a regular file',
      );

      const oversizedIo = makeIo();
      expect(
        runAgentHarnessRegistryReportCli(
          ['--plugins', descriptorPath, '--max-descriptor-bytes', '2'],
          oversizedIo,
        ),
      ).toBe(1);
      expect(oversizedIo.stderrText()).toContain(
        '--plugins file exceeds --max-descriptor-bytes',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
