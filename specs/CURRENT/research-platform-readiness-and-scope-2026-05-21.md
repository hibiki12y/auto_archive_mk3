---
status: current
authority: implementation-risk-ledger
last_verified: 2026-05-21
source_paths:
  - PROJECT.md
  - README.md
  - runtime-state/live-proof.json
  - specs/ARCHIVE/live-proof-matrix.md
  - specs/CURRENT/agent-repo-comparison-improvement-plan-2026-05-17.md
  - specs/ARCHIVE/hermes-pattern-adoption.md
  - specs/ARCHIVE/full-matrix-release-blockers-2026-05-16.md
  - specs/ARCHIVE/release-readiness-checkpoint-2026-05-16.md
  - specs/ARCHIVE/midpoint-checkpoint-2026-05-05.md
  - specs/ARCHIVE/open-harness-parity-completion-audit-2026-05-05.md
  - specs/ARCHIVE/remaining-issues-2026-04-30.md
  - specs/README.md
  - specs/METADATA/cross-references.md
  - specs/METADATA/spec-test-coverage-matrix.md
scope: Current Auto Archive product boundary, readiness posture, active improvement gaps, deferred non-goals, and archived historical gates as of 2026-05-21.
supersedes:
  - specs/CURRENT/full-matrix-release-blockers-2026-05-16.md
  - specs/CURRENT/release-readiness-checkpoint-2026-05-16.md
---

# Research Platform Readiness and Scope — 2026-05-21

## 1. Current product boundary

Auto Archive is currently a **Discord-centered automatic research workflow and
evidence-governance platform**. Its live product value is the operator-visible
research control plane, retained evidence ledgers, proof scorecards, bounded
research-plan orchestration, human/approval gates, and reproducible static
reports around those artifacts.

Auto Archive is **not** currently a model automatic-learning framework, RL
training platform, SFT/DPO dataset generator, trajectory-compression system,
provider-zoo runtime, or Hermes-equivalent multi-channel agent operating system.
Hermes-derived model-training and trajectory patterns remain reference material
only unless a future roadmap explicitly reopens them with separate acceptance
criteria.

This boundary narrows the 2026-05-17 comparison plan: improvement work should
prefer workflow/evidence quality, research-plan controllability, live proof
hygiene, capability envelopes, and operator accountability over model training
or autonomous model self-improvement.

### 1.1. `specs/CURRENT/` inventory rule

The only authoritative live-current documents in `specs/CURRENT/` are:

1. `specs/CURRENT/agent-repo-comparison-improvement-plan-2026-05-17.md` — the
   Hermes/OpenClaw/headless/workflow comparison-derived development plan.
2. `specs/CURRENT/research-platform-readiness-and-scope-2026-05-21.md` — this
   product-boundary and readiness SSoT.

All other Markdown files under `specs/CURRENT/` are redirect-only compatibility
stubs with `status: redirect` and `authority: redirect-only`. Their historical
content now lives in `specs/ARCHIVE/` or, for spec/test coverage metadata,
`specs/METADATA/spec-test-coverage-matrix.md`. They may be used to preserve old
links, but they must not be treated as current development plans.

## 2. Current readiness posture

As of 2026-05-21, the retained aggregate live-proof manifest is no longer in the
2026-05-16 blocker posture. The following static replay command over the
operator-owned retained manifest reports complete active readiness:

```bash
pnpm --silent live:proof:report -- --proof runtime-state/live-proof.json --pretty
```

Observed replay summary on 2026-05-21:

| Field | Value |
| --- | --- |
| report status | `complete` |
| proof records | 16 total |
| active proof records | 15 |
| active complete PASS records | 15 |
| active operator-approved records | 15 |
| unsafe boundary count | 0 |
| missing required artifact count | 0 |
| quality score | 100 / 100 |
| mothballed retained row | `persona-model-rewrite` |

Interpretation:

- This is a **retained-artifact replay** posture, not a fresh live service run.
- It closes the historical 2026-05-16 full-matrix blocker ledger for active
  rows, while preserving the old ledger in `specs/ARCHIVE/` for audit history.
- It does not by itself claim full production deployment completion, SaaS
  readiness, or completion of the broader rewrite target.
- The `persona-model-rewrite` row remains mothballed and excluded from active
  readiness scoring unless deliberately reactivated.

## 3. Archived historical gates

The following dated gates are no longer live authority and have been archived:

| Archived document | Why archived | Current replacement |
| --- | --- | --- |
| `specs/ARCHIVE/full-matrix-release-blockers-2026-05-16.md` | It stated full-matrix release was blocked until all operator-gated rows were PASS. The retained manifest now reports all active rows complete. | This document + `specs/ARCHIVE/live-proof-matrix.md` |
| `specs/ARCHIVE/release-readiness-checkpoint-2026-05-16.md` | It stated `WARN / not release-complete` while the live-proof queue was open. That exact dated 2026-05-16 release-readiness checkpoint is historical. | This document + `README.md` repo-internal readiness section |

Compatibility stubs remain at the old `specs/CURRENT/...2026-05-16.md` paths
with `status: redirect` / `authority: redirect-only`. They must not be treated
as duplicate live risk ledgers.

### 3.1. Historical blocker closure map

Every row from the archived 2026-05-16 full-matrix blocker ledger now maps to a
retained proof surface in the aggregate manifest. Active rows are closed by the
retained replay posture above; the one non-active row is explicitly mothballed
and excluded from active readiness scoring.

| Archived blocker row | Retained proof surface | 2026-05-21 posture |
| --- | --- | --- |
| Discord service | `discord-service` | active PASS, operator-approved, safe boundary |
| GitLab recording | `gitlab-recording` | active PASS, operator-approved, safe boundary |
| Codex runtime provider | `codex-runtime-provider` | active PASS, operator-approved, safe boundary |
| Claude Agent runtime provider | `claude-agent-runtime-provider` | active PASS, operator-approved, safe boundary |
| Agent harness registry | `agent-harness-registry` | active PASS, operator-approved, safe boundary |
| Plana runtime advisor | `plana-runtime-advisor` | active PASS, operator-approved, safe boundary |
| Autonomous research evidence | `autonomous-research-evidence` | active PASS, operator-approved, safe boundary |
| Durable task archive UX | `durable-task-archive-ux` | active PASS, operator-approved, safe boundary |
| Subagent operator surface | `subagent-operator-surface` | active PASS, operator-approved, safe boundary |
| Focus/session binding UX | `focus-session-binding-ux` | active PASS, operator-approved, safe boundary |
| Task health observer | `task-health-observer` | active PASS, operator-approved, safe boundary |
| Trait scheduler tick evidence | `trait-scheduler-tick-evidence` | active PASS, operator-approved, safe boundary |
| Control-plane OTLP logs | `control-plane-otel-logs` | active PASS, operator-approved, safe boundary |
| SLURM/Apptainer compute | `slurm-apptainer-compute` | active PASS, operator-approved, safe boundary |
| Peekaboo macOS/Discord GUI path | `peekaboo-discord-gui` | active PASS, operator-approved, safe boundary |
| Persona model rewrite | `persona-model-rewrite` | mothballed retained PASS, operator-approved, safe boundary; excluded from active scoring |

No extra non-replayable blocker from the archived 2026-05-16 ledger is promoted
silently here. Any future deployment claim that needs a fresh live run must use
the evidence-class reporting rule below rather than reusing the archived blocker
wording.

Older 2026-04-30 and 2026-05-05 checkpoint files that still feed narrow tests or
Claude offload examples are now archived as historical inputs with redirect-only
stubs retained at their former `specs/CURRENT/` paths. They are not revalidated
here as current release gates.

## 4. Active improvement priorities

### P0 — Source-of-truth and research mission proof

1. Keep `PROJECT.md`, `README.md`, `specs/README.md`, and comparison specs in
   sync on the product boundary: research workflow/evidence governance first;
   model auto-learning/RL deferred.
2. Preserve one golden end-to-end research mission proof that demonstrates the
   product shape: research plan, evidence/claim ledger, human gate or approval,
   subtask/synthesis closeout, proof replay, and redacted report.
3. Keep static replay claims visibly separate from fresh live-service proof.

### P1 — Workflow/evidence platform hardening

1. Promote the `research-plan.v2` validation/dry-run subset toward a bounded live
   subset only after runtime semantics for `task`, `human_gate`, and
   `parallel_group` are explicitly specified.
2. Add or maintain metadata-only capability envelopes for provider, subagent,
   network/egress, filesystem, credential-reference, and cost/time limits.
3. Make claim/evidence/proof links first-class: every research output should map
   important claims to retained evidence or an explicit unresolved gap.
4. Make human-gate/notify/approval behavior consistent across Discord and CLI
   projections, including timeout and summary metadata.

### P2 — Workflow improvement loop, not model training

1. Continue using constraint reports, methodology lenses, and reusable-skill
   candidates as **reviewable workflow artifacts**.
2. Do not frame this as model weight training, RL, SFT/DPO, or automatic
   trajectory mining.
3. Any future evaluation loop must score research workflow quality, evidence
   completeness, operator handoff clarity, and safety-boundary compliance before
   considering model-level learning.

## 5. Deferred or out-of-scope items

| Item | Current classification | Reopen trigger |
| --- | --- | --- |
| Model automatic learning / RL environments / SFT-DPO dataset generation | Deferred / out of scope | User explicitly prioritizes a training platform and accepts new data, privacy, eval, and compute gates. |
| Trajectory compression, trajectory hooks, batch-runner learning loops | Deferred / out of scope | Same as above, plus retained trajectory schema and redaction policy. |
| Provider zoo, mid-flight model switching, runtime fan-out/council execution | Out of scope | Bootstrap-time provider seam becomes insufficient for a concrete operator workflow. |
| Multi-channel messaging beyond Discord | Deferred productization | Discord proof/control plane is stable and user asks for a specific channel. |
| Multi-tenant SaaS credential vault and public managed-agent API | Deferred productization | Operator-owned single deployment no longer satisfies target deployment model. |
| Persona model rewrite | Mothballed | Explicit reactivation with persona-scoped credentials and separate proof boundary. |

## 6. Reporting rule

Future readiness reports must state which evidence class they use:

- **Repo-local static evidence**: build, tests, lint, dry-run validation,
  retained-artifact scorecards, and Markdown/spec checks.
- **Retained live-proof replay**: static replay of operator-owned redacted
  artifacts such as `runtime-state/live-proof.json`.
- **Fresh live runtime proof**: a new authenticated Discord/GitLab/provider/SLURM
  run performed during the current task.

Do not promote a fresh-live claim from retained replay alone, and do not revive
archived 2026-05-16 blocker wording as current truth.
