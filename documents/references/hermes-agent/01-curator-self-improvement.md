---
status: stable
authority: external-code-reference
last_verified: 2026-05-01
source_paths:
  - resource/hermes-agent/agent/curator.py
  - resource/hermes-agent/tools/skill_usage.py
  - resource/hermes-agent/run_agent.py
scope: Hermes Agent Curator self-improvement subsystem의 reference material. auto_archive_mk3 동작에 대한 contract가 아니며 참조 전용.
---

# 01 — Curator Self-Improvement

## 1. Purpose & Boundary

Curator는 Hermes의 background skill consolidation pass다. agent가 idle인 시점에 daemon thread를 spawn하여, 자기 자신이 만든 skill 카탈로그를 LLM이 직접 review하고 umbrella-merge / archive 결정을 내린다. Cron-driven scheduler가 아니다 — inactivity-trigger로만 발동되며, bundled / hub / pinned skill에는 절대 손대지 않고, deletion이 아닌 archive(복구 가능)만 수행한다. 본 문서는 curator의 lifecycle, prompt rubric, reconciliation 알고리즘, defense-in-depth 구조를 정리한 reference material이며 auto_archive_mk3의 contract가 아니다.

## 2. Source Anchors

| 항목 | Path |
| --- | --- |
| Curator 본체 | resource/hermes-agent/agent/curator.py:1-1395 |
| Persistent state load/save | resource/hermes-agent/agent/curator.py:64-97 |
| `maybe_run_curator()` interval check | resource/hermes-agent/agent/curator.py:187-220 |
| Default interval (`24*7` hours) | resource/hermes-agent/agent/curator.py:39 |
| Class-first rubric prompt | resource/hermes-agent/agent/curator.py:262-372 |
| Reconciliation (model vs heuristic) | resource/hermes-agent/agent/curator.py:401-506 |
| Source-label hybrid logic | resource/hermes-agent/agent/curator.py:590-679 |
| Per-run report (run.json + REPORT.md) | resource/hermes-agent/agent/curator.py:378-862 |
| Cron rewrite (X→Y consolidation) | resource/hermes-agent/agent/curator.py:777-801 |
| Background review fork | resource/hermes-agent/run_agent.py:3521-3655 |
| Scoped toolset / nudge=0 / stdout redirect | resource/hermes-agent/run_agent.py:3575-3596 |
| Skill usage telemetry sidecar | resource/hermes-agent/tools/skill_usage.py:1-357 |
| Lifecycle states constant | resource/hermes-agent/tools/skill_usage.py:39-42 |
| Provenance gating | resource/hermes-agent/tools/skill_usage.py:109-207 |
| `bump_use` / `bump_view` / `bump_patch` | resource/hermes-agent/tools/skill_usage.py:314-357 |

## 3. Architecture Sketch

- Trigger: agent main loop가 idle을 감지하면 `maybe_run_curator()` 호출. `last_run_at` + `interval_hours`(default 168h) 비교 후 만료 시 daemon thread spawn.
- Persistent state: `~/.hermes/skills/.curator_state` (atomic temp+rename). 미존재 시 `_default_state()` 반환.
- Sidecar telemetry: `~/.hermes/skills/.usage.json` per-skill record (`use_count`, `view_count`, `last_used_at`, `last_viewed_at`, `patch_count`, `pinned`, `archived_at`).
- Lifecycle: `STATE_ACTIVE` → `STATE_STALE` → `STATE_ARCHIVED`. Archive는 디렉토리를 `.archive/`로 이동만 하며 deletion은 절대 없음 (`restore_skill`로 복구 가능).
- Provenance gate: `.bundled_manifest`나 `.hub/lock.json`에 등재된 skill은 후보에서 제외. Agent-created만 review 대상.
- Background fork: parent agent runtime을 `_current_main_runtime()`으로 상속, `enabled_toolsets=["memory","skills"]`로 scope 축소, `_memory_nudge_interval=0`으로 recursion 차단, stdout/stderr → `/dev/null`, `approval_callback` 자동 거부.
- Prompt: UMBRELLA-BUILDING rubric. Three modes — MERGE INTO EXISTING / CREATE NEW UMBRELLA / DEMOTE TO references|templates|scripts. YAML structured block 강제.
- Reconciliation: heuristic tool-call audit + model YAML 비교. `into`가 `destinations`에 존재하면 model 채택, 없으면 hallucination → heuristic fallback → 그래도 없으면 prune. Source label = {`model`, `tool-call audit`, `fallback`, `hybrid`}.
- Per-run artifact: `~/.hermes/logs/curator/{YYYYMMDD-HHMMSS}/` 아래 `run.json` + `REPORT.md`. Schema: started_at, duration, model, provider, auto_transitions, counts(before/after/delta/...), tool_call_counts, archived[], consolidated[], pruned[], added[], state_transitions, cron_rewrites, llm_final, llm_summary, llm_error, tool_calls.
- Cron rewrite: X → Y consolidation 시 X를 참조하는 cron job entry를 in-place로 Y로 갱신.

## 4. Key Invariants

- Bundled / hub-installed skill은 review 대상 아님.
- `pinned=true` skill은 auto-transition을 우회.
- Deletion 금지 — 최대 destructive action은 archive (`.archive/` 이동).
- Background curator는 daemon thread여야 함 (parent main loop block 금지).
- Recursive curator spawn 금지 — `_memory_nudge_interval=0` 강제.
- Toolset은 `["memory","skills"]`로 축소 — full toolset 노출 시 destructive action 가능.
- 모든 archive 결정은 `consolidations`나 `prunings` 둘 중 하나에 정확히 한 번 등장해야 함.

## 5. Notable Constants & Defaults

- `DEFAULT_INTERVAL_HOURS = 24 * 7` (168시간 = 7일).
- Lifecycle: `"active"`, `"stale"`, `"archived"` (resource/hermes-agent/tools/skill_usage.py:39-41).
- State file: `~/.hermes/skills/.curator_state`.
- Usage sidecar: `~/.hermes/skills/.usage.json`.
- Archive directory: `~/.hermes/skills/.archive/`.
- Reports root: `~/.hermes/logs/curator/{YYYYMMDD-HHMMSS}/`.
- Provenance manifests: `.bundled_manifest`, `.hub/lock.json`.
- Background fork toolset: `enabled_toolsets=["memory","skills"]`.

## 6. Comparison to auto_archive_mk3

| Hermes mechanism | auto_archive_mk3 등가물 |
| --- | --- |
| Inactivity-triggered daemon thread | 미존재 — `src/runtime/`은 외부에서 trigger되는 dispatcher 모델 (M-item 후보) |
| Skill catalog at `~/.hermes/skills/` | 미존재 — `src/contracts/methodology-skill.ts`는 declarative trait module만 정의 |
| `STATE_ACTIVE/STALE/ARCHIVED` lifecycle | 미존재 — `src/core/trait-module-loader.ts`는 admission gate만 |
| Per-run JSON+MD report | 부분적 — `src/control/control-plane-ledger.ts`가 dispatch ledger를 보유 |
| Provenance gate via bundled manifest | 미존재 |
| LLM-driven YAML reconciliation | 미존재 — auto_archive_mk3에는 self-modifying agent가 없음 |

## 7. Adoption Notes

**Decision: PORT (M2)**. Curator를 auto_archive_mk3에 도입하려면 (a) trait module catalog의 인지 가능한 lifecycle state, (b) idle trigger를 보낼 control plane signal, (c) destructive action을 차단하는 scoped runtime variant가 모두 필요하다. 우리는 self-modifying agent를 직접 운영하지 않으므로 M2에서는 reconciliation rubric과 archive-only invariant만 부분 차용하고, daemon thread 구조 자체는 SKIP. Connection point: `src/runtime/methodology-skill-runtime-driver.ts` + 새로운 ledger entry kind `"curator-pass"` in `src/control/control-plane-ledger.ts`.

## 8. Pitfalls / Anti-Patterns Observed

CODE_STANDARDS.md §8 후보:

- Self-improvement agent의 nudge interval은 반드시 0으로 설정 — 그렇지 않으면 무한 spawn.
- Background self-modify는 daemon thread (혹은 isolated process)로만 — main coroutine 안에서 await하면 사용자 입력 block.
- Self-modifying toolset은 항상 explicit allow-list — implicit "all tools" 노출 금지.
- Destructive action은 항상 reversible operation으로 환원 (archive vs delete). Recovery path를 spec에 못 박을 것.
- Provenance gate는 모든 self-improvement pass의 첫 단계여야 함 — bundled / hub-installed 자산은 후보 list에서 제외 후 LLM에 노출.
- LLM이 출력한 reconciliation block은 항상 heuristic ground truth와 cross-check — model "win" 조건은 명시적 `destinations` membership 등 검증 가능한 술어로 한정.
- Per-run artifact는 timestamp-stamped directory에 atomic 저장 — overwrite-only log는 원인 분석 불가.
- Hard rule을 prompt 안에 명문화 (DO NOT delete, DO NOT touch pinned, DO NOT use counters as veto). Prompt-as-policy도 contract.
