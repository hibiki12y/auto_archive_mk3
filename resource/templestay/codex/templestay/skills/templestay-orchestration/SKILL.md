---
name: templestay-orchestration
description: "Use for non-trivial Codex repository tasks that need explicit role separation, bounded subagent fan-out, evidence-grounded reporting, or cross-runtime consultation."
---

# templestay Orchestration

Codex-native orchestration discipline. Use the lifecycle for non-trivial work:

```text
Input → Atomize → Plan → Execute → Verify → Critique → Report
Verify → Execute
Critique → Atomize → Plan
```

## Input Anchor

At Input, preserve the task anchor: request, project, constraints, acceptance
checks, excluded scope, safety boundary, verification expectations,
`loop_index=0`, current phase, and stop condition. Select `max_loop_budget`
during Atomize after decomposition, risk, and ambiguity are known. For looping
or long-running work, persist the anchor through the memory MCP using the
`templestay-memory` skill, updating it once Atomize chooses the budget.

## Atomize Interpretation Pass

At Atomize, choose the bounded loop budget from `1`, `3`, `5`, or `10`. For the
initial Atomize pass, strengthen problem interpretation before planning: restate
the requested outcome, acceptance checks, constraints, exclusions, safety
boundary, and material ambiguities. Ask concise clarifying questions only when
continuing by assumption would be unsafe or likely wrong; otherwise proceed
with explicit assumptions. For a recursive Atomize reached from Critique, keep
the existing loop budget and re-slice only around `failed_check`, evidence, the
in-scope repair target, `updated_assumption`, and the next acceptance check.
For a same-plan Verify failure, do not re-enter Atomize: record
`execute_repair_target`, return to Execute, and repeat the relevant Verify check.
If the Verify failure invalidates the plan, let Critique/Atomize re-slice it.

## Default Operating Posture

The parent Codex thread is the orchestrator for non-trivial requests: atomize,
plan, dispatch bounded leaves when they add independent value, synthesize
evidence, verify, critique, and report. Codex remains the repository writer.
External model gateways are consultation inputs only:

- `claude_prompt` via `claude-gateway` — read-only consultation for
  architecture synthesis, Anthropic-native Claude surface review, instruction
  critique, or high-level challenge over content the parent already extracted.
- `gemini_prompt` via `gemini-gateway` — read-only capability-routed
  consultation for long-context, abstract reasoning, multimodal, or tool
  coordination cases.

Gateway responses are evidence, not votes or decisions. Do not ask another
model to grade Codex output as an authority; executable checks remain the
cross-cutting evaluator. Codex-specific Verify/Critique separation is:
`templestay-verifier` runs deterministic sensors and same GPT-family Verify,
then the regular hetero Critique lane runs a single read-only Claude Opus 4.7
double-check via `claude-gateway` for non-trivial Codex changes.

## Subagent Fan-out

Default to proactive one-level fan-out for non-trivial work when units are
value-diverse and merge-safe (parallel reads, an implementer plus an independent
verifier, a researcher plus a writer). Skip fan-out for tightly coupled or
trivial work.

- Keep fan-out one level deep — Codex subagents are leaves.
- Shard broad audits before dispatch into single-axis lenses; the parent owns
  cross-axis synthesis.
- If a delegated lens is omitted that would normally apply, record the skip
  reason in the parent synthesis rather than silently narrowing coverage.
- Read-only consultation leaves (`templestay-claude-consultant`,
  `templestay-gemini-consultant`) are normally PLAN-time evidence inputs, never
  a refinement-loop critic. The regular hetero Critique double-check is handled
  through `templestay-verifier` with Claude Opus 4.7 and does not create a vote
  or binding decision.

## Delegation Contract

Each delegated unit ships as a `SUBAGENT_TASK` with:

- **Concrete task** — the specific outcome the child must produce.
- **Scope and ownership** — paths, read/write boundary, forbidden actions.
- **Required actions** — what to inspect, run, or report.
- **Response budget** — output size cap, task-local timebox, partial-result
  rule when the child cannot finish.
- **Evidence contract** — what anchors must come back (paths, line numbers,
  command outputs, citations).

Make the first packet narrow enough to finish. If a child times out or returns
acknowledgement-only, retry once with a stricter minimal-result packet; if that
fails, close the lens, mark it degraded, and run a replacement inline.

Children must return a `SUBAGENT_RESULT`:

- **Status** — complete / partial / blocked / degraded.
- **Summary** — what was done or learned.
- **Evidence** — anchors, files checked, commands run, citations.
- **Blockers / residual risk** — what remains unresolved.
- **Degradation label** when applicable: `scope-degraded`, `runtime-degraded`,
  `tool-degraded`, or `evidence-degraded`.

Acknowledgement-only completions are degraded; require evidence.

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

All-passing verification should be a digest unless a check failed, warned, was
skipped, performed a live mutation, or the user requested audit detail. Report
closes the request — do not append continuation menus or next-turn promises.

## Cost-Efficiency Policy

Default to local Codex execution for implementation. Use `claude_prompt` only
when Claude-specific strengths are material and the consultation is read-only:

1. Use Codex tools/subagents to gather the necessary file content.
2. Embed extracted content directly in the `claude_prompt` prompt.
3. Ask Claude for evidence-form findings, not code edits or binding decisions.
4. The parent applies findings through normal Codex implementation and
   deterministic verification.

Reserve Codex leaves for iterative repo work: file discovery, edits, tests,
same GPT-family verification, and documentation updates. The verifier leaf may
add its required Claude Opus 4.7 Critique after local sensors. This is a
cost/strength routing heuristic, not a council mechanism.

## Boundaries

- Do not import Copilot approval gates, session-reuse, `.agent.md` dispatch,
  mediator chains, council/vote/consensus semantics, or Copilot-era question
  wrappers.
- Do not add `claude_apply`. Claude and Gemini gateways are read-only by
  design; repository mutation stays in Codex.
- Hooks are optional hardening only. Correctness must not depend on them.
