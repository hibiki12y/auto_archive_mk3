---
status: pointer
authority: pointer-only
last_verified: 2026-04-30
source_paths:
  - README.md
  - .env.example
  - src/discord/discord-service-bootstrap.ts
  - src/discord/discord-command-handlers.ts
  - src/core/process-subprocess-runner.ts
  - tests/discord-service-bootstrap.spec.ts
  - tests/discord-interface.offline.spec.ts
  - tests/process-subprocess-runner.spec.ts
scope: Discord service hardening checklist for admin seeding, slurm-apptainer bootstrap, observer failures, and subprocess env allowlists.
---

# Discord Service Hardening Runbook

This guide is an operator checklist. `PROJECT.md`, `README.md`, `src/`, and
`tests/` remain the implementation truth.

## Required admin seed

There is no embedded default administrator. Before enabling admin-only actions
in a service environment, seed one of:

- `AUTO_ARCHIVE_DISCORD_ADMIN_USER_IDS`, or
- the Discord auth database admin role.

Smoke check after boot:

1. run `/doctor` or `/auth` as a seeded admin and confirm access is allowed;
2. run the same command as a non-admin test user and confirm `admin-required` is
   returned.

## slurm-apptainer service bootstrap

Service mode defaults to `slurm-apptainer` when `AUTO_ARCHIVE_COMPUTE_NODE` is
unset or empty. In that mode both values are mandatory:

- `AUTO_ARCHIVE_APPTAINER_IMAGE`
- `AUTO_ARCHIVE_AGENT_INSTANCE_ENTRY`

For local/dev service runs, set `AUTO_ARCHIVE_COMPUTE_NODE=current-node`
explicitly. For SLURM service runs, keep the default and provide image/entry.

## dispatch-completion-observer terminal evidence

If a Discord task finishes with driver failure phase
`dispatch-completion-observer`, the Discord handler has only captured the
completion-promise rejection as terminal evidence. Inspect runtime/driver logs for
the root cause. The Discord evidence should preserve:

- `cause.kind=driver-failure`,
- `cause.phase=dispatch-completion-observer`,
- the original error message,
- the task id in request context.

## subprocess environment allowlist

`ProcessSubprocessRunner` does not inherit the full host environment. It passes:

- minimal identity/path/temp/locale variables,
- selected non-secret `SLURM_*` scheduler context,
- explicit request env overrides,
- operator-approved `additionalHostEnvAllowlist` names that do not look secret-bearing.

Never add broad `SLURM_.*` inheritance and never allowlist token/secret/password/key
names as host env passthrough.
