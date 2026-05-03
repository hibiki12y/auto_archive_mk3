---
status: draft
level: L3|L4|L5
type: architecture|migration|native-platform|integration|memory
created: YYYY-MM-DD
author: agent-or-user
relates_to: "docs/templestay-native-kernel.md"
---

# Spec: [Feature Name]

## 1. Requirements

### Problem

[What is broken, missing, or suboptimal. Include evidence, user requests, or
observed failures.]

### Goal

[What success looks like, including observable behavior and acceptance checks.]

### Constraints

[What must not change. Name root-native boundaries, compatibility constraints,
and safety limits.]

### Out of Scope

[Explicit exclusions that prevent scope creep.]

## 2. Design

### Behavioral Model

[Describe state transitions, data flow, install flow, MCP interaction, or
platform-specific behavior. Use the templestay native lifecycle rather than
legacy approval or continuation wrappers.]

### Content Ownership Impact

| Surface | Current state | Proposed change | Owner |
|---|---|---|---|
| `path/to/file` | [current] | [change] | [authoritative/reference] |

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| [Risk] | Low/Med/High | Low/Med/High | [Mitigation] |

### Alternatives Considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| [Option] | [pros] | [cons] | Selected/Rejected |

## 3. Work Units

| # | Work unit | Owner | Surfaces | Depends on |
|---|---|---|---|---|
| 1 | [Description] | [coder/writer/verifier] | `path/to/file` | — |
| 2 | Verification | verifier | tests/docs | 1 |

## 4. Decisions

### Decision: [Title]

- Context: [why the decision exists]
- Options: [short list]
- Selected: [choice and reason]
- Revisit trigger: [condition or none]

## Acceptance Criteria

- [ ] Requirements above are implemented or explicitly deferred.
- [ ] Root-native Codex and Claude behavior remains truthful.
- [ ] Verification distinguishes static readiness from live runtime proof where relevant.
- [ ] No duplicate runtime authority is introduced outside the owning surface.
- [ ] No Copilot-only approval, continuation, mediator, or legacy MCP wiring semantics are imported.

## Verification Plan

| Evidence type | Required evidence | Timing |
|---|---|---|
| Computational sensors | [parse/build/tests/dry-run/schema checks] | Before report |
| Inferential review | [verifier/challenge/lens if needed] | After deterministic checks |
| Artifacts | [diff summary, command summary, generated files] | Report |

---
*Template: `specs/_templates/full.md` — for templestay L3+ root-native changes*
