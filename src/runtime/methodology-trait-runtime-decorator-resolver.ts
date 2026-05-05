import { BoundaryValidationError } from '../contracts/boundary-validators.js';
import {
  METHODOLOGY_SKILL_PROFILES,
  METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
  type MethodologySkillSelection,
} from '../contracts/methodology-skill.js';
import type {
  CapabilityFlag,
} from '../contracts/capability-flag.js';
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
  TraitSkillAdmitHook,
  TraitSkillBumpUseHook,
} from '../contracts/trait-runtime-hook.js';

export const AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION =
  'AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION';

export type MethodologyTraitRuntimeDecorationMode = 'off' | 'evidence-only';

export interface MethodologyTraitMidCycleHookBinding {
  readonly moduleId: string;
  readonly moduleVersion: string;
  readonly skillAdmit?: TraitSkillAdmitHook;
  readonly skillBumpUse?: TraitSkillBumpUseHook;
}

export interface MethodologyTraitRuntimeDecoratorResolverOptions {
  readonly workspaceRoot: string;
  readonly importModule?: TraitRuntimeModuleImporter;
  readonly timeoutMs?: number;
  readonly allowWorkspaceLocal?: boolean;
  readonly allowExternal?: boolean;
  readonly moduleRequestedCapabilityFlags?: readonly CapabilityFlag[];
  readonly hostGrantedCapabilityFlags?: readonly CapabilityFlag[];
  /** M5b — tier-2 hooks consulted on admission and decorator composition. */
  readonly midCycleHooks?: ReadonlyArray<MethodologyTraitMidCycleHookBinding>;
}

export function resolveMethodologyTraitRuntimeDecorationMode(
  env: NodeJS.ProcessEnv = process.env,
): MethodologyTraitRuntimeDecorationMode {
  const raw = env[AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION];
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
  if (['1', 'true', 'yes', 'on', 'evidence-only'].includes(value)) {
    return 'evidence-only';
  }
  throw new BoundaryValidationError(
    'B-SET',
    `${AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION} must be one of: off, evidence-only.`,
  );
}

export function createMethodologyTraitRuntimeAgentOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<MethodologyTraitRuntimeDecoratorResolverOptions, 'workspaceRoot'> & {
    readonly workspaceRoot?: string;
  } = {},
): AgentRuntimeOptions {
  const mode = resolveMethodologyTraitRuntimeDecorationMode(env);
  if (mode === 'off') {
    return {};
  }
  return {
    traitRuntimeDecoratorResolver: createMethodologyTraitRuntimeDecoratorResolver({
      workspaceRoot: options.workspaceRoot ?? process.cwd(),
      ...(options.importModule === undefined ? {} : { importModule: options.importModule }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.allowWorkspaceLocal === undefined
        ? {}
        : { allowWorkspaceLocal: options.allowWorkspaceLocal }),
      ...(options.allowExternal === undefined ? {} : { allowExternal: options.allowExternal }),
      ...(options.moduleRequestedCapabilityFlags === undefined
        ? {}
        : {
            moduleRequestedCapabilityFlags:
              options.moduleRequestedCapabilityFlags,
          }),
      ...(options.hostGrantedCapabilityFlags === undefined
        ? {}
        : { hostGrantedCapabilityFlags: options.hostGrantedCapabilityFlags }),
      ...(options.midCycleHooks === undefined
        ? {}
        : { midCycleHooks: options.midCycleHooks }),
    }),
  };
}

export function createMethodologyTraitRuntimeDecoratorResolver(
  options: MethodologyTraitRuntimeDecoratorResolverOptions,
): AgentRuntimeTraitRuntimeDecoratorResolver {
  let loadedDecorator: Promise<TraitRuntimeDriverDecorator> | undefined;

  const loadDecorator = async (): Promise<TraitRuntimeDriverDecorator> => {
    loadedDecorator ??= loadRequiredMethodologyTraitRuntimeDecorator(options).catch(
      (error: unknown) => {
        loadedDecorator = undefined;
        throw error;
      },
    );
    return loadedDecorator;
  };

  const midCycleHooks = options.midCycleHooks ?? [];

  return async ({ plan, plana }): Promise<readonly AgentRuntimeTraitRuntimeDecoratorBinding[]> => {
    const selection = createMethodologyTraitSelection();
    if (!selection.requested) {
      return [];
    }

    const traitRequest = {
      kind: 'trait-module' as const,
      moduleId: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.id,
      taskId: plan.taskId,
      provenance: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.admission.provenance,
      ...selection,
    };
    const admission = plana.consumeTrait(traitRequest);
    if (admission.status === 'vetoed') {
      throw new AgentRuntimeTraitRuntimeDecoratorError(
        'trait runtime decorator admission',
        `Methodology TraitModule runtime decorator vetoed by ${admission.veto.provenance}: ${admission.veto.reason}`,
      );
    }

    // M2 — Consult curator (if wired) for the just-admitted trait. The
    // decision is observation-only in this PR: 'keep' → load decorator,
    // 'prune' → skip decorator (curator-driven removal), 'consolidate' →
    // load decorator with consolidation evidence in context. The default
    // rubric set is empty so no behavior changes unless the operator
    // registers rubrics.
    const curator = plana.getCurator();
    let curatorDecisionKind: 'keep' | 'consolidate' | 'prune' = 'keep';
    let curatorReason: string | undefined;
    if (curator !== undefined) {
      const decision = curator.admitSkill(traitRequest);
      curatorDecisionKind = decision.kind;
      curatorReason = decision.reason;
    }

    // M5b — Fire `skillAdmit` hooks (replaces the M2 console.warn channel).
    // Hooks are observation-only and error-contained.
    const observedAtAdmit = new Date().toISOString();
    const admitPayload = {
      taskId: plan.taskId,
      traitModuleId: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.id,
      admissionStatus:
        curatorDecisionKind === 'prune'
          ? ('curator-pruned' as const)
          : ('admitted' as const),
      ...(curatorReason === undefined ? {} : { curatorReason }),
      ...(curator === undefined ? {} : { curatorDecisionKind }),
    };
    for (const binding of midCycleHooks) {
      if (binding.skillAdmit === undefined) continue;
      try {
        await binding.skillAdmit(
          {
            moduleId: binding.moduleId as never,
            moduleVersion: binding.moduleVersion,
            observedAt: observedAtAdmit,
          },
          admitPayload,
        );
      } catch (error) {
        console.warn(
          'trait-runtime-hook-threw',
          JSON.stringify({
            hook: 'skillAdmit',
            moduleId: binding.moduleId,
            taskId: plan.taskId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    if (curatorDecisionKind === 'prune') {
      return [];
    }

    const decorator = await loadDecorator();

    // M5b — Fire `skillBumpUse` hooks once the decorator is composed.
    const observedAtBump = new Date().toISOString();
    for (const binding of midCycleHooks) {
      if (binding.skillBumpUse === undefined) continue;
      try {
        await binding.skillBumpUse(
          {
            moduleId: binding.moduleId as never,
            moduleVersion: binding.moduleVersion,
            observedAt: observedAtBump,
          },
          {
            taskId: plan.taskId,
            bumpedTraitModuleId: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.id,
          },
        );
      } catch (error) {
        console.warn(
          'trait-runtime-hook-threw',
          JSON.stringify({
            hook: 'skillBumpUse',
            moduleId: binding.moduleId,
            taskId: plan.taskId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    return [
      {
        decorator,
        context: {
          manifest: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
          requested: true,
        },
      },
    ];
  };
}

function createMethodologyTraitSelection(): MethodologySkillSelection {
  const profile = METHODOLOGY_SKILL_PROFILES[0];
  return {
    requested: true,
    selectedSkillId: profile.skillId,
    selectedProfileId: profile.id,
    runtimeDecorationIntent: profile.runtimeDecorationIntent,
    runtimeDecorationEnforcement:
      METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.runtime.hook === 'evidence-decorator'
        ? METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.runtime.enforcement
        : 'required',
  };
}

async function loadRequiredMethodologyTraitRuntimeDecorator(
  options: TraitRuntimeDriverDecoratorLoadOptions,
): Promise<TraitRuntimeDriverDecorator> {
  let loaded: Awaited<ReturnType<typeof loadTraitRuntimeDriverDecorator>>;
  try {
    loaded = await loadTraitRuntimeDriverDecorator(
      METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
      options,
    );
  } catch (error) {
    throw new AgentRuntimeTraitRuntimeDecoratorError(
      'trait runtime decorator loading',
      `Failed to load methodology TraitModule runtime decorator: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  if (loaded.status !== 'loaded' || loaded.decorator === undefined) {
    throw new AgentRuntimeTraitRuntimeDecoratorError(
      'trait runtime decorator loading',
      `Failed to load methodology TraitModule runtime decorator: ${loaded.errorCode ?? loaded.status}${
        loaded.errorMessage === undefined ? '' : `: ${loaded.errorMessage}`
      }`,
    );
  }
  return loaded.decorator;
}
