---
status: proposed
level: L3
type: integration
created: 2026-04-29
author: opus-orchestrator
relates_to: "docs/multi-vendor-coordination-research.md"
---

# Spec: Capability-Routed Gemini consultation (CRLN)

## 1. Requirements

### Problem

templestay's dual-CLI integration exposes Codex as a Tier 1/2 leaf via
`codex-gateway`. The routing decision is always capability-based, not
vendor-diversity-based. Gemini 3.1 Pro has documented strengths that
neither Opus nor Codex match: 1M-token context window, ARC-AGI-2 score
77.1 (≈2× prior frontier), and MCP Atlas tool-coordination score 69.2
(see `docs/multi-vendor-coordination-research.md` §3 and §5.1). There is
currently no path for Opus to consult Gemini when a task type measurably
fits those strengths. Evidence also confirms Gemini is *not* a better code
editor than Codex (80.6 vs. 85 on SWE-bench Verified), so adding it as a
writer would regress authoring quality.

### Goal

Add a capability-routed consultation path so Opus can dispatch a single
read-only consultation to Gemini through a templestay-native MCP gateway.
Consultation fires at PLAN time under explicit capability triggers (long-context
comprehension / abstract reasoning / multimodal / MCP tool coordination).
Returns evidence to the parent — never a vote, never an editor, never
inside the Tier 1 refinement loop.

### Constraints

- No council, vote, consensus, mediator chains, `.agent.md` dispatch, or
  `AWAIT`. README boundaries apply.
- Leaf-only subagents. The new consultant must not spawn subagents and must
  not be re-entered recursively.
- No LLM-vs-LLM critique. The consultant returns evidence; Opus reads it.
  Gemini does not grade Codex output and Codex does not grade Gemini output.
- Read-only gateway. `gemini_apply` is NOT in scope. Codex remains the sole
  writer via `codex_apply`.
- No Gemini in the Tier 1 refinement loop. Consultation happens at PLAN time,
  before Codex iteration starts.
- No silent-reroute R4 self-identify probe. templestay does not contract on
  vendor diversity; silent reroutes are not an invariant violation here.
- Hooks remain optional.
- Auto-memory disabled.

### Out of Scope

- Gemini as code editor or write-path participant.
- Gemini in the Tier 1 refinement loop.
- Council/vote/synthesis protocols from templerun's DT-Council.
- `gemini_apply` write path.
- R4 silent-reroute probe.
- Seed-affinity tracking, RULERS, Anti-Goodhart Defense, BoN amplification,
  Ultra-Team mode.
- Multi-vendor `vendor_diversity_degraded` telemetry.

## 2. Design

### Behavioral Model

Routing is decided at PLAN by the Opus orchestrator:

```
                     +----------------------+
  user request ────▶ |  Opus orchestrator   |
                     |   (PLAN phase)       |
                     +-----------+----------+
                                 │ capability trigger?
                      yes        │           no
             ┌──────────────────-┤           │
             ▼                              ▼
  templestay-gemini-consultant   existing Tier 1/2/3 routing
   (one consultation, read-only)           (unchanged)
             │
             │ evidence result
             ▼
  Opus reads evidence, continues
  to existing Tier 1/2/3 routing
             │
             ▼
  (Tier 1 example)
  templestay-codex-coder ──▶ codex_apply ──▶ templestay-verifier
  Architect/Editor, N=2 loop, executable signals only
```

The consultation result is input evidence for Opus's planning step. It
is not a vote, not a critique of any other model's output, and not a loop
participant. After consultation, the Tier 1/2/3 flow is unchanged.

**Capability triggers** — invoke `templestay-gemini-consultant` only when:

- **Long-context comprehension**: input artifact set exceeds ~200K tokens
  (whole-repo scan, large PDF/spec ingest, multi-file dependency mapping).
  Gemini's 1M window is the documented strength; Codex and Opus have
  narrower effective context for one-shot prompts.
- **Abstract / structural reasoning**: ARC-AGI-2-style problems, novel
  algorithm design from primitives, dependency-graph reasoning. Gemini 3.1
  Pro's ARC-AGI-2 leadership (77.1) is the empirical anchor.
- **Multimodal input**: task requires interpreting visual diagrams, charts,
  or screenshots alongside text.
- **MCP tool-coordination heavy task**: task requires orchestrating several
  MCP tools; Gemini's MCP Atlas score (69.2) is the relevant signal.

**Anti-triggers** — do NOT invoke Gemini for:

- Patch generation, diff authoring, test scaffolding (Codex's lane; Gemini
  scores lower on SWE-bench Verified at 80.6 vs 85).
- "Get a third opinion on this code review" (tests are the third opinion;
  LLM-vs-LLM critique is explicitly forbidden).
- Splitting a single decision across backends to average recommendations
  (rejected by MoA/debate evidence in `docs/multi-vendor-coordination-research.md` §3).

### Content Ownership Impact

| Surface | Current state | Proposed change | Owner |
|---|---|---|---|
| `mcp-servers/gemini-gateway/server.py` | absent | NEW: slim port of `auto_archive_mk3/resource/templerun/copilot/mcp-servers/gemini/server.py` (~500 lines). Two tools: `gemini_prompt`, `gemini_models`. Drops council vocabulary (`vendor_diversity_degraded`, R4 self-identify probe, seed-affinity, BoN amplification); keeps error taxonomy, timeout, markdown-fence stripping, stats extraction, prompt-size validation, `_sanitize_configured_model` pattern. | authoritative |
| `mcp-servers/gemini-gateway/requirements.txt` | absent | NEW: `mcp>=1.0.0` only | authoritative |
| `claude/templestay/agents/templestay-gemini-consultant.md` | absent | NEW: leaf subagent; receives capability-justified hint (`long_context` / `abstract_reasoning` / `multimodal` / `tool_coordination`); calls `mcp__gemini-gateway__gemini_prompt`; returns evidence text + `usage` / `model` / `latency_ms` metadata; no Edit/Write tools; Read/Grep/Glob allowed for pre-prompt evidence gathering | authoritative |
| `claude/templestay/skills/templestay-codex-delegation/SKILL.md` | 3-tier routing + Shape B | Add §Capability-Routed Consultation as 4th section: triggers, anti-triggers, dispatch protocol, evidence-only return contract | authoritative |
| `claude/templestay/skills/templestay-deep-think/SKILL.md` | 5 lenses | Add Long-context comprehension as 6th optional lens; reaffirm advisory-evidence rule | authoritative |
| `claude/templestay/.mcp.json` | 4 servers (memory, context-manager, document-parser, codex-gateway) | Add `gemini-gateway` as 5th entry | authoritative |
| `claude/templestay/settings/presets/deep.json` | codex-gateway enabled | Enable `gemini-gateway` | authoritative |
| `claude/templestay/settings/presets/balanced.json` | codex-gateway enabled | Unchanged — `gemini-gateway` NOT enabled; token-spend predictability takes priority until V1–V6 evidence is in | authoritative |
| `claude/templestay/settings/presets/minimal.json` | minimal footprint | Unchanged — `gemini-gateway` NOT enabled; minimal is the Tier 3 escape hatch | authoritative |
| `claude/templestay/CLAUDE.md` | subagent map ends at `templestay-writer` | Add bullet under §Subagent map: when capability triggers fire, invoke `templestay-gemini-consultant` at PLAN before Codex dispatch | authoritative |
| `README.md` | §Boundaries | Add bullet: Gemini may be consulted (read-only, `deep` preset only) via `gemini-gateway` under capability triggers; evidence-only return; never inside Tier 1 loop | authoritative |
| `docs/multi-vendor-coordination-research.md` | existing | Cross-reference this spec; no content changes | reference |
| `docs/codex-claude-dual-cli-prior-art.md` | existing | Cross-reference this spec; no content changes | reference |
| `specs/_index.md` | existing specs | Register this spec | authoritative |

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Consultation result doubles parent context size | Medium | Medium | Consultant returns a summarized evidence block, not the raw model transcript. Parent may further compress before continuing. |
| Gemini CLI unavailable at runtime | Medium | Low | Failure is attributed `error_category` per the error taxonomy; Opus falls back to existing routing with no consultation. The system degrades cleanly to single-vendor flow. |
| Capability triggers fire too liberally — token cost spiral | Medium | Medium | Triggers are deterministic by default (token estimate, file count, explicit user flag); Opus judgment is not a trigger alone. Revisit thresholds after V1–V6. |
| LLM-vs-LLM critique slip (subprompt asks Gemini to grade Codex) | Low | High | Consultant agent body explicitly forbids grading other models' output. Skill §Capability-Routed Consultation repeats the anti-critique rule. |
| Capability-router decisions drift over time as model scores change | Low | Medium | Triggers are anchored to documented benchmark scores (ARC-AGI-2 77.1, MCP Atlas 69.2, SWE-bench 80.6 vs 85) cited from `docs/multi-vendor-coordination-research.md`. Revisit trigger: when new leaderboard data materially shifts the gap. |
| `gemini-gateway` import error blocks Claude Code startup | Low | High | V1 (py_compile) and V3 (cold start) checks gate merge; `gemini-gateway` wired only in `deep` preset, not `balanced` or `minimal`. |

### Alternatives Considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| (A) Do nothing; Gemini remains unreachable | No new infrastructure | Leaves documented capability strengths on the table for tasks where they would help | Rejected |
| (B) Full DT-Council protocol from templerun (4-slot × 3-vendor, Phase 0–5, RULERS) | Maximum templerun feature parity | README boundaries forbid council/vote/consensus; bias-mitigation review (`docs/multi-vendor-coordination-research.md` §7) shows council does not measurably help even for analysis tasks; martingale proof that debate adds no expected accuracy above majority voting | Rejected |
| (C) gemini-gateway as a Tier 1/2 editor alongside Codex | Gemini available for writes | Gemini SWE-bench Verified 80.6 vs Codex 85 — not a better editor; introduces LLM-vs-LLM critique slip risk in the refinement loop | Rejected |
| (D) Gemini in the Tier 1 refinement loop (Codex generates → Gemini reviews → Codex revises) | Adds a review step | Explicit no-LLM-vs-LLM-critique rule from `docs/codex-as-subagent.md`; executable signals are the only loop trigger; LLM critique without an oracle is weaker for code (`docs/multi-vendor-coordination-research.md` §3) | Rejected |
| **(E — Selected) Capability-Routed Consultation: read-only, evidence input to parent, outside the loop** | Respects all README boundaries; evidence-backed; degrades cleanly when Gemini unavailable; pattern A (MCP-Gateway Leaf, hardened) from `docs/codex-claude-dual-cli-prior-art.md` | Gemini not available for writes; consultation adds one extra dispatch on `deep` preset tasks with matching triggers | **Selected** |

## 3. Work Units

| # | Work unit | Owner | Surfaces | Depends on |
|---|---|---|---|---|
| 1 | Slim port of `mcp-servers/gemini-gateway/server.py` from templerun source (drop council vocabulary; keep error taxonomy, timeout, markdown stripping, stats extraction, prompt-size validation) | `templestay-codex-coder` (Tier 2) | `mcp-servers/gemini-gateway/{server.py,requirements.txt}` | — |
| 2 | Wire gemini-gateway into project MCP config | `templestay-coder` | `claude/templestay/.mcp.json` | 1 |
| 3 | Create `templestay-gemini-consultant` leaf subagent | `templestay-writer` | `claude/templestay/agents/templestay-gemini-consultant.md` | 1 |
| 4 | Extend `templestay-codex-delegation` skill with §Capability-Routed Consultation | `templestay-writer` | `claude/templestay/skills/templestay-codex-delegation/SKILL.md` | 3 |
| 5 | Add Long-context comprehension lens to `templestay-deep-think` skill | `templestay-writer` | `claude/templestay/skills/templestay-deep-think/SKILL.md` | 3 |
| 6 | Enable gemini-gateway in `deep` preset only | `templestay-coder` | `claude/templestay/settings/presets/deep.json` | 2 |
| 7 | Cross-reference in CLAUDE.md and README | `templestay-writer` | `claude/templestay/CLAUDE.md`, `README.md` | 4 |
| 8 | Register spec in index | `templestay-coder` | `specs/_index.md` | — |
| 9 | V1–V6 verification | `templestay-verifier` | tests, integration | 1–8 |

## 4. Decisions

### Decision: Read-only gateway over write-capable

- Context: Gemini could conceivably serve as a write-path tool (analogous to
  `codex_apply`). The research note confirms Gemini 3.1 Pro scores 80.6 on
  SWE-bench Verified vs Codex at 85, making it a weaker code editor. Adding a
  `gemini_apply` write path would introduce path-validation infrastructure,
  worktree semantics, and apply-lock complexity for a model that is not a
  better writer.
- Options: (i) read-only `gemini_prompt` + `gemini_models` only; (ii) add
  `gemini_apply` with worktree isolation analogous to `codex_apply`.
- Selected: **(i) read-only**. Consultation is the only justified use;
  authoring goes to Codex. The gateway inherits the same fail-closed error
  taxonomy as `codex-gateway` without the write-path machinery.
- Revisit trigger: a future spec proposes `gemini_apply` with worktree
  isolation and demonstrates a benchmark gap that justifies the additional
  infrastructure.

### Decision: Capability triggers, not philosophical-diversity triggers

- Context: templerun's DT-Council dispatches by vendor diversity (ensure each
  architectural family is heard). The research note shows frontier models have
  correlated errors and that diversity-for-diversity's-sake does not improve
  accuracy at this scale. The 2026 evidence sweep (`docs/multi-vendor-coordination-research.md`
  §3, §7) is explicit: Self-MoA from a single top model beats heterogeneous
  MoA; martingale proof shows debate adds no expected value above voting.
- Options: (i) vendor-diversity trigger (always consult Gemini to get a
  different vendor's view); (ii) capability trigger (consult Gemini only when
  the task fits a documented strength).
- Selected: **(ii) capability triggers only**: long-context >200K tokens,
  ARC-AGI-2-style abstract reasoning, multimodal input, MCP tool coordination.
  These are empirically grounded in Gemini 3.1 Pro benchmark scores. When no
  trigger fires, Opus proceeds without consultation; the system degrades to
  single-vendor as intended.
- Revisit trigger: frontier-model bias profiles diverge enough — with a new
  published audit at Opus 4.x / Gemini 3.x tier — to make vendor-diversity a
  measurable accuracy signal for planning tasks.

### Decision: `deep` preset only at first

- Context: `balanced` users depend on predictable token spend. Adding a
  Gemini consultation dispatch on every capability-trigger task would
  increase spend in the `balanced` preset without V1–V6 evidence that the
  benefit justifies the cost. `minimal` is the Tier 3 escape hatch and must
  remain minimal.
- Options: (i) enable in `deep` only; (ii) enable in `deep` + `balanced`;
  (iii) enable in all presets.
- Selected: **(i) `deep` only**. `balanced` and `minimal` are unchanged.
  Rationale recorded in the Content Ownership Impact table.
- Revisit trigger: V1–V6 evidence shows that capability-trigger rate on
  `balanced` tasks is low and per-task token cost is contained; then enable
  in `balanced` via a follow-up spec.

## Acceptance Criteria

- [ ] `mcp-servers/gemini-gateway/server.py` compiles clean; no council
      vocabulary (`vendor_diversity_degraded`, R4 probe, seed-affinity, BoN)
      present in source.
- [ ] `gemini_prompt` and `gemini_models` tools are the only tools exposed.
- [ ] `templestay-gemini-consultant` has no Edit/Write tools and does not spawn
      subagents.
- [ ] `deep.json` enables `gemini-gateway`; `balanced.json` and `minimal.json`
      do not.
- [ ] `templestay-codex-delegation` skill has a §Capability-Routed Consultation
      section with triggers and anti-triggers matching §5.3 of the research note.
- [ ] `templestay-deep-think` skill has Long-context comprehension as the 6th
      optional lens with an advisory-evidence return contract.
- [ ] CLAUDE.md §Subagent map includes `templestay-gemini-consultant` with
      invocation condition.
- [ ] README §Boundaries records the read-only, evidence-only, `deep`-preset-only
      consultation path.
- [ ] No council, vote, consensus, mediator chain, AWAIT, or `.agent.md`
      semantics introduced.
- [ ] Existing `pytest -q` suite does not regress (V6).

## Verification Plan

| Check | Command or method | Expected result |
|---|---|---|
| **V1 — Static compile** | `python3 -m py_compile mcp-servers/gemini-gateway/server.py` | PASS |
| **V2 — JSON validity** | `python3 -c "import json; [json.load(open(p)) for p in ['claude/templestay/.mcp.json','claude/templestay/settings/presets/deep.json','claude/templestay/settings/presets/balanced.json','claude/templestay/settings/presets/minimal.json']]"` | PASS |
| **V3 — Server cold start** | `python3 mcp-servers/gemini-gateway/server.py < /dev/null` (stdio transport); must not crash on import | PASS |
| **V4 — Smoke (env-gated)** | Skip when `gemini` CLI not on PATH; otherwise call `gemini_models` and confirm envelope has `success`, `models` list | PASS or SKIP with reason |
| **V5 — Preset diff** | `git diff HEAD -- claude/templestay/settings/presets/` shows `gemini-gateway` only in `deep.json`; absent in `balanced.json` and `minimal.json` | PASS via manual diff review |
| **V6 — Test suite** | `pytest -q` from repo root | PASS, no regressions |

## 6. Open Questions / Future Work

- **Capability trigger heuristic**: the current proposal uses deterministic
  signals (token-count estimate, file count, explicit user flag). Opus
  judgment alone is not a sufficient trigger. The concrete thresholds
  (200K-token cutoff; file count N) should be refined after V1–V6 runtime
  evidence is available.
- **Consultation-result caching**: caching by `request_hash` + capability tag
  would avoid re-spending Gemini tokens on repeated consultations over the
  same evidence set. Deferred to a follow-up spec; requires memory MCP anchor
  schema extension.
- **`gemini_apply` write path**: not needed for capability consultation; Codex
  remains the sole write-path agent. Deferred; would require worktree
  isolation and `_validate_diff` logic analogous to `codex-gateway`.
- **`balanced` preset enablement**: deferred until V1–V6 evidence shows that
  capability-trigger rate on `balanced` tasks is low and per-task token cost
  is contained.

---
*Template: `specs/_templates/full.md` — for templestay L3+ root-native changes*
