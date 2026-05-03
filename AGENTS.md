# AGENTS.md

> **Architecture**: Skill-based dispatch via 10 active agents + 26 behavior skills. All specialist behaviors are composable skill files injected into shell agents at dispatch time.

> **Source of Truth**: This file is the single authoritative reference for agent inventory (§2), task→skill→agent routing tables (§3), skill inventory (§4), and infrastructure documentation (§5). Dispatch execution protocol (templates, checklist, error handling) lives in [orchestrator.agent.md](.github/agents/orchestrator.agent.md). Invariant dispatch rules live in [copilot-instructions.md](.github/instructions/copilot-instructions.md) §3.

---

## 1. Project Specification

**MANDATORY**: All agents MUST check project status before work.

| Layer                 | File                                 | Purpose                                                      |
| --------------------- | ------------------------------------ | ------------------------------------------------------------ |
| Machine-Readable      | [PROJECT.md](PROJECT.md)             | YAML frontmatter: status, milestones, resources (60+ fields) |
| Implementation-Facing | [README.md](README.md), `src/`, `tests/` | Current branch intent and active implementation surfaces      |
| Historical Reference  | [documents/archive/2026-04-cleanup-into-specs-v1/top-level/PROJECT.md](documents/archive/2026-04-cleanup-into-specs-v1/top-level/PROJECT.md) | Background only (non-authoritative for live status or implementation) |
| Reference             | [PROJECT_SPEC.md](PROJECT_SPEC.md)   | Complete agent protocol guide                                |

### Pre-Work Checklist

0. **PROJECT.md Gate (MANDATORY FIRST ACTION)**:
   - **Before any other action**, read `PROJECT.md` and check the `status` field in YAML frontmatter.
   - If `TEMPLATE_MODE`, read `.github/skills/behavior-project-kickoff/SKILL.md` and execute project-kickoff. **HALT all other work** until initialization completes. Only exception: explicit user override for template infrastructure modification.
     > **Terminal delegation**: During project-kickoff, the orchestrator handles specification and planning directly but MUST delegate terminal operations (script execution, package installation, environment setup) to **executor tier** + `behavior-fixer`.
   - `INITIALIZED` / `ACTIVE` → Proceed to step 1.
1. Read `PROJECT.md`, then load context. If an appropriate Memory MCP write
   tool is available, store the session context there with
   `session-context, project-spec` tags. If Memory MCP write tools are not
   exposed in the current runtime, continue without attempting unavailable
   memory tools; the control ledger, GitLab work-result issue, and explicit
   artifact path are the authoritative runtime evidence for that dispatch.

---

## 2. Active Agents (10)

> All agents defined in [.github/agents/](.github/agents/). Follow Prompt Contract v3 (5-section) standard.

### Infrastructure Agents

| Agent           | Role         | Mission                                                                                                               |
| --------------- | ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `@orchestrator` | Coordination | Decompose → Delegate → Verify → Checkpoint. Also handles project initialization via `behavior-project-kickoff` skill. |

### Shell Agents (Skill-Injected)

| Tier          | Agent             | Model  | Context | Tools                                                                                                                                                 | Scope                                                      |
| ------------- | ----------------- | ------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Reader (T1)   | `gpt-reader`      | GPT    | 128K    | `read`, `search`, `web`, `context7/*`, `arxiv-mcp-server/*`, `memory/*`, `sequentialthinking/*`, `citation-tracer/*`, `tavily-search/*`, `tb-query/*` | Decomposition, math review, research                       |
| Reader (T1)   | `opus-reader`     | Opus   | 200K    | (same as above)                                                                                                                                       | Verification, safety research, planning                    |
| Reader (T1)   | `gemini-reader`   | Gemini | 1M+     | (same as above)                                                                                                                                       | Large-context ingestion, citations (cross-verify required) |
| Writer (T2)   | `gpt-writer`      | GPT    | 128K    | `execute/createAndRunTask`, `execute/runTests`, `execute/testFailure`, `read`, `agent`, `search`, `edit`, `memory/*`, `sequentialthinking/*`          | Interface/API, numerical, architecture, rapid iteration    |
| Writer (T2)   | `opus-writer`     | Opus   | 200K    | (same as above)                                                                                                                                       | Complex implementation, safety-critical, documentation     |
| Writer (T2)   | `gemini-writer`   | Gemini | 1M+     | (same as above)                                                                                                                                       | Prototype/PoC, scripts, legacy migration                   |
| Executor (T3) | `gpt-executor`    | GPT    | 128K    | `execute`, `read`, `agent`, `wandb-analysis/*`, `sequentialthinking/*`, `slurm-agent-tools/*`, `memory/*`, `gpu-resource-monitor/*`, `tb-query/*`     | Debugging, environment setup                               |
| Executor (T3) | `opus-executor`   | Opus   | 200K    | (same as above)                                                                                                                                       | Debugging, GPU ops, SLURM                                  |
| Executor (T3) | `gemini-executor` | Gemini | 1M+     | (same as above)                                                                                                                                       | Debugging, optimization                                    |

### Tier Capability Bounds

Each tier has explicit capability constraints. The orchestrator validates that dispatch objectives and outputs stay within these bounds.

| Tier          | Write Scope                                      | Execute Scope                                 | Memory Tags                               | Max Retries |
| ------------- | ------------------------------------------------ | --------------------------------------------- | ----------------------------------------- | ----------- |
| Reader (T1)   | None (read-only)                                 | None                                          | `["work-log", "research"]`                | 2           |
| Writer (T2)   | Project files, `.github/skills/` (with approval) | `createAndRunTask`, `runTests`, `testFailure` | `["work-log", "completed"]`               | 3           |
| Executor (T3) | Project files, configs (with approval)           | Full (`execute/*`, `slurm-agent-tools/*`)     | `["work-log", "completed", "checkpoint"]` | 3           |

> Capability bounds complement invariant rules. Rules guide what agents SHOULD do; capabilities enforce what agents CAN do.

---

## 3. Skill-Based Dispatch (Primary Paradigm)

### Dispatch Model

The orchestrator performs **orchestration only** — it NEVER executes tasks directly. All work is delegated to shell agents with skill injection.

```
User Request → @orchestrator
    │
    ├─ TEMPLATE_MODE? → orchestrator-direct + `behavior-project-kickoff` (ONLY exception)
    │
    └─ Resolve task domain
        │
        ├─ Select behavior skill (.github/skills/behavior-*/SKILL.md)
        ├─ Read skill file content
        ├─ Select shell agent (by model + tool tier)
        ├─ Inject [SKILL] block into shell agent prompt
        └─ Dispatch via runSubagent and verify output
```

### Policy-Guided Routing

> **Routing philosophy**: The orchestrator selects agents by evaluating task characteristics against candidate pools and hard gates, not by looking up a static table. Hard gates are non-overridable; all other routing is advisory with logged rationale.
> **Archive**: The previous static routing table is preserved in [.github/reference/routing-defaults-archive.md](.github/reference/routing-defaults-archive.md).

#### Hard Gates (Non-Overridable)

These routes are mandatory regardless of context. The orchestrator MUST NOT override them.

| Trigger                                                            | Required Route                                                                       | Rationale                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Terminal/SLURM/GPU execution                                       | **executor tier** + `behavior-slurm-manager`                                         | Executor tools required                                            |
| Math consistency verification                                      | `gpt-reader` + `behavior-math-reviewer` (author=gpt인 경우 `opus-reader`로 fallback) | Quantitative rigor; cross-model fallback when author is gpt-family |
| Safety domains (security, financial, medical, legal, irreversible) | Cross-model verification mandatory (reviewer ≠ author model family)                  | Adversarial review for high-risk                                   |
| Code review                                                        | Reader tier + `behavior-code-quality-reviewer`                                       | Verification independence                                          |
| Methodology validation                                             | Reader tier + `behavior-validator`                                                   | Research integrity                                                 |

#### Candidate Pools & Default Biases

The orchestrator selects from the candidate pool for each work shape. Default biases are advisory — the orchestrator may choose any agent in the pool when task characteristics warrant it, logging the selection rationale.

| Work Shape              | Primary Skill                                     | Candidate Pool                               | Default Biases                                                                         | Override Signals                                                                                                                                                        |
| ----------------------- | ------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Research                | `behavior-researcher`                             | opus-reader, gpt-reader, gemini-reader       | opus: synthesis/safety, gpt: theory/math, gemini: citation/doc-heavy                   | Citation-heavy → gemini, Theory-first → gpt, Diversity pressure, Large codebase first-pass → gemini-reader (1M context, cost-optimal)                                   |
| Planning                | `behavior-planner`                                | opus-reader, gpt-reader                      | opus: strategic ambiguity, gpt: quantitative plans                                     | Tightly scoped numerical planning → gpt                                                                                                                                 |
| Ideation                | `behavior-idea-generator`                         | gpt-reader, opus-reader                      | gpt: creative exploration, opus: safety-aware                                          | Safety implications → opus                                                                                                                                              |
| Decomposition           | `behavior-atomizer`                               | gpt-reader, opus-reader                      | gpt: mathematical decomposition                                                        | Complex risk assessment → opus                                                                                                                                          |
| Code generation         | `behavior-code-generator`                         | gpt-writer, opus-writer, gemini-writer       | gpt: interface/API/numerical, opus: safety-critical/refactoring, gemini: prototype/PoC | Low-risk prototype → gemini, Safety-critical → opus, Legacy migration/scaffolding → gemini (context advantage), Large codebase refactoring → gemini (context advantage) |
| Documentation           | `behavior-doc-writer`                             | opus-writer, gpt-writer                      | opus: comprehensive docs                                                               | Simple README → gpt, Large doc set → gemini (context advantage)                                                                                                         |
| Bug fix / troubleshoot  | `behavior-fixer`                                  | opus-executor, gpt-executor, gemini-executor | opus: high-risk/GPU, gpt: local debugging, gemini: optimization experiments            | Low-risk local → gpt, Performance experiment → gemini, Large codebase diagnosis → gemini (context advantage)                                                            |
| SLURM lifecycle         | `behavior-slurm-manager`                          | opus-executor, gpt-executor, gemini-executor | Rotate across executors                                                                | Availability, recent quality                                                                                                                                            |
| Kernel optimization     | `behavior-core-optimizer`                         | opus-executor, gpt-executor                  | opus: GPU-specific, gpt: algorithmic                                                   | Pure algorithm → gpt                                                                                                                                                    |
| Test execution          | `behavior-qa-regression-sentinel`                 | opus-executor, gpt-executor, gemini-executor | Rotate across executors                                                                | Availability                                                                                                                                                            |
| Template infrastructure | `behavior-meta-dev`                               | opus-writer, gpt-writer                      | opus: governance-aware changes                                                         | Simple format fix → gpt                                                                                                                                                 |
| Agent/Skill design      | `behavior-agent-creator`, `behavior-skill-seeker` | opus-writer, gpt-writer                      | opus: protocol design                                                                  | Simple skill → gpt                                                                                                                                                      |
| Pattern extraction      | `behavior-experience-curator`                     | opus-reader, gpt-reader                      | opus: strategic patterns                                                               | Quantitative patterns → gpt                                                                                                                                             |

#### Verification Routing

Verification agents MUST differ in model family from the author agent (cross-model verification).

| Output Type  | Skill                            | Candidate Pool             | Selection Rule                                                                      |
| ------------ | -------------------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| Code         | `behavior-code-quality-reviewer` | opus-reader, gpt-reader    | reviewer ≠ author model family                                                      |
| Methodology  | `behavior-validator`             | opus-reader, gpt-reader    | reviewer ≠ author model family                                                      |
| Math / Paper | `behavior-math-reviewer`         | gpt-reader, opus-reader    | gpt-reader default (hard gate); opus-reader when author is gpt-family (cross-model) |
| Documents    | `behavior-doc-reviewer`          | gpt-reader, opus-reader    | reviewer ≠ author model family; gemini excluded (sycophancy risk)                   |
| Config       | `behavior-config-verifier`       | opus-reader, gpt-reader    | reviewer ≠ author model family                                                      |
| Contracts    | `behavior-contract-compliance`   | opus-reader, gpt-reader    | reviewer ≠ author model family                                                      |
| Consensus    | `behavior-rubric-verifier`       | opus-reader, gpt-reader    | opus-reader default; gpt-reader for diversity or when prior verifier was opus       |
| Citation     | `behavior-citation-tracer`       | gemini-reader, opus-reader | gemini-reader default (specialization); opus-reader as fallback                     |
| Data audit   | `behavior-data-auditor`          | opus-reader, gpt-reader    | reviewer ≠ author model family                                                      |

#### Routing Heuristics

The orchestrator evaluates these factors in order when selecting from a candidate pool:

1. **Hard gate check**: If a hard gate applies, route is mandatory. Stop here.
2. **Tier requirement**: Match tool needs to tier (executor for terminal, writer for file edits, reader for analysis).
3. **Context window filter**: Estimate dispatch prompt size. If it exceeds a model's effective budget, deprioritize that model (GPT ~350 lines, Opus ~500 lines, Gemini ~600 lines). For large-context tasks, prefer Gemini > Opus > GPT.
4. **Task trait matching** (PRIMARY): Match task characteristics to agent specialization tags. This is the dominant selection criterion — diversity is secondary.
5. **Recent quality**: If telemetry data exists, prefer agents with higher `quality_score` on similar task domains (25% weight vs 75% task trait matching).
6. **Diversity guard** (ADVISORY): If any agent exceeds 40% of session dispatches, prefer alternatives ONLY IF they have comparable task trait match (≥80% overlap). Soft block at 60%. Never force an inferior agent for distribution balance.
7. **Cross-model verification**: For task chains, prefer author+reviewer from different model families.
8. **Retry diversity**: After failure, MUST select different model family (per Invariant Rule 11).
9. **Route margin evaluation**: Compare the top-1 and top-2 candidate scores to choose single-agent, candidate-set, or escalation mode per routing policy.

#### Override Rules

The orchestrator may deviate from default biases when:

- No hard gate is violated
- The selected agent is within the declared candidate pool
- The routing decision is logged with rationale (in ROUTING_CARD)
- Verification mode satisfies the task's risk level

#### Known Agent Limitations

Evidence-based constraints that inform routing decisions. These are supplementary to the diversity guard and hard gates.

| Agent         | Limitation                                                | Evidence               | Mitigation                                                        |
| ------------- | --------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------- |
| gemini-reader | Highest sycophancy rate (62.5%)                           | SycEval 2025 benchmark | Never assign critical review; cross-verify all analytical outputs |
| gemini-reader | Instruction following degrades in long conversations      | Community reports      | Use for ingestion/synthesis, not multi-step verification          |
| gemini-writer | HumanEval (99%) ≠ real-world complexity (SWE-bench 63.2%) | Benchmark gap          | Restrict to prototype/boilerplate/migration; complex tasks → opus |
| opus-writer   | 3-4x speed penalty vs GPT/Gemini (~49-67 tok/s)           | Latency benchmarks     | Reserve for safety-critical/complex; fast iteration → gpt         |
| opus-writer   | Highest cost tier ($5/$25 per M tokens)                   | Pricing data           | Use only when task complexity justifies cost premium              |

#### Orchestrator-Direct Protocols

These protocols are managed directly by the orchestrator, not routed through the candidate pool system:

| Task Domain                           | Behavior Skill             | Dispatch Mode                                                       |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------- |
| Project initialization                | `behavior-project-kickoff` | orchestrator-direct (spec/planning); executor tier for terminal ops |
| Multi-perspective analysis            | `behavior-dt-council`      | orchestrator-direct (parallel dispatch + cross-enrichment)          |
| Paper analysis                        | `behavior-dt-council`      | orchestrator-direct (parallel dispatch + cross-enrichment)          |
| Adaptive deep reasoning               | `behavior-deep-think`      | orchestrator-direct (multi-phase dispatch)                          |
| Complex task (high difficulty)        | `behavior-deep-think`      | orchestrator-direct (multi-phase dispatch)                          |
| Deep reasoning + multi-perspective    | `behavior-dt-council`      | orchestrator-direct (multi-phase + DT-council)                      |
| Complex: diversity-dominant (D/C > 1) | `behavior-dt-council`      | orchestrator-direct (Standard/Extended/Deep)                        |
| Complex: coherence-dominant (D/C ≤ 1) | `behavior-deep-think`      | orchestrator-direct (DT-Standard or Single Model)                   |

### Dispatch Execution Protocol

> **SSoT**: The canonical dispatch execution protocol (dispatch steps, templates, error handling, user input sanitization, context management) is defined in [orchestrator.agent.md](/.github/agents/orchestrator.agent.md). This file (AGENTS.md) provides lookup tables only.

### Skill Composability

When dispatching with both `[SKILL]` (behavior) and `[DOMAIN_SKILL]` (domain) blocks:

| Aspect                                                                   | Precedence                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------- |
| Process constraints (quality gates, output format, verification steps)   | Behavior skill takes precedence                           |
| Technical patterns (API usage, library idioms, hardware-specific config) | Domain skill takes precedence                             |
| Conflicting implementation advice                                        | Behavior skill wins; note the conflict in dispatch prompt |

**Limits**:

- Maximum 2 domain skills per dispatch (to avoid context overflow).
- If 3+ domain skills seem needed, decompose the task into smaller subtasks.

**Conflict resolution**: When injecting multiple domain skills, add a `[COMPOSITION_NOTE]` section:

```
[COMPOSITION_NOTE]
Primary domain skill: {skill_name} — prioritize for {specific_aspect}
Secondary domain skill: {skill_name} — use for {specific_aspect}
If advice conflicts, follow primary skill.
```

### Fallback Chain

Dispatch failure recovery is defined in [orchestrator.agent.md](/.github/agents/orchestrator.agent.md) Error Handling.

**Summary**: Retry limits vary by failure type (1–2 retries). After N failures, switch model family. After 3 failures with different approaches, escalate to user via `askQuestions`. Skill files not found → try closest match first, then dispatch without skill in degraded mode (`[DEGRADED_DISPATCH]` tag).

---

## 4. Behavior Skill Inventory (26 active)

Skills are defined in `.github/skills/behavior-*/SKILL.md` and injected into shell agents at dispatch time.

| Category     | Skills                                                                                                                                                                                                                 | Shell Target            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Orchestrator | project-kickoff                                                                                                                                                                                                        | orchestrator-direct     |
| Reader       | validator, code-quality-reviewer, rubric-verifier, experience-curator, config-verifier, contract-compliance, data-auditor, doc-reviewer, citation-tracer, atomizer, math-reviewer, researcher, planner, idea-generator | candidate pool (see §3) |
| Writer       | code-generator, doc-writer, skill-seeker, agent-creator, meta-dev                                                                                                                                                      | candidate pool (see §3) |
| Executor     | fixer, core-optimizer, qa-regression-sentinel, slurm-manager                                                                                                                                                           | candidate pool (see §3) |
| DT-Council   | dt-council                                                                                                                                                                                                             | orchestrator-direct     |
| Deep Think   | deep-think                                                                                                                                                                                                             | orchestrator-direct     |

### DT-Council Trigger Conditions

The `behavior-dt-council` skill activates when:

- User explicitly requests deep multi-perspective analysis (keywords: "심층 다각도 분석", "dt council", "deep council")
- Task classified as multi-perspective by atomizer AND difficulty `d ≥ 0.3`
- Phase 0 triage of `behavior-deep-think` redirects to dt-council (diversity need detected)
- Research synthesis requiring depth + >3 sources + cross-domain integration
- Architecture decisions with high uncertainty AND multiple viable approaches
- Self-referential topics requiring both depth and bias management

> **Routing priority**: The D(τ)/C(τ) ratio (below) is the PRIMARY dispatch heuristic. Atomizer difficulty scores and the triggers above serve as INPUT SIGNALS to the D/C assessment, not independent routing paths. When the orchestrator can assess D/C directly from the task description, atomizer dispatch is not required as a prerequisite.

#### Empirical Dispatch Heuristic: D(τ)/C(τ) Ratio

> **Source**: Baseline measurement study (23 tasks across 5 difficulty levels).
> **Status**: Provisional — post-hoc fit (100% across evaluated tasks), pending prospective validation.

The true dispatch variable is **not** raw difficulty (`d`), but the **D(τ)/C(τ) ratio** — diversity demand vs. coherence demand of the task. Council adds value when diversity demand dominates; single-model (with or without DT) is preferred when coherence demand dominates.

**Dispatch rule**: `D(τ)/C(τ) > θ` → DT-Council; otherwise → Single Model (A) or DT-Standard (C). θ ≈ 1.0.

| High D(τ) Signals (diversity demand) | High C(τ) Signals (coherence demand)      |
| ------------------------------------ | ----------------------------------------- |
| Conflicting source reconciliation    | Single end-to-end implementation          |
| Cross-domain knowledge needed        | Sequential dependencies                   |
| Self-referential tasks               | Convergent optimal solution               |
| Framework-level output               | Formal proofs                             |
| Multiple valid approaches            | Pipeline coherence                        |
| Adversarial testing needed           | Implementation completeness is key metric |
| Literature synthesis across domains  |                                           |

**Quick decision flowchart**:

1. Task requires formal proofs / single optimal solution? → C(τ) dominant → **Single Model (A)**
2. Task requires conflicting source reconciliation? → D(τ) dominant → **DT-Council (D')**
3. Task requires end-to-end coherent implementation? → C(τ) dominant → **Single Model (A)**
4. Task requires adversarial testing / failure mode ID? → D(τ) dominant → **DT-Council (D')**
5. Task is self-referential? → D(τ) dominant → **DT-Council (D')**
6. Unclear? `d < 0.3` → A; `d ≥ 0.3` → DT-Standard (C)

Council levels: **Standard** (3 models, 1 enrichment round), **Extended** (6 models, 1 enrichment round), **Deep** (6 models, 2 enrichment rounds). See `.github/configs/dt_council.yaml` for thresholds.

**Protocol guardrails** (enforced by orchestrator):

- Per-participant deep analysis with self-critique (4 destruction tests) before cross-enrichment
- Gemini minimum claim threshold in Phase 1 (ensures adversarial coverage)
- Cross-enrichment preserves and builds upon all participants' artifacts
- Disagreement surfacing in synthesis — never force artificial consensus
- Adversarial stress test (Phase 4) by fresh agent not involved in Phases 1-2
- Confidence calibration tracking across runs (data-driven weight adjustment)
- BAC Protocol mandatory for self-referential topics (overcompensation prevention)
- QA gates G-1 through G-6 enforced at phase transitions

### Deep Think Trigger Conditions

The `behavior-deep-think` skill activates when:

- Task difficulty score ≥ 0.3 (computed by Phase 0 triage)
- Atomizer flags high risk on a non-decomposable subtask
- Single-dispatch resolution is expected to be insufficient
- User explicitly requests deep reasoning

DT levels: **DT-Lite** (~4x, 2 hypotheses), **DT-Standard** (~8x, 2 hypotheses), **DT-Deep** (~15-20x, 3 hypotheses). See `.github/configs/deep_think.yaml` for thresholds.

**DT-Council**: For tasks requiring BOTH high difficulty AND multi-perspective diversity, use `behavior-dt-council` instead. DT-Council is the primary protocol for depth + diversity tasks, superseding the legacy fused mode. DT-only mode (`behavior-deep-think` Phase 0 with `v = low`) remains unchanged for pure difficulty tasks without diversity needs.

- **D(τ)/C(τ) heuristic**: DT-Council dispatch should primarily use the D(τ)/C(τ) ratio (see DT-Council Trigger Conditions § Empirical Dispatch Heuristic) rather than pure difficulty gating. Tasks with `D(τ)/C(τ) > 1.0` route to DT-Council; coherence-dominant tasks (`D(τ)/C(τ) ≤ 1.0`) stay with Deep Think or Single Model.

**Budget coupling**: DT draws from the same unified compute budget as Progressive Escalation. Both mechanisms cannot run at maximum simultaneously.

**Cost gate**: DT-Lite and DT-Council Standard/Extended are exempt from cost confirmation. DT-Standard, DT-Deep, and DT-Council Deep require user confirmation via `askQuestions`. User-initiated "deep" requests are also exempt.

### Skill Metadata Schema

Behavior skills MAY declare composability metadata in their YAML frontmatter to support automated conflict detection and dependency resolution:

| Field            | Type        | Purpose                                                 | Example                       |
| ---------------- | ----------- | ------------------------------------------------------- | ----------------------------- |
| `conflicts_with` | `list[str]` | Skills that MUST NOT be co-injected                     | `["behavior-core-optimizer"]` |
| `requires`       | `list[str]` | Skills that MUST be co-present for correct operation    | `["behavior-math-reviewer"]`  |
| `supersedes`     | `list[str]` | Skills this one fully replaces (for migration tracking) | `["behavior-legacy-skill"]`   |

**Usage**: When the orchestrator injects multiple skills (behavior + domain), check for `conflicts_with` violations before dispatch. A conflict triggers a dispatch error — decompose the task to avoid co-injection.

**Adoption**: Metadata fields are optional. Skills without these fields are assumed to have no conflicts, no dependencies, and to supersede nothing. Gradual adoption is expected — add metadata as conflicts or dependencies are discovered during operation.

---

## 5. Infrastructure

### MCP Servers

| Server                 | Tools               | Purpose                                   |
| ---------------------- | ------------------- | ----------------------------------------- |
| `slurm-agent-tools`    | `slurm_agent_*`     | SLURM job management                      |
| `memory`               | `mcp_memory_*`      | Persistent agent memory                   |
| `context7`             | `mcp_context7_*`    | Library documentation                     |
| `gpu-resource-monitor` | `gpu_resource_*`    | Bottleneck detection                      |
| `tb-query`             | `tb_query_*`        | TensorBoard analysis                      |
| `wandb-analysis`       | `wandb_*`           | W&B tracking                              |
| `arxiv-mcp-server`     | `arxiv_*`           | Literature research                       |
| `citation-tracer`      | `citation_tracer_*` | Citation graph                            |
| `dispatch-telemetry`   | `telemetry_*`       | Dispatch telemetry & routing analytics    |
| `tavily-search`        | `tavily_*`          | Budget-controlled web search (Tavily API) |

Config: operator-owned MCP client configuration

> **Note**: This table is documentation only. Repo-local VS Code MCP registration is deprecated/removed. Authoritative runtime MCP configuration now lives outside the repository in the operator's MCP client; project-specific infrastructure settings remain in `PROJECT.md` YAML frontmatter and `.github/configs/`.

> **Telemetry tools**: `dispatch-telemetry` (`telemetry_*`) tools are used exclusively by the orchestrator for dispatch recording. Shell agents do not need these tools.

### Key Paths

| Path                         | Purpose                                            |
| ---------------------------- | -------------------------------------------------- |
| `.github/agents/`            | Active agent definitions (10 agents)               |
| `.github/skills/`            | Skill definitions (26 active behavior + 42 domain) |
| `.github/skills/behavior-*/` | Behavior skills for specialist dispatch            |
| `.github/configs/`           | Agent operational configs                          |
| `configs/`                   | Experiment configurations                          |
| `results/`                   | Experiment results (JSON)                          |
| `logs/slurm/`                | SLURM job logs                                     |

### GPU/SLURM Policy

All GPU work via SLURM. Dispatch: **executor tier** + `behavior-slurm-manager` skill.

> **Config**: GPU-specific settings (hardware type, precision defaults, partition config) are defined in `.github/configs/gpu_policy.yaml` and the `required_resources` field in `PROJECT.md`. Per-project adaptations should update these config files, not this document.

### Core Principles

| Principle        | Rule                                                                |
| ---------------- | ------------------------------------------------------------------- |
| Simplicity First | Make every change as simple as possible. Impact minimal code.       |
| No Laziness      | Find root causes. No temporary fixes. Senior developer standards.   |
| Minimal Impact   | Changes should only touch what's necessary. Avoid introducing bugs. |

### Quality Guardrails

| Guardrail                      | Scope         | Reference                                             |
| ------------------------------ | ------------- | ----------------------------------------------------- |
| 3-Strike Subtask Escalation    | All agents    | copilot-instructions.md Invariant Rule #11            |
| Research Dedup                 | All research  | copilot-instructions.md Invariant Rule #12            |
| Architecture Decision Lock     | All agents    | copilot-instructions.md §3 Architecture Decision Lock |
| Agent Diversity Guard          | @orchestrator | Single agent > 30% of delegations → warning           |
| Verification Investment        | @orchestrator | Minimum 3% of tasks must be verification              |
| CP Health Monitor              | @orchestrator | Checkpoint:Completion ratio > 3.0 → pause and clear   |
| Session Resume Protocol        | All agents    | copilot-instructions.md §6 Session Resume Protocol    |
| Memory Hygiene                 | All agents    | copilot-instructions.md §4 Memory Hygiene             |
| Redo Detection                 | All agents    | copilot-instructions.md §4 Redo Detection             |
| Session Isolation              | All agents    | copilot-instructions.md §4 Session Isolation          |
| Proactive Checkpointing        | @orchestrator | copilot-instructions.md §6 Proactive Checkpointing    |
| Telemetry Analysis Volume Gate | @orchestrator | agent_policy.yaml → dispatch_telemetry_tiers          |
| Verification Before Done       | All agents    | copilot-instructions.md §6 Work Completion Protocol   |
| Work Completion Logging        | All agents    | copilot-instructions.md §6 Work Completion Protocol   |
| Elegance Check                 | All agents    | Non-trivial changes: "is there a more elegant way?"   |
| Circular Delegation Detection  | @orchestrator | orchestrator.agent.md Error Handling                  |
| Pre-Registered KPI             | All agents    | agent_policy.yaml → verification_kpi                  |

### Language Policy

Inter-agent communication: always English. When injecting user requirements into dispatch prompts, translate to English while preserving original intent. Full three-layer policy: `copilot-instructions.md` §5. Config: `.github/configs/agent_policy.yaml` → `locale`.
