import type { CapabilityFlag } from './capability-flag.js';

/**
 * Auto Archive TraitModule contract.
 *
 * A TraitModule is a repository/workspace submodule plugin: it may contain a
 * human-readable instruction profile, optional scheduler declarations, and
 * optional runtime hook code behind a stable manifest. It is intentionally
 * broader than a prompt-only skill but narrower than a provider/runtime switch.
 *
 * This contract is data-only. It does not load code, schedule jobs, or execute
 * hooks; those responsibilities belong to future loader/scheduler/runtime
 * slices that consume this manifest.
 */

export const TRAIT_MODULE_SCHEMA_VERSION = 1 as const;

export type TraitModuleId = `trait.${string}.v${number}`;

export type TraitModuleTrustBoundary =
  | 'repository-owned'
  | 'workspace-local'
  | 'external';

export type TraitInstructionFormat = 'markdown';

export interface TraitInstructionSpec {
  /** Instruction file relative to the trait module root. */
  readonly entrypoint: 'TRAIT.md' | string;
  readonly format: TraitInstructionFormat;
  readonly summary: string;
}

export type TraitScheduleDelivery =
  | 'main-session'
  | 'isolated-session'
  | 'current-session';

export interface TraitCronSchedule {
  readonly id: string;
  readonly cron: string;
  readonly timezone?: string;
  readonly delivery: TraitScheduleDelivery;
  readonly summary: string;
}

export type TraitScheduleSpec =
  | {
      readonly mode: 'none';
    }
  | {
      readonly mode: 'cron';
      readonly schedules: ReadonlyArray<TraitCronSchedule>;
    };

export type TraitRuntimeHookKind =
  | 'none'
  | 'evidence-decorator'
  | 'module-entrypoint';

export type TraitRuntimeEnforcement = 'advisory' | 'required';

export type TraitRuntimeSpec =
  | {
      readonly hook: 'none';
    }
  | {
      readonly hook: Exclude<TraitRuntimeHookKind, 'none'>;
      /** Runtime module path relative to the trait module root or repository root. */
      readonly modulePath: string;
      /** Named export consumed by a future runtime loader. */
      readonly exportName: string;
      readonly enforcement: TraitRuntimeEnforcement;
      readonly summary: string;
    };

export interface TraitAdmissionSpec {
  /**
   * Whether requesting the module is opt-in or on by default for a plan class.
   * First-slice consumers only record this declaration.
   */
  readonly defaultRequested: boolean;
  /** Capability flags that may be required when this trait module runs code. */
  readonly requiredCapabilityFlags: ReadonlyArray<CapabilityFlag>;
  /**
   * Capability flags this module's own runtime hook must never request.
   *
   * This is not an ambient surface deny-list: a host allocation may already
   * expose a capability for unrelated reasons without making the module
   * inadmissible. Future loaders should compare this list to the module's own
   * requested capability set.
   */
  readonly forbiddenCapabilityFlags: ReadonlyArray<CapabilityFlag>;
  /** Stable provenance for Plana/admission decisions involving this module. */
  readonly provenance: string;
}

export interface TraitModuleLayout {
  /** Folder root, e.g. `traits/methodology-agent-origin`. */
  readonly root: string;
  /** Manifest file relative to `root`. */
  readonly manifest: 'trait.json' | string;
  /** Instruction file relative to `root`. */
  readonly instruction: 'TRAIT.md' | string;
  /** Optional runtime directory relative to `root`. */
  readonly runtimeDir?: string;
  /** Optional schedule directory relative to `root`. */
  readonly schedulesDir?: string;
}

export interface TraitModuleManifest {
  readonly schemaVersion: typeof TRAIT_MODULE_SCHEMA_VERSION;
  readonly id: TraitModuleId;
  readonly name: string;
  readonly version: string;
  readonly trustBoundary: TraitModuleTrustBoundary;
  readonly layout: TraitModuleLayout;
  readonly instructions: TraitInstructionSpec;
  readonly schedule: TraitScheduleSpec;
  readonly runtime: TraitRuntimeSpec;
  readonly admission: TraitAdmissionSpec;
  readonly sourceMapIds: ReadonlyArray<string>;
}

const TRAIT_MODULE_ID_PATTERN = /^trait\.[a-z0-9][a-z0-9.-]*\.v[1-9][0-9]*$/;

export function isTraitModuleId(value: string): value is TraitModuleId {
  return TRAIT_MODULE_ID_PATTERN.test(value);
}

export function isTraitModuleManifest(
  value: unknown,
): value is TraitModuleManifest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<TraitModuleManifest>;
  return (
    candidate.schemaVersion === TRAIT_MODULE_SCHEMA_VERSION &&
    typeof candidate.id === 'string' &&
    isTraitModuleId(candidate.id) &&
    typeof candidate.name === 'string' &&
    typeof candidate.version === 'string' &&
    typeof candidate.layout === 'object' &&
    candidate.layout !== null &&
    typeof candidate.instructions === 'object' &&
    candidate.instructions !== null &&
    typeof candidate.schedule === 'object' &&
    candidate.schedule !== null &&
    typeof candidate.runtime === 'object' &&
    candidate.runtime !== null &&
    typeof candidate.admission === 'object' &&
    candidate.admission !== null &&
    Array.isArray(candidate.sourceMapIds)
  );
}
