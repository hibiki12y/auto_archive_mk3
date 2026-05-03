---
name: templestay-codex-delegation
description: "Three-tier routing for code authoring in templestay. Tier 2 is the default at ATOMIZE for any code-authoring work unit — reach for this skill there. Tier 3 stays on Sonnet leaves; Tier 2 delegates to Codex via codex-gateway; Tier 1 wraps Codex in Architect/Editor with bounded N=2 refinement."
---

# templestay Codex Delegation

Routing discipline for code-authoring work in the dual-subscription
(Claude + Codex) configuration. The orchestration rules in
`templestay-orchestration` still apply — this skill is a routing overlay,
not a replacement.

This skill operates under the always-on orchestrator posture defined in `CLAUDE.md` § Default Operating Posture.

## Three-Tier Routing

The orchestrator classifies each code-authoring work unit at ATOMIZE.

### Tier 3 — Simple / Execution

Triggers (any of):

- Single-file textual nudge: typo, comment, doc-string, log message, error
  string. ≤30 LOC, no new symbols, no test changes.
- Pure execution: lint, format, run tests, pin a dependency line.
- Read-only analysis, file discovery, fact gathering.

Implementer: `templestay-coder` (Sonnet) for trivial code, or the existing
Sonnet leaf agents (`templestay-explorer`, `templestay-reader`,
`templestay-researcher`, `templestay-verifier`, `templestay-writer`) for
their respective lenses.

Verification: inline by the parent. No refinement loop.

### Tier 2 — Normal (default for non-trivial code)

Triggers (any of):

- Multi-file change within a single domain (~2–5 files).
- New feature or refactor with clear scope; expected diff > ~80 LOC.
- New tests for new behavior, with the implementation.
- The user did not flag the task as core / hard / deep.

Implementer: `templestay-codex-coder`. The Opus driver builds the Architect
prompt; Codex executes via `mcp__codex-gateway__codex_apply`.

Verification: `templestay-verifier` (Sonnet) runs the relevant executable
sensors (pytest, typecheck, lint, focused build).

Refinement: on first failure, the parent re-dispatches `templestay-codex-coder`
once with a narrowed SUBAGENT_TASK that names the failed check and the
specific repair target. If the second pass also fails, **escalate to Tier 1**
rather than running a third pass.

### Tier 1 — Core / High-difficulty

Triggers (any of):

- Architecture decision: module boundary, API surface, data model, schema
  change, public interface contract.
- Multi-domain change: instructions + config + tests + runtime, or any 3+
  axis split.
- Correctness-sensitive: concurrency, locking, transactions, retry logic,
  authentication, sandboxing, data integrity, migration safety.
- User explicitly flagged: "deep", "hard", "core", "tricky", "be careful".
- Tier 2 escalation after two failed verify passes.

Implementer: `templestay-codex-coder` operating in **Shape B** (see below).
Verifier: `templestay-verifier` plus a final post-pass by `templestay-challenge`
(Opus, read-only) — *outside* the refinement loop.

Refinement: bounded executable-signal loop, max **N = 2** Codex re-dispatches.
On the third would-be pass, stop and escalate to the user with the partial
result and the unresolved checks.

## Tier 1 Shape B — Architect/Editor with bounded refinement

Sequence:

```
ATOMIZE
  └─ templestay-deep-think (lenses chosen by ambiguity, not all of them)
PLAN
  └─ Opus writes a free-form natural-language change plan (no whole-file dumps)
EXECUTE (iter 1)
  ├─ templestay-codex-coder builds Architect prompt + persists SUBAGENT_TASK
  └─ codex_apply (detached worktree → diff-validate → apply-back)
VERIFY (iter 1)
  └─ templestay-verifier runs executable sensors
  ├─ PASS → CHALLENGE
  └─ FAIL → EXECUTE (iter 2) with narrowed SUBAGENT_TASK + feedback_context
       VERIFY (iter 2)
         ├─ PASS → CHALLENGE
         └─ FAIL → STOP, escalate to user
CHALLENGE
  └─ templestay-challenge (Opus, RO) reviews the merged diff and final state
REPORT
```

Hard rules:

- **No model-vs-model critique inside the loop.** Refinement is triggered
  only by executable signals (test exit codes, typecheck failure, lint
  failure, missing files, out-of-scope diff). Opus does not "judge" Codex's
  prose; it reformulates the SUBAGENT_TASK based on the executable evidence.
- **`templestay-challenge` is post-loop only.** It runs once, after the loop
  has terminated successfully. Do not invoke it as a critic between
  iterations.
- **The loop bound N=2 is hard.** Three Codex calls per dispatch maximum,
  including the initial pass. After the cap, stop and report.
- **Every iteration writes its own memory capsule.** Use suffix `-iter{n}` so
  the trail is auditable.

Research basis: Aider Architect/Editor (free-form plan → narrow editor
prompt, no architect re-review of the diff text), Reflexion's executable-
signal evaluator on HumanEval, Cursor 2.0's worktree-isolated iterate-until-
correct flow, Cline's Opus-Plan → Sonnet-Act pairing data. Full citations
in the spec at `specs/codex-as-claude-subagent.md`.

## Capability-Routed Consultation

A separate routing path from the three tiers above. Where the tiers
classify code-authoring work, this path classifies *consultation* work —
PLAN-time evidence-gathering that benefits from a backend with a
documented capability advantage neither Opus nor Codex matches. The
classification is independent of the Tier 3/2/1 routing; a single work
unit may invoke a consultation at PLAN time and then proceed through any
of the three tiers at EXECUTE time.

> Naming note: this skill remains `templestay-codex-delegation` for
> historical continuity. The routing it carries now spans both Codex code
> authoring (Tiers 1–3) and Gemini consultation (this section); a future
> rename is out of scope.

### Capability triggers

Invoke `templestay-gemini-consultant` only when the parent's PLAN-time
analysis identifies one of the four capability hints below. The consultant
will refuse the dispatch if the hint is missing or unjustified.

- **long_context** — input artifact set > ~200K tokens (whole-repo scan,
  large PDF/spec ingest, multi-file dependency mapping). Gemini's 1M-token
  context window is the documented strength; Codex and Opus have narrower
  effective context for one-shot prompts.
- **abstract_reasoning** — ARC-AGI-2-style abstract / structural / pattern
  problems where Gemini 3.x has a documented benchmark advantage
  (ARC-AGI-2 score 77.1).
- **multimodal** — image, diagram, video, or mixed-media reasoning where
  Gemini's multimodal stack is the relevant signal.
- **tool_coordination** — tasks that require orchestrating several MCP
  tools; Gemini's MCP Atlas score (69.2) is the relevant capability anchor.

### Anti-triggers

Do **not** invoke `templestay-gemini-consultant` for:

- Patch generation, diff authoring, test scaffolding — that is Codex's
  lane via `templestay-codex-coder`. Gemini scores lower than Codex on
  SWE-bench Verified (80.6 vs. 85) and is not a better editor.
- Code review by an LLM. Executable signals (tests, typecheck, lint) are
  the only cross-cutting critic in templestay. The consultant will refuse
  if asked to grade Codex's output or any other model's output.
- Splitting a single decision across two backends to average their
  recommendations — explicitly forbidden as council-style aggregation.
- Anything inside the Tier 1 refinement loop. Consultation is a PLAN-time
  evidence input, before the executable-signal loop starts. Adding Gemini
  inside the loop reintroduces LLM-vs-LLM critique that the loop bound
  was designed to prevent.

### Dispatch shape

Sequence (parent owns this; the consultant runs as one leaf dispatch):

1. **PLAN** — the parent (Opus) classifies whether the work has a
   capability-justified consultation trigger. If no trigger fires, skip
   the consultation and proceed directly to Tier 3/2/1 routing.
2. **CONSULT (one dispatch only)** — dispatch `templestay-gemini-consultant`
   with the SUBAGENT_TASK fields below. The consultant will validate the
   trigger, call `mcp__plugin_templestay_gemini-gateway__gemini_prompt`
   once, and return evidence.
3. **READ EVIDENCE** — the parent reads the returned evidence as input to
   its plan. The consultation result is *not* a vote, *not* a critique of
   any other model's output, and *not* a decision the parent must adopt.
4. **CONTINUE** — proceed to Tier 3/2/1 routing as normal. The
   consultation result may be referenced in the Architect prompt sent to
   Codex, but Gemini does not enter the refinement loop.

Hard rules:

- **One consultation per work unit.** Multiple consultations on the same
  work unit re-introduce council-style aggregation; not permitted.
- **Consultation is read-only.** The gateway exposes no write capability
  by spec. Codex remains the sole writer via `codex_apply`.
- **Consultation is PLAN-time only.** Never inside the Tier 1 refinement
  loop, and never as a post-loop critic (that is `templestay-challenge`'s
  job, and `templestay-challenge` is read-only and Opus-only).
- **No LLM-vs-LLM critique.** The consultant refuses to grade any other
  model's output. The parent must not ask it to.

### SUBAGENT_TASK fields for consultation

Reuses the standard `templestay-orchestration` SUBAGENT_TASK fields plus
these consultation-specific extensions (see also the consultant agent
file for the full contract):

- **capability_hint** — one of `long_context` / `abstract_reasoning` /
  `multimodal` / `tool_coordination`. Required. The consultant returns
  `blocked` if missing or invalid.
- **model** — explicit Gemini model id (e.g. `gemini-3.1-pro-preview`);
  empty defers to `GEMINI_DEFAULT_MODEL` then to gateway repo-fallback.
- **timeout_sec** — optional; gateway clamps non-integer / zero / negative
  to the 120s default.

### Result shape (consultation)

`templestay-gemini-consultant` returns a SUBAGENT_RESULT with the
standard fields plus:

- **gemini_evidence** — verbatim Gemini response text in an attributed
  block. Not paraphrased.
- **evidence_metadata** — `model`, `tokens` (input/output), `latency_ms`,
  gateway `error_category` if any.
- **degradation_label** — `memory-record-degraded`,
  `runtime-degraded`, `tool-degraded`, or
  `capability-trigger-unjustified` when applicable.

## SUBAGENT_TASK fields (extending templestay-orchestration)

The standard `templestay-orchestration` fields apply. The Codex path adds:

- **model** — explicit Codex model id (e.g. `gpt-5.5`); empty defers to
  `CODEX_DEFAULT_MODEL` then to gateway `repo-fallback`.
- **sandbox** — `workspace-write` for `codex_apply`, `read-only` for
  `codex_prompt` (the gateway enforces the right one per tool).
- **expected_head** — 40-hex commit id the worktree is created at. The driver
  derives it via `git rev-parse HEAD` if the parent did not pass one.
- **allowed_paths** — repo-relative scopes (files or `dir/`). The diff
  validator rejects any out-of-scope change. **Never `**`, never absolute.**
- **forbidden** — explicit list of actions Codex must not take, in addition
  to the universal "do not modify hooks, gateway server, or files outside
  allowed_paths".
- **feedback_context** (refinement passes only) — `failed_check: <name>`,
  `repair_target: <file:line or symbol>`, `evidence_tail: <≤20 lines>`.

## Result shape

`templestay-codex-coder` returns a SUBAGENT_RESULT with the standard fields
plus:

- **changed_files** — exactly what `codex_apply` reports.
- **failure_stage** — gateway enum if any: `request_validation`,
  `primary_precheck`, `worktree_prepare`, `codex_execution`,
  `diff_validation`, `apply_recheck`, `apply_back`, `cleanup`.
- **cleanup_status** — `clean`, `cleanup_failed`, `not_created`.
- **usage** — Codex token usage record from the JSONL event stream when
  available.

Acknowledgement-only completions are degraded; the loop must not advance.

## Memory anchor key scheme

The standard `templestay-memory` task anchor format applies. For Codex
dispatches, use deterministic identifiers so retries and refinement passes
collide with the original anchor:

- `session_id` = `templestay-{project_slug}-{request_hash}`
  - `project_slug` = `sha256(git toplevel + remote.origin.url)[:12]`
  - `request_hash` = `sha256(canonical user request + project_slug)[:10]`
- Pre-call name: `codex-task-{request_hash}` or `codex-task-{request_hash}-iter{n}`
- Post-call name: `codex-result-{request_hash}` or `codex-result-{request_hash}-iter{n}`

## Boundaries

- No reverse write delegation. Codex may consult Claude read-only through
  `claude-gateway`, but there is no `claude_apply`, no recursive callback into
  this Tier 1/2 loop, and no AgentBridge-style bidirectional handoff.
- No council, no vote, no consensus, no mediator chains, no `.agent.md`
  dispatch, no Copilot-style approval gating, no auto-memory.
- No `Bash(codex:*)` allow-list. Codex is invoked only through the
  `codex-gateway` MCP server.
- No nested subagent dispatch from `templestay-codex-coder`. It is a leaf.
- No silent scope widening. If `allowed_paths` are too narrow, return
  `blocked` with the specific path the next pass would need.
