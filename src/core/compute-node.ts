/**
 * Unified ComputeNode port (WU-P §3.1).
 *
 * Unified compute port after the WU-P Stage C cutover. Production code speaks
 * `ComputeNode` only; test-only implementations remain under `__test__/`.
 *
 * Boundaries (C2 / §6 Q3):
 *   - Production implementations on this branch are
 *     `SlurmApptainerComputeNode`, `GitLabCloneComputeNode`, and
 *     `CurrentNodeComputeNode`.
 *   - Any other implementation (`LocalComputeNode`, `InProcessComputeNode`,
 *     etc.) MUST live under `__test__/` and MUST NOT be imported from a
 *     production module.
 *   - This port MUST NOT mention "provider" or any LLM-discriminator name
 *     (C3 hard reject).
 */

import type { LifecycleObserver } from '../contracts/dispatch-lifecycle.js';
import type { TerminalEvidence } from '../contracts/terminal-evidence.js';
import type { RuntimeCancellationBoundary } from '../contracts/runtime-driver.js';
import type { ComputeCapabilitySurface } from './compute-capability.js';
import type { Plana } from './plana.js';
import type { DispatchPlan } from './task.js';

/**
 * Stable handle identifying a reserved allocation+containment pair.
 *
 * `allocationId` is opaque; the only stability guarantee is that it
 * uniquely identifies the allocation for the lifetime of the owning
 * ComputeNode instance. The `capability` field is a per-allocation snapshot
 * — WU-O may diverge per-allocation surfaces from the node-level
 * `ComputeNode.capabilities` field once TRAIT resolution lands.
 */
export interface ComputeAllocation {
  readonly allocationId: string;
  readonly capability: ComputeCapabilitySurface;
}

/**
 * The unified compute port. Production implementations include the SLURM +
 * Apptainer composing path, the direct git-clone path, and the repo-bounded
 * current-node path; test doubles satisfy the same contract by running
 * in-process.
 */
export interface ComputeNode {
  /**
   * Reserve the resources required to dispatch the given plan. For the
   * production composing impl this is `salloc` + Apptainer prepare; for
   * test doubles this returns a synthetic handle.
   *
   * Splitting allocate / dispatch (rather than collapsing into a single
   * `run`) allows WU-K cancel-mode metadata to distinguish pre-dispatch
   * and in-dispatch cancellation without reshaping the port.
   */
  allocate(plan: DispatchPlan): Promise<ComputeAllocation>;

  /**
   * Run the dispatched plan under a previously reserved allocation. The
   * returned `TerminalEvidence` is the authoritative outcome record.
   */
  dispatch(
    allocation: ComputeAllocation,
    plan: DispatchPlan,
    plana: Plana,
    cancellationBoundary: RuntimeCancellationBoundary,
    observer?: LifecycleObserver,
  ): Promise<TerminalEvidence>;

  /**
   * Attach an additional advisory lifecycle observer to an active
   * allocation. Returns void (advisory) per §6 Q2 / WU-N pending — this
   * MUST NOT be promoted to authoritative until WU-N closes.
   */
  observe(allocation: ComputeAllocation, observer: LifecycleObserver): void;

  /**
   * Cooperative cancel. Preemptive escalation semantics (e.g., scancel)
   * are governed by WU-K cancel-mode metadata and are out of scope for
   * the port shape itself.
   */
  cancel(allocation: ComputeAllocation, reason: string): Promise<void>;

  /**
   * Node-level (static) capability surface. Per WU-P §10.7 the node-level
   * field describes static node properties; per-plan/per-allocation
   * variation lives on `ComputeAllocation.capability`.
   *
   * MUST be readable before `allocate()` is invoked (acceptance §7.4).
   */
  readonly capabilities: ComputeCapabilitySurface;
}

/** Structural type guard for the ComputeNode port. */
export function isComputeNode(value: unknown): value is ComputeNode {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof ComputeNode, unknown>>;
  return (
    typeof candidate.allocate === 'function' &&
    typeof candidate.dispatch === 'function' &&
    typeof candidate.observe === 'function' &&
    typeof candidate.cancel === 'function' &&
    typeof candidate.capabilities === 'object' &&
    candidate.capabilities !== null
  );
}
