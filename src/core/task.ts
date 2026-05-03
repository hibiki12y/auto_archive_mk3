import {
  type ResourceEnvelope,
  createPlannedResourceEnvelope,
  type PlanningResourceEnvelopeInput,
} from '../contracts/resource-envelope.js';
import {
  createRuntimeSettingsBundle,
  type RuntimeSettingsBundle,
  type RuntimeSettingsInput,
} from '../contracts/runtime-settings.js';
import type { ExecutionCheckpoint } from '../contracts/execution-checkpoint.js';
import {
  appendGitLabProjectAssignmentInstruction,
  type GitLabProjectAssignment,
} from './gitlab-project-manager.js';

export interface TaskRequest {
  taskId: string;
  instruction: string;
  resources: PlanningResourceEnvelopeInput;
  runtimeSettings: RuntimeSettingsInput;
  artifactLocation?: string;
}

export interface DispatchPlan {
  taskId: string;
  instruction: string;
  resourceEnvelope: ResourceEnvelope;
  runtimeSettings: RuntimeSettingsBundle;
  createdAt: string;
  artifactLocation?: string;
  executionCheckpoint?: ExecutionCheckpoint;
  gitLabProjectAssignment?: GitLabProjectAssignment;
}

type BoundaryObject = Record<string, unknown>;

function assertBoundaryObject(
  value: unknown,
  fieldName: 'request' | 'resources' | 'resources.requested' | 'resources.effective',
): asserts value is BoundaryObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }
}

function assertMeaningfulString(
  value: unknown,
  fieldName: 'taskId' | 'instruction',
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a meaningful string.`);
  }
}

function validateArtifactLocation(value: unknown): value is string | undefined {
  if (value === undefined) {
    return true;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('artifactLocation must be a meaningful string when provided.');
  }

  return true;
}

export function createDispatchPlan(request: TaskRequest): DispatchPlan {
  assertBoundaryObject(request, 'request');
  assertMeaningfulString(request.taskId, 'taskId');
  assertMeaningfulString(request.instruction, 'instruction');
  assertBoundaryObject(request.resources, 'resources');
  assertBoundaryObject(request.resources.requested, 'resources.requested');
  if (request.resources.effective !== undefined) {
    assertBoundaryObject(request.resources.effective, 'resources.effective');
  }
  validateArtifactLocation(request.artifactLocation);

  return {
    taskId: request.taskId,
    instruction: request.instruction,
    resourceEnvelope: createPlannedResourceEnvelope(request.resources),
    runtimeSettings: createRuntimeSettingsBundle(request.runtimeSettings),
    createdAt: new Date().toISOString(),
    artifactLocation: request.artifactLocation,
  };
}

export function attachGitLabProjectAssignment(
  plan: DispatchPlan,
  assignment: GitLabProjectAssignment,
): DispatchPlan {
  return {
    ...plan,
    instruction: appendGitLabProjectAssignmentInstruction(
      plan.instruction,
      assignment,
    ),
    gitLabProjectAssignment: assignment,
  };
}
