# Project Specification Reference

> **Template document** — Project-specific sections are filled during initialization via `behavior-project-kickoff`.
> This file is **read-only** reference. For operational rules, see `AGENTS.md` §1 and `codex.md` §§2-3.

---

## Source of Truth Hierarchy

| Priority | File                            | Purpose                                                  | Owner                 |
| -------- | ------------------------------- | -------------------------------------------------------- | --------------------- |
| 1        | `PROJECT.md`                    | Current status, stage, metadata                          | @orchestrator         |
| 2        | `README.md`, `specs/README.md`, `src/`, `tests/`   | Current branch intent, spec map, and active implementation surfaces | @orchestrator, writer |
| 3        | `IMPLEMENTATION_LOG.md`         | Execution/history chronology                             | @orchestrator         |
| —        | `PROJECT_SPEC.md` (this file)   | Template reference guide                                 | (Read-only)           |

**Conflict resolution**: When files disagree, higher-priority file wins for its domain:

- **Status/stage/metadata** → `PROJECT.md`
- **Current branch implementation orientation and live code surfaces** → `README.md`, `specs/README.md`, `src/`, `tests/`
- **Execution history / prior implementation state** → `IMPLEMENTATION_LOG.md`
- **Historical/reference background** → `IMPLEMENTATION_LOG.md` chronology 와 `specs/CLARIFICATIONS/` 의 비준 흔적

---

## Agent-Specific Usage

| Agent Type          | When to Reference  | What to Extract                                                |
| ------------------- | ------------------ | -------------------------------------------------------------- |
| **@orchestrator**   | Start              | Check initialization status, invoke `behavior-project-kickoff` |
| **@orchestrator**   | Before atomization | Load goals/constraints to inform task decomposition            |
| **Reader agents**   | Before search      | Extract domain/problem to focus research queries               |
| **Reader agents**   | Before planning    | Load timeline/budget constraints                               |
| **Writer agents**   | Before generation  | Load tech stack, architecture decisions                        |
| **Executor agents** | Before diagnosis   | Load known issues, previous fixes                              |
| **Reader agents**   | Before validation  | Load success criteria, metrics                                 |

Pre-work check behavior (TEMPLATE_MODE gate, session resume) is summarized in `AGENTS.md` §1 and `codex.md` §§2-3.

---

## Specification Structure

### Section 1: Project Metadata

**Location**: `PROJECT.md` YAML frontmatter

Status (TEMPLATE_MODE / INITIALIZED / ACTIVE / COMPLETE), domain, stage, team composition.

### Section 2: Current Project Goals & Posture

**Location**: `PROJECT.md` summary/frontmatter, with supporting reference documents under `documents/` as needed.

Primary research question, active posture, and current framing. Historical narrative for background context lives in `IMPLEMENTATION_LOG.md`. Live `PROJECT.md` 는 어떤 경우에도 historical snapshot 으로 대체되지 않습니다.

### Section 3: Dataset & Resources

**Location**: current implementation-facing sources in `README.md`, `src/`, and `tests/`, with supporting historical/reference material under `documents/`

Dataset source/splits, preprocessing requirements, GPU resources, estimated training time.

### Section 4: Implementation Specifications

**Location**: current implementation-facing sources in `README.md`, `src/`, and `tests/`; retained supporting references may remain under `documents/`

Library stack, architecture diagram, integration patterns, known pitfalls, API references.

### Section 5: Execution Plan / History

**Location**: `IMPLEMENTATION_LOG.md` for chronology, plus planning/spec artifacts where applicable

Execution chronology, prior implementation state, and any supporting planning/evaluation references.

---

## Update Protocol

**Who can update**:

| Role                | Authority                                          |
| ------------------- | -------------------------------------------------- |
| @orchestrator       | Full update authority (initialization + execution) |
| Writer + doc-writer | Format and polish only                             |
| All others          | Propose changes via Memory MCP, not direct edits   |

**Procedure**: Load current spec → Identify changes → Update → Verify consistency (via behavior-validator) → Store change log in Memory MCP with tags `["spec-update", "<section>"]`.

---

## Verification Response Standard

All verification agents (behavior-validator, behavior-doc-reviewer, behavior-rubric-verifier, behavior-math-reviewer, behavior-code-quality-reviewer) MUST return responses in this schema:

```json
{
  "verdict": "APPROVED | CONDITIONAL | REJECTED",
  "confidence": 0.0-1.0,
  "issues": [
    {
      "severity": "critical | high | medium | low",
      "category": "completeness | accuracy | consistency | clarity",
      "description": "Human-readable issue description",
      "location": "File path or section reference",
      "suggestion": "How to fix (optional)"
    }
  ],
  "approval_conditions": ["Condition that must be met for approval"],
  "metadata": {
    "verifier": "agent-name",
    "verification_type": "specification | code | documentation",
    "timestamp": "ISO8601"
  }
}
```

---
