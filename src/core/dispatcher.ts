import type {
  LifecycleObserver,
  LifecyclePhaseObservation,
} from '../contracts/dispatch-lifecycle.js';
import type { DispatchSubmission } from '../contracts/dispatch-submission.js';
import {
  assertTaskId,
  generateTaskId,
  isValidTaskId,
  type TaskId,
} from '../contracts/task-id.js';
import { createVetoPath, type VetoPath } from '../contracts/veto.js';
import {
  createAbortEvidenceFromVeto,
  type TerminalEvidence,
} from '../contracts/terminal-evidence.js';
import type { TerminalCauseRuntimeVeto } from '../contracts/terminal-cause.js';
import {
  type RuntimeCancellationBoundary,
  type RuntimeCancellationReceipt,
  type RuntimeTerminalCause,
} from '../contracts/runtime-driver.js';
import { AdmissionGate } from './admission-gate.js';
import { AdmissionDeniedError } from './admission-denied-error.js';
import { isComputeNode, type ComputeNode } from './compute-node.js';
import { createDefaultComputeNode } from './compute-node-factory.js';
// The dispatcher is the single locus where the host-side runtime
// orchestrator is materialized when the caller did not provide a
// pre-built `ComputeNode`. Domain-layer compute nodes have been pulled
// off `AgentRuntime` and now depend only on the `AgentRuntimePort`
// contract; the value-import below is the one place in `src/core/`
// where the runtime/ adapter layer is still touched, and it is
// confined to the parameterless-construction fallback that the WU-P
// Stage B test contract continues to pin.
import { AgentRuntime } from '../runtime/agent-runtime.js';
import type { Plana } from './plana.js';
import {
  type RateLease,
  type RateThrottlePort,
  type RuntimeProvider,
} from './rate-throttle.js';
import {
  createRateThrottleAdmissionRule,
  RATE_THROTTLE_QUOTA_AVAILABLE_KEY,
} from './rate-throttle-rule.js';
import type { DispatchPlan } from './task.js';

export interface CancellationReceipt {
  taskId: string;
  reason: string;
  provenance: string;
  requestedAt: string;
  /**
   * R3 (F4): `'superseded'` is returned when an earlier terminal cause
   * (typically a runtime-veto) was already latched; the external cancel
   * is recorded but did not win the latch. `winningCauseKind` carries
   * the kind of the cause that did win, for audit-log truthfulness.
   */
  status: 'accepted' | 'not-active' | 'superseded';
  winningCauseKind?: RuntimeTerminalCause['kind'];
}

export class DuplicateSubmissionError extends Error {
  readonly name = 'DuplicateSubmissionError';

  constructor(readonly taskId: string) {
    super(
      `task ${taskId} has already been submitted; runtime sessions are single-use`,
    );
  }
}

/**
 * R2 (F14): defensive charset gate on caller-supplied `plan.taskId` strings
 * routed through the legacy non-UUIDv7 admission branch. Rejects ids
 * containing newline/null/control bytes or shell metacharacters that would
 * otherwise reach downstream consumers (logs, SLURM job names, GitLab
 * issue titles) unsanitized. The legacy branch itself remains in place
 * pending the WU-M-INT-2 fixture migration; this gate buys safety until
 * the full retirement lands.
 */
export class InvalidLegacyTaskIdError extends Error {
  readonly name = 'InvalidLegacyTaskIdError';

  constructor(readonly taskId: string) {
    super(
      `task ${JSON.stringify(taskId)} contains characters not permitted in a legacy TaskId; UUIDv7 callers are unaffected`,
    );
  }
}

/**
 * R2 / F14 charset gate. Allowed: alphanumerics, hyphen, underscore,
 * period — covers UUIDv7, all current legacy fixture taskIds, and
 * matches the safe subset that downstream consumers can interpolate
 * without escape. Length capped at 128 chars to keep log lines bounded.
 */
const LEGACY_TASK_ID_PATTERN = /^[A-Za-z0-9_\-.]{1,128}$/;

class SubmissionCancellationState {
  private terminalCause: RuntimeTerminalCause | undefined;
  private externalCancellationOpen = true;
  private readonly terminalCauseAwaiters = new Set<
    (cause: RuntimeTerminalCause) => void
  >();

  constructor(private readonly taskId: string) {}

  cancelExternal(
    reason: string,
    provenance: string,
  ): CancellationReceipt | undefined {
    if (!this.externalCancellationOpen) {
      return undefined;
    }

    // R3 (F4): if a terminal cause is already latched, the external
    // cancel is superseded — record that truthfully rather than
    // returning a misleading `'accepted'` receipt.
    if (this.terminalCause !== undefined) {
      return {
        taskId: this.taskId,
        reason,
        provenance,
        requestedAt: new Date().toISOString(),
        status: 'superseded',
        winningCauseKind: this.terminalCause.kind,
      };
    }

    const receipt: CancellationReceipt = {
      taskId: this.taskId,
      reason,
      provenance,
      requestedAt: new Date().toISOString(),
      status: 'accepted',
    };

    this.latchFirstTerminalCause({
      kind: 'external-cancel',
      taskId: receipt.taskId,
      reason: receipt.reason,
      provenance: receipt.provenance,
      requestedAt: receipt.requestedAt,
    });

    return receipt;
  }

  cancelRuntimeVeto(veto: VetoPath): RuntimeCancellationReceipt {
    const receipt = {
      taskId: this.taskId,
      reason: veto.reason,
      provenance: 'dispatcher-runtime-veto',
      requestedAt: new Date().toISOString(),
    };

    this.latchFirstTerminalCause({
      kind: 'runtime-veto',
      taskId: this.taskId,
      reason: veto.reason,
      provenance: veto.provenance,
      requestedAt: receipt.requestedAt,
      veto,
      cancellation: receipt,
    });

    return receipt;
  }

  latchRuntimeVeto(veto: VetoPath): RuntimeTerminalCause {
    this.latchFirstTerminalCause({
      kind: 'runtime-veto',
      taskId: this.taskId,
      reason: veto.reason,
      provenance: veto.provenance,
      requestedAt: new Date().toISOString(),
      veto,
    });

    return this.currentTerminalCause()!;
  }

  currentTerminalCause(): RuntimeTerminalCause | undefined {
    if (!this.terminalCause) {
      return undefined;
    }

    return cloneTerminalCause(this.terminalCause);
  }

  whenTerminalCause(): Promise<RuntimeTerminalCause> {
    if (this.terminalCause) {
      return Promise.resolve(cloneTerminalCause(this.terminalCause));
    }

    return new Promise<RuntimeTerminalCause>((resolve) => {
      this.terminalCauseAwaiters.add(resolve);
    });
  }

  closeExternalCancellation(): void {
    this.externalCancellationOpen = false;
    // R3 (N1): clear any pending `whenTerminalCause()` awaiters that
    // would otherwise leak when a dispatch settles without a latched
    // terminal cause (e.g., success path). They cannot still fire
    // meaningfully once the cancellation surface is closed.
    if (this.terminalCause === undefined) {
      this.terminalCauseAwaiters.clear();
    }
  }

  private latchFirstTerminalCause(cause: RuntimeTerminalCause): void {
    if (this.terminalCause) {
      return;
    }

    this.terminalCause = cause;
    const latchedCause = cloneTerminalCause(cause);
    for (const awaitTerminalCause of this.terminalCauseAwaiters) {
      awaitTerminalCause(cloneTerminalCause(latchedCause));
    }
    this.terminalCauseAwaiters.clear();
  }
}

function cloneTerminalCause(cause: RuntimeTerminalCause): RuntimeTerminalCause {
  if (cause.kind === 'external-cancel') {
    return { ...cause };
  }

  return {
    ...cause,
    veto: {
      ...cause.veto,
      propagation: { ...cause.veto.propagation },
    },
    cancellation: cause.cancellation ? { ...cause.cancellation } : undefined,
  };
}

export interface DispatchSubmitOptions {
  lifecycleObserver?: LifecycleObserver;
}

/**
 * Optional construction-time hooks. Currently the only hook is a test seam
 * for WU-M BC-4 verification (`taskIdGenerator`). Production code MUST omit
 * this entirely so that `Dispatcher.submit()` is the unique invoker of
 * `generateTaskId()` (BC-4 single-issuer principle at the actual code seam).
 */
export interface DispatcherOptions {
  /**
   * Test-only override for the task-id generator. When omitted (the
   * production default), `Dispatcher.submit()` calls
   * `generateTaskId()` from `src/contracts/task-id.ts` directly.
   *
   * Exists solely to allow spec tests (`tests/dispatcher-admission-task-id.spec.ts`)
   * to assert BC-4 — exactly one issuance per admission when the caller
   * omits `plan.taskId`.
   */
  readonly taskIdGenerator?: () => TaskId;
  /**
   * WU-L Step D — optional admission gate evaluated at T1
   * (DispatcherEntry) just before ComputeNode allocation/dispatch. When omitted (the
   * production default until rules are wired), the dispatcher behaves
   * identically to its pre-WU-L state — no overhead, no behavior
   * change.
   *
   * On `verdict === 'deny'` the dispatcher latches a runtime veto on
   * the per-submission cancellation state and resolves the submission
   * to an abort `TerminalEvidence` synthesized from the veto, without
   * ever crossing into ComputeNode allocation/dispatch.
   *
   * @see specs/wu-l-admission-rule-evaluator.md §3.5
   * @see specs/wu-l-admission-rule-evaluator.md §4
   */
  readonly admissionGate?: AdmissionGate;
  /**
   * PR5 — optional provider-scoped inflight rate-throttle binding.
   *
   * When supplied, the dispatcher evaluates the `'rate-throttle'`
   * chokepoint (T2_ChokepointCrossing) between the T1 admit fall-through
   * and `node.allocate`, then attempts to reserve a lease against
   * `port`. Both deny and lost-race outcomes synthesize an
   * `admission-denied` lifecycle phase indistinguishable in shape from
   * the T1 short-circuit, except for the `vetoSource: 'admission'` reason
   * (`rate-throttle quota exhausted` or `rate-throttle quota race`). On
   * admit the lease is held for the lifetime of the dispatch and
   * released in the `.finally` cleanup, so accepted/aborted/terminal
   * paths all release exactly once.
   *
   * Omitting this option preserves pre-PR5 behavior bit-for-bit.
   *
   * @see specs/CURRENT/dispatcher-rate-throttle.md
   * @see src/core/rate-throttle.ts
   * @see src/core/rate-throttle-rule.ts
   */
  readonly rateThrottle?: {
    readonly port: RateThrottlePort;
    readonly provider: RuntimeProvider;
  };
}

function describeNotifyError(error: unknown): string {
  if (error instanceof Error) {
    try {
      return typeof error.message === 'string'
        ? error.message
        : String(error.message);
    } catch {
      return 'Error with unreadable message';
    }
  }
  try {
    return `non-Error rejection: ${String(error)}`;
  } catch {
    return '<uninspectable thrown value>';
  }
}

function safeNotify(
  observer: LifecycleObserver | undefined,
  observation: LifecyclePhaseObservation,
): void {
  if (!observer) {
    return;
  }
  try {
    observer(observation);
  } catch (error) {
    // Mirrors agent-runtime's `lifecycle.observer.advisory-throw` upgrade
    // (audit 2026-05-03 / F8): visibility loss is acceptable, silent loss
    // is not. Observer errors at this seam are still advisory by design —
    // they MUST NOT abort dispatch — but they are now logged so operators
    // can spot a misbehaving observer instead of debugging a silent drop.
    try {

      console.warn(
        `dispatcher.observer.advisory-throw ${JSON.stringify({
          phase: observation.phase,
          taskId: observation.taskId,
          error: describeNotifyError(error),
        })}`,
      );
    } catch {
      // Stringification failure must not break dispatch.
    }
  }
}

export class Dispatcher {
  private readonly submittedTaskIds = new Set<string>();
  private readonly submissionCancellations = new Map<string, SubmissionCancellationState>();
  private readonly submissionAllocations = new Map<string, import('./compute-node.js').ComputeAllocation>();
  private readonly node: ComputeNode;
  private readonly taskIdGenerator: () => TaskId;
  private readonly admissionGate: AdmissionGate | undefined;
  /**
   * PR5 — provider-scoped lease pool. Held for the lifetime of the
   * `submit()` completion promise so cancellation, abort, and terminal
   * paths all converge on a single `.finally` release site.
   */
  private readonly rateThrottle:
    | { readonly port: RateThrottlePort; readonly provider: RuntimeProvider }
    | undefined;
  /**
   * PR5 — internal single-rule gate that wraps `createRateThrottleAdmissionRule()`
   * for trace emission consistency. We do NOT register this rule on the
   * caller-supplied `admissionGate` because the rate-throttle stack
   * is dispatcher-internal and would otherwise pollute the main T1 trace
   * with a rule that defers for every non-rate-throttle context.
   */
  private readonly rateThrottleGate: AdmissionGate | undefined;

  constructor(node: ComputeNode, options?: DispatcherOptions);
  constructor();
  constructor(node?: ComputeNode, options?: DispatcherOptions) {
    if (node === undefined) {
      this.node = createDefaultComputeNode({ runtime: new AgentRuntime() });
    } else if (isComputeNode(node)) {
      this.node = node;
    } else {
      throw new TypeError('Dispatcher constructor: argument must be a ComputeNode');
    }
    this.taskIdGenerator = options?.taskIdGenerator ?? generateTaskId;
    this.admissionGate = options?.admissionGate;
    this.rateThrottle = options?.rateThrottle;
    this.rateThrottleGate =
      options?.rateThrottle === undefined
        ? undefined
        : new AdmissionGate({
            stack: {
              layers: [
                {
                  id: 'dispatcher-rate-throttle',
                  rules: [createRateThrottleAdmissionRule()],
                },
              ],
            },
          });
  }

  get submissionCount(): number {
    return this.submittedTaskIds.size;
  }

  /**
   * Admit a `DispatchPlan` for execution.
   *
   * `plan.taskId` is OPTIONAL. The dispatcher is the sole admission
   * boundary that issues identity (WU-M BC-4 single-issuer):
   *
   *   1. **Omitted** (production default): the dispatcher calls
   *      `generateTaskId()` exactly once and brands the result as
   *      `TaskId`.
   *   2. **Supplied + UUIDv7-shaped** (resume / replay path, BC-5):
   *      the value is brand-validated via `assertTaskId()` and used
   *      verbatim. Re-submitting the same id throws
   *      `DuplicateSubmissionError`.
   *   3. **Supplied + non-UUIDv7** (legacy-compat path, see below):
   *      the value passes a defensive charset gate
   *      (`LEGACY_TASK_ID_PATTERN`) — rejecting injection-class chars
   *      with `InvalidLegacyTaskIdError` — and is then trusted as
   *      opaque identity, presented through the branded acceptance via
   *      an unchecked cast. This branch will be retired together with
   *      legacy fixtures in WU-M-INT-2.
   *
   * **Production code SHOULD omit caller-supplied `plan.taskId`.** The
   * non-UUIDv7 legacy-compat branch exists only to keep pre-existing
   * test fixtures green during the WU-M-INT seam introduction; the
   * defensive charset gate on it is F14 mitigation until WU-M-INT-2
   * removes the branch outright.
   */
  submit(
    plan: Omit<DispatchPlan, 'taskId'> & { taskId?: string },
    plana: Plana,
    options?: DispatchSubmitOptions,
  ): DispatchSubmission {
    let resolvedTaskId: TaskId;
    if (plan.taskId === undefined) {
      // BC-4: dispatcher is the single issuer; call exactly once per
      // admission when the caller omits an id.
      resolvedTaskId = this.taskIdGenerator();
    } else if (isValidTaskId(plan.taskId)) {
      // Resume / replay path (BC-5): validate the shape and brand it.
      resolvedTaskId = assertTaskId(plan.taskId);
    } else {
      // WU-M-INT legacy admission — defensive charset gate (F14 / R2)
      // rejects newline/null/control bytes and shell metacharacters
      // before the unchecked brand cast forwards the value to logs,
      // SLURM job names, and GitLab issue titles. The full WU-M-INT-2
      // retirement (which removes this branch entirely) is tracked
      // separately and requires fixture migration.
      if (!LEGACY_TASK_ID_PATTERN.test(plan.taskId)) {
        throw new InvalidLegacyTaskIdError(plan.taskId);
      }
      resolvedTaskId = plan.taskId as TaskId;
    }

    if (this.submittedTaskIds.has(resolvedTaskId)) {
      throw new DuplicateSubmissionError(resolvedTaskId);
    }

    const normalizedPlan: DispatchPlan = { ...plan, taskId: resolvedTaskId };
    this.submittedTaskIds.add(resolvedTaskId);
    const acceptedAt = new Date().toISOString();
    const cancellationState = new SubmissionCancellationState(resolvedTaskId);
    this.submissionCancellations.set(resolvedTaskId, cancellationState);
    const cancellationBoundary: RuntimeCancellationBoundary = {
      cancel: (veto: VetoPath) => cancellationState.cancelRuntimeVeto(veto),
      latchRuntimeVeto: (veto: VetoPath) => cancellationState.latchRuntimeVeto(veto),
      currentTerminalCause: () => cancellationState.currentTerminalCause(),
      whenTerminalCause: () => cancellationState.whenTerminalCause(),
      closeExternalCancellation: () =>
        cancellationState.closeExternalCancellation(),
    };
    safeNotify(options?.lifecycleObserver, {
      phase: 'accepted',
      taskId: resolvedTaskId,
      observedAt: acceptedAt,
    });

    // WU-L Step D — T1 (DispatcherEntry) admission chokepoint. Skipped
    // entirely when no gate was injected so default behavior is
    // identical to pre-WU-L code.
    if (this.admissionGate !== undefined) {
      const decision = this.admissionGate.evaluate({
        taskId: resolvedTaskId,
        trigger: 'T1_DispatcherEntry',
        attempt: 1,
        traits: [],
        metadata: {},
      });
      if (decision.verdict === 'deny') {
        const veto = createVetoPath(
          'runtime',
          decision.reason ?? 'admission denied',
          'admission-gate',
        );
        cancellationState.latchRuntimeVeto(veto);
        const endedAt = new Date().toISOString();
        // WU-L Step F (WU-H Option H1) — surface admission-gate denial as
        // `runtime-veto` with the H1 sub-discriminator `vetoSource:
        // 'admission'` so downstream consumers can distinguish
        // admission-origin vetoes from intra-runtime vetoes without a new
        // peer cause-kind. ST-03 metadata-not-peer-kind alignment.
        const admissionDenyCause: TerminalCauseRuntimeVeto = {
          kind: 'runtime-veto',
          taskId: resolvedTaskId,
          runtimeInstanceId: 'dispatcher-admission-denied',
          observedAt: endedAt,
          provenance: veto.provenance,
          reason: veto.reason,
          veto,
           vetoSource: 'admission',
           // WU-K — T1 admission short-circuit is a preemptive cancel
           // (runtime never observed the cancel; dispatcher blocked
           // submission before ComputeNode allocation/dispatch). `cancelDetail.originPort`
           // is intentionally omitted — the enum does not cover a
           // "pure admission short-circuit" origin.
          cancellation: {
            requestedAt: endedAt,
            cancelMode: 'preemptive',
          },
        };
        const abortEvidence: TerminalEvidence = createAbortEvidenceFromVeto({
          taskId: resolvedTaskId,
          runtimeInstanceId: 'dispatcher-admission-denied',
          veto,
          executionContext: {
            planCreatedAt: normalizedPlan.createdAt,
            runtimeSettings: normalizedPlan.runtimeSettings,
          },
          resourceEnvelope: normalizedPlan.resourceEnvelope,
          startedAt: acceptedAt,
          endedAt,
          artifactLocation: normalizedPlan.artifactLocation,
          cause: admissionDenyCause,
        });
        // R8 (F5): emit `admission-denied` and `terminal` lifecycle
        // phases on the T1 short-circuit so observers see the dispatch
        // settle rather than leaving a silent gap after `accepted`.
        safeNotify(options?.lifecycleObserver, {
          phase: 'admission-denied',
          taskId: resolvedTaskId,
          observedAt: endedAt,
          cause: admissionDenyCause,
        });
        safeNotify(options?.lifecycleObserver, {
          phase: 'terminal',
          taskId: resolvedTaskId,
          observedAt: endedAt,
          cause: admissionDenyCause,
        });
        this.submissionCancellations.delete(resolvedTaskId);
        return {
          acceptance: {
            taskId: resolvedTaskId,
            acceptedAt,
            boundary: 'dispatcher',
          },
          completion: Promise.resolve(abortEvidence),
        };
      }
      // 'admit' (or unreachable 'defer') → fall through to node.allocate/dispatch.
    }

    // PR5 — T2_ChokepointCrossing for the `'rate-throttle'` chokepoint.
    // Skipped entirely when no throttle binding was injected (pre-PR5
    // behavior preserved). On deny or lost-race the admission-denied
    // lifecycle path mirrors the T1 short-circuit above byte-for-byte
    // except for `runtimeInstanceId` and `reason`.
    let rateLease: RateLease | undefined;
    if (this.rateThrottle !== undefined && this.rateThrottleGate !== undefined) {
      const provider = this.rateThrottle.provider;
      // §3.4 PURE contract — the rule reads only metadata, never
      // closure state. ATTACK-3 guard: only the boolean is exposed,
      // never raw inflight count.
      const quotaAvailable = this.rateThrottle.port.isQuotaAvailable(provider);
      const decision = this.rateThrottleGate.evaluate({
        taskId: resolvedTaskId,
        trigger: 'T2_ChokepointCrossing',
        chokepoint: 'rate-throttle',
        attempt: 1,
        traits: [],
        metadata: { [RATE_THROTTLE_QUOTA_AVAILABLE_KEY]: quotaAvailable },
      });
      let denyReason: string | undefined;
      if (decision.verdict === 'deny') {
        denyReason = decision.reason ?? 'rate-throttle quota exhausted';
      } else if (decision.verdict === 'admit') {
        // pre-fetched quota was true — still race-vulnerable, so
        // the decisive call is `reserve()`. If a sibling task drained
        // the last slot between `isQuotaAvailable` and here, treat the
        // race-loss as `admission-denied` with a distinct reason so
        // operators can tell exhaust-vs-race from the abort evidence.
        const lease = this.rateThrottle.port.reserve(provider);
        if (lease === undefined) {
          denyReason = 'rate-throttle quota race';
        } else {
          rateLease = lease;
        }
      } else {
        // 'defer' is unreachable here (single-rule single-layer stack
        // with rule that returns admit/deny/defer; the stack falls
        // through to security-conservative deny). Treat as deny for
        // safety to keep the dispatcher fail-closed.
        denyReason = decision.reason ?? 'rate-throttle defer fall-through';
      }
      if (denyReason !== undefined) {
        const veto = createVetoPath('runtime', denyReason, 'admission-gate');
        cancellationState.latchRuntimeVeto(veto);
        const endedAt = new Date().toISOString();
        const admissionDenyCause: TerminalCauseRuntimeVeto = {
          kind: 'runtime-veto',
          taskId: resolvedTaskId,
          runtimeInstanceId: 'dispatcher-rate-throttle-denied',
          observedAt: endedAt,
          provenance: veto.provenance,
          reason: veto.reason,
          veto,
          vetoSource: 'admission',
          // PR5 — rate-throttle deny is a preemptive cancel: dispatcher
          // refused the dispatch before allocation. `cancelDetail.originPort`
          // omitted — enum has no rate-throttle origin.
          cancellation: {
            requestedAt: endedAt,
            cancelMode: 'preemptive',
          },
        };
        const abortEvidence: TerminalEvidence = createAbortEvidenceFromVeto({
          taskId: resolvedTaskId,
          runtimeInstanceId: 'dispatcher-rate-throttle-denied',
          veto,
          executionContext: {
            planCreatedAt: normalizedPlan.createdAt,
            runtimeSettings: normalizedPlan.runtimeSettings,
          },
          resourceEnvelope: normalizedPlan.resourceEnvelope,
          startedAt: acceptedAt,
          endedAt,
          artifactLocation: normalizedPlan.artifactLocation,
          cause: admissionDenyCause,
        });
        safeNotify(options?.lifecycleObserver, {
          phase: 'admission-denied',
          taskId: resolvedTaskId,
          observedAt: endedAt,
          cause: admissionDenyCause,
        });
        safeNotify(options?.lifecycleObserver, {
          phase: 'terminal',
          taskId: resolvedTaskId,
          observedAt: endedAt,
          cause: admissionDenyCause,
        });
        this.submissionCancellations.delete(resolvedTaskId);
        return {
          acceptance: {
            taskId: resolvedTaskId,
            acceptedAt,
            boundary: 'dispatcher',
          },
          completion: Promise.resolve(abortEvidence),
        };
      }
    }

    const completion = this.node
      .allocate(normalizedPlan)
      .then(async (allocation) => {
        this.submissionAllocations.set(resolvedTaskId, allocation);
        // R7 (F1): close the cancel-during-allocate race. If a cancel
        // arrived between `submit()` return and `allocate()` resolve,
        // forward `node.cancel(allocation, ...)` and short-circuit to
        // an abort `TerminalEvidence` instead of crossing into
        // `dispatch()` — backends that do not poll the cancellation
        // boundary before launching (e.g., SLURM `sbatch`) would
        // otherwise launch the job and ignore the cancel.
        const terminalCause = cancellationState.currentTerminalCause();
        if (terminalCause !== undefined) {
          await this.node
            .cancel(allocation, terminalCause.reason)
            .catch(() => undefined);
          const endedAt = new Date().toISOString();
          if (terminalCause.kind === 'runtime-veto') {
            return createAbortEvidenceFromVeto({
              taskId: resolvedTaskId,
              runtimeInstanceId: 'dispatcher-pre-dispatch-cancel',
              veto: terminalCause.veto,
              executionContext: {
                planCreatedAt: normalizedPlan.createdAt,
                runtimeSettings: normalizedPlan.runtimeSettings,
              },
              resourceEnvelope: normalizedPlan.resourceEnvelope,
              startedAt: acceptedAt,
              endedAt,
              artifactLocation: normalizedPlan.artifactLocation,
              cause: {
                ...terminalCause,
                runtimeInstanceId: 'dispatcher-pre-dispatch-cancel',
                observedAt: endedAt,
              },
            });
          }
          // external-cancel branch: synthesize a runtime-veto wrapping
          // the external-cancel intent so the abort evidence remains
          // shape-compatible with the existing admission-deny paths.
          const externalVeto = createVetoPath(
            'runtime',
            terminalCause.reason,
            terminalCause.provenance,
          );
          const externalCause: TerminalCauseRuntimeVeto = {
            kind: 'runtime-veto',
            taskId: resolvedTaskId,
            runtimeInstanceId: 'dispatcher-pre-dispatch-cancel',
            observedAt: endedAt,
            provenance: terminalCause.provenance,
            reason: terminalCause.reason,
            veto: externalVeto,
            cancellation: {
              requestedAt: terminalCause.requestedAt,
              cancelMode: 'preemptive',
            },
          };
          return createAbortEvidenceFromVeto({
            taskId: resolvedTaskId,
            runtimeInstanceId: 'dispatcher-pre-dispatch-cancel',
            veto: externalVeto,
            executionContext: {
              planCreatedAt: normalizedPlan.createdAt,
              runtimeSettings: normalizedPlan.runtimeSettings,
            },
            resourceEnvelope: normalizedPlan.resourceEnvelope,
            startedAt: acceptedAt,
            endedAt,
            artifactLocation: normalizedPlan.artifactLocation,
            cause: externalCause,
          });
        }
        return this.node.dispatch(
          allocation,
          normalizedPlan,
          plana,
          cancellationBoundary,
          options?.lifecycleObserver,
        );
      })
      .catch((error: unknown): TerminalEvidence => {
        // WU-Y — T2-SLURM (and any other ComputeNode surface)
        // `AdmissionDeniedError` materializes here as a
        // `runtime-veto` `TerminalEvidence`, byte-identical in
        // provenance + `vetoSource` to the T1 emit site above and the
        // T2-codex emit site (src/runtime/codex-runtime-adapter.ts ~
        // line 578, WU-X). Centralizing the translation at the
        // dispatcher generalizes to ANY backend that throws
        // `AdmissionDeniedError` during ComputeNode allocation/dispatch — they all benefit
        // transparently across all compute nodes.
        // Non-Admission errors are re-thrown unchanged so completion
        // rejects in the historical way (regression-guarded by
        // `tests/wu-y-slurm-admission-veto.spec.ts` WU-Y.d).
        if (!(error instanceof AdmissionDeniedError)) {
          throw error;
        }
        const reason =
          error.decision.reason ??
          `Denied by rule '${error.decision.ruleId}'`;
        const veto = createVetoPath('runtime', reason, 'admission-gate');
        cancellationState.latchRuntimeVeto(veto);
        const endedAt = new Date().toISOString();
        const admissionDenyCause: TerminalCauseRuntimeVeto = {
          kind: 'runtime-veto',
          taskId: resolvedTaskId,
          runtimeInstanceId: 'compute-node-admission-denied',
          observedAt: endedAt,
          provenance: veto.provenance,
          reason: veto.reason,
          veto,
          vetoSource: 'admission',
          // WU-K — T2-SLURM AdmissionDeniedError flip (admission
          // evaluated AFTER chokepoint crossing). Classified as
          // `degraded`: the runtime/backend threw mid-flight, so we
          // cannot assert cooperative unwind nor a clean preemptive
          // preempt. `cancelDetail.originPort` omitted — enum does
          // not cover post-crossing admission-flip origin.
          cancellation: {
            requestedAt: endedAt,
            cancelMode: 'degraded',
          },
        };
        // R8 (F6): post-allocate `AdmissionDeniedError` flip — emit
        // `admission-denied` and `terminal` lifecycle phases so
        // observers see the dispatch settle. Symmetric with the T1
        // short-circuit emit site above.
        safeNotify(options?.lifecycleObserver, {
          phase: 'admission-denied',
          taskId: resolvedTaskId,
          observedAt: endedAt,
          cause: admissionDenyCause,
        });
        safeNotify(options?.lifecycleObserver, {
          phase: 'terminal',
          taskId: resolvedTaskId,
          observedAt: endedAt,
          cause: admissionDenyCause,
        });
        return createAbortEvidenceFromVeto({
          taskId: resolvedTaskId,
          runtimeInstanceId: 'compute-node-admission-denied',
          veto,
          executionContext: {
            planCreatedAt: normalizedPlan.createdAt,
            runtimeSettings: normalizedPlan.runtimeSettings,
          },
          resourceEnvelope: normalizedPlan.resourceEnvelope,
          startedAt: acceptedAt,
          endedAt,
          artifactLocation: normalizedPlan.artifactLocation,
          cause: admissionDenyCause,
        });
      })
      .finally(() => {
        // PR5 — release the rate-throttle lease exactly once on
        // every terminal path (success / cancel / abort) so the
        // counter cannot leak. `release()` is idempotent against
        // double-release per `RateThrottlePort` contract, but we
        // null the local reference defensively as belt-and-braces.
        if (rateLease !== undefined && this.rateThrottle !== undefined) {
          this.rateThrottle.port.release(rateLease);
          rateLease = undefined;
        }
        this.submissionCancellations.delete(resolvedTaskId);
        this.submissionAllocations.delete(resolvedTaskId);
      });

    return {
      acceptance: {
        taskId: resolvedTaskId,
        acceptedAt,
        boundary: 'dispatcher',
      },
      completion,
    };
  }

  cancel(
    taskId: string,
    reason: string,
    provenance = 'dispatcher',
  ): CancellationReceipt {
    const receipt = this.submissionCancellations
      .get(taskId)
      ?.cancelExternal(reason, provenance);
    const allocation = this.submissionAllocations.get(taskId);
    // R3 (F4): forward to backend cancel for both `accepted` (we
    // latched the cause here) and `superseded` (a prior cause won the
    // latch but the backend may not yet have observed any cancel
    // signal). Idempotency is the backend's responsibility per
    // ComputeNode contract.
    if (
      receipt !== undefined &&
      receipt.status !== 'not-active' &&
      allocation !== undefined
    ) {
      void this.node.cancel(allocation, reason).catch(() => undefined);
    }

    return (
      receipt ?? {
        taskId,
        reason,
        provenance,
        requestedAt: new Date().toISOString(),
        status: 'not-active',
      }
    );
  }
}
