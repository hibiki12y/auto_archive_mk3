---
status: current
authority: implementation-explanation
last_verified: 2026-05-01
source_paths:
  - README.md
  - specs/CURRENT/remaining-issues-2026-04-30.md
  - specs/GUIDES/discord-stack-deployment.md
  - specs/GUIDES/discord-service-hardening-runbook.md
  - specs/GUIDES/peekaboo-remote-evaluation-mcp.md
  - src/discord/discord-service-bootstrap.ts
  - src/remote/peekaboo-remote-evaluation.ts
  - src/persona/
scope: Repository-local verification versus operator-gated live proof surfaces.
---

# Live Proof Matrix

This matrix separates two evidence classes that must not be conflated:

1. **Repository-local static readiness** — build, typecheck, unit/contract tests,
   parser checks, dry-runs, and documentation/source sync.
2. **Live runtime readiness** — authenticated external services, real provider
   access, real Discord gateway observations, cluster allocation, GUI mutation,
   and operator-approved secret-bearing paths.

`specs/CURRENT/remaining-issues-2026-04-30.md` records repository-local closeout
for earlier follow-up items. A row marked resolved there does **not** imply the
corresponding live proof below has been collected.

## Matrix

| Surface | Repository-local evidence | Required live artifact | Secret / authority boundary | Current live status |
| --- | --- | --- | --- | --- |
| Discord service | Bootstrap/env parsing, access-policy, auth DB, command rendering, task registry, core-stack health parsing tests. | Gateway ready event, command registration event, admin-gated `/doctor` or `/auth` smoke, and one correlated command/reply transcript from the target guild/channel. | Requires operator-owned Discord bot token, application id, guild id, and authorized admin seed. | operator-gated, not live-verified by repo tests |
| GitLab recording | Project manager, assignment, issue/note rendering, artifact publication tests. | Real project/issue/note create-or-annotate artifact with redacted URL/id summary and cleanup/closeout record. | Requires GitLab token selected by `AUTO_ARCHIVE_GITLAB_TOKEN_ENV` or equivalent operator configuration. | operator-gated, not live-verified by repo tests |
| Codex runtime provider | Codex bootstrap settings, runtime adapter, provider-failure classification, runtime-driver-factory tests. | Authenticated run using the selected Codex auth path and accessible model, with terminal evidence provenance `codex-runtime-driver`. | Requires valid local Codex auth or `AUTO_ARCHIVE_CODEX_API_KEY`; do not expose auth contents. | operator-gated, not live-verified by repo tests |
| Claude Agent runtime provider | Claude Agent bootstrap settings, runtime adapter, `AUTO_ARCHIVE_RUNTIME_PROVIDER=claude-agent` factory tests. | Authenticated run with terminal evidence provenance `claude-agent-runtime-driver`, plus model/cost metadata when available. | Production path requires `AUTO_ARCHIVE_ANTHROPIC_API_KEY`; `AUTO_ARCHIVE_CLAUDE_CLI_PATH` is single-user local-dev only. | operator-gated, not live-verified by repo tests |
| Plana runtime advisor | Advisor port and Claude-advisor fail-open tests; `/doctor` reports advisor provider/readiness fields. | Bounded advisor ledger entries for sampled runtime events and any advisor veto provenance. | Reuses Claude Agent auth surface when `AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER=claude-agent`. | operator-gated, not live-verified by repo tests |
| SLURM/Apptainer compute | Command construction, resource envelope, subprocess runner, conformance tests. | Real `salloc` / `apptainer exec` dispatch and cleanup evidence in the deployment environment. | Requires site-approved cluster access, image path, entry script, and non-secret scheduler env allowlist. | operator-gated, not live-verified by repo tests |
| Peekaboo macOS/Discord GUI path | Dry-run/probe/live planning, MCP schema, readiness report, evidence ledger append/query tests. | JSONL evidence record with readiness, GUI submit, task correlation, bot ack/matched reply, artifact path, and PASS/WARN/FAIL outcome. | Live REST observation requires operator-authorized env path or token env; GUI mutation requires macOS Accessibility/Screen Recording and logged-in Discord desktop. | operator-gated, not live-verified by repo tests |
| Persona model rewrite | Presentation-only, opt-in, fail-open, hard-verbatim, protected-token tests. | Sampled live transform telemetry for selected model: applied/fallback outcome, latency, budget/cost note, and human review that no source dialogue was copied. | Requires persona-scoped API key or explicitly enabled fallback; logs must not contain prompt text, user content, or transformed text by default. | operator-gated, not live-verified by repo tests |

## Reporting rule

- Repository-local commands may justify `PASS` only for static readiness.
- Live status remains `WARN` or `operator-gated` until the required artifact for
  that row is recorded.
- A live proof artifact must identify the surface, timestamp, operator-approved
  configuration source, redacted correlation ids, and outcome. It must not
  include raw tokens, `.env` contents, private keys, or full secret-bearing logs.
