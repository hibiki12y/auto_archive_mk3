---
status: ready
level: L4
type: integration
created: 2026-04-29
author: opus-orchestrator
relates_to: "docs/multi-vendor-coordination-research.md"
default: disabled
invocation: manual_only_ultra_high_precision
validated: "2026-04-30 (CRLN self-test + DPO research benchmark; default routing intentionally not promoted)"
---

# Spec: DT Audit Ultra-Team v3.1

## 1. Requirements

### Problem

templestay today ships two proven paths for non-trivial analysis:

- **deep-think** (`claude/templestay/skills/templestay-deep-think/SKILL.md`) —
  bounded independent lenses (Architecture / Verification / Challenge / Research /
  Implementation feasibility / Long-context comprehension). Returns evidence to
  the parent Opus thread; no voting, no council. Optimised for in-flight planning
  decisions where one well-chosen lens changes the approach.

- **CRLN** (`specs/codex-gemini-capability-routed-consultation.md`) —
  capability-routed Gemini consultation dispatched at PLAN time. One-shot
  read-only evidence input. Fires only when a documented capability trigger
  matches (long-context > 200K tokens, ARC-AGI-2-style reasoning, multimodal,
  MCP tool coordination).

Neither covers a third, qualitatively different class of work:

- Full-project correctness audits where every core claim must be grounded in
  external evidence and the cost of a wrong conclusion is high.
- Academic paper reproducibility reviews where citation accuracy and
  computational reproducibility are both in scope.
- Irreversible architecture decisions where a single model's analysis could
  carry a systematic blind spot the model itself cannot surface.
- Hypothesis validation where the falsification target must be tracked
  separately from claims derived from the investigation.

In these cases the verification surface is murky — no executable oracle covers
every claim — and accuracy must dominate cost. Single-model + executable signal
works for normal coding (`docs/codex-as-subagent.md`). CRLN works for
capability-fit consultation. Neither produces a tiered claim ledger with
external-evidence requirements, deterministic citation grounding, or
fail-closed semantics when verification cannot fire.

### Goal

An accuracy-first audit pipeline that uses multiple LLMs as evidence-
**contributors** (not voters), gated behind explicit eligibility, defaults off,
and produces a tiered claim ledger where verified findings require external
evidence. Fail-closed when verification cannot fire. **Default-disabled by intent**: DT Audit is reserved for explicit user invocation on ultra-high-precision work (irreversible architecture decisions, paper reproducibility audits, hypothesis validation). Real-test validation completed 2026-04-30 (CRLN self-test + DPO research benchmark) confirmed the protocol's calibrated-confidence reporting and falsification rigor. Promotion to default routing remains intentionally out of scope; harness §25 measurement continues only for ongoing recalibration of cost/accuracy thresholds, not as a gate to default promotion.

The pipeline is a separate, escalation-only path. It does not replace deep-think,
CRLN, codex-delegation, or any existing skill. Auto-escalation from deep-think or
CRLN output to DT Audit is explicitly forbidden; escalation must be an explicit
user request or eligibility-gate decision.

### Constraints

The following are non-negotiable. No phase, gate, or synthesis step may soften them.

```yaml
constraints:
  majority_vote_forbidden: true
  # Model agreement is internal consensus, not external evidence.
  # The synthesizer (Phase 3) is explicitly forbidden from treating
  # cross-model agreement as a quality signal.

  cross_model_agreement_is_not_external_evidence: true
  # Three models saying the same thing is worth exactly one model saying it.
  # External evidence means: fetchable citation with exact-match quote
  # entailment, executable test output, or reproducible artifact.

  phase_1_team_isolation: true
  # Axis leaders and leaves operate independently in Phase 1.
  # No inter-team communication; aggregation only at organizer.

  depth_cap: 4
  # Hard recursion depth cap. No nested DT Audit, no nested council.

  citation_grounding_gate:
    fetch_and_exact_match: deterministic_tooling
    entailment_judgment: llm_judged
    entailment_llm_constraint: must_differ_from_claim_originator
  # Deterministic tooling (DOI resolver + exact-match fetcher) handles
  # fetch and string match. LLM entailment is the only LLM-judged step.
  # The entailment LLM must be a different model from the one that made
  # the claim — no self-grading.

  reasoned_observation_cap:
    max_confidence: 0.55
    promotion_to_verified_finding: forbidden
  # Observations backed only by model reasoning (no external evidence)
  # are capped at confidence 0.55 and may never be promoted.

  hypothesis_under_test:
    is_claim: false
    is_falsification_target: true
    verdict_track: separate
  # The hypothesis-under-test is not citation-grounded as a claim.
  # It lives on its own verdict track (SUPPORTED / REFUTED / INDETERMINATE).

  fail_closed:
    condition: external_feedback_unavailable_for_any_core_claim
    action: halt_and_escalate
  # No partial verified-finding output when external feedback is missing.

  threshold_epistemology: empirical_priors_recalibrated_by_harness
  # All numeric thresholds in this spec are starting points.
  # Harness measurement per §25 governs recalibration.
```

### Out of Scope

This iteration does not include:

- **Runtime citation grounding tooling** — DOI resolver, exact-match fetcher,
  NLI model. The spec documents the contract; implementation is deferred.
- **Harness benchmark code** — held-out task set with top-finding accuracy,
  false-positive rate, citation hallucination rate, calibration Brier score,
  inter-run reliability, and cost-adjusted accuracy. Deferred.
- **Cost-adjusted accuracy evaluation runtime**. Deferred.
- **Promotion to default routing** — explicitly forbidden until harness
  measurement validates per §25.
- **Replacing CRLN, deep-think, codex-delegation, or any existing skill**.
- **Auto-routing from deep-think lens output to DT Audit** — escalation must be
  explicit. No silent promotion.

---

## 2. Design

### Behavioral Model

The parent Opus orchestrator runs the standard templestay lifecycle. The audit
pipeline replaces the **Execute body** for the work unit — it is not a new
lifecycle, and it is not a replacement of Atomize→Plan→Execute→Verify→Report.

```
user request
     │
     ▼
Opus orchestrator
  ┌──────────────────────────────────────────┐
  │ ATOMIZE                                  │
  │  Break into work units                   │
  └───────────────┬──────────────────────────┘
                  │
  ┌───────────────▼──────────────────────────┐
  │ PLAN                                     │
  │  Run §3 eligibility gate                 │
  │  (ultra_team_eligibility check)          │
  └──┬────────────────────────────┬──────────┘
     │ gate PASS + user accepts   │ gate FAIL
     │ cost                       │
     ▼                            ▼
  ┌──────────────┐      existing routing
  │ EXECUTE body │      (CRLN / deep-think /
  │  replaced by │       single-model+test)
  │  audit       │
  │  pipeline    │
  │  below       │
  └──────┬───────┘
         │
  Phase 0 ─ freeze context + hypothesis lock
         │
  Phase 1 ─ isolated axis teams (parallel)
  │          Grounding axis | Challenge axis | Execution axis
  │          (each: 1 Opus 4.7-max leader + 3 leaves)
         │
  Phase 1.5 ─ ledger normalisation (organizer only)
         │
  Phase 1.75 ─ evidence / citation gate
         │
  Phase 2 ─ cross-enrichment (no cross-team critique)
         │
  Phase 2.5 ─ external feedback (fail-closed if unavailable)
         │
  Phase 3 ─ evidence-weighted synthesis (no voting)
         │
  Phase 3.25 ─ independent verification (different model)
         │
  Phase 3.5 ─ disagreement deep dive
         │
  Phase 4 ─ adversarial stress test
         │
  Phase 5 ─ lesson extraction
         │
  ┌──────▼───────┐
  │ VERIFY       │
  │ (parent      │
  │  checks      │
  │  ledger      │
  │  integrity)  │
  └──────┬───────┘
         │
  ┌──────▼───────┐
  │ REPORT       │
  │  dt_audit_   │
  │  final_      │
  │  report      │
  └──────────────┘
```

### Topology

The Ultra-Team is three axes, each with one Opus 4.7-max leader and three
leaves drawn from the approved leaf pool. Phase 1 teams are isolated — leaves
on one axis do not see outputs from another axis.

```yaml
dt_audit_ultra_team_v3_1:
  topology:
    axes:
      - id: grounding
        leader: opus-4.7-max
        leaves:
          - gpt-5.5-xhigh
          - opus-4.7-max
          - gemini-3.1-pro          # via gemini-gateway
      - id: challenge
        leader: opus-4.7-max
        leaves:
          - gpt-5.5-xhigh
          - opus-4.7-max
          - gemini-3.1-pro          # via gemini-gateway
      - id: execution
        leader: opus-4.7-max
        leaves:
          - gpt-5.5-xhigh
          - opus-4.7-max
          - gemini-3.1-pro          # via gemini-gateway
```

Per-axis layout:

| Axis | Mission | Leader | Leaves |
|---|---|---|---|
| `grounding` | Evidence grounding and artifact mapping | Opus 4.7-max | GPT-5.5-xhigh, Opus 4.7-max, Gemini 3.1 Pro (via `gemini-gateway`) |
| `challenge` | Falsification and failure-mode discovery | Opus 4.7-max | GPT-5.5-xhigh, Opus 4.7-max, Gemini 3.1 Pro (via `gemini-gateway`) |
| `execution` | Verification and reproducibility | Opus 4.7-max | GPT-5.5-xhigh, Opus 4.7-max, Gemini 3.1 Pro (via `gemini-gateway`) |

The gateway substrate is `mcp-servers/codex-gateway/server.py` for GPT-class
leaves and `mcp-servers/gemini-gateway/server.py` for Gemini leaves. No
gateway calls `gemini_apply` or `codex_apply`; every leaf is read-only.

### Eligibility Gate

The eligibility gate is checked by the parent Opus at PLAN time, **before any
leaf is dispatched**. If the gate does not pass, the parent falls back to CRLN,
deep-think, or single-model+test-execution and does not enter the audit
pipeline. If the gate passes, the parent must present cost to the user and
receive explicit acceptance before proceeding.

```yaml
ultra_team_eligibility:
  require_any:
    - full_project_audit: true
    - paper_reproducibility_review: true
    - irreversible_architecture_decision: true
    - hypothesis_validation_with_external_claims: true
  require_all:
    - accuracy_must_dominate_cost: true
    - single_model_analysis_insufficient: true
    - external_evidence_surface_exists: true
  disqualifiers:
    - routine_coding_task: true
    - single_file_refactor: true
    - crln_coverage_sufficient: true
    - deep_think_lens_coverage_sufficient: true
  cost_gate:
    user_explicit_acceptance_required: true
    estimated_token_budget_display: true
```

Eligibility is **not** a soft heuristic. Every `require_any` condition is a
documented task type with an observable signal (e.g., "paper PDF + claimed
results" for reproducibility; "schema migration that cannot be rolled back"
for irreversible architecture). The parent must record which condition fired
in the task anchor before dispatching any leaf.

### Phase Contract

#### Phase 0 — Context Freeze and Hypothesis Lock

```yaml
phase_0:
  name: context_freeze_and_hypothesis_lock
  actions:
    - freeze_input_artifacts: true
    - lock_hypothesis_under_test: true
    - record_eligibility_trigger: true
    - record_accepted_cost_estimate: true
    - assign_axis_leaders: true
    - confirm_leaf_pool_availability: true
  outputs:
    - frozen_context_hash
    - hypothesis_under_test          # falsification target only, not a claim
    - axis_assignments
  fail_closed: true                  # halt if any action fails
```

Phase 0 runs in the parent thread before any subagent is dispatched. The
hypothesis-under-test locked here is the falsification target for Phase 4's
adversarial stress test. It must not be treated as a claim in Phase 1 or
synthesised as a finding in Phase 3.

#### Phase 1 — Isolated Axis Team Analysis

```yaml
phase_1:
  name: isolated_axis_team_analysis
  isolation: strict
  # Axis leaders and leaves operate independently.
  # No inter-axis communication is permitted.
  # Aggregation happens only at the organizer in Phase 1.5.
  per_axis:
    grounding:
      leader: opus-4.7-max
      mission: evidence_grounding_and_artifact_mapping
      leaves:
        - model: gpt-5.5-xhigh
          gateway: codex-gateway
        - model: opus-4.7-max
          gateway: direct
        - model: gemini-3.1-pro
          gateway: gemini-gateway
      outputs:
        - raw_claim_set              # untiered, unverified
        - artifact_references        # fetchable URLs, file paths, DOIs
        - confidence_priors          # per-claim float [0,1]
    challenge:
      leader: opus-4.7-max
      mission: falsification_and_failure_mode_discovery
      leaves: [same pool]
      outputs:
        - failure_mode_set
        - counter_evidence_pointers
        - confidence_priors
    execution:
      leader: opus-4.7-max
      mission: verification_and_reproducibility
      leaves: [same pool]
      outputs:
        - reproducibility_findings
        - executable_sensor_results
        - confidence_priors
  depth_cap: 4
  nested_dt_audit_forbidden: true
  nested_council_forbidden: true
```

Phase 1 is the only phase where leaves operate. The axis leader synthesises
its own team's outputs before passing to the organizer — not the inter-axis
outputs. The organizer (parent Opus) sees only axis-leader summaries, not raw
leaf outputs, until Phase 1.5 normalisation.

#### Phase 1.5 — Ledger Normalisation

```yaml
phase_1_5:
  name: ledger_normalisation
  actor: organizer              # parent Opus only
  actions:
    - merge_axis_outputs: true
    - apply_claim_ledger_schema: true
    - assign_initial_tiers:
        verified_finding: requires_external_evidence_gate
        reasoned_observation: model_reasoning_only
        unsupported: no_evidence_cited
        hypothesis_under_test: separate_verdict_track
    - deduplicate_claims: true
    - surface_inter_axis_contradictions: true
  outputs:
    - normalised_claim_ledger       # typed, deduplicated, tiered
    - contradiction_register
```

Ledger normalisation runs entirely in the organizer thread. No model outside
the organizer may mutate the ledger schema after this phase. Inter-axis
contradictions are surfaced explicitly in the `contradiction_register` rather
than resolved by averaging.

#### Phase 1.75 — Evidence and Citation Gate

```yaml
phase_1_75:
  name: evidence_and_citation_gate
  actor: organizer_with_deterministic_tooling
  for_each_claim_in_ledger:
    verified_finding_candidates:
      step_1_fetch:
        method: deterministic_tooling   # DOI resolver / URL fetcher
        action: retrieve_cited_source
        fail_closed: true               # demote to reasoned_observation if fetch fails
      step_2_exact_match:
        method: deterministic_tooling   # exact string match
        action: confirm_quoted_text_present_in_source
        fail_closed: true
      step_3_entailment:
        method: llm_judged
        constraint: entailment_llm_must_differ_from_claim_originator
        action: judge_whether_source_entails_claim
        fail_closed: true
    reasoned_observations:
      action: confirm_confidence_leq_0.55
      promotion_to_verified_finding: forbidden
  outputs:
    - gated_claim_ledger            # claims that passed all three steps are VF
    - demoted_claims                # failed fetch/match/entailment → RO or Unsupported
```

This phase documents the contract for citation grounding. The deterministic
tooling (DOI resolver, exact-match fetcher, NLI model) is **deferred** — see
§1 Out of Scope. Until that tooling ships, Phase 1.75 cannot produce any
Verified Findings; all candidates are held at Reasoned Observation and the
pipeline halts with `fail_closed` semantics before Phase 2.

#### Phase 2 — Cross-Enrichment

```yaml
phase_2:
  name: cross_enrichment
  constraint: no_cross_team_critique
  # Axis leaders read the normalised ledger (not each other's raw outputs).
  # No axis leader may grade or rebut another axis leader's reasoning.
  # Enrichment is additive: each axis may add evidence pointers to claims
  # it did not originate, but may not lower another axis's confidence prior.
  actions:
    - each_axis_reads_contradiction_register
    - each_axis_may_add_evidence_pointers
    - each_axis_flags_claims_it_cannot_corroborate
  outputs:
    - enriched_claim_ledger
    - uncorroborated_flag_set
```

Cross-enrichment is additive and non-adversarial. "Cross-enrichment" in this
protocol means each axis adds evidence to the shared ledger; it does not mean
one model critiques another model's prose. Critiquing is the adversarial stress
tester's job in Phase 4.

#### Phase 2.5 — External Feedback

```yaml
phase_2_5:
  name: external_feedback
  fail_closed: true
  # If no external feedback surface is available (no tests, no human reviewer,
  # no reproducibility oracle), halt and escalate. Do not proceed to Phase 3
  # with only LLM-internal signals.
  feedback_surfaces:
    - executable_tests
    - human_reviewer_annotation
    - reproducibility_oracle
    - third_party_citation_database
  action: collect_and_attach_to_ledger
  outputs:
    - externally_annotated_ledger
  on_no_feedback_available:
    action: halt_and_escalate_to_user
    message: "No external feedback surface available for core claims. DT Audit cannot proceed without external verification."
```

Phase 2.5 is the fail-closed gate that separates this protocol from a council
pattern. A council synthesises from LLM-internal signals alone when no oracle
exists; DT Audit halts. This is the operational expression of the
`fail_closed` constraint.

#### Phase 3 — Evidence-Weighted Synthesis

```yaml
phase_3:
  name: evidence_weighted_synthesis
  actor: organizer
  constraints:
    voting_forbidden: true
    cross_model_agreement_is_not_a_quality_signal: true
    # Agreement across axes is not evidence. Weight is assigned only by
    # the strength of external evidence attached to a claim.
  weighting_scheme:
    verified_finding: full_weight        # external evidence confirmed
    reasoned_observation: reduced_weight # capped at confidence 0.55
    unsupported: zero_weight
    hypothesis_under_test: separate_verdict_track
  outputs:
    - synthesised_ledger
    - evidence_weight_audit_trail
```

The synthesiser is the parent Opus thread. It reads the externally-annotated
ledger and assigns weight by evidence tier — not by how many axes agreed. The
`evidence_weight_audit_trail` must be included in the final report so the
synthesis is auditable.

#### Phase 3.25 — Independent Verification

```yaml
phase_3_25:
  name: independent_verification
  actor: dt-audit-verifier             # GPT-5.5-xhigh, Phase 3.25 only
  constraint: must_not_be_same_model_family_as_synthesiser
  actions:
    - read_synthesised_ledger
    - check_claim_tier_consistency
    - check_confidence_bounds          # RO ≤ 0.55, VF has evidence chain
    - check_hypothesis_verdict_track_isolation
    - check_evidence_weight_audit_trail_completeness
  outputs:
    - verification_report
    - consistency_flags
  on_flags_found:
    action: return_to_phase_3_with_flags
    max_iterations: 1                  # one correction pass; escalate if still flagged
```

The verifier reads the ledger but does not re-run evidence fetching. Its job
is ledger consistency, not independent evidence gathering. The
`dt-audit-verifier` agent (`claude/templestay/agents/dt-audit-verifier.md`)
must be GPT-5.5-xhigh (a different model family from the Opus synthesiser) to
preserve the independence property.

#### Phase 3.5 — Disagreement Deep Dive

```yaml
phase_3_5:
  name: disagreement_deep_dive
  trigger: consistency_flags_present or contradiction_register_nonempty
  actor: organizer
  actions:
    - for_each_flagged_contradiction:
        - retrieve_originating_axis_raw_evidence
        - apply_tiebreaker_hierarchy:
            1: external_evidence_strength
            2: reproducibility_oracle_result
            3: executable_sensor_result
            4: record_as_unresolved_disagreement  # never average or vote
  outputs:
    - resolved_contradiction_set
    - unresolved_disagreement_register
  constraint: no_averaging_and_no_voting_to_resolve_disagreement
```

Disagreements resolved by tiebreaker are recorded with the tiebreaker reason.
Disagreements that survive all tiebreaker levels are written to
`unresolved_disagreement_register` and surface in the final report as explicit
open questions, not as averaged conclusions.

#### Phase 4 — Adversarial Stress Test

```yaml
phase_4:
  name: adversarial_stress_test
  actor: dt-audit-stress-tester        # Gemini 3.1 Pro, Phase 4 only
  constraint: must_not_be_same_model_family_as_synthesiser
  target: synthesised_ledger and hypothesis_under_test
  stress_test_types:
    - boundary_condition_violations
    - assumption_surface_attack
    - citation_chain_weakest_link
    - reproducibility_failure_injection
    - scope_creep_detection
    - confidence_inflation_audit
    - hypothesis_falsification_attempt  # must use external evidence only
  outputs:
    - stress_report
    - surviving_claims                  # claims that withstood all applicable tests
    - failed_claims                     # demoted or flagged for user review
    - hypothesis_verdict: SUPPORTED | REFUTED | INDETERMINATE
```

The stress tester targets the synthesised ledger and the locked
hypothesis-under-test from Phase 0. Hypothesis falsification attempts must be
backed by external evidence — a stress tester that falsifies using model
reasoning alone must record the falsification as Reasoned Observation, not as
a verdict.

#### Phase 5 — Lesson Extraction

```yaml
phase_5:
  name: lesson_extraction
  actor: organizer
  actions:
    - extract_calibration_lessons:
        sources:
          - demoted_claims
          - unresolved_disagreement_register
          - stress_report_failed_claims
    - record_threshold_recalibration_candidates
    - record_evidence_gap_patterns
    - record_citation_hallucination_instances
  outputs:
    - lesson_ledger
    - recalibration_candidates         # fed to harness per §25
```

Lessons are structured for harness consumption. The `recalibration_candidates`
output feeds §25's harness recalibration loop; they do not change any
threshold in the current run.

### Claim Ledger Schema

```yaml
claim_ledger_schema:
  claim:
    id: string                   # deterministic hash of claim text
    text: string
    originating_axis: grounding | challenge | execution
    originating_leaf_model: string
    tier: verified_finding | reasoned_observation | unsupported | hypothesis_under_test
    confidence: float            # [0, 1]; RO hard-capped at 0.55
    external_evidence:
      - source_url: string
        fetch_status: success | failed
        exact_match_quote: string | null
        entailment_result: supports | refutes | neutral | not_judged
        entailment_model: string  # must differ from originating_leaf_model
    executable_sensor_result: string | null
    reproducibility_result: string | null
    cross_axis_corroboration: list[axis_id]  # additive only; not a quality signal
    stress_test_outcome: survived | failed | not_tested
    unresolved_disagreement: bool
    notes: string | null

claim_ledger_tiering:
  verified_finding:
    requires:
      - at_least_one_external_evidence_entry_with_entailment_result_supports
    confidence_ceiling: 1.0
  reasoned_observation:
    requires:
      - no_supporting_external_evidence_required
    confidence_ceiling: 0.55         # hard cap; cannot be promoted
  unsupported:
    requires: []
    confidence_ceiling: 0.0
  hypothesis_under_test:
    verdict_track: SUPPORTED | REFUTED | INDETERMINATE
    not_a_claim: true               # exempt from claim-tier rules
```

### Claim Type Rules

```yaml
claim_type_rules:
  verified_finding:
    definition: >
      A claim backed by at least one external evidence entry where
      fetch succeeded, exact-match quote is confirmed, and entailment
      result is "supports" — judged by a model different from the
      claim originator.
    confidence_range: [0.0, 1.0]
    promotion_path: none             # earned at Phase 1.75; not promotable post-synthesis

  reasoned_observation:
    definition: >
      A claim backed only by model reasoning. No external evidence
      entry with confirmed entailment. May include references that
      failed fetch or exact-match.
    confidence_range: [0.0, 0.55]   # hard ceiling
    promotion_to_verified_finding: forbidden
    # Applies even if multiple axes independently produce the same observation.
    # Cross-model agreement is not external evidence.

  unsupported:
    definition: >
      A claim with no cited evidence and no executable sensor result.
      Confidence is 0.0. Included in the ledger for auditability.
    confidence_range: [0.0, 0.0]

  hypothesis_under_test:
    definition: >
      The falsification target locked at Phase 0. Tracked on a
      separate verdict track (SUPPORTED / REFUTED / INDETERMINATE).
      Never citation-grounded as a claim. Stress tested in Phase 4
      using external evidence only.
    not_subject_to_claim_tier_rules: true
```

### Confidence Policy

```yaml
confidence_policy:
  assignment:
    basis: external_evidence_strength_not_model_agreement
    # Confidence is set by the evidence chain, not by how many axes agree.

  verified_finding:
    floor: 0.56                      # must exceed RO ceiling to distinguish
    ceiling: 1.0

  reasoned_observation:
    floor: 0.0
    ceiling: 0.55                    # hard cap, non-negotiable

  unsupported:
    value: 0.0

  adjustment_rules:
    stress_test_failure: subtract_0.15_from_confidence
    unresolved_disagreement: subtract_0.10_from_confidence
    single_axis_origin_only: no_adjustment  # axis isolation ≠ weakness
    cross_model_agreement: no_adjustment    # agreement is not evidence

  aggregation:
    method: evidence_weighted_mean
    voting: forbidden
```

### Threshold Epistemology

All numeric thresholds below are empirical priors. They are starting points for
harness recalibration, not axioms. After harness measurement per §25, any
threshold with a calibration Brier-score delta > 0.02 is a candidate for
revision via the `recalibration_candidates` feed from Phase 5.

```yaml
threshold_epistemology:
  statement: >
    All values in this spec are empirical priors, not truths. Treat them as
    starting points for harness recalibration. Any threshold that produces a
    calibration Brier-score delta > 0.02 on the held-out task set is a
    candidate for revision.
  thresholds:
    reasoned_observation_confidence_cap: 0.55
    verified_finding_confidence_floor: 0.56
    stress_test_confidence_penalty: 0.15
    unresolved_disagreement_confidence_penalty: 0.10
    entailment_model_family_independence_required: true
    verifier_model_family_independence_required: true
    stress_tester_model_family_independence_required: true
    max_refinement_iterations_phase_3_25: 1
  recalibration_trigger: harness_measurement_per_section_25
  recalibration_authority: harness_output_not_human_intuition
```

### Fail-Closed Rules

```yaml
fail_closed:
  triggers:
    - phase_0_action_fails: true
    - phase_1_75_fetch_fails_for_any_core_claim: true
    - phase_2_5_no_external_feedback_available: true
    - phase_3_25_flags_not_resolved_in_one_pass: escalate_not_suppress
    - phase_4_entailment_model_same_family_as_originator: reject_entailment_result
  actions:
    halt_and_escalate:
      output: human_escalation_packet (see §human_escalation_packet)
      suppress_partial_verified_findings: true
      # Do not emit partial Verified Findings when the pipeline halts.
      # A partial ledger with unverified VF candidates is not a VF ledger.
    no_partial_output_on_core_claim_failure: true
  user_pressure_override: forbidden
  # A user request to "just give a recommendation" does not override
  # fail-closed semantics. The escalation packet explains why.
```

### Policy Interaction Matrix

```yaml
policy_interaction_matrix:
  deep_think:
    relationship: complementary_lighter_path
    replaces: false
    escalation_from_deep_think_to_dt_audit: explicit_only
    # deep-think lens output does NOT auto-trigger DT Audit eligibility check.
    note: >
      deep-think is the correct tool for in-flight planning ambiguity.
      DT Audit is for high-stakes post-planning audits where deep-think's
      lens model is insufficient.

  crln:
    relationship: separate_escalation_only_path
    replaces: false
    note: >
      CRLN (codex-gemini-capability-routed-consultation) is one-shot
      read-only evidence for capability-fit tasks. DT Audit is a full
      multi-phase pipeline for accuracy-first audits. They serve different
      trigger conditions and must not be conflated.

  codex_delegation_tier_1:
    relationship: orthogonal
    note: >
      Tier 1 codex-delegation (Architect/Editor + bounded executable-signal
      refinement) is the correct tool for hard coding tasks. DT Audit is not
      a coding pipeline — it is an audit pipeline. Use Tier 1 for
      implementation; use DT Audit for full-project correctness review
      of completed or candidate implementations.

  majority_vote:
    status: forbidden_at_all_phases
    no_exceptions: true

  silent_reroute_detection:
    applies: true
    # Unlike CRLN (which does not contract on vendor diversity),
    # DT Audit contracts on model-family independence for the verifier
    # (Phase 3.25) and stress tester (Phase 4). Silent reroute to a same-
    # family model is an invariant violation.
```

### Backtracking and Artifact Reuse

```yaml
backtracking:
  permitted: true
  trigger_conditions:
    - phase_3_25_consistency_flags_present
    - phase_4_stress_test_fails_core_claim
  max_backtrack_depth: 1
  # Backtracking more than one phase is forbidden; spiralling on adversarial
  # input is a known failure mode. See §Risk Assessment risk R10.
  artifact_reuse:
    frozen_context_hash: reused_across_all_phases
    normalised_claim_ledger: mutable_by_organizer_only
    raw_leaf_outputs: immutable_after_phase_1_5
  on_max_backtrack_reached:
    action: halt_and_emit_partial_report_with_warn_status
```

### Sampling and Reliability

```yaml
sampling_policy:
  temperature:
    phase_1_leaves: 0.7              # diversity within-axis
    phase_3_synthesis: 0.2           # determinism at synthesis
    phase_3_25_verification: 0.1     # maximum determinism for consistency check
    phase_4_stress_test: 0.8         # adversarial diversity
  repetition:
    inter_run_reliability_target: icc_0.80   # empirical prior; recalibrated by harness
    on_below_target: flag_in_lesson_ledger
  seed_affinity_tracking: false
  # DT Audit does not track seed affinity. Sampling diversity is
  # controlled by temperature per phase; not by seed pinning.
```

### Anytime / Partial Output

```yaml
anytime_output:
  enabled: true
  trigger: user_requests_intermediate_status or phase_2_5_halt
  output_at_phase_1_5: normalised_ledger_preview (all claims at RO tier or lower)
  output_at_phase_2: enriched_ledger_preview
  output_at_phase_2_5_halt: human_escalation_packet
  constraint:
    partial_verified_findings: forbidden_in_anytime_output
    # Anytime output may never surface claims at VF tier.
    # Only the completed Phase 3+ ledger may contain VF-tier claims.
  label_anytime_output: "INTERIM — UNVERIFIED. No Verified Findings until pipeline completes."
```

### Silent Reroute Detection

This protocol contracts on model-family independence for two specific roles:
the Phase 3.25 independent verifier (`dt-audit-verifier`, must be GPT-5.5-xhigh)
and the Phase 4 adversarial stress tester (`dt-audit-stress-tester`, must be
Gemini 3.1 Pro). Silent reroute (budget downgrade or provider substitution
that replaces these with a same-family model) is an invariant violation.

```yaml
silent_reroute_detection:
  applies: true
  rationale: >
    Unlike CRLN, which does not contract on vendor diversity, DT Audit
    contracts on model-family independence for verifier and stress tester.
    These roles require a different architectural family from the Opus
    synthesiser to preserve the independence property.
  probe:
    phase_3_25_verifier:
      expected_model_family: openai
      check: confirm_model_response_metadata_vendor_field
      on_mismatch: halt_phase_3_25_and_escalate
    phase_4_stress_tester:
      expected_model_family: google
      check: confirm_model_response_metadata_vendor_field
      on_mismatch: halt_phase_4_and_escalate
  vendor_diversity_degraded_telemetry: false
  # DT Audit does not emit templerun-style vendor_diversity_degraded events.
  # Invariant violation produces a halt + escalation packet, not a degraded
  # telemetry flag.
```

### Human Escalation Packet

```yaml
human_escalation_packet:
  triggered_by:
    - fail_closed_halt_at_any_phase
    - phase_3_25_flags_not_resolved
    - silent_reroute_detected
    - user_pressure_override_attempt
  contents:
    - trigger_reason: string
    - phase_halted_at: string
    - current_ledger_state: interim_ledger (RO tier only)
    - unresolved_contradiction_register: list
    - missing_external_feedback_surface: list
    - recommended_next_steps: list
    - cost_already_spent: token_count_per_phase
  format: structured_markdown
  label: "[DT AUDIT HALTED — HUMAN REVIEW REQUIRED]"
```

### Final Output Format

```yaml
dt_audit_final_report:
  label: "[DT AUDIT REPORT]"
  sections:
    - hypothesis_verdict:
        verdict: SUPPORTED | REFUTED | INDETERMINATE
        evidence_basis: string
    - verified_findings:
        claims: list[claim]          # VF tier only; each with evidence chain
        count: int
    - reasoned_observations:
        claims: list[claim]          # RO tier; confidence ≤ 0.55 each
        count: int
        note: "Confidence capped at 0.55. Not promoted to Verified Findings."
    - unsupported_claims:
        claims: list[claim]
        count: int
    - unresolved_disagreements:
        register: list
        note: "Not averaged or voted. Explicit open questions."
    - stress_test_summary:
        surviving_claims: int
        failed_claims: int
        adversarial_types_applied: list
    - evidence_weight_audit_trail:
        included: true               # auditability requirement
    - lesson_ledger:
        recalibration_candidates: list
    - pipeline_metadata:
        phases_completed: list
        backtrack_count: int
        total_token_cost: int
        eligibility_trigger: string
        frozen_context_hash: string
  status_token: PASS | WARN | FAIL
```

---

## 3. Content Ownership Impact

| Surface | Current state | Proposed change | Owner |
|---|---|---|---|
| `specs/dt-audit-ultra-team-v3-1.md` | absent | NEW — this file (L4, `release_candidate`) | authoritative |
| `claude/templestay/skills/templestay-dt-audit/SKILL.md` | absent | NEW — orchestration skill; includes `ultra_team_eligibility` gate, phase dispatch protocol, and user cost-acceptance gate | authoritative |
| `claude/templestay/agents/dt-audit-axis-leader.md` | absent | NEW — Opus 4.7-max axis synthesiser; one file shared across all three axes; reads which axis it is from `SUBAGENT_TASK` field `axis_id`; no Edit/Write tools | authoritative |
| `claude/templestay/agents/dt-audit-grounding-leaf.md` | absent | NEW — leaf for grounding axis; mission: `evidence_grounding_and_artifact_mapping`; calls `gemini-gateway` or `codex-gateway` per model assignment | authoritative |
| `claude/templestay/agents/dt-audit-challenge-leaf.md` | absent | NEW — leaf for challenge axis; mission: `falsification_and_failure_mode_discovery` | authoritative |
| `claude/templestay/agents/dt-audit-execution-leaf.md` | absent | NEW — leaf for execution axis; mission: `verification_and_reproducibility` | authoritative |
| `claude/templestay/agents/dt-audit-verifier.md` | absent | NEW — GPT-5.5-xhigh independent ledger consistency verifier (Phase 3.25); must be different model family from synthesiser | authoritative |
| `claude/templestay/agents/dt-audit-stress-tester.md` | absent | NEW — Gemini 3.1 Pro adversarial stress tester (Phase 4); must be different model family from synthesiser | authoritative |
| `claude/templestay/agents/dt-audit-synthesizer.md` | absent | NEW — Opus 4.7-max Phase 3 evidence-weighted synthesizer; produces synthesised ledger with evidence weight audit trail; no voting | authoritative |
| `claude/templestay/CLAUDE.md` | subagent map ends at `templestay-writer` | Add §High-stakes audit subsection: when eligibility gate passes and user accepts cost, dispatch `templestay-dt-audit` skill; gated; default disabled | authoritative |
| `README.md` | §Boundaries — prohibition on vote/consensus-based council patterns | Add gated carve-out paragraph (see note below); pending separate parent commit | authoritative |
| `specs/_index.md` | 3 current specs | Register this spec | authoritative |
| `mcp-servers/codex-gateway/server.py` | existing, 3 tools | Used as-is; read-only calls only from DT Audit leaves | reference |
| `mcp-servers/gemini-gateway/server.py` | existing, 2 tools | Used as-is; read-only calls only from DT Audit Gemini leaves | reference |
| (deferred) `mcp-servers/citation-gate/` | absent | NEW — runtime fetch + exact-match tooling for Phase 1.75; separate spec required | deferred |
| (deferred) `tests/dt_audit_harness/` | absent | NEW — harness benchmark with held-out task set; separate spec required | deferred |

**README carve-out note**: The existing prohibition in `README.md` §Boundaries is on
*vote/consensus-based council patterns* and *Copilot mediator chains*. The DT Audit
protocol is permitted because: (a) no voting at any phase, (b) Verified Findings
require external evidence — not model agreement, (c) eligibility-gated and
default-disabled, and (d) harness-validated before any default promotion is
permitted. The parent commit that amends `README.md` lands separately; this spec
cites it forward.

---

## 4. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **R1 — Council semantics slip**: protocol drifts toward voting or consensus claims under operational pressure | Medium | High | `majority_vote_forbidden: true` and `cross_model_agreement_is_not_external_evidence: true` are recorded in §1 Constraints as non-negotiable. Phase 3 synthesis explicitly forbids agreement as a quality signal. V7 verification check (`grep -E "majority vote\|consensus\|tally"`) gates merge. |
| **R2 — Citation grounding gate falls back to LLM judgment** because deterministic tooling is unavailable | High (tooling deferred) | High | Phase 1.75 is fail-closed: if the deterministic fetch/exact-match tooling cannot fire, all VF candidates are held at RO and the pipeline halts before Phase 2. No partial VF output is emitted. |
| **R3 — Eligibility gate fires too liberally**; routine work pays Ultra-Team token cost | Medium | Medium | Gate uses `require_any` on documented task types with observable signals; requires `require_all` including `accuracy_must_dominate_cost` and `single_model_analysis_insufficient`. User explicit cost acceptance is required before any leaf is dispatched. |
| **R4 — Reasoned observations promoted to Verified Findings** via subtle synthesis wording | Medium | High | RO confidence hard-capped at 0.55 (Phase 1.75). `promotion_to_verified_finding: forbidden` in claim type rules. Phase 3.25 verifier explicitly checks `confidence_bounds` and flags any RO-tier claim above 0.55. |
| **R5 — Hypothesis-under-test conflated with claim track** | Low | Medium | Hypothesis is locked at Phase 0 as a falsification target with a separate verdict track. Claim ledger schema marks it `not_a_claim: true`. Phase 3.25 verifier checks `hypothesis_verdict_track_isolation`. |
| **R6 — Independent verifier and stress tester use the same model family** (silent reroute or budget downgrade) | Medium | High | `silent_reroute_detection` applies; expected vendor fields are checked against model response metadata. Mismatch halts the respective phase and emits escalation packet. Verifier must be OpenAI-family; stress tester must be Google-family. |
| **R7 — Harness gate skipped**; protocol promoted to default without empirical evidence | Low | High | `default: disabled` in frontmatter. Spec §25 (harness validation) is a hard prerequisite for any default promotion. `awaiting: harness_validation_per_section_25` is in frontmatter. The README carve-out explicitly prohibits default promotion until harness validates. |
| **R8 — Fail-closed semantics circumvented by user pressure** | Low | High | `user_pressure_override: forbidden` in `fail_closed` YAML. The human escalation packet explains why the pipeline halted; it does not offer a "proceed anyway" path. |
| **R9 — Cross-team isolation broken via shared memory MCP capsules** | Low | Medium | Phase 1 isolation is enforced at the organizer: axis leader outputs are written to separate capsule keys; leaves on one axis cannot read another axis's capsule. The organizer reads all axis summaries only after Phase 1 completes (at Phase 1.5). |
| **R10 — Backtracking spirals on adversarial input** | Low | Medium | `max_backtrack_depth: 1` in `backtracking` YAML. On reaching the cap, the pipeline halts and emits a partial report with `WARN` status rather than looping. |

---

## 5. Alternatives Considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **(A) Do nothing; deep-think + CRLN + codex-delegation cover all cases** | No new infrastructure; proven patterns | deep-think's lens model is advisory evidence for in-flight planning, not a full-project audit ledger; CRLN is one-shot consultation, not a multi-phase citation-grounded pipeline; neither covers full-project audit / paper reproducibility / irreversible architecture lock-in where accuracy must dominate cost | Rejected |
| **(B) Adopt templerun's DT-Council Ultra-Team verbatim** | Maximum feature parity with the legacy reference | Uses voting / cross-enrichment agreement as a primary quality signal; documented bias failure modes at §7 of `docs/multi-vendor-coordination-research.md` (martingale proof that debate adds no expected accuracy above voting, correlated-error amplification, agreeableness bias from ensemble synthesisers); no fail-closed semantics; introduces mediator chains and RULERS vocabulary that violate templestay kernel rules | Rejected |
| **(C) Single-model + executable signal at the highest tier** | Proven SWE-bench track record; no new infrastructure | Single model misses architectural blind spots that multi-axis evidence-gathering surfaces; SWE-bench evidence applies to coding tasks, not full-project audit / paper reproducibility / hypothesis validation where executable signal alone is insufficient and the verification surface is murky | Rejected for this niche — remains correct for coding tasks |
| **(D) Mixture-of-Agents (Together AI MoA) for these tasks** | Straightforward aggregation API | Self-MoA empirically beats heterogeneous MoA at frontier scale (`docs/multi-vendor-coordination-research.md` §3.2: +6.6% on AlpacaEval 2.0); aggregation introduces agreeableness bias documented in `docs/multi-vendor-coordination-research.md` §7.5; weak outputs drag the aggregator down | Rejected |
| **(E — Selected) Eligibility-gated audit pipeline with no voting, deterministic citation grounding, fail-closed semantics, and harness-validated before default promotion** | Addresses the failure modes in (B–D); compatible with all templestay kernel rules; explicit on what remains deferred; does not replace any existing skill | More complex than any single-path alternative; deferred tooling (citation gate, harness) means the pipeline cannot produce VF-tier output until those land | Selected |

---

## 6. Decisions

### Decision: No voting — evidence-weighted synthesis only

- Context: The prior research (`docs/multi-vendor-coordination-research.md` §7.2)
  gives a martingale proof (Choi, Zhu, Li — NeurIPS 2025 Spotlight) that debate
  does not improve expected correctness, and majority voting accounts for
  essentially all observed gains attributed to multi-agent debate. A voting
  synthesiser inherits the same correlated-error and agreeableness-bias failure
  modes as any council member.
- Options: (i) evidence-weighted synthesis only; (ii) majority vote among axes;
  (iii) synthesiser LLM reads all axis outputs and "decides" (which collapses to
  LLM-judged synthesis with no grounding constraint).
- Selected: **(i)**. The `confidence_policy` YAML (§16) is the empirical anchor;
  confidence is assigned by evidence-chain strength, not by cross-axis agreement.
  The `evidence_weight_audit_trail` makes this auditable.
- Revisit trigger: if harness measurement shows that an evidence-weighted scheme
  produces lower calibration Brier score than a majority-vote scheme on the
  held-out task set — a result that would contradict the NeurIPS 2025 martingale
  proof.

### Decision: Default disabled, eligibility-gated

- Context: The pipeline's token cost is substantially higher than deep-think or
  CRLN. Without empirical harness evidence that the accuracy gain justifies the
  cost, enabling it by default would impose cost on work that lighter paths handle
  well.
- Options: (i) default disabled + eligibility gate + harness prerequisite; (ii)
  default enabled in `deep` preset; (iii) opt-in flag only (no eligibility gate).
- Selected: **(i)**. The `ultra_team_eligibility` gate prevents the pipeline from
  firing on work that CRLN or deep-think covers. User explicit cost acceptance is
  required even when the gate passes.
- Revisit trigger: if harness shows the gate fires too rarely — that high-stakes
  work is being misrouted to lighter paths and producing measurably worse accuracy
  — then promote to opt-in default in `deep` preset.
- **2026-04-30 update**: Real-test validation (CRLN self-test + DPO research
  benchmark) completed. Decision (i) is **retained by intent** — the protocol is
  promoted from "release-candidate awaiting harness §25" to "ready, manual-invocation
  only", but explicitly NOT promoted to default routing. Harness §25 measurement
  continues for ongoing recalibration of cost / accuracy thresholds, not as a
  promotion gate.

### Decision: Citation gate uses deterministic tooling, not LLM assertion

- Context: LLM citation assertion (a model claims a quote supports its claim)
  is the primary source of citation hallucination. The only durable fix is
  deterministic fetch + exact-match before any LLM entailment step.
- Options: (i) deterministic fetch + exact-match + independent LLM entailment;
  (ii) LLM-only citation judgment; (iii) no citation gate.
- Selected: **(i)**. The entailment LLM constraint (`must_differ_from_claim_originator`)
  prevents self-grading. Fetch and exact-match are deterministic tooling — deferred
  to a separate spec but non-negotiable as the contract.
- Revisit trigger: if the deterministic tooling has a prohibitive false-positive
  rate (demoting correct citations at > N% after harness measurement), adjust the
  exact-match algorithm rather than replacing it with LLM assertion.

### Decision: Reasoned observation confidence cap at 0.55

- Context: A cap separates claims backed by external evidence from claims backed
  by model reasoning alone. Without a cap, reasoned observations can be synthesised
  at high confidence and erode the distinction between tiers.
- Options: (i) 0.55 ceiling (below the VF floor of 0.56); (ii) 0.70 ceiling;
  (iii) no ceiling.
- Selected: **(i) 0.55**, per §17 `threshold_epistemology`. The 0.01-point gap
  between the RO ceiling (0.55) and the VF floor (0.56) is intentional: it makes
  tier boundaries non-overlapping without requiring integer rounding.
- Revisit trigger: per §17 threshold_epistemology after harness measurement. If
  calibration Brier-score delta > 0.02 at this threshold, it is a recalibration
  candidate.

### Decision: Hypothesis-under-test is a falsification target, not a claim

- Context: Treating the hypothesis as a claim would require citation grounding at
  Phase 1.75, which is circular (the hypothesis is what we are investigating, not
  what we are evidencing). Tracking it as a claim also conflates the investigation
  structure with the evidence structure.
- Options: (i) separate verdict track (SUPPORTED / REFUTED / INDETERMINATE); (ii)
  treat hypothesis as a Verified Finding candidate; (iii) exclude hypothesis from
  the ledger entirely.
- Selected: **(i)**. The hypothesis is locked at Phase 0 as a falsification
  target; Phase 4 stress tester attempts falsification using external evidence
  only; the verdict track is reported separately in the final output.
- Revisit trigger: only if academic literature on hypothesis-grounded reasoning
  produces a counter-pattern (a different verdict structure) that survives bias
  audits and is empirically validated on a held-out task set comparable to §25.

### Decision: DT Audit does not replace or auto-escalate from existing skills

- Context: deep-think and CRLN solve real problems that DT Audit is not designed
  for. Auto-escalation from a deep-think lens output or a CRLN consultation result
  to a full audit pipeline would impose Ultra-Team token cost on work that lighter
  paths already handle correctly.
- Options: (i) explicit user request or eligibility-gate decision only; (ii) auto-
  escalate when deep-think produces a contradiction across lenses; (iii) auto-
  escalate when CRLN returns a high-impact gap.
- Selected: **(i) explicit only**. The `policy_interaction_matrix` records
  `escalation_from_deep_think_to_dt_audit: explicit_only` and CRLN's relationship
  as `separate_escalation_only_path`.
- Revisit trigger: if harness evidence shows that a specific deep-think contradiction
  pattern reliably predicts cases that require DT Audit accuracy, add a
  recommendation (not an auto-trigger) to the deep-think skill for those patterns.

---

## 7. Work Units

| # | Work unit | Owner | Surfaces | Depends on |
|---|---|---|---|---|
| 1 | Spec authoring — this file | `templestay-writer` | `specs/dt-audit-ultra-team-v3-1.md` | — |
| 2 | Skill `templestay-dt-audit/SKILL.md` (eligibility gate, phase dispatch, user cost-acceptance gate) | `templestay-writer` | `claude/templestay/skills/templestay-dt-audit/SKILL.md` | 1 |
| 3 | Axis-leader agent (`dt-audit-axis-leader.md`) | `templestay-writer` | `claude/templestay/agents/dt-audit-axis-leader.md` | 2 |
| 4 | Three leaf agents (grounding, challenge, execution) | `templestay-writer` | `claude/templestay/agents/dt-audit-grounding-leaf.md`, `dt-audit-challenge-leaf.md`, `dt-audit-execution-leaf.md` | 2 |
| 5 | Verifier agent (`dt-audit-verifier.md`, GPT-5.5-xhigh) | `templestay-writer` | `claude/templestay/agents/dt-audit-verifier.md` | 2 |
| 6 | Stress-tester agent (`dt-audit-stress-tester.md`, Gemini 3.1 Pro) | `templestay-writer` | `claude/templestay/agents/dt-audit-stress-tester.md` | 2 |
| 7 | README §Boundaries carve-out paragraph + CLAUDE.md §High-stakes audit subsection | `templestay-coder` | `README.md`, `claude/templestay/CLAUDE.md` | 1 |
| 8 | Spec index update | `templestay-coder` | `specs/_index.md` | 1 |
| 9 | Verification cross-references (V1–V10) | `templestay-verifier` | tests, integration | 1–8 |
| 10 (DEFERRED) | Citation gate runtime tooling (DOI resolver, exact-match fetcher, NLI model) — separate spec required | `templestay-codex-coder` | `mcp-servers/citation-gate/` | 2 |
| 11 (DEFERRED) | Harness benchmark with held-out task set | `templestay-codex-coder` | `tests/dt_audit_harness/` | 10 |
| 12 (DEFERRED) | Inter-run reliability + cost-adjusted accuracy evaluator | `templestay-codex-coder` | `tests/dt_audit_harness/evaluator.py` | 11 |

---

## 8. Verification Plan

| Check | Command or method | Expected result |
|---|---|---|
| **V1 — Spec is well-formed markdown** | `python3 -c "import re, sys; t = open('specs/dt-audit-ultra-team-v3-1.md').read(); assert t.startswith('---'); assert '## 1.' in t and '## 2.' in t and '## 8.' in t" && echo OK` | OK |
| **V2 — All 6 agent files exist** | `ls claude/templestay/agents/dt-audit-*.md \| wc -l` | 6 |
| **V3 — Skill SKILL.md exists** | `ls claude/templestay/skills/templestay-dt-audit/SKILL.md` | exists |
| **V4 — README carve-out present** | `grep -q "DT Audit Ultra-Team" README.md && echo OK` | OK |
| **V5 — CLAUDE.md subagent map mentions audit** | `grep -q "dt-audit" claude/templestay/CLAUDE.md && echo OK` | OK |
| **V6 — Spec index lists new spec** | `grep -q "dt-audit-ultra-team-v3-1" specs/_index.md && echo OK` | OK |
| **V7 — No voting / consensus language in agent files** | `grep -E -n "majority vote\|consensus\|tally" claude/templestay/agents/dt-audit-*.md ; echo "exit=$?"` | exit=1 (no matches) |
| **V8 — pytest does not regress** | `pytest -q` | 105 passed (or current baseline) |
| **V9 — Eligibility gate phrasing present in skill** | `grep -q "ultra_team_eligibility" claude/templestay/skills/templestay-dt-audit/SKILL.md && echo OK` | OK |
| **V10 — Default-disabled phrasing present in spec** | `grep -q "default: disabled" specs/dt-audit-ultra-team-v3-1.md && echo OK` | OK |

V11–V16 (deferred to harness phase per §25):

| Check | Metric | Target (empirical prior) |
|---|---|---|
| V11 — Top-finding accuracy | % of VF-tier claims correct on held-out task set | TBD by harness |
| V12 — False-positive rate | % of VF-tier claims that fail independent review | TBD by harness |
| V13 — Citation hallucination rate | % of external evidence entries with failed exact-match | TBD by harness |
| V14 — Calibration Brier score | Score on held-out task set confidence predictions | TBD by harness |
| V15 — Inter-run reliability | ICC across ≥ 3 independent runs of same task | Target ICC ≥ 0.80 (empirical prior) |
| V16 — Cost-adjusted accuracy | Accuracy per 1K tokens vs. deep-think + CRLN baseline | Must be positive delta to justify default promotion |

---

## 9. Open Questions / Future Work

**Deferred work units** (from §7): citation gate runtime tooling (WU 10),
harness benchmark with held-out task set (WU 11), inter-run reliability and
cost-adjusted accuracy evaluator (WU 12). None of these are optional before
any default promotion is considered.

**CRLN capability-trigger interaction**: if a CRLN long-context consultation
flags a high-impact gap, should the parent escalate to the DT Audit eligibility
check? Default answer: no auto-escalation; user explicit opt-in only. This
avoids token cost on work that CRLN already handles. Revisit if harness shows
a reliable escalation signal in CRLN output.

**README carve-out dependency**: this spec assumes the parent commit that adds
the DT Audit carve-out paragraph to `README.md` §Boundaries lands separately.
If that amendment cannot be made (e.g., repo governance rejects it), this spec
is shelved until the carve-out is approved. V4 gates on it.

**Phase 1.75 blocking**: until `mcp-servers/citation-gate/` ships, Phase 1.75
cannot confirm any Verified Finding via deterministic tooling. The pipeline
correctly halts at Phase 1.75 with fail-closed semantics and emits a human
escalation packet. This is expected behaviour, not a bug.

**Harness held-out task set composition**: the task set for §25 must include
at least one example from each of the four eligibility-gate task types (full-
project audit, paper reproducibility, irreversible architecture decision,
hypothesis validation). Composition is an open question for the harness spec.

**Threshold recalibration governance**: §17 specifies that thresholds with
calibration Brier-score delta > 0.02 are recalibration candidates. The
governance process for acting on those candidates (who approves a threshold
change, at what cadence) is deferred to the harness spec.

---
*Template: `specs/_templates/full.md` — for templestay L3+ root-native changes*
