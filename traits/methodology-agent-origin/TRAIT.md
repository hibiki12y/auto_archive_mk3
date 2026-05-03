# Methodology Agent Origin Trait

This repository-owned TraitModule records the methodology-origin guidance for
Auto Archive as an evidence-only runtime decorator.

## Boundary

- This TraitModule is an admission/governance and evidence surface only.
- It is not a provider switch, runtime selector, prompt-origin switch, Codex
  bootstrap mode, or compute capability flag.
- It must not import, copy, execute, or prompt-inject external reference
  instruction text such as `templerun`.
- It must not rewrite `TerminalCause`, runtime settings, provider selection, or
  delegate driver results.

## Runtime behavior

When explicitly requested and admitted, the runtime decorator may emit
observable methodology checkpoints before and after the delegate runtime
execution. Checkpoint emission is best-effort: failure to emit a checkpoint must
not alter the delegate runtime result or thrown error.
