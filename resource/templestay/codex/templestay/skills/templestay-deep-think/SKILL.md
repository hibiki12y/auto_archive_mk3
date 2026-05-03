---
name: templestay-deep-think
description: "Use bounded independent lenses for high-ambiguity templestay tasks — architecture, refactor strategy, verification design, or cross-runtime consultation — without vote or council semantics."
---

<!-- templestay-generated-from: shared/templestay/skills/templestay-deep-think/SKILL.md.in -->

# templestay Deep Think

For genuinely ambiguous decisions where direct implementation would commit too
early, run a bounded set of independent lenses before planning.

## Lens Set

Pick the lenses that match the question. Do not run them all when only one or
two are material.

- **Architecture** — system shape, boundaries, dependency direction.
- **Verification** — how would we know this is correct, by what sensor?
- **Challenge** — what is the strongest case against this approach?
- **Research** — what does the source-of-truth doc, paper, or RFC actually say?
- **Implementation feasibility** — does this fit the codebase as it is, or does
  it require invasive groundwork first?
- **Cross-runtime consultation** — use the installed read-only gateway when the
  other platform has material strength for the question: `codex-gateway` from
  Claude for token-heavy synthesis or code-authoring strategy, `claude-gateway`
  from Codex for Anthropic-native surface review, and `gemini-gateway` for
  long-context, abstract reasoning, multimodal, or tool-coordination triggers.

Cross-runtime lenses are advisory evidence, not votes. They must not be used as
critics of another model's output; executable checks and file evidence remain
the verification path.

## How Lenses Combine

- The parent reads lens outputs and decides; lenses do not "agree" and there is
  no consensus, mediator, or council.
- Each lens returns evidence (file paths, citations, counterexamples) — not a
  yes/no recommendation.
- If two lenses contradict, capture the contradiction explicitly and decide
  which evidence weighs more, with a reason.

## Budget

- Run lenses bounded by scope and time: a lens that drifts into open-ended
  exploration costs more than the decision it informs.
- Skip a lens that is not material to the question; record the skip reason if it
  would normally apply.
- Do not import Copilot DT-Council/model-council mediator chains. Do not claim
  "consensus" in the report.

After lensing, return to normal execution — small change, deterministic
verification, compact report.
