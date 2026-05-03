/**
 * M2 — Plana Curator (Hermes-derived)
 *
 * Plana governance has historically focused on per-dispatch admission of a
 * single trait module. As auto_archive_mk3 grows toward a multi-trait future
 * the *curatorial* concern emerges: across an entire population of admitted
 * traits, are some redundant (consolidate), are some stale (prune), or
 * should they be left as-is (keep)?
 *
 * This module establishes the *contract*. Default behavior is identity
 * ("keep" everything) — there is no consolidation or pruning logic in the
 * default rubric set. Future M-items (M5b/M5c plugin hooks) can register
 * richer rubrics; bundled traits and operator-pinned traits are protected
 * from automatic prune/consolidate decisions regardless of rubric output.
 *
 * Hermes anchors:
 *   - resource/hermes-agent/agent/curator.py (1395 LOC) — class-first rubric
 *     + heuristic/model reconciliation pattern (PORT)
 *   - resource/hermes-agent/tools/skill_usage.py STATE_ACTIVE/STATE_STALE/
 *     STATE_ARCHIVED — never delete, archive only.
 *
 * Defensive invariants enforced at curator boundaries:
 *   1. Bundled trait modules (declared via `bundledTraitModuleIds`) cannot
 *      receive `prune` or `consolidate` decisions — the curator reasserts
 *      `keep` and logs the would-be decision as a rubric note.
 *   2. Operator-pinned trait modules (`pinnedTraitModuleIds`) are skipped
 *      entirely — `keep` is returned without consulting any rubric.
 *   3. `prune` is *archive-only* at the contract level — the decision says
 *      "remove from active selection" but evidence preserves the prior
 *      manifest so consumers can restore.
 */
import type { TraitModuleId } from '../contracts/trait-module.js';
import type {
  PlanaTraitMethodologySkill,
} from './plana.js';

export type CuratorDecisionKind = 'keep' | 'consolidate' | 'prune';

export type CuratorEvidenceSource = 'model' | 'audit' | 'hybrid';

export interface CuratorDecision {
  readonly kind: CuratorDecisionKind;
  readonly traitModuleId: TraitModuleId;
  readonly reason: string;
  readonly source: CuratorEvidenceSource;
  readonly observedAt: string;
  readonly rubricId?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
  /** Set when `kind === 'consolidate'` — the source/from trait. */
  readonly from?: TraitModuleId;
  /** Set when `kind === 'consolidate'` — the destination/into trait. */
  readonly into?: TraitModuleId;
  /** Set when the rubric was overridden by a defensive gate. */
  readonly defensiveGate?: 'bundled' | 'pinned';
}

export interface CuratorRubricInput {
  readonly trait: PlanaTraitMethodologySkill;
  readonly observedAt: string;
}

export interface CuratorRubric {
  readonly id: string;
  evaluate(input: CuratorRubricInput): CuratorDecision | null;
}

export interface PlanaCuratorOptions {
  readonly rubrics?: readonly CuratorRubric[];
  readonly clock?: () => Date;
  /**
   * Trait module ids that ship bundled with the kernel. The curator never
   * returns `prune` or `consolidate` for these; rubric output that targets
   * a bundled id is downgraded to `keep` with the evidence preserved on
   * the resulting decision.
   */
  readonly bundledTraitModuleIds?: readonly TraitModuleId[];
  /**
   * Trait module ids the operator has pinned. These are skipped before any
   * rubric runs; the curator returns `keep` immediately.
   */
  readonly pinnedTraitModuleIds?: readonly TraitModuleId[];
}

const DEFAULT_RUBRICS: readonly CuratorRubric[] = [];

export class PlanaCurator {
  private readonly rubrics: readonly CuratorRubric[];
  private readonly clock: () => Date;
  private readonly bundledIds: ReadonlySet<TraitModuleId>;
  private readonly pinnedIds: ReadonlySet<TraitModuleId>;

  constructor(options: PlanaCuratorOptions = {}) {
    this.rubrics = options.rubrics ?? DEFAULT_RUBRICS;
    this.clock = options.clock ?? (() => new Date());
    this.bundledIds = new Set(options.bundledTraitModuleIds ?? []);
    this.pinnedIds = new Set(options.pinnedTraitModuleIds ?? []);
  }

  /**
   * Decide what to do with a single just-admitted trait. The default behavior
   * for any trait that no rubric matches is `keep`.
   */
  admitSkill(trait: PlanaTraitMethodologySkill): CuratorDecision {
    const observedAt = this.clock().toISOString();

    if (this.pinnedIds.has(trait.moduleId)) {
      return {
        kind: 'keep',
        traitModuleId: trait.moduleId,
        reason: 'trait is operator-pinned; auto-curation skipped',
        source: 'audit',
        observedAt,
        defensiveGate: 'pinned',
      };
    }

    for (const rubric of this.rubrics) {
      const decision = rubric.evaluate({ trait, observedAt });
      if (decision === null) continue;
      return this.applyDefensiveGates(decision);
    }

    return {
      kind: 'keep',
      traitModuleId: trait.moduleId,
      reason: 'no rubric matched',
      source: 'audit',
      observedAt,
    };
  }

  /**
   * Inspect metadata-level signals about a trait without admitting it.
   * Returns the decisions that *would* result if the trait were processed
   * by every registered rubric. Used for pre-flight reporting.
   */
  evaluateMetadata(
    trait: PlanaTraitMethodologySkill,
  ): readonly CuratorDecision[] {
    const observedAt = this.clock().toISOString();
    const decisions: CuratorDecision[] = [];
    if (this.pinnedIds.has(trait.moduleId)) {
      decisions.push({
        kind: 'keep',
        traitModuleId: trait.moduleId,
        reason: 'trait is operator-pinned; auto-curation skipped',
        source: 'audit',
        observedAt,
        defensiveGate: 'pinned',
      });
      return decisions;
    }
    for (const rubric of this.rubrics) {
      const decision = rubric.evaluate({ trait, observedAt });
      if (decision === null) continue;
      decisions.push(this.applyDefensiveGates(decision));
    }
    return decisions;
  }

  /**
   * Decide what to do with a population of admitted traits at once. Each
   * trait gets its own decision; the array order matches the input.
   */
  curateSelection(
    traits: readonly PlanaTraitMethodologySkill[],
  ): readonly CuratorDecision[] {
    return traits.map((trait) => this.admitSkill(trait));
  }

  private applyDefensiveGates(decision: CuratorDecision): CuratorDecision {
    if (
      (decision.kind === 'prune' || decision.kind === 'consolidate') &&
      this.bundledIds.has(decision.traitModuleId)
    ) {
      return {
        kind: 'keep',
        traitModuleId: decision.traitModuleId,
        reason: `bundled trait protected from ${decision.kind}; preserving rubric evidence on decision`,
        source: decision.source,
        observedAt: decision.observedAt,
        ...(decision.rubricId === undefined ? {} : { rubricId: decision.rubricId }),
        defensiveGate: 'bundled',
        evidence: {
          ...(decision.evidence ?? {}),
          downgradedFrom: decision.kind,
          originalReason: decision.reason,
        },
      };
    }
    return decision;
  }
}
