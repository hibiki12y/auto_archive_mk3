# templestay State Machine Rule

Apply to non-trivial Claude Code work:

```text
Input → Atomize → Plan → Execute → Verify → Critique → Report
Verify → Execute
Critique → Atomize → Plan
```

`Verify → Execute` is reserved for in-scope actionable Verify failures that stay
inside the current plan and have a concrete `execute_repair_target`. `Critique`
must include the failed check, in-scope repair target, and updated assumption
before returning to `Atomize`; do not short-circuit Critique directly to
Execute.
