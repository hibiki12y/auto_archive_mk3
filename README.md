# Auto Archive Mk3 — Reimplementation Stub

이 브랜치(`reimpl/arona-plana-dispatcher-core`)는 **신규 재구현 시작점**입니다.

- 현재 초점: **Arona / Plana / Dispatcher core contract** 정리와 **runtime skeleton** 마련
- 현재 상태: **스캐폴드 단계**이며, 완료된 rewrite가 아닙니다
- 레거시 코드베이스 스냅샷: [`archive/codebase-20260418/README.md`](archive/codebase-20260418/README.md)
- 이전 `documents/ARCHITECTURE.md`, `documents/MIGRATION_MAP.md` 등 최상위 historical snapshot은 `documents/archive/2026-04-cleanup-into-specs-v1/top-level/` 아래로 통합 보존되었으며, 현재 구현 권위는 `specs/`와 `src/`, `tests/`에 있습니다
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
- Always-on Discord research control-plane first slice: durable JSONL ledger, replay-backed task registry, persistent research agenda/cadence, instruction envelope, access policy, and `/research`/`/tasks`/`/agenda`/`/history`/`/context`/`/doctor` command surface
- GitLab work-result recording first slice: Arona can create/annotate/close GitLab issues, and completed delegated agent work can be recorded as a GitLab issue or as a note on a configured issue

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
  - `AUTO_ARCHIVE_CODEX_CLI_PATH` (optional CLI path override used by the Codex SDK bootstrap path)
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
  - valid `~/.codex/auth.json` wins over API-key bootstrap
  - if both local auth and `AUTO_ARCHIVE_CODEX_API_KEY` are present, the runtime prefers local Codex auth
  - malformed/unreadable positively-detected `~/.codex/auth.json` fails closed; it does not silently fall back to `AUTO_ARCHIVE_CODEX_API_KEY`
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
  - `src/runtime/runtime-driver-factory.ts`
  - `/doctor` reports the active provider and Claude/Plana-advisor readiness
    when run through the Discord service path.


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

## TraitModule / methodology-origin integration

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
dispatch time. The runtime still does not auto-discover or auto-enable
TraitModules; admission/manifest loading remains outside the microkernel.
The built-in methodology decorator is wired through the composition root in
default-off opt-in mode; operators enable it by setting
`AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION=evidence-only` (aliases:
`on`, `1`, `true`). Without the flag the decorator is not loaded and
`AgentRuntime` runs the bare delegate. When enabled, Plana admits the
methodology TraitModule per dispatch before the loader supplies the
evidence-only decorator to `AgentRuntime`.

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
export GITLAB_ADMIN_TOKEN=glpat-admin-bootstrap-token
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

Additional service controls:

```bash
export AUTO_ARCHIVE_CONTROL_LEDGER_PATH=runtime-state/research-control-events.jsonl
export AUTO_ARCHIVE_DISCORD_AUTH_DB_PATH=runtime-state/discord-auth.sqlite
export AUTO_ARCHIVE_DISCORD_AUTH_DB_MODE=sqlite
export AUTO_ARCHIVE_DISCORD_AUTH_DB_DRIVER=python
export AUTO_ARCHIVE_DISCORD_ALLOWED_USER_IDS=123,456
export AUTO_ARCHIVE_DISCORD_ALLOWED_CHANNEL_IDS=789
export AUTO_ARCHIVE_DISCORD_ADMIN_USER_IDS=123
export AUTO_ARCHIVE_DISCORD_ENABLE_DMS=0
export AUTO_ARCHIVE_DISCORD_ALLOW_BOTS=0
```

User/admin authorization is backed by an internal SQLite state database on the
service path. The default DB path is `runtime-state/discord-auth.sqlite`, seeded
idempotently from the Discord guild/channel/user/admin env controls. There is no
embedded default administrator: set `AUTO_ARCHIVE_DISCORD_ADMIN_USER_IDS` (or
seed the auth database out-of-band) before relying on admin-only actions such as
`/auth`, `/approve`, `/deny`, `/doctor`, and `/subagents`; with no admin
configured these actions fail closed with `admin-required`. The default SQLite driver is
Python stdlib sqlite (`python3`); set `AUTO_ARCHIVE_DISCORD_AUTH_DB_DRIVER=sqlite3`
and `AUTO_ARCHIVE_DISCORD_AUTH_DB_SQLITE_BIN` to use a system `sqlite3` binary,
or `AUTO_ARCHIVE_DISCORD_AUTH_DB_MODE=memory` only for local non-durable tests.

Commands beyond the first slice:

- `/research` — research-oriented alias for task dispatch.
- `/tasks` — visible active/recent task board from the replay-backed registry.
- `/agenda` — persistent research agenda and cadence state backed by the control ledger.
- `/history` — bounded control-plane event history.
- `/context` — context envelope summary for a task.
- `/auth` — administrator-only SQLite-backed access list inspection and mutation.
- `/approve` / `/deny` — record operator approval decisions in the control ledger.
- `/doctor` — service readiness summary for ledger, access policy, Codex SDK scope, compute mode, model override, and Message Content Intent.

Discord context history is serialized through a `DiscordInstructionEnvelope`; only the current instruction is executable, and recent messages are explicitly marked `UNTRUSTED`. Raw context history is not automatically promoted into long-term research memory. Research agenda/cadence entries are explicit user-authored control-plane state: add them with `/agenda action:add`, close them with `/agenda action:done`, and set a channel cadence with `/agenda action:cadence`.

#### Persona — Arona/Plana duet voice (optional)

Discord 사용자-facing 메시지 중 낮은 위험의 대화형 surface(`ask-accepted`, `running-update`, `status-reply`, `cancel-ack`, `access-denied`)는 작은 보조 모델을 통해 블루아카이브의 아로나/플라나 듀엣 보이스로 재작성될 수 있다. 구조화된 출력(`/tasks`, `/agenda`, `/history`, `/context`, `/auth`, `/doctor`, `/help`)과 terminal result / approval / focus / subagent / buffered follow-up 계열은 자동화 consumer 와의 호환을 위해 기본 변환 게이트를 우회한다.

- 활성화: 기본은 off. `AUTO_ARCHIVE_PERSONA_MODE=duet` 과 `AUTO_ARCHIVE_PERSONA_API_KEY` 를 모두 설정해야 켜진다. `OPENAI_API_KEY` 재사용은 기본 금지이며, 꼭 필요할 때만 `AUTO_ARCHIVE_PERSONA_ALLOW_OPENAI_API_KEY_FALLBACK=1` 로 명시 opt-in 한다.
- 이벤트 게이트: 기본 allowlist 는 `ask-accepted,running-update,status-reply,cancel-ack,access-denied`. `AUTO_ARCHIVE_PERSONA_EVENT_TYPES` 는 대화형 surface 를 좁히거나 일부 추가할 수 있지만, 구조화 출력과 terminal/approval/focus/subagent/follow-up 계열의 hard-verbatim surface 는 operator override 나 custom transformer `eventTypes` 로도 변환되지 않는다. 이 계열을 열려면 reply-family protected-token contract 와 consumer compatibility test 를 먼저 추가해야 한다.
- 모델: `AUTO_ARCHIVE_PERSONA_MODEL` (default `gpt-4o-mini`). OpenAI 호환 `/chat/completions` 엔드포인트라면 `AUTO_ARCHIVE_PERSONA_BASE_URL` 로 프록시·자체 호스팅 가능. `AUTO_ARCHIVE_PERSONA_LATENCY_BUDGET_MS` 와 `AUTO_ARCHIVE_PERSONA_SAMPLING_LOG_RATE` 로 event별 latency/cost sampling 로그(`persona-transform-observed`)를 남길 수 있으며, 로그에는 원문/변환문 본문을 포함하지 않는다.
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
  - valid Codex CLI local auth (`~/.codex/auth.json`) — preferred when present
  - `AUTO_ARCHIVE_CODEX_API_KEY` — fallback when CLI auth is absent
- optional:
  - `AUTO_ARCHIVE_CODEX_CLI_PATH`
  - `AUTO_ARCHIVE_CODEX_MODEL`
  - `AUTO_ARCHIVE_CODEX_MODEL_FALLBACK`
  - `AUTO_ARCHIVE_CODEX_REASONING_EFFORT`
  - `AUTO_ARCHIVE_CODEX_SETTINGS_FILE`

Operator notes:

- a real `/ask` needs one of the supported Codex auth sources above on the machine/account that runs `pnpm discord:smoke`
- `~/.codex/auth.json` is the preferred source; if it exists and is valid, it takes precedence over `AUTO_ARCHIVE_CODEX_API_KEY`
- `AUTO_ARCHIVE_CODEX_MODEL` / `AUTO_ARCHIVE_CODEX_REASONING_EFFORT` can override an inaccessible local Codex default model for repo smoke runs without editing the global `~/.codex/config.toml`
- `AUTO_ARCHIVE_CODEX_MODEL_FALLBACK` can be set to a known-accessible model (for example `gpt-5.4`) to retry once when the primary/global model is rejected by Codex as invalid, unknown, unsupported, not available, or not accessible
- Docker `discord-service` intentionally sets `AUTO_ARCHIVE_CODEX_CLI_PATH=""`
  so host-only absolute CLI paths are not used inside the container. For
  `gpt-5.5`, the bundled `@openai/codex-sdk` / `@openai/codex` pair must be
  `>=0.125.0`; older `0.121.0` builds fail with the “requires a newer version
  of Codex” model error before falling back.
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

- DT-Council cumulative implemented-code verification completed for `reimpl/arona-plana-dispatcher-core`
- baseline head: `5f2b637`
- verdict: `CONDITIONAL PASS`
- findings summary: `2 Major, 3 Moderate`
- follow-up repair work already landed:
  - `c3a6819` `fix(dispatcher): close backend timeout and cancel gaps`
  - `54ae6f7` `test(integration): cover codex and discord bot seams`
  - `78e87e0` `docs(project): clarify branch authority boundaries`
  - `229de38` `chore(spec): record dt-council repair completion`

즉, 현재 README authority 기준 branch truth는 **dispatcher-core 중심 scaffold-stage reimplementation + verified repair follow-up landed** 이며, 아직 legacy 전체를 대체하는 full rewrite는 아닙니다.

## Legacy snapshot

이전 루트 README와 레거시 코드베이스 설명은 archive 아래 스냅샷으로 보존됩니다.

- [`archive/codebase-20260418/README.md`](archive/codebase-20260418/README.md)
