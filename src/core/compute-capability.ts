/**
 * Capability surface for the unified ComputeNode port (WU-P §3.4 / ST-04).
 *
 * Current slice: `capabilityFlags` is a typed projection of compute/resource
 * grants owned by `src/contracts/capability-flag.ts`. Auto Archive Traits are
 * no longer encoded here; TraitModule manifests live in
 * `src/contracts/trait-module.ts` and may declare capability requirements
 * without becoming capability flags themselves.
 *
 * Boundary (do not violate without amending WU-P / C2):
 *   - The discriminator `kind` distinguishes the production composing impls
 *     from test doubles.
 *   - `kind: 'test-double'` is permitted ONLY in modules under
 *     `src/**\/__test__/**` (or equivalent test-only locations).
 *   - `CapabilityBoundingSet` is JSON-round-trippable: no `Date`, `bigint`,
 *     `Map`, `Set`, no host objects (mirrors WU-H VN-5).
 *   - The schema is **deny-by-default**: an empty capability-flag set MUST compile to
 *     the `DENIAL_FLOOR` constant exported below (§4 DBD-1).
 */

import type { CapabilityFlag } from '../contracts/capability-flag.js';

/**
 * Discriminator for the capability surface.
 *
 *   - `'slurm-apptainer'` — the SLURM + Apptainer production composing impl.
 *   - `'git-clone'`       — the direct git-clone ComputeNode production impl.
 *   - `'current-node'`    — the current-worktree ComputeNode production impl.
 *   - `'test-double'`     — any test-only ComputeNode implementation.
 */
export type ComputeCapabilityKind =
  | 'slurm-apptainer'
  | 'git-clone'
  | 'current-node'
  | 'test-double';

/**
 * Coarse-grained execution context bounds. The composing production impl
 * starts from a deny-by-default posture; WU-O may widen these flags by
 * resolving plan-declared capability flags. Test doubles populate honestly to
 * reflect what the in-process host environment actually permits.
 */
export interface ComputeExecutionContext {
  /** True iff the dispatched workload may make outbound network calls. */
  readonly hasNetwork: boolean;
  /** True iff the dispatched workload may write to non-scratch filesystem locations. */
  readonly hasFilesystemWrite: boolean;
  /** True iff the workload runs without elevated privileges. Production: always true (C2). */
  readonly rootless: boolean;
}

/**
 * The capability surface returned by a `ComputeNode` and attached to each
 * `ComputeAllocation`. WU-O may extend this interface with additional
 * fields; field semantics defined here are stable and MUST NOT be
 * repurposed.
 */
export interface ComputeCapabilitySurface {
  readonly kind: ComputeCapabilityKind;
  readonly execution: ComputeExecutionContext;
  /**
   * Typed compute/resource capability projection. Each entry is a canonical
   * `CapabilityFlag` per `src/contracts/capability-flag.ts`. Empty / undefined
   * means no admitted capability grants — the capability surface remains at
   * the §4 denial floor.
   */
  readonly capabilityFlags?: ReadonlyArray<CapabilityFlag>;
}

// ---------------------------------------------------------------------------
// WU-O §3 — Capability Bounding Set schema
// ---------------------------------------------------------------------------

/** Network grant axis (deny-by-default; `'none'` = no network). */
export interface NetworkGrants {
  readonly mode: 'none' | 'loopback-only' | 'egress-allowlist';
  /** Required iff mode === 'egress-allowlist'. host:port entries. */
  readonly egressAllowlist?: ReadonlyArray<string>;
}

/** Filesystem grant axis (deny-by-default; empty = read-only allocation root). */
export interface FilesystemGrants {
  readonly scratchWrite: boolean;
  readonly readOnlyMounts: ReadonlyArray<string>;
  readonly writeMounts: ReadonlyArray<string>;
}

/** Process / syscall grant axis (deny-by-default; rootless seccomp floor). */
export interface ProcessGrants {
  readonly fork: boolean;
  readonly exec: boolean;
  readonly ptrace: boolean;
}

/** Device grant axis (deny-by-default; no /dev passthrough). */
export interface DeviceGrants {
  readonly gpu: boolean;
  readonly tty: boolean;
}

/** Audit channel: which capability flag contributed which grant fields. */
export interface GrantProvenance {
  readonly capabilityFlag: string;
  readonly grantedFields: ReadonlyArray<string>;
}

/**
 * WU-O §3 capability bounding set attached to a ComputeAllocation. Pure
 * data, JSON-round-trippable. Always carries `provenance` (possibly empty).
 */
export interface CapabilityBoundingSet {
  readonly schemaVersion: 1;
  readonly network: NetworkGrants;
  readonly filesystem: FilesystemGrants;
  readonly process: ProcessGrants;
  readonly devices: DeviceGrants;
  readonly provenance: ReadonlyArray<GrantProvenance>;
}

/**
 * §4 DBD-1 — denial floor. `compile([])` MUST equal this value structurally.
 * Frozen so that consumers cannot mutate the singleton.
 */
export const DENIAL_FLOOR: CapabilityBoundingSet = Object.freeze({
  schemaVersion: 1 as const,
  network: Object.freeze({ mode: 'none' as const }),
  filesystem: Object.freeze({
    scratchWrite: false,
    readOnlyMounts: Object.freeze([] as string[]),
    writeMounts: Object.freeze([] as string[]),
  }),
  process: Object.freeze({ fork: false, exec: false, ptrace: false }),
  devices: Object.freeze({ gpu: false, tty: false }),
  provenance: Object.freeze([] as GrantProvenance[]),
});

/**
 * §5.2 closed seccomp profile-name set. Adding a profile requires a
 * WU-O amendment; the compiler emits a name only (profile content is
 * materialized by the composing impl).
 */
export type SeccompProfileName = 'minimal' | 'fork-exec' | 'ptrace-allowed';

/**
 * §5.3 compile output. The flag stream is opaque to TRAIT vocabulary
 * (no trait names leak into flags, per §5.3 provenance leakage check).
 */
export interface ApptainerInvocation {
  readonly flags: ReadonlyArray<string>;
  readonly seccompProfile: SeccompProfileName;
  /** Required iff network.mode === 'egress-allowlist'; out-of-band per §5.3. */
  readonly egressAllowlist?: ReadonlyArray<string>;
}

/**
 * §6.2 / AC-O5 typed rejection class. Thrown by the compile when a producer
 * supplies a value that is not a canonical `CapabilityFlag` (i.e., references
 * a capability axis WU-O does not understand). NOT a generic `Error` — tests
 * assert the constructor identity.
 */
export class UnknownCapabilityError extends Error {
  readonly kind = 'unknown-capability' as const;
  constructor(
    readonly offendingValue: unknown,
    readonly context: string = 'capability compile',
  ) {
    super(
      `${context}: value ${JSON.stringify(offendingValue)} is not a known CapabilityFlag`,
    );
    this.name = 'UnknownCapabilityError';
  }
}
