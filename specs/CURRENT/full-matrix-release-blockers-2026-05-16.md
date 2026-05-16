---
status: current
authority: implementation-risk-ledger
last_verified: 2026-05-17
source_paths:
  - specs/CURRENT/release-readiness-checkpoint-2026-05-16.md
  - specs/CURRENT/live-proof-matrix.md
  - README.md
  - package.json
scope: Full-matrix release blocker ledger for all operator-gated live proof rows after repo-local release gate hardening.
---

# Full-Matrix Release Blockers — 2026-05-16

## 1. Current decision

Full-matrix release is **blocked**.

Repo-local release gate hardening is closed in commit
`d1892ef` (`chore(release): harden full-matrix readiness gate`), and static
verification passed. The remaining blockers are live-proof blockers: every row
below requires operator-owned, redacted runtime evidence before the full matrix
can be promoted.

This ledger intentionally does not read `.env`, raw credentials, private keys,
Discord/GitLab tokens, provider auth files, raw prompts, raw responses, or
private artifact contents. The parent process had no visible `AUTO_ARCHIVE_*`
environment names during this checkpoint. A Docker `discord-service` container
was running and `pnpm core:stack:health` reported gateway/command-registration
readiness, but that is only partial Discord evidence and does not satisfy the
correlated command/reply proof row by itself.

## 2. Repo-local gate evidence

- `git diff --check`: PASS
- `pnpm lint`: PASS
- `pnpm build`: PASS
- `test -f dist/src/runtime/agent-instance-entry.js`: PASS
- `pnpm vitest run --testTimeout 10000`: PASS, 229 files / 2664 tests
- `pnpm run doctor`: WARN for missing ledger/auth DB/Apptainer env/task-health
  live configuration; PASS for local Codex auth presence, provider/advisor static
  posture, approval registry, shell-hook disabled posture, GitLab disabled
  posture, TLS CA, and secret redaction probe.
- `pnpm core:stack:health`: PASS for the existing `discord-service` container
  reaching ready and command-registration complete states.

## 3. Blocking live-proof rows

| Surface | Current evidence | Blocking missing artifact | Unblock command / scorer |
| --- | --- | --- | --- |
| Discord service | `core:stack:health` PASS only | Operator-owned live command/reply transcript and retained `task.delivery_observed` ledger for the task | `node scripts/check-task-message-shape.mjs <task-id> --ledger <ledger>` and aggregate `pnpm live:proof:report -- --proof <manifest> --pretty` |
| GitLab recording | Static tests only; doctor reports GitLab disabled | Real create-or-annotate/closeout artifact with redacted URL/id and cleanup record | `pnpm gitlab:admin-bootstrap` only for setup; record proof in manifest |
| Codex runtime provider | Doctor static Codex auth presence only | Authenticated `codex-runtime-driver` TerminalEvidence success | `pnpm runtime:provider:evidence:report -- --evidence <file> --provider codex --pretty` |
| Claude Agent runtime provider | Static adapter tests only; no active Claude provider auth in parent process | Authenticated `claude-agent-runtime-driver` TerminalEvidence success | `pnpm runtime:provider:evidence:report -- --evidence <file> --provider claude-agent --pretty` |
| Agent harness registry | Static descriptor/report tests only | Operator-owned descriptor or host integration report showing selected harness binding and zero provider switching | `pnpm agent:harness:registry:report -- --plugins <descriptor> --provider <provider> --pretty` |
| Plana runtime advisor | Static/fail-open tests only | At least 5 real redacted advisor event records with trend/veto/fail-open counts | `pnpm plana:advisor:events:report -- --ledger runtime-state/plana-advisor-events.jsonl --pretty` |
| Autonomous research evidence | Static TraitModule/report tests only | Retained TerminalEvidence for one admitted bounded archive-loop task with start/complete checkpoints | `pnpm autonomous:research:evidence:report -- --evidence <file> --pretty` |
| Durable task archive UX | Static archive/unarchive tests only | Live `/archive` then `/unarchive` interaction and control-plane audit JSONL | `pnpm task:archive:evidence:report -- --ledger runtime-state/research-control-events.jsonl --pretty` |
| Subagent operator surface | Static roster/operator tests only | Live root-owned roster interaction with spawn, terminal lifecycle, and progress samples | `pnpm subagent:operator:evidence:report -- --ledger runtime-state/subagent-roster-events.jsonl --pretty` |
| Focus/session binding UX | Static focus/unfocus tests only | Live `/focus`, focused steering, and `/unfocus` sequence with binding audit evidence | `pnpm session:binding:evidence:report -- --ledger runtime-state/research-control-events.jsonl --pretty` |
| Task health observer | Doctor reports observer disabled | Calibrated threshold, live stalled-task event, runtime correlation scope, and terminal release evidence | `pnpm task:health:evidence:report -- --ledger runtime-state/research-control-events.jsonl --pretty` |
| Trait scheduler tick evidence | Static scheduler tests only | Operator-owned tick loop evidence with no unexplained dispatch failures/checkpoint holds | `pnpm trait:scheduler:evidence:report -- --ledger runtime-state/trait-scheduler-tick-evidence.jsonl --pretty` |
| Control-plane OTLP logs | Static emitter tests only | Collector receipt for a known control-plane event id with no raw instruction/content/reason export | Record in manifest and verify with `pnpm live:proof:report -- --proof <manifest> --pretty` |
| SLURM/Apptainer compute | Local binaries present; doctor reports image/entry env unset | Real `salloc` / `apptainer exec` dispatch, cleanup, and image/entry evidence in target deployment | Run operator `salloc` / `apptainer exec` dispatch, record dispatch proof in manifest; GPU rows also use `pnpm gpu:research:readiness -- --write` and `pnpm gpu:transformer:smoke -- --write` |
| Peekaboo macOS/Discord GUI path | Static MCP/evidence tests only | Live GUI submit, bot ack/matched reply, artifact path, and PASS/WARN/FAIL outcome | `pnpm peekaboo:evidence:report -- --ledger runtime-state/peekaboo-evidence.jsonl --pretty` |
| Persona model rewrite | Static persona/report tests only | At least 5 live transform telemetry records plus human no-copy review | `pnpm persona:telemetry:report -- --ledger runtime-state/persona-telemetry.jsonl --pretty` |

## 4. Completion sequence

1. Collect one row's live artifact under operator control.
2. Replay the row-specific scorer without exposing raw secrets/content.
3. Add a redacted `pass` proof record to the aggregate manifest.
4. Run `pnpm live:proof:report -- --proof runtime-state/live-proof.json --pretty`.
5. Repeat until every row above is `operatorApproved:true` and `status:"pass"`.
6. Run the repo-local release gate again.
7. Run final Critique and update the completion audit.

Any placeholder/template evidence, missing operator approval, unsafe boundary
flag, raw secret/content field, warning scorer status, or failed scorer status
keeps the full matrix blocked.
