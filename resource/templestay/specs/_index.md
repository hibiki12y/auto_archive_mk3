# templestay Specs Index

This index is the root-native navigation surface for current `templestay` specs.
`resource/templerun` remains a legacy reference only; do not treat legacy specs
as runtime authority for Codex or Claude.

## Current root-native specs

| Spec | Status | Role |
|---|---|---|
| [`templestay-memory-v2-platform-v3-prep.md`](templestay-memory-v2-platform-v3-prep.md) | implemented | Memory-v2.5 platform-neutral root/session/schema layer and memory-v3 preparation |
| [`codex-as-claude-subagent.md`](codex-as-claude-subagent.md) | implemented + reverse-read-only extension | Codex CLI as a leaf Claude subagent via codex-gateway, plus Codex → Claude read-only consultation via claude-gateway |
| [`codex-gemini-capability-routed-consultation.md`](codex-gemini-capability-routed-consultation.md) | proposed | Capability-routed Gemini consultation via gemini-gateway, read-only evidence input at PLAN time, no council semantics |
| [`dt-audit-ultra-team-v3-1.md`](dt-audit-ultra-team-v3-1.md) | ready (manual-invocation only, validated 2026-04-30) | Accuracy-first multi-axis audit pipeline for high-stakes work; eligibility-gated; no voting; external-evidence-required for verified findings; fail-closed |

## Standard templates

| Template | Use |
|---|---|
| [`_templates/lightweight.md`](_templates/lightweight.md) | L2 single-file root-native changes |
| [`_templates/full.md`](_templates/full.md) | L3+ architecture, migration, integration, or multi-surface changes |
| [`_templates/plan.md`](_templates/plan.md) | Decision-complete implementation plans |
| [`_templates/report.md`](_templates/report.md) | Completion reports and verification summaries |
| [`_standard.md`](_standard.md) | Spec authoring standard — level/status/type taxonomy, required sections, acceptance/verification patterns |

## Supporting root references

| Reference | Role |
|---|---|
| [`../docs/templestay-native-kernel.md`](../docs/templestay-native-kernel.md) | Native lifecycle, platform boundary, memory, verification, hook policy |
| [`../docs/shared-techniques.md`](../docs/shared-techniques.md) | Portable intent register for Codex and Claude |
| [`../docs/mcp.md`](../docs/mcp.md) | Root-native MCP and memory policy |

## Legacy reference map

The original `resource/templerun` reference submodule has been removed from
the tree. The table below records what was carried forward by intent and what
was intentionally rejected as runtime authority. New legacy imports (if any
arise) must follow the same migration discipline — *reference only*, never
*runtime authority*.

| Former resource/templerun path | Carried forward by intent | Rejected as runtime authority |
|---|---|---|
| `specs/_templates/` | Spec tiering, acceptance checks, plan/report artifact idea (rewritten under `specs/_templates/`) | Copilot approval/checkpoint wording |
| `specs/_index.md` | Current/supporting/superseded navigation pattern (this file) | Legacy ownership claims |
| `docs/shared-techniques.md` | Portable technique register pattern (rewritten under `docs/shared-techniques.md`) | Codex/Copilot mirroring mechanics |
| `shared/skills/verification/SKILL.md` | Deterministic checks first, readiness split, digest discipline (rewritten under `claude/templestay/skills/templestay-verification/`) | Copilot packaging ownership |
| `copilot/mcp-servers/codex-gateway/server.py` | Detached-worktree Codex apply bridge (slim port at `mcp-servers/codex-gateway/`) | Multi-vendor council, RULERS, Ultra-Team, dissent protocols |
| `codex/templerun-codex/` | Compact Codex output vocabulary and task-anchor ideas (folded into `codex/templestay/`) | `templerun-codex` package identity |

## Root-native output standard

Visible plans and reports use compact native headings: `[PLAN]`, `[REPORT]`,
`[VERIFY]`, and `[RISK]`; medium headings use `* Summary:`,
`* Implementation:`, `* Verification:`, and `* Remaining Risk:`. Evidence uses
`PASS`, `WARN`, and `FAIL`. ANSI styling is optional and must never carry the
only meaning.
