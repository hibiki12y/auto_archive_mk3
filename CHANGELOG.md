# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Current project status/stage is maintained in `PROJECT.md`; execution chronology is maintained in `IMPLEMENTATION_LOG.md`. This changelog is release/change history, not the live status authority.

## [Unreleased]

### Added
- TraitModule loader/runtime/scheduler follow-up: `traits/**/trait.json` discovery, deep manifest validation, duplicate `id@version` rejection, scheduler dry-run/store, runtime hook import boundary, and versioning contract.
- Persona hard-verbatim event guard plus latency/cost sampling telemetry for opt-in Arona/Plana transforms.
- Peekaboo evidence ledger `artifactPath`, Discord hardening runbook, and templestay reference-boundary static guard.
- Project-local Peekaboo/Codex helper scripts for per-invocation MCP injection without mutating global `CODEX_HOME` config.
- Optional Arona/Plana duet persona transformer for low-risk conversational Discord replies, with protected-token and output-shape guards.
- Auto Archive TraitModule contracts plus `CapabilityFlag` split, including the built-in methodology TraitModule `trait.methodology.agent-methodology-origin.v1`.
- Remaining issues ledger at `specs/CURRENT/remaining-issues-2026-04-30.md`.

### Changed
- **Breaking for self-hosted service setups**: Discord service admin posture now requires explicit admin env/DB seed; no embedded default administrator remains.
- **Breaking for `slurm-apptainer` service mode**: service bootstrap now fails fast unless image and agent-entry env are configured.
- Compute capability surfaces now use `capabilityFlags` and `capabilityFlag` provenance instead of overloaded trait fields.
- Reference resource posture moved from `resource/templerun` toward `resource/templestay`.
- **Monorepo 전환**: pnpm workspaces 기반 monorepo 구조를 도입하고 `packages/` 아래에 워크스페이스 패키지들을 정리
- **Compute Node Dockerfile**: `pnpm --filter` 기반 workspace 빌드로 전환 (기존 tsconfig.compute.json 빌드에서 변경)
- **CI Pipeline**: GitLab CI 및 GitHub Actions에 workspace 패키지 빌드 검증 단계 추가
- **tsconfig.compute.json**: project references 방식으로 전환

### Fixed
- Recorded remaining issue ledger items from 2026-04-30 are resolved or explicitly operator-gated with tests/docs.
- Dispatch completion observer rejections now surface as terminal evidence instead of being silently dropped.
- `ProcessSubprocessRunner` no longer inherits the full host environment by default; it uses an allowlisted env plus explicit request overrides.
- Peekaboo remote evaluation MCP accepts explicit REST observation env controls for authorized live evidence collection.
- 패키지 빌드 스크립트: `tsc -p` → `tsc --build` (composite project references 호환)
- 패키지 exports: `./*` → `./*.js` (ESM 이중 확장자 해결)
- `.dockerignore`: `**/*.tsbuildinfo` 제외 추가

### Removed
- Removed the overloaded `trait-taxonomy` contract and its `methodology-skill` capability no-op branch.

## [0.0.0-alpha] - 2026-03-08

Initial alpha release of Auto Archive — a Discord-based research deliberation supervisor agent framework using the Orchestrator→SubAgent→Skill pattern. Built over 113 development sessions.

### Added

#### Core Architecture
- Hexagonal + Microkernel architecture in TypeScript (ESM, Node.js 22 LTS)
- Orchestrator→SubAgent→Skill delegation pattern for research deliberation
- Microkernel trait-based plugin system with SPI pattern and priority-ordered activation
- Domain core: entities, events, value objects, budget tracker, orchestration/validation policies
- Ports & contracts layer (inbound: ArchiveService, CommandBus, EventBus; outbound: LlmClient, KnowledgeStore, DiscordGateway)
- Application mediator with command/handler routing and use-cases (RunSupervisor, LoadSkill, ConnectAdapter)
- Composition root with dependency injection bootstrap
- neverthrow-based Result types throughout the codebase
- Zod schema validation for configs and environment

#### Discord Bot
- Slash commands: `/archive`, `/research`, `/knowledge`, `/summarize`, `/metrics`, `/report`
- Message triggers: `!status`, `!dashboard`, `!help`
- Interactive status dashboard with buttons and embed builders
- Thread-per-task research workflow with progress streaming
- Channel event triggers with reaction-based state transitions
- Message lifecycle manager for persistent message editing
- Channel manager and role guard for access control
- Credential management commands

#### Knowledge Store
- PostgreSQL-backed knowledge repository with pgvector + full-text search
- Tier policy metadata (active/archive/restore lifecycle)
- Knowledge chunking, quality scoring, and deduplication
- 27 database migrations covering schema evolution
- Knowledge mutation tracking via database triggers

#### Wire Protocol v2
- WebSocket + SSH tunnel transport with automatic reconnection
- HMAC-SHA256 frame signing with canonicalized payloads
- Mutual authentication via server challenge-response
- Binary frame codec (msgpackr) with capability negotiation
- HELLO/HELLO_ACK handshake with version and feature negotiation
- RECONNECT protocol with session token persistence
- Heartbeat controller with pending request tracking
- Key rotation automation (manual + scheduled triggers, grace period enforcement)

#### Compute Infrastructure
- Master/Compute node separation with hybrid SSH+RPC communication
- Apptainer sandbox execution with rootless mode
- SLURM integration with GPU passthrough (`--gres`)
- Compute node CLI agent with JSON-RPC envelope over SSH tunnel
- File-based replay guard with atomic nonce store
- Container pool with warm sandbox management and eviction

#### Self-Improvement Engine
- MCTS-based improvement proposer
- Thompson sampling adaptive dispatch routing
- Pareto selector for multi-objective optimization
- Self-improvement CI/CD pipeline (patch apply → typecheck → test → evaluation)
- GitLab project management port and adapter

#### Behavior Tracking & Telemetry
- TrackedToolCallingLlm decorator for LLM call instrumentation
- TrackedKnowledgeStore decorator for knowledge operation tracking
- TrackedMediator decorator for command execution tracking
- Agent interactions repository with PostgreSQL persistence
- Behavior metrics service (success rate, tool call rate, p95 latency)
- Evaluation report generator with configurable thresholds
- Knowledge mutation → agent_interactions bridge trigger

#### LLM Integration
- OpenAI SDK v5 adapter (Responses API) with error mapping and retry classification
- OpenAI API-key tool-calling bridge adapter (Chat Completions)
- ChatGPT OAuth PKCE authentication with file-based token persistence
- LLM-agnostic supervisor sandbox (provider-independent execution)
- 5 skill modules: analyst, researcher, synthesizer, extractor, reviewer

#### Agent Skills
- Dynamic skill loader with runtime module resolution
- Skill execution context with service injection
- Connector lifecycle management (factory + manager pattern)
- Trait capability gate with role-based command access control

### Changed

- Full rewrite from Python to TypeScript (DT-Council unanimous decision)
- Domain naming migration: kernel→core, drivers→bridges, mm→budget, procfs→status, ipc→events
- ChatGptCodex→ChatGptResponses rename to reflect Responses API accurately
- Sandbox mode codex→cli rename to avoid deprecated model name confusion
- Auth mode chatgpt→chatgpt-oauth rename for clarity
- Centralized interaction router (Map-based O(1) dispatch replacing legacy factory pattern)
- Barrel file removal and dead export cleanup for build hygiene

### Security

- Global HMAC verification at message handler level (HELLO frame exempted)
- Mutual auth via serverChallengeResponse in first heartbeat
- OAuth PKCE flow for ChatGPT authentication
- Command allowlist enforcement in sandbox execution
- Network isolation enforcement (`networkMode='none'`) in OCI bundles
- Apptainer rootless mode with defense-in-depth hardening (10 apptainer.conf settings)
- File-based replay guard preventing nonce reuse
- DT-Council security audit completed: 14 vulnerabilities identified (2 CRITICAL, 5 HIGH, 5 MEDIUM, 2 LOW) with OWASP Top 10 mapping

### Historical Notes at 0.0.0-alpha Release Time

The following notes are preserved as release-time context and should not be read as the current project status.

- **M7 (Integration & Testing)**: In progress — Vitest unit tests and Testcontainers integration tests ongoing; pact contract tests and full E2E validation not yet complete
- **M8 (CLI Agent Supervision)**: Not started — CLI supervisor port, agent provider connectors, `/code` and `/ask` commands planned for Phase 2
- **Security audit remediation**: 14 findings from DT-Council security audit (Session 110) require prioritized resolution; see `documents/reports/SECURITY_AUDIT_REPORT.md`
- **Pre-existing integration test failures**: A small number of integration tests against live PostgreSQL and WebSocket remain intermittently failing

[unreleased]: https://github.com/deepsky/auto-archive-ts/compare/v0.0.0-alpha...HEAD
[0.0.0-alpha]: https://github.com/deepsky/auto-archive-ts/releases/tag/v0.0.0-alpha
