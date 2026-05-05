---
status: stable
authority: external-code-reference
last_verified: 2026-05-05
source_paths:
  - resource/hermes-agent/
scope: NousResearch/hermes-agent v0.12.0 16-subsystem reference material. auto_archive_mk3 동작에 대한 contract가 아니며 참조 전용. M-item 매핑은 specs/CURRENT/hermes-pattern-adoption.md.
---

# Hermes Agent Reference

> **Source**: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), v0.12.0 (2026-04-30 release), MIT license, Python 88% / TypeScript 8.5%.
> **Local clone**: `resource/hermes-agent/` (92MB shallow clone).
> **Investigation date**: 2026-05-01.

## What this is

OpenClaw의 후계 자기개선형 에이전트 런타임. v0.12.0 기준 1,096 commits / 550 PRs / 217k insertions since v0.11.0. 자체 학습 루프(skill 자동 생성/개선/숙고), 19개 메시징 플랫폼, MCP 통합, ACP(Agent Communication Protocol)로 IDE 통합, RL training pipeline (Atropos), 6개 terminal backend(local/Docker/SSH/Modal/Daytona/Singularity, +Vercel Sandbox)을 가진 거대한 단일 저장소.

본 폴더는 auto_archive_mk3의 미래 구현자(또는 본인)가 Hermes를 재조사하지 않고도 패턴/계약/구현 디테일을 참조할 수 있도록 16개 서브시스템을 영구 문서화한다.

## Subsystem matrix

| # | 파일 | Hermes 출처 | 핵심 LOC | 채택 결정 | Phase B M-item |
| --- | --- | --- | --- | --- | --- |
| 01 | [01-curator-self-improvement.md](01-curator-self-improvement.md) | `agent/curator.py` | 1395 | **PORT** | M2 |
| 02 | [02-gateway-plugins-acp-adapter.md](02-gateway-plugins-acp-adapter.md) | `gateway/`, `hermes_cli/plugins.py` | 100+KB | **PORT-PARTIAL** | M5a/b/c, M10 |
| 03 | [03-memory-state-sessiondb.md](03-memory-state-sessiondb.md) | `agent/memory_*`, `hermes_state.py` | 2.2K+ | **PORT-PARTIAL** | M3 |
| 04 | [04-tools-delegate-terminal-backends.md](04-tools-delegate-terminal-backends.md) | `tools/`, `tools/environments/` | 5K+ | **PORT-PARTIAL** | M4 |
| 05 | [05-prompt-caching-strategy.md](05-prompt-caching-strategy.md) | `agent/prompt_caching.py` | 73 | **PORT (개념)** | M3 |
| 06 | [06-provider-adapters.md](06-provider-adapters.md) | `agent/anthropic_adapter.py`, `codex_responses_adapter.py`, `gemini_native_adapter.py`, `bedrock_adapter.py`, `auxiliary_client.py` | 5749 | **SKIP** | — |
| 07 | [07-trajectory-compression.md](07-trajectory-compression.md) | `trajectory_compressor.py` | 1508 | **SKIP** | — |
| 08 | [08-batch-runner.md](08-batch-runner.md) | `batch_runner.py` | 1300 | **SKIP** | — |
| 09 | [09-rl-environments-atroposlib.md](09-rl-environments-atroposlib.md) | `environments/` | — | **SKIP** | — |
| 10 | [10-cron-scheduler.md](10-cron-scheduler.md) | `cron/jobs.py`, `cron/scheduler.py` | 2421 | **PORT-PARTIAL** | M9 |
| 11 | [11-skill-system.md](11-skill-system.md) | `agent/skill_*` | 2K+ | **PORT (개념)** | M2 일부 |
| 12 | [12-acp-server-editor-bridge.md](12-acp-server-editor-bridge.md) | `acp_adapter/` | 5K+ | **PORT (별도 plan)** | M10 |
| 13 | [13-doctor-diagnostics.md](13-doctor-diagnostics.md) | `hermes_cli/doctor.py` | 800 | **PORT (소형)** | OC-3A micro-task landed |
| 14 | [14-insights-engine.md](14-insights-engine.md) | `agent/insights.py`, `usage_pricing.py` | 1651 | **PORT** | M6 |
| 15 | [15-trajectory-hooks.md](15-trajectory-hooks.md) | `agent/trajectory.py` | 57 | **SKIP** | — |
| 16 | [16-credential-pool.md](16-credential-pool.md) | `agent/credential_pool.py`, `credential_sources.py` | 2K+ | **SKIP** | — |

채택 어휘:
- **PORT** — 구현체 자체는 다르되 패턴/구조/불변식을 그대로 차용
- **PORT-PARTIAL** — 일부 측면만 차용, 나머지는 우리 환경에 부적합
- **PORT (개념)** — 코드 수준 차용 없음, 개념적 가이드만
- **SKIP** — 우리 범위 밖이거나 환경 부적합

## Quick-reference: P0~P3 권고 → 서브시스템 + M-item

| 권고 | 우선순위 | 출처 서브시스템 | Phase B M-item |
| --- | --- | --- | --- |
| 통합 COMMAND_REGISTRY | P0 | 02 (`hermes_cli/commands.py`) | M1 |
| Curator 패턴 → Plana 확장 | P0 | 01, 11 | M2 |
| Prompt-cache 불변식 + session_id rotation | P0 | 05, 03 | M3 |
| Subagent role/toolset/depth 정책 | P1 | 04 | M4 |
| Plugin hook surface (15종) | P1 | 02 | M5a/b/c |
| InsightsEngine 등가물 | P2 | 14 | M6 |
| Cold-start lazy SDK import | P2 | (`run_agent.py:75-90` `_OpenAIProxy`) | M7a |
| Cold-start mtime config cache | P2 | (`hermes_cli/config.py`) | M7b |
| Anti-patterns 8개 → CODE_STANDARDS.md | Cross | (`AGENTS.md` Known Pitfalls) | M0a |
| 채택 추적 spec 신규 | Cross | (자체) | M0b |
| ContextLifecyclePort | Cross | (`agent/context_engine.py`) | M0c |
| Shell-hook bridge | P3 | (`agent/shell_hooks.py`) | M8 |
| Cron context_from chaining | P3 | 10 | M9 |
| ACP IDE 통합 | P3 | 12 | M10 |

## Glossary — Hermes-specific 용어

| 용어 | 의미 |
| --- | --- |
| `AIAgent` | Hermes 코어 에이전트 클래스 (`run_agent.py:873`, ~14k LOC, ~60 init parameters) |
| `ProcessHandle` Protocol | 7개 terminal backend가 공통으로 구현하는 duck-typed interface (poll/kill/wait/stdout/returncode) |
| `_ThreadedProcessHandle` | SDK 기반 backend(Modal/Daytona)를 ProcessHandle로 래핑하는 어댑터 |
| `ToolContext` | RL environment의 tool dispatcher 컨텍스트 (terminal/file_view/web 노출) |
| `ToolCallParser` | 모델별 tool-call 추출기 (DeepSeek V3.1, GLM4.7, Qwen3-Coder, Hermes 등) |
| `SILENT_MARKER` | `[SILENT]` 문자열 — cron job 출력에 들어가면 delivery 억제 (`cron/scheduler.py:115`) |
| `system_and_3` | Anthropic prompt cache 4-breakpoint 전략 (system + 마지막 3 비-시스템 메시지) |
| `cache_ttl` | prompt cache 유지 기간 — 5m 기본, 1h opt-in (`agent/prompt_caching.py:58-59`) |
| `FTS5 trigram` | SQLite FTS5의 trigram tokenizer로 CJK 부분문자열 검색 지원 (`hermes_state.py:132-156`) |
| `atroposlib` | Nous Research RL training framework, `environments/` 의 base class 제공 |
| `AvailableCommand` | ACP 프로토콜의 슬래시 명령 광고 객체 (`acp_adapter/server.py:912`) |
| `bump_use` / `bump_view` / `bump_patch` | skill 활동 텔레메트리 카운터 (`tools/skill_usage.py:314-357`) |
| `STATE_ACTIVE` / `STATE_STALE` / `STATE_ARCHIVED` | skill 라이프사이클 (`tools/skill_usage.py:39-42`) — 절대 삭제하지 않고 archive만 |
| `COMMAND_REGISTRY` | 모든 슬래시 명령의 단일 source (`hermes_cli/commands.py`) — CLI/gateway/Telegram BotCommand/Slack subcommand/ACP/autocomplete가 모두 자동 파생 |
| `VALID_HOOKS` | 15종 plugin hook 화이트리스트 (`hermes_cli/plugins.py`) |
| `_AGENT_LOOP_TOOLS` | dispatcher 도달 전 `run_agent.py`에서 가로채는 도구 (todo, memory, session_search, delegate_task) |
| `DELEGATE_BLOCKED_TOOLS` | subagent에 절대 부여하지 않는 도구 집합 (`tools/delegate_tool.py`) |
| `_last_resolved_tool_names` | process-global tool name cache; `_run_single_child()`가 save/restore |
| `system_and_3 strategy` | 4 cache_control 브레이크포인트 (system + last 3 non-system messages) |
| `auxiliary_client` | 부수 작업(컴팩션 요약, session search, vision)용 routed client (`agent/auxiliary_client.py` ~3840 LOC) |
| `_HERMES_CORE_TOOLS` | 모든 플랫폼에서 활성화되는 코어 도구 목록 (`toolsets.py`) |
| `_OpenAIProxy` | OpenAI SDK lazy import을 위한 thin proxy (`run_agent.py:75-90`) — ~240ms 절감 |

## Citation 규칙

본 폴더의 모든 인용은 `resource/hermes-agent/<path>:<start_line>-<end_line>` 형식.

- 단일 라인은 `:N`만 (예: `cron/scheduler.py:115`)
- 라인 범위는 `:N-M` (예: `agent/curator.py:401-506`)
- 코드 verbatim 복사는 5줄 이내로 제한 (MIT지만 drift 위험 + live source 모델 보존)

## Phase A 검증 체크리스트

본 reference set이 완성되었는지는 다음으로 확인:

1. 17개 마크다운 파일이 모두 존재 (`README.md` + `01-…` ~ `16-…`)
2. 모든 파일에 frontmatter (`status` / `authority` / `last_verified` / `source_paths` / `scope`)
3. 인용 문법 통일: `grep -rE 'resource/hermes-agent/[^:]+:[0-9]+' documents/references/hermes-agent/`로 모두 나열, 10개 무작위 표본을 실제 라인과 대조
4. 채택 결정 매트릭스(상단)와 `specs/CURRENT/hermes-pattern-adoption.md`가 일치
5. **Smoke test**: M2(Curator) 구현 시 `01-curator-self-improvement.md`만 읽고 진행 가능하면 성공

## 폴더 외부 링크

- Plan 본체: `~/.claude/plans/1-hermes-starry-hummingbird.md`
- 채택 추적: `specs/CURRENT/hermes-pattern-adoption.md`
- 코드 표준: `CODE_STANDARDS.md §8` (Hermes-derived anti-patterns)
- Hermes 원본: https://github.com/NousResearch/hermes-agent
