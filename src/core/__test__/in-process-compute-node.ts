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
import type { AgentRuntimePort } from '../../contracts/agent-runtime-port.js';
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
  readonly runtime: AgentRuntimePort;
}

/**
 * Test double: dispatches by invoking the supplied runtime directly.
 * Allocation is synthetic; cancel is a no-op (the runtime's own
 * cancellation boundary handles in-flight cancel during dispatch).
 *
 * Accepts either a positional runtime port or an options bag — the
 * positional form is kept for ergonomics in tests that already wire
 * `new AgentRuntime(driver)` and want to pass it without a wrapper. The
 * runtime is REQUIRED in both forms; the prior `?? new AgentRuntime()`
 * fallback was the test-double's contribution to the layer leak that
 * pulled `CodexRuntimeDriver` into `src/core/` via default-construction.
 */
export class InProcessComputeNode implements ComputeNode {
  private readonly runtime: AgentRuntimePort;
  private allocationCounter = 0;
  // Per-allocation observer registry for `observe()`; advisory only
  // (mirrors the WU-N pending advisory contract on the production port).
  private readonly observers = new Map<string, LifecycleObserver[]>();

  readonly capabilities: ComputeCapabilitySurface = TEST_DOUBLE_CAPABILITIES;

  constructor(runtimeOrOptions: AgentRuntimePort | InProcessComputeNodeOptions) {
    if (isInProcessComputeNodeOptions(runtimeOrOptions)) {
      this.runtime = runtimeOrOptions.runtime;
    } else {
      this.runtime = runtimeOrOptions;
    }
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

    _reason: string,
  ): Promise<void> {
    // Cooperative cancel for in-process double: drop observer state.
    // In-flight cancellation is governed by the cancellation boundary
    // passed to `dispatch()`; nothing further to do here.
    this.observers.delete(allocation.allocationId);
  }
}

// The options bag is the only shape that carries a `runtime` property at
// the top level; the positional form passes the port object directly.
// `execute` is mandatory on a runtime port object, and an options bag
// has no `execute` property — that asymmetry is what lets us discriminate.
function isInProcessComputeNodeOptions(
  value: AgentRuntimePort | InProcessComputeNodeOptions,
): value is InProcessComputeNodeOptions {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { execute?: unknown }).execute !== 'function' &&
    'runtime' in value
  );
}
