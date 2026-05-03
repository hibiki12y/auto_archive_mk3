import { createVetoPath, type VetoPath } from '../contracts/veto.js';
import type { RuntimeWarningEvidence } from '../contracts/terminal-evidence.js';
import type {
  ApprovalHookDecision,
  ApprovalRequestedEvent,
  RuntimeEvent,
} from '../contracts/runtime-event.js';
import type { RuntimeEventStream } from '../contracts/runtime-event-stream.js';
import type { CapabilityFlag } from '../contracts/capability-flag.js';
import type { TraitModuleId } from '../contracts/trait-module.js';
import type {
  MethodologySkillSelection,
} from '../contracts/methodology-skill.js';
import type {
  AgentInstance,
  RuntimeCancellationBoundary,
} from '../contracts/runtime-driver.js';
import {
  createToolLoopDetector,
  type ToolLoopDetector,
} from './tool-loop-detector.js';
import type { DispatchPlan } from './task.js';
import type {
  PlanaAdvisorVerdict,
  PlanaRuntimeAdvisor,
} from './plana-runtime-advisor.js';
import type { PlanaCurator } from './plana-curator.js';

export type ReviewDecision =
  | { status: 'approved' }
  | { status: 'vetoed'; veto: VetoPath };

/**
 * Plana capability/trait-module consumer surface.
 *
 * Earlier development conflated compute capability flags with Auto Archive
 * Traits. The split is now explicit:
 *
 *   - `CapabilityFlag` values (`network-access`, `sandbox-mode`, ...)
 *     describe coarse compute/resource grants.
 *   - `TraitModule` manifests describe repository/workspace submodule plugins
 *     that may contain instructions, scheduler declarations, and runtime hooks.
 *
 * Capability surface handoff to WU-O (per WU-G spec §3.4 — comment is
 * the AC-G3 doc artifact):
 *
 *   | CapabilityFlag value (network-access)      | Implied ComputeCapabilitySurface delta |
 *   |--------------------------------------------|-----------------------------------------|
 *   | requested=false (denied or not requested)  | execution.hasNetwork=false; capabilityFlags ⊇ ['network-access'] (denied) |
 *   | requested=true AND admit                   | execution.hasNetwork=true;  capabilityFlags ⊇ ['network-access']          |
 *   | requested=true AND veto                    | not reached — request never enters dispatch() (pre-side-effect veto) |
 *
 * WU-O reads this table; Plana does NOT mutate `ComputeCapabilitySurface`
 * and does NOT enumerate Apptainer flags. The handoff is one-directional:
 * capability intent → (WU-O) flag bundle.
 */
export interface PlanaGovernanceRequestBase {
  /** Identity of the request the TRAIT is being evaluated against. */
  readonly taskId: string;
  /** Provenance string identifying the call site. */
  readonly provenance: string;
}

/** First concrete capability flag exercised end-to-end (WU-G AC-G2). */
export interface PlanaTraitNetworkAccess extends PlanaGovernanceRequestBase {
  readonly kind: Extract<CapabilityFlag, 'network-access'>;
  /** Does the plan request network reachability? */
  readonly requested: boolean;
  /** `NetworkPolicyProfile.name` the request runs under. */
  readonly profileName: string;
}

/**
 * Repository-owned methodology TraitModule admission request.
 *
 * The selected module/profile may authorize a repository-owned evidence-only
 * runtime decorator, but the module is not a provider switch and is not a
 * compute capability flag.
 */
export interface PlanaTraitMethodologySkill
  extends PlanaGovernanceRequestBase,
    MethodologySkillSelection {
  readonly kind: 'trait-module';
  readonly moduleId: TraitModuleId;
}

/**
 * Discriminated union of governance requests the Plana consumer recognizes.
 * Other `CapabilityFlag` members (`sandbox-mode`, `approval-policy`,
 * `web-search-mode`) are reserved at the capability level but their concrete
 * consumer rules belong to a follow-up slice.
 */
export type PlanaTrait = PlanaTraitNetworkAccess | PlanaTraitMethodologySkill;

/**
 * Result of consuming a TRAIT. Reuses Plana's existing `ReviewDecision`
 * shape so consumer code is uniform with `reviewPreDispatch` /
 * `reviewRuntime`.
 */
export type PlanaBehavior = ReviewDecision;

/**
 * Hook signature for TRAIT admission. Returns a `VetoPath` to deny the
 * TRAIT, or `undefined` to admit. The hook is the injection point the
 * WU-G test scaffolding (per spec §5.1 / AC-G2) uses to supply the
 * `profileName → allowed?` policy lookup; production wiring of that
 * lookup is downstream (WU-S).
 */
export type PlanaTraitHook = (trait: PlanaTrait) => VetoPath | undefined;

export interface RuntimeReviewContext {
  plan: DispatchPlan;
  instance: AgentInstance;
  event: RuntimeEvent;
}

export interface RuntimeStreamReviewContext extends RuntimeReviewContext {
  cancellationBoundary: RuntimeCancellationBoundary;
}

export interface RuntimeSettingsReviewContext {
  plan: DispatchPlan;
  instance: AgentInstance;
}

export interface ApprovalReviewContext {
  readonly plan: DispatchPlan;
  readonly instance: AgentInstance;
  readonly event: ApprovalRequestedEvent;
}

export interface ApprovalResponsePort {
  respond(
    approvalRequestId: string,
    decision: ApprovalHookDecision,
    responseMeta?: {
      readonly respondedAt?: string;
      readonly provenance: 'plana-approval';
    },
  ): Promise<void>;
}

export interface RuntimeStreamContext {
  readonly plan: DispatchPlan;
  readonly instance: AgentInstance;
  readonly cancellationBoundary: RuntimeCancellationBoundary;
  readonly approvalResponsePort: ApprovalResponsePort;
  readonly defaultApprovalTimeoutMs?: number;
  readonly onRuntimeWarning?: (warning: RuntimeWarningEvidence) => void;
  readonly signal?: AbortSignal;
}

export interface PlanaStreamTerminalReport {
  readonly terminalCause: 'stream-closed' | 'signal-aborted' | 'consumer-threw';
  readonly eventsConsumed: number;
  readonly vetoesEmitted: number;
}

type Awaitable<T> = T | Promise<T>;

export interface PlanaPolicyHooks {
  preDispatch?: (plan: DispatchPlan) => VetoPath | undefined;
  runtime?: (context: RuntimeStreamReviewContext) => Awaitable<VetoPath | undefined>;
  runtimeSettings?: (
    context: RuntimeSettingsReviewContext,
  ) => VetoPath | undefined;
  approval?: (
    ctx: ApprovalReviewContext,
  ) => Awaitable<ApprovalHookDecision>;
  toolLoopDetector?: ToolLoopDetector | false;
  /** WU-G — TRAIT admission hook (see `PlanaTraitHook`). */
  trait?: PlanaTraitHook;
  /**
   * Cross-vendor runtime advisor (see
   * `specs/CLARIFICATIONS/multi-provider-scope.md` §Advisor 패턴). When
   * present, Plana consults the advisor on sampled runtime events. A `'veto'`
   * verdict from the advisor is lifted into a `runtime` VetoPath using the
   * advisor's own provenance. Advisor failures are not surfaced — the
   * advisor must self-fail-open per the port contract.
   */
  runtimeAdvisor?: PlanaRuntimeAdvisor;
  /**
   * M2 — Trait curator (Hermes-derived). When present, the methodology
   * trait runtime decorator resolver consults the curator after admission
   * to record `keep | consolidate | prune` decisions. Decisions are
   * observation-only in this PR (default rubric set is empty); the surface
   * is established here so M5b/M5c plugin hooks can register richer rubrics.
   *
   * @see src/core/plana-curator.ts
   */
  curator?: PlanaCurator;
}

const APPROVED_REVIEW: ReviewDecision = { status: 'approved' };
const PLANA_RUNTIME_REVIEW_PROVENANCE = 'plana-runtime-review';
const APPROVED_APPROVAL: ApprovalHookDecision = { status: 'approved' };
const TOOL_LOOP_PROVENANCE = 'plana-tool-loop-detector';

export class Plana {
  private readonly toolLoopDetector: ToolLoopDetector | undefined;

  constructor(private readonly policyHooks: PlanaPolicyHooks = {}) {
    this.toolLoopDetector =
      policyHooks.toolLoopDetector === false
        ? undefined
        : policyHooks.toolLoopDetector ?? createToolLoopDetector();
  }

  /**
   * M2 — Curator accessor. Returns the configured PlanaCurator, or
   * undefined when none is wired. Consumers (e.g.,
   * methodology-trait-runtime-decorator-resolver) call this after a
   * successful admission to record curator decisions.
   */
  getCurator(): PlanaCurator | undefined {
    return this.policyHooks.curator;
  }

  reviewPreDispatch(plan: DispatchPlan): ReviewDecision {
    const veto = this.policyHooks.preDispatch?.(plan);
    return veto ? { status: 'vetoed', veto } : APPROVED_REVIEW;
  }

  reviewRuntime(context: RuntimeReviewContext): ReviewDecision {
    const veto = this.policyHooks.runtime?.({
      ...context,
      cancellationBoundary: {
        cancel: (_veto) => ({
          taskId: context.instance.taskId,
          reason: '',
          provenance: 'plana-review-compat',
          requestedAt: new Date().toISOString(),
        }),
      },
    });
    if (veto instanceof Promise) {
      throw new TypeError(
        'Plana.reviewRuntime compatibility shim does not support async runtime hooks.',
      );
    }
    return veto ? { status: 'vetoed', veto } : APPROVED_REVIEW;
  }

  reviewRuntimeSettings(context: RuntimeSettingsReviewContext): ReviewDecision {
    const veto = this.policyHooks.runtimeSettings?.(context);
    return veto ? { status: 'vetoed', veto } : APPROVED_REVIEW;
  }

  hasRuntimeSettingsHook(): boolean {
    return this.policyHooks.runtimeSettings !== undefined;
  }

  async consumeRuntimeStream(
    stream: RuntimeEventStream,
    ctx: RuntimeStreamContext,
  ): Promise<PlanaStreamTerminalReport> {
    let eventsConsumed = 0;
    let vetoesEmitted = 0;

    try {
      if (ctx.signal?.aborted) {
        return {
          terminalCause: 'signal-aborted',
          eventsConsumed,
          vetoesEmitted,
        };
      }

      for await (const event of stream.events) {
        eventsConsumed += 1;

        const toolLoopDecision = this.toolLoopDetector?.observe(event);
        let toolLoopVeto: VetoPath | undefined;
        if (
          toolLoopDecision !== undefined &&
          toolLoopDecision.status !== 'ok'
        ) {
          ctx.onRuntimeWarning?.({
            kind: 'tool-loop',
            status: toolLoopDecision.status,
            reason: toolLoopDecision.reason,
            provenance: TOOL_LOOP_PROVENANCE,
            fingerprint: toolLoopDecision.fingerprint,
            count: toolLoopDecision.count,
            observedAt: event.timestamp,
          });
          if (toolLoopDecision.status === 'veto') {
            toolLoopVeto = vetoRuntime(
              toolLoopDecision.reason,
              TOOL_LOOP_PROVENANCE,
            );
          }
        }

        const hookVeto = await this.policyHooks.runtime?.({
          plan: ctx.plan,
          instance: ctx.instance,
          event,
          cancellationBoundary: ctx.cancellationBoundary,
        });
        let advisorVeto: VetoPath | undefined;
        if (
          this.policyHooks.runtimeAdvisor !== undefined &&
          hookVeto === undefined &&
          toolLoopVeto === undefined
        ) {
          // F7 (R5): per-iteration try/catch around advisor.review() so a
          // throw cannot kill runtime supervision for the rest of the
          // dispatch. Advisor contract says fail-open ('approve'); we
          // honour it here even when the advisor implementation throws.
          try {
            const verdict: PlanaAdvisorVerdict =
              await this.policyHooks.runtimeAdvisor.review({
                plan: ctx.plan,
                instance: ctx.instance,
                event,
              });
            if (verdict.status === 'veto') {
              advisorVeto = createVetoPath(
                'runtime',
                verdict.reason,
                verdict.provenance,
              );
            }
          } catch (advisorError) {
            console.warn(
              JSON.stringify({
                event: 'plana-advisor-throw',
                taskId: ctx.plan.taskId,
                instanceId: ctx.instance.instanceId,
                eventKind: event.kind,
                errorMessage:
                  advisorError instanceof Error
                    ? advisorError.message
                    : String(advisorError),
                errorName:
                  advisorError instanceof Error
                    ? advisorError.name
                    : 'non-error',
              }),
            );
            advisorVeto = undefined;
          }
        }
        const runtimeVeto = hookVeto ?? toolLoopVeto ?? advisorVeto;

        if (runtimeVeto) {
          vetoesEmitted += 1;
          const veto = {
            ...runtimeVeto,
            provenance:
              runtimeVeto.provenance === ''
                ? PLANA_RUNTIME_REVIEW_PROVENANCE
                : runtimeVeto.provenance,
          };
          if (veto.propagation.requestsCancellation) {
            ctx.cancellationBoundary.cancel(veto);
          }
          if (
            veto.propagation.requestsCancellation ||
            veto.propagation.requestsTermination
          ) {
            ctx.cancellationBoundary.latchRuntimeVeto?.(veto);
          }
        }

        if (
          event.kind === 'approval.requested' &&
          runtimeVeto === undefined
        ) {
          // F9 (R5): skip approval respond() when runtime-veto was just
          // latched in the same iteration. Avoids audit-ordering collapse
          // where the approval would fire after a cancellation cause was
          // already in flight.
          const decision =
            (await this.policyHooks.approval?.({
              plan: ctx.plan,
              instance: ctx.instance,
              event,
            })) ?? APPROVED_APPROVAL;
          await ctx.approvalResponsePort.respond(
            event.approvalRequestId,
            decision,
            { provenance: 'plana-approval' },
          );
        }

        if (ctx.signal?.aborted) {
          return {
            terminalCause: 'signal-aborted',
            eventsConsumed,
            vetoesEmitted,
          };
        }
      }

      return {
        terminalCause: ctx.signal?.aborted ? 'signal-aborted' : 'stream-closed',
        eventsConsumed,
        vetoesEmitted,
      };
    } catch (consumerError) {
      // F16 (R5): bind the error and surface it via structured warn log
      // so consumer-threw failures are not invisible in production.
      console.warn(
        JSON.stringify({
          event: 'plana-consumer-threw',
          taskId: ctx.plan.taskId,
          instanceId: ctx.instance.instanceId,
          eventsConsumed,
          vetoesEmitted,
          errorMessage:
            consumerError instanceof Error
              ? consumerError.message
              : String(consumerError),
          errorName:
            consumerError instanceof Error
              ? consumerError.name
              : 'non-error',
        }),
      );
      return {
        terminalCause: 'consumer-threw',
        eventsConsumed,
        vetoesEmitted,
      };
    }
  }

  /**
   * WU-G — Evaluate a single TRAIT and return an admit/veto decision.
   *
   * Pure function over the injected `trait` hook. Per-kind default policy
   * applies when no hook is configured (`policyHooks.trait` is undefined):
   *
   *   - `kind: 'network-access'` → default-permissive (`{ status: 'approved' }`).
   *     Preserves the original WU-G AC-G1 default-permissive posture for
   *     coarse compute-capability traits whose host-side gating already runs
   *     through `ComputeCapabilitySurface` (WU-O).
   *   - `kind: 'trait-module'` → default-deny per
   *     `specs/CONTRACTS/microkernel-module-boundary.md` §3 (kernel-owned
   *     trait gating). Operators who want a permissive trait-module posture
   *     must explicitly wire `policyHooks.trait` (e.g., a permissive
   *     `() => undefined` hook for in-container scaffolds where admission
   *     already settled on the host, or a real admission policy on the host
   *     itself).
   *
   * If the hook is configured and returns a `VetoPath`, the result is
   * `{ status: 'vetoed', veto }` — the caller-visible signature mandated by
   * WU-G AC-G1.
   */
  consumeTrait(trait: PlanaTrait): PlanaBehavior {
    const hook = this.policyHooks.trait;
    if (hook !== undefined) {
      const veto = hook(trait);
      return veto ? { status: 'vetoed', veto } : APPROVED_REVIEW;
    }
    if (trait.kind === 'trait-module') {
      return {
        status: 'vetoed',
        veto: vetoTrait(
          `kind:'trait-module' admission requires an operator-configured policyHooks.trait; default-deny per microkernel-module-boundary §3 (kernel-owned trait gating)`,
          'plana-trait-module-default-deny',
        ),
      };
    }
    return APPROVED_REVIEW;
  }
}

export function vetoPreDispatch(
  reason: string,
  provenance = 'plana-pre-dispatch',
): VetoPath {
  return createVetoPath('pre-dispatch', reason, provenance);
}

export function vetoRuntime(
  reason: string,
  provenance = 'plana-runtime-review',
): VetoPath {
  return createVetoPath('runtime', reason, provenance);
}

export function vetoRuntimeSettings(
  reason: string,
  provenance = 'plana-runtime-settings',
): VetoPath {
  return createVetoPath('runtime', reason, provenance);
}

/**
 * WU-G — `VetoPath` constructor for TRAIT admission denials. Defaults
 * to a `pre-dispatch` origin (the side-effect-free admission boundary
 * per `architecture-improvement-review-2026-04-20.md` ST-02 / WU-L)
 * with provenance identifying Plana as the originator (AC-G2).
 */
export function vetoTrait(
  reason: string,
  provenance = 'plana-trait',
): VetoPath {
  return createVetoPath('pre-dispatch', reason, provenance);
}
