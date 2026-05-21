# Codex CLI Policy Adapter

Last sync target:

- `.codex/config.toml` (2026-05-16)
- `.codex/verify_alignment.sh` (2026-05-16)
- `.github/copilot-instructions.md` (2026-03-21)
- `.github/instructions/copilot-instructions.md` (2026-03-21)
- `.github/agents/orchestrator.agent.md` (2026-03-21)
- `AGENTS.md` (2026-03-19)
- `.github/configs/agent_policy.yaml` (2026-03-19)
- `.github/instructions/metacognitive.instructions.md` (2026-03-19)

This file keeps Codex CLI behavior aligned with `.github` conventions.
If any statement here conflicts with the source files above, **the source files win**.

This file is supplementary bridge documentation, not the primary Codex instruction entrypoint.
Codex auto-loads `AGENTS.md` and `PROJECT.md` directly. This file is only discovered through the configured fallback filename list when no higher-priority `AGENTS.md` or `AGENTS.override.md` applies in the current directory.

---

## §1. Source of Truth

Codex users must treat these as canonical (in priority order):

1. `PROJECT.md` — status gate and project lifecycle
2. `AGENTS.md` — routing, skills, verification, MCP infra
3. `.github/instructions/copilot-instructions.md` — invariants + protocols
4. `.github/instructions/metacognitive.instructions.md` — post-output checks
5. `.github/skills/behavior-*/SKILL.md` — behavior skills (26 active)
6. `.github/configs/agent_policy.yaml` — limits, locale, telemetry, search budget

This file is an **adapter** for Codex CLI runtime differences only.

Copilot CLI auto-load entrypoint: `.github/copilot-instructions.md` is a compatibility entrypoint that points back to the canonical `.github/instructions/copilot-instructions.md` policy. It is not an independent policy source.

Codex-native project surfaces:

1. `AGENTS.md` / `PROJECT.md` — primary instruction files
2. `.codex/config.toml` — project-scoped runtime, MCP, app/connector, and
   subagent role limits
3. `.codex/verify_alignment.sh` — local verifier for the Codex compatibility
   surface
4. `.codex/agents/*.toml` — optional project-scoped custom agent config layers
   (currently not required; roles are declared inline in `.codex/config.toml`)
5. `.agents/skills/` — optional repo skill surface when active skill files are
   checked in or bridged
6. `codex.md` — supplementary/fallback notes only

Compatibility note: this bridge surface was last locally exercised with
`codex-cli 0.130.0` on 2026-05-16. `bash .codex/verify_alignment.sh` validates
repository invariants, the expected project config shape, and the Codex 0.130
`multi_agent_v2` guard that requires boolean `features.multi_agent_v2 = true`
while avoiding both the rejected `[features.multi_agent_v2]` table form and the
legacy `agents.max_threads` key; it is not an upstream Codex
schema-conformance oracle and should be rerun after CLI upgrades.
This scoped check is an upstream Codex schema compatibility guard for known
project invariants, not a complete upstream Codex schema proof.

---

## §2. Pre-Work Gate (Mandatory)

1. Read `PROJECT.md` → check `project_metadata.status`.
2. `TEMPLATE_MODE` → halt; only `behavior-project-kickoff` may proceed.
3. `INITIALIZED` / `ACTIVE` → continue normally.

---

## §3. Invariant Rules (13 rules — synced)

These mirror `copilot-instructions.md §1`. All are mandatory.

1. **Plan before act** — for file edits, code changes, or multi-step operations.
2. **All GPU work via SLURM** — no direct GPU execution.
3. **Memory MCP is the only memory store** — no `*.memory.md` files.
4. **Follow-up interaction contract (coordinator only)** — after each completed turn, the coordinator agent must emit a user-visible status report using the literal Intermediate Summary Template for completed-turn updates, or the literal Workflow Summary template when wrapping up; dense freeform prose is insufficient. It must then use the active runtime's follow-up/question surface to preserve the same completion-approval / stop-pause loop semantics. In Codex CLI, that follow-up surface may still be plain text, but the loop remains active until the user explicitly approves that the current goal is fully complete or explicitly chooses to stop/pause. Once the current goal's success criteria are met, only mandatory bookkeeping may occur before handing control back to the user; the coordinator must not autonomously start adjacent cleanup, follow-up maintenance, next-session preparation, or related-but-unrequested work unless the user explicitly selects it. Child agents must NOT query the user directly; report blockers as `[REQUIRES_USER_INPUT]` in output.
5. **Progress tracking** — read/update `IMPLEMENTATION_LOG.md`; store with `work-log` tags.
6. **Three-layer language** — cognitive/tool: English; presentation: locale.
7. **MCP-first** — structured tools over direct CLI.
8. **Configs read-only** — `.github/configs/` read-only; generate in `configs/generated/`.
9. **Type hints required** — explicit annotations, no implicit `Any`.
10. **Verify before optimize** — reproduce correctness first.
11. **3-strike escalation** — re-decompose or escalate after 3 consecutive failures.
12. **Research dedup** — `memory_search` before any `tavily_search`/`context7`/`arxiv` call; reuse if similarity > 0.7.
13. **Data-before-code for reproductions** — verify data pipeline equivalence before training on paper reproductions.

---

## §4. Codex Compatibility Layer

Mappings from `.github` conventions to Codex CLI runtime:

| VS Code Convention                                           | Codex CLI Equivalent                                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Follow-up interaction contract (`vscode/askQuestions` in VS Code) | Emit the literal Intermediate Summary Template or Workflow Summary template first after each completed turn, then use the active runtime follow-up/question surface to continue the same completion-approval / stop-pause loop in concise plain text. After the current goal is done, limit pre-handoff work to mandatory bookkeeping only and treat any Next / Suggested Next Steps text as user decision points/options, not autonomous execution commitments |
| `runSubagent`                                    | `spawn_agent` / `send_input` / `wait_agent` / `close_agent` (legacy Codex UI labels: `spawnAgent` / `sendInput` / `waitAgent` / `closeAgent`) |
| MCP hyphen names (`tavily-search`)               | Codex MCP ids in `.codex/config.toml`; project-local Peekaboo is `peekaboo-remote-eval`               |
| `.github/agents/*.agent.md`                      | `.codex/config.toml` inline role descriptions, or `.codex/agents/*.toml` custom layers when needed    |
| `.github/skills/*`                               | Optional `.agents/skills/*` repo skill bridge when active skill files are checked in                   |
| `CODEX_HOME`                                     | Optional isolated automation profile only. Normal interactive use should run plain `codex` from repo root |
| Follow-up interaction prohibition in subagents (`vscode/askQuestions` in VS Code) | Same: child agents must NOT query user directly; report blockers as `[REQUIRES_USER_INPUT]` in output |

When active behavior skill files are present, `metadata.codex-mode: true` means
the skill can be injected into the main Codex session or Codex subagents without
an extra Copilot-only shim. Historical backups such as `SKILL_v1_backup.md` may
still retain older metadata and are not part of the active compatibility surface.
The current reimplementation scaffold keeps the durable routing policy in
`AGENTS.md`; Codex role discovery is provided by `.codex/config.toml` even when
the optional skill bridge is absent.

---

## §5. Skill-Based Dispatch

Full routing tables: `AGENTS.md §3`. Required behavior:

1. Choose behavior skill from `.github/skills/behavior-*/SKILL.md`.
2. Choose shell agent tier by task type (Reader / Writer / Executor).
3. **Codex adaptation**: inject `[SKILL]` block content into the `spawn_agent` prompt.
4. Follow fallback chain: primary agent fails 2× → alternate model tier → escalate to user.

### Verification Routing

| Output Type  | Skill                            | Scope                                                        |
| ------------ | -------------------------------- | ------------------------------------------------------------ |
| Code         | `behavior-code-quality-reviewer` | Standards, reproducibility                                   |
| Methodology  | `behavior-validator`             | Claims, experimental results                                 |
| Math / Paper | `behavior-math-reviewer`         | Equation-code consistency (**mandatory**)                    |
| Documents    | `behavior-doc-reviewer`          | Factual accuracy, structure quality, maintenance risk        |
| Escalation   | `behavior-rubric-verifier`       | Multi-perspective consensus                                  |
| Config       | `behavior-config-verifier`       | Semantic correctness, resource bounds, library compatibility |
| Contracts    | `behavior-contract-compliance`   | Output contract structural compliance                        |

Source: `AGENTS.md` → Verification Routing table.

---

## §6. MCP Policy

Codex MCP mapping: `.codex/config.toml`. Repo-local VS Code MCP registration is
deprecated/removed; use operator-owned MCP client config for non-Codex MCP
surfaces.

Validation: `bash .codex/verify_alignment.sh` (TOML parse + server parity + governance files).

Default runtime path: run plain `codex` commands from the repository root after
trusting the project, or pass `codex -C "$REPO_ROOT"` from another directory.
Project-scoped `.codex/config.toml` is loaded in that project context, and the
Peekaboo MCP entry uses `cwd = "."` with that project root expectation.
`CODEX_HOME=.codex` is reserved for isolated automation profiles with separate
auth/session state and must not be used for normal interactive runs unless the
operator intentionally wants a separate Codex home.

Servers available via the checked-in project layer: `peekaboo-remote-eval`.
Operator/user-scope Codex config may still add Memory MCP, Tavily, GitHub, or
other connectors; this repository does not check in credentials or user-scoped
MCP registrations.

Templestay integration posture:

- `resource/templestay` is pinned as a reference/plugin resource and is not a
  runtime dependency, provider, bootstrap mode, or prompt source of truth for
  Auto Archive.
- Secret-safe readiness proof is the non-mutating Codex installer preview:
  `bash resource/templestay/scripts/install_templestay_codex_cli.sh --preset balanced --memory-profile none --dry-run --no-tavily`.
- Real templestay install state is operator-owned (`CODEX_HOME`, Claude
  settings, `.templestay-harness`, memory roots, provider credentials). Do not
  commit generated user-scope state into this repository.
- Auto Archive owns its project-scoped Codex compatibility keys. Templestay must
  not write `[agents]` thread limits here; this repo keeps
  `features.multi_agent_v2 = true` while omitting the rejected
  `[features.multi_agent_v2]` table/concurrency key and the legacy
  `agents.max_threads` key. Runtime/session policy owns any active thread cap.

Codex app/cloud notes:

- Local Codex app/CLI sessions should open this repository as the selected
  project so `AGENTS.md`, `PROJECT.md`, and `.codex/config.toml` are in scope.
- Cloud threads clone the GitHub repository branch, so project-scoped config and
  docs must be committed before relying on them in cloud tasks; this document
  records static compatibility expectations, not proof of an authenticated cloud
  run.
- App/connectors are enabled in the project layer, but destructive and
  open-world app tools default to disabled and per-tool use remains prompt-gated.

---

## §7. GPU / SLURM Policy

1. No direct GPU job execution — submit/monitor via SLURM MCP tools.
2. Validate config semantics before submission.
3. Store experiment and failure context in Memory MCP.

Reference: `AGENTS.md §5`, `.github/skills/behavior-slurm-manager/SKILL.md`.

---

## §8. Session Resume Protocol

**Mandatory 5-step recovery** at every session start (source: `copilot-instructions.md §6`):

1. Read `IMPLEMENTATION_LOG.md` — identify last completed task.
2. `memory_search` for recent `work-log` entries (last 10).
3. `memory_list(tags=["checkpoint"])` — check incomplete checkpoints.
4. Compile status: completed / in-progress / blocked.
5. Resume from last checkpoint or present status + next steps.

**Anti-pattern**: never reload full project spec from scratch when `work-log` records exist.

---

## §9. Language Policy

Source: `.github/configs/agent_policy.yaml → locale`.

| Layer        | Language        | Scope                            |
| ------------ | --------------- | -------------------------------- |
| Cognitive    | English (fixed) | Reasoning, planning, inter-agent |
| Tool         | English (fixed) | API calls, configs, MCP metadata |
| Presentation | Korean (locale) | User-facing output               |

Exception: error messages → Korean context + English stack trace.

---

## §10. Architecture Decision Lock

Source: `copilot-instructions.md §3`.

1. **Record**: `memory_store` with tag `architecture-decision` (rationale + alternatives + date).
2. **Lock**: no agent may change a locked decision autonomously.
3. **Override**: requires explicit user approval with impact assessment.
4. **Track**: log in `IMPLEMENTATION_LOG.md → Technical Decisions`.

**Anti-pattern**: never re-evaluate architecture at every session.

---

## §11. Search Budget Protocol

Source: `copilot-instructions.md §4`, `.github/configs/agent_policy.yaml → search_budget`.

Hierarchical session model for Tavily search credits:

1. Create parent session: `tavily_create_budget(session_id="{task-id}", max_credits=...)`.
2. Create child per dispatch: `tavily_create_budget(session_id="{task-id}:{agent}:{n}", parent_session_id="{task-id}")`.
3. Children are isolated — one exhausting budget does not affect siblings.
4. Release sessions after dispatch; unused credits return to parent.

Budget levels: simple=6, moderate=12, complex=20, deep_research=40. Hard cap: 100 credits/session.

**Codex adaptation**: Codex CLI uses `tavily_search` (underscore) — session IDs apply the same way.

---

## §12. DT-Council / Deep Think Protocols

Source: `AGENTS.md §4`, `.github/skills/behavior-deep-think/SKILL.md`, `.github/skills/behavior-dt-council/SKILL.md`, `.github/configs/deep_think.yaml`, `.github/configs/dt_council.yaml`.

### Deep Think (single-agent deep reasoning)

Activates when: difficulty ≥ 0.3, atomizer flags high risk, or user requests deep reasoning.

| Level       | Compute | Hypotheses |
| ----------- | ------- | ---------- |
| DT-Lite     | ~4×     | 2          |
| DT-Standard | ~8×     | 2          |
| DT-Deep     | ~15-20× | 3          |

**Cost gate**: DT-Standard or higher requires user confirmation.

### DT-Council (multi-perspective + depth)

Activates when: multi-perspective analysis needed, d ≥ 0.3, or keywords "dt council" / "deep council".

Levels: Enhanced-Light (~3-4×), Enhanced-Full (~6-8×), Enhanced-Full+ (~10-14×), Enhanced-Debate (~14-18×).

**Codex adaptation**: use `spawn_agent` for parallel council participants and `wait_agent` for synchronization; synthesize results in the coordinator agent. `behavior-model-council` is **deprecated** — use `behavior-dt-council` for all council tasks.

---

## §13. Dispatch Telemetry

Source: `.github/configs/agent_policy.yaml → shadow_dispatch_logging`, `dispatch_telemetry_tiers`.

Three tiers of dispatch logging:

| Tier         | Scope                                                                         | Tags                                      |
| ------------ | ----------------------------------------------------------------------------- | ----------------------------------------- |
| L0 (shadow)  | Every dispatch — task domain, agent, outcome, quality score                   | `dispatch-log`, `shadow-routing`          |
| L1 (failure) | On failure, escalation, or retry ≥ 2 — adds error context, fallback chain     | `dispatch-log`, `failure-trace`           |
| L2 (distill) | Periodic reflective analysis — routing patterns, failure clusters, skill gaps | `dispatch-lesson`, `template-improvement` |

All tiers store via `memory_store`. Phase 1 (current): shadow logging only, no routing changes.

**Codex adaptation**: same `memory_store` calls with identical tags. No tool naming difference.

---

## §14. Memory Hygiene

Source: `copilot-instructions.md §4 → Memory Hygiene`.

Run cleanup at workflow start (not every session):

| Target          | Criterion                              | Action                  |
| --------------- | -------------------------------------- | ----------------------- |
| Old checkpoints | Age > 7 days AND completed             | `memory_delete`         |
| Duplicates      | Similarity > 0.9 (lessons > 0.85)      | Merge → keep newest     |
| Orphans         | No `work-log` or `lesson-*` references | Review → archive/delete |

**Anti-pattern**: never accumulate 400+ records without cleanup.

> **Known bug**: `memory_delete(tags=...)` is non-functional. Workaround: `memory_list(tags=[...])` → get `content_hash` → `memory_delete(content_hash=hash)`.

### Shared Memory Reuse

No separate Copilot-to-Codex bridge configuration is required.
Both runtimes read and write the same Memory MCP backend, so cross-runtime reuse should happen through the normal tag set:

- `work-log` for prior task history
- `research` for collected information worth reusing
- `implementation-status` for reusable verification/state snapshots
- `architecture-decision` for durable decisions

On Codex session start, inspect recent `work-log` entries first, then look for durable knowledge under the relevant standard tags before doing fresh search or re-analysis.

### Redo Detection

| Signal                | Threshold             | Action                     |
| --------------------- | --------------------- | -------------------------- |
| Same tag combo stored | 3×                    | Warning → review           |
| Same search query     | 2× (similarity > 0.8) | Block → reuse prior result |
| Same SLURM config     | 3×                    | Escalate → systemic issue  |

---

## §15. Metacognitive Checks

Source: `.github/instructions/metacognitive.instructions.md`.

Apply after producing any non-trivial output:

1. **Error Recovery** (mandatory): re-read own output before returning. Fix errors immediately — don't flag them. Zero issues found in complex output = look harder.
2. **Self-Challenge** (conditional — non-trivial logic, external claims, multi-step reasoning): ask one targeted question ("What input would break this?" / "What assumption invalidates this?").
3. **Uncertainty Recognition**: mark unverified assumptions as `[UNVERIFIED: reason]`. Verify with tools rather than memory. Escalate low-confidence decisions.

**Codex adaptation**: no tool difference; these are reasoning discipline checks independent of runtime.

---

## §16. Progressive Escalation / 3-Strike Rule

Source: `copilot-instructions.md §1 rule 11`, `AGENTS.md → Quality Guardrails`.

After 3 consecutive failures on the same subtask:

1. **Re-decompose** via `behavior-atomizer` — break into smaller sub-problems.
2. **Consider alternatives** — different model tier, different approach.
3. **Escalate to user** — present accumulated evidence + options.

Additional guardrails:

| Guardrail                | Trigger                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| Agent Diversity Guard    | Single agent > 30% of delegations → warning                         |
| Circular Delegation      | Same domain dispatched 3× without progress → halt                   |
| Verification Before Done | Never mark complete without proof (tests, logs, diff)               |
| Pre-Registered KPI       | Primary KPI set before execution; change post-execution = violation |

KPI task types and enforcement: `.github/configs/agent_policy.yaml → verification_kpi`.

---

## §17. Research Dedup Protocol

Source: `copilot-instructions.md §1 rule 12`.

Before any external search (`tavily_search`, `mcp_context7_*`, `arxiv_*`):

1. `memory_search(query=..., limit=5)` for prior results.
2. If similarity > 0.7 exists → **reuse** cached result.
3. If no match → proceed with search → `memory_store` the result for future dedup.

Web search fallback chain: `tavily_search` → retry 1× → `tavily_extract` → `mcp_context7_*` → ask user.

---

## §18. Sync Maintenance

When source files change:

1. Update this adapter to reflect new protocols.
2. Keep reference-first — avoid copying long rule blocks.
3. Update "Last sync target" dates at top of file.
4. Run `bash .codex/verify_alignment.sh` to validate integrity.
