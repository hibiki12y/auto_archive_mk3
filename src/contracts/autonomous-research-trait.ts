/**
 * Repository-owned autonomous-research TraitModule contracts.
 *
 * The trait maps the Darwin Gödel Machine (DGM) idea — archive-backed,
 * empirically validated open-ended improvement — into Auto Archive's bounded
 * research-control posture. It is intentionally evidence-only at runtime:
 * it may annotate dispatches with checkpoints, but it must not spawn hidden
 * loops, switch providers, rewrite prompts, or mutate terminal causes.
 */

import type { TraitModuleId, TraitModuleManifest } from './trait-module.js';

export type AutonomousResearchTraitId = 'autonomous-research-goal-loop';

export const AUTONOMOUS_RESEARCH_TRAIT_MODULE_ID =
  'trait.research.autonomous-goal-loop.v1' as const satisfies TraitModuleId;

export const AUTONOMOUS_RESEARCH_TRAIT_IDS = Object.freeze([
  'autonomous-research-goal-loop',
] as const) satisfies readonly AutonomousResearchTraitId[];

export function isAutonomousResearchTraitId(
  value: string,
): value is AutonomousResearchTraitId {
  return (AUTONOMOUS_RESEARCH_TRAIT_IDS as readonly string[]).includes(value);
}

export type AutonomousResearchTraitProfileId = 'dgm-bounded-archive-runtime';

export const AUTONOMOUS_RESEARCH_TRAIT_PROFILE_IDS = Object.freeze([
  'dgm-bounded-archive-runtime',
] as const) satisfies readonly AutonomousResearchTraitProfileId[];

export function isAutonomousResearchTraitProfileId(
  value: string,
): value is AutonomousResearchTraitProfileId {
  return (AUTONOMOUS_RESEARCH_TRAIT_PROFILE_IDS as readonly string[]).includes(
    value,
  );
}

export type AutonomousResearchRuntimeDecorationIntent =
  'bounded-archive-evidence';

export const AUTONOMOUS_RESEARCH_RUNTIME_DECORATION_INTENTS = Object.freeze([
  'bounded-archive-evidence',
] as const) satisfies readonly AutonomousResearchRuntimeDecorationIntent[];

export type AutonomousResearchRuntimeDecorationEnforcement =
  | 'advisory'
  | 'required';

export const AUTONOMOUS_RESEARCH_RUNTIME_DECORATION_ENFORCEMENTS =
  Object.freeze([
    'advisory',
    'required',
  ] as const) satisfies readonly AutonomousResearchRuntimeDecorationEnforcement[];

export interface AutonomousResearchTraitSelection {
  readonly requested: boolean;
  readonly selectedTraitId: AutonomousResearchTraitId;
  readonly selectedProfileId: AutonomousResearchTraitProfileId;
  readonly runtimeDecorationIntent: AutonomousResearchRuntimeDecorationIntent;
  readonly runtimeDecorationEnforcement: AutonomousResearchRuntimeDecorationEnforcement;
}

export type AutonomousResearchTraitSourceMapId =
  'darwin-godel-machine-2505.22954';

export const AUTONOMOUS_RESEARCH_TRAIT_SOURCE_MAP = Object.freeze({
  'darwin-godel-machine-2505.22954':
    'https://arxiv.org/abs/2505.22954',
} as const) satisfies Readonly<Record<AutonomousResearchTraitSourceMapId, string>>;

export type AutonomousResearchTraitCriterion =
  | 'explicit-goal-and-stop-condition-required'
  | 'bounded-iteration-and-budget-required'
  | 'archive-stepping-stones-recorded'
  | 'empirical-evidence-gate-required'
  | 'completion-audit-before-terminal'
  | 'sandbox-and-human-oversight-preserved'
  | 'prompt-provider-settings-unchanged';

const DGM_BOUNDED_ARCHIVE_CRITERIA = Object.freeze([
  'explicit-goal-and-stop-condition-required',
  'bounded-iteration-and-budget-required',
  'archive-stepping-stones-recorded',
  'empirical-evidence-gate-required',
  'completion-audit-before-terminal',
  'sandbox-and-human-oversight-preserved',
  'prompt-provider-settings-unchanged',
] as const) satisfies readonly AutonomousResearchTraitCriterion[];

const DGM_BOUNDED_ARCHIVE_SOURCE_MAP_IDS = Object.freeze([
  'darwin-godel-machine-2505.22954',
] as const) satisfies readonly AutonomousResearchTraitSourceMapId[];

export interface AutonomousResearchTraitProfile {
  readonly id: AutonomousResearchTraitProfileId;
  readonly traitId: AutonomousResearchTraitId;
  readonly runtimeDecorationIntent: AutonomousResearchRuntimeDecorationIntent;
  readonly summary: string;
  readonly criteria: ReadonlyArray<AutonomousResearchTraitCriterion>;
  readonly sourceMapIds: ReadonlyArray<AutonomousResearchTraitSourceMapId>;
}

export const AUTONOMOUS_RESEARCH_TRAIT_PROFILES = Object.freeze([
  {
    id: 'dgm-bounded-archive-runtime',
    traitId: 'autonomous-research-goal-loop',
    runtimeDecorationIntent: 'bounded-archive-evidence',
    summary:
      'records DGM-inspired bounded autonomous research checkpoints without launching unbounded hidden execution',
    criteria: DGM_BOUNDED_ARCHIVE_CRITERIA,
    sourceMapIds: DGM_BOUNDED_ARCHIVE_SOURCE_MAP_IDS,
  },
] as const) satisfies readonly AutonomousResearchTraitProfile[];

export const AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: AUTONOMOUS_RESEARCH_TRAIT_MODULE_ID,
  name: 'autonomous-research-goal-loop',
  version: '1.0.0',
  trustBoundary: 'repository-owned',
  layout: {
    root: 'traits/autonomous-research-goal-loop',
    manifest: 'trait.json',
    instruction: 'TRAIT.md',
    runtimeDir: 'runtime',
    schedulesDir: 'schedules',
  },
  instructions: {
    entrypoint: 'TRAIT.md',
    format: 'markdown',
    summary:
      'guides bounded archive-backed autonomous research until explicit goal criteria pass',
  },
  schedule: {
    mode: 'none',
  },
  runtime: {
    hook: 'evidence-decorator',
    modulePath: 'src/runtime/autonomous-research-runtime-driver.ts',
    exportName: 'composeTraitRuntimeDriver',
    enforcement: 'required',
    summary:
      'emits evidence-only autonomous-research checkpoints without spawning hidden loops or changing delegate semantics',
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
    provenance: 'plana-trait-module-autonomous-research',
  },
  sourceMapIds: DGM_BOUNDED_ARCHIVE_SOURCE_MAP_IDS,
} as const) satisfies TraitModuleManifest;

export function getAutonomousResearchTraitProfile(
  profileId: AutonomousResearchTraitProfileId,
): AutonomousResearchTraitProfile {
  const profile = AUTONOMOUS_RESEARCH_TRAIT_PROFILES.find(
    (entry) => entry.id === profileId,
  );
  if (!profile) {
    throw new Error(`Unknown autonomous research trait profile: ${profileId}`);
  }
  return profile;
}

export type AutonomousResearchEvidenceCheckpointKind =
  | 'runtime-decoration-start'
  | 'runtime-decoration-complete'
  | 'runtime-decoration-error';

export type AutonomousResearchEvidenceCheckpointStatus =
  | 'delegate-returned'
  | 'delegate-threw';

export interface AutonomousResearchEvidenceCheckpoint {
  readonly checkpoint: AutonomousResearchEvidenceCheckpointKind;
  readonly taskId: string;
  readonly traitId: AutonomousResearchTraitId;
  readonly profileId: AutonomousResearchTraitProfileId;
  readonly requested: boolean;
  readonly runtimeDecorationIntent: AutonomousResearchRuntimeDecorationIntent;
  readonly runtimeDecorationEnforcement: AutonomousResearchRuntimeDecorationEnforcement;
  readonly summary: string;
  readonly criteria: ReadonlyArray<AutonomousResearchTraitCriterion>;
  readonly sourceMapIds: ReadonlyArray<AutonomousResearchTraitSourceMapId>;
  readonly completionStatus?: AutonomousResearchEvidenceCheckpointStatus;
  readonly causeKind?: string;
}

export interface CreateAutonomousResearchEvidenceCheckpointInput
  extends AutonomousResearchTraitSelection {
  readonly checkpoint: AutonomousResearchEvidenceCheckpointKind;
  readonly taskId: string;
  readonly summary?: string;
  readonly completionStatus?: AutonomousResearchEvidenceCheckpointStatus;
  readonly causeKind?: string;
}

export function createAutonomousResearchEvidenceCheckpoint(
  input: CreateAutonomousResearchEvidenceCheckpointInput,
): AutonomousResearchEvidenceCheckpoint {
  const profile = getAutonomousResearchTraitProfile(input.selectedProfileId);
  if (profile.traitId !== input.selectedTraitId) {
    throw new Error(
      `Autonomous research trait profile ${input.selectedProfileId} does not belong to ${input.selectedTraitId}.`,
    );
  }
  if (profile.runtimeDecorationIntent !== input.runtimeDecorationIntent) {
    throw new Error(
      `Autonomous research trait profile ${input.selectedProfileId} requires runtimeDecorationIntent=${profile.runtimeDecorationIntent}.`,
    );
  }

  const summary =
    input.summary ??
    (input.checkpoint === 'runtime-decoration-start'
      ? 'autonomous-research bounded archive decoration started'
      : input.checkpoint === 'runtime-decoration-complete'
        ? 'autonomous-research bounded archive decoration completed'
        : 'autonomous-research bounded archive decoration observed delegate error');

  return Object.freeze({
    checkpoint: input.checkpoint,
    taskId: input.taskId,
    traitId: input.selectedTraitId,
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

export function formatAutonomousResearchEvidenceCheckpointDetail(
  checkpoint: AutonomousResearchEvidenceCheckpoint,
): string {
  const detail = [
    `checkpoint=${checkpoint.checkpoint}`,
    `trait=${checkpoint.traitId}`,
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
