---
status: current
authority: implementation-explanation
last_verified: 2026-05-05
source_paths:
  - README.md
  - specs/CURRENT/remaining-issues-2026-04-30.md
  - specs/GUIDES/discord-stack-deployment.md
  - specs/GUIDES/discord-service-hardening-runbook.md
  - specs/GUIDES/peekaboo-remote-evaluation-mcp.md
  - src/discord/discord-service-bootstrap.ts
  - scripts/check-task-message-shape.mjs
  - tests/discord-delivery-observed.spec.ts
  - tests/discord-natural-language-in-place.spec.ts
  - tests/discord-mention-chat-routing.spec.ts
  - src/runtime/autonomous-research-evidence-report-cli.ts
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
| Discord service | Bootstrap/env parsing, access-policy, auth DB, command rendering, task registry, core-stack health parsing tests, in-place natural-language lifecycle tests, chat-by-default mention routing tests, `task.delivery_observed` ledger tests, and `scripts/check-task-message-shape.mjs` retained-ledger message-shape verification. | Gateway ready event, command registration event, admin-gated `/doctor` or `/auth` smoke, one correlated command/reply transcript from the target guild/channel, and a retained `task.delivery_observed` ledger excerpt for that task whose `editReply` shape is checked by `node scripts/check-task-message-shape.mjs <task-id> --ledger <path>`. | Requires operator-owned Discord bot token, application id, guild id, and authorized admin seed. The message-shape script reads existing JSONL only; it must not contact Discord REST/gateway, read bot tokens, mutate ledgers, render raw Discord content, or promote the Discord service row to live-ready by itself. | operator-gated, not live-verified by repo tests |
| GitLab recording | Project manager, assignment, issue/note rendering, artifact publication tests. | Real project/issue/note create-or-annotate artifact with redacted URL/id summary and cleanup/closeout record. | Requires GitLab token selected by `AUTO_ARCHIVE_GITLAB_TOKEN_ENV` or equivalent operator configuration. | operator-gated, not live-verified by repo tests |
| Codex runtime provider | Codex bootstrap settings, runtime adapter, provider-failure classification, runtime-driver-factory tests, `pnpm runtime:provider:evidence:report` retained TerminalEvidence scorecard/template tests, and `/doctor` redacted provider-evidence summary. | Authenticated run using the selected Codex auth path and accessible model, with terminal evidence provenance `codex-runtime-driver`; retained provider scorecard should show terminal success, matched provenance, runtime settings/resource snapshots, and no raw task/reason/transcript rendering. | Requires valid local Codex auth or `AUTO_ARCHIVE_CODEX_API_KEY`; do not expose auth contents. `--print-template` may emit a non-promoting TerminalEvidence skeleton with canonical `codex-runtime-driver` provenance and a template `driver-failure` cause, but it must not read evidence files, instantiate drivers, contact providers, switch providers, read env, mutate evidence, or render raw task ids/runtime instance ids/reasons/transcripts. CLI and `/doctor` read existing TerminalEvidence only and must not instantiate drivers, contact providers, switch providers, read env beyond configured doctor path, mutate evidence, or render raw task ids/runtime instance ids/reasons/transcripts. | operator-gated, not live-verified by repo tests |
| Claude Agent runtime provider | Claude Agent bootstrap settings, runtime adapter, `AUTO_ARCHIVE_RUNTIME_PROVIDER=claude-agent` factory tests, `pnpm runtime:provider:evidence:report -- --provider claude-agent` retained TerminalEvidence scorecard/template tests, and `/doctor` redacted provider-evidence summary. | Authenticated run with terminal evidence provenance `claude-agent-runtime-driver`, plus model/cost/token metadata when available; retained provider scorecard should show terminal success, matched provenance, runtime settings/resource snapshots, and no raw task/reason/transcript rendering. | Production path requires `AUTO_ARCHIVE_ANTHROPIC_API_KEY`; `AUTO_ARCHIVE_CLAUDE_CLI_PATH` is single-user local-dev only. `--print-template` may emit a non-promoting TerminalEvidence skeleton with canonical `claude-agent-runtime-driver` provenance and a template `driver-failure` cause, but it must not read evidence files, instantiate drivers, contact providers, switch providers, read env, mutate evidence, or render raw task ids/runtime instance ids/reasons/transcripts. CLI and `/doctor` read existing TerminalEvidence only and must not instantiate drivers, contact providers, switch providers, read env beyond configured doctor path, mutate evidence, or render raw task ids/runtime instance ids/reasons/transcripts. | operator-gated, not live-verified by repo tests |
| Agent harness registry | `AgentHarnessPlugin` ABI, selection/fail-closed/report tests, runtime-driver-factory sync/lazy wrapper tests, `pnpm agent:harness:registry:report` descriptor CLI/template tests, and `/doctor` descriptor summary tests. | Operator-owned harness descriptor or host integration report showing active provider/source, selected harness binding preview, unsupported reasons, and zero runtime-provider switching, visible through the local CLI and/or `/doctor`. | Descriptor/report metadata only; do not include secrets, prompts, responses, or raw task instructions. `--print-template` may emit a safe descriptor skeleton but does not read descriptor files, import plugin code, call `wrapDriver()`, create a runtime driver, fetch registries, or alter provider selection. Report surfaces must not import plugin code, call `wrapDriver()`, create a runtime driver, fetch registries, or alter provider selection. | operator-gated, not live-verified by repo tests |
| Plana runtime advisor | Advisor port and Claude-advisor fail-open tests; `/doctor` reports advisor provider/readiness fields; optional `AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_LEDGER_PATH` writes redacted JSONL verdict breadcrumbs without prompt/response/free-form reason text; `/doctor` and `pnpm plana:advisor:events:report` can replay that advisor ledger read-only with bounded byte guards and malformed/torn-line counters; `--print-template` emits a one-line non-promoting setup record. | Bounded advisor ledger entries for sampled runtime events and any advisor veto provenance, plus `/doctor` redacted advisor-ledger summary and/or CLI JSON scorecard showing valid sample count, veto/fail-open counts, malformed/torn lines, and last event time. | Reuses Claude Agent auth surface when `AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER=claude-agent`; advisor event ledgers must stay redacted and operator-owned. `/doctor` and the CLI read only the configured advisor ledger and must not run advisor calls, alter dispatch decisions, compact/rotate ledgers, or expose prompt/response/free-form reason text. `--print-template` may emit one compact metadata-only advisor audit JSONL placeholder, but it must not read ledgers, call Claude/advisor/provider paths, contact services, mutate/rotate ledgers, or pretty-print multi-line JSON; the placeholder remains insufficient/non-promoting until replaced by at least 5 real redacted advisor event records. | operator-gated, not live-verified by repo tests |
| Autonomous research evidence | Repository-owned autonomous-research TraitModule contract/runtime/resolver tests, `/doctor` runtime-mode boundary tests, `pnpm autonomous:research:evidence:report` TerminalEvidence report/template tests, and `/doctor` autonomous evidence summary tests. | Retained TerminalEvidence JSON for at least one admitted bounded archive-loop task, with start+complete autonomous-research checkpoints, terminal success, complete bounded-archive criteria coverage, and a redacted `/doctor` or CLI scorecard. | Reads existing TerminalEvidence only; do not include raw prompts, secrets, responses, or private artifact contents. `--print-template` may emit a non-promoting TerminalEvidence skeleton with no autonomous checkpoints and a template cause, but it must not run autonomous research, load TraitModule runtime code, call runtime drivers/delegates, evaluate variants, change providers, contact services, read evidence files, or mutate evidence. Report surfaces must not run autonomous research, load TraitModule runtime code, call runtime drivers/delegates, evaluate variants, change providers, contact services, or mutate evidence. | operator-gated, not live-verified by repo tests |
| Durable task archive UX | Registry archive/unarchive tests, metadata-only `task.archived` / `task.unarchived` control-plane audit payload tests, `pnpm task:archive:evidence:report` retained JSONL scorecard/template tests, and `/doctor` redacted task-archive evidence summary tests. | Operator-owned archive and unarchive interactions for at least one retained Discord task, visible in `/tasks archived` before restore, retained control-plane JSONL artifact with both archive and unarchive audit records, and redacted `/doctor` or CLI scorecard. | CLI and `/doctor` replay existing control-plane metadata only; they must not call Discord/GitLab/provider services, mutate/archive/unarchive tasks, compact/rotate ledgers, or render raw task ids, actor/user ids, reasons, instructions, or payload blobs. `--print-template` may emit one compact non-promoting metadata-only `task.archived` control-plane JSONL placeholder with stable redacted hashes, but it must not read ledgers, run archive/unarchive handlers, mutate archive state, contact services, compact/rotate ledgers, or pretty-print multi-line JSON; the placeholder remains WARN until replaced by real archive and unarchive evidence. Unexpected schema-versioned `archiveAudit` fields, malformed hash-named fields, and unsafe legacy raw archive payload keys fail the report; filtered reports mark transition counts as filter-scoped. | operator-gated, not live-verified by repo tests |
| Subagent operator surface | Subagent roster/operator policy tests, Discord `/subagents` session-binding tests, `pnpm subagent:operator:evidence:report` retained roster-event JSONL scorecard/template tests, and `/doctor` redacted subagent-operator evidence summary tests. | Operator-owned `/subagents list/info/log/send/steer/kill` interaction against a live root-owned roster, retained roster-event JSONL artifact with spawn plus terminal lifecycle events and progress samples, and redacted `/doctor` or CLI scorecard. | CLI and `/doctor` replay existing roster-event metadata only; they must not spawn, steer, kill, inspect live subagents, mutate/rotate ledgers, contact Discord/GitLab/provider services, or render raw subagent ids, task ids, runtime instance ids, messages, artifacts, prompts, responses, or payload blobs. `--print-template` may emit one compact non-promoting `subagent.spawned` JSONL placeholder, but it must not read ledgers, inspect live subagents, mutate rosters/ledgers, contact services, or pretty-print multi-line JSON; the placeholder remains WARN until replaced by real spawn, terminal, and progress evidence. Raw message/reason/prompt/response/payload keys and raw string artifacts fail closed; digest/ref artifact metadata is the only retained artifact shape accepted by the local scorecard. Filtered reports mark transition counts as filter-scoped. | operator-gated, not live-verified by repo tests |
| Focus/session binding UX | Session binding manager tests, retention sweep tests, Discord focus/unfocus rendering tests, metadata-only `bindingAudit` control-plane payload tests, `pnpm session:binding:evidence:report` retained JSONL scorecard/template tests, and `/doctor` redacted session-binding evidence summary tests. | Operator-owned `/focus`, focused `/ask` steering, and `/unfocus` sequence for a live tracked task, retained control-plane JSONL artifact with binding create, steering submitted, and terminal release/change/expiry evidence, and redacted `/doctor` or CLI scorecard. | CLI and `/doctor` replay existing control-plane metadata only; they must not focus, unfocus, steer, append events, mutate/rotate ledgers, contact Discord/GitLab/provider services, or render raw binding ids, task ids, owner/user ids, guild/channel/thread ids, subagent ids, instructions, steering text, or payload blobs. `--print-template` may emit one compact non-promoting metadata-only `session.binding_created` control-plane JSONL placeholder with stable redacted binding/task/owner/channel/thread/subagent hashes, but it must not read ledgers, focus, unfocus, steer, append events, mutate/rotate ledgers, contact services, or pretty-print multi-line JSON; the placeholder remains WARN until replaced by real binding create, steering, and terminal transition evidence. Legacy raw `payload.binding` / `payload.bindingId` records fail closed; filtered reports mark transition counts as filter-scoped. | operator-gated, not live-verified by repo tests |
| Task health observer | RuntimeMidCycleObserver fan-out/release tests, default-off TaskStallObserver threshold/tick/currentStalls/release tests, Discord service opt-in wiring/interval tests, `task.health_stalled` control-plane recorder tests, `/doctor` task-health rendering tests, `pnpm task:health:evidence:report` retained control-plane JSONL scorecard/template tests, and `/doctor` redacted task-health evidence summary. | Calibrated `AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS` and `AUTO_ARCHIVE_TASK_STALL_LEDGER_TICK_INTERVAL_MS`, one long-running task with runtime progress events, one no-progress interval visible in `/doctor`, one `task.health_stalled` ledger event visible through `/feed kind=task`, retained scorecard from the control-plane ledger, terminal release clearing state, and operator follow-up via `/status`, `/history`, `/feed`, or `/escalate`. | Requires operator-approved live service, representative runtime/provider latency data, and redacted task correlation ids. Background Discord push delivery remains a later/operator-gated artifact. CLI and `/doctor` replay existing retained control-plane metadata only; they must not tick observers, append events, mutate ledgers, contact services, or render raw task/correlation ids or payload blobs. `--print-template` may emit one compact non-promoting `task.health_stalled` control-plane JSONL placeholder with safe task-health metadata only, but it must not read ledgers, tick observers, append events, mutate/rotate ledgers, contact services, or pretty-print multi-line JSON; the placeholder remains WARN until replaced by real stall evidence with task and runtime correlation scopes. Unsafe task-health payload keys and excessive nesting fail the report. | operator-gated, not live-verified by repo tests |
| Trait scheduler tick evidence | UTC one-shot planner, bounded dispatch runner, cursor/lease/evidence JSONL tests, optional append-time valid-record retention tests, read-only scorecard CLI/template tests, and `/doctor` tick-evidence rendering tests. | Operator-owned tick loop with `runTraitSchedulerTickOnceWithLeaseAndEvidence()`, at least the minimum recommended evidence sample, zero unexplained dispatch failures/checkpoint holds, `/doctor` redacted scorecard, and retained JSONL artifact with a stated retention/backup-rotation policy. | Requires operator-owned scheduler/cursor/lease/evidence paths. `--print-template` may emit one compact non-promoting JSONL record for setup, but it must not read ledgers, run ticks, acquire leases, dispatch jobs, compact/rotate ledgers, or send Discord pushes; it rejects `--pretty` so the output remains one JSONL line. The JSONL writer can compact to the latest N valid records when the host constructs it with `retentionRecords`; that option assumes one writer per ledger path and does synchronous parse/rewrite on append. Backup/archive rotation and cross-process append serialization remain host-owned. `/doctor` reads only the configured evidence ledger and must not run ticks, acquire leases, dispatch jobs, compact/rotate ledgers, or send Discord pushes. | operator-gated, not live-verified by repo tests |
| Control-plane OTLP logs | Ledger observer fail-open tests, OTLP HTTP JSON payload/fetch/shutdown tests, and `/doctor` redacted config diagnostics for endpoint/resource-attribute parsing. | Collector-side log record or redacted collector receipt for a known control-plane event id, plus confirmation that no raw instruction/content/reason fields were exported. | Requires operator-approved OTLP collector endpoint in `AUTO_ARCHIVE_OTEL_LOGS_URL`; endpoint URLs and collector auth, if any, must not be leaked. `/doctor` must not contact the collector or export a test event; it reports only `protocol#hash`, counts, and fail-open/payload-boundary posture. | operator-gated, not live-verified by repo tests |
| SLURM/Apptainer compute | Command construction, resource envelope, subprocess runner, conformance tests. GPU requests are statically pinned to `salloc --gpus=<n>` plus Apptainer `--nv`; `gpu:research:readiness` parses non-secret `nvidia-smi` inventory before launch; `gpu:transformer:smoke` performs bounded CUDA Transformer train/eval when a GPU is eligible. | Real `salloc` / `apptainer exec` dispatch and cleanup evidence in the deployment environment. For GPU model training/evaluation, include readiness JSON, redacted `gpuCards>0`, `salloc --gpus`, Apptainer GPU exposure (`--nv` or documented site equivalent), training artifact path, evaluation metric artifact, terminal evidence, and cleanup/closeout record. | Requires site-approved cluster access, GPU quota, image path, entry script, and non-secret scheduler env allowlist. | operator-gated, not live-verified by repo tests |
| Peekaboo macOS/Discord GUI path | Dry-run/probe/live planning, MCP schema, readiness report, evidence ledger append/query tests, MCP quantitative scorecard, `pnpm peekaboo:evidence:report` bounded JSONL replay/template tests, and `/doctor` redacted scorecard summary. | JSONL evidence record with readiness, GUI submit, task correlation, bot ack/matched reply, artifact path, and PASS/WARN/FAIL outcome. | Live REST observation requires operator-authorized env path or token env; GUI mutation requires macOS Accessibility/Screen Recording and logged-in Discord desktop. CLI and `/doctor` replay existing redacted ledger metadata only; they must not submit GUI actions, poll Discord, mutate ledgers, or render raw notes/correlation ids. `--print-template` may emit one compact non-promoting dry-run evidence placeholder, but it must not read ledgers, submit GUI actions, poll Discord, contact Peekaboo/provider services, mutate/rotate ledgers, or pretty-print multi-line JSON; the placeholder and repeated placeholders remain insufficient because they are not live GUI evidence. | operator-gated, not live-verified by repo tests |
| Persona model rewrite | **Mothballed 2026-05-18.** Presentation-only, fail-open, hard-verbatim, protected-token tests, `persona-transform-observed` metadata logging, `pnpm persona:telemetry:report` bounded JSONL scorecard/template tests, and `/doctor` redacted telemetry summary are retained for historical audit. | No new live artifact is required while mothballed. Historical sampled transform telemetry may still be replayed if retained by the operator, but the surface is excluded from active live-readiness scoring. | Reactivation requires `AUTO_ARCHIVE_PERSONA_MOTHBALLED=0`, `AUTO_ARCHIVE_PERSONA_MODE=duet`, and a persona-scoped API key or explicit fallback. Logs must not contain prompt text, user content, transformed text, task ids, or credentials by default. CLI and `/doctor` replay existing redacted telemetry metadata only; they must not call persona models, contact providers, mutate ledgers, or render raw prompt/source dialogue/transformed text/task ids. Nested raw-content/task-id/credential keys and excessive nesting fail the report without rendering their values. | mothballed; not release-gating |

## Reporting rule

- Repository-local commands may justify `PASS` only for static readiness.
- Live status remains `WARN` or `operator-gated` until the required artifact for
  that row is recorded.
- Mothballed rows, currently `persona-model-rewrite`, are retained in the
  manifest vocabulary for historical replay but excluded from active
  live-readiness status and quality scoring unless their proof boundary is
  unsafe.
- `plana-runtime-advisor` remains an active runtime review/advisor surface. It
  is separate from the mothballed Arona/Plana presentation-voice rewrite.
- A live proof artifact must identify the surface, timestamp, operator-approved
  configuration source, redacted correlation ids, and outcome. It must not
  include raw tokens, `.env` contents, private keys, or full secret-bearing logs.

## Read-only artifact report

Operators can summarize retained live proof artifacts without contacting live
services by writing a redacted `schemaVersion: 1` JSON manifest and running:

```bash
pnpm live:proof:report -- --proof runtime-state/live-proof.json --pretty
```

To reduce operator copy/paste errors, generate a redacted manifest skeleton
before filling in real proof metadata:

```bash
pnpm live:proof:report -- --print-template --surface focus-session-binding-ux --pretty
```

The manifest `proofs[]` records use the matrix surface token, a safe proof id,
timestamp, `pass|warn|fail` status, explicit `operatorApproved` flag, redacted
artifact tokens, and boundary booleans for secret/content exclusion. The report
compares each proof against the required artifact tokens for its surface and
flags missing evidence, failed/warning proofs, missing operator approval, and
unsafe boundary flags. The command is a static checker only: it does not read
environment variables, render raw summaries or correlation ids, mutate proof
files, contact Discord/GitLab/provider/SLURM/Peekaboo/OTLP services, or turn an
operator-gated row into live-ready by itself.

`--print-template` is also read-only. It emits a valid `schemaVersion: 1`
manifest with `operatorApproved:false`, `status:"warn"`, safe boundary
defaults, and the required artifact tokens for the selected surface(s), but it
does not read proof files, write output files, contact live services, or promote
any row by itself.

The static checker must stay in sync with this matrix, including the
open-harness UX rows `durable-task-archive-ux`,
`subagent-operator-surface`, and `focus-session-binding-ux`. Their required
artifact tokens mirror the live artifact columns above: archive/unarchive
interaction plus retained archive audit evidence, live root-owned subagent
operator interaction plus roster lifecycle/progress evidence, and
focus/focused-steering/unfocus plus retained binding lifecycle evidence.

Required proof boundary keys are `secretsRedacted`, `rawTokensIncluded`,
`rawCredentialsIncluded`, `rawPromptsIncluded`, `rawResponsesIncluded`,
`rawInstructionsIncluded`, and `rawPrivateArtifactContentIncluded`. The emitted
report is `schemaVersion: 1` and contains `status`, `filter`, `method`,
`source`, `scorecard`, redacted proof assessments, and a read-only boundary
block. With an explicit `--generated-at`, the report is intended to be
diff-friendly for the same manifest/filter; raw proof summaries and raw
correlation ids are never rendered. Correlation ids are counted only in proof
assessments. CLI exit code `0` means a report was generated even when the
report-level `status` is `warn`, `fail`, or `no-proof`; exit code `1` is
reserved for argument, file, byte-guard, JSON, or manifest validation failures.
Set `AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH` to expose the same scorecard in
`/doctor`; `AUTO_ARCHIVE_LIVE_PROOF_MAX_BYTES` applies the bounded read guard.
The `/doctor` path remains a static manifest reader: it does not contact live
services, mutate proof files, render raw summaries or raw correlation ids, or
promote an operator-gated row to live-ready by itself.

For Plana advisor event ledger setup, operators can generate one compact
non-promoting advisor audit record before replacing it with retained output from
real sampled advisor reviews:

```bash
pnpm --silent plana:advisor:events:report -- --print-template --generated-at 2026-05-05T10:20:00.000Z > runtime-state/plana-advisor-events.jsonl
```

The placeholder is schema-valid redacted JSONL but intentionally remains
insufficient for trend evidence: it is a single `skip`/advisor-fail-open setup
record, not a successful Claude consultation. Template mode reads no ledgers,
does not call Claude/advisor/provider paths, does not contact
Discord/GitLab/provider services, does not mutate or rotate ledgers, and rejects
report-only flags such as `--pretty` so the output stays one compact JSONL
line. Operators can replay retained advisor ledgers with:

```bash
pnpm plana:advisor:events:report -- --ledger runtime-state/plana-advisor-events.jsonl --pretty
```

The replay report counts valid records, veto/fail-open totals, malformed/torn
lines, and last event time without rendering prompt text, response text,
free-form veto reasons, Discord content, or raw instructions.

For Trait scheduler tick evidence setup, operators can generate one compact
non-promoting JSONL record before replacing it with retained output from a real
host-owned tick loop:

```bash
pnpm --silent trait:scheduler:evidence:report -- --print-template --generated-at 2026-05-05T09:10:00.000Z > runtime-state/trait-scheduler-tick-evidence.jsonl
```

The record is schema-valid but intentionally contains a held checkpoint and
dispatch failure, so the report remains insufficient for trend/promotion until
real tick evidence replaces it. Template mode does not read ledgers, run ticks,
acquire leases, dispatch jobs, mutate files, or emit pretty multi-line JSON.

For autonomous-research archive-loop evidence setup, operators can generate a
non-promoting TerminalEvidence skeleton before replacing it with retained output
from a real bounded run:

```bash
pnpm --silent autonomous:research:evidence:report -- --print-template --generated-at 2026-05-05T14:02:00.000Z --pretty > runtime-state/autonomous-research-template.json
```

The skeleton is schema-valid, read-only, and intentionally scores as
`not-requested` when fed back into `autonomous:research:evidence:report`: it has
no autonomous-research checkpoints and uses a template `driver-failure` cause. It
does not read evidence files, run autonomous research, call runtime
drivers/delegates, contact services, mutate files, or promote the live-proof
row. Any manual edit to the skeleton invalidates that non-promoting guarantee
until the edited file is re-checked by this report command.

For operator-authored AgentHarnessPlugin descriptor setup, generate a metadata-only
skeleton before filling in host-specific harness rationale:

```bash
pnpm --silent agent:harness:registry:report -- --print-template --provider codex --pretty
```

The harness descriptor template is read-only and schema-valid, but it is not a
live integration report: it does not read descriptor files, import plugin code,
call `wrapDriver()`, create runtime drivers, contact registries/services, switch
providers, or promote the agent-harness row out of operator-gated status. Use
`pnpm --silent` when redirecting JSON output so package-manager lifecycle text
does not enter the retained artifact.

For retained runtime-provider TerminalEvidence, operators can run:

```bash
pnpm runtime:provider:evidence:report -- --evidence runtime-state/provider-terminal-evidence.json --provider codex --pretty
```

Repeat `--evidence` for multiple retained terminal records; use
`--provider codex` or `--provider claude-agent` to filter to the active provider,
or omit the filter to score both supported providers. The report parses
TerminalEvidence JSON only, checks canonical driver provenance
(`codex-runtime-driver` / `claude-agent-runtime-driver`), terminal
success/failure counts, provider-failure classifications, retained runtime
settings/resource snapshots, transcript event counts, and token usage when
available. It reports raw task ids, runtime instance ids, terminal reasons, and
transcripts as boundary flags only; values are never rendered. Set
`AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_PATH` to expose the same redacted
scorecard in `/doctor`; `AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_MAX_BYTES`
controls the bounded read guard. The CLI and `/doctor` never instantiate
RuntimeDrivers, contact Codex/Claude Agent, switch providers, mutate evidence,
or promote an operator-gated provider row to live-ready by themselves.

For retained task-health control-plane evidence, operators can run:

```bash
pnpm task:health:evidence:report -- --ledger runtime-state/research-control-events.jsonl --pretty
```

To initialize an operator-owned task-health evidence ledger without accidentally
creating complete retained evidence, operators can emit one compact
non-promoting placeholder:

```bash
pnpm --silent task:health:evidence:report -- --print-template --generated-at 2026-05-05T11:10:01.000Z > runtime-state/research-control-events.jsonl
```

The template is valid control-plane JSONL but records only a safe
`task.health_stalled` placeholder without task or runtime correlation scopes. It
remains `warn` until real retained stall evidence supplies both scopes, and
template mode does not read ledgers, tick observers, append control-plane
events, mutate/rotate ledgers, contact live services, or pretty-print
multi-line JSON.

The report scores `task.health_stalled` events only, counts malformed/torn and
non-task-health lines, checks task/correlation scoping, and reports stall
duration aggregates without rendering raw task ids, raw correlation ids,
Discord content, task instructions, or payload blobs. Filters apply before the
bounded tail `--limit`; the local quality rubric is evidence presence 35,
task-scope coverage 20, runtime-correlation coverage 20, and clean replay/no
unsafe payload 25. Set
`AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_LEDGER_PATH` to expose the same scorecard in
`/doctor`; `AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_MAX_LEDGER_BYTES` controls the
bounded replay guard. The CLI and `/doctor` never tick observers, append
control-plane events, mutate ledgers, contact live services, or send Discord
notifications.

For retained task archive/unarchive control-plane evidence, operators can run:

```bash
pnpm task:archive:evidence:report -- --ledger runtime-state/research-control-events.jsonl --pretty
```

To initialize an operator-owned archive evidence ledger without accidentally
creating complete retained evidence, operators can emit one compact
non-promoting placeholder:

```bash
pnpm --silent task:archive:evidence:report -- --print-template --generated-at 2026-05-05T07:10:00.000Z > runtime-state/research-control-events.jsonl
```

The template is valid control-plane JSONL but records only a metadata-only
`task.archived` placeholder with stable redacted task/actor hashes. It remains
`warn` because matching `task.unarchived` evidence is absent, and template mode
does not read ledgers, run archive/unarchive handlers, mutate archive state,
contact services, compact/rotate ledgers, or pretty-print multi-line JSON.

For retained subagent operator roster evidence, operators can run:

```bash
pnpm subagent:operator:evidence:report -- --ledger runtime-state/subagent-roster-events.jsonl --pretty
```

To initialize a caller-owned roster-event ledger without accidentally creating
healthy retained evidence, operators can emit one compact non-promoting
placeholder:

```bash
pnpm --silent subagent:operator:evidence:report -- --print-template --generated-at 2026-05-05T08:10:00.000Z > runtime-state/subagent-roster-events.jsonl
```

The template is schema-valid JSONL but records only an active `subagent.spawned`
placeholder. It remains `warn` because terminal lifecycle and `roster.progress`
evidence are absent, and template mode does not read ledgers, inspect or mutate
live subagents, contact services, or pretty-print multi-line JSON.

The report scores `subagent.spawned`, terminal subagent events, and
`roster.progress` samples, counts lifecycle/scoping anomalies, malformed/torn
lines, and unsafe raw operator payloads without rendering raw subagent ids, raw
task ids, raw runtime instance ids, messages, artifacts, prompts, responses, or
payload blobs. Spawn+terminal-only evidence remains `warn` until at least one
retained `roster.progress` sample is present. Filters apply before the bounded
tail `--limit`; transition
counts in filtered reports are explicitly filter-scoped. Set
`AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH` to expose the same
scorecard in `/doctor`;
`AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_MAX_LEDGER_BYTES` controls the bounded
replay guard. The CLI and `/doctor` never spawn, steer, kill, inspect live
subagents, mutate ledgers, contact live services, or promote the operator
surface from operator-gated to live-ready by themselves.

For retained focus/session binding evidence, operators can run:

```bash
pnpm session:binding:evidence:report -- --ledger runtime-state/research-control-events.jsonl --pretty
```

To initialize an operator-owned focus/session evidence ledger without
accidentally creating complete retained evidence, operators can emit one compact
non-promoting placeholder:

```bash
pnpm --silent session:binding:evidence:report -- --print-template --generated-at 2026-05-05T09:10:00.000Z > runtime-state/research-control-events.jsonl
```

The template is valid control-plane JSONL but records only a metadata-only
`session.binding_created` placeholder with stable redacted
binding/task/owner/channel/thread/subagent hashes. It remains `warn` because
steering and terminal lifecycle evidence are absent, and template mode does not
read ledgers, focus, unfocus, steer, append events, mutate/rotate ledgers,
contact live services, or pretty-print multi-line JSON.

The report scores focus binding creation, steering submission, and terminal
release/change/expiry/eviction evidence using metadata-only `bindingAudit`
payloads. It reports binding/task/owner/channel/thread/subagent scoping,
transition anomalies, malformed/torn lines, and unsafe legacy raw binding
payloads without rendering raw binding ids, raw task ids, owner ids,
guild/channel/thread ids, subagent ids, instructions, steering text, or payload
blobs. Retained hashes are domain-separated HMAC digests with a process-local
random pepper when `AUTO_ARCHIVE_SESSION_BINDING_AUDIT_HASH_PEPPER` is unset or
blank; set a high-entropy deployment pepper only when operators need stable
cross-restart correlation, and treat pepper rotation as a deliberate continuity
break. Set `AUTO_ARCHIVE_SESSION_BINDING_EVIDENCE_LEDGER_PATH` to expose the
same scorecard in `/doctor`;
`AUTO_ARCHIVE_SESSION_BINDING_EVIDENCE_MAX_LEDGER_BYTES` controls the bounded
replay guard. The CLI and `/doctor` never focus, unfocus, steer, append events,
mutate ledgers, contact live services, or promote the focus/session binding row
from operator-gated to live-ready by themselves.

For Peekaboo GUI evaluation ledgers, operators can run:

```bash
pnpm --silent peekaboo:evidence:report -- --print-template --generated-at 2026-05-05T12:10:00.000Z > runtime-state/peekaboo-evidence.jsonl
```

This template mode emits exactly one compact, redacted, non-promoting dry-run
evidence JSONL placeholder. It reads no ledger, submits no GUI actions, polls no
Discord REST path, contacts no Peekaboo/provider services, mutates or rotates no
ledger, and rejects report-only options such as `--pretty`; the placeholder
remains insufficient for promotion because live sample size stays zero even if
operators concatenate repeated template rows.

```bash
pnpm peekaboo:evidence:report -- --ledger runtime-state/peekaboo-evidence.jsonl --pretty
```

This reuses the MCP quantitative-report rubric outside the MCP server. It reads
an existing JSONL ledger with a bounded byte guard, records malformed/torn line
counts in `replayAudit`, and reports only aggregate scorecard metadata. Set
`AUTO_ARCHIVE_PEEKABOO_EVIDENCE_LEDGER_PATH` to expose the same redacted
scorecard in `/doctor`;
`AUTO_ARCHIVE_PEEKABOO_EVIDENCE_MAX_LEDGER_BYTES` controls the replay guard.
Neither surface submits GUI actions, polls Discord, contacts providers, mutates
the ledger, renders raw notes, or renders raw correlation ids. `/doctor` marks
empty/insufficient samples and any malformed/torn ledger line as WARN rather
than treating partial replay as clean live evidence.

Persona model rewrite is mothballed as of 2026-05-18, so operators do not need
to collect new live transform telemetry for release readiness. To replay
historical retained telemetry or prepare a non-promoting placeholder, operators
can still run:

```bash
pnpm --silent persona:telemetry:report -- --print-template --generated-at 2026-05-05T04:10:00.000Z > runtime-state/persona-telemetry.jsonl
```

This template mode emits exactly one compact, metadata-only
`persona-transform-observed` JSONL placeholder. It reads no ledger, calls no
persona model/provider, contacts no Discord/GitLab/provider services, mutates or
rotates no ledger, and rejects report-only options such as `--pretty`; the
placeholder remains historical/non-promoting while the surface is mothballed.

```bash
pnpm persona:telemetry:report -- --ledger runtime-state/persona-telemetry.jsonl --pretty
```

The input is an operator-owned redacted JSONL stream containing
`persona-transform-observed` metadata. The report scores sampled success/fallback
outcomes, latency-budget compliance, token totals, and a human
`humanReviewedNoSourceDialogueCopy` annotation without rendering raw persona
text or task ids. Set `AUTO_ARCHIVE_PERSONA_TELEMETRY_LEDGER_PATH` to expose the
same redacted scorecard in `/doctor`;
`AUTO_ARCHIVE_PERSONA_TELEMETRY_MAX_LEDGER_BYTES` controls the bounded replay
guard. Raw content keys force FAIL; malformed/torn lines, insufficient samples,
or missing human no-copy review remain WARN for the historical telemetry report
and do not reactivate the mothballed live-proof row.
live-ready by themselves.
