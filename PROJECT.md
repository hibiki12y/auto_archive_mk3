---
spec_version: "2.0.0"
last_updated: "2026-04-23"
updated_by: "writer"

project_metadata:
  project_id: "auto-archive"
  project_name: "Auto Archive"
  status: "ACTIVE"
  stage: "macos-track-b-close-out-recorded"
  domain: "software-engineering"
  subdomain: "agent-framework"
  description: "Discord 기반 연구 숙고 슈퍼바이저 에이전트 프레임워크 — Orchestrator→SubAgent→Skill 패턴"
  research_question: "Orchestrator→SubAgent→Skill 패턴으로 연구 활동에 특화된 숙고/지식 관리 에이전트를 경량 구현할 수 있는가?"
  expected_contribution: "연구자를 위한 경량 Discord 에이전트: 에이전트 역할 기반 숙고, 지식 그래프 구성, 스킬 주입, CLI 에이전트 감독"
  reference_architecture: ".github/ 에이전트 인프라 (orchestrator, shell agents, behavior skills)"
  notes:
    - "Track b host-backed proof close-out is now recorded complete; non-macOS backlog is historical context only."
    - "P0-C approval-record foundation and P1-A persisted lineage foundation are revalidated complete."
    - "The context/memory axis has no active gap; raw pre-compaction transcript export is optional parity enhancement only."
    - "Post-Track-b implementation is no longer entirely planning-only in the repo state: control authorization/execution-contract slices, memory baseline-freeze/object-model/retrieval-stage/promotion-gate slices, and the bounded delegated compute contract are landed. Remaining scope still fans out as two owner workstreams, three waves, and six paired bundles guarded by companion gates and planning-only later lanes."
    - "Current-branch LLM runtime scope is now bootstrap-time multi-provider: `AUTO_ARCHIVE_RUNTIME_PROVIDER` selects `codex` (default, `@openai/codex-sdk`) or `claude-agent` (`@anthropic-ai/claude-agent-sdk`) once at service startup. Codex bootstrap still prefers valid Codex CLI local auth at `~/.codex/auth.json`; otherwise it falls back to env-backed `AUTO_ARCHIVE_CODEX_API_KEY`, with optional `AUTO_ARCHIVE_CODEX_CLI_PATH`, env-only `AUTO_ARCHIVE_CODEX_MODEL` / `AUTO_ARCHIVE_CODEX_MODEL_FALLBACK` / `AUTO_ARCHIVE_CODEX_REASONING_EFFORT`, and operator-authored `AUTO_ARCHIVE_CODEX_SETTINGS_FILE` for `apiKey` / `codexPathOverride` only. Claude Agent bootstrap uses `AUTO_ARCHIVE_ANTHROPIC_API_KEY` for production or `AUTO_ARCHIVE_CLAUDE_CLI_PATH` for single-user local development, plus `AUTO_ARCHIVE_CLAUDE_*` model/budget overrides. Mid-flight provider switching, runtime fan-out/council execution, Copilot-CLI-as-provider, and OpenAI tool-calling bridge remain out of scope. `templerun` remains a reference document, not a runtime, provider, in-process component, or prompt-origin dependency. See `specs/CLARIFICATIONS/multi-provider-scope.md` and `specs/CLARIFICATIONS/scaffold-adapter-driver-trait-definitions.md` §0."
    - "Trait semantics are now split: compute/resource grants live in `CapabilityFlag`, while Auto Archive Traits are `TraitModule` submodule plugins. Methodology-origin integration is the built-in TraitModule `trait.methodology.agent-methodology-origin.v1` plus an opt-in evidence-only runtime decorator; it does not change runtime provider boundaries and does not turn `templerun` into a runtime or prompt-origin dependency."
    - "Session 112 (2026-04-04): Full project verification + tech debt remediation — 49 TS errors→0, 139 lint errors→0, 5 test failures→0, 4 domain violations→0, 253 lint warnings→0. Zero-warning codebase achieved."

  team:
    lead: "deepsky"
    members: []
    advisors: []

  timeline:
    start_date: "2026-02-24"
    target_completion: "2026-04-30"
    total_estimated_hours: 120
    gpu_hours_budget: 0

milestones:
  - id: "M1"
    name: "TS Foundation"
    description: "shared/ (Result, Brand, Logger) → config/ (Zod env schema) → errors/ (AppError, error codes) → domain/value-objects/"
    status: "completed"
    dependencies: []
    estimated_hours: 8
  - id: "M2"
    name: "Domain Core"
    description: "domain/entities/ → domain/events/ → domain/services/ (BudgetTracker, OrchestrationPolicy, ValidationPolicy)"
    status: "completed"
    dependencies: ["M1"]
    estimated_hours: 10
  - id: "M3"
    name: "Ports & Contracts"
    description: "ports/inbound/ (ArchiveService, CommandBus, EventBus) → ports/outbound/ (LlmClient, KnowledgeStore, DiscordGateway)"
    status: "completed"
    dependencies: ["M1"]
    estimated_hours: 8
  - id: "M4"
    name: "Microkernel & Plugin API"
    description: "skills/skill-module → skills/composition → connectors/connector-module → api/ boundary → 5 skill modules (analyst, researcher, synthesizer, extractor, reviewer)"
    status: "completed"
    dependencies: ["M2", "M3"]
    estimated_hours: 14
  - id: "M5"
    name: "Infrastructure Adapters"
    description: "postgres adapter (pg-pool, repositories) → openai adapter → discord adapter → auth (OAuth PKCE) → security filter"
    status: "completed"
    dependencies: ["M3"]
    estimated_hours: 16
  - id: "M6"
    name: "Application Layer"
    description: "mediator → commands/handlers → use-cases (RunSupervisor, LoadSkill, ConnectAdapter) → composition_root/bootstrap"
    status: "completed"
    dependencies: ["M4", "M5"]
    estimated_hours: 14
  - id: "M7"
    name: "Integration & Testing"
    description: "Vitest unit tests → Testcontainers integration tests → pact contract tests → E2E validation → neverthrow migration cleanup"
    status: "completed"
    dependencies: ["M6"]
    estimated_hours: 16
    acceptance_criteria:
      - "Vitest test suite: 0 failures across all test categories (unit, integration, contract, e2e, stress, property)"
      - "TypeScript strict mode: 0 errors in src/ production code"
      - "Test coverage: minimum 40% (v8 coverage, per vitest.config.ts threshold)"
      - "All 6 test categories represented: unit, integration, contract, e2e, stress, property"
  - id: "M8"
    name: "CLI Agent Supervision (Phase 2)"
    description: "CLI supervisor port → agent provider connectors → /ask command"
    status: "completed"
    dependencies: ["M7"]
    estimated_hours: 20
    acceptance_criteria:
      - "Supervisor FSM: state machine transitions verified (idle → running → complete/failed)"
      - "Agent provider connectors: at least 1 connector operational (Copilot CLI)"
      - "/ask Discord command: end-to-end handler registration and response"
      - "3-tier agent hierarchy: Orchestrator → SubAgent → Skill pattern functional"

required_resources:
  compute:
    gpu_type: null
    gpu_count: 0
    memory_gb: 4
    storage_gb: 10

  datasets: []

  software:
    - name: "Node.js"
      version: "20 LTS"
    - name: "TypeScript"
      version: "5.7+"
    - name: "pnpm"
      version: "latest"
    - name: "PostgreSQL"
      version: "16+"
    - name: "discord.js"
      version: ">=14.16"
    - name: "neverthrow"
      version: ">=8.1"
    - name: "zod"
      version: ">=3.24"

reproducibility:
  random_seed: 42
  deterministic_operations: true
  environment_lock: true

deliverables:
  - name: "Auto Archive Discord Bot (MVP)"
    description: "Orchestrator→SubAgent→Skill 패턴 기반 연구 숙고 Discord 봇 — thread-text `/archive` 중심 아카이브 워크플로"
    type: "software"
    milestone: "M7"
  - name: "Architecture Specification"
    description: "v3.3.0 아키텍처 사양서 (Orchestrator→SubAgent 패턴 포함)"
    type: "document"
    milestone: "M1"
    status: "completed"
  - name: "Agent Skills Library"
    description: "에이전트 역할별 스킬 프롬프트 파일 (researcher, extractor, analyst, synthesizer, reviewer)"
    type: "config"
    milestone: "M2"
  - name: "CLI Agent Supervisor (Phase 2)"
    description: "CLI 에이전트 감독 프로토콜 — /ask 명령어"
    type: "software"
    milestone: "M8"
---

# Auto Archive — Project Specification

> **Status**: ACTIVE | **Domain**: Agent Framework | **Stage**: macOS Track b Close-Out Recorded
>
> **Current branch authority note**: 이 문서는 broader project/program context와 target-state planning을 포함합니다. 현재 브랜치(`reimpl/arona-plana-dispatcher-core`)의 구현 상태는 `README.md`를 기준으로 해석해야 하며, 이 브랜치는 현재 **reimplementation scaffold** 단계입니다.

## Overview

Auto Archive는 Discord 기반 연구 숙고 슈퍼바이저 에이전트 프레임워크를 위한 broader project specification입니다. 현재 브랜치의 구현 범위는 `README.md`에 적힌 reimplementation scaffold를 기준으로 보아야 하며, 아래 내용은 그보다 넓은 **program context / planning target**을 포함합니다. 현재 문서상 planning target은 **Arona (administrator)**, **Plana (policy evaluator)**, **Agent runtime / Agent Instance** (orchestration pattern은 `templerun` Copilot CLI 참조 instruction set의 영향을 받되, templerun 자체는 runtime이 아님), **bootstrap-time runtime provider seam** (Codex default, optional Claude Agent current-branch scope), **compute node = SLURM allocation + Apptainer (rootless) containment** 조합으로 정렬됩니다. `.github/` 에이전트 인프라의 Orchestrator→SubAgent→Skill 패턴과 openclaude-informed 구조는 **참조 패턴**으로만 사용합니다. 코드 표준: [`CODE_STANDARDS.md`](CODE_STANDARDS.md) | 스펙 트리: [`specs/README.md`](specs/README.md) | 용어 정정 프레임: [`specs/CLARIFICATIONS/scaffold-adapter-driver-trait-definitions.md`](specs/CLARIFICATIONS/scaffold-adapter-driver-trait-definitions.md) §0 (binding correction frame), §3 (Adapter/Driver/Trait classification) | 이전 Python→TS 마이그레이션 맵 등 historical snapshot은 [`documents/archive/2026-04-cleanup-into-specs-v1/`](documents/archive/2026-04-cleanup-into-specs-v1/) 아래에 통합 보존됨

> 참고: 일부 historical repo/runtime framing은 더 오래된 orchestration pattern을 언급할 수 있습니다. 그러나 승인된 planning target은 **Arona/Plana + Agent Instance (with nested subagents) + bootstrap-time runtime provider seam (Codex default, optional Claude Agent) + compute node (SLURM allocation + Apptainer containment)** 조합이며, `templerun`은 그 orchestration pattern을 알려주는 Copilot CLI 참조 instruction set입니다 (runtime 아님).

## Current Status

- 현재 브랜치(`reimpl/arona-plana-dispatcher-core`)의 구현 상태는 **Arona / Plana / Dispatcher core contract + runtime skeleton 수준의 재구현 스캐폴드**입니다. 완성된 rewrite나 아래 broader program scope의 구현 완료를 의미하지 않습니다.
- 비-macOS backlog는 더 이상 active remaining-work 영역이 아니며, 관련 비교/백로그 문서는 historical reference로 유지합니다.
- P0-C approval-record foundation과 P1-A persisted lineage foundation은 완료로 재검증되었습니다.
- context/memory 축은 active gap이 없으며, raw pre-compaction transcript export는 선택적 parity enhancement만 남아 있습니다.
- macOS Track b host-backed proof chain close-out은 이제 기록 완료 상태이며, authoritative posture는 B1-H PASS, B2-A/B2-B PROVISIONAL, B3-H PASS, B4-H COMPLETE입니다.
- Track b close-out은 `PROJECT.md`와 `IMPLEMENTATION_LOG.md`에 함께 기록되었습니다. post-Track-b control/workflow continuation과 memory expansion은 계속 locked future owner workstream이며, 이번 동기화는 Wave 1이나 후속 implementation 착수를 의미하지 않습니다.
- 추가 planning target 정렬: legacy OAuth-based Codex path는 historical/retired only로 간주하며, 다음 target runtime은 bootstrap-time multi-provider seam입니다. 기본 `codex` provider는 `@openai/codex-sdk`와 기존 Codex auth/model bootstrap surface를 사용하고, optional `claude-agent` provider는 `@anthropic-ai/claude-agent-sdk`와 `AUTO_ARCHIVE_ANTHROPIC_API_KEY` / `AUTO_ARCHIVE_CLAUDE_CLI_PATH` 계열 bootstrap surface를 사용합니다. `AUTO_ARCHIVE_RUNTIME_PROVIDER`는 서비스 시작 시 1회만 적용되며 mid-flight switching, runtime fan-out/council execution, Copilot CLI provider, OpenAI tool-calling bridge는 여전히 범위 밖입니다. 이 runtime seam은 task-bound lifecycle(`1 request -> 1 compute-node allocation -> 1 Agent Instance`) 위에서 동작합니다. compute node는 SLURM allocation + Apptainer containment를 묶은 단일 추상이며 두 컴포넌트는 sibling이 아니라 같은 compute-node seam의 부품입니다. 이 wording refresh는 target-state 정렬일 뿐, 구현 시작 또는 migration gate 통과를 의미하지 않습니다.

## Current Planning Target

현재 문서상 다음 target architecture를 기준선으로 사용합니다.

| Target surface | Planning target |
| --- | --- |
| Administrator | **Arona (administrator)** |
| Policy layer | **Plana (policy evaluator)** |
| Runtime | **Agent runtime / Agent Instance** (nested subagents). Orchestration *pattern* informed by `templerun` (Copilot CLI reference instruction set); templerun is NOT part of the runtime stack. |
| LLM framework | **Bootstrap-time multi-provider runtime seam** (`AUTO_ARCHIVE_RUNTIME_PROVIDER=codex` default via `@openai/codex-sdk`; optional `AUTO_ARCHIVE_RUNTIME_PROVIDER=claude-agent` via `@anthropic-ai/claude-agent-sdk`; no mid-flight provider switching or runtime fan-out) |
| Compute node | **SLURM allocation + Apptainer (rootless) containment** — one unified compute-node abstraction (NOT two sibling components) |
| Resource unit | **Compute-node resource slot = CPU core, RAM, GPU, time** |
| Lifecycle | **Task-bound lifecycle** — compute time/job 종료 시 자원 release |
| Historical only | Legacy OAuth-based Codex path, repo-owned OAuth architecture |

## Post-Track-b Execution Outlook

Track b close-out은 이제 기록 완료 상태입니다. 아래 구조는 DT Council style synthesis를 반영한 post-close-out execution outlook이지만, 현재 active queue를 넓히지 않으며 이후 Wave 1 착수 기준으로 자동 승격되지 않습니다.

### Locked future owner workstreams

| Owner workstream | Status before unlock | Role after unlock |
| ---------------- | -------------------- | ----------------- |
| Control and workflow continuation | locked future | control-plane, workflow, verifier/hook hardening을 소유하는 상위 owner workstream |
| Memory expansion roadmap | locked future | memory architecture expansion, text-truth alignment, bounded experimental promotion을 소유하는 상위 owner workstream |

### Three-wave, six-bundle internal topology

각 wave는 비슷한 규모의 bundle 두 개를 묶어 병렬 세션으로 진행하도록 설계합니다. cross-session blocking은 이전 wave close-out과 shared contract freeze로만 제한하고, 각 wave 내부에서는 control/memory bundle을 peer execution bundle로 다룹니다.

| Wave | Control bundle | Memory bundle | Parallel execution rule |
| ---- | -------------- | ------------- | ----------------------- |
| Wave 1 | C1 Control Proof Freeze | M1 Memory Baseline Freeze | 두 bundle 모두 post-unlock의 기준선과 freeze artifacts를 고정하며, 다음 wave는 둘 다 close될 때만 연다. |
| Wave 2 | C2 Control Execution Contract | M2 Memory Text Truth Contract | Wave 1 freeze 산출물을 입력으로 받아 병렬 구현 세션을 허용하되, 교차 의존성은 contract surface 교환으로만 제한한다. |
| Wave 3 | C3 Control Availability and Rollout Closure | M3 Memory Experimental Containment and Promotion | Wave 2 contract stabilization 이후 rollout, containment, promotion close-out를 병렬 정리한다. |

### Companion gates

아래 항목은 execution owner workstream이 아니라, 두 owner workstream을 가로지르는 shared gate입니다.

| Companion gate | Scope | Rule |
| -------------- | ----- | ---- |
| Security/Risk | control + memory 공통 리스크 분류와 non-go 판단 | 독립 owner workstream으로 승격하지 않고, 각 bundle close-out의 shared gate로만 사용합니다. |
| Trace-first Observability/Replay | replayability, evidence trace, observability support | execution bundle의 증빙 품질을 보조하지만 top-level queue를 생성하지 않습니다. |
| Assurance/Evaluation | verification 기준, evidence quality, evaluation readiness | later review hierarchy를 위한 shared gate이며 active 또는 locked-future owner workstream이 아닙니다. |

### Planning-only later lanes

아래 항목은 future scouting 또는 concept alignment 용도이며, 현재 execution topology에 포함되지 않습니다.

| Planning-only later lane | Current classification | Rule |
| ------------------------ | ---------------------- | ---- |
| Provenance/Attestation | later-lane concept | future branch 후보 검토용이며 현재 owner workstream이나 companion gate가 아닙니다. |
| Protocol Interoperability/Federation | later-lane experimental note | repo fit/trust-surface 조사만 유지하며 execution bundle grid에 편입하지 않습니다. |
| Additional methodology survey items | later-lane survey pool | 방법론 메모는 reference로만 유지하고 active or locked-future workstream으로 승격하지 않습니다. |

## Broader Architecture Context

상세 아키텍처: [`CODE_STANDARDS.md`](CODE_STANDARDS.md) | [`specs/CURRENT/architecture-hexagonal-microkernel.md`](specs/CURRENT/architecture-hexagonal-microkernel.md)

아래 구조는 project/program 차원의 architecture context 및 target framing입니다. 현재 브랜치에서 이미 전면 구현되었다는 뜻이 아니며, current branch truth는 `README.md`를 우선합니다.

**핵심 패턴**: Hexagonal Architecture (Domain → Ports → Infrastructure) + Microkernel (Skills/Connectors)

- **Domain Layer**: 엔티티, 값 객체, 도메인 이벤트, 도메인 서비스 (순수 비즈니스 로직)
- **Ports**: Inbound (CommandBus, EventBus) / Outbound (LlmClient, KnowledgeStore, DiscordGateway)
- **Infrastructure**: PostgreSQL adapter, OpenAI adapter, Discord adapter, Auth module
- **Microkernel**: SkillModule/ConnectorModule 플러그인 — Plugin API Boundary를 통한 격리
- **Application**: Mediator 패턴, Command/Handler, Use-Cases (Supervisor orchestration)
- **Error Handling**: neverthrow Result<T, E> — 예외 대신 타입 안전한 에러 전파
- **Runtime Validation**: Zod 스키마 — LLM 경계에서의 런타임 타입 검증

### Planning-target runtime framing

- **Arona (administrator)**: 자원 계획, agent execution 요청, 사용자 입력·반응 처리
- **Plana (policy evaluator)**: 시스템 자원 거버넌스, anomaly detection, destructive/inefficient execution veto
- **Agent runtime / Agent Instance**: nested subagent runtime. Orchestration *pattern* informed by the `templerun` Copilot CLI reference instruction set, which is NOT a runtime and NOT part of the runtime stack
- **Bootstrap-time runtime provider seam**: target LLM runtime selection is `AUTO_ARCHIVE_RUNTIME_PROVIDER=codex` by default (`@openai/codex-sdk`) or optional `AUTO_ARCHIVE_RUNTIME_PROVIDER=claude-agent` (`@anthropic-ai/claude-agent-sdk`). Codex keeps its existing local-auth/API-key/settings-file bootstrap surface; Claude Agent uses `AUTO_ARCHIVE_ANTHROPIC_API_KEY` for production or `AUTO_ARCHIVE_CLAUDE_CLI_PATH` for single-user local development. Mid-flight switching, runtime fan-out/council execution, Copilot CLI provider, and OpenAI tool-calling bridge remain outside the current branch scope)
- **Compute node**: one unified abstraction = **SLURM allocation + Apptainer (rootless) containment**. SLURM and Apptainer are NOT sibling/peer components — they are two parts of the same compute-node seam

위 framing은 planning target이며, 현재 브랜치 구현 사실로 읽으면 안 됩니다. 구현 착수/완료 여부는 `README.md`의 branch posture와 `IMPLEMENTATION_LOG.md`를 함께 확인합니다.

## Program Implementation History

아래 M1-M8 순서는 현재 브랜치의 구현 inventory가 아니라, broader project 차원의 기반 구현 이력/기록을 고수준으로 보존한 것입니다. 현재 branch scope 판단에는 사용하지 않으며, remaining-work sequencing은 `IMPLEMENTATION_LOG.md`와 macOS Track b 준비 문서를 기준으로 판단합니다.

| Phase | Modules                                                                              | Milestone |
| ----- | ------------------------------------------------------------------------------------ | --------- |
| 1     | `shared/` → `config/` → `errors/` → `domain/value-objects/`                          | M1        |
| 2     | `domain/entities/` → `domain/events/` → `domain/services/`                           | M2        |
| 3     | `ports/inbound/` → `ports/outbound/`                                                 | M3        |
| 4     | `microkernel/skills/` → `microkernel/connectors/` → `microkernel/api/`               | M4        |
| 5     | `infrastructure/providers/` → `infrastructure/auth/`                                  | M5        |
| 6     | `application/mediator/` → `application/commands/` → `application/use-cases/`          | M6        |
| 7     | Integration tests → Contract tests → E2E                                              | M7        |
| 8     | CLI agent supervision                                                                 | M8        |

## Reference Architecture Mapping

| `.github/` Pattern                        | Auto Archive Implementation                  |
| ----------------------------------------- | -------------------------------------------- |
| `orchestrator.agent.md` (pure routing)    | `Supervisor`: decompose → dispatch → verify  |
| `behavior-*/SKILL.md` (skill injection)   | `skills/*.yaml` → system prompt injection    |
| Shell agents (reader/writer/executor)     | Agent roles (researcher/analyst/synthesizer) |
| DT-Council (multi-perspective)            | `DeliberationCouncil` (simplified)           |
| Memory MCP (store/search)                 | `KnowledgeStore` + `SessionMemory`           |
| Dispatch protocol (context + constraints) | `DispatchPayload` dataclass                  |

위 매핑은 conceptual/reference 대응표입니다. 현재 브랜치에 이 전체 구현이 존재한다는 진술이 아닙니다.

## Resources

| Resource           | Path                                    |
| ------------------ | --------------------------------------- |
| Architecture Spec  | `specs/CURRENT/architecture-hexagonal-microkernel.md` (current); `documents/archive/2026-04-cleanup-into-specs-v1/drafts/ARCHITECTURE_SPEC.md` (historical) |
| Agent definitions  | `.github/agents/*.agent.md`             |
| Skills library     | `.github/skills/*/SKILL.md`             |
| Implementation Log | `IMPLEMENTATION_LOG.md`                 |

## For Agents

**This project is ACTIVE.**

Before starting work:

1. Check `status` field in YAML frontmatter
2. If `TEMPLATE_MODE`: Use `@orchestrator` to initialize first
3. If the project is active, proceed with the current task and treat `IMPLEMENTATION_LOG.md` as the session-detail source of truth
4. Reference architecture: `.github/agents/` and `.github/skills/behavior-*/` for pattern inspiration

See [AGENTS.md](AGENTS.md) for complete agent routing and [PROJECT_SPEC.md](PROJECT_SPEC.md) for specification protocol.
