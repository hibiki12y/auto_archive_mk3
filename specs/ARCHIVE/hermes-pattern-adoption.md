---
status: current
authority: implementation-explanation
last_verified: 2026-05-21
source_paths:
  - documents/references/hermes-agent/
  - resource/hermes-agent/
  - CODE_STANDARDS.md
scope: Hermes Agent v0.12.0 패턴 채택 추적 — 16개 서브시스템에 대한 PORT/PORT-PARTIAL/SKIP 결정과 각 결정이 매핑되는 Phase B M-item 진행 상태. 2026-05-21 기준 모델 자동 학습/RL/trajectory/batch-runner 계열은 현 제품 범위 밖으로 축소한다.
supersedes:
---

# Hermes Pattern Adoption Tracking

## 1. 목적과 권한

본 spec은 Hermes Agent v0.12.0(`https://github.com/NousResearch/hermes-agent`, MIT, Python)의 16개 서브시스템에 대해 auto_archive_mk3가 *어떤 패턴을 채택했고, 어떤 패턴을 의도적으로 skip했으며, 그 결정이 어느 M-item으로 land되었는지*를 추적하는 단일 진실 소스이다.

권한:
- `authority: implementation-explanation` — 채택 결정의 *기록*이지 contract가 아니다. 채택된 패턴의 형식 contract는 해당 슬라이스의 `specs/CONTRACTS/` 항목이 가진다.
- 본 spec은 `documents/references/hermes-agent/`(외부 코드 reference)와 `CODE_STANDARDS.md §16`(Hermes-derived anti-patterns)의 governance 카운터파트이다.
- 새 M-item이 land될 때마다 본 spec의 채택 매트릭스를 갱신한다(상태: `pending` → `in-progress` → `landed`).

구속 경계:
- **2026-05-21 범위 정제**: Auto Archive는 현재 Discord-centered automatic research workflow/evidence-governance platform이다. Hermes의 RL environments, trajectory compression/hooks, batch runner, provider zoo, credential pool, multi-channel gateway는 모델 자동 학습 플랫폼을 만들기 위한 active backlog가 아니며, deferred reference로만 남긴다. Curator/self-improvement 채택은 workflow constraint report, skill-candidate review, evidence quality 개선으로 제한하고 모델 가중치 학습이나 SFT/DPO 데이터셋 생성을 의미하지 않는다.
- Hermes는 외부 reference이며 auto_archive_mk3 동작의 진실 소스가 아니다. `specs/README.md` §"진실 소스 위계"의 1-2 순위(`PROJECT.md`, `README.md`, `src/`, `tests/`)가 우선한다.
- `resource/hermes-agent/`는 shallow clone이며 부분이 변할 수 있다. 인용은 v0.12.0(2026-04-30 release) 시점 기준.

---

## 2. 16개 서브시스템 채택 매트릭스

| # | 서브시스템 | Hermes LOC | 채택 결정 | M-item | 상태 | Reference 문서 |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | Curator + workflow-improvement loop | 1,395 | **PORT (workflow only)** | M2 | landed (contract; rubrics deferred to M5b/M5c; no model training/RL) | [01-curator-self-improvement.md](../../documents/references/hermes-agent/01-curator-self-improvement.md) |
| 02 | Gateway plugins + ACP adapter | 100K+B | **PORT-PARTIAL** | M5a/b/c, M10 | M5a + M5b + M5c landed; M10 stages 1–5 landed | [02-gateway-plugins-acp-adapter.md](../../documents/references/hermes-agent/02-gateway-plugins-acp-adapter.md) |
| 03 | Memory + state + SessionDB | 2K+ | **PORT-PARTIAL** | M3 | landed | [03-memory-state-sessiondb.md](../../documents/references/hermes-agent/03-memory-state-sessiondb.md) |
| 04 | Tools + delegate + terminal backends | 5K+ | **PORT-PARTIAL** | M4 | landed (policy enforcer; requested-tool blocklist admission gate; per-subagent tool grants still out of scope) | [04-tools-delegate-terminal-backends.md](../../documents/references/hermes-agent/04-tools-delegate-terminal-backends.md) |
| 05 | Prompt caching strategy | 73 | **PORT (개념)** | M3 | landed | [05-prompt-caching-strategy.md](../../documents/references/hermes-agent/05-prompt-caching-strategy.md) |
| 06 | Provider adapters | 5,749 | **SKIP** | — | n/a (provider zoo out of scope) | [06-provider-adapters.md](../../documents/references/hermes-agent/06-provider-adapters.md) |
| 07 | Trajectory compression | 1,508 | **SKIP** | — | n/a (model-learning trajectory path deferred) | [07-trajectory-compression.md](../../documents/references/hermes-agent/07-trajectory-compression.md) |
| 08 | Batch runner | 1,300 | **SKIP** | — | n/a (batch learning/eval platform deferred) | [08-batch-runner.md](../../documents/references/hermes-agent/08-batch-runner.md) |
| 09 | RL environments + atroposlib | — | **SKIP** | — | n/a (RL/training framework out of scope) | [09-rl-environments-atroposlib.md](../../documents/references/hermes-agent/09-rl-environments-atroposlib.md) |
| 10 | Cron scheduler | 2,421 | **PORT-PARTIAL** | M9 | landed (data plane + UTC one-shot tick planner + bounded host-callback dispatch runner + cursor store/coordinator + in-process tick queue + optional filesystem lease + best-effort evidence JSONL with optional append-time valid-record retention + read-only evidence scorecard/CLI and `/doctor` summary with `replayAudit` counters and bounded chunked `--max-ledger-bytes`/env replay guards: JobOutputStore, resolveContextFrom, SILENT_MARKER, planTraitSchedulerTick, runTraitSchedulerDueJobs, applyTraitSchedulerDispatchCheckpoint, JsonFileTraitSchedulerCursorStore, runTraitSchedulerTickOnce, runTraitSchedulerTickOnceFromStores, InProcessTraitSchedulerTickOnceRunner, JsonFileTraitSchedulerTickLease, runTraitSchedulerTickOnceWithLease, JsonlTraitSchedulerTickEvidenceLedger, runTraitSchedulerTickOnceWithLeaseAndEvidence, buildTraitSchedulerTickEvidenceReport, `pnpm trait:scheduler:evidence:report`); daemon/fresh env reload/timezone-aware wake loop/Discord delivery/backup ledger rotation deferred | [10-cron-scheduler.md](../../documents/references/hermes-agent/10-cron-scheduler.md) |
| 11 | Skill system | 2K+ | **PORT (개념)** | M2 일부 | landed (curator side + `skillBumpUse` usage telemetry sidecar + optional `/traits` use-count view + service/smoke in-process wiring; Hermes view_count/patch_count counters remain out of scope) | [11-skill-system.md](../../documents/references/hermes-agent/11-skill-system.md) |
| 12 | ACP server (editor bridge) | 5K+ | **PORT (단계적)** | M10 stages 1–5 | **landed** (5-stage execution complete: handshake + prompt+cancel + permission bridge + slash commands + persistence/load/resume/fork + Stage 5 polish [`AcpLogger` seam, stable label inventory, `documents/host-setup-acp.md` runbook]) | [12-acp-server-editor-bridge.md](../../documents/references/hermes-agent/12-acp-server-editor-bridge.md) |
| 13 | Doctor / diagnostics | 800 | **PORT (소형)** | OC-3A micro-task | landed (trust-baseline doctor: `pnpm run doctor` + Discord `/doctor`; non-mutating, no `--fix`; package-install probes, symlink repair, and Hermes-specific SOUL/profile checks remain out of scope) | [13-doctor-diagnostics.md](../../documents/references/hermes-agent/13-doctor-diagnostics.md) |
| 14 | Insights engine | 1,651 | **PORT** | M6 | landed | [14-insights-engine.md](../../documents/references/hermes-agent/14-insights-engine.md) |
| 15 | Trajectory hooks | 57 | **SKIP** | — | n/a (trajectory mining out of scope) | [15-trajectory-hooks.md](../../documents/references/hermes-agent/15-trajectory-hooks.md) |
| 16 | Credential pool | 2K+ | **SKIP** | — | n/a | [16-credential-pool.md](../../documents/references/hermes-agent/16-credential-pool.md) |

채택 어휘:
- **PORT** — 구현체 자체는 다르되 패턴/구조/불변식을 그대로 차용
- **PORT-PARTIAL** — 일부 측면만 차용, 나머지는 우리 환경에 부적합
- **PORT (개념)** — 코드 수준 차용 없음, 개념적 가이드만
- **SKIP** — 우리 범위 밖이거나 환경 부적합

상태 어휘:
- **pending** — Phase B M-item이 아직 시작 안 됨
- **in-progress** — M-item 구현 중(어느 PR/commit인지 기록)
- **landed** — M-item이 main에 병합됨, capability flag full-on(있는 경우)
- **n/a** — SKIP 결정이라 land 대상 없음
- **design-only** — 설계만 본 plan에서, 실행은 후속 plan(예: M10)
- **future** — 향후 micro-task 후보

---

## 3. Cross-cutting 작업 단위

본 plan의 Phase B는 cross-cutting 3개를 먼저 land한다(`~/.claude/plans/1-hermes-starry-hummingbird.md` §B.2 DAG):

| ID | 작업 | 영향 파일 | 상태 |
| --- | --- | --- | --- |
| M0a | Hermes-derived anti-patterns 8개 → `CODE_STANDARDS.md §16` | `CODE_STANDARDS.md` | **landed** (2026-05-01) |
| M0b | 본 spec 신규 + `specs/README.md` CURRENT 인덱스 한 행 추가 | 본 파일 + `specs/README.md` | **landed** (2026-05-01) |
| M0c | `ContextLifecyclePort` (refined from ContextEnginePort) 추가 | (skipped — SDK probe ✗) | **skipped** (2026-05-01) |

M0c 사전조사 결과 (2026-05-01):
- `@openai/codex-sdk@^0.125.0` 의 `ThreadEvent` 유니온은 turn/item lifecycle 이벤트만 노출 (`compact`/`compress`/`context`/`session-end` 부재)
- `@anthropic-ai/claude-agent-sdk@^0.2.123` 도 동일 — `system/init`, `assistant`, `result` 메시지뿐, 컴팩션 이벤트 없음
- 결론: 양쪽 SDK 모두 컴팩션 이벤트 미노출 → M0c skip
- 후속 처리: M3(prompt-cache invariant)가 in-adapter 방식으로 직접 assert. SDK가 컴팩션을 외부에 알리지 않으므로 `ContextLifecyclePort` 도입 가치 부재
- 재평가 트리거: 두 SDK 중 하나가 컴팩션/세션 이벤트를 노출하는 메이저 버전 업데이트

---

## 4. P0~P3 권고 → M-item 진행 추적

M4의 requested-tool blocklist는 admission metadata gate이다. 이는 요청
메타데이터에 blocklisted tool name이 포함된 subagent spawn을 descriptor
admission 전에 fail-closed하기 위한 표면이며, per-subagent runtime tool grant나
실행 중 tool permission boundary를 새로 제공하지 않는다.

`~/.claude/plans/1-hermes-starry-hummingbird.md` §B.1의 12개 권고 / 14개 M-item을 추적:

| 우선순위 | 권고 | M-item | 상태 | 머지 PR/commit | 영향 슬라이스 |
| --- | --- | --- | --- | --- | --- |
| Cross | Anti-patterns → CODE_STANDARDS.md §16 | M0a | **landed** | (2026-05-01 commit TBD) | docs |
| Cross | 채택 추적 spec 신규 | M0b | **landed** | (2026-05-01 commit TBD) | docs |
| Cross | ContextLifecyclePort | M0c | **skipped** (SDK probe ✗) | — | contracts |
| P0 | 통합 COMMAND_REGISTRY | M1 | **landed** | (2026-05-01 commit TBD) | discord |
| P0 | Curator → Plana 확장 | M2 | **landed** (contract surface; default identity rubric) | (2026-05-01 commit TBD) | core/runtime |
| P0 | Prompt-cache 불변식 + session_id rotation | M3 | **landed** (warn-default, in-adapter) | (2026-05-01 commit TBD) | runtime |
| P1 | Subagent role/toolset/depth 정책 | M4 | **landed** (role allowlist + depth cap + 80% warning + requested-tool blocklist admission gate; per-subagent runtime tool grants remain out of scope) | (2026-05-01 commit TBD) | runtime |
| P1 | Plugin hook tier 1 (3 lifecycle hooks) | M5a | **landed** | (2026-05-01 commit TBD) | contracts/core |
| P1 | Plugin hook tier 2 (5 mid-cycle hooks) | M5b | **landed** (subagentSpawn/subagentTerminal/skillAdmit/skillBumpUse/commandIntercept; M2 curator channel migrated to skillAdmit; `skillBumpUse` can feed `InMemoryTraitUsageTelemetry`) | (2026-05-01 commit TBD) | contracts/core |
| P1 | Plugin hook tier 3 (7 observe-only hooks) | M5c | **landed** (7 of 7: providerSelectObserve / promptCacheBreakpointObserve / ledgerAppendObserve / insightsSnapshotObserve / doctorProbeObserve / cronTickObserve / acpSessionObserve; ACP payload is lifecycle summary-only and omits prompt text, cwd, MCP declarations, permission decisions, and filesystem content) | (2026-05-01 commit TBD) | contracts/core |
| P2 | InsightsEngine 등가물 | M6 | **landed** | (2026-05-01 commit TBD) | runtime/discord |
| P2 | Cold-start lazy SDK import | M7a | **landed** | (2026-05-01 commit TBD) | runtime |
| P2 | Cold-start mtime config cache | M7b | **landed** | (2026-05-01 commit TBD) | config |
| P3 | Shell-hook bridge | M8 | **landed** (default-OFF; allowlist + per-entry timeout + JSON wire protocol matching Hermes/Claude Code shape; `AUTO_ARCHIVE_ACCEPT_HOOKS=1` non-interactive consent resolution landed; interactive TTY prompt remains out of scope until a concrete operator UI needs it) | (2026-05-01 commit TBD) | runtime |
| P3 | Cron context_from chaining | M9 | **landed** (`src/cron/job-output-store.ts` ships `JobOutputStore` + `resolveContextFrom` + `SILENT_MARKER`/`stripSilentMarker`; `src/cron/trait-scheduler-tick.ts` ships `planTraitSchedulerTick()` as a bounded UTC-only due-run selector over `TraitSchedulerState` plus observe-only `cronTickObserve` summary hooks; `src/cron/trait-scheduler-dispatch-runner.ts` ships `runTraitSchedulerDueJobs()` to sequentially hand cloned due-job snapshots to a host dispatcher callback with awaited async dispatch, per-job failure containment, conservative checkpoint advice including multi-reason hold metadata, JSON cursor store/apply helper, one-shot store coordinator, in-process queue, optional filesystem lease, best-effort tick evidence JSONL, optional append-time valid-record retention compaction, read-only evidence scorecard, and JSONL `replayAudit` counters. `pnpm trait:scheduler:plan` previews the next due-job plan from persisted scheduler state/cursor without dispatching or saving, `pnpm trait:scheduler:evidence:report` exposes the scorecard over an existing ledger path without writing and applies a configurable bounded chunked `--max-ledger-bytes` read guard; `/doctor` can render a redacted read-only summary when `AUTO_ARCHIVE_TRAIT_SCHEDULER_TICK_EVIDENCE_LEDGER_PATH` is configured. Operator daemon, fresh `.env` reload, timezone-aware wake loop, Discord delivery, and backup ledger rotation remain deferred.) | (2026-05-01 commit TBD) | cron(신규) |
| P3 | ACP IDE 통합 | M10 | **landed (stages 1–5 complete)** — Stage 5 추가: `src/acp/acp-logger.ts` (`AcpLogger`/`AcpLogEvent`/`defaultAcpLogger` ndjson-on-stderr seam + `withScope` 헬퍼) + 안정 label 인벤토리(`acp-entrypoint-error`/`-fatal`/`acp-session-store-write-failed`/`acp-permission-denied`/`acp-slash-commands-notify-failed`) + permission bridge `recordDenied()` 통합 + `documents/host-setup-acp.md` 운영 runbook(Zed 등록 JSON + permission UX 표 + 트러블슈팅 + 캐퍼빌리티 광고). | (2026-05-02 commit TBD) | acp(신규) |

---

## 5. 채택하지 않은 패턴(SKIP) 근거

향후 "왜 그 시점에 채택 안 했나"를 확인할 수 있도록 명시:

| 서브시스템 | SKIP 근거 | 재평가 트리거 |
| --- | --- | --- |
| 06 Provider adapters | auto_archive_mk3는 bootstrap-time `codex` + optional `claude-agent` seam만 사용한다. provider zoo/native adapter proliferation은 현재 목표가 아니다. | 특정 provider가 Discord research workflow proof에 필수이고 bootstrap-time seam으로 충분하지 않을 때 |
| 07 Trajectory compression | 모델 학습/RL/SFT-DPO용 trajectory materialization은 현재 제품 범위 밖이다. | training platform을 별도 roadmap으로 열고 redaction/retention/eval gate를 승인할 때 |
| 08 Batch runner | batch learning/eval platform은 현재 제품 범위 밖이다. research-plan은 bounded workflow/evidence orchestration으로만 확장한다. | 대량 실험 실행이 연구 workflow의 필수 live artifact가 될 때 |
| 09 RL environments | RL/atroposlib 학습 환경은 현재 불필요하며 의존도·컴퓨트·평가 부담이 제품 목표를 흐린다. | RL/SFT/DPO가 명시적 목표가 되고 별도 safety/data gate가 생길 때 |
| 15 Trajectory hooks | trajectory mining과 prompt/model rewrite 자동화는 범위 밖이다. constraint report/promotion gate만 유지한다. | trajectory-based training 또는 replay research가 명시적으로 승인될 때 |
| 16 Credential pool | 우리는 단일 deployment의 bootstrap-time provider credential boundary를 유지한다. multi-key pool/rotation은 현재 불필요하다. | multi-tenant SaaS 모드 또는 provider pool 운영이 실제 roadmap에 들어올 때 |

---

## 6. 본 spec의 라이프사이클

- **갱신 시점**: 매 M-item 상태 변화 시(`pending → in-progress → landed`).
- **갱신 책임**: 해당 M-item을 land하는 PR이 본 spec의 §2/§4 표를 함께 수정한다.
- **last_verified 갱신**: 표 갱신 시 frontmatter `last_verified`도 같은 날짜로 변경.
- **supersede 정책**: 본 spec은 새 정책으로 대체되는 것이 아니라 *완성*된다(모든 M-item이 landed가 되면 status를 `stable`로 변경하고 archive 후보로 검토).

---

## 7. 외부 링크

- Plan 본체: `~/.claude/plans/1-hermes-starry-hummingbird.md`
- Reference 문서: `documents/references/hermes-agent/` (16개 서브시스템 + 인덱스)
- Anti-patterns: `CODE_STANDARDS.md §16`
- Hermes 원본: https://github.com/NousResearch/hermes-agent (v0.12.0, MIT)
- 로컬 클론: `resource/hermes-agent/` (92MB shallow clone)
