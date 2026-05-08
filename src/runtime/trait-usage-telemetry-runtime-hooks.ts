import {
  METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST,
} from '../contracts/methodology-skill.js';
import {
  createTraitUsageTelemetryBumpUseHook,
  type TraitUsageTelemetryPort,
} from '../core/trait-usage-telemetry.js';
import type {
  MethodologyTraitMidCycleHookBinding,
} from './methodology-trait-runtime-decorator-resolver.js';

/**
 * Bridges the observe-only methodology TraitModule runtime hook into the
 * process-local trait usage sidecar. The hook binding carries no prompt,
 * provider, sandbox, approval, or tool authority; it only records the
 * composed methodology TraitModule use event when the opt-in runtime
 * decorator is enabled.
 */
export function createMethodologyTraitUsageTelemetryMidCycleHooks(
  telemetry: TraitUsageTelemetryPort,
): readonly MethodologyTraitMidCycleHookBinding[] {
  return [
    {
      moduleId: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.id,
      moduleVersion: METHODOLOGY_SKILL_TRAIT_MODULE_MANIFEST.version,
      skillBumpUse: createTraitUsageTelemetryBumpUseHook(telemetry),
    },
  ];
}
