/**
 * Domain-side port for the host-side runtime executor.
 *
 * `AgentRuntime` (in `src/runtime/agent-runtime.ts`) is the kernel-side
 * orchestrator that wraps a `RuntimeDriver`, fans out lifecycle
 * observers, applies trait decorators, and emits `TerminalEvidence`.
 * Compute nodes in `src/core/` (the dispatch substrate) consume that
 * orchestrator's `execute()` method but should not depend on its
 * concrete class — value-importing it leaks the runtime adapter layer
 * (and, transitively via `AgentRuntime`'s default-driver constructor,
 * the Codex provider) into the domain layer.
 *
 * This port captures the single method compute nodes actually call.
 * Domain code imports it as `import type` and treats `AgentRuntime` as
 * an opaque conformer; `AgentRuntime` itself declares
 * `implements AgentRuntimePort` to keep the surface checked at compile
 * time.
 *
 * Layering: type-only references to `DispatchPlan` and `Plana` mirror
 * the pre-existing `RuntimeDriver` port pattern (see runtime-driver.ts
 * "Note (layering)") — contracts/ stays free of value-imports from
 * core/, but type erasure makes the type reference safe.
 */

import type {
  LifecycleAuthorityAuditSink,
  LifecycleObserverInput,
} from './dispatch-lifecycle.js';
import type { RuntimeCancellationBoundary } from './runtime-driver.js';
import type { TerminalEvidence } from './terminal-evidence.js';
import type { DispatchPlan } from '../core/task.js';
import type { Plana } from '../core/plana.js';

export interface AgentRuntimePort {
  execute(
    plan: DispatchPlan,
    plana: Plana,
    cancellationBoundary: RuntimeCancellationBoundary,
    observer?: LifecycleObserverInput | readonly LifecycleObserverInput[],
    authorityAudit?: LifecycleAuthorityAuditSink,
  ): Promise<TerminalEvidence>;
}
