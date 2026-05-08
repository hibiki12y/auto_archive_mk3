# Autonomous Research Goal Loop Trait

This repository-owned TraitModule maps the Darwin Gödel Machine (DGM)
framework into Auto Archive as a bounded, evidence-first research loop.

## Purpose

Enable a host-approved agent workflow to continue research until explicit goal
criteria are met by combining:

1. a goal and stop-condition declaration,
2. an archive of research stepping stones,
3. bounded candidate generation or refinement,
4. empirical evaluation against the goal, and
5. a completion audit before terminal success.

The DGM reference motivates the archive loop: retain diverse prior artifacts as
stepping stones, sample from the archive, generate an interesting child
variant, evaluate it empirically, and add evidence-bearing variants back to the
archive when they improve capability or unlock future progress.

## Required research loop

When this trait is requested and admitted, the agent should treat autonomous
research as a bounded loop:

1. **Declare the target** — restate the research goal, measurable acceptance
   checks, budget, stop condition, and excluded scope.
2. **Inspect the archive** — list prior hypotheses, sources, experiments,
   failed attempts, and useful partial artifacts.
3. **Sample or propose a stepping stone** — choose one archive item or propose
   a new bounded variant that is likely to reduce uncertainty.
4. **Run an evidence gate** — use citations, local tests, reproducible command
   output, or artifact inspection before promoting a claim.
5. **Retain and score** — keep all evidence-bearing variants in the ledger;
   promote only when the variant improves the goal metric or creates a useful
   future stepping stone.
6. **Audit completion** — stop only when the prompt-to-artifact checklist
   covers every explicit requirement, or when the budget/safety boundary blocks
   further progress.

## Boundary

- This TraitModule is opt-in governance, instructions, and evidence annotation.
- It is not an unbounded autonomous runner, hidden scheduler, provider switch,
  prompt-origin switch, or compute capability flag.
- It does not grant network, web-search, sandbox, or approval authority; those
  remain host/runtime policy decisions.
- It must not read secrets, bypass approval, rewrite `TerminalCause`, mutate
  runtime settings, or alter delegate driver results.
- Open-ended research remains bounded by explicit budgets, sandboxing, and
  human/operator oversight.

## Non-goals / will never

- Will never self-modify Auto Archive source code as part of runtime trait
  execution.
- Will never launch an unbounded loop driver or background scheduler.
- Will never switch providers, models, prompt origins, runtime settings, or
  approval policy.
- Will never grant network, web-search, sandbox, filesystem, or approval
  authority.
- Will never promote a claim without an evidence gate and completion audit.

## Runtime behavior

When explicitly requested and admitted, the runtime decorator may emit
observable `autonomous-research.checkpoint` events before and after delegate
runtime execution. Checkpoint emission is best-effort and evidence-only:
failure to emit a checkpoint must not alter the delegate runtime result or
thrown error.
