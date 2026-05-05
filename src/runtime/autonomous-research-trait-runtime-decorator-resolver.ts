import { BoundaryValidationError } from '../contracts/boundary-validators.js';
import type { CapabilityFlag } from '../contracts/capability-flag.js';
import {
  AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST,
  AUTONOMOUS_RESEARCH_TRAIT_PROFILES,
  type AutonomousResearchTraitSelection,
} from '../contracts/autonomous-research-trait.js';
import {
  loadTraitRuntimeDriverDecorator,
  type TraitRuntimeDriverDecoratorLoadOptions,
} from '../core/trait-module-loader.js';
import {
  AgentRuntimeTraitRuntimeDecoratorError,
  type AgentRuntimeOptions,
  type AgentRuntimeTraitRuntimeDecoratorBinding,
  type AgentRuntimeTraitRuntimeDecoratorResolver,
} from './agent-runtime.js';
import type {
  TraitRuntimeDriverDecorator,
  TraitRuntimeModuleImporter,
} from '../contracts/trait-runtime-hook.js';

export const AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION =
  'AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION';

export type AutonomousResearchTraitRuntimeDecorationMode =
  | 'off'
  | 'bounded-evidence';

export interface AutonomousResearchTraitRuntimeDecoratorResolverOptions {
  readonly workspaceRoot: string;
  readonly importModule?: TraitRuntimeModuleImporter;
  readonly timeoutMs?: number;
  readonly allowWorkspaceLocal?: boolean;
  readonly allowExternal?: boolean;
  readonly moduleRequestedCapabilityFlags?: readonly CapabilityFlag[];
  readonly hostGrantedCapabilityFlags?: readonly CapabilityFlag[];
}

export function resolveAutonomousResearchTraitRuntimeDecorationMode(
  env: NodeJS.ProcessEnv = process.env,
): AutonomousResearchTraitRuntimeDecorationMode {
  const raw = env[AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION];
  if (raw === undefined) {
    return 'off';
  }
  const value = raw.trim().toLowerCase();
  if (value.length === 0) {
    return 'off';
  }
  if (['0', 'false', 'no', 'off', 'none'].includes(value)) {
    return 'off';
  }
  if (
    ['1', 'true', 'yes', 'on', 'bounded-evidence', 'evidence-only'].includes(
      value,
    )
  ) {
    return 'bounded-evidence';
  }
  throw new BoundaryValidationError(
    'B-SET',
    `${AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION} must be one of: off, bounded-evidence.`,
  );
}

export function createAutonomousResearchTraitRuntimeAgentOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<
    AutonomousResearchTraitRuntimeDecoratorResolverOptions,
    'workspaceRoot'
  > & {
    readonly workspaceRoot?: string;
  } = {},
): AgentRuntimeOptions {
  const mode = resolveAutonomousResearchTraitRuntimeDecorationMode(env);
  if (mode === 'off') {
    return {};
  }
  return {
    traitRuntimeDecoratorResolver:
      createAutonomousResearchTraitRuntimeDecoratorResolver({
        workspaceRoot: options.workspaceRoot ?? process.cwd(),
        ...(options.importModule === undefined
          ? {}
          : { importModule: options.importModule }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.allowWorkspaceLocal === undefined
          ? {}
          : { allowWorkspaceLocal: options.allowWorkspaceLocal }),
        ...(options.allowExternal === undefined
          ? {}
          : { allowExternal: options.allowExternal }),
        ...(options.moduleRequestedCapabilityFlags === undefined
          ? {}
          : {
              moduleRequestedCapabilityFlags:
                options.moduleRequestedCapabilityFlags,
            }),
        ...(options.hostGrantedCapabilityFlags === undefined
          ? {}
          : { hostGrantedCapabilityFlags: options.hostGrantedCapabilityFlags }),
      }),
  };
}

export function createAutonomousResearchTraitRuntimeDecoratorResolver(
  options: AutonomousResearchTraitRuntimeDecoratorResolverOptions,
): AgentRuntimeTraitRuntimeDecoratorResolver {
  let loadedDecorator: Promise<TraitRuntimeDriverDecorator> | undefined;

  const loadDecorator = async (): Promise<TraitRuntimeDriverDecorator> => {
    loadedDecorator ??= loadRequiredAutonomousResearchTraitRuntimeDecorator(
      options,
    ).catch((error: unknown) => {
      loadedDecorator = undefined;
      throw error;
    });
    return loadedDecorator;
  };

  return async ({ plan, plana }): Promise<
    readonly AgentRuntimeTraitRuntimeDecoratorBinding[]
  > => {
    const selection = createAutonomousResearchTraitSelection();
    if (!selection.requested) {
      return [];
    }

    const traitRequest = {
      kind: 'trait-module' as const,
      moduleId: AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST.id,
      taskId: plan.taskId,
      provenance: AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST.admission.provenance,
      ...selection,
    };
    const admission = plana.consumeTrait(traitRequest);
    if (admission.status === 'vetoed') {
      throw new AgentRuntimeTraitRuntimeDecoratorError(
        'trait runtime decorator admission',
        `Autonomous Research TraitModule runtime decorator vetoed by ${admission.veto.provenance}: ${admission.veto.reason}`,
      );
    }

    const decorator = await loadDecorator();
    return [
      {
        decorator,
        context: {
          manifest: AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST,
          requested: true,
        },
      },
    ];
  };
}

function createAutonomousResearchTraitSelection(): AutonomousResearchTraitSelection {
  const profile = AUTONOMOUS_RESEARCH_TRAIT_PROFILES[0];
  return {
    requested: true,
    selectedTraitId: profile.traitId,
    selectedProfileId: profile.id,
    runtimeDecorationIntent: profile.runtimeDecorationIntent,
    runtimeDecorationEnforcement:
      AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST.runtime.hook ===
      'evidence-decorator'
        ? AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST.runtime.enforcement
        : 'required',
  };
}

async function loadRequiredAutonomousResearchTraitRuntimeDecorator(
  options: TraitRuntimeDriverDecoratorLoadOptions,
): Promise<TraitRuntimeDriverDecorator> {
  const loaded = await loadTraitRuntimeDriverDecorator(
    AUTONOMOUS_RESEARCH_TRAIT_MODULE_MANIFEST,
    options,
  );
  if (loaded.status !== 'loaded' || loaded.decorator === undefined) {
    throw new AgentRuntimeTraitRuntimeDecoratorError(
      'trait runtime decorator loading',
      loaded.errorMessage ??
        'Autonomous Research TraitModule runtime decorator could not be loaded.',
    );
  }
  return loaded.decorator;
}
