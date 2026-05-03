/**
 * Test-only ComputeNode double — alternative test seam co-located with
 * `InProcessComputeNode`. Where `InProcessComputeNode` reuses
 * `AgentRuntime.execute` (preserving exact legacy in-process behavior),
 * `LocalComputeNode` accepts an injectable executor so unit tests can
 * synthesize terminal evidence directly without standing up a runtime.
 *
 * MUST NOT be imported from any production module (WU-P §3.3 / §6 Q3,
 * C2 anti-scope).
 */

import type { LifecycleObserver } from '../../contracts/dispatch-lifecycle.js';
import type { TerminalEvidence } from '../../contracts/terminal-evidence.js';
import type { RuntimeCancellationBoundary } from '../../contracts/runtime-driver.js';
import type { ComputeCapabilitySurface } from '../compute-capability.js';
import type { CapabilityFlag } from '../../contracts/capability-flag.js';
import type { ComputeAllocation, ComputeNode } from '../compute-node.js';
import type { Plana } from '../plana.js';
import type { DispatchPlan } from '../task.js';

const LOCAL_CAPABILITIES: ComputeCapabilitySurface = Object.freeze({
  kind: 'test-double' as const,
  execution: Object.freeze({
    hasNetwork: true,
    hasFilesystemWrite: true,
    rootless: true,
  }),
  capabilityFlags: Object.freeze([] as CapabilityFlag[]),
});

export type LocalComputeExecutor = (
  allocation: ComputeAllocation,
  plan: DispatchPlan,
  plana: Plana,
  cancellationBoundary: RuntimeCancellationBoundary,
  observer?: LifecycleObserver,
) => Promise<TerminalEvidence>;

export interface LocalComputeNodeOptions {
  /** Executor invoked from `dispatch()`. Required. */
  readonly executor: LocalComputeExecutor;
}

/**
 * Test double whose `dispatch()` delegates to an injected executor.
 * Useful for tests that want full control over the produced
 * `TerminalEvidence` without exercising the full `AgentRuntime` stack.
 */
export class LocalComputeNode implements ComputeNode {
  private readonly executor: LocalComputeExecutor;
  private allocationCounter = 0;
  private readonly observers = new Map<string, LifecycleObserver[]>();
  private readonly cancelled = new Set<string>();

  readonly capabilities: ComputeCapabilitySurface = LOCAL_CAPABILITIES;

  constructor(options: LocalComputeNodeOptions) {
    this.executor = options.executor;
  }

  async allocate(plan: DispatchPlan): Promise<ComputeAllocation> {
    this.allocationCounter += 1;
    return {
      allocationId: `local-${plan.taskId}-${this.allocationCounter}`,
      capability: this.capabilities,
    };
  }

  async dispatch(
    allocation: ComputeAllocation,
    plan: DispatchPlan,
    plana: Plana,
    cancellationBoundary: RuntimeCancellationBoundary,
    observer?: LifecycleObserver,
  ): Promise<TerminalEvidence> {
    const extras = this.observers.get(allocation.allocationId) ?? [];
    const fanOut: LifecycleObserver | undefined =
      observer === undefined && extras.length === 0
        ? undefined
        : (observation) => {
            if (observer !== undefined) {
              try {
                observer(observation);
              } catch {
                // swallow per AgentRuntime semantics.
              }
            }
            for (const extra of extras) {
              try {
                extra(observation);
              } catch {
                // swallow per AgentRuntime semantics.
              }
            }
          };
    return this.executor(allocation, plan, plana, cancellationBoundary, fanOut);
  }

  observe(allocation: ComputeAllocation, observer: LifecycleObserver): void {
    const list = this.observers.get(allocation.allocationId) ?? [];
    list.push(observer);
    this.observers.set(allocation.allocationId, list);
  }

  async cancel(
    allocation: ComputeAllocation,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _reason: string,
  ): Promise<void> {
    this.cancelled.add(allocation.allocationId);
    this.observers.delete(allocation.allocationId);
  }

  /** Test introspection: did `cancel()` fire for this allocation? */
  wasCancelled(allocation: ComputeAllocation): boolean {
    return this.cancelled.has(allocation.allocationId);
  }
}
