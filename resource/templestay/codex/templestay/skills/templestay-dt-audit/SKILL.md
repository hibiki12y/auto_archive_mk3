---
name: templestay-dt-audit
description: "Use for ultra-high-precision audits — full-project review, hypothesis validation, paper reproducibility, irreversible architecture decisions. Manual-invocation only; eligibility-gated per spec §2; fail-closed when external evidence is unavailable. No voting; verified findings require external evidence (executable tests, citation fetch, artifact verification)."
---

# templestay DT Audit

Orchestration skill for the Ultra-Team audit pipeline. This skill summarises
the dispatch contract; `specs/dt-audit-ultra-team-v3-1.md` is the normative
source for all design decisions, YAML schemas, and threshold values.

The parent Codex orchestrator runs the standard templestay lifecycle unchanged.
When this skill fires, it replaces the **Execute body** for the work unit.
It is not a new lifecycle.

## How to invoke

Invocation paths — the same as any other templestay skill:

- Skill tool: `skill: "templestay-dt-audit"`
- Slash command: `/templestay-dt-audit`
- Parent dispatch via the Skill tool inside an orchestrator session

**Manual-invocation only.** The skill does not auto-fire even when the eligibility conditions below hold; the user or the parent orchestrator must explicitly select it.

## When to invoke (eligibility gate)

Invoke when ALL three conditions hold AND the user has explicitly requested DT Audit (or the work is irreversible enough that the parent should explicitly surface the option to the user before proceeding):

1. The eligibility gate from `specs/dt-audit-ultra-team-v3-1.md` §2 passes
   (`ultra_team_eligibility` — any of `require_any`, all of `require_all`,
   and none of `disqualifiers`).
2. The user has explicitly accepted the cost / latency profile, OR
   `safety_security_or_irreversible_decision: true`.
3. No lighter path is sufficient — single Codex + test execution,
   `templestay-deep-think` lenses, `templestay-deep-think` plus read-only Claude/Gemini consultation, or direct Codex execution.

If any condition is false, fall back to the lighter path. Do not auto-escalate
from deep-think or CRLN output; escalation must be explicit.

Eligibility gate (verbatim from spec §2):

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

Record which `require_any` condition fired in the task anchor before
dispatching any leaf.

## Topology (summary table)

Three axes; one Codex parent-appointed leader per axis; three leaves per axis
drawn from the approved pool. Phase 1 teams are isolated.

| Axis | Mission | Leader | Leaves |
|---|---|---|---|
| `grounding` | Evidence grounding and artifact mapping | Codex axis leader | GPT-5.5-xhigh, Claude Opus via `claude-gateway`, Gemini 3.1 Pro via `gemini-gateway` |
| `challenge` | Falsification and failure-mode discovery | Codex axis leader | GPT-5.5-xhigh, Claude Opus via `claude-gateway`, Gemini 3.1 Pro via `gemini-gateway` |
| `execution` | Verification and reproducibility | Codex axis leader | GPT-5.5-xhigh, Claude Opus via `claude-gateway`, Gemini 3.1 Pro via `gemini-gateway` |

Plus two independent specialist roles:

- **Verifier** — GPT-5.5-xhigh, Phase 3.25 only. Must not be same model
  family as the synthesiser.
- **Stress tester** — Gemini 3.1 Pro via `gemini-gateway`, Phase 4. Falls
  back to GPT-5.5-xhigh if Gemini is unavailable; the report must include
  `stress_test_not_fully_independent_from_phase_3_25` caveat when fallback
  fires.

Leaf gateways: Codex-native subagents for GPT-class leaves,
`mcp-servers/claude-gateway/server.py` for Claude-family read-only
consultation, and `mcp-servers/gemini-gateway/server.py` for Gemini leaves.
All leaf calls are read-only. The axis-leader role is dispatched as
`dt-audit-axis-leader` from `codex/templestay/agents/`.

## Phase sequence (11 phases)

| Phase | Name | Owner | Required input | Required output | Gate |
|---|---|---|---|---|---|
| 0 | Task Freezing | Parent (Codex) | User request + eligibility trigger | `frozen_input_snapshot_id`, hypothesis lock, axis assignments | All actions succeed; fail-closed |
| 1 | Isolated Team Analysis | 3 axis leaders (parallel) + 9 leaves | Phase 0 snapshot + `team_isolation_token` | Axis team summaries (raw claim sets, artifact refs, confidence priors) | Axis leaders return summaries; no cross-axis sharing |
| 1.5 | Tiered Claim Ledger Normalization | Parent | Phase 1 axis summaries | Normalised claim ledger + contradiction register | Deduplication and tiering complete |
| 1.75 | Evidence and Citation Grounding Gate | Parent + deterministic tooling | Normalised ledger | Gated claim ledger; each entry status-tagged | Each VF candidate passes fetch + exact-match + entailment; fail-closed on miss |
| 2 | Delta-Directed Cross-Enrichment | 3 axis leaders | Gated ledger + contradiction register | Enriched ledger + uncorroborated flag set | Additive only; no cross-axis critique |
| 2.5 | Strict External Feedback | Parent + external tools | Enriched ledger | Externally annotated ledger | At least one external feedback surface available; halt if none |
| 3 | Evidence-Weighted Synthesis | Synthesiser (Opus 4.7-max) | Externally annotated ledger | Synthesised ledger + evidence weight audit trail | No voting; evidence weight determines confidence |
| 3.25 | Independent Verification Pass | Verifier (GPT-5.5-xhigh) | Synthesised ledger | Verification report + consistency flags | Ledger consistency confirmed; one correction pass max |
| 3.5 | Blocking Disagreement Deep Dive | Parent | Consistency flags / contradiction register | Resolved contradiction set + unresolved disagreement register | Conditional; fires when flags affect top recommendation |
| 4 | Adversarial Stress Test | Stress tester (Gemini 3.1 Pro) | Synthesised ledger + hypothesis-under-test | Stress report + surviving/failed claims + hypothesis verdict | All applicable stress types applied |
| 5 | Accuracy Lesson Extraction | Parent | Demoted claims, unresolved disagreements, stress report | Lesson ledger + recalibration candidates | Lessons stored to memory MCP |

## SUBAGENT_TASK contract (audit extensions)

The standard `templestay-orchestration` SUBAGENT_TASK fields apply (concrete
task, scope and ownership, required actions, response budget, evidence
contract). Add these audit-specific extensions when dispatching audit leaves:

- **`audit_role`** — one of `grounding_leaf` / `challenge_leaf` /
  `execution_leaf` / `axis_leader` / `verifier` / `stress_tester` /
  `synthesizer`.
- **`axis`** — one of `grounding` / `challenge` / `execution`. Only for
  axis-team agents; omit for verifier, stress tester, synthesizer.
- **`team_isolation_token`** — a per-axis token generated at Phase 0. Agents
  must NOT see other axes' outputs until Phase 2; the parent enforces this by
  never including cross-axis output in Phase 1 dispatches.
- **`frozen_input_snapshot_id`** — Phase 0 output. Binds the audit to a
  specific input snapshot so reruns are reproducible.
- **`claim_ledger_ref`** — pointer to the shared claim ledger (memory MCP
  capsule). Read-only for axis leaves; read-write for the Phase 3 synthesizer
  only.
- **`phase`** — one of `0` / `1` / `1.5` / `1.75` / `2` / `2.5` / `3` /
  `3.25` / `3.5` / `4` / `5`.
- **`verification_feasibility`** — `executable` / `source_only` / `none`.
  Drives the strict-external-feedback policy in Phase 2.5.
- **`failure_or_timeout_policy`** — verbatim from spec §2 `fail_closed` YAML.

SUBAGENT_RESULT fields follow the standard `templestay-orchestration` shape.
Acknowledgement-only completions are degraded; the parent must not advance.

## Hard rules (the parent must enforce)

- `majority_vote_forbidden: true` — model agreement is internal consensus,
  not external evidence. The synthesizer is explicitly forbidden from treating
  cross-model agreement as a quality signal.
- `cross_model_agreement_is_not_external_evidence: true` — three models
  saying the same thing is worth exactly one model saying it.
- Citation grounding fetch + exact-match must use deterministic tooling. Only
  entailment is LLM-judged. The entailment LLM must NOT be the claim
  originator and must NOT be the same team as the originator.
- Reasoned observations are hard-capped at confidence 0.55. They cannot be
  promoted to verified findings or blocking issues, even when multiple axes
  independently produce the same observation.
- The hypothesis-under-test is NOT a claim to be citation-grounded. It is a
  falsification target on its own verdict track (SUPPORTED / REFUTED /
  INDETERMINATE).
- Fail-closed when external feedback is unavailable for any core (Tier-A)
  claim. No partial verified-finding output when the pipeline halts.
- All numeric thresholds are empirical priors. Recalibrate via harness
  measurement per `specs/dt-audit-ultra-team-v3-1.md` §25.
- No nested DT Audit, no nested council. Depth cap 4 absolute.
- `user_pressure_override: forbidden` — a user request to "just give a
  recommendation" does not override fail-closed semantics.

## Dispatch flow (parent perspective)

1. **PLAN — eligibility check.** Run the `ultra_team_eligibility` gate (spec
   §2). Record which `require_any` condition fired. If gate fails or a lighter
   path is sufficient, return to standard routing. Do not enter the pipeline.

2. **PHASE 0 — task freezing.** Freeze the input snapshot; lock the
   hypothesis-under-test as a falsification target (not a claim); record the
   eligibility trigger and accepted cost estimate; assign axis leaders;
   confirm leaf pool availability. Output: `frozen_input_snapshot_id`. Fail-
   closed — halt if any action fails.

3. **PHASE 1 — isolated team dispatch.** Dispatch three axis leaders in
   parallel, each with its own `team_isolation_token`. Each axis leader
   dispatches its three leaves in parallel within the axis. The parent does
   NOT share cross-axis outputs. Collect axis-leader summaries only.

4. **PHASE 1.5 — ledger normalization.** Parent (or a dedicated synthesizer
   dispatch) normalises all major findings into the tiered claim ledger schema
   (spec §claim_ledger_schema). No synthesis yet. Surfaces inter-axis
   contradictions in the `contradiction_register`.

5. **PHASE 1.75 — evidence + citation gate.** Parent dispatches the
   deterministic citation grounding tooling. Each ledger entry gets a status:
   `ungrounded` / `grounded` / `cited_but_not_supported` /
   `externally_verified` / `contradicted` / `reasoned_observation` /
   `unsupported`. Tooling is deferred (spec §1 Out of Scope); until it ships,
   Phase 1.75 holds all VF candidates at Reasoned Observation and the
   pipeline halts with fail-closed semantics. This is expected behaviour.

6. **PHASE 2 — cross-enrichment.** ONLY after Phase 1.75 may teams see other
   teams' outputs. Dispatch each axis leader with the other axes' ledger
   entries and `phase: 2`. Output is an additive delta list (evidence
   pointers, uncorroborated flags) — no agreement summary, no voting, no
   axis-vs-axis critique.

7. **PHASE 2.5 — strict external feedback.** Run deterministic external
   checks: executable tests, build, measured benchmark, formal checker, direct
   artifact observation. Tier-1 decisive signals only count for verified
   status. Cross-model agreement is explicitly NOT external evidence. Halt and
   escalate if no external feedback surface is available for any core claim.

8. **PHASE 3 — evidence-weighted synthesis.** Dispatch the synthesizer (Opus
   4.7-max) with the externally annotated ledger. Weight is assigned by
   evidence tier, not vote count. Preserves disagreement explicitly. Excludes
   unsupported claims. Reasoned observations preserved separately, capped at
   0.55. Include `evidence_weight_audit_trail` in output.

9. **PHASE 3.25 — independent verification pass.** Dispatch the verifier
   (GPT-5.5-xhigh) with the synthesis output + claim ledger. The verifier
   checks ledger consistency, trace integrity, confidence ceilings, and
   recommendation traceability. Consistency-only — not creative evidence
   gathering. One correction pass; escalate if still flagged.

10. **PHASE 3.5 — disagreement deep dive (conditional).** If the verifier or
    stress tester finds an issue affecting the top recommendation, dispatch a
    deep dive. Apply the tiebreaker hierarchy: external evidence strength →
    reproducibility oracle → executable sensor → record as unresolved. Never
    average or vote to resolve. If still unresolved → fail-closed with human
    escalation packet.

11. **PHASE 4 — adversarial stress test.** Dispatch the stress tester (Gemini
    via `gemini-gateway` preferred; GPT-5.5-xhigh fallback with caveat). Stress
    types: factual accuracy, logical consistency, counterexample, edge case,
    missing perspective, temporal robustness, confidence calibration, evidence
    traceability, reproducibility. Hypothesis falsification attempts must use
    external evidence only.

12. **PHASE 5 — lesson extraction.** Parent records: decisive evidence types,
    overclaim patterns, missed-error patterns, model calibration notes,
    validator effectiveness, recurring failure modes, cost-accuracy
    observations. Store to memory MCP as `recalibration_candidates` for harness
    input per spec §25.

## Failure modes (concise)

- **Eligibility gate misfire** — fall back to the lighter path immediately.
  Do not partial-enter the pipeline.
- **Citation grounding tooling unavailable** — advisory-only mode: max
  confidence 0.60, no verified findings, all recommendations marked
  `requires_human_validation`.
- **Phase 2.5 external feedback unavailable for any core claim** — halt and
  emit the human escalation packet. Do not proceed to Phase 3.
- **Verifier and stress tester conflict on top recommendation** — fire Phase
  3.5 deep dive; if still unresolved → fail-closed with human escalation
  packet.
- **Silent reroute on diversity-critical slot** — unlike CRLN, this protocol
  contracts on vendor diversity for the Phase 3.25 verifier (must be OpenAI-
  family) and Phase 4 stress tester (must be Google-family). Confirm vendor
  field in model response metadata. On mismatch: halt the phase and escalate.
  See spec §23 `silent_reroute_detection`.

## Coexistence with other skills

This skill does NOT replace any existing skill.

| Skill | Relationship |
|---|---|
| `templestay-orchestration` | Owns SUBAGENT_TASK / SUBAGENT_RESULT conventions. This skill extends them with audit-specific fields. |
| `templestay-deep-think` | Lighter, lens-based, single-Codex. Pick deep-think when one or two lenses change the approach. No auto-escalation from deep-think to this skill. |
| `templestay-claude-consultation` | Read-only Claude consultation. This skill is for audit, not authoring. If the audit produces an action recommendation, implement through normal Codex execution, not through a gateway. |
| `templestay-research` | Used inside Phase 1.75 / 2.5 when external runtime or library facts are needed. |
| `templestay-verification` | Single-target verification. Used inside Phase 2.5 / 3.25 as a primitive. |

## Cost discipline within audit phases

Parent-internal reasoning steps (Phase 1.5 ledger normalization, Phase 5 lesson
extraction) stay in the Codex parent unless a bounded `claude_prompt` or
`gemini_prompt` call is explicitly justified as read-only evidence. The
contracted axis-leaf topology, Phase 3.25 verifier vendor identity (must be
OpenAI-family), and Phase 4 stress tester vendor identity (must be
Google-family) are unchanged — those slots carry hard vendor-diversity
contracts that override cost concerns.

## Status and ongoing recalibration

> **Default: disabled by intent.** Real-test validated on 2026-04-30 (CRLN
> self-test surfaced 3 missed FAILs that V1-V8 verification had not caught;
> DPO research benchmark scored highest on limitation awareness vs single-shot
> Claude/GPT). Despite validation, default routing is intentionally NOT
> promoted: this pipeline is reserved for explicit manual invocation on
> ultra-high-precision work where the cost / latency profile is justified
> (irreversible architecture, paper reproducibility, hypothesis validation).
> Harness §25 measurement continues only for ongoing recalibration of
> cost/accuracy thresholds — it no longer serves as a gate, since promotion
> to default is intentionally out of scope.
