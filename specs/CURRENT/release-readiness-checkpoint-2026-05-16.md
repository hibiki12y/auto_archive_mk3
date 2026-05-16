---
status: current
authority: implementation-risk-ledger
last_verified: 2026-05-16
source_paths:
  - PROJECT.md
  - README.md
  - package.json
  - specs/CURRENT/live-proof-matrix.md
  - specs/CURRENT/midpoint-checkpoint-2026-05-05.md
  - specs/CURRENT/open-harness-parity-completion-audit-2026-05-05.md
  - specs/CURRENT/remaining-issues-2026-04-30.md
scope: Release-readiness checkpoint separating repo-local releasability from operator-gated live proof required before release completion.
---

# Release Readiness Checkpoint — 2026-05-16

## 1. Decision

Current release status is **WARN / not release-complete**.

The repository has substantial static implementation coverage for the
current-branch scaffold, Discord control-plane UX, provider bootstrap seams,
retained evidence readers, and SLURM/Apptainer compute-node wiring. However,
release completion still depends on operator-owned live artifacts listed in
`specs/CURRENT/live-proof-matrix.md`. Repository-local tests, templates, and
scorecards can prove static readiness only; they must not promote an
operator-gated row to live-ready by themselves.

This checkpoint is an execution ledger for the release plan. It does not replace
`README.md` as current branch authority and does not mark the broader rewrite
complete.

## 2. Repo-local release gate

Before cutting a release candidate, the worktree must be made intentionally
reviewable:

1. Resolve all modified and untracked files into focused commits or deliberate
   reverts.
2. Keep generated `runtime-state/` artifacts out of the release unless they are
   intentional non-secret fixtures.
3. Confirm `resource/templestay` is not accidentally dirty or staged.
4. Run deterministic checks:
   - `git diff --check`
   - `pnpm lint`
   - `pnpm build`
   - `test -f dist/src/runtime/agent-instance-entry.js`
   - `pnpm vitest run --testTimeout 10000`
   - focused tests for any changed release surface
5. Record any skipped or degraded check as a release blocker or explicit
   residual risk.

`pnpm vitest run --testTimeout 10000` is decisive only in an environment allowed
to run the repository's child-process checks and `.codex` dry-run scratch paths.
If a constrained sandbox returns `EPERM`/read-only filesystem errors for those
pre-existing tests, rerun the failing focused tests and the full suite in the
approved host verification environment before judging release status.

The active local closeout slice at this checkpoint is the standard
SLURM/Apptainer agent-instance image/entry-path alignment: the runtime entry is
`dist/src/runtime/agent-instance-entry.js`, the standard image advertises
multi-provider runtime posture, and Apptainer invocation must not emit the
unsupported `exec --read-only` token.
The non-scratch invocation must keep `--no-mount=tmp` and must not emit
Apptainer writable-mode flags such as `--writable`, `--writable-tmpfs`, or
`--overlay`.

## 3. Operator-gated live proof gate

Release completion requires redacted, operator-approved live artifacts for the
deployment surfaces that are in scope. The mandatory proof queue is inherited
from `live-proof-matrix.md` and currently includes:

- Discord service/guild/channel smoke with correlated command/reply evidence.
- GitLab create-or-annotate/closeout artifact.
- Authenticated Codex and Claude Agent runtime provider TerminalEvidence.
- Agent harness descriptor or host integration report.
- Plana advisor sampled redacted event ledger.
- Autonomous research admitted bounded archive-loop TerminalEvidence.
- Durable task archive/unarchive live interaction evidence.
- Subagent roster lifecycle/progress retained evidence.
- Focus/session binding lifecycle retained evidence.
- Task health stall/release evidence with calibrated thresholds.
- Trait scheduler retained tick evidence from an operator-owned loop.
- Deployment-scope OTLP, SLURM/Apptainer/GPU, Peekaboo, and persona telemetry
  proof when those surfaces are part of the target release.

Each retained artifact must be checked by its read-only scorecard CLI. The
aggregate proof manifest must be checked with:

```bash
pnpm live:proof:report -- --proof <manifest> --pretty
```

These commands replay retained evidence only. They must not contact Discord,
GitLab, providers, SLURM, Peekaboo, or OTLP services, mutate proof files, or
render raw tokens, prompts, responses, task instructions, private artifacts, or
secret-bearing logs.

Row-level artifact tokens, minimum fields, and safety boundaries are not
duplicated here; they remain defined by `specs/CURRENT/live-proof-matrix.md`.
This checkpoint is the release queue and completion gate, while the matrix is
the per-surface acceptance source of truth.

## 4. Completion rule

Do not declare release completion until all of the following are true:

1. The repo-local release gate passes with no unreviewed worktree drift.
2. Every mandatory live-proof row for the target deployment has
   operator-approved `pass` evidence and safe boundary flags.
3. The final completion audit maps each proof row to retained artifact evidence.
4. Same-family verification and the regular hetero Critique lane report no
   unresolved blocking issue, or degraded lenses are explicitly accepted as
   residual risk.

If any mandatory proof is declined, missing, warning, or failing, keep release
status at **WARN** or **FAIL** and create a focused repair ledger for that
surface instead of promoting the release.
