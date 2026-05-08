import type { TraitModuleId } from '../contracts/trait-module.js';
import type {
  TraitSkillBumpUseHook,
  TraitSkillBumpUsePayload,
} from '../contracts/trait-runtime-hook.js';

export interface TraitUsageStats {
  readonly traitModuleId: TraitModuleId;
  readonly useCount: number;
  readonly firstUsedAt: string;
  readonly lastUsedAt: string;
  readonly lastTaskId: string;
}

export interface TraitUsageTelemetryPort {
  bumpUse(
    payload: TraitSkillBumpUsePayload,
    options?: { readonly observedAt?: string },
  ): TraitUsageStats;
  snapshot(): readonly TraitUsageStats[];
}

/**
 * Synchronous in-memory usage sidecar. This is not Hermes' JSON wire format
 * and does not persist on its own; hosts that need durability should snapshot
 * the stats into their own ledger/store. It records usage only and receives no
 * prompt, provider, approval, sandbox, or runtime-permission handles.
 */
export class InMemoryTraitUsageTelemetry implements TraitUsageTelemetryPort {
  private readonly stats = new Map<TraitModuleId, TraitUsageStats>();

  constructor(
    seed: readonly TraitUsageStats[] = [],
    private readonly clock: () => Date = () => new Date(),
  ) {
    for (const entry of seed) {
      this.stats.set(entry.traitModuleId, { ...entry });
    }
  }

  bumpUse(
    payload: TraitSkillBumpUsePayload,
    options: { readonly observedAt?: string } = {},
  ): TraitUsageStats {
    const observedAt = options.observedAt ?? this.clock().toISOString();
    const previous = this.stats.get(payload.bumpedTraitModuleId);
    const next: TraitUsageStats =
      previous === undefined
        ? {
            traitModuleId: payload.bumpedTraitModuleId,
            useCount: 1,
            firstUsedAt: observedAt,
            lastUsedAt: observedAt,
            lastTaskId: payload.taskId,
          }
        : {
            traitModuleId: previous.traitModuleId,
            useCount: previous.useCount + 1,
            firstUsedAt: previous.firstUsedAt,
            lastUsedAt: observedAt,
            lastTaskId: payload.taskId,
          };
    this.stats.set(next.traitModuleId, next);
    return { ...next };
  }

  snapshot(): readonly TraitUsageStats[] {
    return [...this.stats.values()]
      .sort((left, right) => left.traitModuleId.localeCompare(right.traitModuleId))
      .map((entry) => ({ ...entry }));
  }
}

/**
 * Hermes records `bump_use` into a JSON counter. Auto Archive keeps the
 * runtime hook observe-only and lets hosts attach this sidecar when they want
 * deterministic trait usage telemetry for curator rubrics or operator UI.
 */
export function createTraitUsageTelemetryBumpUseHook(
  telemetry: TraitUsageTelemetryPort,
): TraitSkillBumpUseHook {
  return (context, payload) => {
    telemetry.bumpUse(payload, { observedAt: context.observedAt });
  };
}
