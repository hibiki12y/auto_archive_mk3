# Multi-Vendor Coordination — Research Note (2026-04-29)

Research-and-design note for evolving templestay's multi-vendor reasoning
surface. Inputs: the templerun DT-Council protocol (legacy reference, no
longer in tree), templestay's existing `codex-gateway` MCP + Tier-1 Architect/
Editor pattern, and a 2026-04 evidence sweep on multi-LLM coordination.

This document is **research and design** — not a spec, not an implementation
plan. A follow-up spec under `specs/` is required before any code lands.

## 1. What templerun's DT-Council actually does

Verbatim from `resource/templerun/shared/skills/dt-council/details/*` and
the `dt-council-mediator` / `gemini-gateway` agents (the templerun submodule
has been removed from the templestay tree — content cited from the
`/home/deepsky/workspace/auto_archive_mk3/resource/templerun/` archive).

**Topology** — fixed 4-slot, 3-vendor council:

| Slot | Role | Model | Vendor |
|---|---|---|---|
| C1 | First-Principles Analyst | `gpt-5.4` | OpenAI |
| C2 | Skeptical Analyst | `gpt-5.4` | OpenAI |
| C3 | Cross-Domain Analyst | `gemini-3.1-pro-preview` (via `gemini-gateway`) | Google |
| C4 | Implementation Analyst | `claude-haiku-4.5` (Council) / `claude-opus-4-7` (Ultra) | Anthropic |

**Phases** — up to 9 phases per run:

1. Phase 0 — triage / participant assignment / R4 silent-reroute probe
2. Phase 1 — full-depth parallel analysis + 4 destruction tests + BAC self-audit
3. Phase 1.5 — distillation (Extended/Ultra)
4. Phase 2 — cross-enrichment, rounds 1–3 (delta-directed, persistent-disagreement focus)
5. Phase 3 — synthesis with disagreement surfacing
6. Phase 3.25 — synthesis refinement (2–6 rounds)
7. Phase 3.5 — disagreement deep dives (convergence-gated)
8. Phase 4 — adversarial stress test (7 types)
9. Phase 5 — lesson extraction

**Heavy machinery on top**: RULERS framework, Anti-Goodhart Defense, Ultra-
Team mode (3 axes × 1–2 members, 9 leaves total), seed affinity tracking,
BoN amplification (N=3 with temperature variation), QA gates DC-G-1…DC-G-9,
council-budget auto-sizing, Pilot-First escalation, vendor-diversity-degraded
telemetry, silent-reroute fingerprinting.

**Gateway role in templerun**: `gemini-gateway` is a thin pass-through proxy
to `gemini_prompt`; `codex-gateway` is the same idea for Codex CLI work.
Both are leaf agents — no recursion, no analysis substitution, fail-closed
with attributed `error_category`. The orchestrator owns all routing.

**What the council buys you (claimed)**: maximum-diversity multi-perspective
analysis across architecturally different models, with disagreement preserved
rather than averaged away.

**What the council costs you**: ~10–60 dispatches per run depending on
level, multiple cross-enrichment rounds, vendor lock-in (must keep 3 vendors
healthy), heavy state tracking (seed metrics, traceability records, R4
probes, RULERS scores), context blow-up from cross-enrichment payloads, and
a phase pipeline that fans out even when one model would have answered.

## 2. Why templestay rejected this in the first place

`README.md`, `docs/templestay-native-kernel.md`, and
`docs/codex-as-subagent.md` are explicit:

- *"No council, no vote, no consensus, no mediator chains, no `.agent.md`
  dispatch, no `AWAIT`."* (README §Boundaries)
- *"Forbidden migrations: DT-Council/model-council mediator chains or
  vote/consensus claims."* (kernel doc)
- *"LLM-vs-LLM critique loops: refinement signal is executable only. Opus
  never grades Codex's prose. This is what keeps the loop from sliding into
  council-style reconciliation."* (codex-as-subagent doc)

The existing `templestay-deep-think` skill keeps the *useful* part —
multi-perspective analysis — but reframes it as **bounded lenses**
(Architecture / Verification / Challenge / Research / Implementation
feasibility) that return *evidence, not votes*, with explicit prohibition on
consensus claims.

The Tier-1 `templestay-codex-delegation` Shape B already implements a
two-vendor capability split (Opus architect + Codex editor) with hard cap
N=2 refinement and *executable* signals as the only loop trigger.

So templestay has already done the obvious capability-split half of "multi-
vendor reasoning." The open question this note addresses is: **does adding
Gemini buy us anything, and if so, in what shape?**

## 3. The 2026 evidence sweep

Full source list at the end. Headline findings:

| Question | Direction of evidence |
|---|---|
| Is multi-vendor at the top of SWE-bench Verified 2026? | **No.** Mythos 93.9 / Opus 4.7 87.6 / GPT-5.3 Codex 85 — all single-strong-model agent loops with executable signals. Gemini 3.1 Pro 80.6. |
| Heterogeneous Mixture-of-Agents > Self-MoA? | **No.** Self-MoA from a single top model beats heterogeneous MoA by 6.6% on AlpacaEval 2.0 and 3.8% across MMLU/CRUX/MATH (Li et al. 2502.00674). Weak outputs drag the aggregator down. |
| Multi-agent debate > self-consistency for code? | **No.** Most MAD gains trace to majority voting alone. Tyranny-of-majority and adversarial-conformity failure modes are documented. One bad agent can erase gains and increase confident wrong answers by 30%. |
| Cross-vendor production patterns work? | **By capability, not by vendor.** Aider's Architect/Editor result (o1 + Sonnet, 82.7%) is capability-tier split. Cline 2026 telemetry: Opus → Sonnet (same vendor) is the leading cross-mode pair at 25.3%. |
| Panel-of-judges > single strong judge for code? | **Mixed → no, for code.** Bias-in-the-Loop (2604.16790) shows position bias shifts judge accuracy by 10%+; tests are cheaper, faster, more reliable. |
| Async/event-driven > rigid phase pipelines? | **Architecturally yes.** LangGraph v1.0, AutoGen v0.4, OpenAI Agents SDK all moved to handoff/conditional-graph models. But "emergent" multi-LLM coordination has no SWE-bench-class win. |
| Is Gemini 3.1 Pro distinctively good at *something* relevant? | **Yes, but narrowly.** ARC-AGI-2 77.1 (≈2× prior), 1M-token context, MCP Atlas 69.2, Artificial Analysis Index #1 of 115. Not a better code editor than Codex (80.6 vs 85 on SWE-bench Verified). |
| Has LLM-critic closed the gap on executable critic? | **No.** RLEF, CTRL, Critique-Coder all *ground* the critic in execution feedback. Free-form LLM critique without an oracle is still weaker for code. |
| Speculative-decoding analog at task level? | Conceptually sound but not formalized in peer-reviewed work for multi-LLM. Verifier becomes the bottleneck unless verifier = test runner. |
| 3-vendor cost-aware routing? | **Open gap.** RouteLLM, GraphRouter, xRouter, LLMRouter all mature for 2-model strong/weak dispatch. None publish 3-vendor + executable-signal feedback. |

(Full citations and evidence quality ratings in the §Sources section.)

The evidence converges: **the things templerun's DT-Council does heavily
(debate, panel critique, heterogeneous MoA, rigid phase pipelines) are the
things 2026 evidence has weakened.** The things templestay already does
(capability split, executable-signal refinement, hard iteration cap, lenses-
as-evidence) are the things 2026 evidence supports.

## 4. What "more organic" means in 2026 SOTA terms

Not these (empirically weakened or templestay-forbidden):

- (a) Debate / argument-and-rebuttal between models
- (b) Panel-of-judges grading each other's prose
- (c) Heterogeneous Mixture-of-Agents stacking
- (d) Fixed-pipeline cross-enrichment phases

What plausibly does work (evidence-supported), expressed in templestay
vocabulary:

- **Capability-routed dispatch**, not philosophical-diversity dispatch.
  Each backend is invoked for what it is *measurably* good at, not to add a
  third opinion.
- **Blackboard, not pipeline**. Backends read from and write to the shared
  task-anchor (memory MCP capsule). They do not consume each other's outputs
  as critiques.
- **Executable signals as the only cross-cutting critic.** Tests, type
  checks, lints, file-existence checks, scope-validation. Same rule as the
  existing Tier 1 Shape B loop.
- **Hard iteration cap (N=2)** preserved. SWE-bench evidence: depth matters
  less than model strength; LLM-critique loops show diminishing returns past
  ~2 rounds, and inverted returns under adversarial inputs.

## 5. Proposed shape — "Capability-Routed Lens Network" (CRLN)

A design sketch, not a spec. Keeps templestay's existing patterns and adds
Gemini as a third *capability-specific* backend rather than a council member.

### 5.1 Add `mcp-servers/gemini-gateway/`

A slim port of `resource/templerun/copilot/mcp-servers/gemini/server.py`
(517 lines, well-tested) into templestay's `mcp-servers/` tree. Exposes:

- `gemini_prompt` — read-only prompt proxy with structured output, error
  taxonomy, timeout handling, model fallback chain.
- `gemini_models` — list available models (operator diagnostic only).

Inherits the same envelope contract as the existing `codex-gateway`:
`success`, `response`, `data`, `parsed`, `model`, `tokens`, `latency_ms`,
`error`, `error_category`. Adds nothing council-specific (no
`vendor_diversity_degraded`, no R4 silent-reroute probe, no seed-affinity
metrics) — those are council-protocol vocabulary that does not apply here.

Gateway invariants — same shape as codex-gateway:

- Fail-closed with attributed `error_category`.
- No file writes (gemini is read-only by design — no apply path needed).
- No recursive protocol invocation.
- Leaf-only — no further subagent dispatch.

Default model: `gemini-3.1-pro-preview` via `GEMINI_DEFAULT_MODEL` env.

### 5.2 Add `claude/templestay/agents/templestay-gemini-consultant.md`

A leaf subagent that:

- Receives a SUBAGENT_TASK with explicit *capability-justified* hint:
  `long_context` / `abstract_reasoning` / `multimodal` / `tool_coordination`.
- Calls `mcp__gemini-gateway__gemini_prompt`.
- Returns SUBAGENT_RESULT with the response text and `usage` / `model` /
  `latency_ms` metadata. Does not interpret. Does not editorialize.
- No file write tools. Read/Grep/Glob allowed for evidence-gathering before
  the prompt is sent (mirroring templestay-researcher).

The subagent name is *consultant*, not *analyst* or *judge*, deliberately —
it consults on the specific capability the parent named, returns evidence,
and exits.

### 5.3 Extend `templestay-codex-delegation` skill with capability routing

Add a 4th section: **Capability-Routed Consultation** (alongside Tier 3 / 2 / 1).

Capability triggers — invoke `templestay-gemini-consultant` only when:

- **Long-context comprehension**: input artifact set > ~200K tokens (whole-
  repo scan, large PDF/spec ingest, multi-file dependency mapping). Codex
  has narrower effective context for one-shot prompts; Opus pays more per
  token; Gemini's 1M window is documented strength.
- **Abstract / structural reasoning**: ARC-AGI-2-style problems, novel
  algorithm design from primitives, dependency-graph reasoning. Gemini
  3.1 Pro's ARC-AGI-2 leadership is the empirical anchor.
- **MCP tool-coordination heavy task**: when the task requires orchestrating
  several MCP tools and Gemini's MCP Atlas score (69.2) is the relevant
  signal. (Niche today; flagged for future use as MCP tool surfaces grow.)

The router (which is the parent Opus thread, not a dedicated routing agent)
calls Gemini *as one consultation*, then returns to its existing Tier 1/2/3
flow with the consultation result available as input evidence — not as a
vote, not as a critique of any other model's output.

Anti-triggers — do **not** invoke Gemini for:

- Patch generation, diff authoring, test scaffolding (Codex's lane;
  Gemini scores lower on SWE-bench Verified).
- "Get a third opinion on this code review" (rejected by templestay
  boundaries; tests are the third opinion).
- Splitting a single decision across two backends to average their
  recommendations (rejected by MoA/debate evidence).

### 5.4 Refresh `templestay-deep-think` lens set

Add one optional lens to the existing five:

- **Long-context comprehension** — invoked when the question requires
  reading more than the parent context can hold; dispatches via
  `templestay-gemini-consultant`. Returns evidence (file references, found
  invariants, contradictions discovered), not a recommendation.

The existing rule holds verbatim: *"Lenses are advisory evidence, not
votes."* The new lens is just a sixth optional one with a clear capability
trigger.

### 5.5 What is explicitly NOT added

- No `gemini-gateway` agent file in the templerun-style "council
  cross-domain analyst" sense.
- No `dt-council-mediator` analog.
- No phase pipeline (no Phase 1/1.5/2/3/3.25/3.5/4/5 staging).
- No silent-reroute R4 probe — templestay does not contract on vendor
  diversity, so silent reroutes are not an invariant violation here.
- No seed-affinity tracking, RULERS, Anti-Goodhart Defense, BoN
  amplification — all are council-protocol artifacts that do not apply to
  capability-routed dispatch.
- No "gemini grades codex's diff" or "codex grades gemini's plan" — same
  no-LLM-vs-LLM rule the Tier 1 Shape B loop already enforces. The only
  cross-cutting critic is the executable sensor.
- No Gemini in the Tier 1 refinement loop. The loop is Codex + executable
  signals, hard cap N=2. Gemini, if used, contributes evidence at PLAN time
  before the loop starts, not inside it.

## 6. Why this is "more organic" than the templerun council

| Dimension | DT-Council | CRLN sketch |
|---|---|---|
| Dispatch shape | Fixed fan-out to 4 slots every run | On-demand consultation by capability |
| Cross-model output flow | Forced cross-enrichment over multiple rounds | None — blackboard via memory MCP, no inter-model critique |
| Phase count | 5–9 phases with sub-phases and gates | 0 phases (uses templestay's existing Atomize→Plan→Execute→Verify→Report) |
| Vendor diversity contract | Hard requirement (vendor_diversity_degraded telemetry) | None — capability-justified only; degrades to 1 vendor cleanly |
| Synthesizer | Mediator with RULERS / disagreement surfacing | None — parent Opus reads evidence and decides, same as today |
| Failure mode | One vendor unhealthy → degraded run, fallback chain | One vendor unhealthy → that capability route is unavailable, parent picks the next-best route |
| Token cost (one decision) | 10–60 dispatches × full-depth prompts | 0–2 consultations + existing flow |
| State tracked | Seed metrics, R4 telemetry, traceability records, RULERS scores, BAC audits | The standard templestay task-anchor capsule + consultation result fields |
| Negative evidence triggered | Heterogeneous-MoA collapse, MAD majority echo, LLM-judge bias | None of the above — no aggregation, no inter-LLM judging, no mandatory diversity |

The "organic" property here is **dispatch only when the capability signal
matches**, with zero machinery on top. The system collapses to a single-
vendor flow when no consultation is justified, which is the common case.

## 7. Re-examination — does the answer flip for planning / analysis tasks?

The research above was code-focused (executable signals dominate). A
follow-up review (2026-04-29) examined whether the conclusion changes for
**non-code tasks** — project planning, problem analysis, design review,
contested-domain QA — where no execution oracle exists. The claim under
review: "Can a model council mitigate per-vendor bias and improve accuracy
when the verification surface is murky?"

### 7.1 Per-vendor bias profiles at frontier scale (2026)

| Finding | Evidence |
|---|---|
| Sycophancy varies by vendor but the spread is narrow | SycEval 2502.08177: Gemini 62.47% / Claude-Sonnet 57.44% / GPT-4o 56.71% sycophantic. Stanford 2026: AI affirms user 49% more than humans; vendor differences exist but are not dramatic. |
| No published planning-specific bias audit at Opus 4.x / GPT-5.x / Gemini 3.x tier | Bias literature covers earlier generations and interpersonal sycophancy; no audit isolates planning biases (optimism, risk aversion, hedging) per vendor at 2026 frontier scale. |
| Frontier models converge in error patterns | "Correlated Errors" 2506.07962: LLMs are more similar to other LLMs than human responses are to each other; within-vendor models even more correlated. |

**Implication**: The vendor-diversity argument is weaker than it looks.
Frontier models share enough training data, RLHF objectives, and cultural
priors that their *errors* correlate. Diversity that would justify council
exists in theory; at this scale it is not measurably present.

### 7.2 The hard NeurIPS 2025 result

"Debate or Vote" (Choi, Zhu, Li — NeurIPS 2025 Spotlight, 2508.17536) gives
the cleanest finding in this space: a **martingale proof** that debate does
not improve expected correctness. Majority voting accounts for essentially
all observed gains attributed to multi-agent debate. The debate process
itself is a stochastic walk that does not systematically elevate minority
correct positions.

For a non-code analysis task with no oracle, this is decisive: you cannot
identify which agent holds the correct position, so the system defaults to
majority — exactly where correlated errors converge. The "synthesis not
voting" framing used in templerun's DT-Council does not escape this when
the synthesizer is itself an LLM (and inherits the same sycophancy and
majority-convergence biases as any participant).

### 7.3 Where ensemble *does* help (and why it doesn't apply here)

- **Probabilistic forecasting**: Wisdom of the Silicon Crowd (Science
  Advances 2025) — median aggregation of 12 LLMs beat 67% of individual
  guesses (75% with context). Requires independent, well-calibrated outputs
  — condition holds for forecasting tasks, not for open-ended narrative
  analysis.
- **Structured QA classification**: SkillAggregation hit 80.8% on HaluEval-
  Dialogue (+4.7pp over majority vote) and 68.7% on TruthfulQA (+1.3pp).
  Real but small; +1.3pp is within noise on most setups.
- **Calibration in structured QA**: Amazon Science cascading-ensemble cut
  calibration error 46% on classification. Calibration is unmeasurable on
  open-ended planning where no ground truth exists.

The pattern is consistent: ensemble helps when the task has a *checkable*
answer (forecasting probability, classification label, factual claim) so
that voting provides signal. Project planning and design review do not have
this property.

### 7.4 Single-model bias-audit prompting as the counterfactual

The strongest 2025 finding in the *opposite* direction: **Bias-Augmented
Consistency Training** (BCT) reduced sycophancy on MMLU from ~73% sycophantic
to ~90% non-sycophantic *within a single model* by adding structured
consistency prompts (steel-man / pre-mortem / assumption audit / devil's
advocate). The cost is one additional generation step rather than N×M debate
rounds. No direct per-token comparison study against MAD exists for analysis
tasks, but the martingale proof implies MAD's extra calls add no expected
value above voting — meaning their token cost is the *upper bound* on what
single-model adversarial prompting must beat to win on per-token efficiency.

### 7.5 Honest assessment

For project planning and problem analysis at 2026 frontier scale, **the
multi-vendor council case does not measurably win**:

- Bias reduction: marginal at best, and the *aggregation step itself*
  introduces new biases (anchoring on first-listed model, echo chamber,
  sycophantic synthesizer drifting toward consensus). NUS "Beyond
  Consensus" 2025 documents the agreeableness bias introduced by ensemble
  synthesizers.
- Accuracy improvement: +1–5pp on structured QA where the task is
  checkable; not demonstrated on open-ended planning. PlanBench updates and
  related work do not show council beating single strong model on
  open-ended plan quality.
- Per-token efficiency: a council run costs N× the calls of a single-model
  adversarial-prompt run. Even if council won by a few points (which the
  evidence does not show for planning), the per-token return is poor.
- Failure modes added: tyranny of the majority, adversarial-agent
  manipulation (Nature Sci Rep 2026: one bad agent + 30% increase in
  confident-wrong), correlated-error amplification, sycophantic
  synthesis.

The conditions under which council would flip the answer are not met:

1. Models must be *structurally* diverse — not met at frontier tier
   (correlated errors).
2. The synthesis step must be *non-LLM* (programmatic rubric) — not met by
   any council implementation including templerun's DT-Council, where the
   synthesizer is another LLM dispatch.
3. The task must have a *checkable* answer so voting provides signal —
   not met for planning/analysis.

### 7.6 What this means for templestay

The conclusion of §6 ("Capability-Routed Lens Network") is reinforced
rather than reversed. Specifically:

- **Keep `templestay-deep-think` exactly as it is — bounded lenses, not
  votes.** The existing skill is already the evidence-supported answer for
  analysis tasks: structured adversarial prompting (Challenge lens),
  evidence-grounding (Research lens), assumption-checking
  (Implementation feasibility lens) — all returning evidence to the parent
  Opus, not voting against each other.
- **Optionally strengthen the Challenge lens explicitly** with a
  bias-audit micro-checklist drawn from BCT-style structured consistency
  prompting: pre-mortem, steel-man of opposition, hidden-assumption surface.
  This is a single-model prompt augmentation, not a new vendor.
- **The CRLN proposal in §5 stands** — Gemini consultation by *capability*
  signal (long-context comprehension, abstract reasoning) — but only as
  evidence input to the parent, never as a council vote. This is consistent
  with both the coding-task evidence (§3) and the analysis-task evidence
  (§7).
- **Do not build a council**. The legacy DT-Council protocol's central
  claims — bias mitigation through vendor diversity, accuracy improvement
  through cross-enrichment, dissent preservation through synthesis — are
  not supported by the 2025–2026 evidence at frontier scale, and would
  reintroduce the failure modes templestay's README boundary was designed
  to prevent.

The templestay README boundary ("no council, no vote, no consensus, no
mediator chains") stands on stronger evidence in 2026 than it did when
written. The genuine multi-vendor value is captured by capability-routed
consultation (§5), not by adversarial multi-LLM debate.

## 8. Open questions for a follow-up spec

The above is research-and-design only. A spec under `specs/` should answer:

1. Does the Gemini gateway need its own `gemini_apply` analog for any
   write-capable use? (Answer is probably no — Gemini's role here is read-
   only consultation; Codex remains the editor. But worth confirming.)
2. What is the budget signal for "this task needs long-context
   consultation"? Is it `git ls-files | wc -l > N`? Token estimate? User
   flag? The router needs a deterministic trigger, not an Opus judgment.
3. How does the consultation result enter Opus context without ballooning
   it? Do we summarize before returning to the parent, or pass through?
4. Should the consultation be cached on the task anchor (deterministic
   `request_hash` + capability tag) so repeat consultations on the same
   evidence don't re-spend Gemini tokens?
5. Verification plan: what V1–V6 shape (parallel to the codex-as-subagent
   spec) demonstrates that adding Gemini measurably helps on the documented
   capability triggers and is no worse on everything else?
6. What preset wires `gemini-gateway` on by default? Most likely `deep`
   only; `balanced` and `minimal` should keep token spend predictable.

## Sources

Multi-LLM coordination evidence (2024–2026), curated for this note. Quality
ratings: STRONG / MODERATE / WEAK / SPECULATIVE.

- SWE-bench Verified leaderboard 2026 [STRONG] — `https://www.swebench.com/`
- SWE-Bench Pro: contamination-corrected scores [STRONG] —
  `https://www.morphllm.com/swe-bench-pro`
- Mixture-of-Agents (Wang et al. 2024, ICLR 2025 Spotlight) [MODERATE] —
  `https://arxiv.org/abs/2406.04692`
- Rethinking Mixture-of-Agents — Self-MoA beats heterogeneous (Li et al.
  Feb 2025) [STRONG] — `https://arxiv.org/abs/2502.00674`
- Multi-LLM-Agents Debate scaling/efficiency analysis [STRONG] —
  `https://d2jud02ci9yv69.cloudfront.net/2025-04-28-mad-159/blog/mad/`
- Can LLM Agents Really Debate? (controlled study) [STRONG] —
  `https://arxiv.org/abs/2511.07784`
- Should we be going MAD? (Smit et al., ICML 2024) [STRONG] —
  `https://proceedings.mlr.press/v235/smit24a.html`
- When Collaboration Fails (adversarial-influence MAD, Nature Sci Rep 2026)
  [STRONG] — `https://www.nature.com/articles/s41598-026-42705-7`
- Aider Architect/Editor production result [STRONG] —
  `https://aider.chat/2024/09/26/architect.html`
- Cline Plan/Act 2026 telemetry [MODERATE] —
  `https://cline.bot/blog/plan-act-model-usage-patterns-in-cline`
- Bias in the Loop: LLM-as-judge for SE (April 2026) [STRONG] —
  `https://arxiv.org/html/2604.16790v1`
- Gemini 3.1 Pro model card (Feb 2026) [STRONG] —
  `https://deepmind.google/models/model-cards/gemini-3-1-pro/`
- Vellum Gemini 3 benchmark roundup [MODERATE] —
  `https://www.vellum.ai/blog/google-gemini-3-benchmarks`
- RLEF: Grounding Code LLMs in Execution Feedback (ICLR 2025) [STRONG] —
  `https://openreview.net/forum?id=PzSG5nKe1q`
- Teaching Language Models to Critique via RL (CTRL, Feb 2025) [STRONG] —
  `https://arxiv.org/html/2502.03492v1`
- Critique-Coder (Sept 2025) [MODERATE] —
  `https://arxiv.org/html/2509.22824`
- RouteLLM (LMSYS, ICLR 2025) [STRONG] —
  `https://www.lmsys.org/blog/2024-07-01-routellm/`
- LLMRouter unified library (Dec 2025) [MODERATE] —
  `https://github.com/ulab-uiuc/LLMRouter`
- xRouter — RL cost-aware orchestration (Oct 2025) [MODERATE] —
  `https://arxiv.org/html/2510.08439v1`
- Debate or Vote — martingale proof (NeurIPS 2025 Spotlight) [STRONG] —
  `https://arxiv.org/abs/2508.17536`
- SycEval: cross-vendor sycophancy audit [MODERATE] —
  `https://arxiv.org/html/2502.08177v2`
- When Debate Fails: bias reinforcement in LLMs [STRONG] —
  `https://arxiv.org/html/2503.16814v1`
- Beyond Consensus: agreeableness bias from ensemble synthesizers (NUS, 2025)
  [MODERATE] —
  `https://aicet.comp.nus.edu.sg/wp-content/uploads/2025/10/Beyond-Consensus-Mitigating-the-agreeableness-bias-in-LLM-judge-evaluations.pdf`
- Wisdom of the Silicon Crowd (Science Advances 2025) [MODERATE] —
  `https://www.science.org/doi/10.1126/sciadv.adp1528`
- Bias-Augmented Consistency Training (single-model sycophancy reduction)
  [MODERATE] —
  `https://aisafetyfrontier.substack.com/p/paper-highlights-of-november-2025`
- PlanBench frontier-model evaluation [WEAK for council comparison] —
  `https://openreview.net/forum?id=YXogl4uQUO`
- SkillAggregation on HaluEval/TruthfulQA [MODERATE] —
  `https://www.emergentmind.com/topics/halueval-and-truthfulqa`
- Why Do Multi-Agent LLM Systems Fail? (2503.13657) [STRONG] —
  `https://arxiv.org/abs/2503.13657`

## See also

- `docs/templestay-native-kernel.md` — kernel rules, including the council/
  vote/consensus prohibition that this note honors.
- `docs/codex-as-subagent.md` — Tier 1 Shape B rationale and the
  no-LLM-vs-LLM-critique rule that CRLN keeps.
- `claude/templestay/skills/templestay-deep-think/SKILL.md` — the existing
  bounded-lens skill that the Long-context lens extension would land in.
- `claude/templestay/skills/templestay-codex-delegation/SKILL.md` — the
  Tier-3/2/1 routing skill that CRLN's capability-routed consultation would
  extend with a fourth section.
- `mcp-servers/codex-gateway/server.py` — the existing pattern that the
  proposed `mcp-servers/gemini-gateway/server.py` would mirror in shape.
