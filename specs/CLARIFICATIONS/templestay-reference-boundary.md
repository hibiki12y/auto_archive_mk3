---
status: ratified
authority: binding-clarification
last_verified: 2026-05-16
source_paths:
  - .gitmodules
  - README.md
  - codex.md
  - .codex/verify_alignment.sh
  - resource/templestay/scripts/install_templestay_codex_cli.sh
  - resource/templestay/prototypes/templestay-cli/README.md
  - specs/CLARIFICATIONS/templerun-reference-boundary.md
  - tests/resource-boundary.spec.ts
scope: `resource/templestay` submodule boundary: reference/plugin resource posture, not runtime dependency.
---

# Templestay Reference Boundary

`resource/templestay` is a checked-in reference/plugin resource posture. It is
not part of Auto Archive's runtime stack. Integration preparation is allowed
only as an operator-owned integration path: Auto Archive may document, preview,
and verify templestay install surfaces, but production source remains owned by
Auto Archive's own runtime contracts.

## Not allowed

- importing or executing `resource/templestay` from `src/`,
- treating it as a provider, runtime driver, bootstrap mode, or prompt source of
  truth,
- making application/runtime tests pass only by executing code inside the
  submodule,
- letting templestay installers overwrite project-owned Codex concurrency
  settings such as `features.multi_agent_v2` or `[agents]` limits.

## Allowed

- documentation comparison,
- instruction/protocol reference for human review,
- submodule pointer updates plus upstream delta review,
- secret-free installer dry-runs and metadata inspection,
- operator-owned integration into user-local Codex/Claude/tstay homes,
- migration notes that keep Auto Archive source contracts as the actual runtime
  truth,
- compatibility verifiers that prove the templestay installer keeps agent
  limits user/project/runtime-owned while this repository keeps its own
  project-owned Codex concurrency contract.

## Integration boundary

The current safe integration lane is:

1. Pin `resource/templestay` to a reviewed upstream commit.
2. Run a non-mutating Codex installer preview with Tavily disabled and
   `memory-profile=none` when validating this repository's compatibility
   surface.
3. Keep Auto Archive's checked-in `.codex/config.toml` secret-free and
   project-local. In particular, the project continues to own
   `features.multi_agent_v2.max_concurrent_threads_per_session` and must keep
   the legacy `agents.max_threads` key absent.
4. Treat real `tstay install`, templestay MCP registration, shared memory roots,
   and provider credential homes as operator/user-scope setup, not committed
   Auto Archive runtime state.

This supersedes the historical `resource/templerun` posture for current work,
while the older templerun clarification remains as historical boundary context.
