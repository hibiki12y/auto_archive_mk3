# Glossary — templestay (한/영)

A bilingual quick reference for recurring templestay terminology. This page
points into the authoritative protocol documents. Where a term has a canonical
SSoT, that SSoT is cited and wins on any conflict.

## Orchestration roles

- **Parent orchestrator** — 오케스트레이터
  Top-level Claude Code thread. Atomizes, plans, dispatches leaves, synthesizes evidence, and reports. Does not implement except for one-shot reads and verbatim single-line edits.
  SSoT: [`../claude/templestay/CLAUDE.md`](../claude/templestay/CLAUDE.md) §Default Operating Posture.

- **Leaf subagent** — 리프 서브에이전트
  Spawned for a bounded, scope-locked task. Does not persist memory or report directly to the user.
  SSoT: [`../claude/templestay/CLAUDE.md`](../claude/templestay/CLAUDE.md) §Subagent map.

- **templestay-* agent family** — templestay 에이전트 패밀리
  Nine leaves: `templestay-explorer` (탐색), `templestay-reader` (리더),
  `templestay-coder` (코더, Tier 3/Sonnet), `templestay-codex-coder`
  (코덱스 코더, Tier 1/2), `templestay-verifier` (검증; Codex side adds a
  Claude Opus 4.7 read-only hetero Critique),
  `templestay-challenge` (챌린지), `templestay-writer` (문서 작성),
  `templestay-researcher` (리서처),
  `templestay-gemini-consultant` (제미나이 자문, CRLN only).
  SSoT: [`../claude/templestay/CLAUDE.md`](../claude/templestay/CLAUDE.md) §Subagent map.

- **Memory MCP** — 메모리 MCP
  `memory-v2` MCP server. Schema `memory-v2.5`, service `templestay`. Durable cross-platform task anchors and checkpoints. Only the parent orchestrator calls `memory_save` / `memory_session_save`.
  SSoT: [`../docs/mcp.md`](mcp.md) §Root-native server set.

- **Codex gateway** — 코덱스 게이트웨이
  Leaf-proxy wrapping Codex CLI. Exposes `codex_prompt` (advisory) and
  `codex_apply` (sole write path).
  SSoT: [`../docs/mcp.md`](mcp.md) §Root-native server set.

- **Gemini gateway** — 제미나이 게이트웨이
  MCP server exposing Gemini for DT Audit leaves and CRLN consultation.
  No `gemini_apply` write path.
  SSoT: [`../docs/mcp.md`](mcp.md) §Root-native server set.

## DT Audit phases

11-phase pipeline for DT Audit Ultra-Team v3.1 only. Default-disabled;
eligibility gate passage and explicit user cost acceptance required.
SSoT: [`../specs/dt-audit-ultra-team-v3-1.md`](../specs/dt-audit-ultra-team-v3-1.md) §Phase Contract.

- **Phase 0 — Context Freeze & Hypothesis Lock** — 페이즈 0, 컨텍스트 동결/가설 고정
  Freeze artifacts, lock hypothesis, record eligibility trigger, assign axis leaders.
- **Phase 1 — Isolated Axis Analysis** — 페이즈 1, 축 격리 병렬 분석
  Three teams (Grounding / Challenge / Execution) run in parallel; no inter-team communication.
- **Phase 1.5 — Ledger Normalisation** — 페이즈 1.5, 레저 정규화
  Parent normalises three axis ledgers into a unified claim inventory.
- **Phase 1.75 — Evidence / Citation Gate** — 페이즈 1.75, 증거/인용 게이트
  Deterministic grounding check; un-evidenced claims capped at confidence ≤ 0.55.
- **Phase 2 — Cross-Enrichment** — 페이즈 2, 교차 보강
  Axis leaders add cross-perspective evidence; no cross-team critique.
- **Phase 2.5 — External Feedback** — 페이즈 2.5, 외부 피드백
  Fail-closed: halt and escalate if external feedback is unavailable for any core claim.
- **Phase 3 — Evidence-Weighted Synthesis** — 페이즈 3, 증거 가중 합성
  Synthesizer produces tiered claim ledger; cross-model agreement ≠ external evidence.
- **Phase 3.25 — Independent Verification** — 페이즈 3.25, 독립 검증
  Different-vendor model checks ledger consistency and citation integrity.
- **Phase 3.5 — Disagreement Deep Dive** — 페이즈 3.5, 불일치 심층 조사
  Targeted investigation of disagreements surfaced in Phase 3.25.
- **Phase 4 — Adversarial Stress Test** — 페이즈 4, 적대적 스트레스 테스트
  Google-family stress tester challenges synthesised findings for blind spots.
- **Phase 5 — Lesson Extraction** — 페이즈 5, 교훈 추출
  MARS-style lessons written to durable memory by the parent orchestrator only.

## DT Audit topology

- **Grounding axis** — 그라운딩 축 · **Challenge axis** — 챌린지 축 · **Execution axis** — 이그제큐션 축
  Three parallel Phase 1 teams. Grounding: evidence and artifact mapping.
  Challenge: falsification and failure-mode discovery. Execution: verification
  and reproducibility. Each: one Opus 4.7-max axis leader + three leaves.

- **Axis leader** — 액시스 리더
  One Opus 4.7-max leaf that sequences a single axis team; isolated from other axis leaders during Phase 1.

- **Verifier** — 검증자
  `dt-audit-verifier`; Phase 3.25 independent ledger check.
  Vendor identity contract: OpenAI-family preferred.

- **Stress tester** — 스트레스 테스터
  `dt-audit-stress-tester`; Phase 4 adversarial review.
  Vendor identity contract: Google-family preferred (via `gemini-gateway`).

- **Synthesizer** — 신디사이저
  `dt-audit-synthesizer`; Phase 3 evidence-weighted claim ledger. Cross-model agreement may not be treated as external evidence.

## Code authoring tiers

The parent orchestrator does not call `Edit`, `MultiEdit`, or `Write` outside
a verbatim single-line nudge named in the same turn.
SSoT: [`../claude/templestay/skills/templestay-codex-delegation/SKILL.md`](../claude/templestay/skills/templestay-codex-delegation/SKILL.md).

- **Tier 1** — 티어 1 (아키텍처/정확성 중심)
  Architecture, multi-domain, correctness-critical, or user-flagged hard. Route to `templestay-codex-coder` in Architect/Editor pattern; hard cap N=2.

- **Tier 2** — 티어 2 (다중 파일 또는 대규모 수정)
  Multi-file or >80 LOC, new symbols or tests. Route to `templestay-codex-coder`.

- **Tier 3** — 티어 3 (단일 파일 소규모 수정)
  Single file, ≤30 LOC, doc/comment/log/lint/format, no new symbols, no tests.
  Route to `templestay-coder` (Sonnet).

- **`codex_prompt` vs `codex_apply`** — 자문 vs 적용
  `codex_prompt`: read-only advisory; no file writes. `codex_apply`: sole write path; runs in a detached git worktree, validates diff, applies under repo lock.

- **Architect/Editor pattern** — 아키텍트/에디터 패턴
  Tier 1: Codex produces a full design (Architect pass) then targeted edits (Editor pass).

- **Bounded executable-signal refinement (N=2)** — 경계 있는 실행 신호 정제 (N=2)
  After each Codex write, run the test signal and feed results back. Hard cap: 2 iterations.

## CRLN (Capability-Routed Lens Network)

One-shot read-only Gemini consultation at PLAN time under an explicit
capability trigger. Not a council; no voting.
SSoT: [`../specs/codex-gemini-capability-routed-consultation.md`](../specs/codex-gemini-capability-routed-consultation.md).

- **Capability flags** — 능력 플래그
  Four triggers: long-context (>200K tokens), abstract reasoning
  (ARC-AGI-2-style), multimodal input, MCP tool coordination.

- **`templestay-gemini-consultant`** — 제미나이 자문 에이전트
  CRLN leaf. Returns evidence to the parent; never spawns subagents, never grades Codex output, never re-entered recursively.

- **Evidence-only return rule** — 증거 전용 반환 규칙
  Consultant returns structured evidence; parent synthesizes it. No LLM-vs-LLM grading in either direction.

- **"Never inside Tier 1 loop" boundary** — 티어 1 루프 외부 전용
  CRLN fires once at PLAN time. Forbidden inside the Tier 1 refinement loop.

## MCP servers (templestay)

SSoT: [`../docs/mcp.md`](mcp.md).

| Server | 한글 | Role |
|---|---|---|
| `codex-gateway` | 코덱스 게이트웨이 MCP | Codex CLI bridge; `codex_prompt` (advisory) + `codex_apply` (sole write path) |
| `claude-gateway` | 클로드 게이트웨이 MCP | Claude Code read-only bridge for Codex consultation; `claude_prompt` + `claude_preflight`; no apply path |
| `gemini-gateway` | 제미나이 게이트웨이 MCP | Gemini access for DT Audit leaves and CRLN; no write path |
| `memory-v2` | 메모리 MCP | Durable anchors and checkpoints; schema `memory-v2.5`, service `templestay` |
| `context-manager` | 컨텍스트 매니저 MCP | Session-scoped store for bulky transient artifacts; not for secrets |
| `document-parser` | 문서 파서 MCP | Read-only PDF/Excel/CSV/DOCX/PPTX extraction; macros never executed |

## Control & safety terms

- **SSoT (Single Source of Truth)** — 단일 진실 공급원
  The authoritative definition for a given value, rule, or structure. Derived prose must follow the SSoT when it changes.

- **Eligibility gate** — 적격성 게이트
  PLAN-time check before any DT Audit leaf is dispatched. Gate failure routes to CRLN, deep-think, or single-model + test execution.
  SSoT: [`../specs/dt-audit-ultra-team-v3-1.md`](../specs/dt-audit-ultra-team-v3-1.md) §Eligibility Gate.

- **Manual-invocation only** — 수동 호출 전용
  DT Audit Ultra-Team v3.1 is default-disabled. Auto-escalation from
  deep-think or CRLN output to DT Audit is explicitly forbidden.

- **Fail-closed** — 페일-클로즈드
  Phase 2.5: pipeline halts and escalates if external feedback is unavailable
  for any core claim.

- **Vendor diversity** — 벤더 다양성
  DT Audit axes use OpenAI-family, Anthropic-family, and Google-family leaves.
  Vendor identity contracts: Verifier is OpenAI-family; Stress tester is
  Google-family.

- **Bounded helper recursion** — 경계 있는 헬퍼 재귀
  The DT Audit subagent tree is scope-locked; no layer invokes DT Audit
  recursively. Hard cap: `depth_cap: 4`.

- **Read-only consultation** — 읽기 전용 자문
  `codex_prompt` and `templestay-gemini-consultant` return evidence only. No
  writes, no artifact mutation, no downstream delegation.

## Cross-references

- Native kernel and lifecycle: [`templestay-native-kernel.md`](templestay-native-kernel.md)
- Orchestration and delegation rules: [`../claude/templestay/CLAUDE.md`](../claude/templestay/CLAUDE.md)
- Spec index: [`../specs/_index.md`](../specs/_index.md)
- MCP capability guide: [`../docs/mcp.md`](mcp.md)
- Shared techniques: [`../docs/shared-techniques.md`](shared-techniques.md)
