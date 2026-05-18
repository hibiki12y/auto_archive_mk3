import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import {
  RESEARCH_PLAN_SUBTASK_OUTPUTS_TOKEN,
  mergeResources,
  mergeRuntimeSettings,
  type ResearchPlan,
  type ResearchPlanResourcesOverride,
} from './research-plan-orchestrator.js';
import { createDispatchPlan } from './task.js';
import {
  projectCapabilityEnvelope,
  type CapabilityEnvelope,
} from '../contracts/capability-envelope.js';
import type { PlanningResourceEnvelopeInput, ResourceEnvelope } from '../contracts/resource-envelope.js';
import type { RuntimeSettingsBundle, RuntimeSettingsInput } from '../contracts/runtime-settings.js';

export const RESEARCH_PLAN_CHECK_REPORT_SCHEMA_VERSION = 1;

type ResearchPlanCheckMode = 'validate' | 'dry-run';
type ResearchPlanCheckStatus = 'pass' | 'fail';
type ResearchPlanCheckDiagnosticStatus = 'pass' | 'fail' | 'info';
type ResearchPlanSchema = 'research-plan.v1' | 'research-plan.v2';

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
  readonly schema: ResearchPlanSchema;
  readonly subTaskCount?: number;
  readonly stepCount?: number;
  readonly taskCount?: number;
  readonly humanGateCount?: number;
  readonly parallelGroupCount?: number;
  readonly synthesisTaskId: string;
  readonly dispatchCount: number;
  readonly executionModel:
    | 'sequential-subtasks-then-synthesis'
    | 'v2-sequential-steps-with-bounded-parallel-groups-then-synthesis';
  readonly providerRequiredForCheck: false;
}

export interface ResearchPlanDryRun {
  readonly graph: {
    readonly executionModel:
      | 'sequential-subtasks-then-synthesis'
      | 'v2-sequential-steps-with-bounded-parallel-groups-then-synthesis';
    readonly dispatchCount: number;
    readonly nodes: readonly ResearchPlanDryRunGraphNode[];
    readonly edges: readonly ResearchPlanDryRunEdge[];
  };
  readonly evidenceRequirements: readonly ResearchPlanDryRunEvidenceRequirement[];
}

export interface ResearchPlanDryRunNode {
  readonly id: string;
  readonly kind: 'sub-task' | 'task' | 'synthesis';
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
  readonly capabilityEnvelope: CapabilityEnvelope;
}

export interface ResearchPlanHumanGateDryRunNode {
  readonly id: string;
  readonly kind: 'human_gate';
  readonly index: number;
  readonly dependsOn: readonly string[];
  readonly question: {
    readonly length: number;
    readonly sha256: string;
    readonly rawRendered: false;
  };
  readonly timeoutSec: number;
  readonly onTimeout: 'fail-closed';
}

export interface ResearchPlanParallelGroupDryRunNode {
  readonly id: string;
  readonly kind: 'parallel_group';
  readonly index: number;
  readonly dependsOn: readonly string[];
  readonly childNodeIds: readonly string[];
}

export type ResearchPlanDryRunGraphNode =
  | ResearchPlanDryRunNode
  | ResearchPlanHumanGateDryRunNode
  | ResearchPlanParallelGroupDryRunNode;

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
  readonly kind: 'sequential-next' | 'synthesis-input' | 'parallel-child';
}

export interface ResearchPlanDryRunEvidenceRequirement {
  readonly nodeId: string;
  readonly terminalEvidence: boolean;
  readonly finalAgentMessage: boolean;
  readonly rawPromptRendered: false;
  readonly rawResponseRendered: false;
  readonly answerProvenanceRequired?: true;
  readonly rawQuestionRendered?: false;
}

interface ValidatedDispatch {
  readonly node: ResearchPlanDryRunNode;
  readonly evidenceRequirement: ResearchPlanDryRunEvidenceRequirement;
}

interface ValidatedResearchPlanV1 {
  readonly schema: 'research-plan.v1';
  readonly plan: ResearchPlan;
}

interface ResearchPlanV2Task {
  readonly kind: 'task';
  readonly taskId: string;
  readonly instruction: string;
  readonly artifactLocation?: string;
  readonly runtimeSettings?: Partial<RuntimeSettingsInput>;
  readonly resources?: ResearchPlanResourcesOverride;
}

interface ResearchPlanV2HumanGate {
  readonly kind: 'human_gate';
  readonly gateId: string;
  readonly question: string;
  readonly timeoutSec: number;
  readonly onTimeout: 'fail-closed';
}

interface ResearchPlanV2ParallelGroup {
  readonly kind: 'parallel_group';
  readonly groupId: string;
  readonly subTasks: readonly ResearchPlanV2Task[];
}

type ResearchPlanV2Step =
  | ResearchPlanV2Task
  | ResearchPlanV2HumanGate
  | ResearchPlanV2ParallelGroup;

interface ResearchPlanV2 {
  readonly schema: 'research-plan.v2';
  readonly steps: readonly ResearchPlanV2Step[];
  readonly synthesis: ResearchPlan['synthesis'];
  readonly runtimeSettings: RuntimeSettingsInput;
  readonly resources: PlanningResourceEnvelopeInput;
}

interface ValidatedResearchPlanV2 {
  readonly schema: 'research-plan.v2';
  readonly plan: ResearchPlanV2;
}

type ValidatedResearchPlan = ValidatedResearchPlanV1 | ValidatedResearchPlanV2;

interface ValidatedDryRun {
  readonly graph: ResearchPlanDryRun['graph'];
  readonly evidenceRequirements: readonly ResearchPlanDryRunEvidenceRequirement[];
}

const USAGE = `Usage:
  pnpm research:plan:validate -- <plan.json> [--pretty] [--generated-at <iso>]
  pnpm research:plan:dry-run -- <plan.json> [--pretty] [--generated-at <iso>]

Validate or dry-run research-plan v1 and the validate/dry-run-only
research-plan.v2 subset without instantiating a RuntimeDriver or contacting
Codex/Claude. v2 supports bounded task, human_gate, and parallel_group nodes
for static graph/evidence planning only; it is not a general script/DAG engine.

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
  const validated = validateResearchPlanShape(value, input.planLabel, diagnostics);
  if (validated === undefined) {
    return failedReport(input, diagnostics);
  }

  const dryRun = validateResearchPlanDryRun(validated, diagnostics);
  if (dryRun === undefined) {
    return failedReport(input, diagnostics, buildPlanSummary(validated));
  }

  diagnostics.push({
    name: 'provider-boundary',
    status: 'pass',
    summary: 'validated without RuntimeDriver instantiation or provider contact',
  });
  const planSummary = buildPlanSummary(validated);
  return {
    schemaVersion: RESEARCH_PLAN_CHECK_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    mode: input.mode,
    status: 'pass',
    source: sourceFor(input.planLabel),
    planSummary,
    diagnostics,
    ...(input.mode === 'dry-run'
      ? { dryRun }
      : {}),
    boundary: boundary(),
  };
}

function validateResearchPlanShape(
  value: unknown,
  planLabel: string,
  diagnostics: ResearchPlanCheckDiagnostic[],
): ValidatedResearchPlan | undefined {
  if (!isPlainObject(value)) {
    diagnostics.push({
      name: 'shape',
      status: 'fail',
      summary: `plan ${JSON.stringify(planLabel)} must be a JSON object`,
    });
    return undefined;
  }
  const schema = value['schema'];
  if (schema === 'research-plan.v2') {
    return validateResearchPlanV2Shape(value, planLabel, diagnostics);
  }
  if (schema !== undefined && schema !== 'research-plan.v1') {
    diagnostics.push({
      name: 'schema',
      status: 'fail',
      summary:
        'plan schema must be "research-plan.v1", "research-plan.v2", or omitted for v1 compatibility',
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
  return { schema: 'research-plan.v1', plan: value as unknown as ResearchPlan };
}

function validateResearchPlanV2Shape(
  value: Record<string, unknown>,
  planLabel: string,
  diagnostics: ResearchPlanCheckDiagnostic[],
): ValidatedResearchPlanV2 | undefined {
  const steps = value['steps'];
  if (!Array.isArray(steps) || steps.length === 0) {
    diagnostics.push({
      name: 'steps',
      status: 'fail',
      summary: `research-plan.v2 ${JSON.stringify(planLabel)} requires a non-empty steps array`,
    });
    return undefined;
  }

  const ids = new Set<string>();
  const stepValues: ResearchPlanV2Step[] = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = validateResearchPlanV2Step(
      steps[index],
      `steps[${index}]`,
      ids,
      diagnostics,
    );
    if (step === undefined) return undefined;
    stepValues.push(step);
  }

  const synthesis = value['synthesis'];
  if (!isPlainObject(synthesis)) {
    diagnostics.push({
      name: 'synthesis',
      status: 'fail',
      summary: 'research-plan.v2 synthesis must be an object',
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
      summary: 'synthesis taskId collides with a v2 step id',
    });
    return undefined;
  }
  if (!validateOptionalString(synthesis['artifactLocation'], 'synthesis.artifactLocation', diagnostics)) {
    return undefined;
  }
  if (!validateOverrideShape(synthesis, 'synthesis', diagnostics)) {
    return undefined;
  }
  if (!isPlainObject(value['runtimeSettings'])) {
    diagnostics.push({
      name: 'runtimeSettings',
      status: 'fail',
      summary: 'plan requires a runtimeSettings object',
    });
    return undefined;
  }
  if (!isPlainObject(value['resources'])) {
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
    summary: `research-plan.v2 shape accepted with ${stepValues.length} top-level step(s)`,
  });
  return {
    schema: 'research-plan.v2',
    plan: {
      schema: 'research-plan.v2',
      steps: stepValues,
      synthesis: synthesis as unknown as ResearchPlan['synthesis'],
      runtimeSettings: value['runtimeSettings'] as unknown as RuntimeSettingsInput,
      resources: value['resources'] as unknown as PlanningResourceEnvelopeInput,
    },
  };
}

function validateResearchPlanV2Step(
  value: unknown,
  scope: string,
  ids: Set<string>,
  diagnostics: ResearchPlanCheckDiagnostic[],
): ResearchPlanV2Step | undefined {
  if (!isPlainObject(value)) {
    diagnostics.push({
      name: scope,
      status: 'fail',
      summary: 'research-plan.v2 step must be an object',
    });
    return undefined;
  }
  const kind = value['kind'];
  if (kind === 'task') {
    return validateResearchPlanV2Task(value, scope, ids, diagnostics);
  }
  if (kind === 'human_gate') {
    return validateResearchPlanV2HumanGate(value, scope, ids, diagnostics);
  }
  if (kind === 'parallel_group') {
    return validateResearchPlanV2ParallelGroup(value, scope, ids, diagnostics);
  }
  diagnostics.push({
    name: `${scope}.kind`,
    status: 'fail',
    summary:
      'research-plan.v2 step kind must be one of: task, human_gate, parallel_group',
  });
  return undefined;
}

function validateResearchPlanV2Task(
  value: Record<string, unknown>,
  scope: string,
  ids: Set<string>,
  diagnostics: ResearchPlanCheckDiagnostic[],
): ResearchPlanV2Task | undefined {
  const taskId = value['taskId'];
  const instruction = value['instruction'];
  if (!isMeaningfulString(taskId)) {
    diagnostics.push({
      name: `${scope}.taskId`,
      status: 'fail',
      summary: 'task taskId must be a non-empty string',
    });
    return undefined;
  }
  if (!reserveResearchPlanV2Id(taskId, `${scope}.taskId`, ids, diagnostics)) {
    return undefined;
  }
  if (!isMeaningfulString(instruction)) {
    diagnostics.push({
      name: `${scope}.instruction`,
      status: 'fail',
      summary: 'task instruction must be a non-empty string',
    });
    return undefined;
  }
  if (!validateOptionalString(value['artifactLocation'], `${scope}.artifactLocation`, diagnostics)) {
    return undefined;
  }
  if (!validateOverrideShape(value, scope, diagnostics)) {
    return undefined;
  }
  return value as unknown as ResearchPlanV2Task;
}

function validateResearchPlanV2HumanGate(
  value: Record<string, unknown>,
  scope: string,
  ids: Set<string>,
  diagnostics: ResearchPlanCheckDiagnostic[],
): ResearchPlanV2HumanGate | undefined {
  const gateId = value['gateId'];
  if (!isMeaningfulString(gateId)) {
    diagnostics.push({
      name: `${scope}.gateId`,
      status: 'fail',
      summary: 'human_gate gateId must be a non-empty string',
    });
    return undefined;
  }
  if (!reserveResearchPlanV2Id(gateId, `${scope}.gateId`, ids, diagnostics)) {
    return undefined;
  }
  if (!isMeaningfulString(value['question'])) {
    diagnostics.push({
      name: `${scope}.question`,
      status: 'fail',
      summary: 'human_gate question must be a non-empty string',
    });
    return undefined;
  }
  if (!isPositiveSafeInteger(value['timeoutSec'])) {
    diagnostics.push({
      name: `${scope}.timeoutSec`,
      status: 'fail',
      summary: 'human_gate timeoutSec must be a positive safe integer',
    });
    return undefined;
  }
  if (value['onTimeout'] !== 'fail-closed') {
    diagnostics.push({
      name: `${scope}.onTimeout`,
      status: 'fail',
      summary: 'human_gate onTimeout must be "fail-closed"',
    });
    return undefined;
  }
  return value as unknown as ResearchPlanV2HumanGate;
}

function validateResearchPlanV2ParallelGroup(
  value: Record<string, unknown>,
  scope: string,
  ids: Set<string>,
  diagnostics: ResearchPlanCheckDiagnostic[],
): ResearchPlanV2ParallelGroup | undefined {
  const groupId = value['groupId'];
  if (!isMeaningfulString(groupId)) {
    diagnostics.push({
      name: `${scope}.groupId`,
      status: 'fail',
      summary: 'parallel_group groupId must be a non-empty string',
    });
    return undefined;
  }
  if (!reserveResearchPlanV2Id(groupId, `${scope}.groupId`, ids, diagnostics)) {
    return undefined;
  }
  const subTasks = value['subTasks'];
  if (!Array.isArray(subTasks) || subTasks.length === 0) {
    diagnostics.push({
      name: `${scope}.subTasks`,
      status: 'fail',
      summary: 'parallel_group subTasks must be a non-empty task array',
    });
    return undefined;
  }
  const validatedSubTasks: ResearchPlanV2Task[] = [];
  for (let index = 0; index < subTasks.length; index += 1) {
    const rawSubTask: unknown = subTasks[index];
    if (!isPlainObject(rawSubTask) || rawSubTask['kind'] !== 'task') {
      diagnostics.push({
        name: `${scope}.subTasks[${index}].kind`,
        status: 'fail',
        summary: 'parallel_group subTasks entries must be kind "task"',
      });
      return undefined;
    }
    const task = validateResearchPlanV2Task(
      rawSubTask,
      `${scope}.subTasks[${index}]`,
      ids,
      diagnostics,
    );
    if (task === undefined) return undefined;
    validatedSubTasks.push(task);
  }
  return {
    kind: 'parallel_group',
    groupId,
    subTasks: validatedSubTasks,
  };
}

function reserveResearchPlanV2Id(
  id: string,
  scope: string,
  ids: Set<string>,
  diagnostics: ResearchPlanCheckDiagnostic[],
): boolean {
  if (ids.has(id)) {
    diagnostics.push({
      name: scope,
      status: 'fail',
      summary: `duplicate research-plan.v2 id ${JSON.stringify(id)}`,
    });
    return false;
  }
  ids.add(id);
  return true;
}

function validateResearchPlanDryRun(
  validated: ValidatedResearchPlan,
  diagnostics: ResearchPlanCheckDiagnostic[],
): ValidatedDryRun | undefined {
  if (validated.schema === 'research-plan.v1') {
    const dispatches = validateResearchPlanV1Dispatches(
      validated.plan,
      diagnostics,
    );
    if (dispatches === undefined) return undefined;
    return buildV1DryRun(dispatches, validated.plan.synthesis.taskId);
  }
  return validateResearchPlanV2DryRun(validated.plan, diagnostics);
}

function validateResearchPlanV1Dispatches(
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

function validateResearchPlanV2DryRun(
  plan: ResearchPlanV2,
  diagnostics: ResearchPlanCheckDiagnostic[],
): ValidatedDryRun | undefined {
  const nodes: ResearchPlanDryRunGraphNode[] = [];
  const edges: ResearchPlanDryRunEdge[] = [];
  const evidenceRequirements: ResearchPlanDryRunEvidenceRequirement[] = [];
  const taskNodeIds: string[] = [];
  let previousExitIds: readonly string[] = [];
  let nodeIndex = 1;
  let providerDispatchCount = 0;

  for (const step of plan.steps) {
    if (step.kind === 'task') {
      addSequentialEdges(previousExitIds, step.taskId, edges);
      const dispatch = buildValidatedDispatch({
        id: step.taskId,
        kind: 'task',
        index: nodeIndex,
        dependsOn: previousExitIds,
        instruction: step.instruction,
        artifactLocation: step.artifactLocation,
        runtimeSettings: mergeRuntimeSettings(
          plan.runtimeSettings,
          step.runtimeSettings,
        ),
        resources: mergeResources(plan.resources, step.resources),
      }, diagnostics);
      if (dispatch === undefined) return undefined;
      nodes.push(dispatch.node);
      evidenceRequirements.push(dispatch.evidenceRequirement);
      taskNodeIds.push(step.taskId);
      previousExitIds = [step.taskId];
      providerDispatchCount += 1;
      nodeIndex += 1;
      continue;
    }

    if (step.kind === 'human_gate') {
      addSequentialEdges(previousExitIds, step.gateId, edges);
      nodes.push({
        id: step.gateId,
        kind: 'human_gate',
        index: nodeIndex,
        dependsOn: previousExitIds,
        question: {
          length: step.question.length,
          sha256: sha256(step.question),
          rawRendered: false,
        },
        timeoutSec: step.timeoutSec,
        onTimeout: step.onTimeout,
      });
      evidenceRequirements.push({
        nodeId: step.gateId,
        terminalEvidence: false,
        finalAgentMessage: false,
        rawPromptRendered: false,
        rawResponseRendered: false,
        answerProvenanceRequired: true,
        rawQuestionRendered: false,
      });
      previousExitIds = [step.gateId];
      nodeIndex += 1;
      continue;
    }

    addSequentialEdges(previousExitIds, step.groupId, edges);
    const childNodeIds = step.subTasks.map((subTask) => subTask.taskId);
    nodes.push({
      id: step.groupId,
      kind: 'parallel_group',
      index: nodeIndex,
      dependsOn: previousExitIds,
      childNodeIds,
    });
    nodeIndex += 1;

    for (const subTask of step.subTasks) {
      edges.push({
        from: step.groupId,
        to: subTask.taskId,
        kind: 'parallel-child',
      });
      const dispatch = buildValidatedDispatch({
        id: subTask.taskId,
        kind: 'task',
        index: nodeIndex,
        dependsOn: [step.groupId],
        instruction: subTask.instruction,
        artifactLocation: subTask.artifactLocation,
        runtimeSettings: mergeRuntimeSettings(
          plan.runtimeSettings,
          subTask.runtimeSettings,
        ),
        resources: mergeResources(plan.resources, subTask.resources),
      }, diagnostics);
      if (dispatch === undefined) return undefined;
      nodes.push(dispatch.node);
      evidenceRequirements.push(dispatch.evidenceRequirement);
      taskNodeIds.push(subTask.taskId);
      providerDispatchCount += 1;
      nodeIndex += 1;
    }
    previousExitIds = childNodeIds;
  }

  addSequentialEdges(previousExitIds, plan.synthesis.taskId, edges);
  for (const taskId of taskNodeIds) {
    edges.push({ from: taskId, to: plan.synthesis.taskId, kind: 'synthesis-input' });
  }
  const synthesisDispatch = buildValidatedDispatch({
    id: plan.synthesis.taskId,
    kind: 'synthesis',
    index: nodeIndex,
    dependsOn: uniqueStrings([...previousExitIds, ...taskNodeIds]),
    instruction: plan.synthesis.instructionTemplate,
    artifactLocation: plan.synthesis.artifactLocation,
    runtimeSettings: mergeRuntimeSettings(
      plan.runtimeSettings,
      plan.synthesis.runtimeSettings,
    ),
    resources: mergeResources(plan.resources, plan.synthesis.resources),
  }, diagnostics);
  if (synthesisDispatch === undefined) return undefined;
  nodes.push(synthesisDispatch.node);
  evidenceRequirements.push(synthesisDispatch.evidenceRequirement);
  providerDispatchCount += 1;

  diagnostics.push({
    name: 'dispatch-boundary',
    status: 'pass',
    summary: `all ${providerDispatchCount} research-plan.v2 provider dispatch(es) pass runtime/resource boundary validation`,
  });

  return {
    graph: {
      executionModel:
        'v2-sequential-steps-with-bounded-parallel-groups-then-synthesis',
      dispatchCount: providerDispatchCount,
      nodes,
      edges,
    },
    evidenceRequirements,
  };
}

function buildValidatedDispatch(
  input: {
    readonly id: string;
    readonly kind: 'sub-task' | 'task' | 'synthesis';
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
      capabilityEnvelope: projectCapabilityEnvelope({
        runtimeSettings: dispatchPlan.runtimeSettings,
        resourceEnvelope: dispatchPlan.resourceEnvelope,
      }),
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

function buildV1DryRun(
  dispatches: readonly ValidatedDispatch[],
  synthesisTaskId: string,
): ValidatedDryRun {
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

function buildPlanSummary(
  validated: ValidatedResearchPlan,
): ResearchPlanCheckPlanSummary {
  if (validated.schema === 'research-plan.v2') {
    const counts = countResearchPlanV2Steps(validated.plan.steps);
    return {
      schema: 'research-plan.v2',
      stepCount: validated.plan.steps.length,
      taskCount: counts.taskCount,
      humanGateCount: counts.humanGateCount,
      parallelGroupCount: counts.parallelGroupCount,
      synthesisTaskId: validated.plan.synthesis.taskId,
      dispatchCount: counts.taskCount + 1,
      executionModel:
        'v2-sequential-steps-with-bounded-parallel-groups-then-synthesis',
      providerRequiredForCheck: false,
    };
  }
  const plan = validated.plan;
  return {
    schema: 'research-plan.v1',
    subTaskCount: plan.subTasks.length,
    synthesisTaskId: plan.synthesis.taskId,
    dispatchCount: plan.subTasks.length + 1,
    executionModel: 'sequential-subtasks-then-synthesis',
    providerRequiredForCheck: false,
  };
}

function countResearchPlanV2Steps(steps: readonly ResearchPlanV2Step[]): {
  readonly taskCount: number;
  readonly humanGateCount: number;
  readonly parallelGroupCount: number;
} {
  let taskCount = 0;
  let humanGateCount = 0;
  let parallelGroupCount = 0;
  for (const step of steps) {
    if (step.kind === 'task') taskCount += 1;
    if (step.kind === 'human_gate') humanGateCount += 1;
    if (step.kind === 'parallel_group') {
      parallelGroupCount += 1;
      taskCount += step.subTasks.length;
    }
  }
  return { taskCount, humanGateCount, parallelGroupCount };
}

function addSequentialEdges(
  fromIds: readonly string[],
  to: string,
  edges: ResearchPlanDryRunEdge[],
): void {
  for (const from of fromIds) {
    edges.push({ from, to, kind: 'sequential-next' });
  }
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
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

function isPositiveSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
  );
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
