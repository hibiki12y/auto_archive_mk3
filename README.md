# Auto Archive Mk3 — Reimplementation Stub

현재 브랜치(`master`)는 **신규 재구현 시작점**입니다. (2026-05 git 저장소 이전 이전의 작업 브랜치명은 `reimpl/arona-plana-dispatcher-core`였으며, 이전으로 인해 그 브랜치 히스토리는 단일 init 커밋으로 압축되어 현재 `master` HEAD 트리에 그대로 정착되었습니다. 본 문서가 이전 브랜치명을 인용하는 historical 위치는 그 사실을 함께 명시합니다.)

- 현재 초점: **Arona / Plana / Dispatcher core contract** 정리와 **runtime skeleton** 마련
- 현재 상태: **스캐폴드 단계**이며, 완료된 rewrite가 아닙니다
- 현재 구현 권위는 `specs/` 와 `src/`, `tests/` 에 있으며, 보조 문서는 `documents/host-setup-*.md` 와 `documents/references/` 에 있습니다
- `PROJECT.md` 는 broader project/program context와 target-state planning을 담을 수 있지만, **현재 브랜치 구현 상태의 권위 문서는 이 README입니다**

## Branch intent

- 기존 루트 구현을 바로 이어서 수정하는 대신, 핵심 계약과 런타임 골격부터 다시 세웁니다
- 우선순위는 인터페이스 경계, 메시지/디스패치 흐름, 최소 실행 구조입니다
- 세부 기능 복원과 확장은 이후 단계에서 진행됩니다

## What to expect here

- fresh-root reimplementation scaffold
- core contract documents and bootstrap code
- dispatcher-centric runtime skeleton
- legacy 대비 범위 축소 및 점진적 이전

## Current implemented slices

- dispatcher / control / runtime contract surface
- delegated clone backend seam
- bootstrap-time runtime provider seam (`codex` default, optional `claude-agent`)
- Discord first-slice integration
- Discord turnkey smoke bootstrap/run path
- Always-on Discord research control-plane first slice: durable JSONL ledger, replay-backed task registry, persistent research agenda/cadence, instruction envelope, access policy, and registry-backed command surface (`/ask`, `/research`, `/evidence`, `/claim`, `/critique`, `/proof`, `/status`, `/cancel`, `/rerun`, `/tasks`, `/traits`, `/archive`, `/unarchive`, `/agenda`, `/history`, `/context`, `/escalate`, `/feed`, `/approve`, `/deny`, `/doctor`, `/subagents`, `/focus`, `/unfocus`, `/auth`, `/insights`, `/config`, `/research-plan`, `/help`, `/quickstart`, `/follow`)
- GitLab work-result recording first slice: Arona can create/annotate/close GitLab issues, and completed delegated agent work can be recorded as a GitLab issue or as a note on a configured issue
- Operator shell-hook bridge: default-off lifecycle hooks with command allowlist, bounded timeouts, and explicit non-interactive consent via `AUTO_ARCHIVE_ACCEPT_HOOKS=1`
- Research-plan orchestrator: sequential N-sub-task + 1-synthesis decomposition for ultra-deep research that exceeds single-shot SDK ceilings (Codex ~17 min compact-task 502 / Claude `max_turns` exhaustion). Operator CLI: `pnpm research:plan:run <plan.json> [--provider codex|claude-agent] [--max-turns N] [--report-out <file>]` — sample plan in `examples/research-plans/`. Programmatic API: `runResearchPlan(driver, plan)` from `src/core/research-plan-orchestrator.ts`.

현재 브랜치는 위 slice들이 **implemented scaffold surface**로 존재하는 상태이며, 아직 full rewrite complete 상태는 아닙니다.

## Current runtime provider bootstrap support

- runtime provider scope: **bootstrap-time multi-provider**
  - `AUTO_ARCHIVE_RUNTIME_PROVIDER=codex` (default) uses
    `@openai/codex-sdk`.
  - `AUTO_ARCHIVE_RUNTIME_PROVIDER=claude-agent` uses
    `@anthropic-ai/claude-agent-sdk`.
  - The provider is selected once at service bootstrap. Mid-flight provider
    switching, runtime fan-out/council execution, Copilot CLI as a provider, and
    OpenAI tool-calling bridge runtime paths remain out of scope.
- supported Codex bootstrap inputs today:
  - Codex CLI local auth at `~/.codex/auth.json` (preferred when valid)
  - `AUTO_ARCHIVE_CODEX_API_KEY` (fallback only when Codex CLI auth is absent)
  - `AUTO_ARCHIVE_CODEX_AUTH_SOURCE` (optional `auto` / `codex-cli` / `api-key` selection; default `auto`)
  - `AUTO_ARCHIVE_CODEX_CLI_PATH` (optional CLI path override used by the Codex SDK bootstrap path)
  - `AUTO_ARCHIVE_CODEX_CLI_HOME_MODE` (optional `default` / `isolated-auth`; Docker defaults to `isolated-auth` so host `~/.codex/config.toml` or `~/.codex/.env` proxy/telemetry settings do not leak into containerized Codex runs)
  - `AUTO_ARCHIVE_CODEX_ISOLATED_HOME` (optional isolated Codex home path used with `AUTO_ARCHIVE_CODEX_CLI_HOME_MODE=isolated-auth`)
  - `AUTO_ARCHIVE_CODEX_MODEL` (optional Codex SDK thread model override; use this to avoid an inaccessible global Codex default model)
  - `AUTO_ARCHIVE_CODEX_MODEL_FALLBACK` (optional one-shot fallback model used only when the primary/global model fails with a model-access/config error)
  - `AUTO_ARCHIVE_CODEX_REASONING_EFFORT` (optional Codex SDK thread reasoning effort; one of `minimal`, `low`, `medium`, `high`, `xhigh`)
  - `AUTO_ARCHIVE_CODEX_SETTINGS_FILE` (optional operator-authored JSON settings file; fallback/additive only, with env retaining precedence on overlapping `apiKey` / `codexPathOverride` keys)
- supported Claude Agent bootstrap inputs today:
  - `AUTO_ARCHIVE_ANTHROPIC_API_KEY` (production/API-key path)
  - `AUTO_ARCHIVE_CLAUDE_CLI_PATH` (single-user local development path to a
    `claude` binary)
  - `AUTO_ARCHIVE_CLAUDE_MODEL`
  - `AUTO_ARCHIVE_CLAUDE_FALLBACK_MODEL`
  - `AUTO_ARCHIVE_CLAUDE_REASONING_EFFORT`
  - `AUTO_ARCHIVE_CLAUDE_PERMISSION_MODE`
  - `AUTO_ARCHIVE_CLAUDE_MAX_TURNS`
  - `AUTO_ARCHIVE_CLAUDE_MAX_BUDGET_USD`
- Codex auth precedence today:
  - `AUTO_ARCHIVE_CODEX_AUTH_SOURCE=auto` keeps the default order: valid `~/.codex/auth.json` wins over API-key bootstrap
  - `AUTO_ARCHIVE_CODEX_AUTH_SOURCE=codex-cli` requires valid local Codex auth and fails closed if it is absent
  - `AUTO_ARCHIVE_CODEX_AUTH_SOURCE=api-key` uses `AUTO_ARCHIVE_CODEX_API_KEY` or settings-file `apiKey` and intentionally skips local CLI-auth inspection
  - in `auto` / `codex-cli`, malformed/unreadable positively-detected `~/.codex/auth.json` fails closed; it does not silently fall back to `AUTO_ARCHIVE_CODEX_API_KEY`
  - `AUTO_ARCHIVE_CODEX_CLI_HOME_MODE=isolated-auth` creates a child-process-only Codex home containing only an `auth.json` symlink, preventing host Codex config/dotenv proxy settings from affecting container runtime provider calls
- Codex model override note:
  - `AUTO_ARCHIVE_CODEX_MODEL` / `AUTO_ARCHIVE_CODEX_REASONING_EFFORT` are env-only runtime overrides passed through the Codex SDK thread options, so a repo smoke run can use a known-accessible model even if `~/.codex/config.toml` has an inaccessible top-level default
  - `AUTO_ARCHIVE_CODEX_MODEL_FALLBACK` is not a silent model selector; it retries once only after a model-specific permanent-config failure such as “invalid/unknown/unsupported/not accessible model”
  - `AUTO_ARCHIVE_CODEX_SETTINGS_FILE` remains JSON-only for `apiKey` / `codexPathOverride`; it does not accept model/config keys
- multi-provider reference:
  - `specs/CLARIFICATIONS/multi-provider-scope.md`
  - `specs/CURRENT/live-proof-matrix.md` separates repository-local bootstrap
    readiness from operator-gated live verification; bootstrap support does not
    by itself mean Discord/GitLab/provider/SLURM/Peekaboo/Persona live proof has
    been collected.
  - operators can score retained, redacted live-proof manifests without
    contacting any live service:

    ```bash
    pnpm live:proof:report -- --proof runtime-state/live-proof.json --pretty
    ```

    To start an operator-owned redacted manifest without guessing the required
    artifact tokens, print a skeleton first:

    ```bash
    pnpm live:proof:report -- --print-template --surface focus-session-binding-ux --pretty
    ```

    The manifest is operator-owned JSON with `schemaVersion: 1` and `proofs[]`
    records keyed by `surface` tokens from the live-proof matrix, such as
    `discord-service`, `gitlab-recording`, `control-plane-otel-logs`,
    `autonomous-research-evidence`, `durable-task-archive-ux`,
    `subagent-operator-surface`, or `focus-session-binding-ux`. Each proof
    records a safe `proofId`,
    timestamp, `pass|warn|fail` status, explicit `operatorApproved` flag,
    redacted artifact tokens, and boundary booleans proving that raw tokens,
    credentials, prompts, responses, task instructions, and private artifact
    content are not retained in the proof. The required boundary keys are
    `secretsRedacted`, `rawTokensIncluded`, `rawCredentialsIncluded`,
    `rawPromptsIncluded`, `rawResponsesIncluded`, `rawInstructionsIncluded`,
    and `rawPrivateArtifactContentIncluded`.
    `live:proof:report` compares the artifact tokens with
    `specs/CURRENT/live-proof-matrix.md`, reports missing artifact evidence,
    unsafe boundary flags, and per-surface counts, but it does not read
    environment variables, render raw summaries/correlation ids, mutate the
    proof file, or contact Discord/GitLab/provider/SLURM/Peekaboo or OTLP
    collector services. The JSON output is also `schemaVersion: 1` and includes
    `status`, `filter`, `method`, `source`, `scorecard`, redacted `proofs[]`
    assessments, and a read-only `boundary`; with `--generated-at`, output is
    deterministic for the same manifest and filter. Correlation ids are counted
    only and are never rendered raw. Exit code `0` means a report was generated
    even when report `status` is `warn`, `fail`, or `no-proof`; exit code `1`
    is reserved for arguments, file IO, byte guard, JSON, or manifest validation
    failures. Always-on operators can set
    `AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH` so `/doctor` renders the same
    redacted scorecard; `AUTO_ARCHIVE_LIVE_PROOF_MAX_BYTES` applies the same
    bounded read guard. `--print-template` is also read-only: it emits a valid
    schemaVersion 1 manifest skeleton with `operatorApproved:false`,
    `status:"warn"`, safe boundary defaults, and required artifact tokens for
    the selected surface(s), but it does not write files or contact services.
    `/doctor` reads only the manifest, renders no raw proof
    summaries or raw correlation ids, and does not contact live services or
    promote operator-gated rows by itself.
  - provider-specific retained TerminalEvidence can be scored without a live
    provider call:

    ```bash
    pnpm runtime:provider:evidence:report -- --evidence runtime-state/provider-terminal-evidence.json --provider codex --pretty
    ```

    Repeat `--evidence` to summarize several retained terminal records; omit
    `--provider` to score both `codex` and `claude-agent`, or pass the active
    provider explicitly. The report checks canonical runtime-driver provenance
    (`codex-runtime-driver` / `claude-agent-runtime-driver`), terminal
    success/failure counts, provider-failure classifications, retained runtime
    settings/resource snapshots, transcript event counts, and token usage when
    available. It does not instantiate RuntimeDrivers, call Codex, call Claude
    Agent, switch providers, read environment variables, mutate evidence files,
    render raw task ids, render raw runtime instance ids, render raw terminal
    reasons, or render raw transcript content. Set
    `AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_PATH` to expose the same redacted
    scorecard in `/doctor`; `AUTO_ARCHIVE_RUNTIME_PROVIDER_EVIDENCE_MAX_BYTES`
    controls the bounded read guard. This scorecard complements
    `live:proof:report`: the manifest remains the operator-approved artifact
    token gate, while this command parses retained TerminalEvidence itself.
    To start an operator-owned provider evidence file without accidentally
    implying a successful authenticated run, generate a non-promoting skeleton:

    ```bash
    pnpm --silent runtime:provider:evidence:report -- --print-template --provider codex --generated-at 2026-05-05T16:02:00.000Z --pretty > runtime-state/provider-terminal-evidence-template.json
    ```

    The template is valid TerminalEvidence with canonical runtime-driver
    provenance for the selected provider, but it uses a `driver-failure`
    template cause, empty transcript metadata, and no successful provider turn.
    Feeding it back into the report remains `warn` and insufficient for provider
    proof until it is replaced by retained TerminalEvidence from a real
    authenticated provider run. Template mode reads no evidence files, does not
    instantiate drivers, does not contact Codex or Claude Agent, and accepts at
    most one `--provider`.
  - `src/runtime/runtime-driver-factory.ts`
  - optional `AgentHarnessPlugin` bindings can wrap the bootstrap-selected
    `RuntimeDriver` through `src/contracts/agent-harness-plugin.ts` and
    `src/runtime/agent-harness-registry.ts`; they are explicit factory inputs,
    fail closed when configured but unsupported, and do not enable mid-flight
    provider switching. Hosts can call
    `buildAgentHarnessRegistryReport()` to explain which configured harness
    would bind and why each alternative is unsupported without calling
    `wrapDriver()`. For local operator snapshots, provide a metadata-only JSON
    descriptor and run:

    ```bash
    pnpm --silent agent:harness:registry:report -- --plugins runtime-state/agent-harnesses.json --provider codex --pretty
    ```

    To reduce descriptor setup mistakes, generate a metadata-only skeleton first:

    ```bash
    pnpm --silent agent:harness:registry:report -- --print-template --provider codex --pretty
    ```

    The descriptor CLI is read-only: it does not import plugin code, create a
    runtime driver, switch providers, install/fetch registries, contact
    Discord/GitLab/provider services, or mutate the descriptor. It is a
    diagnostics surface for explicit host-owned harness metadata, not an
    auto-discovery or plugin-loading mechanism. `--print-template` is also
    read-only: it emits a valid `schemaVersion: 1` descriptor skeleton with an
    operator-owned research harness placeholder, but it does not read descriptor
    files, import plugin code, call `wrapDriver()`, or alter provider selection.
    Use `pnpm --silent` when redirecting the machine-readable JSON output so
    package-manager lifecycle text does not enter the artifact. Always-on
    operators can set
    `AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_DESCRIPTOR_PATH` so `/doctor` renders
    the same descriptor-backed selection preview. The companion
    `AUTO_ARCHIVE_AGENT_HARNESS_REGISTRY_MAX_DESCRIPTOR_BYTES` applies the
    bounded read guard. `/doctor` reads descriptor metadata only and must not
    import plugin code, call `wrapDriver()`, create a runtime driver, fetch
    registries, or alter provider selection.
  - local doctor CLI: `pnpm run doctor` (package script: `npm run doctor`) builds
    the repo and renders the same env-derived diagnostic report used by the
    Discord `/doctor` surface. It is intentionally non-mutating: remediation
    hints are printed, but there is no `--fix` mode. Do not use bare
    `pnpm doctor`; that is pnpm's own diagnostic command and does not render
    the Auto Archive report.
  - `/doctor` reports the active provider and Claude/Plana-advisor readiness
    when run through the Discord service path. Operators that enable
    `AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER=claude-agent` may also set
    `AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_LEDGER_PATH` to append redacted JSONL
    advisor verdict breadcrumbs (task/instance/event/verdict metadata only; no
    prompt text, response text, free-form reason, Discord content, or raw
    instruction). When the ledger path is configured, `/doctor` replays it
    read-only with a bounded `AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_MAX_LEDGER_BYTES`
    guard and reports valid record count, trend-sample sufficiency, veto count,
    advisor fail-open count, malformed/torn line count, and last event time
    without running advisor calls or mutating the ledger.
    Local operators can start an operator-owned advisor ledger skeleton without
    accidentally implying a live Claude consultation:

    ```bash
    pnpm --silent plana:advisor:events:report -- --print-template --generated-at 2026-05-05T10:20:00.000Z > runtime-state/plana-advisor-events.jsonl
    ```

    The template is one compact metadata-only JSONL record. It reads no ledger,
    calls no Claude/advisor/provider path, contacts no Discord/GitLab/provider
    service, mutates or rotates no ledger, rejects report-only flags such as
    `--pretty`, and remains insufficient/non-promoting until replaced by at
    least 5 real redacted advisor event records. Local operators can render the
    same advisor-ledger scorecard without starting Discord:

    ```bash
    pnpm plana:advisor:events:report -- --ledger runtime-state/plana-advisor-events.jsonl --pretty
    ```

    The command accepts `--task-id`, `--event-kind`, `--verdict
    approve|veto|skip`, `--consultation-outcome
    consulted|advisor-error-fail-open`, `--limit`, `--max-ledger-bytes`, and
    `--generated-at`; filters compose by AND, `--limit` is applied after the
    other filters, and the report command only reads the JSONL file and prints
    JSON to stdout.

## Operator shell-hook bridge

The shell-hook bridge is an advanced operator extension surface for M5a
lifecycle observation. It is default-off. A hook entry is executable only when:

1. `AUTO_ARCHIVE_SHELL_HOOKS=on` is set,
2. the exact `(event, command)` pair is already present in the shell-hook
   allowlist, or the operator explicitly sets `AUTO_ARCHIVE_ACCEPT_HOOKS=1` for
   that process, and
3. the command is parsed into argv and spawned with `shell:false`.

`AUTO_ARCHIVE_ACCEPT_HOOKS=1` performs an explicit in-memory consent resolution
for configured entries and emits `shell-hook-auto-allowlisted` diagnostics.
Callers that want durable consent can persist the returned allowlist with
`saveAllowlist`; without the accept env the bridge logs
`shell-hook-consent-required` and does not run the unapproved entry.
`/doctor` reports the master gate and consent-env state so operators can spot
ignored or invalid hook consent before launching a live service.


## Peekaboo remote evaluation MCP path

The Peekaboo/macOS agent-node direct-control evaluation path is now standardized in `specs/GUIDES/peekaboo-remote-evaluation-mcp.md` and exposed as a local stdio MCP server.

Package scripts:

```bash
pnpm peekaboo:mcp        # build, then run the stdio MCP server
pnpm peekaboo:mcp:start  # run the compiled server after pnpm build
```

Repository-local VS Code MCP registration is deprecated and intentionally not checked in. Register the server in your MCP client using `node scripts/start-peekaboo-remote-eval-mcp.mjs`; the starter sends build output to stderr so MCP stdout remains JSON-RPC only.

### Project-local Codex MCP usage

Codex CLI does not currently expose a repository-scoped `codex mcp add --project`
registration path. Running `codex mcp add` writes to the active `CODEX_HOME`
configuration (normally `~/.codex/config.toml`), so it is a global/user-scope
mutation rather than a project-local install.

For this repository, prefer the checked-in helper that injects the Peekaboo MCP
server with per-invocation Codex `-c` overrides and an absolute path to this
repo's starter script:

```bash
pnpm peekaboo:codex:mcp-list
pnpm peekaboo:codex
pnpm peekaboo:codex:exec -- "List MCP tools and confirm Peekaboo is present."
```

- `pnpm peekaboo:codex:mcp-list` verifies the temporary MCP registration without
  editing `~/.codex/config.toml`.
- `pnpm peekaboo:codex` starts interactive Codex and therefore must be run from
  a real terminal/TTY.
- `pnpm peekaboo:codex:exec -- "<prompt>"` is the non-interactive path to use
  when stdin is piped or a command runner reports `stdin is not a terminal`.

MCP tools:

- `peekaboo_remote_eval_standard` — returns the gates, evidence schema, and PASS/WARN/FAIL rubric.
- `peekaboo_remote_eval_plan` — creates `RUN_ID_TNN` markers and the evidence plan before mutation.
- `peekaboo_remote_eval_batch_plan` — planning/validation only for bounded 5-10 turn batches; not an autonomous runner.
- `peekaboo_remote_eval_run_turn` — wraps `scripts/agent-node-discord-direct-control.mjs` for one standardized turn. It defaults to dry-run; live remote GUI mutation requires both `dryRun=false` and `allowLive=true`.
- `peekaboo_remote_eval_evidence_append` / `peekaboo_remote_eval_evidence_query` — explicit durable evidence ledger append/query tools. `run_turn` does not auto-persist.
- `peekaboo_remote_eval_quantitative_report` — read-only scorecard over a Peekaboo evidence JSONL ledger. It computes live readiness, matched-reply, strong-correlation, task-correlation, and live PASS rates as a 0-100 weighted quality score, records a scoring rubric version, marks baseline/candidate batches below 5 live records as insufficient for promotion, and can compare `baselineRunId` vs `candidateRunId` for iterative improvement.

The same quantitative scorecard is available without starting the MCP server.
To initialize an operator-owned ledger without implying a live macOS/Discord GUI
turn, first emit a non-promoting dry-run skeleton:

```bash
pnpm --silent peekaboo:evidence:report -- --print-template --generated-at 2026-05-05T12:10:00.000Z > runtime-state/peekaboo-evidence.jsonl
```

The template is exactly one compact redacted JSONL record. It reads no ledger,
submits no GUI action, polls no Discord REST path, contacts no
Peekaboo/provider service, mutates or rotates no ledger, rejects report-only
flags such as `--pretty`, and remains insufficient for promotion because it is
`dry-run` metadata rather than live GUI evidence.

```bash
pnpm peekaboo:evidence:report -- --ledger runtime-state/peekaboo-evidence.jsonl --pretty
```

The CLI replays an existing JSONL ledger with a bounded byte guard, skips
malformed/torn lines into `replayAudit`, and emits scorecard metadata only. It
does not submit GUI actions, poll Discord, contact Peekaboo/provider services,
mutate ledgers, or render raw notes/correlation ids. Set
`AUTO_ARCHIVE_PEEKABOO_EVIDENCE_LEDGER_PATH` to show the same redacted summary
in `/doctor`; `AUTO_ARCHIVE_PEEKABOO_EVIDENCE_MAX_LEDGER_BYTES` controls the
bounded replay limit. `/doctor` treats an empty/insufficient sample or any
malformed/torn ledger line as WARN so concurrent-writer tail damage does not
look like a clean live proof.

For live closeout that needs bot-reply correlation, `peekaboo_remote_eval_run_turn`
can pass explicit REST observation controls through to the helper:
`envFile` maps to `--env-file` and `botTokenEnv` maps to `--bot-token-env`.
Use these only with operator authorization for the exact secret-bearing path or
environment variable. If REST observation is intentionally out of scope, set
`noRest=true`; the GUI submit can still be tested, but matched-reply evidence
will remain missing and the closeout should be WARN rather than PASS.

Boundary: Discord REST remains observation/evidence only and is never a
substitute for user-authored Discord input. The live mutation path is still SSH
→ macOS agent node → Peekaboo proxy → Discord desktop GUI.

This direct-control path has a proven evaluated surface, but the repository as a
whole remains a core/scaffold branch rather than a production-ready autonomous
framework.

## TraitModule / methodology-origin and autonomous research integration

The current branch separates compute capability flags from Auto Archive
TraitModules. A TraitModule is a project-owned submodule/plugin manifest that
may declare instructions, schedules, and runtime hooks; it is not a Codex skill
installation and not a provider switch.

The methodology-origin integration is the built-in TraitModule
`trait.methodology.agent-methodology-origin.v1` with an evidence-only decorator:

- `src/contracts/capability-flag.ts`
- `src/contracts/trait-module.ts`
- `src/contracts/methodology-skill.ts`
- `src/contracts/trait-runtime-hook.ts`
- `src/runtime/methodology-skill-runtime-driver.ts`
- `specs/CONTRACTS/microkernel-module-boundary.md`
- `specs/CURRENT/trait-module-submodule-plugin-system.md`
- `specs/CURRENT/methodology-skill-admission-governance.md`

Boundary: `methodology-skill` is no longer a compute capability flag or generic
trait taxonomy entry. The built-in methodology TraitModule is an
admission/governance module with an opt-in evidence-only runtime decorator.
`templerun` remains reference-only, not a runtime dependency, provider, or
in-process component. Live validation/evidence stays on the Peekaboo/Discord
direct-control path above.

Microkernel boundary: TraitModules are optional behavior extensions, not a
replacement for kernel-core surfaces. `Arona`, `Plana`, `Dispatcher`,
`AgentRuntime`, `ComputeNode`, `RuntimeDriver`, `TerminalEvidence`, and
`CapabilityFlag` remain kernel/contract-owned; see
`specs/CONTRACTS/microkernel-module-boundary.md`.
The current evidence-decorator loader validates and returns decorators, and
`AgentRuntime` can compose a caller-provided, pre-admitted decorator list at
dispatch time. The runtime still does not auto-enable TraitModules;
admission/manifest loading remains outside the microkernel. The Discord
service exposes `/traits` as a read-only discovery view over repository
TraitModule manifests; it lists manifest metadata only and does not install,
enable, or fetch external registries.
The built-in methodology decorator is wired through the composition root in
default-off opt-in mode; operators enable it by setting
`AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION=evidence-only` (aliases:
`on`, `1`, `true`). Without the flag the decorator is not loaded and
`AgentRuntime` runs the bare delegate. When enabled, Plana admits the
methodology TraitModule per dispatch before the loader supplies the
evidence-only decorator to `AgentRuntime`.
Hosts that need Hermes-style `bump_use` evidence can subscribe the
observe-only `skillBumpUse` hook to `InMemoryTraitUsageTelemetry`; this records
per-Trait `useCount`, first/last use timestamps, and the last task id without
granting runtime permission or mutating prompts/providers. It is an in-memory
Auto Archive sidecar, not Hermes' persistent `skill_usage.json` wire format;
hosts that need durability should snapshot it into their own ledger/store. When
that sidecar is supplied to the Discord command handler, `/traits` renders the
use count and latest task id beside read-only TraitModule manifest metadata;
the Discord smoke launcher and service launcher wire the same sidecar into
in-process `current-node` / `git-clone` runtime modes. The default
`slurm-apptainer` service mode runs the agent runtime in a separate container,
so host memory cannot observe use counts without a future durable store or IPC
bridge. The default host wiring observes the built-in methodology TraitModule;
additional TraitModules can attach their own hook bindings explicitly. The
sidecar lifetime is the process lifetime. Hermes-style view/patch counters
remain intentionally unported.
Cron schedule declarations are likewise split from live execution:
`buildTraitSchedulerDryRun()` materializes validated `schedule.mode="cron"`
manifests into durable scheduler state, and `planTraitSchedulerTick()` offers a
bounded UTC-only one-shot due-run selector over that state. It returns due job
snapshots and deterministic opaque run ids; day-of-month/day-of-week matching
uses standard cron semantics (OR when both fields are restricted, otherwise
non-wildcard fields must match). Hosts can attach the observe-only
`cronTickObserve` hook to audit the finalized due-run summary; the hook cannot
add/remove due jobs or dispatch work. The planner does not spawn a daemon,
acquire locks, dispatch tasks, reload environment variables, or deliver Discord
messages. Hosts that already own an execution loop can pass a finalized plan to
`runTraitSchedulerDueJobs()`; it invokes a caller-provided dispatch callback in
deterministic due-job order, contains per-job failures, returns a conservative
checkpoint (`advance` only when the plan is untruncated and all dispatches
succeed; `hold.reasons` records dispatch failure and/or plan truncation), and
still does not create a daemon, lock, env reload, ledger writer, or Discord
delivery path by itself. `applyTraitSchedulerDispatchCheckpoint()` and
`JsonFileTraitSchedulerCursorStore` let host loops persist `lastTickAt` only
when that conservative checkpoint says `advance`; held batches keep the prior
cursor and record hold reasons/batch counts for operator audit. For hosts that
want the smallest end-to-end seam, `runTraitSchedulerTickOnce()` composes
planner → dispatch runner → cursor application for one explicit host-invoked
tick, and `runTraitSchedulerTickOnceFromStores()` adds load/save around caller
owned scheduler/cursor stores. These helpers still do not daemonize, lock,
reload environment variables, write ledgers, or deliver Discord messages.
Dispatch callbacks and observe hooks remain caller-owned side-effect surfaces:
hosts that share a cursor store across concurrent tick sources should serialize
invocation, and a post-dispatch cursor save failure should be treated as
at-least-once delivery rather than exactly-once completion. Same-process hosts
can use `InProcessTraitSchedulerTickOnceRunner` to queue
`runTraitSchedulerTickOnceFromStores()` calls through one shared runner instance
so a later tick reloads the cursor after the prior checkpoint save. This is a
low-fanout same-process helper, not a general work queue; constructing multiple
runner instances for the same cursor store, or running multiple processes/hosts,
still needs a lease. `JsonFileTraitSchedulerTickLease` and
`runTraitSchedulerTickOnceWithLease()` provide an optional atomic-directory
lease wrapper with TTL-based stale takeover; when a live lease is held the tick
is skipped before scheduler/cursor stores or dispatch callbacks are invoked.
The lease is still caller-configured and does not create a wake loop, env
reload, ledger writer, or Discord delivery path. Operators should place the
lease on storage with reliable atomic directory creation and aligned clocks;
network/shared filesystems with weak mkdir semantics or cross-host clock skew
remain deployment responsibilities. For research audit trails,
`JsonlTraitSchedulerTickEvidenceLedger` and
`runTraitSchedulerTickOnceWithLeaseAndEvidence()` can append compact ran/skipped
tick evidence to JSONL; evidence write failure is reported beside the tick
result and does not change whether the tick ran or was skipped. The ledger is a
best-effort operator-owned audit trail: replay skips torn/malformed lines, and
operators can construct it with `retentionRecords` to compact the file after
append to the latest N valid evidence records via tmp+rename. It is still not
fsync-backed, not a cross-process append lock, and not a backup-rotation
system; enable `retentionRecords` only for a single writer per ledger path, and
expect per-append compaction to parse/rewrite the retained file. Use non-secret
lease `ownerId` values and keep host-level backup/archive rotation explicit
when running long-lived deployments.
`buildTraitSchedulerTickEvidenceReport()` turns replayed evidence records into a
read-only scorecard with dispatch failure, checkpoint hold, lease contention,
sample-size, and recommendation fields so operators can compare bounded
scheduler batches without implying live daemon readiness. The weighted
`qualityScore` is an advisory trend heuristic, not an SLA, command source, or
replacement for deferred live-daemon proof; zero-ran samples are not penalized
for dispatch/checkpoint components, but remain sample-size-gated. When rendered
from JSONL, the report also includes `replayAudit` counters so operators can see
the total replayed lines, parsed records, empty lines, and malformed/torn lines
excluded from scoring. The CLI applies a default byte guard during bounded
chunked replay so oversized audit files fail closed with a clear diagnostic
before bytes beyond the guard are accepted. Local operators can render the same
report without writing to the ledger:

```bash
pnpm trait:scheduler:evidence:report -- --ledger runtime-state/trait-scheduler-tick-evidence.jsonl --pretty
```

To start a caller-owned JSONL evidence file without accidentally creating a
healthy sample, emit one compact non-promoting record first:

```bash
pnpm --silent trait:scheduler:evidence:report -- --print-template --generated-at 2026-05-05T09:10:00.000Z > runtime-state/trait-scheduler-tick-evidence.jsonl
```

The template record is valid JSONL but intentionally records a held checkpoint
and dispatch failure, so the report remains insufficient for trend/promotion
until replaced by real host-owned tick evidence. `--print-template` rejects
`--pretty` to keep the output one JSONL line; any manual edit invalidates the
non-promoting guarantee until the edited ledger is re-checked.

The command accepts `--source`, `--status ran|skipped`, `--limit`,
`--max-ledger-bytes`, and `--generated-at`; it only reads the JSONL file and
prints JSON to stdout. To preview the next due-job window before wiring a host
owned dispatch loop, operators can use the read-only plan CLI:

```bash
pnpm trait:scheduler:plan -- --state runtime-state/trait-scheduler-state.json --cursor runtime-state/trait-scheduler-cursor.json --pretty
```

`trait:scheduler:plan` reads the scheduler state and optional cursor, applies
bounded `--max-due-jobs`, `--max-lookback-minutes`, `--max-state-bytes`, and
`--max-cursor-bytes` guards, and prints the resulting due-job plan. It does not
dispatch jobs, save cursors, acquire leases, append evidence, reload env,
daemonize, or contact Discord/GitLab/provider services.
For the always-on service, operators can set
`AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_LEDGER_PATH` so `/doctor` renders a
redacted, read-only summary of the same scorecard. The companion
`AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_MAX_LEDGER_BYTES` applies a bounded
replay guard. This diagnostic path does not run ticks, acquire leases, dispatch
jobs, compact/rotate ledgers, or deliver Discord messages.
ACP hosts can likewise subscribe to the observe-only `acpSessionObserve` hook
for session lifecycle summaries (`session-created`, `session-loaded`,
`session-resumed`, `session-forked`, `session-closed`). The hook output is
ignored and the payload deliberately omits prompt text, cwd, MCP declarations,
permission decisions, and filesystem content; it reports only session ids,
parent linkage where applicable, persistence status, close reason, and
additional-directory counts.

The autonomous-research integration is the built-in TraitModule
`trait.research.autonomous-goal-loop.v1`, inspired by the Darwin Gödel Machine
archive loop (arXiv:2505.22954). It adds a bounded research-until-goal trait:
declare the goal and stop condition, maintain an archive of research stepping
stones, generate/evaluate candidate variants empirically, retain evidence, and
run a completion audit before terminal success. Its runtime hook is also
evidence-only and default-off; enable it with
`AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION=bounded-evidence`
(aliases: `on`, `1`, `true`, `evidence-only`). This trait does not create an
unbounded autonomous runner and does not grant network/web/sandbox/approval
authority; those remain explicit host/runtime policy decisions.
`/doctor` reports the resolved mode, selected trait/profile when enabled, and
the `Hidden autonomous runner: no` boundary so operators can confirm the
research-specific runtime decoration without starting work.
Operators can also inspect retained TerminalEvidence JSON with
`pnpm autonomous:research:evidence:report -- --evidence <path>` to score
archive-loop checkpoints, criteria coverage, terminal causes, and delegate-error
guardrails without running a task. To start a safe operator-owned evidence file
without accidentally promoting completion, emit a non-promoting skeleton first:

```bash
pnpm --silent autonomous:research:evidence:report -- --print-template --generated-at 2026-05-05T14:02:00.000Z --pretty > runtime-state/autonomous-research-template.json
```

The template is valid TerminalEvidence with no autonomous-research checkpoints
and a `driver-failure` template cause, so feeding it back into the report remains
`not-requested` until replaced by retained evidence from a real bounded run. Any
manual edit to the template invalidates that non-promoting guarantee until the
edited file is re-checked by this report command. Repeat `--evidence` to
summarize several retained task records; `delegate-error` takes precedence over completion, while
records without autonomous-research checkpoints are counted as `not-requested`
and do not by themselves prove the archive loop. The default per-file replay
guard is 5 MiB and fails closed before parsing; override it with
`--max-evidence-bytes` for larger retained TerminalEvidence. Set
`AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_PATH` to expose the same redacted,
read-only summary in `/doctor`; use
`AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_EVIDENCE_MAX_BYTES` to bound replay. These
diagnostics and the template mode never load TraitModule runtime code, call a runtime driver/delegate,
evaluate variants, change providers, contact services, or mutate evidence.
The boundary block in the JSON report attests only to this diagnostic reader;
it is not a claim that a live autonomous-research run has been operator-verified.

Trait manifest discovery defaults to the service process current working
directory. Set `AUTO_ARCHIVE_TRAIT_MODULE_WORKSPACE_ROOT` when a service manager
launches the Discord process from outside the repository root. `/traits` remains
read-only, disables Discord mentions at the payload level, and reports
discovery failures without enabling any TraitModule.

Specification map: see `specs/README.md`.

## Discord actual service path (current service runbook)

Smoke 검증을 넘어 장시간 실제 서비스 형태로 bot을 띄울 때는 아래 package script를 사용합니다.

```bash
pnpm core:stack:start
pnpm core:stack:status
pnpm core:stack:health
pnpm discord:service
pnpm discord:service:start
```

- `pnpm core:stack:start`
  - `docker compose up -d --build discord-service`로 Docker Compose core stack을 시작/재시작합니다
  - 현재 core stack은 `discord-service` 하나를 포함하며, container name은 `auto-archive-discord-service`입니다
  - start/restart 후 `check-discord-core-stack.mjs`가 현재 Docker container log에서 Discord gateway ready 및 command registration 완료를 확인합니다
  - container 내부 Codex home은 `HOME=/home/deepsky`, `CODEX_HOME=/home/deepsky/.codex`로 고정하고 host `~/.codex`를 `/home/deepsky/.codex`에 mount합니다. 이는 host `~/.codex/config.toml`의 absolute `model_instructions_file=/home/deepsky/.codex/...` 같은 Codex CLI 경로가 Docker 안에서도 동일하게 해석되도록 하기 위한 Docker-only runtime contract입니다.
  - Codex는 session, system skills, model cache, auth refresh를 위해 Codex home에 쓰기를 수행하므로 이 mount는 read-only가 아니라 trusted service write mount입니다.
- `pnpm core:stack:status`
  - `discord-service` container가 `running`인지와 현재 container의 gateway ready event가 관측됐는지 확인합니다
- `pnpm core:stack:health`
  - Docker container가 살아있는 것만으로 성공 처리하지 않고, `client-ready-wait-complete` 및 `command-registration-complete` lifecycle log가 현재 container에 존재하는지 검사합니다
  - Discord live GUI test 전에는 이 gate를 먼저 통과해야 합니다
- `pnpm discord:service`
  - host Node 실행이 아니라 `pnpm core:stack:start`의 Docker Compose 경로를 호출합니다
- `pnpm discord:service:start`
  - host Node 실행이 아니라 `pnpm core:stack:start`의 Docker Compose 경로를 호출합니다

이 service launcher는 smoke launcher와 같은 Discord command/natural-language handler를 사용하지만, 운영 기본값은 smoke보다 실제 작업에 맞게 조정되어 있습니다.

- repo root(`process.cwd()`)의 `.env` 를 먼저 읽어 fallback으로 사용합니다
- shell/exported env가 `.env` 보다 항상 우선합니다
- 필수 Discord env는 smoke와 동일합니다:
  - `AUTO_ARCHIVE_DISCORD_TOKEN`
  - `AUTO_ARCHIVE_DISCORD_APPLICATION_ID`
  - `AUTO_ARCHIVE_DISCORD_GUILD_ID`
- 기본 compute node는 unset/empty일 때 `slurm-apptainer` 입니다
  - 이 service mode는 `AUTO_ARCHIVE_APPTAINER_IMAGE` 와
    `AUTO_ARCHIVE_AGENT_INSTANCE_ENTRY` 가 비어 있으면 즉시 실패합니다
    (legacy `/bin/sh -c` fallback은 직접 `SlurmApptainerComputeNode` 를
    구성한 테스트/비서비스 경로에만 남아 있습니다)
  - local live service처럼 현재 checkout에서 직접 실행하려면 `AUTO_ARCHIVE_COMPUTE_NODE=current-node` 를 명시합니다
  - detached clone 기반 검증이 필요하면 `AUTO_ARCHIVE_COMPUTE_NODE=git-clone` 을 명시합니다
- service request defaults:
  - `cpuCores=2`
  - `memoryMiB=4096`
  - `wallTimeSec=1800`
  - `gpuCards=0`
  - `networkProfile='provider-only'`
  - `sandboxMode='workspace-write'`
  - `approvalPolicy='on-request'`
  - `workingDirectory='.'`
  - `artifactLocation='results/task-artifacts'`
- Docker Compose service override:
  - `AUTO_ARCHIVE_DISCORD_TASK_WORKING_DIRECTORY=/workspace/auto_archive_mk3`
  - `AUTO_ARCHIVE_DISCORD_TASK_ARTIFACT_LOCATION=/workspace/auto_archive_mk3/results/task-artifacts`
  - `AUTO_ARCHIVE_DISCORD_TASK_SANDBOX_MODE=danger-full-access`
  - `AUTO_ARCHIVE_CONTROL_LEDGER_PATH=/workspace/auto_archive_mk3/runtime-state/research-control-events.jsonl`
  - `AUTO_ARCHIVE_DISCORD_AUTH_DB_PATH=/workspace/auto_archive_mk3/runtime-state/discord-auth.sqlite`
  - `~/.codex`는 `/home/deepsky/.codex`로 writable mount되며, `/home/node/.codex` 경로는 사용하지 않습니다.
  - Docker container 자체를 execution boundary로 사용하므로 nested Codex/bubblewrap sandbox 대신 `danger-full-access`를 사용합니다. Host PM2 또는 host Node service 경로에서는 이 Docker-only override를 사용하지 않습니다.
  - host Codex 설정이 `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` 등으로
    `/opt/ai-gateway/certs/root-ca.pem` 같은 CA bundle을 가리킬 수 있으므로,
    Compose service는 `${AUTO_ARCHIVE_CODEX_CA_CERTS_HOST_DIR:-/opt/ai-gateway/certs}`를
    container의 `/opt/ai-gateway/certs`에 read-only mount합니다. 다른 host 경로를
    쓰는 운영자는 `AUTO_ARCHIVE_CODEX_CA_CERTS_HOST_DIR`만 바꿔 같은 container
    path 계약을 유지합니다.
  - host-local Codex/AI gateway를 `localhost`로 참조하는 인증 환경에서는
    `AUTO_ARCHIVE_DISCORD_SERVICE_NETWORK_MODE=host`로 재기동해 container 안의
    `localhost`를 host network와 일치시킬 수 있습니다. 기본값은 `bridge`이고,
    Compose는 `host.docker.internal`도 host-gateway로 등록합니다.
- natural-language service defaults:
  - task trigger는 mention-only (`AUTO_ARCHIVE_DISCORD_NATURAL_LANGUAGE_TRIGGER_MODE=mention`)
  - prefix-only 메시지는 기본적으로 task로 실행하지 않고 context history로만 축적합니다
  - context history와 recent-message backfill은 기본 on입니다
  - content가 필요한 일반 메시지까지 context에 포함하려면 Discord Developer Portal에서 **Message Content Intent**를 켜고 `AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT=1`을 설정합니다

Service-specific optional env:

```bash
# natural language/context controls
export AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT=1
export AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY=1
export AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_BACKFILL=1
export AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_LIMIT=30
export AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_MAX_ENTRIES=500
export AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_BACKFILL_LIMIT=30
export AUTO_ARCHIVE_DISCORD_NATURAL_LANGUAGE_TRIGGER_MODE=mention
export AUTO_ARCHIVE_DISCORD_NATURAL_LANGUAGE_PREFIXES=arona,아로나,plana,플라나

# service task envelope
export AUTO_ARCHIVE_DISCORD_TASK_CPU_CORES=2
export AUTO_ARCHIVE_DISCORD_TASK_MEMORY_MIB=4096
export AUTO_ARCHIVE_DISCORD_TASK_WALL_TIME_SEC=1800
export AUTO_ARCHIVE_DISCORD_TASK_GPU_CARDS=0
export AUTO_ARCHIVE_DISCORD_TASK_WORKING_DIRECTORY=.
export AUTO_ARCHIVE_DISCORD_TASK_ARTIFACT_LOCATION=results/task-artifacts
export AUTO_ARCHIVE_DISCORD_TASK_SANDBOX_MODE=workspace-write  # Docker Compose overrides this to danger-full-access
```

Optional GPU research smoke profile (operator-gated, for high-end model
training/evaluation paths):

```bash
export AUTO_ARCHIVE_COMPUTE_NODE=slurm-apptainer
export AUTO_ARCHIVE_APPTAINER_IMAGE=<site-approved-image>
export AUTO_ARCHIVE_AGENT_INSTANCE_ENTRY=/workspace/auto_archive_mk3/dist/runtime/agent-instance-entry.js
export AUTO_ARCHIVE_DISCORD_TASK_CPU_CORES=8
export AUTO_ARCHIVE_DISCORD_TASK_MEMORY_MIB=32768
export AUTO_ARCHIVE_DISCORD_TASK_WALL_TIME_SEC=7200
export AUTO_ARCHIVE_DISCORD_TASK_GPU_CARDS=1
```

`gpuCards > 0` is a resource-envelope grant: the SLURM allocator emits
`salloc --gpus=<n>` and the Apptainer runtime emits `--nv` so the allocated GPU
is visible inside the container. Static tests prove that command contract; live
GPU proof still requires an operator-redacted artifact containing the real
`salloc` allocation, `apptainer exec` invocation, terminal evidence, training
artifact path, evaluation metric artifact, and cleanup/closeout note.

Before launching any modern Transformer training/evaluation run, collect a
non-mutating GPU readiness artifact:

```bash
pnpm gpu:research:readiness -- --write
```

This checks `nvidia-smi` without logging process names or environment variables.
Default gates require at least one GPU with 24GiB free VRAM, <=30% utilization,
<=85C temperature, and compute capability >=7.5 when reported. See
`specs/GUIDES/gpu-transformer-research-readiness.md` for architecture targets
such as FlashAttention-3, Mamba-2/SSD, MLA+MoE, and Kimi Linear/KDA.

When the readiness gate returns `PASS`, collect an actual bounded CUDA
train/eval proof:

```bash
pnpm gpu:transformer:smoke -- --write
```

The smoke uses a tiny causal Transformer with PyTorch
`scaled_dot_product_attention`, trains on synthetic next-token data, evaluates a
held-out synthetic batch, and writes metrics under
`results/gpu-transformer-smoke/`. It is a capability proof, not a benchmark or
frontier-scale reproduction.

For an HRM-style long-duration research test inspired by
arXiv:2506.21734, use:

```bash
pnpm gpu:hrm:longrun -- --duration-sec 600 --eval-every-sec 60 --write
```

This trains a tiny high/low-timescale recurrent maze-reasoning model on
synthetic shortest-path masks and records periodic JSONL metrics under
`results/hrm-small-gpu-longrun/`. It is designed to fit modest GPUs and to prove
stable long-run research instrumentation before attempting larger Sudoku/ARC or
paper-faithful HRM reproductions.

For follow-up research rather than paper-only implementation, use the derivative
gated-fusion lane and a multi-hour duration:

```bash
pnpm gpu:hrm:longrun -- \
  --duration-sec 7200 \
  --eval-every-sec 600 \
  --fusion-mode gated \
  --variant-tag gated-fusion-followup-v1 \
  --save-best-checkpoint \
  --hypothesis "Learned gates between high/low recurrent states improve path-mask precision-recall stability over additive fusion." \
  --write results/hrm-small-gpu-longrun/hrm-gated-fusion-2h.json
```

Pair derivative runs with a matched additive baseline and comparison artifact so
late-window regression is visible instead of reporting only the terminal score:

```bash
pnpm gpu:hrm:longrun -- \
  --duration-sec 7200 \
  --eval-every-sec 600 \
  --fusion-mode add \
  --variant-tag additive-baseline-v1 \
  --save-best-checkpoint \
  --write results/hrm-small-gpu-longrun/hrm-additive-baseline-2h.json

pnpm gpu:hrm:compare -- \
  --baseline results/hrm-small-gpu-longrun/hrm-additive-baseline-2h.json \
  --candidate results/hrm-small-gpu-longrun/hrm-gated-fusion-2h.json \
  --write results/hrm-small-gpu-longrun/hrm-add-vs-gated-2h-comparison.json
```

2026-05-04 paired 2-hour artifacts are recorded under
`results/hrm-small-gpu-longrun/`: additive baseline,
gated-fusion candidate, and `hrm-add-vs-gated-2h-comparison-2026-05-04.json`.
The matched single-seed comparison showed gated terminal `pathF1` `+0.037347`
and best `pathF1` `+0.029148` over additive, while also recording the
throughput/parameter tradeoff.

DT Audit hardening now records validation/test split discipline, threshold
sweeps, `pathIoU`, path-length bucket support, gated-mode gate statistics,
retained best-validation weights, held-out `selectedTestEval`,
optional `.best.pt` checkpoint export via `--save-best-checkpoint`, explicit
`selectionPolicy`, and comparison `qualityGates`. The comparison helper now
prefers `selectedTestEval` (and its validation-selected
`operatingThresholdEval`) when present, then falls back to held-out
`finalTestEval`, then legacy validation `finalEval`. Existing 2026-05-04
additive-vs-gated results remain `exploratory_only` because they are
single-seed, not parameter matched, and predate held-out selected-test
evaluation. Tracked hashes and interpretation guardrails are maintained in
`specs/CURRENT/hrm-experiment-ledger.md`.

### Optional GitLab instance management and work-result recording

The current branch includes a GitLab API v4 management adapter.
It is off by default. When enabled, the Discord smoke/service Arona instance
wires an instance manager, optional fixed-project manager, optional project
assignment manager, and work-result recorder:

- every accepted Arona dispatch still completes through the normal
  `DispatchSubmission.completion` path;
- GitLab recording is a sidecar `gitLabRecording` promise, so a GitLab outage is
  surfaced as `{ kind: 'failed', reason }` without turning a completed agent task
  into a dispatch failure;
- when assignment is enabled, Arona obtains a GitLab project before dispatch,
  attaches the assignment to `DispatchPlan.gitLabProjectAssignment`, and appends
  a trusted GitLab assignment block to the subagent instruction;
- with `AUTO_ARCHIVE_GITLAB_AUTO_CREATE_PROJECTS=true`, Arona creates/reuses a
  task-scoped project in the configured namespace when a fixed project is not
  enough;
- if `AUTO_ARCHIVE_GITLAB_WORK_RESULT_ISSUE_IID` is set, work results are added
  as notes to that issue; otherwise a per-task issue is created in the assigned
  or fixed project;
- Arona exposes management helpers for loading/creating/ensuring GitLab
  projects, plus fixed-project issue create/note/close helpers.

```bash
export AUTO_ARCHIVE_GITLAB_ENABLED=true
export AUTO_ARCHIVE_GITLAB_URL=https://gitlab.example.com

# Prefer token indirection. Direct token is supported for container secret envs.
export AUTO_ARCHIVE_GITLAB_TOKEN_ENV=GITLAB_TOKEN
export GITLAB_TOKEN=glpat-...
# or: export AUTO_ARCHIVE_GITLAB_TOKEN=glpat-...

# Fixed project mode: assign/use an existing project.
export AUTO_ARCHIVE_GITLAB_PROJECT_ID=42

# Dynamic project mode: create/reuse a project per task under this namespace.
export AUTO_ARCHIVE_GITLAB_ASSIGNMENT_ENABLED=true
export AUTO_ARCHIVE_GITLAB_AUTO_CREATE_PROJECTS=true
export AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_ID=5
export AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_PATH=research
export AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_PREFIX=auto-archive-task
export AUTO_ARCHIVE_GITLAB_ASSIGNMENT_PROJECT_VISIBILITY=private
export AUTO_ARCHIVE_GITLAB_ASSIGNMENT_INITIALIZE_WITH_README=true

# Optional: append every result to one issue in the assigned/fixed project
# instead of opening a per-task issue.
export AUTO_ARCHIVE_GITLAB_WORK_RESULT_ISSUE_IID=77
export AUTO_ARCHIVE_GITLAB_WORK_RESULT_LABELS=auto-archive,agent-result
export AUTO_ARCHIVE_GITLAB_WORK_RESULT_INTERNAL=false
```

### One-time GitLab admin bootstrap

For a dedicated Auto Archive GitLab instance, keep admin credentials out of the
long-running Discord/agent runtime. Use the admin PAT only for a one-time
bootstrap that ensures the Auto Archive group, creates a group-scoped runtime
token, and then revokes the admin PAT.

```bash
pnpm gitlab:admin-bootstrap --url https://gitlab.example.com
```

The command prompts for the GitLab admin PAT with hidden input when
`GITLAB_ADMIN_TOKEN` is not already set. It uses safe Auto Archive defaults:
group name `Auto Archive`, group path `auto-archive`, private visibility,
runtime token name `auto-archive-runtime`, scopes `api,write_repository`, and
runtime token expiration 365 days from the run date, and admin-token disposal
enabled. The generated runtime env block is written to
`runtime-state/gitlab-bootstrap-runtime.env` by default (`runtime-state/` is
git-ignored) and redacts the runtime token in stdout. Use
`--runtime-token-expires-at YYYY-MM-DD` to override the generated expiration
date. Store that runtime token in `.env` or your secret manager, then remove all
`AUTO_ARCHIVE_GITLAB_ADMIN_*` values from the service environment. The admin
PAT is revoked through the GitLab personal access token API only after the
runtime env block is durably written (or after `--print-secret` is explicitly
used with `--no-output-file`) and the newly created runtime token can read the
target group, when
`AUTO_ARCHIVE_GITLAB_ADMIN_BOOTSTRAP_DISCARD_ADMIN_TOKEN=true`.

For non-interactive runs, set the default admin-token env and pass the server
URL:

```bash
export GITLAB_ADMIN_TOKEN=<redacted-gitlab-token>
pnpm gitlab:admin-bootstrap --url https://gitlab.example.com --no-prompt
```

`AUTO_ARCHIVE_GITLAB_ADMIN_TOKEN_ENV` is only needed when the admin PAT is stored
under a non-default env name.

The Docker-only Discord service automatically reads
`runtime-state/gitlab-bootstrap-runtime.env` when that file exists. Keep admin
bootstrap variables out of `.env`; the service should run with only the
generated runtime group token after the admin PAT is revoked through the GitLab
API.


### Always-on research control-plane defaults

The service path now keeps the **control plane** always-on while preserving the Arona/Plana task-bound runtime invariant: no warm pool, no runtime session reuse, and no permanent GPU reservation. The durable control ledger defaults to `runtime-state/research-control-events.jsonl` and can be overridden with `AUTO_ARCHIVE_CONTROL_LEDGER_PATH`.

External observability is default-off. Set `AUTO_ARCHIVE_OTEL_LOGS_URL` to an
OTLP HTTP `/v1/logs` collector endpoint to attach a fail-open control-plane
observer to successful ledger appends. The exporter sends safe metadata only
(event type/id, task/correlation ids, trust envelope, and selected scalar fields
such as lifecycle phase/scope/command name); it does not export raw Discord
content, task instructions, payload blobs, or free-form reasons. Optional
resource labels use comma-separated `key=value` pairs in
`AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES`. Shutdown waits up to two seconds for
pending exports and never blocks the ledger append path. When
`AUTO_ARCHIVE_OTEL_LOGS_URL` is configured, `/doctor` renders a redacted
endpoint summary (`protocol#hash`), resource-attribute counts, invalid
`key=value` pair count, and the fail-open/payload boundary without contacting
the collector or exporting a test event. A PASS here means the local
configuration is parse-valid, not that logs are flowing.

Additional service controls:

```bash
export AUTO_ARCHIVE_CONTROL_LEDGER_PATH=runtime-state/research-control-events.jsonl
export AUTO_ARCHIVE_OTEL_LOGS_URL=
export AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES=deployment.environment=dev
export AUTO_ARCHIVE_DISCORD_AUTH_DB_PATH=runtime-state/discord-auth.sqlite
export AUTO_ARCHIVE_DISCORD_AUTH_DB_MODE=sqlite
export AUTO_ARCHIVE_DISCORD_AUTH_DB_DRIVER=python
export AUTO_ARCHIVE_DISCORD_ALLOWED_USER_IDS=123,456
export AUTO_ARCHIVE_DISCORD_ALLOWED_CHANNEL_IDS=789
export AUTO_ARCHIVE_DISCORD_ADMIN_USER_IDS=123
export AUTO_ARCHIVE_DISCORD_ENABLE_DMS=0
export AUTO_ARCHIVE_DISCORD_ALLOW_BOTS=0
```

Task-health retained evidence can be summarized without running observers or
contacting live services by replaying a redacted control-plane JSONL ledger:

```bash
pnpm task:health:evidence:report -- --ledger runtime-state/research-control-events.jsonl --pretty
```

To initialize an operator-owned task-health evidence ledger without accidentally
promoting incomplete evidence, emit one compact placeholder:

```bash
pnpm --silent task:health:evidence:report -- --print-template --generated-at 2026-05-05T11:10:01.000Z > runtime-state/research-control-events.jsonl
```

The template writes a single `task.health_stalled` control-plane JSONL line
with safe task-health metadata only and intentionally omits raw task and runtime
correlation scopes. Reporting that placeholder remains `WARN` until real
retained stall evidence supplies task and runtime correlation scopes. Template
mode reads no ledger, rejects `--pretty` so the output remains one JSONL line,
never ticks observers, appends control-plane events, mutates/rotates ledgers,
or contacts live services.

The report scores retained `task.health_stalled` events only. It fails closed on
unsafe task-health payload keys or excessive nested payloads, counts
malformed/torn and non-task-health lines, and reports task/correlation scoping,
stall durations, quality score, and recommendations without rendering raw
task ids, correlation ids, Discord content, task instructions, or payload blobs.
`--last-event-kind` filters records first and `--limit` then keeps the bounded
tail of the matching records. The quality score is an advisory retained-evidence
rubric: evidence presence 35점, task scope coverage 20점, runtime correlation
scope coverage 20점, clean replay/no unsafe payload 25점.
Set `AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_LEDGER_PATH` to expose the same redacted
scorecard in `/doctor`; `AUTO_ARCHIVE_TASK_HEALTH_EVIDENCE_MAX_LEDGER_BYTES`
controls the bounded replay guard. This diagnostic path never ticks
`TaskStallObserver`, appends `task.health_stalled`, mutates or rotates ledgers,
reloads env, or sends Discord notifications.

Task archive/unarchive retained evidence can be summarized from the same
control-plane ledger without calling Discord or changing task state:

```bash
pnpm task:archive:evidence:report -- --ledger runtime-state/research-control-events.jsonl --pretty
```

To initialize an operator-owned archive evidence ledger without accidentally
promoting incomplete evidence, emit one compact placeholder:

```bash
pnpm --silent task:archive:evidence:report -- --print-template --generated-at 2026-05-05T07:10:00.000Z > runtime-state/research-control-events.jsonl
```

The template writes a single metadata-only `task.archived` control-plane JSONL
line with stable redacted task/actor hashes and no raw task, actor, channel, or
reason values. Reporting that placeholder remains `WARN` because it lacks the
matching `task.unarchived` evidence required for promotion. Template mode reads
no ledger, rejects `--pretty` so the output remains one JSONL line, never runs
`/archive` or `/unarchive`, and does not mutate archive state, contact services,
or rotate ledgers.

The report scores retained `task.archived` / `task.unarchived` archive-audit
records, counts archive/unarchive coverage, task/actor/channel attribution,
reason-presence metadata, transition anomalies when a safe task hash is
available, malformed/torn lines, and unsafe legacy raw archive payloads. It
never renders raw task ids, actor/user ids, channel ids, reasons, instructions,
Discord content, or payload blobs; unexpected fields inside schema-versioned
`archiveAudit`, malformed hash-named fields, or a legacy raw `archive` /
`unarchive` payload co-located with a metadata-only `archiveAudit` fail closed.
`--event-type` filters records first and `--limit`
then keeps the bounded tail; filtered reports mark transition counts as
filter-scoped rather than whole-ledger state. Set
`AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_LEDGER_PATH` to expose the same redacted
scorecard in `/doctor`; `AUTO_ARCHIVE_TASK_ARCHIVE_EVIDENCE_MAX_LEDGER_BYTES`
controls the bounded replay guard. This diagnostic path never runs `/archive`
or `/unarchive`, writes control-plane events, mutates or rotates ledgers,
reloads env, or contacts Discord/GitLab/provider services.

Subagent operator retained evidence can be summarized from an operator-owned
roster-event JSONL ledger without touching live subagents:

```bash
pnpm subagent:operator:evidence:report -- --ledger runtime-state/subagent-roster-events.jsonl --pretty
```

To start a caller-owned roster-event JSONL ledger without creating a healthy
operator-surface sample, emit one compact non-promoting spawn placeholder first:

```bash
pnpm --silent subagent:operator:evidence:report -- --print-template --generated-at 2026-05-05T08:10:00.000Z > runtime-state/subagent-roster-events.jsonl
```

The template is a valid `subagent.spawned` roster-event JSONL line, but it has
no terminal lifecycle event and no `roster.progress` sample, so feeding it back
into the report remains `warn` with one active placeholder subagent until real
host-owned roster evidence replaces it. Template mode rejects `--pretty` to keep
the output one JSONL line, reads no ledger, does not inspect or mutate live
subagents, and does not contact Discord/GitLab/provider services.

The report scores retained `subagent.spawned`, `subagent.completed`,
`subagent.aborted`, `subagent.failed`, and `roster.progress` events, counts
lifecycle coverage, subagent/parent task/runtime scoping, active/duplicate and
terminal-without-spawn transition anomalies, malformed/torn lines, and unsafe
raw operator payloads. It never renders raw subagent ids, task ids, runtime
instance ids, messages, artifacts, instructions, prompts, responses, or payload
blobs. Raw messages/reasons/prompts/responses/payloads and raw string artifacts
fail closed; only digest/ref artifact metadata is accepted as retained evidence.
Spawn+terminal evidence without at least one retained `roster.progress` sample
stays `warn` because the live operator surface requires progress visibility.
`--event-kind` filters events first and `--limit` then keeps the bounded tail;
filtered reports mark transition counts as filter-scoped rather than
whole-ledger state. Set
`AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_LEDGER_PATH` to expose the same
redacted scorecard in `/doctor`;
`AUTO_ARCHIVE_SUBAGENT_OPERATOR_EVIDENCE_MAX_LEDGER_BYTES` controls the bounded
replay guard. This diagnostic path never spawns, steers, kills, or inspects live
subagents, mutates or rotates ledgers, reloads env, or contacts
Discord/GitLab/provider services.

Focus/session binding retained evidence can be summarized from the control-plane
ledger without issuing `/focus`, `/unfocus`, or steering commands:

```bash
pnpm session:binding:evidence:report -- --ledger runtime-state/research-control-events.jsonl --pretty
```

To initialize an operator-owned focus/session evidence ledger without
accidentally promoting incomplete evidence, emit one compact placeholder:

```bash
pnpm --silent session:binding:evidence:report -- --print-template --generated-at 2026-05-05T09:10:00.000Z > runtime-state/research-control-events.jsonl
```

The template writes a single metadata-only `session.binding_created`
control-plane JSONL line with stable redacted binding/task/owner/channel/thread
and subagent hashes. Reporting that placeholder remains `WARN` because it lacks
the `steering.submitted` and terminal release/change/expiry/eviction evidence
required for promotion. Template mode reads no ledger, rejects `--pretty` so
the output remains one JSONL line, never focuses, unfocuses, steers, appends
events, mutates/rotates ledgers, or contacts live services.

The report scores retained `session.binding_created`,
`session.binding_released`, `session.focus_changed`,
`session.binding_expired`, `session.binding_evicted`, and `steering.submitted`
events, using the metadata-only `bindingAudit` payload emitted by the focus
manager and steering path. It counts focus creation, steering, terminal
transitions, binding/task/owner/channel/thread/subagent scoping, transition
anomalies, malformed/torn lines, and unsafe legacy raw binding payloads. It
never renders raw binding ids, task ids, owner/user ids, guild/channel/thread
ids, subagent ids, instructions, steering text, or payload blobs. Legacy
`payload.binding` / raw `payload.bindingId` records fail closed. `--event-type`
filters records first and `--limit` then keeps the bounded tail; filtered
reports mark transition counts as filter-scoped rather than whole-ledger state.
The retained hashes are domain-separated HMAC digests, so the same raw Discord
snowflake in different binding/task/owner/channel/thread/subagent fields does
not produce a reusable cross-field hash. Leave
`AUTO_ARCHIVE_SESSION_BINDING_AUDIT_HASH_PEPPER` unset or blank for a process-local
random pepper, or set a high-entropy deployment pepper only when operators need
cross-restart correlation in retained audit artifacts. Treat a configured
pepper as secret operational material; rotating it intentionally breaks
cross-process retained-hash continuity for previously written ledger records.
Set `AUTO_ARCHIVE_SESSION_BINDING_EVIDENCE_LEDGER_PATH` to expose the same
redacted scorecard in `/doctor`;
`AUTO_ARCHIVE_SESSION_BINDING_EVIDENCE_MAX_LEDGER_BYTES` controls the bounded
replay guard. This diagnostic path never focuses, unfocuses, steers, writes
control-plane events, mutates or rotates ledgers, reloads env, or contacts
Discord/GitLab/provider services.

Claude token offload (Codex parent → Claude advisor) retained evidence can be
summarized from the metadata-only offload ledger without contacting Claude:

```bash
pnpm claude:token:offload:report -- --ledger runtime-state/claude-token-offload.jsonl --pretty
```

The offload route lets the Codex parent send bounded read-only synthesis,
critique, or memory-compaction work to Claude as an advisor lens, while Codex
remains the sole repository writer and final completion auditor. The retained
ledger is metadata-only by structural contract: each record carries
`recordId`, `purpose`, `routeStatus`, `errorCategory`, `model`,
`sourceRefCount`, `acceptanceCheckCount`, `blockingGapCount`,
`memoryCandidateCount`, `latencyMs`, `costUsd`, redacted token usage
(`inputTokens` includes any cache-creation tokens since the model still
processes them as fresh input; `cachedInputTokens` reflects only
`cache_read_input_tokens`, the actual cache hits), and timestamps. Raw
prompts, raw responses, raw task instructions, `.env` values, secret-bearing
logs, and Discord/Peekaboo content are forbidden by structural shape checks
(positive-allowlist projection plus a banned-key denylist over
`rawPrompt`/`rawResponse`/`rawInstruction`/`token`/`apiKey`/`credential`/`secret`)
and never reach the ledger or this CLI. The report tags every aggregate as
`provenance: claude-token-offload` and `decisionRole: advisory-only` so a
Claude triage/synthesis row can never satisfy a live-proof gate by itself.
Set `AUTO_ARCHIVE_CLAUDE_OFFLOAD_LEDGER_PATH` to expose the same redacted
scorecard in `/doctor`;
`AUTO_ARCHIVE_CLAUDE_OFFLOAD_MAX_LEDGER_BYTES` controls the bounded replay
guard. The route status vocabulary is namespaced
(`offload-route-ok`/`offload-route-warn`/`offload-route-fail`) so it cannot be
confused with live-proof PASS/WARN/FAIL by naive substring grep. Quota, auth,
network, timeout, model-unavailability, partial-result, parse-failure, and
tool-use-requested degradation all surface as WARN rather than failing the
parent — a Claude advisor outage must never stall Codex. The CLI never
contacts Claude, never writes to the ledger, never mutates or rotates ledger
files, and never expands raw response bodies (the ledger does not retain them
in the first place).

User/admin authorization is backed by an internal SQLite state database on the
service path. The default DB path is `runtime-state/discord-auth.sqlite`, seeded
idempotently from the Discord guild/channel/user/admin env controls. There is no
embedded default administrator: set `AUTO_ARCHIVE_DISCORD_ADMIN_USER_IDS` (or
seed the auth database out-of-band) before relying on admin-only actions such as
`/auth`, `/approve`, `/deny`, `/doctor`, `/proof`, and `/subagents`; with no admin
configured these actions fail closed with `admin-required`. The default SQLite driver is
Python stdlib sqlite (`python3`); set `AUTO_ARCHIVE_DISCORD_AUTH_DB_DRIVER=sqlite3`
and `AUTO_ARCHIVE_DISCORD_AUTH_DB_SQLITE_BIN` to use a system `sqlite3` binary,
or `AUTO_ARCHIVE_DISCORD_AUTH_DB_MODE=memory` only for local non-durable tests.

Commands beyond the first slice:

- `/research` — research-oriented alias for task dispatch.
- `/tasks` — visible active/recent task board from the replay-backed registry; `/tasks archived` shows archived records.
- `/rerun` — task owner or Discord admin only; start a fresh task from a terminal tracked task without reusing the old managed artifact root; optional notes are appended as rerun context.
- `/archive` — task owner or Discord admin only; hide a terminal tracked task from default task lists while preserving `/status`, `/context`, and `/history` inspectability.
- `/unarchive` — task owner or Discord admin only; restore an archived task to default task lists without deleting the durable archive/unarchive ledger history.
- `/traits` — read-only TraitModule plugin manifest discovery; no install, enable, or external registry action is performed.
- `/agenda` — persistent research agenda and cadence state backed by the control ledger.
- `/history` — bounded control-plane event history. Use `view:talk` (or
  slash-text `/history --talk`) for a sanitized read-only channel talk
  transcript drawn from observed Discord messages.
- `/context` — context envelope summary for a task.
- `/escalate` — Discord-only operator escalation request; records
  `escalation.requested` in the control ledger without mutating task state or
  exposing the command through ACP. The visible acknowledgement is no-mention
  sanitized; the bounded ledger `reason` remains untrusted audit data and must
  be sanitized by downstream viewers.
- `/feed` — Discord-only bounded control-plane live tail; reads recent events
  through `loadSince`, caps output to 50 events, applies task/escalation/approval
  filters, rate-limits each Discord user to 2 requests/minute, and sanitizes
  untrusted event text without exposing the command through ACP.
- `/auth` — administrator-only SQLite-backed access list inspection and mutation.
- `/approve` / `/deny` — record operator approval decisions in the control ledger.
- `/subagents action:tree mission_id:<id>` — administrator-only research subagent role/tree preflight. It shows the planner/collector/experimenter/critic/synthesizer/archivist role map and active roster descriptors whose parent task id matches `discord-research-mission-plan-<mission_id>-<numeric-run-suffix>`, without spawning, killing, steering, reading logs, mutating proof/archive state, writing GitLab, or contacting live services.
- `/subagents action:spawn mission_id:<id> role:<planner|collector|experimenter|critic|synthesizer|archivist> text:<task>` — administrator-only research subagent spawn preflight. It previews the role-specific prompt envelope, depth-1 root-owned policy, evidence/claim/uncertainty output schema, and boundary conditions, but does not create a provider session, spawn a subagent, read logs, mutate proof/archive state, write GitLab, or contact live services.
  `/research action:show|status|pin` mission summaries also include read-only mission-scoped subagent role-state counts when a subagent operator roster is wired, using the same exact parent task id match as `/subagents action:tree`.
- `/doctor` — non-mutating service readiness summary for ledger, auth/access policy, runtime provider, compute/sandbox inputs, Codex/Claude auth and model overrides, AgentHarness registry descriptor, Plana advisor, approval/tool-loop/task-health/task-archive/subagent-operator/session-binding retained evidence/subagent policy, shell-hook bridge, GitLab recording, TLS CA, rate-throttle state when enabled, Message Content Intent, and secret-redaction sanity. The package-level `pnpm run doctor` command renders the same diagnostic report for local operators. `/doctor mission_id:<id>` renders a read-only mission quality diagnostic card for plan approval, synthesis, retained evidence, unresolved claims, thread binding, and configured global proof-report status without mutating mission/proof/archive state.
- `/critique mission_id:<id> lens:<methodology|evidence|counterargument|reproducibility>` — read-only research critique preflight. It surfaces the mission's evidence, claim, synthesis, and lens-specific warning context without invoking an external critic or mutating evidence/claim/proof/archive state.
- `/research action:archive` — non-mutating research closeout preflight. It renders a closeout checklist for plan approval, synthesis, retained evidence, unresolved claims, and configured live-proof report status without archiving the mission, writing GitLab, mutating proof manifests, or contacting live services.
- Research mission and closeout cards include Discord button components with parse-safe `research-mission:*` and `research-closeout:*` custom ids. The bot routes supported button presses through the same slash-command handlers (`/research`, `/evidence`, `/critique`, `/proof`) rather than adding a separate mutation path; closeout `Archive anyway` still re-renders the preflight and proof buttons still require operator-owned capture steps.
- `/proof action:status` — administrator-only Discord view of mission-local proof counters (when `mission_id` matches a tracked Research Mission) plus the configured live-proof manifest scorecard. Unknown `mission_id` values render sanitized header context only. It reuses the redacted `AUTO_ARCHIVE_LIVE_PROOF_MANIFEST_PATH` doctor status, never renders raw proof summaries/correlation ids, and does not contact live services or mutate proof files.
- `/proof action:start surface:<surface>` — administrator-only operator start preflight for one `live-proof-matrix.md` surface. It turns the proof start step into Discord guidance for checklist review, template export, capture preparation, and `live:proof:report` scoring without spawning proof work, reading/writing proof files, mutating manifests, contacting live services, or linking mission proof state.
- `/proof action:export surface:<surface>` — administrator-only Discord template export for one `live-proof-matrix.md` surface. It emits a `live:proof:report`-compatible manifest skeleton inline so the operator does not have to hand-author the JSON shape, but it remains template-only WARN evidence until replaced with redacted operator-owned proof.
- `/proof action:capture surface:<surface>` — administrator-only operator capture preflight for one `live-proof-matrix.md` surface. It gives the operator the safe redaction/reporting steps and compatible `live:proof:report` commands without reading/writing proof files, mutating manifests, contacting live services, or linking mission proof state.
  When configured, the same redacted live-proof report status is also surfaced in `/research action:show|status|pin` mission summaries as a global proof-report note; `/proof action:status mission_id:<id>` shows mission-local counters beside that global scorecard, while proof artifact linking remains a later mission-scoped slice.

Task-mutating controls (`/cancel`, `/rerun`, `/archive`, `/unarchive`) require
the tracked task owner or a configured Discord admin. Read-only inspection
surfaces such as `/status`, `/tasks`, `/history`, `/context`, and `/feed` continue to
follow the broader Discord access policy. `/help` mirrors this split so users
can distinguish reversible inspection from owner/admin task mutation before
issuing a command. It also calls out admin-only operations (`/auth`,
`/approve`, `/deny`, `/subagents`, `/doctor`) and owner-only focus binding
controls. `/escalate` is Discord-only and records a human/operator review
request without changing the task; `/feed` is Discord-only to keep the live
operator event tail out of ACP. The command registry carries structured
`permissionClass` metadata so future slash commands must be classified before
they can be treated as covered by the UX contract.

Discord context history is serialized through a `DiscordInstructionEnvelope`; only the current instruction is executable, and recent messages are explicitly marked `UNTRUSTED`. Raw context history is not automatically promoted into long-term research memory. Research agenda/cadence entries are explicit user-authored control-plane state: add them with `/agenda action:add`, close them with `/agenda action:done`, and set a channel cadence with `/agenda action:cadence`.

#### Persona — Arona/Plana duet voice (optional)

Discord 사용자-facing 메시지 중 낮은 위험의 대화형 surface(`ask-accepted`, `running-update`, `status-reply`, `cancel-ack`, `access-denied`)는 작은 보조 모델을 통해 블루아카이브의 아로나/플라나 듀엣 보이스로 재작성될 수 있다. 구조화된 출력(`/tasks`, `/traits`, `/agenda`, `/history`, `/context`, `/auth`, `/doctor`, `/help`)과 terminal result / archive / rerun / approval / focus / subagent / buffered follow-up 계열은 자동화 consumer 와의 호환을 위해 기본 변환 게이트를 우회한다.

- 활성화: 기본은 off. `AUTO_ARCHIVE_PERSONA_MODE=duet` 과 `AUTO_ARCHIVE_PERSONA_API_KEY` 를 모두 설정해야 켜진다. `OPENAI_API_KEY` 재사용은 기본 금지이며, 꼭 필요할 때만 `AUTO_ARCHIVE_PERSONA_ALLOW_OPENAI_API_KEY_FALLBACK=1` 로 명시 opt-in 한다.
- 이벤트 게이트: 기본 allowlist 는 `ask-accepted,running-update,status-reply,cancel-ack,access-denied`. `AUTO_ARCHIVE_PERSONA_EVENT_TYPES` 는 대화형 surface 를 좁히거나 일부 추가할 수 있지만, 구조화 출력과 terminal/archive/rerun/approval/focus/subagent/follow-up 계열의 hard-verbatim surface 는 operator override 나 custom transformer `eventTypes` 로도 변환되지 않는다. 이 계열을 열려면 reply-family protected-token contract 와 consumer compatibility test 를 먼저 추가해야 한다.
- 모델: `AUTO_ARCHIVE_PERSONA_MODEL` (default `gpt-4o-mini`). OpenAI 호환 `/chat/completions` 엔드포인트라면 `AUTO_ARCHIVE_PERSONA_BASE_URL` 로 프록시·자체 호스팅 가능. `AUTO_ARCHIVE_PERSONA_LATENCY_BUDGET_MS` 와 `AUTO_ARCHIVE_PERSONA_SAMPLING_LOG_RATE` 로 event별 latency/cost sampling 로그(`persona-transform-observed`)를 남길 수 있으며, 로그에는 원문/변환문 본문을 포함하지 않는다.
- telemetry scorecard: operator가 보존한 redacted `persona-transform-observed` JSONL은 `pnpm persona:telemetry:report -- --ledger runtime-state/persona-telemetry.jsonl --pretty` 로 정적 점검할 수 있다. 초기 operator-owned ledger skeleton은 `pnpm --silent persona:telemetry:report -- --print-template --generated-at 2026-05-05T04:10:00.000Z > runtime-state/persona-telemetry.jsonl` 로 만들 수 있다. 템플릿은 metadata-only 1줄 JSONL이며 raw prompt/source dialogue/transformed text/task id를 포함하지 않고, 표본 1건·human no-copy review 부재 상태라 WARN/non-promoting으로 남는다. 이 CLI는 persona model 호출, Discord/GitLab/provider 접촉, ledger mutation/rotation을 하지 않으며 raw prompt/source dialogue/transformed text/task id를 렌더링하지 않는다. `AUTO_ARCHIVE_PERSONA_TELEMETRY_LEDGER_PATH` 를 설정하면 `/doctor` 가 같은 요약을 표시하고, `AUTO_ARCHIVE_PERSONA_TELEMETRY_MAX_LEDGER_BYTES` 로 bounded replay guard를 조정한다. raw content·task id·credential key는 중첩 객체/배열에서도 FAIL로 집계하고 값은 렌더링하지 않으며, 과도하게 깊은 nested telemetry도 fail-closed 처리한다. malformed/torn line·sample 부족·human no-copy review 부재는 WARN으로 유지한다. quality score는 success rate 40점, latency-budget pass rate 25점, human no-copy review gate 20점, 5건 표본 충족 15점으로 계산된다. 표본이 5건 미만인 집계는 익명화/품질 근거로 취급하지 않고 operator 보강 대상으로 남긴다.
- 보이스 프로필: `src/persona/arona-plana-duet.ts` 는 공개 프로필·대사 목록에서 말투 패턴만 추출해 아로나를 따뜻한 OS 비서/안내자, 플라나를 짧은 상태 확인·경고를 남기는 두 번째 OS로 분리한다. 원작 대사 문장 자체는 프롬프트에 복사하지 않고, 운영 메시지(`ask-accepted`, `running-update`, `status-reply`, `cancel-ack`, `access-denied`)별 어댑터 규칙만 둔다.
- 보존 의무: 시스템 프롬프트와 출력 불변식 guard 가 백틱 ID, 경로, URL, taskId, allocationId, bindingId, agendaId, approvalId, timestamp/숫자, 라이프사이클 키워드(`accepted`/`admission-denied`/`runtime-entering`/`runtime-running`/`settling`/`terminal`/`runtime-veto`/`success`/`failure`/`timeout`/`operator-cancel`/`abort`/`superseded`/`advisory`/`authoritative` 등)를 verbatim 보존하도록 강제한다. 누락되거나 `**아로나:**` → 빈 줄 → `**플라나:**` 두 블록 구조를 벗어나면 원문을 그대로 전송한다.
- 실패 모델: 변환 실패(타임아웃, HTTP 에러, throw, empty response)는 원문을 그대로 전송 (fail-open). UX 변경이 backend 신뢰성에 영향을 주지 않는다.

Admin controls can also be submitted through mention-based natural language or
slash-text fallback when Discord's slash-option UI is awkward: for example
`auth list`, `auth allow_user <discord-user-id>`, `approve <approval-id>`, or
`deny <approval-id>`. These routes still use the same admin-only access policy
and existing `/auth` / `/approve` / `/deny` handlers; natural language only
normalizes the command and target.

Smoke와 service의 의도 차이는 다음과 같습니다.

| Path | Purpose | Default compute mode | Default task cwd | Default wall time |
| ---- | ------- | -------------------- | ---------------- | ----------------- |
| `discord:smoke` | 짧은 repo-internal live validation | `git-clone` when unset | `results/task-artifacts` | 900s |
| `discord:service` | 실제 사용자 과제 수행용 장시간 service | `slurm-apptainer` when unset | repo root `.` | 1800s |

현재 local agent-node 기반 live service 검증에서는 보통 아래처럼 실행합니다.

```bash
export AUTO_ARCHIVE_COMPUTE_NODE=current-node
export AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT=1
pnpm core:stack:start
pnpm core:stack:status
pnpm core:stack:health
```

Docker-only policy: long-running Discord bot service는 root `Dockerfile` +
`docker-compose.yml`의 `discord-service`로만 실행합니다. Host PM2 /
host Node service 실행은 current branch의 supported path가 아닙니다.

## Discord turnkey smoke path (authoritative current-branch runbook)

이 브랜치의 **repo-internal turnkey smoke path** 는 이제 아래 두 package script 기준으로 실행합니다.

```bash
pnpm discord:smoke
pnpm discord:smoke:start
```

- `pnpm discord:smoke`
  - TypeScript build를 먼저 수행한 뒤
  - `dist/src/discord/discord-smoke-bootstrap.js` 를 실행합니다
- `pnpm discord:smoke:start`
  - 이미 build가 되어 있다는 전제에서
  - 같은 smoke bootstrap launcher만 바로 실행합니다

이 launcher는 current branch 기준 **minimal live-smoke launcher** 입니다.

- repo root(`process.cwd()`)의 `.env` 를 먼저 읽어 Discord smoke env lookup에 fallback으로 사용합니다
- shell/exported env가 `.env` 보다 항상 우선합니다
- repo root `.env` 가 없어도 그 자체로는 실패하지 않지만, fallback 이후에도 필수 env가 비어 있으면 즉시 실패합니다
- Discord 필수 env를 읽고, 비어 있으면 즉시 실패합니다
- `/ask`, `/status`, `/cancel` first-slice command bot을 기동합니다
- smoke-friendly request defaults를 사용합니다
  - `cpuCores=2`
  - `memoryMiB=4096`
  - `wallTimeSec=900`
  - `networkProfile='provider-only'`
  - `sandboxMode='workspace-write'`
  - `approvalPolicy='on-request'`
  - artifact / working directory: `results/task-artifacts`

### Required env for the smoke path

#### Required Discord credentials (current branch, no OAuth-era flow)

Only these Discord values are required by the repo-internal smoke launcher:

- `AUTO_ARCHIVE_DISCORD_TOKEN`
- `AUTO_ARCHIVE_DISCORD_APPLICATION_ID`
- `AUTO_ARCHIVE_DISCORD_GUILD_ID`

This smoke path does **not** use historical Discord OAuth client/secret/redirect-code/refresh-token inputs. Operator setup is strictly:

- bot token → `AUTO_ARCHIVE_DISCORD_TOKEN`
- Discord application ID → `AUTO_ARCHIVE_DISCORD_APPLICATION_ID`
- target guild/server ID → `AUTO_ARCHIVE_DISCORD_GUILD_ID`

Reuse vs reissue guidance:

- `AUTO_ARCHIVE_DISCORD_APPLICATION_ID`: reusable if you are intentionally reusing the same Discord application/bot
- `AUTO_ARCHIVE_DISCORD_GUILD_ID`: reusable if smoke continues to target the same guild
- `AUTO_ARCHIVE_DISCORD_TOKEN`: must be the current active bot token for that application; reissue/rotate it in the Discord Developer Portal if you are moving to a fresh bot token or the previous token should no longer be trusted

Minimal external provisioning procedure:

1. In the Discord Developer Portal, choose the existing application you want to reuse, or create a new application and add a bot to it.
2. Copy the application's **Application ID** and export it as `AUTO_ARCHIVE_DISCORD_APPLICATION_ID`.
3. In the bot settings, obtain the bot token for that application; if needed, regenerate it there, then export it as `AUTO_ARCHIVE_DISCORD_TOKEN`.
4. Invite that bot to the target Discord guild/server and copy the guild's ID, then export it as `AUTO_ARCHIVE_DISCORD_GUILD_ID`.
5. Confirm the target channel/guild allows slash commands for the bot before running smoke.

If you run the smoke launcher from the repo workflow, you may place these three Discord values in the repo-root `.env` instead of exporting them every time. Exported shell env remains authoritative and overrides overlapping `.env` entries.

#### Compute-node constraint (fail-closed)

- `AUTO_ARCHIVE_COMPUTE_NODE` 는 **unset, `git-clone`, `current-node` 만 허용**됩니다
- `slurm-apptainer` 를 포함해 다른 값을 강제로 주면 smoke bootstrap은 **즉시 실패**합니다
- 즉, 이 smoke path는 default compute-node resolver의 `slurm-apptainer` fallback에 조용히 기대지 않습니다
- launcher는 smoke 용도로 unset 시 `GitLabCloneComputeNode`, explicit `current-node` 시 `CurrentNodeComputeNode` 를 사용하며, conflicting mode를 허용하지 않습니다
- 따라서 smoke에서는 `AUTO_ARCHIVE_COMPUTE_NODE` 를 비우면 general default처럼 `slurm-apptainer` 로 가지 않고, **`git-clone` 으로 동작합니다**

#### Codex runtime env (needed for a real `/ask`, but external credential provisioning remains out of repo scope)

- supported auth:
  - valid Codex CLI local auth (`~/.codex/auth.json`) — preferred when present under the default `AUTO_ARCHIVE_CODEX_AUTH_SOURCE=auto`
  - `AUTO_ARCHIVE_CODEX_API_KEY` — fallback when CLI auth is absent, or required when `AUTO_ARCHIVE_CODEX_AUTH_SOURCE=api-key`
- optional:
  - `AUTO_ARCHIVE_CODEX_AUTH_SOURCE` (`auto`, `codex-cli`, or `api-key`)
  - `AUTO_ARCHIVE_CODEX_CLI_PATH`
  - `AUTO_ARCHIVE_CODEX_CLI_HOME_MODE` (`default` or `isolated-auth`)
  - `AUTO_ARCHIVE_CODEX_ISOLATED_HOME`
  - `AUTO_ARCHIVE_CODEX_MODEL`
  - `AUTO_ARCHIVE_CODEX_MODEL_FALLBACK`
  - `AUTO_ARCHIVE_CODEX_REASONING_EFFORT`
  - `AUTO_ARCHIVE_CODEX_SETTINGS_FILE`

Operator notes:

- a real `/ask` needs one of the supported Codex auth sources above on the machine/account that runs `pnpm discord:smoke`
- `AUTO_ARCHIVE_CODEX_AUTH_SOURCE=auto` is the default: `~/.codex/auth.json` is preferred when valid and takes precedence over `AUTO_ARCHIVE_CODEX_API_KEY`
- use `AUTO_ARCHIVE_CODEX_AUTH_SOURCE=api-key` when a container/service must ignore local Codex CLI auth and use an API key only; use `codex-cli` to require local Codex CLI auth
- `AUTO_ARCHIVE_CODEX_MODEL` / `AUTO_ARCHIVE_CODEX_REASONING_EFFORT` can override an inaccessible local Codex default model for repo smoke runs without editing the global `~/.codex/config.toml`
- `AUTO_ARCHIVE_CODEX_MODEL_FALLBACK` can be set to a known-accessible model (for example `gpt-5.4`) to retry once when the primary/global model is rejected by Codex as invalid, unknown, unsupported, not available, or not accessible
- Docker `discord-service` intentionally sets `AUTO_ARCHIVE_CODEX_CLI_PATH=""`
  so host-only absolute CLI paths are not used inside the container. For
  `gpt-5.5`, the bundled `@openai/codex-sdk` / `@openai/codex` pair must be
  `>=0.125.0`; older `0.121.0` builds fail with the “requires a newer version
  of Codex” model error before falling back.
- Docker `discord-service` also defaults `AUTO_ARCHIVE_CODEX_CLI_HOME_MODE=isolated-auth`
  and `AUTO_ARCHIVE_CODEX_ISOLATED_HOME=/home/deepsky/.auto-archive/codex-home`.
  This keeps the mounted `~/.codex/auth.json` usable while preventing host
  `~/.codex/config.toml` or `~/.codex/.env` proxy/telemetry settings from
  leaking into containerized provider calls.
- `AUTO_ARCHIVE_CODEX_SETTINGS_FILE` is only additive/fallback for supported JSON keys; it does not replace the need for valid `~/.codex/auth.json` or `AUTO_ARCHIVE_CODEX_API_KEY`

예시:

```bash
# optional when the same values already exist in repo-root .env
export AUTO_ARCHIVE_DISCORD_TOKEN=...
export AUTO_ARCHIVE_DISCORD_APPLICATION_ID=...
# optional when the bot user id differs from the application id
export AUTO_ARCHIVE_DISCORD_BOT_USER_ID=...
export AUTO_ARCHIVE_DISCORD_GUILD_ID=...
# optional but required for full channel context history content
export AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT=1
# optional fallback when local Codex CLI auth is absent
export AUTO_ARCHIVE_CODEX_API_KEY=...
# optional: force auto (default), codex-cli, or api-key auth-source selection
export AUTO_ARCHIVE_CODEX_AUTH_SOURCE=auto
# optional model override when the global Codex default is not accessible
export AUTO_ARCHIVE_CODEX_MODEL=gpt-5.5
export AUTO_ARCHIVE_CODEX_MODEL_FALLBACK=gpt-5.4
export AUTO_ARCHIVE_CODEX_REASONING_EFFORT=high
# optional; if set, it must be git-clone or current-node for this smoke path
export AUTO_ARCHIVE_COMPUTE_NODE=current-node

pnpm discord:smoke
```

### Short real-smoke procedure

1. 외부 선행조건(아래 섹션)을 먼저 준비합니다
2. 위 env를 설정하고 `pnpm discord:smoke` 로 bot을 기동합니다
3. 자연어 명령 경로를 확인할 때는 대상 guild/channel 에서 봇을 직접 mention한 plain message를 보냅니다. GUI helper를 쓰는 경우에는 instruction만 넘기면 자동으로 bot mention을 붙일 수 있습니다:
   ```bash
   pnpm discord:gui-ask -- --mode natural-ask --message "삼진수 VM을 설계하고 예제 프로그램까지 작성해줘"
   ```
   `--mode natural-ask` 는 기본적으로 `<@BOT_USER_ID> ...` 형태의 일반 채팅 메시지를 제출합니다. `BOT_USER_ID`는 `AUTO_ARCHIVE_DISCORD_BOT_USER_ID`가 있으면 그 값을, 없으면 `AUTO_ARCHIVE_DISCORD_APPLICATION_ID`를 사용합니다. 이미 bot mention으로 시작하는 문장은 중복 mention을 붙이지 않습니다.
4. slash-command 경로를 확인할 때는 Discord UI를 통해 `/ask` 를 실행합니다:
   1. composer를 클릭합니다
   2. `/ask` 만 먼저 입력합니다
   3. Discord autocomplete/palette에 표시된 Arona `/ask` 항목을 Return으로 선택합니다
   4. slash-command form의 `instruction` option field가 활성화된 것을 확인한 뒤 instruction만 입력합니다
   5. Return으로 제출하고 `task_id` 를 기록합니다
5. 같은 `task_id` 로 `/status` 를 실행해 coarse 상태가 조회되는지 확인합니다
6. 작업이 아직 terminal 전이면 `/cancel task_id:<...> reason:<...>` 로 취소를 요청합니다
7. 다시 `/status` 를 실행해 terminal/cancelled 쪽으로 수렴하는지 확인합니다

자동 GUI 제출이 필요하면 agent-node direct-control helper를 사용할 수 있습니다.

```bash
pnpm discord:gui-ask -- \
  --channel-id "$AUTO_ARCHIVE_E2E_TEST_CHANNEL_ID" \
  --message "Create a tiny file under results/task-artifacts and report the path." \
  --polls 12
```

GUI 텍스트 OCR이 최신 Discord 메시지를 안정적으로 드러내지 않는 환경에서는
post-submit 관찰을 이미지 캡처로 전환할 수 있습니다. 이 경로는 Discord REST
polling을 사용하지 않고, Peekaboo `image` 도구가 만든 PNG를 직접 evidence
artifact로 다룹니다.

```bash
pnpm discord:gui-ask -- \
  --mode natural-ask \
  --message "results/task-artifacts 아래에 작은 검증 파일을 만들고 경로를 보고해줘." \
  --no-rest \
  --observe-mode image \
  --image-capture-path /tmp/auto-archive-discord-observe.png \
  --image-output runtime-state/live-proof-artifacts/discord-observe.png
```

`--observe-mode both` 는 기존 `see` 텍스트 관찰과 PNG 캡처를 함께 남깁니다.
`--image-output` 은 원격 PNG를 로컬 artifact 경로로 복사하며, raw prompt/response
또는 REST 토큰을 요구하지 않습니다.

주의: `/ask <instruction>` 을 한 번에 plain text로 입력하고 Return을 누르는 방식은 검증 절차가 아닙니다. Discord slash-command autocomplete 항목을 먼저 선택해야 실제 `/ask` interaction으로 접수됩니다.

자연어 메시지 경로 smoke에서는 봇을 명시적으로 멘션한 plain Discord 메시지를 사용합니다. 예:

```text
<@BOT_USER_ID> results/task-artifacts 아래에 작은 검증 파일을 만들고 경로를 보고해줘.
```

이 경로는 slash command가 아니며, smoke bootstrap은 봇 멘션 메시지를 `/ask`와 같은 tracked task로 dispatch합니다.

현재 smoke bootstrap의 자연어 task trigger는 mention-only입니다. `아로나야 ...`, `plana ...` 같은 멘션 없는 prefix-only 메시지는 task로 실행하지 않고 context history에만 남깁니다. context history는 같은 채널에서 bot이 관측한 최근 모든 메시지(user/bot/prefix-only/일반 대화)를 현재 task instruction 앞에 bounded context로 첨부합니다. 또한 mention task가 들어오면 같은 채널의 최근 Discord 메시지를 best-effort로 fetch해 bot 기동 전/관측 누락 메시지도 bounded history에 병합합니다. 모든 non-mention 메시지의 content까지 포함하려면 Discord Developer Portal에서 해당 bot의 **Message Content Intent**가 허용되어 있어야 하며, launcher에 `AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT=1`을 명시해야 합니다.

권장 smoke 패턴:

- 먼저 작은 `/ask` 로 command registration + dispatch acceptance를 확인합니다
- `/cancel` 까지 확인하려면, terminal 도달 전에 취소할 수 있을 정도로 조금 더 긴 `/ask` 를 한 번 더 사용합니다

### Repo-internal readiness vs external prerequisites

이 브랜치에서 **repo-internal gap이 닫힌 범위** 는 다음입니다.

- repo-native Discord smoke bootstrap entrypoint 존재
- repo-native Discord service bootstrap entrypoint 존재
- package script (`discord:smoke`, `discord:smoke:start`) 존재
- package script (`discord:service`, `discord:service:start`) 존재
- current-branch authoritative runbook가 이 README에 존재
- conflicting compute-node mode에 대해 fail-closed

하지만 아래는 **여전히 repo 밖의 external prerequisite** 입니다.

- 실제 Discord application / bot 생성
- Discord bot token 발급
- target guild 준비 및 bot 초대
- slash command 사용 권한 및 channel/guild permissions 설정
- 실제 `application id` / `guild id` 확보
- live `/ask` 실행에 필요한 Codex credential/operator setup
- 운영 환경의 네트워크/정책/비밀관리

따라서 현재 상태는 **live smoke readiness** 이며, full production deployment completion을 의미하지 않습니다.

## Recent verified work history

> **Migration note (2026-05)**: 본 섹션은 git 저장소 이전 이전의 `reimpl/arona-plana-dispatcher-core` 브랜치 위에서 수행된 검증 결과를 기록한 것입니다. 이전 시점에 히스토리가 단일 init 커밋(`master`)으로 압축되어 아래 baseline/follow-up SHA들은 더 이상 `git rev-parse`로 resolve되지 않습니다. 다만 검증 시점의 코드와 후속 repair 변경 내용은 현재 `master` HEAD 트리에 그대로 보존되어 있으며, 검증 사실 자체는 `IMPLEMENTATION_LOG.md`에 텍스트 chronology로 남아 있습니다.

- DT-Council cumulative implemented-code verification: 이전 브랜치 `reimpl/arona-plana-dispatcher-core` 대상으로 완료
- baseline head: `5f2b637` (이전 SHA, 현 저장소에서 unresolvable)
- verdict: `CONDITIONAL PASS`
- findings summary: `2 Major, 3 Moderate`
- 후속 repair work 요약 (이전 SHA는 unresolvable이며 변경 내용은 현 `master` 트리에 반영됨):
  - `fix(dispatcher): close backend timeout and cancel gaps` (이전 SHA `c3a6819`)
  - `test(integration): cover codex and discord bot seams` (이전 SHA `54ae6f7`)
  - `docs(project): clarify branch authority boundaries` (이전 SHA `78e87e0`)
  - `chore(spec): record dt-council repair completion` (이전 SHA `229de38`)

즉, 현재 README authority 기준 branch truth는 **dispatcher-core 중심 scaffold-stage reimplementation + verified repair follow-up landed (이전 브랜치 검증 결과가 현 `master` 코드 트리에 그대로 반영됨)** 이며, 아직 legacy 전체를 대체하는 full rewrite는 아닙니다.
