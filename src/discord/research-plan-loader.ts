/**
 * Operator-side plan loader for Discord `/research-plan`.
 *
 * Plans live as JSON files under a configured directory (default
 * `runtime-state/research-plans/`, gitignored). The loader resolves a plan-id
 * to a path inside that directory, reads + parses + validates the JSON
 * against the `runResearchPlan` shape, and returns a typed object.
 *
 * Validation is intentionally narrow — boundary-style. Wide instruction
 * strings, unfamiliar keys, etc. pass through to the orchestrator as-is so
 * future extensions to `runResearchPlan` work without a loader update.
 *
 * Path-traversal guard: plan-ids must match `^[a-zA-Z0-9._-]+$`. Anything
 * else is rejected before touching the filesystem so an operator cannot
 * `../../etc/passwd` themselves into reading the wrong file.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type {
  ResearchPlan,
} from '../core/research-plan-orchestrator.js';

export const DEFAULT_RESEARCH_PLAN_DIRECTORY =
  'runtime-state/research-plans';

export const AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY =
  'AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY';

export class ResearchPlanLoaderError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ResearchPlanLoaderError';
  }
}

const PLAN_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export function resolveResearchPlanDirectory(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const raw = env[AUTO_ARCHIVE_RESEARCH_PLAN_DIRECTORY]?.trim();
  const target =
    raw && raw.length > 0 ? raw : DEFAULT_RESEARCH_PLAN_DIRECTORY;
  return isAbsolute(target) ? target : resolve(cwd, target);
}

export function resolveResearchPlanPath(
  planId: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  if (!PLAN_ID_PATTERN.test(planId)) {
    throw new ResearchPlanLoaderError(
      `plan-id ${JSON.stringify(planId)} must match [A-Za-z0-9._-]+ ` +
        `(no path separators, no spaces).`,
    );
  }
  return resolve(resolveResearchPlanDirectory(env, cwd), `${planId}.json`);
}

export function loadResearchPlan(
  planId: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ResearchPlan {
  const path = resolveResearchPlanPath(planId, env, cwd);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new ResearchPlanLoaderError(
      `failed to read plan ${JSON.stringify(planId)} from configured research-plan directory.`,
      cause,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ResearchPlanLoaderError(
      `plan ${JSON.stringify(planId)} is not valid JSON.`,
      cause,
    );
  }
  return validatePlan(parsed, planId);
}

function validatePlan(value: unknown, planId: string): ResearchPlan {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ResearchPlanLoaderError(
      `plan ${JSON.stringify(planId)} must be a JSON object.`,
    );
  }
  const candidate = value as Record<string, unknown>;
  const subTasks = candidate.subTasks;
  if (!Array.isArray(subTasks) || subTasks.length === 0) {
    throw new ResearchPlanLoaderError(
      `plan ${JSON.stringify(planId)} requires non-empty .subTasks array.`,
    );
  }
  const subTaskIds = new Set<string>();
  for (let i = 0; i < subTasks.length; i++) {
    const sub: unknown = subTasks[i];
    if (typeof sub !== 'object' || sub === null || Array.isArray(sub)) {
      throw new ResearchPlanLoaderError(
        `plan ${JSON.stringify(planId)} .subTasks[${i}] must be an object.`,
      );
    }
    const subRecord = sub as Record<string, unknown>;
    const taskId = subRecord.taskId;
    const instruction = subRecord.instruction;
    if (typeof taskId !== 'string' || taskId.trim().length === 0) {
      throw new ResearchPlanLoaderError(
        `plan ${JSON.stringify(planId)} .subTasks[${i}].taskId must be a non-empty string.`,
      );
    }
    if (typeof instruction !== 'string' || instruction.trim().length === 0) {
      throw new ResearchPlanLoaderError(
        `plan ${JSON.stringify(planId)} .subTasks[${i}].instruction must be a non-empty string.`,
      );
    }
    if (subTaskIds.has(taskId)) {
      throw new ResearchPlanLoaderError(
        `plan ${JSON.stringify(planId)} .subTasks contains duplicate taskId ${JSON.stringify(taskId)}.`,
      );
    }
    subTaskIds.add(taskId);
    assertOverridesShape(
      subRecord,
      `plan ${JSON.stringify(planId)} .subTasks[${i}]`,
    );
  }
  const synthesis = candidate.synthesis;
  if (
    typeof synthesis !== 'object' ||
    synthesis === null ||
    Array.isArray(synthesis)
  ) {
    throw new ResearchPlanLoaderError(
      `plan ${JSON.stringify(planId)} .synthesis must be an object.`,
    );
  }
  const synthRecord = synthesis as Record<string, unknown>;
  if (
    typeof synthRecord.taskId !== 'string' ||
    synthRecord.taskId.trim().length === 0 ||
    typeof synthRecord.instructionTemplate !== 'string' ||
    synthRecord.instructionTemplate.trim().length === 0
  ) {
    throw new ResearchPlanLoaderError(
      `plan ${JSON.stringify(planId)} .synthesis.{taskId,instructionTemplate} must be non-empty strings.`,
    );
  }
  if (subTaskIds.has(synthRecord.taskId)) {
    throw new ResearchPlanLoaderError(
      `plan ${JSON.stringify(planId)} synthesis taskId collides with a sub-task taskId.`,
    );
  }
  assertOverridesShape(
    synthRecord,
    `plan ${JSON.stringify(planId)} .synthesis`,
  );
  if (
    typeof candidate.runtimeSettings !== 'object' ||
    candidate.runtimeSettings === null ||
    typeof candidate.resources !== 'object' ||
    candidate.resources === null
  ) {
    throw new ResearchPlanLoaderError(
      `plan ${JSON.stringify(planId)} requires .runtimeSettings and .resources objects.`,
    );
  }
  return value as ResearchPlan;
}

/**
 * Per-sub-task / per-synthesis override fields (`runtimeSettings`,
 * `resources`) are optional partials. The loader's job is narrow boundary
 * validation — verify they are objects when present so the orchestrator's
 * merge function gets a sane shape; key-level validation happens in
 * `createDispatchPlan` after merge so the same invariants apply to overrides
 * and plan-level defaults.
 */
function assertOverridesShape(
  record: Record<string, unknown>,
  scope: string,
): void {
  for (const field of ['runtimeSettings', 'resources'] as const) {
    const raw = record[field];
    if (raw === undefined) continue;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ResearchPlanLoaderError(
        `${scope}.${field} must be an object when provided.`,
      );
    }
  }
  const resources = record['resources'];
  if (resources !== undefined) {
    const resRec = resources as Record<string, unknown>;
    for (const sub of ['requested', 'effective'] as const) {
      const raw = resRec[sub];
      if (raw === undefined) continue;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new ResearchPlanLoaderError(
          `${scope}.resources.${sub} must be an object when provided.`,
        );
      }
    }
  }
}
