---
status: pointer
authority: pointer-only
last_verified: 2026-04-29
source_paths:
  - src/remote/peekaboo-remote-evaluation.ts
  - src/remote/peekaboo-remote-eval-mcp.ts
  - scripts/start-peekaboo-remote-eval-mcp.mjs
  - scripts/dev/codex-with-peekaboo-mcp.mjs
  - README.md
  - specs/CURRENT/discord-control-plane-always-on.md
scope: 라이브 Peekaboo 원격 평가 증거 경로에 대한 빠른 운영자/spec 포인터.
---

# 가이드: Peekaboo 원격 평가 MCP

## 사용 시점

라이브 Discord 증거에 대한 짧은 spec 차원 규칙이 필요하거나 전체 운영자 runbook을
찾아야 할 때 본 가이드를 사용한다.

## 사전 조건

- 라이브 Discord 변경에는 Peekaboo/macOS 경로가 필요함을 이해
- Discord REST는 관찰/증거 전용임을 이해
- 라이브 변경 이전에 readiness/probe 워크플로가 가용함

## 주요 운영자 가이드

- `README.md`의 "Peekaboo remote evaluation MCP path"
- `src/remote/peekaboo-remote-evaluation.ts`
- `src/remote/peekaboo-remote-eval-mcp.ts`
- `scripts/start-peekaboo-remote-eval-mcp.mjs`
- `scripts/dev/codex-with-peekaboo-mcp.mjs`

## Spec 차원 읽기

- 라이브 Discord GUI 증거에 Peekaboo를 사용한다. 임의의 자동화 주장에는 사용하지
  않는다.
- Discord REST는 관찰/증거 전용으로 유지한다.
- 라이브 변경 이전에 probe/readiness 증명을 요구한다.
- 지속형 증거가 필요하면 명시적인 원장 append/query를 사용한다.

## 권한 노트

본 가이드는 포인터 전용이다. 현재 구현 응대 동반 spec은
`../CURRENT/discord-control-plane-always-on.md`이다.

## 주요 동반 문서

- `../CURRENT/discord-control-plane-always-on.md`

## Local Codex MCP helper boundary

`scripts/dev/codex-with-peekaboo-mcp.mjs` is **project-local per-invocation MCP
injection**. It passes `-c mcp_servers...` overrides for the current Codex
process and does not run `codex mcp add`, does not edit `~/.codex/config.toml`,
and is not a first-class Codex CLI repository-scoped install.

If Codex CLI later provides repository-scoped MCP registration, update this guide
and the helper tests before changing operator instructions.

## Evidence ledger closeout fields

Every live evidence closeout must keep these fields separate:

1. readiness/probe status (`CONFIG_OK`, `SSH_OK`, `BRIDGE_PRESENT`, proxy, submit,
   and live matched-reply gates),
2. GUI submit evidence from the macOS Peekaboo path,
3. REST/matched-reply observation evidence, if an operator-authorized `envFile`
   or `botTokenEnv` is supplied,
4. `artifactPath` pointing at the durable JSONL/evidence artifact,
5. final PASS/WARN/FAIL outcome.

GUI submit without REST/matched reply evidence is WARN/unknown readiness, not a
PASS closeout.

## Quantitative iteration method

반복 개선은 live GUI 실행 자체가 아니라 증거 원장 위에서 정량 비교한다.

1. `peekaboo_remote_eval_batch_plan`으로 5-10 turn bounded batch를 계획한다.
2. live 실행 전 `precheck`/`probe` 증거로 proxy와 submit readiness를 확인한다.
3. 각 turn closeout을 `peekaboo_remote_eval_evidence_append`로 JSONL 원장에
   저장한다.
4. `peekaboo_remote_eval_quantitative_report`를 실행해 다음 지표를 계산한다.
   - `qualityScore` = liveOk 25 + matchedReplyObserved 25 + strongCorrelation 20
     + taskCorrelationCaptured 15 + live PASS outcome 15.
     - Weighting is an initial calibration heuristic: liveness and matched
       reply readiness dominate because an unobserved GUI path cannot prove
       improvement; correlation strength and task-correlation capture then
       reward evidence quality; the live PASS outcome remains a bounded
       closeout signal rather than the whole score.
   - guardrails: liveOkRate, matchedReplyObservedRate,
     strongCorrelationRate, sample size.
   - `confidence.sufficientForPromotion` is false until the scoped report has
     at least 5 live records; smaller samples are still useful for debugging
     but should not be treated as stable score deltas.
   - `method.scoringRubricVersion` pins the active heuristic so historical
     comparisons can detect rubric drift; bump it whenever weights, thresholds,
     or promotion gates change.
   - baseline/candidate 비교 리포트의 `comparison.promotionGate`가 promotion의
     authoritative gate이다. `qualityScore` delta만으로 promote하지 말고
     `eligibleForPromotion=true`를 확인한다.
   - baseline 또는 candidate가 5 live records 미만이면
     `comparison.interpretation`은
     `insufficient-live-sample-for-promotion`이다. 5 live records는 최소
     floor이며 권장 목표치가 아니므로, 안정적인 판단에는 5-10 turn batch를
     유지한다.
5. candidate run은 baseline run 대비 `qualityScore >= +5`이고 liveOk /
   matchedReplyObserved가 퇴행하지 않으며, baseline/candidate 모두
   `confidence.sufficientForPromotion=true`일 때만 promote한다. 그렇지 않으면 같은
   evidence ledger 위에서 다음 개선 후보를 만든다.

이 리포트는 read-only 평가/비교 표면이다. 원격 GUI를 실행하거나 메시지를 보내지
않으며, live mutation은 계속 `run_turn`의 `dryRun=false` + `allowLive=true` 및
운영자 승인 경계에 남는다.
