# templestay Claude Hooks

These hooks are optional hardening assets. They are not required for the native
state machine or preset correctness.

Use them only for explicit hardened deployments that want extra deny/warn checks
for secrets, destructive shell, sensitive reads/writes, web access, and MCP write
tools such as `mcp__<server>__<tool>`.
