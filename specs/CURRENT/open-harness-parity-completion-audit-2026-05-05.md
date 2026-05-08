---
status: current
authority: implementation-risk-ledger
last_verified: 2026-05-05
source_paths:
  - README.md
  - package.json
  - specs/CURRENT/openclaw-gap-implementation.md
  - specs/CURRENT/hermes-pattern-adoption.md
  - specs/CURRENT/live-proof-matrix.md
  - specs/CURRENT/remaining-issues-2026-04-30.md
  - src/
  - tests/
scope: 2026-05-05 active goal completion audit for open-harness UX parity, auto-archive gaps, research-specialized framework readiness, and remaining operator-gated evidence.
---

# Open Harness Parity Completion Audit — 2026-05-05

## 1. 감사 대상 goal

Active goal under audit:

> 제안된 계획에 따라 작업 진행, 오픈소스 하네스와 동등한 ux를 가지면서 연구에 특화된 프레임워크가 될 수 있도록 작업

본 문서는 위 goal을 `complete`로 닫아도 되는지 판단하기 위한 checkpoint다. 결론은
**repo-local/static implementation parity는 상당 부분 PASS**, **전체 goal은 아직 WARN / not
complete**다. 이유는 `live-proof-matrix.md`의 operator-gated surface들이 실제
Discord/GitLab/provider/Peekaboo/SLURM/OTLP 환경 증거 없이 live-ready로 승격될 수
없기 때문이다. `authority=implementation-risk-ledger`는 이 문서가 completion을
허가하는 문서가 아니라, 남은 증거 리스크와 다음 반복 진입점을 고정하는 ledger임을
뜻한다.

## 2. 외부 baseline 신호

이 절은 비교 기준을 고정하기 위한 요약이다. 외부 문서는 참조 기준일 뿐이며,
auto_archive_mk3의 실행 진실 소스는 `README.md`, `src/`, `tests/`이다.
외부 baseline URL은 2026-05-05에 확인한 현재 문서 기준이며, upstream 변경 시 본
문서의 `last_verified`를 갱신해야 한다.

| Baseline | 관찰한 UX/architecture 신호 | Auto Archive 대응 상태 |
| --- | --- | --- |
| OpenClaw subagents | `sessions_spawn`, Discord thread binding, `/focus`·`/unfocus`, `/agents`/`/subagents`, auto-archive, spawn depth/cascade stop 같은 operator UX가 핵심이다. Source: <https://docs.openclaw.ai/tools/subagents> | `/subagents`, `/focus`, `/unfocus`, depth-1 root-owned policy, retained roster/session-binding scorecards, task archive scorecards가 repo-local로 구현되어 있다. Auto-archive는 실시간 자동 삭제 타이머가 아니라 durable task archive UX와 evidence reader 중심으로 범위를 고정했다. |
| OpenClaw agent harness plugin | Harness는 provider/channel/tool registry가 아니라 prepared native turn executor이며 provider/model/auth/tool policy 결정 이후에만 실행된다. Source: <https://docs.openclaw.ai/plugins/sdk-agent-harness> | `AgentHarnessPlugin` ABI와 registry report/descriptor CLI가 bootstrap-selected `RuntimeDriver` wrapper 경계로 구현되어 있고, mid-flight provider switching은 금지한다. |
| OpenClaw ACP agents | Codex/Claude Code/Gemini CLI 같은 external harness를 ACP backend로 spawn하고 background task/runtime controls와 연결한다. Source: <https://docs.openclaw.ai/tools/acp-agents> | ACP adapter stages 1-5와 provider evidence report가 landed 상태다. 다만 실제 external harness live spawn/credential proof는 operator-gated다. |
| Hermes Agent v0.12.0 | Messaging gateways, skills, memory, MCP, cron scheduling, context files, command approval/security, OpenClaw migration 같은 broad agent harness subsystem을 제공한다. Source: <https://github.com/NousResearch/hermes-agent> | `hermes-pattern-adoption.md`가 16개 subsystem별 PORT/PORT-PARTIAL/SKIP 결정을 추적한다. Cron scheduler/skill system/ACP/doctor/hook tiers는 landed로 기록되어 있으나 daemon/fresh env reload/timezone-aware wake loop/Discord delivery/backup rotation 등은 의도적으로 deferred/operator-owned다. |

## 3. Acceptance checklist

| Check | Required evidence | Current evidence | Status |
| --- | --- | --- | --- |
| Open-harness UX parity skeleton | Harness ABI, descriptor/report UX, external harness boundary, no provider switching | `src/contracts/agent-harness-plugin.ts`, `src/runtime/agent-harness-registry.ts`, `src/runtime/agent-harness-registry-report-cli.ts`, `tests/agent-harness-registry*.spec.ts`, README `agent:harness:registry:report` section | PASS-static / WARN-live |
| Auto-archive task UX | Archive/unarchive commands, archived listing, retained audit records, safe evidence replay | `DiscordTaskRegistry.archiveTask` / `unarchiveTask`, `/archive`, `/unarchive`, `/tasks archived`, `src/control/task-archive-evidence-report-cli.ts`, `tests/task-archive-evidence-report-cli.spec.ts`, `live-proof-matrix.md` durable task row | PASS-static / WARN-live |
| Subagent operator UX | List/info/log/send/steer/kill, policy guard, retained roster scorecard | `/subagents` surface, `src/runtime/subagent-operator-evidence-report-cli.ts`, `tests/subagent-operator-evidence-report-cli.spec.ts`, `live-proof-matrix.md` subagent row | PASS-static / WARN-live |
| Focus/session binding UX | `/focus`, focused steering, `/unfocus`, binding lifecycle evidence | `src/discord/discord-session-binding.ts`, `src/discord/session-binding-evidence-report-cli.ts`, `tests/session-binding-evidence-report-cli.spec.ts`, `live-proof-matrix.md` focus row | PASS-static / WARN-live |
| Task health / no-progress observer | Mid-cycle observer, default-off stall observer, retained scorecard, operator thresholds | `RuntimeMidCycleObserver`, `TaskStallObserver`, `src/control/task-health-evidence-report-cli.ts`, `tests/task-health-*.spec.ts`, `openclaw-gap-implementation.md` OC-1A.1 | PASS-static / WARN-live |
| Research-specialized framework | TraitModule research loop, methodology-origin evidence decorator, trait scheduler, evidence CLI | `traits/autonomous-research-goal-loop/`, `src/contracts/autonomous-research-trait.ts`, `src/runtime/autonomous-research-*.ts`, `src/cron/trait-scheduler-*.ts`, related tests | PASS-static / WARN-live |
| Report-template UX parity | Operator can create safe skeleton artifacts without accidental promotion | `--print-template` exists in 12 report CLIs: live-proof, harness registry, autonomous research, runtime provider, trait scheduler, task archive, task health, subagent operator, session binding, Peekaboo, Plana advisor, persona telemetry | PASS-static |
| Evaluation hardening / DT audit posture | Completion gate separates static proof from live proof; Critique/DT audit does not over-promote | This audit, `live-proof-matrix.md`, prior deterministic full suite PASS, Claude Critique PASS on latest slices, Gemini Critique quota-degraded | WARN |
| Checkpointing | Durable checkpoint artifact and memory-consolidation attempt | This file plus memory checkpoint attempts. Memory MCP may be session-id degraded depending runtime. | PASS-doc / WARN-memory-runtime |

## 4. Verification evidence captured in this checkpoint

Static verification already recorded in-session for the latest report-template slices:

- For this doc/index slice: `git diff --check` — PASS, and
  `pnpm vitest run tests/readme-current-slices.spec.ts --testTimeout 10000` —
  PASS.
- Inherited same-session static suite for the latest report-template code
  slices: `pnpm lint` PASS, `pnpm build` PASS, focused
  persona/plana/peekaboo template tests plus `pnpm typecheck:tests` PASS, and
  `pnpm vitest run --testTimeout 10000` PASS (148 files / 1955 tests). This is
  not a fresh full-suite rerun for the doc-only slice.
- Repository scan on 2026-05-05 found `--print-template` / `printTemplate`
  coverage in these 12 report CLI files:
  - `src/core/live-proof-report-cli.ts`
  - `src/runtime/agent-harness-registry-report-cli.ts`
  - `src/runtime/autonomous-research-evidence-report-cli.ts`
  - `src/runtime/runtime-provider-evidence-report-cli.ts`
  - `src/cron/trait-scheduler-evidence-report-cli.ts`
  - `src/control/task-archive-evidence-report-cli.ts`
  - `src/control/task-health-evidence-report-cli.ts`
  - `src/runtime/subagent-operator-evidence-report-cli.ts`
  - `src/discord/session-binding-evidence-report-cli.ts`
  - `src/remote/peekaboo-evidence-report-cli.ts`
  - `src/core/plana-advisor-events-report-cli.ts`
  - `src/persona/persona-telemetry-report-cli.ts`
- `live-proof-matrix.md` rows 36-51 currently contain 16 rows marked
  `operator-gated, not live-verified by repo tests`; this is expected and blocks
  full live completion.
- `specs/README.md` was updated only to index this new checkpoint doc. Other
  pre-existing uncommitted index rows in that file are outside this slice.

## 5. Completion gate decision

Do **not** mark the goal complete yet.

The repo now has the static scaffolding and operator artifact UX needed to
approach open-harness parity, including the previously missing safe
`--print-template` setup path for the final retained evidence report CLIs. The
remaining blocker is not a code gap that can be closed inside the repo alone; it
is a proof gap requiring operator-owned live artifacts:

1. Discord service/guild/channel smoke with admin seed and correlated command/reply.
2. GitLab create-or-annotate/closeout artifact.
3. Authenticated Codex and Claude Agent provider TerminalEvidence.
4. Durable task archive/unarchive live interaction and retained audit JSONL.
5. Live subagent roster lifecycle and focus/session binding lifecycle evidence.
6. Task-health threshold calibration and live stalled-task/release evidence.
7. Trait scheduler retained tick evidence from an operator-owned loop.
8. Autonomous-research retained TerminalEvidence for an admitted bounded archive-loop task.
9. Peekaboo macOS/Discord GUI path evidence.
10. Persona live transform telemetry with human no-copy review.
11. Optional/targeted OTLP and SLURM/GPU proof where deployment scope requires it.
12. Gemini Critique retry after quota recovery, if the current verification profile requires the Gemini lens.

## 6. Recursive continuation plan

Use this as the next loop state instead of reopening broad design work:

1. **Execute live-proof collection** — operator generates redacted artifacts using the command templates documented in `README.md` and `live-proof-matrix.md`.
2. **Verify retained artifacts** — run the corresponding read-only report CLI for each surface and then `pnpm live:proof:report -- --proof <manifest> --pretty`.
3. **Repair only failed surfaces** — if a scorecard fails due schema/redaction/UX gaps, repair that one CLI or surface and rerun its focused tests.
4. **Re-run static suite** — `pnpm lint`, `pnpm build`, `pnpm vitest run --testTimeout 10000`, and `git diff --check`.
5. **Critique** — Claude Opus content-bearing Critique plus Gemini stress-check when quota/config is available; record degraded lenses explicitly.
6. **Decline/FAIL branch** — if an operator declines a mandatory live proof or a
   row returns FAIL, keep goal status open, create a focused repair ledger for
   that surface, and re-enter Verify/Critique after the repair rather than
   flipping status.
7. **Complete goal only when** all mandatory live-proof rows needed for the active deployment are operator-approved PASS and no blocking Critique finding remains.
