/**
 * Repository-owned methodology-skill contracts.
 *
 * This module defines the canonical Auto Archive methodology-skill/profile
 * identifiers plus the observable evidence-checkpoint payloads used by the
 * opt-in runtime decorator. It is intentionally pure and dependency-free:
 * no imports from `src/core/`, `src/runtime/`, or any reference-only surface.
 */

import type { TraitModuleId, TraitModuleManifest } from './trait-module.js';

export type MethodologySkillId = 'agent-methodology-origin';

export const METHODOLOGY_SKILL_TRAIT_MODULE_ID =
  'trait.methodology.agent-methodology-origin.v1' as const satisfies TraitModuleId;

export const METHODOLOGY_SKILL_IDS = Object.freeze([
  'agent-methodology-origin',
] as const) satisfies readonly MethodologySkillId[];

export function isMethodologySkillId(value: string): value is MethodologySkillId {
  return (METHODOLOGY_SKILL_IDS as readonly string[]).includes(value);
}

export type MethodologySkillProfileId = 'evidence-only-runtime';

export const METHODOLOGY_SKILL_PROFILE_IDS = Object.freeze([
  'evidence-only-runtime',
] as const) satisfies readonly MethodologySkillProfileId[];

export function isMethodologySkillProfileId(
  value: string,
): value is MethodologySkillProfileId {
  return (METHODOLOGY_SKILL_PROFILE_IDS as readonly string[]).includes(value);
}

export type MethodologySkillRuntimeDecorationIntent = 'evidence-only';

export const METHODOLOGY_SKILL_RUNTIME_DECORATION_INTENTS = Object.freeze([
  'evidence-only',
] as const) satisfies readonly MethodologySkillRuntimeDecorationIntent[];

export type MethodologySkillRuntimeDecorationEnforcement =
  | 'advisory'
  | 'required';

export const METHODOLOGY_SKILL_RUNTIME_DECORATION_ENFORCEMENTS =
  Object.freeze([
    'advisory',
    'required',
  ] as const) satisfies readonly MethodologySkillRuntimeDecorationEnforcement[];

export interface MethodologySkillSelection {
  readonly requested: boolean;
  readonly selectedSkillId: MethodologySkillId;
  readonly selectedProfileId: MethodologySkillProfileId;
  readonly runtimeDecorationIntent: MethodologySkillRuntimeDecorationIntent;
  readonly runtimeDecorationEnforcement: MethodologySkillRuntimeDecorationEnforcement;
}

export type MethodologySkillSourceMapId =
  | 'chain-of-thought-2201.11903'
  | 'self-consistency-2203.11171'
  | 'tree-of-thoughts-2305.10601'
  | 'graph-of-thoughts-2308.09687'
  | 'react-2210.03629'
  | 'constitutional-ai-2212.08073'
  | 'process-supervision-2305.20050'
  | 'red-teaming-2209.07858';

export const METHODOLOGY_SKILL_SOURCE_MAP = Object.freeze({
  'chain-of-thought-2201.11903': 'https://arxiv.org/abs/2201.11903',
  'self-consistency-2203.11171': 'https://arxiv.org/abs/2203.11171',
  'tree-of-thoughts-2305.10601': 'https://arxiv.org/abs/2305.10601',
  'graph-of-thoughts-2308.09687': 'https://arxiv.org/abs/2308.09687',
  'react-2210.03629': 'https://arxiv.org/abs/2210.03629',
  'constitutional-ai-2212.08073': 'https://arxiv.org/abs/2212.08073',
  'process-supervision-2305.20050': 'https://arxiv.org/abs/2305.20050',
  'red-teaming-2209.07858': 'https://arxiv.org/abs/2209.07858',
} as const) satisfies Readonly<Record<MethodologySkillSourceMapId, string>>;

export interface MethodologySkillProfile {
  readonly id: MethodologySkillProfileId;
  readonly skillId: MethodologySkillId;
  readonly runtimeDecorationIntent: MethodologySkillRuntimeDecorationIntent;
  readonly summary: string;
  readonly criteria: ReadonlyArray<string>;
  readonly sourceMapIds: ReadonlyArray<MethodologySkillSourceMapId>;
}

const EVIDENCE_ONLY_RUNTIME_CRITERIA = Object.freeze([
  'observable-summary-only',
  'criteria-and-checkpoints-only',
  'source-map-ids-only',
  'prompt-provider-settings-unchanged',
] as const) satisfies readonly string[];

const EVIDENCE_ONLY_RUNTIME_SOURCE_MAP_IDS = Object.freeze([
  'chain-of-thought-2201.11903',
  'self-consistency-2203.11171',
  'tree-of-thoughts-2305.10601',
  'graph-of-thoughts-2308.09687',
  'react-2210.03629',
  'constitutional-ai-2212.08073',
  'process-supervision-2305.20050',
  'red-teaming-2209.07858',
] as const) satisfies readonly MethodologySkillSourceMapId[];

export const METHODOLOGY_SKILL_PROFILES = Object.freeze([
  {
    id: 'evidence-only-runtime',
    skillId: 'agent-methodology-origin',
    runtimeDecorationIntent: 'evidence-only',
    summary:
      'records observable methodology checkpoints without mutating prompts, providers, or runtime settings',
    criteria: EVIDENCE_ONLY_RUNTIME_CRITERIA,
    sourceMapIds: EVIDENCE_ONLY_RUNTIME_SOURCE_MAP_IDS,
  },
] as const) satisfies readonly MethodologySkillProfile[];

export const METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: METHODOLOGY_SKILL_TRAIT_MODULE_ID,
  name: 'methodology-agent-origin',
  version: '1.0.0',
  trustBoundary: 'repository-owned',
  layout: {
    root: 'traits/methodology-agent-origin',
    manifest: 'trait.json',
    instruction: 'TRAIT.md',
    runtimeDir: 'runtime',
    schedulesDir: 'schedules',
  },
  instructions: {
    entrypoint: 'TRAIT.md',
    format: 'markdown',
    summary:
      'records methodology-origin guidance as Auto Archive trait-module instructions',
  },
  schedule: {
    mode: 'none',
  },
  runtime: {
    hook: 'evidence-decorator',
    modulePath: 'src/runtime/methodology-skill-runtime-driver.ts',
    exportName: 'composeTraitRuntimeDriver',
    enforcement: 'required',
    summary:
      'emits evidence-only methodology checkpoints without switching providers or prompt origins',
  },
  admission: {
    defaultRequested: false,
    requiredCapabilityFlags: [],
    forbiddenCapabilityFlags: [
      'network-access',
      'web-search-mode',
      'sandbox-mode',
      'approval-policy',
    ],
    provenance: 'plana-trait-module-methodology-skill',
  },
  sourceMapIds: EVIDENCE_ONLY_RUNTIME_SOURCE_MAP_IDS,
} as const) satisfies TraitModuleManifest;

export function getMethodologySkillProfile(
  profileId: MethodologySkillProfileId,
): MethodologySkillProfile {
  const profile = METHODOLOGY_SKILL_PROFILES.find((entry) => entry.id === profileId);
  if (!profile) {
    throw new Error(`Unknown methodology skill profile: ${profileId}`);
  }
  return profile;
}

export type MethodologySkillEvidenceCheckpointKind =
  | 'runtime-decoration-start'
  | 'runtime-decoration-complete'
  | 'runtime-decoration-error';

export type MethodologySkillEvidenceCheckpointStatus =
  | 'delegate-returned'
  | 'delegate-threw';

export interface MethodologySkillEvidenceCheckpoint {
  readonly checkpoint: MethodologySkillEvidenceCheckpointKind;
  readonly taskId: string;
  readonly skillId: MethodologySkillId;
  readonly profileId: MethodologySkillProfileId;
  readonly requested: boolean;
  readonly runtimeDecorationIntent: MethodologySkillRuntimeDecorationIntent;
  readonly runtimeDecorationEnforcement: MethodologySkillRuntimeDecorationEnforcement;
  readonly summary: string;
  readonly criteria: ReadonlyArray<string>;
  readonly sourceMapIds: ReadonlyArray<MethodologySkillSourceMapId>;
  readonly completionStatus?: MethodologySkillEvidenceCheckpointStatus;
  readonly causeKind?: string;
}

export interface CreateMethodologySkillEvidenceCheckpointInput
  extends MethodologySkillSelection {
  readonly checkpoint: MethodologySkillEvidenceCheckpointKind;
  readonly taskId: string;
  readonly summary?: string;
  readonly completionStatus?: MethodologySkillEvidenceCheckpointStatus;
  readonly causeKind?: string;
}

export function createMethodologySkillEvidenceCheckpoint(
  input: CreateMethodologySkillEvidenceCheckpointInput,
): MethodologySkillEvidenceCheckpoint {
  const profile = getMethodologySkillProfile(input.selectedProfileId);
  if (profile.skillId !== input.selectedSkillId) {
    throw new Error(
      `Methodology skill profile ${input.selectedProfileId} does not belong to ${input.selectedSkillId}.`,
    );
  }
  if (profile.runtimeDecorationIntent !== input.runtimeDecorationIntent) {
    throw new Error(
      `Methodology skill profile ${input.selectedProfileId} requires runtimeDecorationIntent=${profile.runtimeDecorationIntent}.`,
    );
  }

  const summary =
    input.summary ??
    (input.checkpoint === 'runtime-decoration-start'
      ? 'methodology-skill evidence-only decoration started'
      : input.checkpoint === 'runtime-decoration-complete'
        ? 'methodology-skill evidence-only decoration completed'
        : 'methodology-skill evidence-only decoration observed delegate error');

  return Object.freeze({
    checkpoint: input.checkpoint,
    taskId: input.taskId,
    skillId: input.selectedSkillId,
    profileId: input.selectedProfileId,
    requested: input.requested,
    runtimeDecorationIntent: input.runtimeDecorationIntent,
    runtimeDecorationEnforcement: input.runtimeDecorationEnforcement,
    summary,
    criteria: profile.criteria,
    sourceMapIds: profile.sourceMapIds,
    ...(input.completionStatus === undefined
      ? {}
      : { completionStatus: input.completionStatus }),
    ...(input.causeKind === undefined ? {} : { causeKind: input.causeKind }),
  });
}

export function formatMethodologySkillEvidenceCheckpointDetail(
  checkpoint: MethodologySkillEvidenceCheckpoint,
): string {
  const detail = [
    `checkpoint=${checkpoint.checkpoint}`,
    `skill=${checkpoint.skillId}`,
    `profile=${checkpoint.profileId}`,
    `requested=${String(checkpoint.requested)}`,
    `intent=${checkpoint.runtimeDecorationIntent}`,
    `enforcement=${checkpoint.runtimeDecorationEnforcement}`,
    `summary=${checkpoint.summary}`,
    `criteria=${checkpoint.criteria.join(',')}`,
    `sources=${checkpoint.sourceMapIds.join(',')}`,
  ];
  if (checkpoint.completionStatus !== undefined) {
    detail.push(`completionStatus=${checkpoint.completionStatus}`);
  }
  if (checkpoint.causeKind !== undefined) {
    detail.push(`causeKind=${checkpoint.causeKind}`);
  }
  return detail.join(' | ');
}
