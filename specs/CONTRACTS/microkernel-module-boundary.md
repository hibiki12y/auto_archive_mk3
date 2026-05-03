---
status: current
authority: stable-contract-interpretation
last_verified: 2026-05-01
source_paths:
  - README.md
  - src/contracts/
  - src/core/
  - src/runtime/
scope: Auto Archive microkernel module taxonomy and the boundary between kernel-owned surfaces and TraitModule extensions.
---

# Microkernel Module Boundary Contract

## 1. Decision

Auto Archive does not convert every microkernel module into a TraitModule.
TraitModule is one optional extension category inside the broader microkernel
module taxonomy. Kernel authority, execution identity, resource allocation, and
terminal evidence semantics remain kernel-owned.

## 2. Module taxonomy

| Kind | Meaning | Examples |
| --- | --- | --- |
| `kernel-core` | Always-present orchestration or governance authority. | `Arona`, `Plana`, `Dispatcher`, `AgentRuntime`, `TraitModuleLoader` |
| `port-contract` | Stable data/interface vocabulary with no external SDK behavior. | `ComputeNode`, `RuntimeDriver`, `TerminalEvidence`, `CapabilityFlag`, `TraitModuleManifest` |
| `infrastructure-adapter` | External system boundary implementation or composition glue. | Codex SDK adapter, Discord adapter, GitLab adapter, Peekaboo adapter, SLURM/Apptainer implementation |
| `trait-module` | Optional project-owned behavior extension loaded through the TraitModule contract. | methodology-origin, future persona profile, future schedule/policy/evidence-rubric modules |

All TraitModules are microkernel modules in the broad taxonomy, but not all
microkernel modules are TraitModules.

## 3. Kernel-owned responsibilities

The following responsibilities MUST remain outside TraitModules:

1. Task identity issuance and single-use submission guarantees.
2. Dispatch lifecycle ownership, cancellation latching, and terminal settlement.
3. `TerminalCause` and `TerminalEvidence` semantics.
4. `ComputeNode` allocation, dispatch, observation, and cancellation.
5. Runtime provider selection and Codex SDK bootstrap boundaries.
6. Plana's final admit/veto/approval authority.
7. Discord authorization, access policy, and durable control ledger authority.
8. TraitModule discovery/validation/loading itself.

## 4. Allowed TraitModule responsibilities

TraitModules MAY provide:

- human-readable instruction profiles through `TRAIT.md`;
- declarative schedule/cadence proposals consumed by a kernel scheduler;
- declarative admission or policy inputs consumed by Plana;
- evidence-only runtime driver decorators;
- presentation profiles for low-risk user-facing text;
- evaluation rubrics or evidence scoring profiles.

TraitModules MAY request `CapabilityFlag` grants, but the capability vocabulary
and grant compilation stay kernel/compute-owned.

## 5. Forbidden TraitModule modes

TraitModules MUST NOT:

- switch runtime providers or select a `RuntimeDriver`;
- call or override `Dispatcher.submit`;
- issue `TaskId`, runtime instance id, allocation id, or approval request id;
- allocate or cancel compute resources directly;
- rewrite `TerminalCause` or convert failures to success;
- bypass Discord auth/access policy;
- replace Plana as policy authority;
- run unbounded daemon loops.

The current manifest loader rejects reserved kernel-authority keys such as
`extensionPoints`, `dispatcherOverride`, `runtimeProvider`,
`computeAllocator`, `terminalCauseRewrite`, `authOverride`, and
`unboundedDaemon`. Adding first-class extension point fields requires a schema
amendment instead of ad hoc manifest keys.

## 6. Extension point registry

Current and planned extension points are constrained as follows:

| Extension point | Owner | TraitModule effect |
| --- | --- | --- |
| `arona.instruction-envelope.v1` | Arona/control plane | append bounded instruction context |
| `plana.admission.v1` | Plana | supply declarative policy inputs only |
| `control.scheduler.v1` | control plane | materialize declared schedules as proposed jobs |
| `agent-runtime.driver-decoration.v1` | runtime | append evidence-only checkpoints |
| `terminal-evidence.enrichment.v1` | runtime/evidence boundary | append warnings or references, not causes |
| `discord.presentation.v1` | Discord presentation layer | transform low-risk text only |
| `subagent.role-profile.v1` | runtime/subagent operator | provide role/instruction profile only |
| `evaluation.rubric.v1` | evaluation boundary | score or classify evidence only |

No extension point may grant provider switching, terminal-cause rewriting, direct
compute allocation, unchecked approval response, or Discord authorization
override.

For `agent-runtime.driver-decoration.v1`, the only current implementation path
is opt-in `AgentRuntime` composition of a caller-provided, pre-admitted
`TraitRuntimeDriverDecorator` list. This path is dispatch-time wiring, not
TraitModule auto-discovery: manifest discovery/loading/admission remains outside
`AgentRuntime`, and decorators may only wrap the selected `RuntimeDriver` to
append evidence. When multiple decorators are supplied, declaration order is
observable and the first binding is the outermost wrapper.
Composition roots may provide a per-dispatch resolver to run Plana admission and
loader validation before returning that pre-admitted list; the resolver is still
caller-owned and does not make `AgentRuntime` a TraitModule discovery service.

## 7. TraitModule decorator execution bounding

`composeTraitRuntimeDriverDecorators` is a **pure composition** of decorators
into a single `RuntimeDriver`. It does not race each `binding.decorator(...)`
invocation against a per-decorator timeout, and it does not wrap each composed
`run()` call in a per-decorator deadline. A misbehaving or slow trait runtime
decorator (one whose `run()` body hangs or stalls) is therefore bounded by the
**plan-level deadline only**:

- The kernel observes `plan.runtimeSettings.deadlineMs` in `AgentRuntime`. When
  set, the deadline timer races alongside the composed driver execution and
  latches a `TerminalCause.kind: 'timeout'` with provenance
  `agent-runtime-deadline` once the deadline elapses.
- Trait runtime decorators inherit this backstop transparently. Operators who
  enable trait runtime decorators SHOULD set `deadlineMs` on the dispatch plan;
  operators who do not set `deadlineMs` accept that a hung decorator is bounded
  only by external cancellation.

Per-decorator timeout wrapping inside the composition path is a plausible future
hardening, but it is **not part of the current contract**. Trait runtime
decorators MUST NOT rely on a per-decorator timeout existing.

Trait module loader internals (`TraitModuleLoader.invokeTraitRuntimeHook` and
`TraitModuleLoader.loadTraitRuntimeDriverDecorator`) bound their own dynamic
`import()` and entrypoint invocation with `withTimeout` (default 5_000 ms,
caller-tunable via `options.timeoutMs`). Those timeouts protect manifest
admission/load — they are **not** the decorator-execution backstop. The
decorator-execution backstop is the plan-level deadline above.

Regression coverage:
`tests/runtime/agent-runtime-trait-runtime-decorator.spec.ts` includes
`'plan-level deadlineMs bounds a slow trait decorator (DT Audit H3 backstop)'`
which constructs a hanging trait decorator and asserts the kernel latches
`cause.kind === 'timeout'` with provenance `agent-runtime-deadline` within the
configured `deadlineMs + tolerance`.
