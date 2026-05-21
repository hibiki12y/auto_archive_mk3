# Spec ↔ Test Coverage Matrix

Persisted from the 2026-05-08 comprehensive audit (§11 Spec ↔ Test Coverage)
with each test name verified by grep against the first `describe()` argument
in the corresponding test file, replacing the audit's "best guess from
describe" with the actual current test name.

Drafts skipped: none listed. Non-ratified/superseded clarification excluded:
`specs/CLARIFICATIONS/codex-sdk-provider-scope.md`.

| spec file | one ratified invariant from the spec | test file | test name (first describe) |
|---|---|---|---|
| `specs/CLARIFICATIONS/compute-node-slurm-apptainer-unification.md` | `ComputeNode` is the unified production seam for SLURM allocation plus Apptainer containment. | `tests/core/compute-node-slurm-apptainer.spec.ts` | `SlurmApptainerComputeNode` |
| `specs/CLARIFICATIONS/multi-provider-scope.md` | A dispatch uses exactly one runtime sub-driver; provider hot-swap must not create fan-out. | `tests/multi-provider-runtime-driver.spec.ts` | `MultiProviderRuntimeDriver (spec §1.4.0)` |
| `specs/CLARIFICATIONS/scaffold-adapter-driver-trait-definitions.md` | `Trait` is governance/admission identity; compute/resource grants remain `CapabilityFlag`s. | `tests/contracts/trait-module.spec.ts` | `contracts/trait-module — Auto Archive TraitModule manifest` |
| `specs/CLARIFICATIONS/templerun-reference-boundary.md` | `resource/templerun` is reference-only and must not be imported/executed from `src/`. | `tests/agent-methodology-origin-integration.spec.ts` | `agent methodology origin integration source boundaries` |
| `specs/CLARIFICATIONS/templestay-reference-boundary.md` | `resource/templestay` is not a runtime dependency, provider, bootstrap mode, or prompt source. | `tests/resource-boundary.spec.ts` | `resource submodule runtime boundary` |
| `specs/ARCHIVE/architecture-hexagonal-microkernel.md` | TraitModules are extension surfaces, not replacements for kernel-owned contracts/providers. | `tests/contracts/microkernel-module-boundary.spec.ts` | `microkernel module boundary contract` |
| `specs/ARCHIVE/claude-token-offload-implementation-plan-2026-05-05.md` | Claude offload bundles must retain only allowlisted, redacted, advisory-only metadata. | `tests/contracts/claude-token-offload.spec.ts` | `contracts/claude-token-offload` |
| `specs/ARCHIVE/codex-sdk-runtime-bootstrap.md` | Codex CLI auth priority does not create a second provider or bypass runtime provider selection. | `tests/codex-runtime-bootstrap-current-spec.spec.ts` | `Codex runtime bootstrap current spec` |
| `specs/ARCHIVE/control-plane-otel-and-feed.md` | OTLP is observe-only/default-off and collector failure must not affect control-plane correctness. | `tests/control-plane-otel-emitter.spec.ts` | `control-plane OTLP logs emitter` |
| `specs/ARCHIVE/discord-control-plane-always-on.md` | Discord history is untrusted context; executable instruction remains the current task instruction. | `tests/discord-always-on-control.spec.ts` | `discord always-on control plane slice` |
| `specs/ARCHIVE/discord-session-log-thread.md` | When configured, follow-up lifecycle messages route to a task thread and fail open to channel fallback. | `tests/discord-session-log-thread-routing.spec.ts` | `DiscordCommandHandlers session-log thread routing` |
| `specs/ARCHIVE/dispatcher-rate-throttle.md` | `rate-throttle` is a `T2_ChokepointCrossing` chokepoint and other chokepoints must defer. | `tests/admission-rule.rate-throttle-chokepoint.spec.ts` | `ChokepointKind widening — rate-throttle` |
| `specs/ARCHIVE/hermes-pattern-adoption.md` | M3 prompt-cache invariant is landed and enforced at runtime entry/freeze boundaries. | `tests/agent-runtime.prompt-cache-invariant.spec.ts` | `AgentRuntime + prompt-cache invariant integration (M3)` |
| `specs/ARCHIVE/hrm-experiment-ledger.json` | Headline HRM claims require held-out selected-test evidence and retained best-validation weights. | `tests/hrm-longrun-compare.spec.ts` | `hrm-longrun-compare package script` |
| `specs/ARCHIVE/hrm-experiment-ledger.md` | Additive-vs-gated 2-hour HRM result remains exploratory until held-out/multi-seed/parameter gates pass. | `tests/hrm-longrun-compare.spec.ts` | `hrm-longrun-compare package script` |
| `specs/ARCHIVE/live-proof-matrix.md` | Static readiness and operator-owned live runtime proof must not be conflated. | `tests/live-proof-report-cli.spec.ts` | `Live proof report CLI` |
| `specs/CURRENT/research-platform-readiness-and-scope-2026-05-21.md` | Current readiness distinguishes retained live-proof replay from fresh live runtime proof and keeps model auto-learning/RL out of current scope. | `tests/full-matrix-release-blockers.spec.ts`, `tests/release-readiness-checkpoint.spec.ts` | `full-matrix release blockers archival redirect`, `release readiness checkpoint archival redirect` |
| `specs/ARCHIVE/m10-acp-adapter-design.md` | ACP `fork_session` preserves lineage by allocating a new session and triggering rotation. | `tests/acp/acp-server.persistence.spec.ts` | `AcpServer Stage 4 persistence` |
| `specs/ARCHIVE/methodology-skill-admission-governance.md` | Methodology is a repository-owned TraitModule, not a capability flag or provider switch. | `tests/contracts/methodology-skill.spec.ts` | `contracts/methodology-skill` |
| `specs/CURRENT/midpoint-checkpoint-2026-05-05.md` | Redirect-only compatibility stub points the historical midpoint checkpoint to `ARCHIVE/` and the 2026-05-21 readiness SSoT. | `tests/historical-checkpoint-redirects.spec.ts` | `historical checkpoint redirects` |
| `specs/CURRENT/open-harness-parity-completion-audit-2026-05-05.md` | Redirect-only compatibility stub points the historical open-harness completion audit to `ARCHIVE/` and the 2026-05-21 readiness SSoT. | `tests/historical-checkpoint-redirects.spec.ts` | `historical checkpoint redirects` |
| `specs/ARCHIVE/openclaw-gap-implementation.md` | Subagent operator UX is depth-1/root-owned and retained evidence must avoid raw payloads. | `tests/subagent-operator-evidence-report-cli.spec.ts` | `subagent operator evidence report CLI model` |
| `specs/ARCHIVE/orchestrator-subagent-skill-pattern.md` | Runtime/provider selection is not delegated to TraitModules. | `tests/contracts/microkernel-module-boundary.spec.ts` | `microkernel module boundary contract` |
| `specs/CURRENT/remaining-issues-2026-04-30.md` | Redirect-only compatibility stub points the historical remaining-issues ledger to `ARCHIVE/` and the 2026-05-21 readiness SSoT. | `tests/historical-checkpoint-redirects.spec.ts` | `historical checkpoint redirects` |
| `specs/ARCHIVE/task-health-and-escalation.md` | Task stall events are safe task-scoped control-plane events, duplicate-suppressed until progress. | `tests/task-health-control-plane-recorder.spec.ts` | `task-health control-plane recorder` |
| `specs/ARCHIVE/trait-module-submodule-plugin-system.md` | TraitModule manifests use `trait.<namespace>.vN`; scheduler/runtime are declarations, not live execution authority. | `tests/core/trait-module-loader.spec.ts` | `TraitModule loader / registry` |

## Verification methodology

Each row's `test name` column was verified by running:

```
grep -nE "^describe\(" <test_file>
```

against the worktree at commit `4ce4486` (parent of this matrix commit) and
selecting the `describe()` first argument that aligns with the named spec
invariant. Files containing multiple top-level `describe` blocks
(`agent-methodology-origin-integration.spec.ts`, `core/trait-module-loader.spec.ts`,
`admission-rule.rate-throttle-chokepoint.spec.ts`) used the block whose subject
most directly maps to the cited invariant.

All rows are verified against current test files; no `(unverified)`
markers were required. The table contains 26 spec→test rows (the audit's
"24-row" reference under-counted by one).
`hrm-experiment-ledger.json` and `hrm-experiment-ledger.md` are two distinct
spec entries that share one test file, and `live-proof-report-cli.spec.ts`
is reused by three separate `live-proof / midpoint / open-harness` spec
entries because the live-proof report CLI is the single authoritative gate
they all defer to.
