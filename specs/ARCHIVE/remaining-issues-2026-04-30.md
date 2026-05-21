---
status: resolved
authority: implementation-risk-ledger
last_verified: 2026-04-30
source_paths:
  - IMPLEMENTATION_LOG.md
  - README.md
  - .env.example
  - specs/CURRENT/trait-module-submodule-plugin-system.md
  - specs/CONTRACTS/trait-module-versioning.md
  - specs/GUIDES/discord-service-hardening-runbook.md
  - specs/GUIDES/peekaboo-remote-evaluation-mcp.md
  - specs/CLARIFICATIONS/templestay-reference-boundary.md
  - src/core/trait-module-loader.ts
  - src/persona/
  - src/remote/peekaboo-evidence-ledger.ts
  - src/discord/discord-result-renderer.ts
  - src/core/process-subprocess-runner.ts
scope: 2026-04-30 close-out ledger의 후속 해결 상태. 라이브 외부 증거가 필요한 항목은 operator-gated로 분리.
---

# 2026-04-30 Remaining Issues Ledger — Resolved Follow-up

이 문서는 2026-04-30 close-out commit 직전에 기록했던 남은 문제의 후속 처리 상태를
기록한다. repository-local code/docs/tests로 닫을 수 있는 항목은 resolved로 전환했다.
실제 Discord/Peekaboo/model/SLURM 환경이 필요한 항목은 **operator-gated**로 남긴다.
이는 repo-local 실패가 아니라 live evidence artifact로만 증명 가능한 경계다.
operator-gated 항목의 현재 live proof 상태는 `live-proof-matrix.md`에서 별도로
추적하며, 이 문서의 `resolved`는 live-verified를 뜻하지 않는다.

## 1. TraitModule runtime expansion

| ID | 상태 | 해결 내용 | 증거 |
| --- | --- | --- | --- |
| RI-TM-1 | resolved | `traits/**/trait.json` scanner/registry loader, deep manifest validation, `TRAIT.md` existence check, duplicate `id@version` rejection을 추가했다. | `src/core/trait-module-loader.ts`, `tests/core/trait-module-loader.spec.ts` |
| RI-TM-2 | resolved | cron 선언을 persistent scheduler job state로 materialize하는 dry-run/store를 추가하고 retry/retention, delivery target semantics를 고정했다. | `buildTraitSchedulerDryRun`, `JsonFileTraitSchedulerStore`, `tests/core/trait-module-loader.spec.ts` |
| RI-TM-3 | resolved | runtime hook dynamic import boundary를 추가했다. 경로 bounding, trust-boundary opt-in, named export shape, timeout, failure isolation, capability self-request check를 수행한다. | `invokeTraitRuntimeHook`, `tests/core/trait-module-loader.spec.ts` |
| RI-TM-4 | resolved | `TraitModuleId` major와 manifest package version의 공존/중복/마이그레이션 정책을 stable contract로 승격했다. | `specs/CONTRACTS/trait-module-versioning.md`, version helper tests |
| RI-TM-5 | resolved | `forbiddenCapabilityFlags`가 ambient host deny-list가 아니라 module self-request ban-list라는 positive/negative test를 추가했다. | `evaluateTraitModuleCapabilityBoundary`, `tests/core/trait-module-loader.spec.ts` |

## 2. Persona layer

| ID | 상태 | 해결 내용 | 증거 |
| --- | --- | --- | --- |
| RI-PE-1 | resolved + operator-gated-live | opt-in/fail-open 구조를 유지하면서 latency/cost sampling logger를 추가했다. live model 품질·비용은 운영 모델 선택 후 live artifact로 판단한다. | `OpenAIPersonaStyleTransformer` `persona-transform-observed`, `.env.example`, README, tests/persona |
| RI-PE-2 | resolved | structured/terminal/approval/focus/subagent/follow-up 계열을 hard-verbatim event set으로 고정했다. env override나 custom transformer `eventTypes`로도 변환되지 않는다. | `HARD_VERBATIM_PERSONA_EVENT_TYPES`, `isPersonaEventTypeTransformable`, Discord delivery tests |
| RI-PE-3 | resolved-by-contract | prompt는 direct quote 금지 정책과 source-line copy 금지를 명시하고, tests가 해당 policy 문구를 고정한다. future prompt edit은 human review가 필요하다. | `src/persona/arona-plana-duet.ts`, `tests/persona/persona-style-transformer.spec.ts` |

## 3. Peekaboo MCP / live evaluation path

| ID | 상태 | 해결 내용 | 증거 |
| --- | --- | --- | --- |
| RI-PB-1 | resolved-doc-test | project-local Codex helper가 per-invocation MCP injection이며 repo-scoped install이 아님을 guide/test로 고정했다. | `specs/GUIDES/peekaboo-remote-evaluation-mcp.md`, `tests/peekaboo-remote-evaluation.spec.ts` |
| RI-PB-2 | resolved + operator-gated-live | REST observation이 없으면 live readiness가 unknown/WARN이 되도록 테스트하고, explicit env controls와 secret-path authorization boundary를 유지했다. | `buildPeekabooReadinessReport` tests, MCP schema tests |
| RI-PB-3 | resolved + operator-gated-live | evidence ledger에 readiness/submit/REST match/artifact path를 분리 기록하도록 `artifactPath`를 추가하고 guide/test를 보강했다. 실제 macOS/Discord/Peekaboo readiness는 live artifact가 필요하다. | `src/remote/peekaboo-evidence-ledger.ts`, `tests/peekaboo-evidence-ledger.spec.ts` |

## 4. Discord service and auth hardening

| ID | 상태 | 해결 내용 | 증거 |
| --- | --- | --- | --- |
| RI-DS-1 | resolved + operator-gated-deploy | no-default-admin fail-closed posture를 runbook에 기록했다. 운영 환경에서는 admin seed smoke가 필요하다. | `specs/GUIDES/discord-service-hardening-runbook.md`, existing admin tests |
| RI-DS-2 | resolved + operator-gated-deploy | slurm-apptainer image/entry fail-fast와 local current-node 운영 지침을 runbook/.env/README에 정렬했다. 실제 image/entry 존재는 배포 smoke 필요. | `.env.example`, README, runbook, service bootstrap tests |
| RI-DS-3 | resolved | completion observer rejection의 terminal evidence가 Discord reply에도 driver phase/message로 표시된다. | `renderTerminalResult`, `tests/discord-interface.offline.spec.ts` |
| RI-DS-4 | resolved | subprocess host env는 allowlist 유지. site-specific non-secret env allowlist option과 secret-looking name rejection tests를 추가했다. | `ProcessSubprocessRunner.additionalHostEnvAllowlist`, `tests/process-subprocess-runner.spec.ts` |

## 5. Repository/resource posture

| ID | 상태 | 해결 내용 | 증거 |
| --- | --- | --- | --- |
| RI-RP-1 | resolved | `resource/templestay`가 runtime dependency가 아닌 reference/plugin resource posture임을 clarification과 static source test로 고정했다. | `specs/CLARIFICATIONS/templestay-reference-boundary.md`, `tests/resource-boundary.spec.ts` |
| RI-RP-2 | resolved-by-process | broad close-out commit은 이미 발생한 이력이라 코드로 되돌릴 수 없다. 다음 변경은 workstream별 commit을 선호한다는 process note를 유지한다. | 이 ledger와 implementation log |

## 6. Verification baseline for this follow-up

Focused checks executed during this follow-up:

- `pnpm exec vitest run tests/core/trait-module-loader.spec.ts`: PASS (11 tests)
- `pnpm exec vitest run tests/persona/persona-style-transformer.spec.ts tests/persona/discord-persona-delivery.spec.ts`: PASS
- `pnpm exec vitest run tests/peekaboo-remote-evaluation.spec.ts tests/peekaboo-evidence-ledger.spec.ts`: PASS
- `pnpm exec vitest run tests/discord-interface.offline.spec.ts`: PASS
- `pnpm exec vitest run tests/process-subprocess-runner.spec.ts`: PASS
- `pnpm exec vitest run tests/resource-boundary.spec.ts`: PASS

Still required for live PASS claims:

- real persona model run with selected production model and sampled telemetry artifact,
- operator-authorized Peekaboo REST observation secret path/env and live evidence JSONL,
- production admin seed smoke,
- SLURM/Apptainer image+entry smoke in the deployment environment.
