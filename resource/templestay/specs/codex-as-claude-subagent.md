---
status: proposed
level: L3
type: integration
created: 2026-04-28
author: opus-orchestrator
relates_to: "docs/templestay-native-kernel.md"
---

# Spec: Codex CLI as a Claude leaf subagent (3-tier routing)

## 1. Requirements

### Problem

`claude/templestay` and `codex/templestay` are independent native surfaces.
Code authoring on the Claude side is delegated to `templestay-coder` (Sonnet)
across all non-trivial work, which means orchestration uses Opus for
planning/review and Sonnet for authoring even when accuracy or token-budget
distribution between the two existing subscriptions (Anthropic + OpenAI)
would benefit from using Codex as the implementer. There is no path today
for the Claude orchestrator to delegate to Codex.

### Goal

Add a leaf delegation path so Claude (Opus) can dispatch code authoring to
Codex CLI through a templestay-native MCP gateway, under a 3-tier complexity
routing scheme:

- **Tier 3** (single-file textual nudges, lint/format, read-only analysis):
  unchanged — Sonnet leaves keep ownership.
- **Tier 2** (multi-file or >80-LOC authoring, default for non-trivial code):
  defaults to a new `templestay-codex-coder` leaf that proxies to Codex via
  the gateway.
- **Tier 1** (architecture, multi-domain, correctness-sensitive, or user-
  flagged hard): same delegation, wrapped in an Architect/Editor sequential
  pattern with a bounded executable-signal refinement loop (max N=2 Codex
  re-dispatches), terminated by a post-loop `templestay-challenge` review.

Acceptance: each tier dispatches the right implementer, the gateway runs
Codex inside a detached worktree with validated apply-back, and Anthropic
token usage on a representative Tier 2 task drops measurably (target: ≤50%
of the Sonnet-only baseline).

### Constraints

- **No council, no vote, no consensus, no mediator chains, no `.agent.md`
  dispatch, no `AWAIT`.** Templestay README boundaries.
- **Leaf-only subagents.** `templestay-codex-coder` must not spawn
  subagents and must not be re-entered recursively.
- **Bounded refinement.** Tier 1 loop hard-capped at N=2.
- **No `Bash(codex:*)` allow-list.** Codex is reached only through the
  `codex-gateway` MCP server.
- **Detached-worktree apply-back only.** Codex never writes directly into
  the user's working tree.
- **Hooks remain optional.** Correctness must be enforced by the gateway,
  not by hook scripts.
- **Auto-memory disabled.** Memory is MCP only.
- **Reverse write delegation remains out of scope.** Codex may consult Claude
  read-only through `claude-gateway`; Claude never writes back into the repo.

### Out of Scope

- Reverse apply/write delegation (Codex → Claude). Read-only consultation is
  handled by `claude-gateway`.
- Multi-vendor / council / RULERS / Ultra-Team / dissent protocols from
  templerun.
- Replacing or deleting `templestay-coder` (Sonnet). It stays as the Tier 3
  / fallback owner.
- Replacing Codex-native behavior in `codex/templestay/` with Claude-specific
  runtime semantics.
- Adding a new SUBAGENT_TASK packet format. Reuse the existing one in
  `templestay-orchestration`.
- LLM-vs-LLM critique loops. Refinement signals are executable only.

## 2. Design

### Behavioral Model

Three-tier routing decided at ATOMIZE by the Opus orchestrator:

```
                        +-------------------+
   user request  ─────▶ |  Opus orchestrator |
                        |   (ATOMIZE phase)  |
                        +---------+----------+
                                  │ classify
              ┌───────────────────┼────────────────────┐
              ▼                   ▼                    ▼
         Tier 3              Tier 2 (default)      Tier 1 (core)
   templestay-coder    templestay-codex-coder  templestay-codex-coder
       (Sonnet)         + codex-gateway MCP        Architect/Editor
          │                      │                       │
          │              codex_apply (worktree)   deep-think + bounded
          │                      │                refinement (N=2)
          │                      ▼                       │
          │             templestay-verifier              ▼
          │                  (Sonnet)             templestay-verifier
          │                                              │
          ▼                                              ▼
        report                                    templestay-challenge
                                                     (post-loop)
                                                          │
                                                          ▼
                                                       report
```

Tier 1 sequence in detail (Shape B from the research record):

1. **PLAN** — Opus produces a free-form natural-language change plan,
   file-by-file. Aider rule applies: no whole-file dumps.
2. **EXECUTE iter 1** — `templestay-codex-coder` builds the Architect
   prompt, persists a SUBAGENT_TASK capsule with deterministic
   `session_id` and `request_hash`, then invokes `codex_apply`.
3. **VERIFY iter 1** — `templestay-verifier` (Sonnet) runs executable
   sensors. PASS → CHALLENGE. FAIL → iter 2.
4. **EXECUTE iter 2** — narrowed SUBAGENT_TASK with `feedback_context`
   (failed check + repair target only). New capsule with `-iter2` suffix.
5. **VERIFY iter 2** — same sensors. PASS → CHALLENGE. FAIL → STOP and
   escalate to user with the partial state.
6. **CHALLENGE** — `templestay-challenge` (Opus, RO) reviews the merged
   diff once. Post-loop only; not invoked between iterations.
7. **REPORT** — `[REPORT]` with `PASS` / `WARN` / `FAIL`.

Memory anchor key scheme (see `templestay-codex-delegation` skill for the
full contract). `session_id = templestay-{project_slug}-{request_hash}`,
deterministic from git toplevel + remote + canonical request text.

### Content Ownership Impact

| Surface | Current state | Proposed change | Owner |
|---|---|---|---|
| `mcp-servers/codex-gateway/server.py` | absent | NEW: slim port of `resource/templerun/copilot/mcp-servers/codex-gateway/server.py`, 3 tools (`codex_preflight` / `codex_prompt` / `codex_apply`), canonical `codex -a never exec --json --ephemeral -C <ws> -s <sandbox> -m <model> -o <out>` invocation | authoritative |
| `mcp-servers/codex-gateway/requirements.txt` | absent | NEW: `mcp>=1.0.0` only | authoritative |
| `claude/templestay/agents/templestay-codex-coder.md` | absent | NEW: leaf subagent, Opus driver, Architect role, no Edit/Write tools | authoritative |
| `claude/templestay/skills/templestay-codex-delegation/SKILL.md` | absent | NEW: 3-tier routing heuristic, Tier 1 Shape B protocol, SUBAGENT_TASK extensions | authoritative |
| `claude/templestay/.mcp.json` | 3 servers wired | + `codex-gateway` 4th entry | authoritative |
| `claude/templestay/settings/presets/balanced.json` | 3 servers enabled | + `codex-gateway` enabled | authoritative |
| `claude/templestay/settings/presets/deep.json` | 3 servers enabled | + `codex-gateway` enabled | authoritative |
| `claude/templestay/settings/presets/minimal.json` | minimal | unchanged (Tier 3 cheap-mode escape hatch) | authoritative |
| `claude/templestay/agents/templestay-coder.md` | "narrow implementation owner" | "Tier 3 + fallback" — description tightened | authoritative |
| `claude/templestay/skills/templestay-orchestration/SKILL.md` | fan-out + delegation contract | + paragraph cross-referencing 3-tier routing | authoritative |
| `claude/templestay/CLAUDE.md` | Claude Code Rules | + bullet on tiered code authoring + Codex leaf rules | authoritative |
| `README.md` | Boundaries | + bullet on Codex-as-leaf-subagent | authoritative |
| `docs/codex-as-subagent.md` | absent | NEW: rationale + research citations | authoritative |
| `specs/_index.md` | 1 current spec | + this spec | authoritative |
| `codex/templestay/**` | independent surface | Codex-native; later adds read-only `claude-gateway` consultation | independent |

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Codex writes outside `allowed_paths` | Medium | High | Detached worktree + `_validate_diff` rejects out-of-scope paths before apply-back |
| Concurrent `codex_apply` corrupts primary repo | Low | High | Per-repo `_repo_apply_lock`; primary HEAD/clean re-checked under the lock |
| Refinement loop spirals on adversarial failure | Low | Medium | Hard cap N=2 enforced by orchestrator and skill contract; escalate to user after cap |
| Architect prompt leaks whole-file dumps and balloons cost | Medium | Medium | Aider rule encoded in subagent body; Architect prompt template restated each call |
| Codex preflight unavailable (auth, binary missing) | Medium | Medium | Subagent calls `codex_preflight` first; on `degraded` returns `tool-degraded` for parent fallback to `templestay-coder` |
| Memory MCP capsule collision across retries | Low | Low | Deterministic `session_id` + `-iter{n}` suffix scheme |
| LLM-vs-LLM critique slip | Medium | High | Skill explicitly forbids Opus from grading Codex prose; loop trigger is executable signal only |

### Alternatives Considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Bash-subprocess-only subagent (no MCP gateway) | Simpler infra | Permission leakage, no clean validation boundary, every preset must allow `Bash(codex:*)` | Rejected |
| MCP gateway with no dedicated leaf agent | One fewer agent | Gateway calls leak into Opus thread; no sealed turn budget; breaks leaf-only fan-out idiom | Rejected |
| Dual implementation + reconciliation (council-ish) | Closer to "complementary" framing | Violates README boundaries; doubles token cost; SWE-bench leaders do not use this | Rejected |
| Architect/Editor sequential, no refinement loop | Matches Aider exactly | Tier 1 hard tasks lose accuracy on first miss; Reflexion shows executable-signal loops add measurable accuracy | Rejected for Tier 1; this is Tier 2's shape |
| **Architect/Editor sequential + bounded executable-signal refinement (Shape B)** | Aider production track record; Reflexion / Devin / Cursor 2.0 all use executable signals; honors every templestay constraint | Slightly more complex than no-loop variant | **Selected (Tier 1)** |

## 3. Work Units

| # | Work unit | Owner | Surfaces | Depends on |
|---|---|---|---|---|
| 1 | Slim port of codex-gateway MCP server with new CLI invocation form | codex-coder | `mcp-servers/codex-gateway/{server.py,requirements.txt}` | — |
| 2 | Wire codex-gateway into project MCP config | writer | `claude/templestay/.mcp.json` | 1 |
| 3 | Create `templestay-codex-coder` leaf subagent | writer | `claude/templestay/agents/templestay-codex-coder.md` | 1 |
| 4 | Create `templestay-codex-delegation` skill (3-tier + Shape B) | writer | `claude/templestay/skills/templestay-codex-delegation/SKILL.md` | 3 |
| 5 | Enable codex-gateway in balanced + deep presets | writer | `claude/templestay/settings/presets/{balanced,deep}.json` | 2 |
| 6 | Update `templestay-coder` description to Tier 3 / fallback | writer | `claude/templestay/agents/templestay-coder.md` | 4 |
| 7 | Cross-reference routing in orchestration skill + CLAUDE.md + repo README | writer | orchestration SKILL, CLAUDE.md, README.md | 4 |
| 8 | Rationale doc with research citations | writer | `docs/codex-as-subagent.md` | 4 |
| 9 | Spec index update | writer | `specs/_index.md` | 0 |
| 10 | Verification (V1–V6 from §Verification Plan) | verifier | tests/integration | 1–9 |

## 4. Decisions

### Decision: Hybrid (MCP gateway + thin leaf agent) over Bash-subprocess or gateway-alone

- Context: Three architectures were viable — Bash subprocess subagent, MCP gateway alone, or gateway + leaf agent.
- Options: see Alternatives table.
- Selected: **Hybrid**. Gateway gives an auditable boundary (path scoping, preflight, validated apply-back, classified errors, lock); leaf agent gives a sealed turn budget so Codex output never re-enters the Opus context except as a structured SUBAGENT_RESULT. Together they match templestay idioms (MCP-first, leaf-only) without new mediator/AWAIT semantics.
- Revisit trigger: if the gateway proves to be the bottleneck under load (lock contention) or if Anthropic ships native cross-vendor agent dispatch primitives.

### Decision: Tier 1 collaboration is Architect/Editor sequential + bounded executable-signal refinement (Shape B)

- Context: Two-strong-model collaboration shape was open. Researched 2026-04-28.
- Options: (A) sequential single pass, (B) sequential + bounded executable-signal refinement, (C) parallel + reconciliation (council-ish).
- Selected: **(B)**. (A) is the proven Aider production pattern; Reflexion/Devin/Cursor 2.0 all use executable-signal refinement on top of it; (C) is forbidden by README boundaries and not supported by SWE-bench leaders. Cap N=2 (Reflexion Ω=1–3, CTRL 3–5).
- Revisit trigger: if SWE-bench-class evidence emerges that bounded LLM-vs-LLM critique outperforms executable-signal critique with the same loop budget.

### Decision: Keep `templestay-coder` (Sonnet) as Tier 3 + fallback rather than removing it

- Context: User asked for "high-performance models only" but also a 3-tier scheme where simple/execution work uses Sonnet.
- Options: (i) remove Sonnet entirely, (ii) keep as Tier 3 + fallback, (iii) Sonnet as default.
- Selected: **(ii)**. The user clarified that Tier 3 work uses Sonnet. (ii) also preserves a fallback path when `codex_preflight` reports `degraded`.
- Revisit trigger: if Codex preflight stability proves high enough that the fallback is never used in practice.

### Decision: Reverse path is read-only consultation only

- Context: User asked for a complementary two-model arrangement; bidirectional
  Codex→Claude was initially deferred until Codex-side MCP routing was defined.
- Options: one-way / bidirectional write bridge / read-only reverse
  consultation.
- Selected: **read-only reverse consultation**. Codex can call
  `claude-gateway` for Claude-native surface review, architecture synthesis,
  instruction critique, or challenge evidence. There is no `claude_apply` and
  no recursive AgentBridge-style handoff.
- Revisit trigger: if a future requirement needs Claude-authored patches, write
  a separate detached-worktree/apply-back spec with the same path validation and
  executable-signal constraints as `codex_apply`.

## Acceptance Criteria

- [ ] Three-tier routing dispatches to the right implementer for V1-A/B/C prompts.
- [ ] `codex-gateway` MCP server exposes only `codex_preflight`, `codex_prompt`, `codex_apply`.
- [ ] Gateway invokes Codex with `codex -a never exec --json --ephemeral -C <ws> -s <sandbox> -m <model> -o <out> "<prompt>"`.
- [ ] `codex_apply` writes only inside the detached worktree until validated apply-back; primary repo HEAD is re-checked under per-repo lock.
- [ ] Out-of-scope diff produced by Codex is rejected at `_validate_diff` with `failure_stage=diff_validation`.
- [ ] Tier 1 refinement loop terminates at N=2 with user escalation rather than a third Codex pass.
- [ ] Memory capsules `codex-task-{request_hash}[-iter{n}]` and `codex-result-{request_hash}[-iter{n}]` round-trip via memory-v2.5 MCP with matching `session_id`.
- [ ] No `Bash(codex:*)` allow-list entry is added.
- [ ] `codex/templestay/**` stays Codex-native and may include read-only
  Claude consultation guidance.
- [ ] `templestay-codex-coder` has no Edit/Write tools and does not spawn subagents.
- [ ] No council, vote, consensus, mediator chain, AWAIT, or `.agent.md` semantics are introduced.

## Verification Plan

Test recipe restated from the implementation plan. PASS / WARN / FAIL per item.

| Evidence type | Required evidence | Timing |
|---|---|---|
| **V1 — Tier routing** | Three prompts (typo / 30-LOC new file / concurrent-safe MCP tool) dispatch to `templestay-coder`, `templestay-codex-coder`, and `templestay-codex-coder` with deep-think + challenge respectively | Integration |
| **V2 — Codex CLI invocation** | Gateway log shows the canonical `codex -a never exec --json --ephemeral -C <tmp>/codex-gateway-worktree-* -s workspace-write -m gpt-5.5 -o ...` line; user `pwd` unchanged during execution | Live runtime |
| **V3 — Memory round-trip** | `find $TEMPLATESTAY_MEMORY_ROOT -name 'codex-task-*' -o -name 'codex-result-*'` yields paired capsules with matching `request_hash`, `session_id`, schema `memory-v2.5`, service `templestay` | Live runtime |
| **V4 — Apply boundary** | Adversarial out-of-scope prompt yields `{success: false, failure_stage: "diff_validation", error_category: "diff_validation_error"}`; primary `git status` clean | Live runtime |
| **V5 — Refinement loop bound** | Forced-failure acceptance check produces exactly 2 codex_apply calls (initial + 1 refinement) and a user escalation, never a third | Live runtime |
| **V6 — Token accounting** | Same Tier 2 task with vs without codex-gateway enabled — Anthropic-side input/output tokens reduced ≥30% (PASS), 0–30% (WARN), regression (FAIL) | Live runtime, comparative |

---
*Template: `specs/_templates/full.md` — for templestay L3+ root-native changes*
