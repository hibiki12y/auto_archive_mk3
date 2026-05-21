---
status: current
authority: implementation-risk-ledger
last_verified: 2026-05-05
source_paths:
  - PROJECT.md
  - README.md
  - package.json
  - specs/CURRENT/open-harness-parity-completion-audit-2026-05-05.md
  - specs/CURRENT/openclaw-gap-implementation.md
  - specs/CURRENT/hermes-pattern-adoption.md
  - specs/CURRENT/live-proof-matrix.md
  - specs/CURRENT/remaining-issues-2026-04-30.md
  - src/
  - tests/
scope: Active goal midpoint checkpoint summarizing completed work, current evidence, remaining work, and the next verification gate.
---

# Midpoint Checkpoint — 2026-05-05

## 1. 목적과 판정

Active goal:

> 제안된 계획에 따라 작업 진행, 오픈소스 하네스와 동등한 ux를 가지면서 연구에 특화된 프레임워크가 될 수 있도록 작업

중간 판정은 **WARN / goal not complete**다. 현재 브랜치에는 open-source harness에
가까운 repo-local UX와 연구 특화 TraitModule/증거 표면이 상당 부분 구현되어 있다.
그러나 `specs/CURRENT/live-proof-matrix.md` rows 36-51의 16개 live proof row는
여전히 operator-gated이며, 실제 Discord/GitLab/provider/Peekaboo/SLURM/OTLP 환경
증거 없이 complete로 승격할 수 없다.

이 문서는 진행 상황 설명과 다음 작업 queue를 위한 checkpoint다. 완료 승인 문서가
아니며, completion 판단은
`specs/CURRENT/open-harness-parity-completion-audit-2026-05-05.md`의 gate를 따른다.

## 2. 현재까지 진행한 작업

### 2.1 OpenClaw/open-harness parity 표면

- **Agent harness ABI / descriptor UX**
  - `AgentHarnessPlugin` ABI, harness registry, read-only descriptor report CLI,
    `/doctor` descriptor summary가 추가되었다.
  - provider 선택은 bootstrap-selected `RuntimeDriver` wrapper 경계로 제한하며,
    mid-flight provider switching은 금지한다.
  - 주요 증거: `src/contracts/agent-harness-plugin.ts`,
    `src/runtime/agent-harness-registry.ts`,
    `src/runtime/agent-harness-registry-report-cli.ts`,
    `tests/agent-harness-registry*.spec.ts`.
- **Durable task archive UX**
  - Discord task archive/unarchive, `/tasks archived`, metadata-only
    `task.archived` / `task.unarchived` audit records, read-only retained evidence
    scorecard가 구현되었다.
  - 주요 증거: `src/discord/discord-task-registry.ts`,
    `src/control/task-archive-evidence-report-cli.ts`,
    `tests/task-archive-evidence-report-cli.spec.ts`.
- **Subagent operator UX**
  - root-owned depth-1 roster policy, `/subagents` operator surface, retained
    roster-event scorecard가 구현되었다.
  - 주요 증거: `src/runtime/subagent-roster.ts`,
    `src/runtime/subagent-operator-evidence-report-cli.ts`,
    `tests/subagent-operator-evidence-report-cli.spec.ts`.
- **Focus/session binding UX**
  - `/focus`, focused steering, `/unfocus`, metadata-only binding audit replay가
    구현되었다.
  - 주요 증거: `src/discord/discord-session-binding.ts`,
    `src/discord/session-binding-evidence-report-cli.ts`,
    `tests/session-binding-evidence-report-cli.spec.ts`.
- **Task health / no-progress observer**
  - `RuntimeMidCycleObserver`, default-off `TaskStallObserver`, task-health
    control-plane recorder, retained scorecard, `/doctor` summary가 추가되었다.
  - 주요 증거: `src/contracts/runtime-mid-cycle-observer.ts`,
    `src/core/task-stall-observer.ts`,
    `src/control/task-health-evidence-report-cli.ts`,
    `tests/task-health-*.spec.ts`.

### 2.2 Hermes 패턴 채택과 platform hardening

- **Cron scheduler 패턴**
  - UTC one-shot planner, bounded dispatch runner, cursor/lease/evidence JSONL,
    read-only scheduler evidence scorecard, `/doctor` summary가 landed 상태로
    문서화되었다.
  - 주요 증거: `specs/CURRENT/hermes-pattern-adoption.md`,
    `src/cron/trait-scheduler-*.ts`, `tests/trait-scheduler-*.spec.ts`.
- **Skill/Trait system**
  - `TraitModule` manifest discovery, capability boundary, runtime hook observe,
    usage telemetry sidecar가 landed되었다.
  - 주요 증거: `src/core/trait-module-loader.ts`,
    `src/core/trait-usage-telemetry.ts`,
    `tests/core/trait-module-loader.spec.ts`,
    `tests/trait-usage-telemetry*.spec.ts`.
- **ACP / IDE bridge / doctor**
  - ACP handshake, prompt/cancel, permission bridge, slash command bridge,
    persistence/load/resume/fork, Stage 5 polish와 runbook이 landed 상태다.
  - 주요 증거: `src/acp/`, `tests/acp/*.spec.ts`,
    `documents/host-setup-acp.md`.
- **Control-plane observability**
  - `/feed`, escalation request, default-off OTLP safe metadata observer, redacted
    `/doctor` diagnostics가 정리되었다.
  - 주요 증거: `src/control/control-plane-otel-emitter.ts`,
    `specs/CURRENT/control-plane-otel-and-feed.md`,
    `tests/control-plane-otel-emitter.spec.ts`.

### 2.3 연구 특화 framework 표면

- **Autonomous research TraitModule**
  - repository-owned `trait.research.autonomous-goal-loop.v1`, default-off evidence
    decorator, autonomous research TerminalEvidence report CLI가 추가되었다.
  - 주요 증거: `traits/autonomous-research-goal-loop/`,
    `src/contracts/autonomous-research-trait.ts`,
    `src/runtime/autonomous-research-*.ts`,
    `tests/autonomous-research-evidence-report-cli.spec.ts`.
- **Trait scheduler evidence**
  - 연구 loop를 주기적으로 실행하기 위한 planner/dispatch/evidence/retention
    surface가 정적 검증 가능한 형태로 추가되었다.
  - 주요 증거: `src/cron/trait-scheduler-plan-cli.ts`,
    `src/cron/trait-scheduler-evidence-report-cli.ts`,
    `tests/trait-scheduler-plan-cli.spec.ts`,
    `tests/trait-scheduler-evidence-report-cli.spec.ts`.
- **Runtime provider retained evidence**
  - Codex/Claude Agent provider TerminalEvidence를 redacted scorecard로 replay하는
    CLI와 `/doctor` summary가 추가되었다.
  - 주요 증거: `src/runtime/runtime-provider-evidence-report-cli.ts`,
    `tests/runtime-provider-evidence-report-cli.spec.ts`.
- **GPU/HRM research readiness**
  - GPU Transformer readiness/smoke와 HRM experiment ledger가 추가되어 연구 실행
    환경의 사전 점검 표면이 확장되었다.
  - 주요 증거: `scripts/gpu-transformer-research-readiness.mjs`,
    `scripts/gpu-transformer-smoke.py`, `specs/GUIDES/gpu-transformer-research-readiness.md`,
    `specs/CURRENT/hrm-experiment-ledger.md`.

### 2.4 평가/증거/운영자 setup UX

- **Live proof artifact scorecard**
  - `pnpm live:proof:report`와 `--print-template`가 operator-owned manifest를
    static scorecard로 검증한다.
- **Retained evidence report CLIs**
  - 다음 12개 report CLI는 `--print-template` 또는 `printTemplate` setup path를
    제공한다: live-proof, agent harness registry, autonomous research, runtime
    provider, trait scheduler, task archive, task health, subagent operator,
    session binding, Peekaboo, Plana advisor events, persona telemetry.
- **Persona / Peekaboo / Plana advisor evidence**
  - persona telemetry, Peekaboo evidence, Plana advisor events 모두 read-only
    replay scorecard와 non-promoting template mode가 추가되었다.
- **Completion audit**
  - `open-harness-parity-completion-audit-2026-05-05.md`가 static readiness와
    live proof gate를 분리하고, goal을 아직 complete로 닫지 말라는 결론을 기록한다.

## 3. 현재 검증 상태

### 3.1 최근 doc/checkpoint slice 검증

- `git diff --check`: PASS.
- `pnpm vitest run tests/readme-current-slices.spec.ts --testTimeout 10000`: PASS.

### 3.2 같은 세션에서 상속된 code-slice 검증

최근 report-template code slices에 대해 다음 검증이 기록되어 있다.

- `pnpm lint`: PASS.
- `pnpm build`: PASS.
- `pnpm vitest run --testTimeout 10000`: PASS, 148 files / 1955 tests.
- focused persona/plana/peekaboo template tests + `pnpm typecheck:tests`: PASS.
- Claude Opus 4.7 Critique: PASS / no blockers.
- Gemini Critique: quota-degraded (`QUOTA_EXHAUSTED`)로 WARN.

이 항목들은 같은 세션의 code-slice 검증 근거이며, 이 checkpoint 문서만을 위해 다시
full suite를 실행했다는 뜻은 아니다.

## 4. 남은 작업

### 4.1 Goal completion을 막는 live proof queue

다음 항목은 repo-local 작업만으로 complete 처리할 수 없다. operator-owned live
artifact가 필요하다.

1. Discord service/guild/channel smoke와 correlated command/reply transcript.
2. GitLab create-or-annotate/closeout artifact.
3. Codex runtime provider authenticated TerminalEvidence.
4. Claude Agent runtime provider authenticated TerminalEvidence.
5. Agent harness descriptor 또는 host integration report.
6. Plana advisor sampled runtime-event ledger.
7. Autonomous research admitted bounded archive-loop TerminalEvidence.
8. Durable task archive/unarchive live interaction and audit JSONL.
9. Subagent roster lifecycle/progress retained evidence.
10. Focus/session binding lifecycle retained evidence.
11. Task health threshold calibration, stalled-task event, release evidence.
12. Trait scheduler retained tick evidence from an operator-owned loop.
13. Control-plane OTLP collector receipt, if deployment scope requires OTLP proof.
14. SLURM/Apptainer/GPU dispatch proof, if deployment scope requires cluster/GPU proof.
15. Peekaboo macOS/Discord GUI live evidence.
16. Persona live transform telemetry with human no-copy review.

### 4.2 Verification/Critique backlog

- Gemini Critique must be retried after quota recovery when a Gemini lens is in
  scope.
- After any code repair or operator-proof parser change, rerun focused tests and
  then the static suite (`pnpm lint`, `pnpm build`, `pnpm vitest run --testTimeout
  10000`, `git diff --check`).
- A final completion audit must map every live proof row and active deployment
  requirement to actual artifact evidence before `update_goal(status=complete)` is
  allowed.

### 4.3 Git/worktree hygiene

- The working tree contains many modified and untracked files from multiple
  slices. Do not revert unrelated edits.
- Before merge/commit, group changes into reviewable workstream commits:
  harness/archive UX, Hermes/ACP/cron, research TraitModule/evidence,
  live-proof/report templates, and checkpoint docs.
- Confirm generated runtime-state artifacts are not accidentally committed unless
  they are intended non-secret sample fixtures.

## 5. 다음 실행 순서

1. Use the templates in `README.md` and `live-proof-matrix.md` to create
   operator-owned, redacted proof artifacts.
2. Replay each retained artifact with its corresponding read-only scorecard CLI.
3. Summarize all proof rows with `pnpm live:proof:report -- --proof <manifest>
   --pretty`.
4. Repair only failed scorecards or redaction/schema gaps.
5. Rerun deterministic checks and hetero Critique.
6. Only after all mandatory live rows are operator-approved PASS and no blocking
   Critique remains, run the final completion audit and then mark the goal
   complete.
