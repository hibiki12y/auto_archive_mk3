# templestay Native Kernel

`templestay` is the native Codex CLI / Claude Code successor surface that
inherited the durable techniques from the original `templerun` project
(`resource/templerun` reference submodule, since removed from the tree)
without migrating Copilot runtime protocol. The public deployment id is
`templestay` on every new native surface.

## State Machine

All native surfaces use this request lifecycle:

```text
Input → Atomize → Plan → Execute → Verify → Critique → Report
```

When same-family `Verify` finds an in-scope actionable failure that can be fixed
inside the current plan, use the focused repair edge:

```text
Verify → Execute
```

When hetero-model `Critique` finds an in-scope actionable failure, use the
re-slicing repair edge:

```text
Critique → Atomize → Plan
```

- **Input**: capture the user request, cwd, applicable instructions, constraints,
  acceptance checks, exclusions, safety boundaries, `loop_index=0`, and an
  explicit stop condition. Leave `max_loop_budget` pending.
- **Atomize**: break the request into complete, non-overlapping work units,
  assess risk and ambiguity, and choose `max_loop_budget` from `1`, `3`, `5`,
  or `10` passes.
- **Plan**: produce an executable plan whose remaining decisions are explicit
  assumptions rather than hidden choices.
- **Execute**: make the smallest platform-appropriate change or action.
- **Verify**: run deterministic checks and same GPT-family semantic review; do
  not use hetero-model judgment as the Verify result. If an in-scope actionable
  failure has a concrete repair target and the current plan remains valid,
  return to `Execute`.
- **Critique**: run the hetero-model double-check after Verify, record blocking
  risks, and decide whether to report or re-enter Atomize.
- **Report**: close the current request with changes, verification, Critique,
  persistence, and residual risk.

The loop is intentionally bounded:

```text
Input(capture anchor; loop_index=0; max_loop_budget=pending)
Atomize(initial_interpretation; max_loop_budget = choose(1, 3, 5, 10))
while loop_index < max_loop_budget:
    Plan → Execute → Verify(same_gpt_family)
    if Verify finds an in-scope actionable failure within the current Plan:
        Verify(failed_check, evidence, execute_repair_target, updated_assumption)
        loop_index += 1
        if loop_index < max_loop_budget:
            Verify → Execute(repair_target) → Verify(same_gpt_family)
            continue  # re-run Verify after the focused Execute fix
        Verify → Report(FAIL loop-budget-exhausted)
        stop
    Verify → Critique(hetero_model)
    if acceptance checks pass and Critique finds no blocking issue:
        Critique → Report(PASS)
        stop
    if failed_check is in scope and actionable:
        Critique(failed_check, evidence, repair_target, updated_assumption)
        loop_index += 1
        if loop_index < max_loop_budget:
            Atomize(repair_context)
            continue from Plan
        Critique → Report(FAIL loop-budget-exhausted)
        stop
    Critique → Report(WARN or FAIL)
    stop
Critique → Report(FAIL loop-budget-exhausted)
```

Loop budget counts the initial pass plus any Verify or Critique repair passes;
for example, a budget of `3` means one initial attempt and up to two repair
passes before `loop-budget-exhausted`. The `Verify → Execute(repair_target) →
Verify` line is an in-place repair leg inside the current plan; it does not
restart problem interpretation.

`Verify` failures return to `Execute` only when the current plan is still
solvable and the failure is in scope, actionable, and has a concrete
`execute_repair_target`. The parent state machine owns that branching decision:
verifier leaves may return the repair record, but they do not mutate or decide
scope expansion. If the failure invalidates the plan, changes the decomposition,
requires new scope, or lacks an actionable repair target, do not patch ad hoc;
carry the Verify ledger into `Critique` or report `FAIL` when the blocker is
already decisive. If the hetero Critique route itself is degraded, report
`WARN` when same-family Verify passed and residual risk is acceptable; report
`FAIL` when Verify found an unresolved in-scope blocker.

The initial Atomize pass strengthens problem interpretation before any plan is
final: restate the requested outcome, acceptance checks, constraints,
exclusions, safety boundary, and material ambiguities. Ask concise clarifying
questions only when a reasonable assumption would be unsafe or likely wrong;
otherwise proceed with explicit assumptions. A recursive Atomize reached through
`Critique` does not reopen the full problem. It uses the Critique record to
re-slice around the failed check, repair target, updated assumption, and next
acceptance check while preserving the existing loop budget unless the user
explicitly changes scope. A `Verify → Execute` repair is narrower: it stays
inside the current plan and repeats the relevant Verify acceptance check after
the focused execution fix.

Transition table:

| Transition | Condition | Required state |
|---|---|---|
| `Input → Atomize` | Task anchor is captured | Request, scope, constraints, acceptance checks, exclusions, safety boundary, verification expectations, `loop_index=0`, pending `max_loop_budget`, `stop_condition` |
| `Atomize → Plan` | Work is decomposed and loop budget is selected | Initial problem interpretation or recursive repair context, plus `max_loop_budget` chosen during Atomize |
| `Plan → Execute` | Plan is solvable, complete, and non-redundant | Explicit assumptions and executable work units |
| `Execute → Verify` | Work unit is complete or ready for inspection | Changed artifact or read-only result plus expected same GPT-family checks |
| `Verify → Critique` | Same GPT-family verification evidence is ready | Verification ledger, deterministic sensor results, and unresolved risks |
| `Verify → Execute` | Verify found an in-scope actionable failure inside the current plan | Verify repair record with `execute_repair_target`, updated assumption, and next acceptance check |
| `Critique → Report(PASS)` | Acceptance checks pass and Critique finds no blocking issue | Verification and Critique evidence |
| `Critique → Atomize` | Failed check is in scope and actionable | Critique record with repair target and updated assumption |
| `Critique → Report(WARN)` | Evidence is degraded, live proof is skipped, blocked work is out of scope, or an external dependency cannot be proven | Residual risk and degradation label |
| `Critique → Report(FAIL)` | An unresolved in-scope blocker remains or the repair budget is exhausted | Failed check and blocker evidence |

Verify repair records must include `failed_check`, `evidence`,
`execute_repair_target`, `updated_assumption`, and the next acceptance check to
re-run. Critique records must include `failed_check`, `evidence`,
`in_scope_repair_target`, `updated_assumption`, and the next acceptance check to
re-run. Termination is explicit: `PASS` for satisfied acceptance checks plus no
blocking Critique issue, `WARN` for useful results with degraded or skipped
evidence, `FAIL` for unresolved in-scope blockers, and
`FAIL loop-budget-exhausted` when no repair budget remains.

Do not short-circuit from `Critique` directly back to `Execute` and do not use
`Critique → Execute`: an in-scope Critique finding must return through
`Atomize → Plan` so the repair target, assumption update, and next acceptance
check are explicit. `Verify → Execute` is reserved for current-plan repairs
only. Critique remains a read-only hetero-model evidence lane; it does not write
patches, invoke Execute, or replace the same-family Verify result. If the
configured hetero Critique model is unavailable, do not silently substitute the
same GPT-family verifier; use an explicitly authorized hetero successor or
report the Critique lane as degraded.

Example edge contrast: a failed parser, stale generated file, or focused unit
test that names the exact artifact to fix can use `Verify → Execute` and then
rerun Verify. A Critique finding such as "the scope decomposition is wrong" or
"the acceptance check is missing" must use `Critique → Atomize → Plan`, because
it changes the plan rather than merely repairing the current execution.

`Report` is terminal for the current request. Do not add Copilot-style `AWAIT`,
approval gates, completion menus, or `.agent.md` dispatch semantics to native
Codex or Claude surfaces.

## Platform Boundary

The original `templerun` was a reference library for techniques, MCP servers,
and verification vocabulary. The `resource/templerun` submodule has since
been removed from the tree; what was portable was rewritten for native
templestay surfaces and what was Copilot-tied was intentionally dropped.
New Codex and Claude instructions must be authored for their own loading,
settings, plugin, skill, subagent, permission, and hook models.

Portable content shared by both native surfaces lives under
`shared/templestay/`. `scripts/materialize_shared_resources.py` renders the
shared instruction kernel and common skill templates into `claude/templestay/`
and `codex/templestay/`; platform wrappers remain native and are not symlinks to
the other platform.

Forbidden migrations into native surfaces:

- Copilot `ask_user` approval-gate lifecycle.
- Copilot `AWAIT` / `FINAL` session reuse semantics.
- Copilot `.agent.md` dispatch assumptions.
- DT-Council/model-council mediator chains or vote/consensus claims.
- Hook parity claims with Copilot.

## Memory and State

Use a compact task anchor whenever a task may loop or exceed one simple pass:

- `project_key`
- `deployment_id: templestay`
- `request_hash`
- `phase`, `loop_index`, `max_loop_budget` (pending until Atomize chooses it),
  `stop_condition`
- source-faithful request summary
- constraints, acceptance checks, exclusions, and verification expectations
- current blocker when returning through `Verify → Execute` or `Critique`

When a `memory` MCP server is available, use it for cross-platform durable
progress. Built-in Codex or Claude memories are helpful local context but are
not the shared source of truth.

The shared templestay memory profile is memory-v2.5: it prefers
`TEMPLATESTAY_MEMORY_ROOT` / `MEMORY_V2_ROOT`, detects Codex/Claude/Copilot
session ids, and writes `memory_schema_version` plus `platform` metadata so a
future memory-v3 backend can migrate without guessing provenance.

## Verification Vocabulary

Use compact status tokens consistently:

- `PASS`: planned checks passed or a read-only answer is sufficiently grounded.
- `WARN`: useful work completed with a skipped check, degraded tool, or residual
  risk that the user should know.
- `FAIL`: the requested outcome is not complete or verification found an
  unresolved in-scope blocker.

All-passing verification should be a short digest unless the user requests an
audit trail or a check was skipped, warned, failed, or performed a live mutation.

## Spec and Output Standards

Use `specs/_index.md` as the root-native spec navigation surface and
`specs/_templates/` for reusable lightweight, full, plan, and report templates.
The templates preserved templerun's useful traceability and evidence-contract
discipline while remaining native to Codex and Claude.

Visible output artifacts are compact and non-interactive:

- `[PLAN]`: decision-complete plan when the user or task risk needs a visible
  plan artifact.
- `[REPORT]`: completion summary for the current request.
- `[VERIFY]`: standalone verification summary.
- `[RISK]`: risk-focused note when residual risk is the dominant outcome.

Prefer `* Summary:`, `* Implementation:`, `* Verification:`, and
`* Remaining Risk:` as section headings. Use `PASS`, `WARN`, and `FAIL` for
evidence outcomes. ANSI styling may improve readability but must not carry
meaning that disappears in plain text.

## Hook Policy

Hooks are optional hardening only. Native correctness must not depend on hooks.
Use settings, permissions, MCP policy, explicit state artifacts, and verification
checks as the primary controls.

Recommended v1 hook stance:

- `minimal`: hooks off.
- `balanced`: no hooks or deny-only hooks for obvious secrets/destructive shell.
- `deep` / `hardened`: optional warn/deny telemetry for destructive shell,
  sensitive file access, external mutation, and MCP writes.

If hooks are unavailable or disabled, the state machine and reporting contract
remain unchanged.
