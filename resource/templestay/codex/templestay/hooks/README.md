# templestay Codex Hooks

Hooks in this directory are optional hardening assets for Codex. They are not
required for the templestay lifecycle:

```text
Input → Atomize → Plan → Execute → Verify → Critique → Report
Verify → Execute
Critique → Atomize → Plan
```

Use them only when a `hardened` or explicitly hook-enabled preset is desired.
They may warn or deny obvious secrets, destructive shell, or risky MCP/external
mutation, but correctness belongs to instructions, settings, MCP policy, and
verification.
