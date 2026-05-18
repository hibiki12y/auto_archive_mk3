import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import {
  RESEARCH_PLAN_SUBTASK_OUTPUTS_TOKEN,
  mergeResources,
  mergeRuntimeSettings,
  type ResearchPlan,
} from './research-plan-orchestrator.js';
import { createDispatchPlan } from './task.js';
import type { PlanningResourceEnvelopeInput, ResourceEnvelope } from '../contracts/resource-envelope.js';
import type { RuntimeSettingsBundle, RuntimeSettingsInput } from '../contracts/runtime-settings.js';

export const RESEARCH_PLAN_CHECK_REPORT_SCHEMA_VERSION = 1;

type ResearchPlanCheckMode = 'validate' | 'dry-run';
type ResearchPlanCheckStatus = 'pass' | 'fail';
type ResearchPlanCheckDiagnosticStatus = 'pass' | 'fail' | 'info';

export interface ResearchPlanCheckCliIo {
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
}

export interface ResearchPlanCheckCliOptions {
  readonly mode: ResearchPlanCheckMode;
  readonly planPath: string;
  readonly generatedAt?: string;
  readonly pretty: boolean;
}

export interface ResearchPlanCheckDiagnostic {
  readonly name: string;
  readonly status: ResearchPlanCheckDiagnosticStatus;
  readonly summary: string;
  readonly detail?: string;
}

export interface ResearchPlanCheckReport {
  readonly schemaVersion: typeof RESEARCH_PLAN_CHECK_REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly mode: ResearchPlanCheckMode;
  readonly status: ResearchPlanCheckStatus;
  readonly source: {
    readonly kind: 'file';
    readonly label: string;
    readonly pathRendered: false;
    readonly fileRead: true;
  };
  readonly planSummary?: ResearchPlanCheckPlanSummary;
  readonly diagnostics: readonly ResearchPlanCheckDiagnostic[];
  readonly dryRun?: ResearchPlanDryRun;
  readonly boundary: {
    readonly readOnly: true;
    readonly fileRead: true;
    readonly runtimeDriverInstantiated: false;
    readonly providerContacted: false;
    readonly providerCallPlanned: false;
    readonly providerSwitched: false;
    readonly runtimeFanOutStarted: false;
    readonly credentialFilesRead: false;
    readonly settingsFilesRead: false;
    readonly secretValuesRendered: false;
    readonly rawPromptsRendered: false;
    readonly rawResponsesRendered: false;
    readonly filesMutated: false;
  };
}

export interface ResearchPlanCheckPlanSummary {
  readonly schema: 'research-plan.v1';
  readonly subTaskCount: number;
  readonly synthesisTaskId: string;
  readonly dispatchCount: number;
  readonly executionModel: 'sequential-subtasks-then-synthesis';
  readonly providerRequiredForCheck: false;
}

export interface ResearchPlanDryRun {
  readonly graph: {
    readonly executionModel: 'sequential-subtasks-then-synthesis';
    readonly dispatchCount: number;
    readonly nodes: readonly ResearchPlanDryRunNode[];
    readonly edges: readonly ResearchPlanDryRunEdge[];
  };
  readonly evidenceRequirements: readonly ResearchPlanDryRunEvidenceRequirement[];
}

export interface ResearchPlanDryRunNode {
  readonly id: string;
  readonly kind: 'sub-task' | 'synthesis';
  readonly index: number;
  readonly dependsOn: readonly string[];
  readonly instruction: {
    readonly length: number;
    readonly sha256: string;
    readonly containsSubTaskOutputsToken: boolean;
    readonly rawRendered: false;
  };
  readonly artifactLocationConfigured: boolean;
  readonly runtimeSettings: ResearchPlanDryRunRuntimeSettings;
  readonly resourceEnvelope: ResourceEnvelope;
}

export interface ResearchPlanDryRunRuntimeSettings {
  readonly networkProfile: RuntimeSettingsBundle['networkProfile'];
  readonly sandboxMode: RuntimeSettingsBundle['sandboxMode'];
  readonly approvalPolicy: RuntimeSettingsBundle['approvalPolicy'];
  readonly workingDirectoryConfigured: boolean;
  readonly workingDirectoryRendered: false;
  readonly deadlineMs?: number;
  readonly networkProjection: RuntimeSettingsBundle['networkProjection'];
}

export interface ResearchPlanDryRunEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'sequential-next' | 'synthesis-input';
}

export interface ResearchPlanDryRunEvidenceRequirement {
  readonly nodeId: string;
  readonly terminalEvidence: true;
  readonly finalAgentMessage: true;
  readonly rawPromptRendered: false;
  readonly rawResponseRendered: false;
}

interface ValidatedDispatch {
  readonly node: ResearchPlanDryRunNode;
  readonly evidenceRequirement: ResearchPlanDryRunEvidenceRequirement;
}

const USAGE = `Usage:
  pnpm research:plan:validate -- <plan.json> [--pretty] [--generated-at <iso>]
  pnpm research:plan:dry-run -- <plan.json> [--pretty] [--generated-at <iso>]

Validate or dry-run the current research-plan v1 shape without instantiating a
RuntimeDriver or contacting Codex/Claude. This is a bounded Conductor-inspired
workflow check for Auto Archive's existing sequential N-sub-task + synthesis
research-plan subset; it is not a general script/DAG engine.

Output:
  JSON report on stdout. Invalid plans return exit code 1 and report status
  "fail". Valid plans return exit code 0 and report status "pass".

Boundary:
  Reads only the supplied plan JSON file. Does not read credentials/settings,
  does not render raw prompts/responses, does not call providers, and does not
  mutate files.
`;

export function parseResearchPlanCheckCliArgs(
  argv: readonly string[],
): ResearchPlanCheckCliOptions | 'help' {
  let mode: ResearchPlanCheckMode | undefined;
  let planPath: string | undefined;
  let generatedAt: string | undefined;
  let pretty = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--pretty') {
      pretty = true;
      continue;
    }
    if (arg === '--generated-at') {
      generatedAt = requireCliValue(argv, index, '--generated-at');
      if (!isIsoInstant(generatedAt)) {
        throw new Error('--generated-at must be a valid ISO-8601 UTC timestamp.');
      }
      index += 1;
      continue;
    }
    if (mode === undefined && (arg === 'validate' || arg === 'dry-run')) {
      mode = arg;
      continue;
    }
    if (planPath === undefined && !arg.startsWith('--')) {
      planPath = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg ?? '(missing)'}.`);
  }

  if (mode === undefined) {
    throw new Error('Missing mode: expected validate or dry-run.');
  }
  if (planPath === undefined) {
    throw new Error('Missing required <plan.json> path.');
  }
  return {
    mode,
    planPath,
    ...(generatedAt === undefined ? {} : { generatedAt }),
    pretty,
  };
}

export function runResearchPlanCheckCli(
  argv: readonly string[],
  io: ResearchPlanCheckCliIo = { stdout: process.stdout, stderr: process.stderr },
): number {
  let options: ResearchPlanCheckCliOptions | 'help';
  try {
    options = parseResearchPlanCheckCliArgs(argv);
  } catch (error) {
    io.stderr.write(
      `research-plan check failed: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    );
    return 1;
  }
  if (options === 'help') {
    io.stdout.write(USAGE);
    return 0;
  }

  let raw: string;
  try {
    raw = readFileSync(options.planPath, 'utf8');
  } catch (error) {
    io.stderr.write(
      `research-plan check failed: could not read plan file ${JSON.stringify(basename(options.planPath))}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }

  const report = buildResearchPlanCheckReportFromJsonText(raw, {
    mode: options.mode,
    planLabel: basename(options.planPath),
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
  });
  io.stdout.write(`${JSON.stringify(report, null, options.pretty ? 2 : undefined)}\n`);
  return report.status === 'pass' ? 0 : 1;
}

export function buildResearchPlanCheckReportFromJsonText(
  raw: string,
  input: {
    readonly mode: ResearchPlanCheckMode;
    readonly planLabel: string;
    readonly generatedAt?: string;
  },
): ResearchPlanCheckReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return failedReport(input, [
      {
        name: 'json-parse',
        status: 'fail',
        summary: 'plan file is not valid JSON',
        detail: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
  return buildResearchPlanCheckReport(parsed, input);
}

export function buildResearchPlanCheckReport(
  value: unknown,
  input: {
    readonly mode: ResearchPlanCheckMode;
    readonly planLabel: string;
    readonly generatedAt?: string;
  },
): ResearchPlanCheckReport {
  const diagnostics: ResearchPlanCheckDiagnostic[] = [];
  const plan = validateResearchPlanShape(value, input.planLabel, diagnostics);
  if (plan === undefined) {
    return failedReport(input, diagnostics);
  }

  const dispatches = validateResearchPlanDispatches(plan, diagnostics);
  if (dispatches === undefined) {
    return failedReport(input, diagnostics, buildPlanSummary(plan));
  }

  diagnostics.push({
    name: 'provider-boundary',
    status: 'pass',
    summary: 'validated without RuntimeDriver instantiation or provider contact',
  });
  const planSummary = buildPlanSummary(plan);
  return {
    schemaVersion: RESEARCH_PLAN_CHECK_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    mode: input.mode,
    status: 'pass',
    source: sourceFor(input.planLabel),
    planSummary,
    diagnostics,
    ...(input.mode === 'dry-run'
      ? { dryRun: buildDryRun(dispatches, plan.synthesis.taskId) }
      : {}),
    boundary: boundary(),
  };
}

function validateResearchPlanShape(
  value: unknown,
  planLabel: string,
  diagnostics: ResearchPlanCheckDiagnostic[],
): ResearchPlan | undefined {
  if (!isPlainObject(value)) {
    diagnostics.push({
      name: 'shape',
      status: 'fail',
      summary: `plan ${JSON.stringify(planLabel)} must be a JSON object`,
    });
    return undefined;
  }
  const candidate = value;
  const subTasks = candidate['subTasks'];
  if (!Array.isArray(subTasks) || subTasks.length === 0) {
    diagnostics.push({
      name: 'subTasks',
      status: 'fail',
      summary: 'plan requires a non-empty subTasks array',
    });
    return undefined;
  }

  const ids = new Set<string>();
  const subTaskValues: readonly unknown[] = subTasks;
  for (let index = 0; index < subTaskValues.length; index += 1) {
    const sub = subTaskValues[index];
    if (!isPlainObject(sub)) {
      diagnostics.push({
        name: `subTasks[${index}]`,
        status: 'fail',
        summary: 'sub-task must be an object',
      });
      return undefined;
    }
    const taskId = sub['taskId'];
    const instruction = sub['instruction'];
    if (!isMeaningfulString(taskId)) {
      diagnostics.push({
        name: `subTasks[${index}].taskId`,
        status: 'fail',
        summary: 'sub-task taskId must be a non-empty string',
      });
      return undefined;
    }
    if (ids.has(taskId)) {
      diagnostics.push({
        name: `subTasks[${index}].taskId`,
        status: 'fail',
        summary: `duplicate sub-task taskId ${JSON.stringify(taskId)}`,
      });
      return undefined;
    }
    ids.add(taskId);
    if (!isMeaningfulString(instruction)) {
      diagnostics.push({
        name: `subTasks[${index}].instruction`,
        status: 'fail',
        summary: 'sub-task instruction must be a non-empty string',
      });
      return undefined;
    }
    if (!validateOptionalString(sub['artifactLocation'], `subTasks[${index}].artifactLocation`, diagnostics)) {
      return undefined;
    }
    if (!validateOverrideShape(sub, `subTasks[${index}]`, diagnostics)) {
      return undefined;
    }
  }

  const synthesis = candidate['synthesis'];
  if (!isPlainObject(synthesis)) {
    diagnostics.push({
      name: 'synthesis',
      status: 'fail',
      summary: 'plan synthesis must be an object',
    });
    return undefined;
  }
  const synthesisTaskId = synthesis['taskId'];
  const instructionTemplate = synthesis['instructionTemplate'];
  if (!isMeaningfulString(synthesisTaskId) || !isMeaningfulString(instructionTemplate)) {
    diagnostics.push({
      name: 'synthesis',
      status: 'fail',
      summary: 'synthesis taskId and instructionTemplate must be non-empty strings',
    });
    return undefined;
  }
  if (ids.has(synthesisTaskId)) {
    diagnostics.push({
      name: 'synthesis.taskId',
      status: 'fail',
      summary: 'synthesis taskId collides with a sub-task taskId',
    });
    return undefined;
  }
  if (!validateOptionalString(synthesis['artifactLocation'], 'synthesis.artifactLocation', diagnostics)) {
    return undefined;
  }
  if (!validateOverrideShape(synthesis, 'synthesis', diagnostics)) {
    return undefined;
  }
  if (!isPlainObject(candidate['runtimeSettings'])) {
    diagnostics.push({
      name: 'runtimeSettings',
      status: 'fail',
      summary: 'plan requires a runtimeSettings object',
    });
    return undefined;
  }
  if (!isPlainObject(candidate['resources'])) {
    diagnostics.push({
      name: 'resources',
      status: 'fail',
      summary: 'plan requires a resources object',
    });
    return undefined;
  }

  diagnostics.push({
    name: 'shape',
    status: 'pass',
    summary: `research-plan.v1 shape accepted with ${subTaskValues.length} sub-task(s)`,
  });
  return value as unknown as ResearchPlan;
}

function validateResearchPlanDispatches(
  plan: ResearchPlan,
  diagnostics: ResearchPlanCheckDiagnostic[],
): readonly ValidatedDispatch[] | undefined {
  const dispatches: ValidatedDispatch[] = [];
  for (let index = 0; index < plan.subTasks.length; index += 1) {
    const subTask = plan.subTasks[index];
    const dispatch = buildValidatedDispatch({
      id: subTask.taskId,
      kind: 'sub-task',
      index: index + 1,
      dependsOn: index === 0 ? [] : [plan.subTasks[index - 1].taskId],
      instruction: subTask.instruction,
      artifactLocation: subTask.artifactLocation,
      runtimeSettings: mergeRuntimeSettings(plan.runtimeSettings, subTask.runtimeSettings),
      resources: mergeResources(plan.resources, subTask.resources),
    }, diagnostics);
    if (dispatch === undefined) return undefined;
    dispatches.push(dispatch);
  }

  const synthesisDispatch = buildValidatedDispatch({
    id: plan.synthesis.taskId,
    kind: 'synthesis',
    index: plan.subTasks.length + 1,
    dependsOn: plan.subTasks.map((subTask) => subTask.taskId),
    instruction: plan.synthesis.instructionTemplate,
    artifactLocation: plan.synthesis.artifactLocation,
    runtimeSettings: mergeRuntimeSettings(plan.runtimeSettings, plan.synthesis.runtimeSettings),
    resources: mergeResources(plan.resources, plan.synthesis.resources),
  }, diagnostics);
  if (synthesisDispatch === undefined) return undefined;
  dispatches.push(synthesisDispatch);

  diagnostics.push({
    name: 'dispatch-boundary',
    status: 'pass',
    summary: `all ${dispatches.length} planned dispatch(es) pass runtime/resource boundary validation`,
  });
  return dispatches;
}

function buildValidatedDispatch(
  input: {
    readonly id: string;
    readonly kind: 'sub-task' | 'synthesis';
    readonly index: number;
    readonly dependsOn: readonly string[];
    readonly instruction: string;
    readonly artifactLocation?: string;
    readonly runtimeSettings: RuntimeSettingsInput;
    readonly resources: PlanningResourceEnvelopeInput;
  },
  diagnostics: ResearchPlanCheckDiagnostic[],
): ValidatedDispatch | undefined {
  try {
    const dispatchPlan = createDispatchPlan({
      taskId: input.id,
      instruction: input.instruction,
      runtimeSettings: input.runtimeSettings,
      resources: input.resources,
      ...(input.artifactLocation === undefined ? {} : { artifactLocation: input.artifactLocation }),
    });
    const node: ResearchPlanDryRunNode = {
      id: input.id,
      kind: input.kind,
      index: input.index,
      dependsOn: input.dependsOn,
      instruction: {
        length: input.instruction.length,
        sha256: sha256(input.instruction),
        containsSubTaskOutputsToken: input.instruction.includes(RESEARCH_PLAN_SUBTASK_OUTPUTS_TOKEN),
        rawRendered: false,
      },
      artifactLocationConfigured: input.artifactLocation !== undefined,
      runtimeSettings: projectRuntimeSettings(dispatchPlan.runtimeSettings),
      resourceEnvelope: dispatchPlan.resourceEnvelope,
    };
    return {
      node,
      evidenceRequirement: {
        nodeId: input.id,
        terminalEvidence: true,
        finalAgentMessage: true,
        rawPromptRendered: false,
        rawResponseRendered: false,
      },
    };
  } catch (error) {
    diagnostics.push({
      name: `${input.kind}:${input.id}`,
      status: 'fail',
      summary: 'planned dispatch failed runtime/resource boundary validation',
      detail: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function buildDryRun(
  dispatches: readonly ValidatedDispatch[],
  synthesisTaskId: string,
): ResearchPlanDryRun {
  const nodes = dispatches.map((dispatch) => dispatch.node);
  const edges: ResearchPlanDryRunEdge[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.kind === 'sub-task' && index > 0) {
      edges.push({ from: nodes[index - 1].id, to: node.id, kind: 'sequential-next' });
    }
    if (node.kind === 'sub-task') {
      edges.push({ from: node.id, to: synthesisTaskId, kind: 'synthesis-input' });
    }
  }
  return {
    graph: {
      executionModel: 'sequential-subtasks-then-synthesis',
      dispatchCount: nodes.length,
      nodes,
      edges,
    },
    evidenceRequirements: dispatches.map((dispatch) => dispatch.evidenceRequirement),
  };
}

function buildPlanSummary(plan: ResearchPlan): ResearchPlanCheckPlanSummary {
  return {
    schema: 'research-plan.v1',
    subTaskCount: plan.subTasks.length,
    synthesisTaskId: plan.synthesis.taskId,
    dispatchCount: plan.subTasks.length + 1,
    executionModel: 'sequential-subtasks-then-synthesis',
    providerRequiredForCheck: false,
  };
}

function projectRuntimeSettings(settings: RuntimeSettingsBundle): ResearchPlanDryRunRuntimeSettings {
  return {
    networkProfile: settings.networkProfile,
    sandboxMode: settings.sandboxMode,
    approvalPolicy: settings.approvalPolicy,
    workingDirectoryConfigured: settings.workingDirectory !== undefined,
    workingDirectoryRendered: false,
    ...(settings.deadlineMs === undefined ? {} : { deadlineMs: settings.deadlineMs }),
    networkProjection: settings.networkProjection,
  };
}

function validateOverrideShape(
  record: Record<string, unknown>,
  scope: string,
  diagnostics: ResearchPlanCheckDiagnostic[],
): boolean {
  for (const field of ['runtimeSettings', 'resources'] as const) {
    const raw = record[field];
    if (raw === undefined) continue;
    if (!isPlainObject(raw)) {
      diagnostics.push({
        name: `${scope}.${field}`,
        status: 'fail',
        summary: `${scope}.${field} must be an object when provided`,
      });
      return false;
    }
  }
  const resources = record['resources'];
  if (isPlainObject(resources)) {
    for (const sub of ['requested', 'effective'] as const) {
      const raw = resources[sub];
      if (raw === undefined) continue;
      if (!isPlainObject(raw)) {
        diagnostics.push({
          name: `${scope}.resources.${sub}`,
          status: 'fail',
          summary: `${scope}.resources.${sub} must be an object when provided`,
        });
        return false;
      }
    }
  }
  return true;
}

function validateOptionalString(
  value: unknown,
  scope: string,
  diagnostics: ResearchPlanCheckDiagnostic[],
): boolean {
  if (value === undefined) return true;
  if (!isMeaningfulString(value)) {
    diagnostics.push({
      name: scope,
      status: 'fail',
      summary: `${scope} must be a non-empty string when provided`,
    });
    return false;
  }
  return true;
}

function failedReport(
  input: {
    readonly mode: ResearchPlanCheckMode;
    readonly planLabel: string;
    readonly generatedAt?: string;
  },
  diagnostics: readonly ResearchPlanCheckDiagnostic[],
  planSummary?: ResearchPlanCheckPlanSummary,
): ResearchPlanCheckReport {
  return {
    schemaVersion: RESEARCH_PLAN_CHECK_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    mode: input.mode,
    status: 'fail',
    source: sourceFor(input.planLabel),
    ...(planSummary === undefined ? {} : { planSummary }),
    diagnostics,
    boundary: boundary(),
  };
}

function sourceFor(label: string): ResearchPlanCheckReport['source'] {
  return {
    kind: 'file',
    label,
    pathRendered: false,
    fileRead: true,
  };
}

function boundary(): ResearchPlanCheckReport['boundary'] {
  return {
    readOnly: true,
    fileRead: true,
    runtimeDriverInstantiated: false,
    providerContacted: false,
    providerCallPlanned: false,
    providerSwitched: false,
    runtimeFanOutStarted: false,
    credentialFilesRead: false,
    settingsFilesRead: false,
    secretValuesRendered: false,
    rawPromptsRendered: false,
    rawResponsesRendered: false,
    filesMutated: false,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMeaningfulString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireCliValue(
  argv: readonly string[],
  index: number,
  optionName: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function isIsoInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
