---
name: templestay-claude-consultation
description: "Use when a Codex task benefits from read-only Claude Code consultation through claude-gateway: Claude-native surface review, architecture synthesis, instruction critique, or high-stakes challenge evidence. No writes, no votes, no LLM-vs-LLM critique loop."
---

# templestay Claude Consultation

Routing discipline for Codex → Claude read-only consultation through the
`claude-gateway` MCP server. This is a mirror of Claude-side gateway discipline,
not a reverse apply bridge: Claude returns evidence; Codex owns edits and
verification.

## When to invoke

Invoke only when the parent PLAN-time analysis identifies a material reason that
Claude adds evidence the Codex parent should not synthesize alone:

- **claude_native_surface** — the artifact is primarily `CLAUDE.md`, Claude
  plugin metadata, Claude Code hooks/settings, or Anthropic-native workflow
  semantics.
- **architecture_synthesis** — the parent has already extracted the relevant
  repo content and wants a read-only architecture synthesis or failure-mode map.
- **instruction_review** — the task is instruction/prompt policy where concise
  natural-language critique is the useful artifact.
- **high_stakes_challenge** — a manual, bounded challenge lens is useful before
  committing to a plan, but DT Audit is not warranted.

## Anti-triggers

Do **not** invoke Claude consultation for:

- Patch generation, diff authoring, test scaffolding, or repo writes. Codex is
  the editor; this gateway exposes no `claude_apply`.
- LLM-vs-LLM judging of Codex output. Executable signals (tests, typecheck,
  lint, schema parse, file assertions) are the evaluator. The narrow exception
  is the Codex `templestay-verifier` contract, which performs one read-only
  Claude Opus 4.7 hetero Critique after executable/static sensors and treats
  the response as evidence, not a verdict.
- Splitting a single decision across vendors to average recommendations.
- Anything inside a verification repair loop, except the one-shot
  `templestay-verifier` Critique described above. Consultation is
  PLAN-time evidence or a single post-Verify Critique lens, not an
  iterative critic.

## Dispatch shape

1. Gather the needed file excerpts with Codex tools or subagents.
2. Build a plain-text prompt that states the capability reason, the concrete
   task, evidence-format expectations, and forbidden actions.
3. Call `mcp__claude-gateway__claude_prompt` (or the plugin-prefixed alias) with
   `prompt`, optional `model`, `timeout`, and `max_turns`.
4. Read the response as attributed evidence. Do not treat it as a binding
   decision.
5. Continue through normal Codex implementation and deterministic verification.

## SUBAGENT_TASK extensions

When dispatching `templestay-claude-consultant`, include:

- **consultation_hint** — one of `claude_native_surface` /
  `architecture_synthesis` / `instruction_review` / `high_stakes_challenge`.
- **model** — explicit Claude model or alias; empty defers to
  `CLAUDE_DEFAULT_MODEL` then gateway repo fallback. Codex installer defaults
  that value to `claude-opus-4-7`, primarily for hetero Critique.
- **timeout_sec** and **max_turns** — optional bounded execution controls.

## Result shape

Return a `SUBAGENT_RESULT` with:

- **Status** — complete / partial / blocked / degraded.
- **Summary** — one paragraph naming the consultation hint and resolved model.
- **Claude Evidence** — attributed Claude response text.
- **Evidence metadata** — model, token/cost/latency/session metadata when
  provided by the gateway.
- **Blockers / residual risk** — what remains for the Codex parent to verify.

## Boundaries

- No `claude_apply`, no repo writes, no permission bypass, no recursive agent
  bridge.
- No council, vote, mediator, consensus, or Copilot approval-gate semantics.
- If `claude_preflight` or `claude_prompt` is degraded, report the category and
  proceed with a Codex-native fallback rather than retrying indefinitely.
