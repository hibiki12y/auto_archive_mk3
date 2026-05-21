---
status: current
authority: implementation-plan
last_verified: 2026-05-05
source_paths:
  - PROJECT.md
  - README.md
  - specs/CLARIFICATIONS/multi-provider-scope.md
  - specs/ARCHIVE/midpoint-checkpoint-2026-05-05.md
  - specs/ARCHIVE/open-harness-parity-completion-audit-2026-05-05.md
  - specs/CURRENT/research-platform-readiness-and-scope-2026-05-21.md
  - specs/CURRENT/live-proof-matrix.md
  - src/core/plana-claude-runtime-advisor.ts
  - src/runtime/runtime-provider-evidence-report-cli.ts
scope: Implementation plan for reducing Codex parent token pressure by offloading bounded read-only synthesis, critique, and memory-compaction work to Claude while preserving Codex write ownership and live-proof gates.
---

# Claude Token Offload Implementation Plan — 2026-05-05

## 1. 목적

현재 active goal은 open-source harness와 동등한 UX를 갖추면서 연구 특화 framework로
진화하는 것이다. 최근 작업으로 static parity, retained evidence report, completion
checkpoint 문서가 늘어나면서 Codex parent thread가 장문 repo/context를 계속 보유하는
비용이 커졌다. 이 계획은 **토큰 부하를 Claude로 분산**하되, 다음 불변식을 유지한다.

- Codex parent가 repository writer이자 final decision owner다.
- Claude는 read-only consultation / synthesis / Critique / compaction evidence만
  제공한다.
- `.env`, private keys, raw prompts, raw responses, task instructions, secret-bearing
  logs는 Claude prompt나 memory에 보내지 않는다.
- live proof gate는 우회하지 않는다. operator-gated row는 실제 operator-owned
  artifact 없이는 PASS로 승격하지 않는다.

## 2. 현재 기반

이미 존재하는 기반:

- `claude-gateway` preflight + `claude_prompt(tool_mode=disabled)` route.
- `specs/CLARIFICATIONS/multi-provider-scope.md`의 read-only advisor 패턴.
- `src/core/plana-claude-runtime-advisor.ts`의 Claude advisor provenance / fail-open
  관점.
- `runtime:provider:evidence:report`, `plana:advisor:events:report`,
  `live:proof:report` 등 retained evidence replay CLI.
- archived `midpoint-checkpoint-2026-05-05.md`와
  `open-harness-parity-completion-audit-2026-05-05.md`의 historical active-goal/live-proof gate,
  plus the current 2026-05-21 readiness SSoT.

따라서 첫 구현은 새 provider를 만드는 것이 아니라, 이미 허용된 read-only Claude
route를 **언제, 어떤 bundle로, 어떤 결과 shape로, 어떤 memory policy와 함께 쓸지**
고정하는 것이다.

## 3. Offload 대상과 비대상

| Work type | Claude offload 여부 | 이유 / 경계 |
| --- | --- | --- |
| 장문 spec/README/current checkpoint 요약 | Yes | Claude가 read-only synthesis를 맡고 Codex는 요약 검증과 문서 반영만 수행한다. |
| live-proof matrix row triage | Yes | Claude가 missing/weak evidence map을 제안할 수 있으나 PASS 승격은 CLI/manifest 검증만 허용한다. |
| implementation plan critique | Yes | Claude가 failure-mode와 누락 gate를 지적한다. Codex가 반영한다. |
| memory compaction draft | Yes | Claude가 압축 후보를 제안할 수 있으나 memory write는 Codex가 secret-screen 후 수행한다. |
| code edits / tests 작성 | No | Codex가 writer다. Claude는 patch author가 아니다. |
| final completion decision | No | Completion audit은 Codex + deterministic artifacts가 판단한다. Claude response는 evidence lens일 뿐이다. |
| live service proof 생성 | No | Discord/GitLab/provider/Peekaboo/SLURM/OTLP proof는 operator-owned artifact가 필요하다. |

## 4. 구현 deliverables

### D1. `ClaudeOffloadBundle` contract

새 narrow contract를 추가한다. 제안 경로:

- `src/contracts/claude-token-offload.ts`

예상 shape:

```ts
export interface ClaudeOffloadBundle {
  readonly schemaVersion: 1;
  readonly purpose:
    | 'checkpoint-synthesis'
    | 'live-proof-triage'
    | 'implementation-plan-critique'
    | 'memory-compaction-draft';
  readonly sourceRefs: readonly string[];
  readonly acceptanceChecks: readonly string[];
  readonly redactionBoundary: {
    readonly excludesSecrets: true;
    readonly excludesRawPrompts: true;
    readonly excludesRawResponses: true;
    readonly excludesRawInstructions: true;
  };
  readonly content: string;
}
```

Acceptance:

- Bundle cannot be constructed unless boundary booleans are all safe.
- Source refs must be paths/anchors only; no raw secret-bearing env/log content.
- Use a positive allowlist for retained bundle fields (`schemaVersion`, `purpose`,
  `sourceRefs`, `acceptanceChecks`, `redactionBoundary`, `content`) before applying
  banned-key detection. The invariant must be structural, not only a negative
  denylist.
- Unit tests reject banned field names: `rawPrompt`, `rawResponse`, `rawInstruction`,
  `token`, `apiKey`, `credential`, `secret`.

### D2. `buildClaudeOffloadPrompt()` helper

제안 경로:

- `src/core/claude-token-offload.ts`

Responsibilities:

1. Accept a `ClaudeOffloadBundle`.
2. Prefix the prompt with read-only/no-tools/no-vote/no-write instructions.
3. Require result sections: `status`, `findings`, `blockingGaps`, `memoryCandidates`,
   `residualRisk`.
4. Add explicit rule: “Do not mark live proof rows complete from static evidence.”
5. Produce deterministic string output for snapshot tests.

Acceptance:

- Snapshot/unit tests pin prompt headers and forbidden-action clauses.
- Prompt builder is pure and does not call Claude, read files, or mutate memory.

### D3. `ClaudeOffloadResult` normalization

제안 경로:

- `src/core/claude-token-offload-result.ts`

Responsibilities:

- Normalize gateway metadata into a small in-process record:
  - `routeStatus`, `model`, `latencyMs`, `tokenUsage`, `costUsd`, `errorCategory`,
    `degradedReason`.
- Preserve structured degradation categories from `claude_prompt`.
- Mark incomplete/non-JSON response as `WARN tool-degraded`, not FAIL by default.

Acceptance:

- Tests cover success, quota/auth/model error, timeout, partial response, and
  tool-use-request degradation.
- Result normalization never stores raw prompt/response in retained ledgers by default.

### D4. Offload ledger / checkpoint integration

Do **not** create a broad raw transcript ledger. Reuse metadata-only patterns from
Plana advisor and retained evidence CLIs.

Suggested path:

- `src/core/claude-token-offload-ledger.ts`
- Optional CLI later: `scripts/claude-token-offload-report.mjs`

Retained record fields:

- `schemaVersion`, `recordId`, `purpose`, `sourceRefCount`, `status`,
  `blockingGapCount`, `memoryCandidateCount`, `model`, `latencyMs`, `createdAt`,
  `provenance: 'claude-token-offload'`, `decisionRole: 'advisory-only'`.

Forbidden retained fields:

- raw prompt text, raw response text, task instruction, Discord content, `.env`
  values, credentials, private artifact contents.

Acceptance:

- JSONL replay scorecard rejects unsafe raw keys and excessive nesting.
- `/doctor` summary, if added, is redacted and read-only.
- Any Claude triage/synthesis result rendered in a ledger, `/doctor`, or report is
  structurally tagged as advisory and must not satisfy a gate by itself.

### D5. Memory compaction protocol

Memory cleanup is procedural first, not deletion-first. The current memory MCP path
supports session memory save, but not guaranteed deletion/prune operations. Therefore
“정리” means creating a **single compact superseding capsule** and instructing future
agents to prefer it over older verbose checkpoints.

Protocol:

1. Gather only durable session facts:
   - latest checkpoint docs,
   - current goal status,
   - static verification state,
   - remaining live-proof queue,
   - Claude/Gemini Critique degradation state.
2. Drop command logs, long grep output, raw diffs, and repeated PASS lines.
3. Save one session memory with tags:
   `checkpoint,claude-offload,compacted,active-goal`.
4. Include `supersedes` notes naming older verbose checkpoint memories when known.
5. Do not promote project/global memory without explicit user approval.

Acceptance:

- Compact memory is under ~1,500 words.
- It contains no secrets, raw prompts/responses, or private artifact content.
- It identifies goal status as not complete unless final live proof audit passes.
- The capsule body includes a `Supersedes / prefer-over` section so future agents
  can prefer the compact capsule without deleting older memories.

## 5. Routing policy

### 5.1 PLAN-time offload trigger

Use Claude offload when any trigger is true:

- The parent would otherwise paste more than ~200 lines of docs/specs into the
  active context.
- The task is synthesis/checkpoint/audit over many evidence surfaces.
- Memory consolidation would repeat already documented facts.
- The task is a high-risk plan where a read-only failure-mode map is useful.

Do not offload when:

- A focused code/test edit is cheaper locally.
- The necessary evidence is a secret-bearing file or live service credential.
- The task requires mutation or final decision authority.

### 5.2 Verify/Critique interaction

- Deterministic sensors run first for code/doc changes.
- Claude offload during PLAN is not the same as hetero Critique.
- After non-trivial changes, still run the regular Claude Opus Critique through
  `templestay-verification` unless the change is trivial or the route is degraded.
- Gemini remains a stress-check lens when quota/config allows; quota exhaustion is
  reported as WARN runtime-degraded.

## 6. Implementation phases

| Phase | Change | Tests / checks | Stop condition |
| --- | --- | --- | --- |
| P0 | This plan document + compact memory capsule | `git diff --check`, docs index smoke | Plan exists and future agents can follow it without context replay. |
| P1 | Add `ClaudeOffloadBundle` contract and prompt builder | unit tests for redaction/frozen prompt | Safe bundle construction and deterministic prompt output. |
| P2 | Add result normalization and metadata-only ledger | unit tests for success/degraded/unsafe raw keys | Claude output can be retained without raw prompt/response. |
| P3 | Add optional report CLI and `/doctor` summary | CLI tests, doctor tests, byte guard tests | Operators can audit offload usage without contacting Claude. |
| P4 | Integrate into checkpoint/live-proof workflows | focused checkpoint tests + full static suite | Parent can call Claude for synthesis while memory remains compact. |

## 7. Verification plan

For code phases P1-P4:

- Focused tests for new contract/helper/ledger/report files.
- `pnpm typecheck:tests` when test types move.
- `pnpm lint` and `pnpm build`.
- `pnpm vitest run --testTimeout 10000` before completion claims.
- `git diff --check`.
- Claude Opus Critique over secret-screened patch summary.
- Gemini Critique retry when quota is available; otherwise mark runtime-degraded.

For P0 document-only phase:

- `git diff --check`.
- `pnpm vitest run tests/readme-current-slices.spec.ts --testTimeout 10000` after
  specs index update.
- Memory session save with compact capsule.

## 8. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Claude route becomes accidental decision-maker | Every prompt/result says Claude is evidence-only; Codex owns edits and completion. |
| Secret-bearing context transfer | Preflight + explicit bundle boundary + banned-key tests + no `.env` reads. |
| Memory bloat continues | Save one compact superseding capsule per major checkpoint; do not copy raw command logs. |
| Live proof gets over-promoted | Bundle prompt and completion audit forbid static-to-live promotion. |
| Gateway quota/auth degradation | Normalize as WARN runtime/tool-degraded and continue Codex-native fallback. |
| Duplicate advisor/offload concepts | Keep Plana advisor for runtime event review; keep token offload for parent context synthesis and memory compaction. |

## 9. Current P0 memory cleanup action

For this session, create one compact memory capsule that supersedes verbose current
checkpoint memories for active-goal handoff. The capsule should point to:

- `specs/ARCHIVE/midpoint-checkpoint-2026-05-05.md`
- `specs/ARCHIVE/open-harness-parity-completion-audit-2026-05-05.md`
- `specs/CURRENT/research-platform-readiness-and-scope-2026-05-21.md`
- this plan document

It should state:

- static parity work is substantially complete,
- active goal is not complete,
- 16 operator-gated live proof rows remain,
- Claude offload should be used for synthesis/critique/compaction only,
- Codex remains repository writer and final completion auditor.
