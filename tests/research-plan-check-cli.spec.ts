import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildResearchPlanCheckReportFromJsonText,
  parseResearchPlanCheckCliArgs,
  type ResearchPlanDryRunNode,
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

const VALID_V2_PLAN = {
  schema: 'research-plan.v2',
  steps: [
    {
      kind: 'task',
      taskId: 'v2-st1',
      instruction: 'first private v2 research instruction',
    },
    {
      kind: 'human_gate',
      gateId: 'gate-approve',
      question: 'private approval question',
      timeoutSec: 60,
      onTimeout: 'fail-closed',
    },
    {
      kind: 'parallel_group',
      groupId: 'group-readers',
      subTasks: [
        {
          kind: 'task',
          taskId: 'v2-p1',
          instruction: 'parallel private instruction one',
        },
        {
          kind: 'task',
          taskId: 'v2-p2',
          instruction: 'parallel private instruction two',
          runtimeSettings: { sandboxMode: 'read-only' },
        },
      ],
    },
  ],
  synthesis: {
    taskId: 'v2-synth',
    instructionTemplate: 'combine private v2 outputs {{subTaskOutputs}}',
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
    expect(
      report.dryRun?.graph.nodes.every(
        (node) =>
          (node.kind === 'sub-task' || node.kind === 'synthesis') &&
          node.capabilityEnvelope.schemaVersion === 1,
      ),
    ).toBe(true);
    const st1 = report.dryRun?.graph.nodes.find(
      (node) => node.id === 'st1',
    ) as ResearchPlanDryRunNode | undefined;
    expect(st1?.resourceEnvelope.requested.cpuCores).toBe(2);
    expect(st1?.capabilityEnvelope).toMatchObject({
      schemaVersion: 1,
      filesystemWriteScope: 'workspace-write',
      networkEgress: { class: 'provider-only', webSearchMode: 'provider' },
      toolGrant: { class: 'approval-required', approvalPolicy: 'on-request' },
      credentialReference: { class: 'none-declared', secretValuesRendered: false },
      provenance: { metadataOnly: true, enforcementChanged: false },
    });
    expect(st1?.instruction).toMatchObject({
      length: 'first private research instruction'.length,
      rawRendered: false,
    });
    const st2 = report.dryRun?.graph.nodes.find(
      (node) => node.id === 'st2',
    ) as ResearchPlanDryRunNode | undefined;
    expect(st2?.runtimeSettings.sandboxMode).toBe('read-only');
    expect(st2?.capabilityEnvelope.filesystemWriteScope).toBe('read-only');
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

  it('dry-runs research-plan.v2 task, human_gate, and parallel_group nodes', () => {
    const report = buildResearchPlanCheckReportFromJsonText(
      JSON.stringify(VALID_V2_PLAN),
      {
        mode: 'dry-run',
        planLabel: 'valid-v2-plan.json',
        generatedAt: '2026-05-18T05:00:00.000Z',
      },
    );

    expect(report.status).toBe('pass');
    expect(report.planSummary).toMatchObject({
      schema: 'research-plan.v2',
      stepCount: 3,
      taskCount: 3,
      humanGateCount: 1,
      parallelGroupCount: 1,
      synthesisTaskId: 'v2-synth',
      dispatchCount: 4,
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
    expect(report.dryRun?.graph).toMatchObject({
      executionModel:
        'v2-sequential-steps-with-bounded-parallel-groups-then-synthesis',
      dispatchCount: 4,
    });
    expect(report.dryRun?.graph.nodes).toHaveLength(6);
    expect(report.dryRun?.graph.edges).toEqual([
      { from: 'v2-st1', to: 'gate-approve', kind: 'sequential-next' },
      { from: 'gate-approve', to: 'group-readers', kind: 'sequential-next' },
      { from: 'group-readers', to: 'v2-p1', kind: 'parallel-child' },
      { from: 'group-readers', to: 'v2-p2', kind: 'parallel-child' },
      { from: 'v2-p1', to: 'v2-synth', kind: 'sequential-next' },
      { from: 'v2-p2', to: 'v2-synth', kind: 'sequential-next' },
      { from: 'v2-st1', to: 'v2-synth', kind: 'synthesis-input' },
      { from: 'v2-p1', to: 'v2-synth', kind: 'synthesis-input' },
      { from: 'v2-p2', to: 'v2-synth', kind: 'synthesis-input' },
    ]);
    const providerNodes = report.dryRun?.graph.nodes.filter(
      (node) => node.kind === 'task' || node.kind === 'synthesis',
    );
    expect(
      providerNodes?.every(
        (node) => 'capabilityEnvelope' in node && node.capabilityEnvelope.schemaVersion === 1,
      ),
    ).toBe(true);
    const gate = report.dryRun?.graph.nodes.find(
      (node) => node.kind === 'human_gate',
    );
    expect(gate).toMatchObject({
      id: 'gate-approve',
      question: {
        length: 'private approval question'.length,
        rawRendered: false,
      },
      timeoutSec: 60,
      onTimeout: 'fail-closed',
    });
    const group = report.dryRun?.graph.nodes.find(
      (node) => node.kind === 'parallel_group',
    );
    expect(group).toMatchObject({
      id: 'group-readers',
      childNodeIds: ['v2-p1', 'v2-p2'],
    });
    expect(report.dryRun?.evidenceRequirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'gate-approve',
          terminalEvidence: false,
          finalAgentMessage: false,
          answerProvenanceRequired: true,
          rawQuestionRendered: false,
        }),
        expect.objectContaining({
          nodeId: 'v2-p1',
          terminalEvidence: true,
          finalAgentMessage: true,
        }),
      ]),
    );
    const rendered = JSON.stringify(report);
    expect(rendered).not.toContain('first private v2 research instruction');
    expect(rendered).not.toContain('private approval question');
    expect(rendered).not.toContain('parallel private instruction');
    expect(rendered).not.toContain('combine private v2 outputs');
  });

  it('fails closed for invalid research-plan.v2 nodes before provider work is possible', () => {
    const invalidKind = {
      ...VALID_V2_PLAN,
      steps: [{ kind: 'script', taskId: 'bad', instruction: 'do not run' }],
    };

    const invalidKindReport = buildResearchPlanCheckReportFromJsonText(
      JSON.stringify(invalidKind),
      {
        mode: 'dry-run',
        planLabel: 'invalid-v2-kind.json',
        generatedAt: '2026-05-18T05:01:00.000Z',
      },
    );

    expect(invalidKindReport.status).toBe('fail');
    expect(invalidKindReport.boundary.providerContacted).toBe(false);
    expect(invalidKindReport.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'steps[0].kind',
          status: 'fail',
          summary: expect.stringContaining('task, human_gate, parallel_group'),
        }),
      ]),
    );

    const invalidGate = {
      ...VALID_V2_PLAN,
      steps: [
        {
          kind: 'human_gate',
          gateId: 'gate-bad',
          question: 'private question',
          timeoutSec: 0,
          onTimeout: 'continue',
        },
      ],
    };
    const invalidGateReport = buildResearchPlanCheckReportFromJsonText(
      JSON.stringify(invalidGate),
      {
        mode: 'validate',
        planLabel: 'invalid-v2-gate.json',
        generatedAt: '2026-05-18T05:02:00.000Z',
      },
    );
    expect(invalidGateReport.status).toBe('fail');
    expect(invalidGateReport.boundary.providerContacted).toBe(false);
    expect(invalidGateReport.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'steps[0].timeoutSec',
          status: 'fail',
        }),
      ]),
    );

    const duplicateId = {
      ...VALID_V2_PLAN,
      steps: [
        {
          kind: 'task',
          taskId: 'duplicate',
          instruction: 'private top-level instruction',
        },
        {
          kind: 'parallel_group',
          groupId: 'group-with-duplicate',
          subTasks: [
            {
              kind: 'task',
              taskId: 'duplicate',
              instruction: 'private duplicate instruction',
            },
          ],
        },
      ],
    };
    const duplicateReport = buildResearchPlanCheckReportFromJsonText(
      JSON.stringify(duplicateId),
      {
        mode: 'dry-run',
        planLabel: 'invalid-v2-duplicate.json',
        generatedAt: '2026-05-18T05:03:00.000Z',
      },
    );
    expect(duplicateReport.status).toBe('fail');
    expect(duplicateReport.boundary.providerContacted).toBe(false);
    expect(duplicateReport.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'steps[1].subTasks[0].taskId',
          status: 'fail',
          summary: expect.stringContaining('duplicate'),
        }),
      ]),
    );
  });

  it('fails closed for invalid plan shape before provider work is possible', () => {
    const unknownSchema = {
      ...VALID_PLAN,
      schema: 'research-plan.v3',
    };
    const unknownSchemaReport = buildResearchPlanCheckReportFromJsonText(
      JSON.stringify(unknownSchema),
      {
        mode: 'validate',
        planLabel: 'unknown-schema.json',
        generatedAt: '2026-05-18T04:01:30.000Z',
      },
    );
    expect(unknownSchemaReport.status).toBe('fail');
    expect(unknownSchemaReport.boundary.providerContacted).toBe(false);
    expect(unknownSchemaReport.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'schema',
          status: 'fail',
          summary: expect.stringContaining('research-plan.v2'),
        }),
      ]),
    );

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
    expect(helpIo.stdoutText()).toContain('research-plan.v2');
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
