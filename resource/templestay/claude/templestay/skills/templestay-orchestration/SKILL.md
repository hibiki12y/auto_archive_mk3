---
name: templestay-orchestration
description: "Use for non-trivial Claude Code repository tasks that benefit from explicit role separation, bounded subagent fan-out, or evidence-grounded reporting."
---

# templestay Orchestration

Native Claude Code orchestration discipline. The lifecycle itself is built in;
this skill captures the conventions that make a non-trivial run reproducible:

```text
Input → Atomize → Plan → Execute → Verify → Critique → Report
Verify → Execute
Critique → Atomize → Plan
```

Use `Verify → Execute` only for same-plan, in-scope, actionable Verify failures
with a concrete `execute_repair_target`. Hetero Critique findings return through
`Critique → Atomize → Plan`; do not short-circuit Critique directly to Execute.

The orchestrator role is the default operating posture for the templestay Claude
Code preset — see `CLAUDE.md` § Default Operating Posture. This skill is the
canonical reference for the delegation contract; the posture is always on, not
opt-in.

## Subagent Fan-out

- Default to proactive one-level fan-out when work units are value-diverse
  and merge-safe (parallel reads, an implementer plus an independent verifier,
  a researcher plus a coder). Skip fan-out for tightly coupled or trivial work.
- Keep fan-out one level deep. Do not spawn subagents from inside subagents.
- Shard broad audits before dispatch. If the work spans instructions, config,
  tests, live runtime, external services, or challenge review, split it into
  single-axis child lenses; the parent owns cross-axis synthesis.
- If a delegated lens is omitted that would normally apply, record the skip
  reason in the parent synthesis instead of silently narrowing coverage.
- Code authoring follows the three-tier routing in `templestay-codex-delegation`.
  Tier 3 (single-file textual nudges, lint/format runs, read-only analysis)
  stays on Sonnet leaves. Tier 2 (multi-file or >80-LOC authoring) defaults
  to `templestay-codex-coder` (Opus driver + Codex via codex-gateway). Tier 1
  (architecture, multi-domain, correctness-sensitive, or user-flagged hard)
  uses the Architect/Editor sequential pattern with a bounded executable-
  signal refinement loop (N=2). The SUBAGENT_TASK packet shape below is
  unchanged — Codex receives the same fields as a Sonnet leaf.

## Delegation Contract

Each delegated unit is a structured prompt that names the same fields a
`SUBAGENT_TASK` packet would carry, written as bullet sections (Claude
idiom — no literal packet block needed):

- **Concrete task** — the specific outcome the child must produce.
- **Scope and ownership** — paths, read/write boundary, forbidden actions.
- **Required actions** — what to inspect, run, or report.
- **Response budget** — output size cap, task-local timebox, partial-result
  rule when the child cannot finish.
- **Evidence contract** — what anchors must come back (paths, line numbers,
  command outputs, citations).

The first packet must be narrow enough to finish: name the files or question,
cap the response, set a stop condition. If a child times out or returns only
acknowledgement, retry once with a stricter minimal-result prompt; if that
also fails, close the lens, mark it degraded, and run a replacement inline.
Do not wait indefinitely for a child thread.

Children must return the same fields as a `SUBAGENT_RESULT`:

- **Status** — complete / partial / blocked / degraded.
- **Summary** — what was done or learned.
- **Evidence** — anchors, files checked, commands run, citations.
- **Blockers / residual risk** — what remains unresolved.
- **Degradation label** when applicable: `scope-degraded`, `runtime-degraded`,
  `tool-degraded`, or `evidence-degraded`.

Acknowledgement-only completions are degraded. Require evidence.

## Decomposition Quality Gate

Before execution, the plan should be:

- **solvable** — every unit has an executable owner and a path to a result;
- **complete** — acceptance checks and critical dependencies are covered;
- **non-redundant** — no duplicated units or overlapping ownership.

Run an Occam pass first: stronger context, tools, or verification often beat
adding more roles or wider search.

## Reporting

Use compact native output when a visible artifact is warranted:

- `[PLAN]` — decision-complete plan with executable work units, scope,
  assumptions, risk, and verification criteria.
- `[REPORT]` — completion summary for the current request.
- `[VERIFY]` — standalone verification summary.
- `[RISK]` — risk-focused note when residual risk dominates the output.

Prefer medium headings `* Summary:`, `* Implementation:`,
`* Verification:`, and `* Remaining Risk:`. Use compact status tokens at
Report:

- `PASS` — verified success or a sufficiently grounded read-only answer.
- `WARN` — useful work with a skipped check, degraded tool, or residual risk
  the user should know.
- `FAIL` — unresolved in-scope blocker.

All-passing verification should be a digest unless a check failed, warned,
was skipped, performed a live mutation, or the user requested audit detail.
Report closes the request — do not append continuation menus or next-turn
promises.

## Cost-Efficiency Policy

Claude quota is the binding constraint relative to Codex/GPT. Default to
`codex_prompt` (via `codex-gateway`) for token-heavy reasoning when:

- The task is synthesis or analysis over content already extracted from the repo.
- The task is multi-step abstract reasoning that does not need iterative tool use.
- The output is read-only consultation, not implementation.

Pattern:

1. Use Claude tools (`Read`, `templestay-explorer`) to gather the necessary file content.
2. Embed the extracted content directly in the `codex_prompt` prompt.
3. Ask Codex for synthesis, analysis, or critique.
4. The parent applies findings, or dispatches `templestay-coder` (Tier 3) or `templestay-codex-coder` (Tier 2/1) for any resulting edit.

Reserve Claude leaves for work that genuinely needs Claude tooling:

- Iterative read/grep loops — `templestay-explorer` and `templestay-reader` for file discovery and deep behavioral reads.
- Deterministic Bash and verification — `templestay-verifier`.
- Web research where `WebFetch` or `WebSearch` is required — `templestay-researcher`.
- Code authoring at all tiers — `templestay-coder` (Sonnet, Tier 3) and `templestay-codex-coder` (Tier 2/1, which already routes to Codex via `codex-gateway`).

This is cost-efficient default routing, not a hard rule. When the work is
correctness-critical, irreversible, or eligibility-gated for
`templestay-dt-audit`, the discipline of the contracted topology takes
precedence; cost-efficiency is secondary on that path.

## Boundaries

- Do not import Copilot approval-gate, session-reuse, `.agent.md` dispatch,
  mediator chains, or council/vote/consensus semantics.
- Hooks are optional hardening only. Correctness must not depend on them.
