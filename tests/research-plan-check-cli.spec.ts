import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildResearchPlanCheckReportFromJsonText,
  parseResearchPlanCheckCliArgs,
  runResearchPlanCheckCli,
} from '../src/index.js';

const VALID_PLAN = {
  subTasks: [
    {
      taskId: 'st1',
      instruction: 'first private research instruction',
      resources: { requested: { cpuCores: 2 } },
    },
    {
      taskId: 'st2',
      instruction: 'second private research instruction',
      runtimeSettings: { sandboxMode: 'read-only' },
    },
  ],
  synthesis: {
    taskId: 'synth',
    instructionTemplate: 'combine private outputs {{subTaskOutputs}}',
    resources: { requested: { wallTimeSec: 300 } },
  },
  runtimeSettings: {
    networkProfile: 'provider-only',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
    workingDirectory: '.',
  },
  resources: {
    requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
  },
};

let workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces) {
    rmSync(workspace, { recursive: true, force: true });
  }
  workspaces = [];
});

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'research-plan-check-'));
  workspaces.push(workspace);
  return workspace;
}

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

describe('research-plan check CLI', () => {
  it('dry-runs a valid research-plan without rendering raw prompts or contacting providers', () => {
    const report = buildResearchPlanCheckReportFromJsonText(
      JSON.stringify(VALID_PLAN),
      {
        mode: 'dry-run',
        planLabel: 'valid-plan.json',
        generatedAt: '2026-05-18T04:00:00.000Z',
      },
    );

    expect(report.status).toBe('pass');
    expect(report.planSummary).toMatchObject({
      schema: 'research-plan.v1',
      subTaskCount: 2,
      synthesisTaskId: 'synth',
      dispatchCount: 3,
      providerRequiredForCheck: false,
    });
    expect(report.boundary).toMatchObject({
      runtimeDriverInstantiated: false,
      providerContacted: false,
      providerCallPlanned: false,
      rawPromptsRendered: false,
      rawResponsesRendered: false,
      filesMutated: false,
    });
    expect(report.source).toMatchObject({
      label: 'valid-plan.json',
      pathRendered: false,
    });
    expect(report.dryRun?.graph.nodes).toHaveLength(3);
    expect(report.dryRun?.graph.edges).toEqual([
      { from: 'st1', to: 'synth', kind: 'synthesis-input' },
      { from: 'st1', to: 'st2', kind: 'sequential-next' },
      { from: 'st2', to: 'synth', kind: 'synthesis-input' },
    ]);
    const st1 = report.dryRun?.graph.nodes.find((node) => node.id === 'st1');
    expect(st1?.resourceEnvelope.requested.cpuCores).toBe(2);
    expect(st1?.instruction).toMatchObject({
      length: 'first private research instruction'.length,
      rawRendered: false,
    });
    const st2 = report.dryRun?.graph.nodes.find((node) => node.id === 'st2');
    expect(st2?.runtimeSettings.sandboxMode).toBe('read-only');
    const rendered = JSON.stringify(report);
    expect(rendered).not.toContain('first private research instruction');
    expect(rendered).not.toContain('second private research instruction');
    expect(rendered).not.toContain('combine private outputs');
  });

  it('validates a plan file through the CLI and keeps stdout machine-readable JSON', () => {
    const workspace = makeWorkspace();
    const planPath = join(workspace, 'valid.json');
    writeFileSync(planPath, JSON.stringify(VALID_PLAN), 'utf8');
    const io = makeIo();

    const exitCode = runResearchPlanCheckCli(
      ['validate', planPath, '--generated-at', '2026-05-18T04:01:00.000Z'],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stderrText()).toBe('');
    const report = JSON.parse(io.stdoutText()) as { status: string; dryRun?: unknown };
    expect(report.status).toBe('pass');
    expect(report.dryRun).toBeUndefined();
  });

  it('fails closed for invalid plan shape before provider work is possible', () => {
    const invalid = {
      ...VALID_PLAN,
      subTasks: [
        { taskId: 'dup', instruction: 'a' },
        { taskId: 'dup', instruction: 'b' },
      ],
    };

    const report = buildResearchPlanCheckReportFromJsonText(
      JSON.stringify(invalid),
      {
        mode: 'dry-run',
        planLabel: 'invalid.json',
        generatedAt: '2026-05-18T04:02:00.000Z',
      },
    );

    expect(report.status).toBe('fail');
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'subTasks[1].taskId',
          status: 'fail',
          summary: expect.stringContaining('duplicate'),
        }),
      ]),
    );
    expect(report.boundary.providerContacted).toBe(false);
    expect(report.dryRun).toBeUndefined();
  });

  it('catches merged dispatch resource/runtime boundary errors during validation', () => {
    const invalid = {
      ...VALID_PLAN,
      subTasks: [
        {
          taskId: 'st1',
          instruction: 'bad effective resources',
          resources: { effective: { memoryMiB: 999 } },
        },
      ],
    };

    const report = buildResearchPlanCheckReportFromJsonText(
      JSON.stringify(invalid),
      {
        mode: 'validate',
        planLabel: 'boundary-invalid.json',
        generatedAt: '2026-05-18T04:03:00.000Z',
      },
    );

    expect(report.status).toBe('fail');
    expect(report.planSummary).toMatchObject({ subTaskCount: 1 });
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'sub-task:st1',
          status: 'fail',
          detail: expect.stringContaining('effective memoryMiB must not exceed requested memoryMiB'),
        }),
      ]),
    );
  });


  it('fails closed for synthesis collisions and malformed override shapes', () => {
    const collision = {
      ...VALID_PLAN,
      synthesis: {
        taskId: 'st1',
        instructionTemplate: 'collides with sub-task id',
      },
    };
    const collisionReport = buildResearchPlanCheckReportFromJsonText(
      JSON.stringify(collision),
      {
        mode: 'validate',
        planLabel: 'collision.json',
        generatedAt: '2026-05-18T04:05:00.000Z',
      },
    );
    expect(collisionReport.status).toBe('fail');
    expect(collisionReport.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'synthesis.taskId',
          summary: expect.stringContaining('collides'),
        }),
      ]),
    );

    const malformedOverride = {
      ...VALID_PLAN,
      subTasks: [
        {
          taskId: 'st1',
          instruction: 'bad override',
          resources: { requested: 'not-an-object' },
        },
      ],
    };
    const overrideReport = buildResearchPlanCheckReportFromJsonText(
      JSON.stringify(malformedOverride),
      {
        mode: 'dry-run',
        planLabel: 'bad-override.json',
        generatedAt: '2026-05-18T04:05:30.000Z',
      },
    );
    expect(overrideReport.status).toBe('fail');
    expect(overrideReport.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'subTasks[0].resources.requested',
          status: 'fail',
        }),
      ]),
    );
    expect(overrideReport.boundary.providerContacted).toBe(false);
  });

  it('returns a JSON fail report for malformed JSON plan files', () => {
    const workspace = makeWorkspace();
    const planPath = join(workspace, 'bad.json');
    writeFileSync(planPath, '{not-json', 'utf8');
    const io = makeIo();

    const exitCode = runResearchPlanCheckCli(
      ['dry-run', planPath, '--generated-at', '2026-05-18T04:06:00.000Z'],
      io,
    );

    expect(exitCode).toBe(1);
    expect(io.stderrText()).toBe('');
    const report = JSON.parse(io.stdoutText()) as {
      status: string;
      diagnostics: Array<{ name: string; status: string; summary: string }>;
      boundary: { providerContacted: boolean };
    };
    expect(report.status).toBe('fail');
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'json-parse',
          status: 'fail',
          summary: 'plan file is not valid JSON',
        }),
      ]),
    );
    expect(report.boundary.providerContacted).toBe(false);
  });

  it('parses args and prints help for the new validate/dry-run scripts', () => {
    expect(
      parseResearchPlanCheckCliArgs([
        'dry-run',
        'plan.json',
        '--pretty',
        '--generated-at',
        '2026-05-18T04:04:00.000Z',
      ]),
    ).toEqual({
      mode: 'dry-run',
      planPath: 'plan.json',
      generatedAt: '2026-05-18T04:04:00.000Z',
      pretty: true,
    });

    const helpIo = makeIo();
    expect(runResearchPlanCheckCli(['--help'], helpIo)).toBe(0);
    expect(helpIo.stdoutText()).toContain('research:plan:validate');
    expect(helpIo.stdoutText()).toContain('research:plan:dry-run');
    expect(helpIo.stdoutText()).toContain('not a general script/DAG engine');
    expect(helpIo.stderrText()).toBe('');

    expect(() => parseResearchPlanCheckCliArgs(['plan.json'])).toThrow(
      /Missing mode/,
    );
    expect(() =>
      parseResearchPlanCheckCliArgs(['validate', 'plan.json', '--generated-at', 'bad']),
    ).toThrow(/valid ISO-8601 UTC/);
  });
});
