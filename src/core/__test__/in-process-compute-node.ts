/**
 * Test-only ComputeNode double. Wraps an `AgentRuntime` and runs the plan
 * synchronously in the current process.
 *
 * MUST NOT be imported from any production module (see WU-P §3.3 / §6 Q3,
 * C2 anti-scope). Production code imports the unified port from
 * `src/core/compute-node.ts` and constructs `SlurmApptainerComputeNode`.
 *
 * Test consumers SHOULD import this double via the
 * `compute-node-test-doubles.ts` barrel rather than by direct file path.
 */

import type { LifecycleObserver } from '../../contracts/dispatch-lifecycle.js';
import type { TerminalEvidence } from '../../contracts/terminal-evidence.js';
import { AgentRuntime } from '../../runtime/agent-runtime.js';
import type { RuntimeCancellationBoundary } from '../../contracts/runtime-driver.js';
import type { ComputeCapabilitySurface } from '../compute-capability.js';
import type { CapabilityFlag } from '../../contracts/capability-flag.js';
import type { ComputeAllocation, ComputeNode } from '../compute-node.js';
import type { Plana } from '../plana.js';
import type { DispatchPlan } from '../task.js';

const TEST_DOUBLE_CAPABILITIES: ComputeCapabilitySurface = Object.freeze({
  kind: 'test-double' as const,
  // In-process execution honestly reflects the host process — we cannot
  // promise containment or filesystem isolation here.
  execution: Object.freeze({
    hasNetwork: true,
    hasFilesystemWrite: true,
    rootless: true,
  }),
  capabilityFlags: Object.freeze([] as CapabilityFlag[]),
});

export interface InProcessComputeNodeOptions {
  readonly runtime?: AgentRuntime;
}

/**
 * Test double: dispatches by invoking the supplied `AgentRuntime`
 * directly. Allocation is synthetic; cancel is a no-op (the runtime's
 * own cancellation boundary handles in-flight cancel during dispatch).
 */
export class InProcessComputeNode implements ComputeNode {
  private readonly runtime: AgentRuntime;
  private allocationCounter = 0;
  // Per-allocation observer registry for `observe()`; advisory only
  // (mirrors the WU-N pending advisory contract on the production port).
  private readonly observers = new Map<string, LifecycleObserver[]>();

  readonly capabilities: ComputeCapabilitySurface = TEST_DOUBLE_CAPABILITIES;

  constructor(runtimeOrOptions: AgentRuntime | InProcessComputeNodeOptions = {}) {
    this.runtime =
      runtimeOrOptions instanceof AgentRuntime
        ? runtimeOrOptions
        : runtimeOrOptions.runtime ?? new AgentRuntime();
  }

  async allocate(plan: DispatchPlan): Promise<ComputeAllocation> {
    this.allocationCounter += 1;
    const allocationId = `in-process-${plan.taskId}-${this.allocationCounter}`;
    return {
      allocationId,
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
                // Lifecycle observer errors are swallowed by design,
                // matching `AgentRuntime.execute` semantics.
              }
            }
            for (const extra of extras) {
              try {
                extra(observation);
              } catch {
                // see above.
              }
            }
          };
    return this.runtime.execute(plan, plana, cancellationBoundary, fanOut);
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
    // Cooperative cancel for in-process double: drop observer state.
    // In-flight cancellation is governed by the cancellation boundary
    // passed to `dispatch()`; nothing further to do here.
    this.observers.delete(allocation.allocationId);
  }
}
