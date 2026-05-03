/**
 * Capability flag contract.
 *
 * This module owns the closed vocabulary for coarse compute/resource grants.
 * It deliberately does NOT define Auto Archive Traits. Traits are submodule
 * plugins described by `src/contracts/trait-module.ts`; capability flags are
 * only the small, behavior-free tokens consumed by compute bounding logic.
 */

/**
 * String-literal union of canonical compute/resource capability flags.
 *
 * Additions require a compute-boundary review because each new flag must map
 * to an explicit `CapabilityBoundingSet` delta before any runtime may consume
 * it. Methodology/profile/plugin identities MUST NOT be added here.
 */
export type CapabilityFlag =
  | 'network-access'
  | 'sandbox-mode'
  | 'approval-policy'
  | 'web-search-mode';

/**
 * Immutable list of capability flag identifiers.
 */
export type CapabilityFlags = ReadonlyArray<CapabilityFlag>;

/**
 * Frozen runtime enumeration of every member of `CapabilityFlag`. The
 * `satisfies` check keeps this list in lockstep with the union.
 */
export const CAPABILITY_FLAGS = Object.freeze([
  'network-access',
  'sandbox-mode',
  'approval-policy',
  'web-search-mode',
] as const) satisfies readonly CapabilityFlag[];

/**
 * Type guard: is `value` a canonical `CapabilityFlag`?
 */
export function isCapabilityFlag(value: string): value is CapabilityFlag {
  return (CAPABILITY_FLAGS as readonly string[]).includes(value);
}

/**
 * Type guard: is `value` a `CapabilityFlags` immutable-array-compatible value?
 */
export function isCapabilityFlags(value: unknown): value is CapabilityFlags {
  if (!Array.isArray(value)) {
    return false;
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || !isCapabilityFlag(entry)) {
      return false;
    }
  }
  return true;
}
