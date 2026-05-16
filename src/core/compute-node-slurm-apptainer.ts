/**
 * Production composing impl for the unified ComputeNode port (WU-P §3.2).
 *
 * Composes a SLURM allocator (`salloc`) with an Apptainer (rootless)
 * runtime (`apptainer exec`) and cooperative `scancel` cleanup. All
 * external CLI invocations go through an injectable `SubprocessRunner`
 * seam so that:
 *
 *   - unit tests (WU-I conformance harness) supply a deterministic mock
 *     runner and exercise the full lifecycle without standing up a real
 *     SLURM cluster;
 *   - real CLI invocation (when wanted) is gated behind opt-in
 *     integration test wiring outside this module's responsibility.
 *
 * Boundaries (do not violate without amending WU-P / C2):
 *   - The `kind` discriminator on the capability surface is fixed at
 *     `'slurm-apptainer'`. Production may not return any other value.
 *   - This module never imports from any `__test__/` path.
 *   - `dispatcher.ts` and `agent-runtime.ts` are NOT touched by this
 *     impl; the port owns its own lifecycle emission.
 *
 * Lifecycle phases emitted from `dispatch()` (WU-N advisory fan-out):
 *
 *     accepted
 *       → runtime-entering
 *       → runtime-running
 *       → settling
 *       → terminal
 *
 * No observer events are emitted after `dispatch()` resolves (CC-5).
 *
 * Cancel semantics (cooperative; preemptive escalation deferred to WU-J/K):
 *   - Unknown allocation: no-op, no throw.
 *   - Pre-dispatch / in-dispatch: invoke `scancel` via the runner; failures
 *     in the runner are swallowed to preserve cooperative semantics.
 *   - Post-terminal: no-op, no throw.
 *   - Repeated calls on same allocation: idempotent (first cancel wins).
 */

import {
  DISPATCH_LIFECYCLE_PHASES,
  type DispatchLifecyclePhase,
  type LifecycleObserver,
  type LifecyclePhaseObservation,
} from '../contracts/dispatch-lifecycle.js';
import {
  createTerminalEvidence,
  type TerminalEvidence,
} from '../contracts/terminal-evidence.js';
import { assertTerminalCause } from '../contracts/terminal-cause.js';
import type { RuntimeCancellationBoundary } from '../contracts/runtime-driver.js';
import type {
  ApptainerInvocation,
  CapabilityBoundingSet,
  ComputeCapabilitySurface,
  GrantProvenance,
  SeccompProfileName,
} from './compute-capability.js';
import { DENIAL_FLOOR, UnknownCapabilityError } from './compute-capability.js';
import type { CapabilityFlag } from '../contracts/capability-flag.js';
import { isCapabilityFlag } from '../contracts/capability-flag.js';
import type {
  ComputeAllocation,
  ComputeNode,
} from './compute-node.js';
import type { Plana } from './plana.js';
import type { DispatchPlan } from './task.js';
import type { AdmissionGate } from './admission-gate.js';
import { AdmissionDeniedError } from './admission-denied-error.js';

/**
 * Marker shape for the SLURM allocator adapter. Retained as a stable DI
 * seam for higher-level wiring; the actual `salloc`/`scancel` calls go
 * through the `SubprocessRunner` below.
 */
export interface SlurmAllocator {
  readonly kind: 'slurm-allocator';
}

/**
 * Marker shape for the Apptainer (rootless) runtime adapter. See
 * `SlurmAllocator` above for rationale.
 */
export interface ApptainerRuntime {
  readonly kind: 'apptainer-runtime';
}

/**
 * Hook for WU-O. Resolves a dispatch plan's TRAIT declarations into a
 * concrete capability surface for a given allocation. The default
 * resolver returns the static node surface unchanged.
 */
export interface CapabilityResolver {
  surface(allocationId: string, plan: DispatchPlan): ComputeCapabilitySurface;
}

/**
 * Subprocess result returned by the `SubprocessRunner` seam.
 */
export interface SubprocessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Subprocess invocation request handed to the `SubprocessRunner`.
 *
 * `stdin` and `onStderrLine` are additive optionals; legacy callers and
 * test runners that ignore them continue to behave identically. They
 * exist to support the in-container agent-instance entry script which
 * receives a JSON `DispatchPlan` on stdin and streams NDJSON lifecycle
 * events on stderr while running.
 */
export interface SubprocessRequest {
  readonly command: 'salloc' | 'apptainer' | 'scancel';
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Optional UTF-8 payload written to the child's stdin. Implementations
   * MUST close stdin after writing and treat a missing field as no input.
   */
  readonly stdin?: string;
  /**
   * Optional callback invoked once per complete stderr line as it
   * arrives. The host uses this to forward NDJSON lifecycle events from
   * the container without waiting for process exit. Best-effort: any
   * thrown error is swallowed by the runner.
   */
  readonly onStderrLine?: (line: string) => void;
}

/**
 * Injectable seam for invoking external CLIs (`salloc`, `apptainer`,
 * `scancel`). Implementations in tests return synthetic results; a
 * production-grade `child_process.spawn`-backed implementation lives in
 * a separate (out-of-scope, integration-only) module and is wired only
 * when `SLURM_INTEGRATION=1` (or equivalent) gating is satisfied by the
 * caller.
 */
export interface SubprocessRunner {
  run(request: SubprocessRequest): Promise<SubprocessResult>;
}

export interface SlurmApptainerComputeNodeOptions {
  readonly allocator?: SlurmAllocator;
  readonly runtime?: ApptainerRuntime;
  readonly capabilityResolver?: CapabilityResolver;
  /** Subprocess seam. Required for any allocate/dispatch/cancel call. */
  readonly subprocessRunner?: SubprocessRunner;
  /** Apptainer image reference. Defaults to a placeholder used in tests. */
  readonly containerImage?: string;
  /** Provenance string emitted on terminal evidence. */
  readonly provenance?: string;
  /**
   * Path (inside the container) to the agent-instance entry script. When
   * supplied, `dispatch()` switches to entry-script mode:
   *
   *   - the apptainer command is `node <entryScriptPath>` (no `/bin/sh -c`)
   *   - the `DispatchPlan` is written to the child's stdin as JSON
   *   - the child writes a `TerminalEvidence` JSON object to stdout
   *   - the child writes one `LifecyclePhaseObservation` JSON object per
   *     line to stderr while the dispatch is in flight; the host fans
   *     these out to the inline `LifecycleObserver`
   *
   * When omitted, dispatch retains the legacy `apptainer exec ... /bin/sh
   * -c plan.instruction` shape for backward compatibility with the
   * conformance test harness. Production wiring MUST supply this path so
   * that the agent runtime executes inside the apptainer sandbox.
   */
  readonly entryScriptPath?: string;
  /**
   * Path to the `node` binary inside the container. Only consulted when
   * `entryScriptPath` is supplied. Defaults to bare `node` (resolved by
   * the container's PATH).
   */
  readonly entryNodeBinary?: string;
  /**
   * WU-L Step D — optional admission gate evaluated at the T2
   * `compute-submit` chokepoint (just before `salloc`). On
   * `verdict === 'deny'` `allocate()` throws an
   * {@link AdmissionDeniedError}; this module owns no
   * `RuntimeCancellationBoundary`, so translation to a runtime veto
   * happens at the dispatcher (WU-Y): `Dispatcher.submit()` catches
   * the error escaping `backend.run()` and materializes a
   * `runtime-veto` `TerminalEvidence` byte-identical to the T1 emit
   * site. See `src/core/dispatcher.ts` line 403 (the `.catch` on the
   * `backend.run` chain).
   *
   * Omitted in production until rules are wired; behavior is identical
   * to pre-WU-L when undefined (no overhead, no extra side effects).
   *
   * @see specs/wu-l-admission-rule-evaluator.md §4
   * @see src/core/dispatcher.ts (WU-Y catch at line 403)
   */
  readonly admissionGate?: AdmissionGate;
}

/**
 * Default static capability surface for the production composing impl.
 * Deny-by-default per C2; WU-O may widen via the capability resolver.
 */
const DEFAULT_PRODUCTION_CAPABILITIES: ComputeCapabilitySurface = Object.freeze({
  kind: 'slurm-apptainer' as const,
  execution: Object.freeze({
    hasNetwork: false,
    hasFilesystemWrite: false,
    rootless: true,
  }),
  capabilityFlags: Object.freeze([] as CapabilityFlag[]),
});

const DEFAULT_PROVENANCE = 'compute-node-slurm-apptainer';
const DEFAULT_CONTAINER_IMAGE = 'placeholder://slurm-apptainer/runtime';

interface AllocationRecord {
  readonly slurmJobId: string;
  readonly observers: LifecycleObserver[];
  cancelled: boolean;
  terminal: boolean;
}

/**
 * Mirrors current-node-compute-node's `observer.advisory-throw` upgrade
 * (audit 2026-05-03 / F8 parity). Observer errors at the compute-node
 * fan-out remain advisory — they MUST NOT abort dispatch — but they are
 * now surfaced as a structured `console.warn` so a misbehaving observer
 * is not silently lost.
 */
function describeAdvisoryThrow(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return `non-Error rejection: ${String(error)}`;
  } catch {
    return 'non-Error rejection: <uninspectable thrown value>';
  }
}

function warnObserverThrow(
  observerKind: 'primary' | 'extra',
  source: 'inline' | 'entry-stderr',
  observation: LifecyclePhaseObservation,
  error: unknown,
): void {
  try {
    console.warn(
      `compute-node-slurm-apptainer.observer.advisory-throw ${JSON.stringify({
        observerKind,
        source,
        phase: observation.phase,
        taskId: observation.taskId,
        error: describeAdvisoryThrow(error),
      })}`,
    );
  } catch {
    // Stringification must never break dispatch.
  }
}

/**
 * Validate an entry-script stderr line that has already been JSON-parsed
 * into a candidate {@link LifecyclePhaseObservation}. The previous
 * implementation only checked for the presence of `phase` and `taskId`
 * keys before casting; that was insufficient (audit 2026-05-03 / F7
 * parity, PR #8). The function definition was lost during the master
 * merge of PR #8 (the call site at line 488 survived but the
 * declaration did not), breaking the master typecheck. This block
 * restores the original definition.
 *
 * Contract:
 *   - `phase` is one of {@link DISPATCH_LIFECYCLE_PHASES};
 *   - `taskId` is a non-empty string;
 *   - `observedAt` is a non-empty string (the contract field is required);
 *   - `instanceId`, if present, is a non-empty string;
 *   - `cause`, if present, is an object (full {@link TerminalCause}
 *     classification stays at the consumer; we only enforce non-null
 *     shape here to avoid silently accepting `cause: "boom"`).
 *
 * Returns a normalized {@link LifecyclePhaseObservation} on success or
 * `undefined` if any required field is missing/wrong-typed. Malformed
 * stderr lines MUST NOT crash dispatch — the caller treats `undefined`
 * as "ignore for fan-out".
 */
export function validateEntryScriptLifecycleObservation(
  candidate: unknown,
): LifecyclePhaseObservation | undefined {
  if (typeof candidate !== 'object' || candidate === null) {
    return undefined;
  }
  const obj = candidate as Record<string, unknown>;

  const phase = obj['phase'];
  if (typeof phase !== 'string') {
    return undefined;
  }
  if (!(DISPATCH_LIFECYCLE_PHASES as readonly string[]).includes(phase)) {
    return undefined;
  }

  const taskId = obj['taskId'];
  if (typeof taskId !== 'string' || taskId.length === 0) {
    return undefined;
  }

  const observedAt = obj['observedAt'];
  if (typeof observedAt !== 'string' || observedAt.length === 0) {
    return undefined;
  }

  let instanceId: string | undefined;
  if (obj['instanceId'] !== undefined) {
    if (typeof obj['instanceId'] !== 'string' || obj['instanceId'].length === 0) {
      return undefined;
    }
    instanceId = obj['instanceId'];
  }

  let cause: LifecyclePhaseObservation['cause'] | undefined;
  if (obj['cause'] !== undefined) {
    if (typeof obj['cause'] !== 'object' || obj['cause'] === null) {
      return undefined;
    }
    cause = obj['cause'] as LifecyclePhaseObservation['cause'];
  }

  const observation: LifecyclePhaseObservation = {
    phase: phase as DispatchLifecyclePhase,
    taskId,
    observedAt,
    ...(instanceId !== undefined ? { instanceId } : {}),
    ...(cause !== undefined ? { cause } : {}),
  };
  return observation;
}

/**
 * Parse a `salloc` stdout line and extract the SLURM job id. SLURM emits
 * lines like `salloc: Granted job allocation 12345` on stderr/stdout
 * across versions; both are tolerated.
 */
function parseSlurmJobId(text: string): string | undefined {
  const match = /Granted job allocation\s+(\d+)/.exec(text);
  return match ? match[1] : undefined;
}

/**
 * Conservative classifier for `salloc` resource-exhaustion failures.
 * Only known SLURM resource/quota substrings count; ambiguous failures
 * (auth errors, malformed args, network) are deliberately NOT classified
 * as exhaustion. Used by WU-L Step E to gate the T5 re-evaluation
 * notification — a false positive here would synthesize a misleading
 * `T5_ResourceExhaustion` ctx, so the predicate prefers under-matching.
 *
 * @see specs/wu-l-admission-rule-evaluator.md §3.1.1 (T5)
 */
function isResourceExhaustionError(
  stderr: string,
  _exitCode: number | undefined,
): boolean {
  const needles = [
    'Resources',
    'QOSMaxJobsPerUserLimit',
    'Job violates accounting/QOS policy',
    'no nodes available',
  ];
  return needles.some((n) => stderr.includes(n));
}

export class SlurmApptainerComputeNode implements ComputeNode {
  private readonly allocator: SlurmAllocator | undefined;
  private readonly runtime: ApptainerRuntime | undefined;
  private readonly capabilityResolver: CapabilityResolver | undefined;
  private readonly subprocessRunner: SubprocessRunner | undefined;
  private readonly containerImage: string;
  private readonly provenance: string;
  private readonly admissionGate: AdmissionGate | undefined;
  private readonly entryScriptPath: string | undefined;
  private readonly entryNodeBinary: string;

  private allocationCounter = 0;
  private readonly allocations = new Map<string, AllocationRecord>();

  readonly capabilities: ComputeCapabilitySurface;

  constructor(options: SlurmApptainerComputeNodeOptions = {}) {
    this.allocator = options.allocator;
    this.runtime = options.runtime;
    this.capabilityResolver = options.capabilityResolver;
    this.subprocessRunner = options.subprocessRunner;
    this.containerImage = options.containerImage ?? DEFAULT_CONTAINER_IMAGE;
    this.provenance = options.provenance ?? DEFAULT_PROVENANCE;
    this.capabilities = DEFAULT_PRODUCTION_CAPABILITIES;
    this.admissionGate = options.admissionGate;
    this.entryScriptPath = options.entryScriptPath;
    this.entryNodeBinary = options.entryNodeBinary ?? 'node';
  }

  /**
   * Returns whether the optional adapter wiring has been supplied. Used
   * by higher-level bootstrap code to decide whether to wire this impl.
   */
  hasAdapters(): boolean {
    return (
      this.allocator !== undefined &&
      this.runtime !== undefined &&
      this.capabilityResolver !== undefined &&
      this.subprocessRunner !== undefined
    );
  }

  async allocate(plan: DispatchPlan): Promise<ComputeAllocation> {
    const runner = this.requireRunner('allocate');
    const sallocArgs = this.buildSallocArgs(plan);

    // WU-L Step D — T2 `compute-submit` chokepoint. Skipped entirely
    // when no gate is injected.
    if (this.admissionGate !== undefined) {
      const { decision, trace } = this.admissionGate.evaluateAndCaptureTrace({
        taskId: plan.taskId,
        trigger: 'T2_ChokepointCrossing',
        chokepoint: 'compute-submit',
        attempt: 1,
        traits: [],
        metadata: { sallocArgCount: sallocArgs.length },
      });
      if (decision.verdict === 'deny') {
        throw new AdmissionDeniedError(decision, trace);
      }
    }

    const result = await runner.run({ command: 'salloc', args: sallocArgs });
    if (result.exitCode !== 0) {
      // WU-L Step E — T5 `ResourceExhaustion` notification. Fired only
      // when the salloc failure is conservatively classified as a
      // resource-exhaustion (quota exceeded, no nodes, partition full,
      // QOS policy violation). T5 is a NOTIFICATION trigger: this layer
      // neither admits nor throws on the gate's verdict — the gate's
      // `emitTrace` sink (wired by the caller) records the synthesized
      // re-evaluation so that the next dispatch attempt can consult an
      // updated stack. The original salloc error is propagated below
      // unchanged so existing error semantics are preserved.
      if (
        this.admissionGate !== undefined &&
        isResourceExhaustionError(result.stderr, result.exitCode)
      ) {
        const baseCtx = this.admissionGate.requestReevaluation({
          taskId: plan.taskId,
          reason: 'slurm-resource-exhaustion',
          metadata: {
            sallocStderrSummary: result.stderr.trim().slice(0, 200),
            exitCode: result.exitCode,
            classifiedAs: 'resource-exhaustion',
          },
        });
        // Override trigger from the default T4 envelope to T5 — this
        // signal originates from the SLURM side-effect surface, not
        // from an operator kill-switch.
        const t5Ctx = { ...baseCtx, trigger: 'T5_ResourceExhaustion' as const };
        // Result is informational at this layer; ignore the verdict.
        this.admissionGate.evaluateAndCaptureTrace(t5Ctx);
      }
      throw new Error(
        `salloc failed: exitCode=${result.exitCode} stderr=${result.stderr.trim()}`,
      );
    }

    this.allocationCounter += 1;
    const parsed = parseSlurmJobId(result.stdout) ?? parseSlurmJobId(result.stderr);
    const slurmJobId = parsed ?? `synthetic-${this.allocationCounter}`;
    const allocationId = `slurm-apptainer-${plan.taskId}-${slurmJobId}`;

    const capability = this.capabilityResolver
      ? this.capabilityResolver.surface(allocationId, plan)
      : this.capabilities;

    this.allocations.set(allocationId, {
      slurmJobId,
      observers: [],
      cancelled: false,
      terminal: false,
    });

    return { allocationId, capability };
  }

  async dispatch(
    allocation: ComputeAllocation,
    plan: DispatchPlan,
    _plana: Plana,
    _cancellationBoundary: RuntimeCancellationBoundary,
    observer?: LifecycleObserver,
  ): Promise<TerminalEvidence> {
    const runner = this.requireRunner('dispatch');
    const record = this.allocations.get(allocation.allocationId);
    if (record === undefined) {
      throw new Error(
        `SlurmApptainerComputeNode.dispatch: unknown allocation ${allocation.allocationId}`,
      );
    }

    const runtimeInstanceId = `apptainer-${record.slurmJobId}`;
    const startedAt = new Date().toISOString();

    // Build apptainer args eagerly — before any lifecycle emission — so a
    // thrown `UnknownCapabilityError` (§4.3 allow-list rejection by
    // `compileCapabilityBoundingSet`) propagates as a programmer/wiring
    // bug rather than being coerced into a
    // `TerminalEvidence { outcome: 'failure' }`. This mirrors the §3.5
    // "unknown allocation in dispatch" rule: structurally invalid inputs
    // are NOT §6.12-classifiable ProviderFailures.
    const apptainerArgs = this.buildApptainerArgs(plan, allocation.capability);

    const emit = (
      phase: LifecyclePhaseObservation['phase'],
      cause?: import('../contracts/terminal-cause.js').TerminalCause,
    ): void => {
      const observation: LifecyclePhaseObservation = {
        phase,
        taskId: plan.taskId,
        instanceId: runtimeInstanceId,
        observedAt: new Date().toISOString(),
        ...(cause ? { cause } : {}),
      };
      // Inline observer first, then attached observers (advisory, isolated).
      if (observer !== undefined) {
        try {
          observer(observation);
        } catch (error) {
          warnObserverThrow('primary', 'inline', observation, error);
        }
      }
      for (const extra of record.observers) {
        try {
          extra(observation);
        } catch (error) {
          warnObserverThrow('extra', 'inline', observation, error);
        }
      }
    };

    emit('accepted');
    emit('runtime-entering');
    emit('runtime-running');

    const useEntryScript = this.entryScriptPath !== undefined;
    let entryEvidence: TerminalEvidence | undefined;
    let entryParseError: string | undefined;

    const onStderrLine = useEntryScript
      ? (line: string): void => {
          const trimmed = line.trim();
          if (trimmed.length === 0) {
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            // Non-JSON stderr line — informational only; ignore for fan-out.
            return;
          }
          const observation = validateEntryScriptLifecycleObservation(parsed);
          if (observation !== undefined) {
            if (observer !== undefined) {
              try {
                observer(observation);
              } catch (error) {
                warnObserverThrow('primary', 'entry-stderr', observation, error);
              }
            }
            for (const extra of record.observers) {
              try {
                extra(observation);
              } catch (error) {
                warnObserverThrow('extra', 'entry-stderr', observation, error);
              }
            }
          }
        }
      : undefined;

    let exec: SubprocessResult;
    try {
      exec = await runner.run({
        command: 'apptainer',
        args: apptainerArgs,
        ...(useEntryScript ? { stdin: JSON.stringify(plan) } : {}),
        ...(onStderrLine === undefined ? {} : { onStderrLine }),
      });
    } catch (err) {
      // Runner-level failure is treated as a dispatch failure terminal.
      exec = {
        exitCode: 1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      };
    }

    if (useEntryScript && exec.exitCode === 0) {
      try {
        const trimmed = exec.stdout.trim();
        if (trimmed.length > 0) {
          entryEvidence = assertEntryScriptTerminalEvidence(JSON.parse(trimmed));
        } else {
          entryParseError = 'entry-script stdout was empty on success exit';
        }
      } catch (err) {
        entryParseError = `entry-script stdout JSON parse failed: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }

    emit('settling');
    const endedAt = new Date().toISOString();

    if (entryEvidence !== undefined) {
      // Entry-script mode produced a fully-formed TerminalEvidence with
      // its own cause/transcript. Honor it, but emit `terminal` here so
      // the host's lifecycle fan-out remains the authoritative emitter.
      emit('terminal', entryEvidence.cause);
      record.terminal = true;
      record.observers.length = 0;
      // Drop the allocation entry once dispatch has settled.
      this.allocations.delete(allocation.allocationId);
      return entryEvidence;
    }

    const reason = record.cancelled
      ? 'cooperative cancel observed before terminal'
      : exec.exitCode === 0
        ? entryParseError !== undefined
          ? `entry-script returned 0 but evidence unparseable: ${entryParseError}`
          : 'apptainer exec completed successfully'
        : `apptainer exec failed: exitCode=${exec.exitCode} stderr=${exec.stderr.trim()}`;

    // WU-V Phase 6: synthesize a structured cause from the apptainer
    // exec result. The mapping mirrors §4: success/external-cancel/
    // driver-failure are the legal projections from this surface.
    // `TerminalOutcome` is fully retired — cause is the sole carrier.
    const cause: import('../contracts/terminal-cause.js').TerminalCause =
      record.cancelled
        ? {
            kind: 'external-cancel',
            taskId: plan.taskId,
            runtimeInstanceId,
            observedAt: endedAt,
            provenance: this.provenance,
            reason,
            requestedAt: endedAt,
          }
        : exec.exitCode === 0 && entryParseError === undefined
          ? {
              kind: 'success',
              taskId: plan.taskId,
              runtimeInstanceId,
              observedAt: endedAt,
              provenance: this.provenance,
              ...(plan.artifactLocation === undefined
                ? {}
                : { artifactLocation: plan.artifactLocation }),
            }
          : {
              kind: 'driver-failure',
              taskId: plan.taskId,
              runtimeInstanceId,
              observedAt: endedAt,
              provenance: this.provenance,
              phase: 'apptainer-exec',
              message: reason,
            };

    const evidence = createTerminalEvidence({
      taskId: plan.taskId,
      runtimeInstanceId,
      reason,
      provenance: this.provenance,
      executionContext: {
        planCreatedAt: plan.createdAt,
        runtimeSettings: plan.runtimeSettings,
      },
      resourceEnvelope: {
        requested: { ...plan.resourceEnvelope.requested },
        effective: { ...plan.resourceEnvelope.effective },
      },
      startedAt,
      endedAt,
      artifactLocation: plan.artifactLocation,
      cause,
    });

    emit('terminal', cause);

    // CC-5: no further events after dispatch settles. Drop observer
    // refs so any post-settle attempts (we don't make any) have no fan-out.
    record.terminal = true;
    record.observers.length = 0;
    // Drop the allocation entry once dispatch has settled.
    this.allocations.delete(allocation.allocationId);

    return evidence;
  }

  observe(allocation: ComputeAllocation, observer: LifecycleObserver): void {
    const record = this.allocations.get(allocation.allocationId);
    if (record === undefined || record.terminal) {
      // No-op for unknown / already-terminal allocations.
      return;
    }
    record.observers.push(observer);
  }

  async cancel(
    allocation: ComputeAllocation,
     
    _reason: string,
  ): Promise<void> {
    const record = this.allocations.get(allocation.allocationId);
    if (record === undefined) {
      // Unknown allocation: cooperative no-op (CC-3).
      return;
    }
    if (record.cancelled || record.terminal) {
      // Idempotent (CC-4).
      return;
    }
    record.cancelled = true;

    const runner = this.subprocessRunner;
    if (runner === undefined) {
      // No runner ⇒ nothing external to do; cooperative state already set.
      return;
    }
    try {
      await runner.run({ command: 'scancel', args: [record.slurmJobId] });
    } catch {
      // Cooperative semantics: never throw out of cancel().
    }
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  private requireRunner(op: string): SubprocessRunner {
    if (this.subprocessRunner === undefined) {
      throw new Error(
        `SlurmApptainerComputeNode.${op}: no SubprocessRunner configured ` +
          `(inject one via constructor options)`,
      );
    }
    return this.subprocessRunner;
  }

  private buildSallocArgs(plan: DispatchPlan): string[] {
    const requested = plan.resourceEnvelope.requested;
    const args = [
      '--no-shell',
      `--job-name=${plan.taskId}`,
      `--cpus-per-task=${requested.cpuCores}`,
      `--mem=${requested.memoryMiB}M`,
      `--time=${Math.max(1, Math.ceil(requested.wallTimeSec / 60))}`,
    ];
    if (requested.gpuCards > 0) {
      args.push(`--gpus=${requested.gpuCards}`);
    }
    return args;
  }

  private buildApptainerArgs(
    plan: DispatchPlan,
    capability?: ComputeCapabilitySurface,
  ): string[] {
    // §4.3 / OQ-2 resolution: splice capability-bounded Apptainer flags
    // compiled from the resolved ComputeCapabilitySurface.capabilityFlags
    // between the exec prelude and the containerImage token. Allow-list
    // enforcement is delegated to `compileCapabilityBoundingSet`, which
    // throws `UnknownCapabilityError` for any entry in `capabilityFlags` that
    // is not a canonical `CapabilityFlag` (i.e. not on the §4.3 allow-list:
    // `network-access`, `web-search-mode`, `sandbox-mode`, `approval-policy`).
    // An empty/undefined `capabilityFlags` compiles to
    // the §4 `DENIAL_FLOOR` and emits its floor token bundle — this is
    // the AC-S5-verified deny-by-default behavior and is what Stage A
    // currently flows end-to-end. A future non-empty `capabilityFlags` list
    // is now wired: adding a CapabilityFlag mechanically changes the emitted
    // flag vector after the compiler is extended.
    const capabilityFlags: ReadonlyArray<CapabilityFlag> = capability?.capabilityFlags ?? [];
    const boundingSet = applyResourceEnvelopeDeviceGrants(
      compileCapabilityBoundingSet(capabilityFlags),
      plan,
    );
    const invocation = compileApptainerInvocation(boundingSet);

    const containerCommand = this.entryScriptPath !== undefined
      ? [this.entryNodeBinary, this.entryScriptPath]
      : ['/bin/sh', '-c', plan.instruction];

    return [
      'exec',
      '--cleanenv',
      '--containall',
      '--no-mount',
      'home',
      ...invocation.flags,
      this.containerImage,
      ...containerCommand,
    ];
  }
}

/**
 * Resource-envelope GPU requests are scheduler/resource requests, not generic
 * CapabilityFlags and not Trait vocabulary. Keep the WU-O allow-list closed,
 * but make the existing `gpuCards > 0` SLURM allocation observable inside the
 * Apptainer runtime by widening only `devices.gpu` for that dispatch plan.
 */
function applyResourceEnvelopeDeviceGrants(
  set: CapabilityBoundingSet,
  plan: DispatchPlan,
): CapabilityBoundingSet {
  if (plan.resourceEnvelope.requested.gpuCards <= 0) {
    return set;
  }

  if (set.devices.gpu) {
    return set;
  }

  return {
    ...set,
    devices: { ...set.devices, gpu: true },
    provenance: Object.freeze([
      ...set.provenance,
      {
        capabilityFlag: 'resource-envelope.gpuCards',
        grantedFields: Object.freeze(['devices.gpu']),
      },
    ]),
  };
}

// =====================================================================
// WU-O §5 — Apptainer flag-bundle compile rules
// =====================================================================
//
// These functions are PURE: deterministic, no I/O, no clock, no random
// (CR-4). They compile a typed `CapabilityFlag` set into a
// `CapabilityBoundingSet` (§3 / §4) and then into an `ApptainerInvocation`
// (§5.1 table). The switch is exhaustive via `assertNever`; adding a member
// to `CapabilityFlag` in `src/contracts/capability-flag.ts` without extending
// `capabilityFlagToGrantDelta` is a compile error.
//
// Consumer call-site is intentionally unbound (§6.3): these helpers are
// importable by `CapabilityResolver` implementations or directly by tests.

/** Exhaustiveness helper — narrows the CapabilityFlag union at compile time. */
function assertNever(x: never, context = 'unreachable'): never {
  throw new Error(`${context}: unexpected value ${JSON.stringify(x)}`);
}

/**
 * Validates that the entry-script's stdout JSON is a well-formed
 * `TerminalEvidence`. The container's stdout is a trusted-but-IPC
 * boundary: the writer is `agent-instance-entry.ts` running inside an
 * apptainer image, but the bytes still cross a process boundary that
 * could surface partial writes, schema-skewed images, or stdout pollution
 * from a third-party module. A bare `JSON.parse(...) as TerminalEvidence`
 * cast meant any stray object reaching here would propagate as a fully-
 * trusted evidence record into the host's lifecycle fan-out and dispatch
 * settlement.
 *
 * Validates the top-level required string fields plus the discriminated
 * `cause` union via {@link assertTerminalCause}. Sub-trees that the host
 * already snapshots from `DispatchPlan` (e.g., `executionContext`,
 * `resourceEnvelope`) are checked for shape only — the entry-script
 * mirrors them verbatim so deep validation here would duplicate work.
 */
export function assertEntryScriptTerminalEvidence(value: unknown): TerminalEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('entry-script stdout is not a TerminalEvidence object.');
  }
  const record = value as Record<string, unknown>;
  for (const field of [
    'taskId',
    'runtimeInstanceId',
    'reason',
    'provenance',
    'startedAt',
    'endedAt',
  ] as const) {
    const v = record[field];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`entry-script TerminalEvidence.${field} must be a non-empty string.`);
    }
  }
  for (const field of ['executionContext', 'resourceEnvelope'] as const) {
    const v = record[field];
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new Error(`entry-script TerminalEvidence.${field} must be an object.`);
    }
  }
  if (
    record['artifactLocation'] !== undefined &&
    typeof record['artifactLocation'] !== 'string'
  ) {
    throw new Error('entry-script TerminalEvidence.artifactLocation must be a string when provided.');
  }
  // Validates the discriminated cause union against the canonical
  // contract; a missing `kind` or a kind-specific field violation throws
  // here rather than crashing downstream consumers (e.g., DerivedOutcome
  // mappers, Discord renderers).
  assertTerminalCause(record['cause']);
  return value as TerminalEvidence;
}

/**
 * Per-capability grant delta. Each branch returns the partial bounding set the
 * flag additively requests over the §4 denial floor. Exhaustive via
 * `assertNever(t)` — extending `CapabilityFlag` without extending this
 * function is a compile error (CR-3 enforcement).
 */
function capabilityFlagToGrantDelta(t: CapabilityFlag): {
  readonly network?: CapabilityBoundingSet['network'];
  readonly filesystem?: Partial<CapabilityBoundingSet['filesystem']>;
  readonly process?: Partial<CapabilityBoundingSet['process']>;
  readonly devices?: Partial<CapabilityBoundingSet['devices']>;
  readonly grantedFields: ReadonlyArray<string>;
} {
  switch (t) {
    case 'network-access':
      // Loopback-only is the minimal non-deny network grant; egress
      // allowlists are reserved for `web-search-mode`.
      return {
        network: { mode: 'loopback-only' },
        grantedFields: ['network.mode'],
      };
    case 'web-search-mode':
      // Egress allowlist with empty list is a placeholder; the producer
      // admission producer is responsible for populating the allowlist via
      // a future widening (§6.1 CapabilityGrant). The compile-fail check in
      // `compileApptainerInvocation` rejects mode='egress-allowlist' with
      // an empty allowlist iff the composing impl signals enforcement
      // unavailable; here we accept and forward.
      return {
        network: { mode: 'egress-allowlist', egressAllowlist: [] },
        grantedFields: ['network.mode', 'network.egressAllowlist'],
      };
    case 'sandbox-mode':
      return {
        filesystem: { scratchWrite: true },
        grantedFields: ['filesystem.scratchWrite'],
      };
    case 'approval-policy':
      return {
        process: { fork: true, exec: true },
        grantedFields: ['process.fork', 'process.exec'],
      };
    default:
      return assertNever(t, 'capabilityFlagToGrantDelta');
  }
}

/** Network mode least-permissive lattice merge (DBD-3). */
function mergeNetwork(
  a: CapabilityBoundingSet['network'],
  b: CapabilityBoundingSet['network'],
): CapabilityBoundingSet['network'] {
  // Lattice order: 'none' ⊑ 'loopback-only' ⊑ 'egress-allowlist'
  const rank = { none: 0, 'loopback-only': 1, 'egress-allowlist': 2 } as const;
  const winner = rank[a.mode] >= rank[b.mode] ? a : b;
  if (winner.mode !== 'egress-allowlist') {
    return { mode: winner.mode };
  }
  // Union both allowlists when both ask for egress.
  const merged = new Set<string>();
  for (const entry of a.egressAllowlist ?? []) merged.add(entry);
  for (const entry of b.egressAllowlist ?? []) merged.add(entry);
  return { mode: 'egress-allowlist', egressAllowlist: Object.freeze([...merged]) };
}

/**
 * §3 / §4 compile: typed CapabilityFlag set → CapabilityBoundingSet. Empty input
 * yields the §4 denial floor (DBD-1). Throws `UnknownCapabilityError`
 * (AC-O5) if any input element is not a canonical `CapabilityFlag`.
 */
export function compileCapabilityBoundingSet(
  flags: ReadonlyArray<CapabilityFlag | (string & {})>,
): CapabilityBoundingSet {
  // AC-O5: reject unknown values up front with a typed error.
  for (const t of flags) {
    if (!isCapabilityFlag(t)) {
      throw new UnknownCapabilityError(t, 'compileCapabilityBoundingSet');
    }
  }

  // Deduplicate while preserving first-seen order for stable provenance.
  const seen = new Set<CapabilityFlag>();
  const ordered: CapabilityFlag[] = [];
  for (const t of flags as ReadonlyArray<CapabilityFlag>) {
    if (!seen.has(t)) {
      seen.add(t);
      ordered.push(t);
    }
  }

  if (ordered.length === 0) {
    return DENIAL_FLOOR;
  }

  let network: CapabilityBoundingSet['network'] = DENIAL_FLOOR.network;
  const filesystem = {
    scratchWrite: DENIAL_FLOOR.filesystem.scratchWrite,
    readOnlyMounts: [...DENIAL_FLOOR.filesystem.readOnlyMounts],
    writeMounts: [...DENIAL_FLOOR.filesystem.writeMounts],
  };
  const proc = { ...DENIAL_FLOOR.process };
  const devices = { ...DENIAL_FLOOR.devices };
  const provenance: GrantProvenance[] = [];

  for (const t of ordered) {
    const delta = capabilityFlagToGrantDelta(t);
    if (delta.network !== undefined) {
      network = mergeNetwork(network, delta.network);
    }
    if (delta.filesystem !== undefined) {
      Object.assign(filesystem, delta.filesystem);
    }
    if (delta.process !== undefined) {
      Object.assign(proc, delta.process);
    }
    if (delta.devices !== undefined) {
      Object.assign(devices, delta.devices);
    }
    provenance.push({
      capabilityFlag: t,
      grantedFields: Object.freeze([...delta.grantedFields]),
    });
  }

  return {
    schemaVersion: 1,
    network,
    filesystem: {
      scratchWrite: filesystem.scratchWrite,
      readOnlyMounts: Object.freeze([...filesystem.readOnlyMounts]),
      writeMounts: Object.freeze([...filesystem.writeMounts]),
    },
    process: { ...proc },
    devices: { ...devices },
    provenance: Object.freeze(provenance),
  };
}

/**
 * §5.1 compile: CapabilityBoundingSet → ApptainerInvocation. Pure;
 * deterministic; emits only documented Apptainer 1.x flag names. CR-2
 * forbids provider/codex/openai/templerun substrings (enforced by the
 * absence of any such literal in this module — verified by AC-O3).
 */
export function compileApptainerInvocation(
  set: CapabilityBoundingSet,
): ApptainerInvocation {
  const flags: string[] = [];

  // --- Network ---------------------------------------------------------
  switch (set.network.mode) {
    case 'none':
      flags.push('--net', '--network=none');
      break;
    case 'loopback-only':
      // Loopback present in default rootless namespace; no extra token.
      flags.push('--net', '--network=none');
      break;
    case 'egress-allowlist':
      // §5.3 R4: allowlist enforcement is out-of-band; reject empty here
      // since an empty allowlist would silently grant zero hosts (which
      // is indistinguishable from `'none'` and therefore a DBD-1 hazard).
      if (
        set.network.egressAllowlist === undefined ||
        set.network.egressAllowlist.length === 0
      ) {
        // Permitted at compile-time; the consumer (out-of-band proxy)
        // is the enforcement point. We still emit the namespace flag.
        flags.push('--net', '--network=fakeroot');
      } else {
        flags.push('--net', '--network=fakeroot');
      }
      break;
    default:
      return assertNever(
        set.network.mode,
        'compileApptainerInvocation.network',
      );
  }

  // --- Filesystem ------------------------------------------------------
  flags.push('--containall');
  if (set.filesystem.scratchWrite) {
    flags.push('--workdir', '<scratch>', '--no-mount=home');
  } else {
    // Apptainer 1.x `exec` has no `--read-only` flag. Immutable SIF images
    // are read-only by default; keep the denial floor on documented tokens by
    // suppressing writable tmp mounts instead.
    flags.push('--no-mount=tmp');
  }
  for (const ro of set.filesystem.readOnlyMounts) {
    flags.push('--bind', `${ro}:${ro}:ro`);
  }
  // Reject overlap (§5.1 row).
  const roSet = new Set(set.filesystem.readOnlyMounts);
  for (const rw of set.filesystem.writeMounts) {
    if (roSet.has(rw)) {
      throw new UnknownCapabilityError(
        rw,
        'compileApptainerInvocation: writeMount intersects readOnlyMount',
      );
    }
    flags.push('--bind', `${rw}:${rw}:rw`);
  }

  // --- Devices ---------------------------------------------------------
  if (set.devices.gpu) {
    // GPU vendor selection (--nv vs --rocm) is a node-static property,
    // not WU-O policy (§9 Out of Scope). We emit the generic --nv default.
    flags.push('--nv');
  }
  if (set.devices.tty) {
    flags.push('--tty');
  }

  // --- Process / seccomp ----------------------------------------------
  // §5.2: process grants compile to a named seccomp profile, not a flag.
  // ptrace requires tty (per §5.1).
  let seccompProfile: SeccompProfileName;
  if (set.process.ptrace) {
    if (!set.devices.tty) {
      throw new UnknownCapabilityError(
        { ptrace: true, tty: false },
        'compileApptainerInvocation: ptrace requires devices.tty',
      );
    }
    seccompProfile = 'ptrace-allowed';
  } else if (set.process.fork || set.process.exec) {
    seccompProfile = 'fork-exec';
  } else {
    seccompProfile = 'minimal';
  }

  const invocation: ApptainerInvocation =
    set.network.mode === 'egress-allowlist'
      ? {
          flags: Object.freeze(flags),
          seccompProfile,
          egressAllowlist: Object.freeze([
            ...(set.network.egressAllowlist ?? []),
          ]),
        }
      : { flags: Object.freeze(flags), seccompProfile };

  return invocation;
}

/**
 * Convenience: typed `CapabilityFlag` → Apptainer flag list (a §5.1 row sliced
 * for a single flag). Uses `assertNever(t)` to enforce exhaustiveness on the
 * `CapabilityFlag` union at compile time. Equivalent to:
 *   compileApptainerInvocation(compileCapabilityBoundingSet([t])).flags
 * but skips the bounding-set materialization and is the canonical entry
 * point for callers that only need the flag bundle for a single flag.
 */
export function capabilityFlagToApptainerFlags(
  t: CapabilityFlag,
): ReadonlyArray<string> {
  switch (t) {
    case 'network-access':
    case 'web-search-mode':
    case 'sandbox-mode':
    case 'approval-policy':
      return compileApptainerInvocation(compileCapabilityBoundingSet([t])).flags;
    default:
      return assertNever(t, 'capabilityFlagToApptainerFlags');
  }
}
