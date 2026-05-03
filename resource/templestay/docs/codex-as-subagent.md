# Codex CLI as a Claude Leaf Subagent

This document explains *why* `templestay` exposes the OpenAI Codex CLI as a
leaf subagent of Claude Code, what we are deliberately not doing, and the
research that grounds the chosen collaboration shape.

The implementation lives in:

- `mcp-servers/codex-gateway/server.py` — slim port of the original
  templerun codex-gateway (the templerun reference submodule has since been
  removed from the tree; the port is the only surviving copy of the
  detached-worktree apply bridge)
- `claude/templestay/agents/templestay-codex-coder.md` — leaf subagent
- `claude/templestay/skills/templestay-codex-delegation/SKILL.md` — routing
- `specs/codex-as-claude-subagent.md` — full spec

## Why two subscriptions, two models

Users of `templestay` typically already hold both an Anthropic Claude
subscription (Opus orchestration; Sonnet/Haiku for fast leaf work) and an
OpenAI Codex subscription. The default Claude Code orchestration uses Opus
to plan and Sonnet to author code. That is fine, but it leaves the Codex
subscription idle and concentrates token spend on a single vendor.

The goal of templestay's Codex integration is the opposite of "model
multiplexing for the sake of it": **use only high-performance models on
each side of the dispatch, and route work to the model best suited for it.**
Specifically:

- **Opus** orchestrates, atomizes, plans, reviews, and verifies. Its
  deep-thinking and challenge skills are the value Anthropic offers.
- **Codex** authors code. It is strong on multi-file refactors, diff
  generation, and test scaffolding when given a tight specification.
- **Sonnet** stays Sonnet for genuinely simple work (typos, doc strings,
  lint runs) and as a fallback when Codex preflight is degraded.

The result is a token-budget split that uses Claude tokens where reasoning
matters most and Codex tokens where authoring matters most. We measure this
on real tasks (see V6 in the spec), targeting ≥30% reduction in Anthropic
token spend on a representative Tier 2 task.

## Why a hybrid (MCP gateway + thin leaf agent), not Bash subprocess

Three architectures were viable:

1. **Bash-subprocess-only subagent** — every preset would have to allow
   `Bash(codex:*)`. Path scoping, repo-state preflight, secret screening,
   diff validation, and apply-back logic would live inside an LLM prompt.
   That violates templestay's "Correctness must not depend on hooks" rule —
   the only correctness boundary becomes prompt discipline.

2. **MCP gateway alone, no dedicated subagent** — Codex calls leak into the
   Opus thread. Every read/edit Codex performs spends Opus tokens, which
   defeats the token-budget rationale. It also breaks the leaf-subagent
   fan-out idiom.

3. **Hybrid** — the gateway is the deterministic, auditable boundary
   (path scoping, preflight, validated apply-back, classified errors,
   per-repo lock — all proven in the original templerun codex-gateway,
   slim-ported into `mcp-servers/codex-gateway/server.py`). The
   subagent (`templestay-codex-coder`) provides a sealed turn budget, so
   Codex output re-enters Opus only as a structured SUBAGENT_RESULT.

We chose the hybrid. It is the one that matches templestay's existing
idioms (MCP-first runtime, leaf-only subagents) without inventing new
mediator/AWAIT semantics.

## Tier 1 collaboration: Architect/Editor + bounded executable-signal refinement

For genuinely hard, core, or multi-domain tasks, "dispatch Codex once" is
not always enough. The question was: when Codex's first pass misses the
acceptance check, how should Opus collaborate?

We surveyed production systems and recent research (full report:
`/home/deepsky/.claude/plans/claude-submodule-cozy-dijkstra-agent-ad16e9bf8ce8f3dc8.md`).
The dominant pattern in production is **sequential Architect/Editor with
one-shot handoff and executable-signal feedback**:

- **Aider's Architect mode** (Sep 2024) — strong reasoner produces a
  free-form natural-language plan; editor model translates into a strict
  diff format. Architect does **not** re-review the editor's diff. Source:
  `aider/coders/architect_coder.py`. Production pairing o1-preview architect
  + Sonnet editor scored 82.7% on Aider's diff bench.
  → <https://aider.chat/2024/09/26/architect.html>
- **Cline's Plan/Act mode** — Plan-mode model (often Opus 4.1) discusses
  the approach; Act-mode model (often Sonnet 4) executes. 2025 telemetry:
  Opus → Sonnet is the leading cross-mode pair at 25.3%.
  → <https://cline.bot/blog/plan-act-model-usage-patterns-in-cline>
- **Cursor 2.0 Plan Mode + Composer** — Plan Mode produces an editable
  plan object; agents run in **git worktrees** for isolation; iterate via
  executable signals; "run multiple, pick best" (selection, not voting).
  → <https://cursor.com/blog/2-0>

The refinement loop (when the first pass fails) is grounded in:

- **Reflexion** (Shinn et al., NeurIPS 2023) — Actor + Evaluator + verbal
  Self-Reflection. Strongest results are on HumanEval, where the evaluator
  is unit tests, not an LLM. Memory bound Ω = 1–3 trials.
  → <https://arxiv.org/abs/2303.11366>
- **Devin's Debugger loop** — adversarial Critic before execution; Debugger
  loops on test failure.
  → <https://cognition.ai/blog/introducing-devin>
- **CTRL** (2025) — bounded 3–5 round generator-critic loop, where the
  critic is trained for the role.
  → <https://arxiv.org/abs/2502.03492>

We pick **Shape B**: Aider's sequential Architect/Editor as the inner
pass, wrapped in a bounded refinement loop only when *executable* sensors
fail (pytest, typecheck, lint, file-existence, out-of-scope diff). Hard
cap **N = 2**. Opus chooses *whether* and *what* to re-dispatch, but never
plays LLM-judge over Codex's prose — that is the slip toward
council/consensus the templestay README forbids.

SWE-bench Verified 2026 leaders are single-strong-model agent loops with
executable signals (Claude Mythos Preview 93.9%, Opus 4.7 Adaptive 87.6%,
GPT-5.3 Codex 85%); multi-agent gains come from search-subagents, not
LLM-vs-LLM critics.
→ <https://swebench.com/>

## Boundary: detached-worktree apply-back only

Codex never writes into the user's working tree. The gateway:

1. validates the request (canonical `repo_root`, 40-hex `expected_head`,
   non-empty repo-relative `allowed_paths` — never `**`, never absolute);
2. asserts the primary repo HEAD matches and the worktree is clean;
3. creates a detached `git worktree` at `expected_head` in a tempdir;
4. runs Codex with `-s workspace-write` inside that worktree;
5. validates the resulting diff (`A`/`M`/`D` only, no symlinks/submodules,
   no mode changes, no binary-heavy entries, every path in `allowed_paths`);
6. re-checks the primary repo's HEAD and clean state under a per-repo
   lock;
7. `git apply --check` then `git apply` the patch;
8. verifies the primary's content matches the worktree's;
9. cleans up the worktree on every exit path.

If any step fails, the gateway returns a structured envelope with
`failure_stage` and `error_category`, leaving the user's tree untouched.

This pattern is templerun-proven and mirrors Cursor 2.0's worktree
isolation. It gives Opus a deterministic post-condition (`changed_files`,
`cleanup_status`, `failure_stage`) that `templestay-verifier` can act on
without re-reading the working tree.

## What we are deliberately not doing

1. **Reverse write delegation (Codex → Claude).** Still out of scope. Codex may
   consult Claude read-only through `mcp-servers/claude-gateway/`, but there is
   no `claude_apply`, no reverse edit bridge, and no recursive AgentBridge-style
   handoff.
2. **Council / vote / consensus / multi-vendor arbitration.** Forbidden by
   templestay's README boundaries. AutoGen-style group-chat is the
   explicit counter-example to avoid.
   → <https://github.com/microsoft/autogen> (cautionary)
3. **LLM-vs-LLM critique loops.** The refinement signal is *executable*
   only. Opus never grades Codex's prose. This is what keeps the loop
   from sliding into council-style reconciliation.
4. **Whole-file dumps in the Architect prompt.** Aider's rule is encoded
   in the subagent body. Architects describe changes file-by-file in
   natural language and quote only surrounding lines.
5. **`Bash(codex:*)` allow-list.** Codex is invoked only through the
   `codex-gateway` MCP server. Permission semantics stay clean.
6. **Nested subagent dispatch from `templestay-codex-coder`.** It is leaf,
   one-level fan-out only.
7. **Auto-memory.** Memory remains MCP-only. Capsules are written to
   `memory-v2.5` with deterministic `session_id` and `request_hash`.
8. **Replacing or removing `templestay-coder`.** Sonnet stays as the
   Tier 3 / cheap-mode / fallback owner.

## Operational notes

- `CODEX_DEFAULT_MODEL` env var sets the Codex model the gateway uses by
  default. Falls back to `gpt-5.5` if unset. Explicit per-call `model`
  argument overrides both.
- `CODEX_BIN` env var sets the Codex CLI path. Falls back to `which codex`
  then `/usr/local/bin/codex`.
- `TEMPLATESTAY_MEMORY_ROOT` is the shared memory root for both Claude and
  Codex memory-v2.5 capsules. Defaults to `~/.templestay/memory-v2`.
- `codex-gateway` is enabled by default in the `balanced` and `deep`
  presets. The `minimal` preset deliberately omits it (Tier 3 escape
  hatch).
- `CLAUDE_BIN` and `CLAUDE_DEFAULT_MODEL` configure the read-only
  `claude-gateway` used by Codex. The Codex `balanced` and `deep` presets
  register it in `~/.codex/config.toml`; `minimal` omits it. The Codex
  installer defaults `CLAUDE_DEFAULT_MODEL` to `claude-opus-4-7` and
  `CLAUDE_DEFAULT_EFFORT` to `max`, and policy-preauthorizes the standard
  Critique evidence bundle with
  `CLAUDE_GATEWAY_DESTINATION_TRUST=trusted_internal` and
  `CLAUDE_GATEWAY_ALLOW_REPO_CONTENT=true`. This lets `templestay-verifier` run
  the regular Claude Opus 4.7 max-effort Critique lane for non-trivial
  Codex changes after same GPT-family Verify without a separate per-call
  transfer prompt. That lane sends only a secret-screened patch summary,
  relevant diff excerpts, and sensor results; if the gateway/data-transfer path
  is degraded, the verification/Critique report records the degradation rather than
  silently skipping it. When the runtime treats
  `claude-gateway` as an external data-transfer boundary, the verifier may send
  repository-derived summaries, diffs, logs, or file details without per-call
  explicit external-transfer approval when
  `claude_preflight().content_transfer_policy.content_transfer_allowed` is true.
  That state requires `trusted_internal` destination trust plus the runtime
  repository-content allow flag. If policy preauthorization or destination trust
  is not established, the Critique lane may run only a no-repository synthetic
  connectivity check and must report content-bearing Critique as
  degraded. The gateway exposes that decision through
  `claude_preflight().content_transfer_policy` and `claude_route_probe`.

## See also

- `claude/templestay/skills/templestay-codex-delegation/SKILL.md` — the
  routing skill (Tier 1/2/3 heuristic, Shape B sequence, SUBAGENT_TASK
  field extensions).
- `specs/codex-as-claude-subagent.md` — the full spec including risk
  table, alternatives, decisions, and the V1–V6 verification plan.
- The original templerun codex-gateway is no longer kept in tree; the
  slim port at `mcp-servers/codex-gateway/server.py` is the canonical copy.
