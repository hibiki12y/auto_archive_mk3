---
status: pointer
authority: pointer-only
last_verified: 2026-05-06T20:11:00Z
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

## Standard debug procedure

Peekaboo proof closeout is also the standard debug procedure for this live GUI
path. Use it as a staged ladder and stop at the first failed gate instead of
jumping directly to a live submit.

1. **Frame**: record `runId`, `turnMarker`, control mode, target bot, channel,
   expected task id, observation source, and the failing gate. Do not read
   `.env`, private keys, bridge secrets, raw Discord content, or token-bearing
   logs.
2. **Static/local**: inspect `peekaboo_remote_eval_standard`, generate a
   `peekaboo_remote_eval_plan` or bounded `peekaboo_remote_eval_batch_plan`, and
   verify the helper command in dry-run mode.
3. **Probe**: run the same turn shape with `probe=true` to isolate config,
   SSH, bridge file, Peekaboo proxy, submit readiness, and remediation hints
   before any live Discord mutation.
4. **Authorized live turn**: only after operator approval, run with
   `dryRun=false` and `allowLive=true`. REST credentials, when supplied, are
   observation-only and must never submit user messages.
5. **Stage classification**: classify `submit`, `taskCorrelation`, `ack`, and
   `matchedReply` independently. Prefer marker + task-id + author evidence;
   timing-only matches are weak. Image/OCR-only evidence remains single-source
   until a REST or independent corroborating record exists.
6. **Artifact ledger**: append a redacted digest explicitly with
   `peekaboo_remote_eval_evidence_append`; `run_turn` does not auto-persist.
   Replay with `peekaboo_remote_eval_quantitative_report` or
   `pnpm peekaboo:evidence:report -- --ledger ... --pretty` and inspect
   `replayAudit`, recommendations, and the read-only `debug` block sourced from
   `peekaboo_remote_eval_standard`.
7. **Repair loop**: change one variable, restart from the nearest failed gate
   (static, probe, live submit, observation, or ledger), and preserve failed
   records for baseline/candidate comparison.
8. **Closeout**:
   - PASS requires explicit live GUI opt-in, submitted GUI action, strong
     correlated bot/task evidence, and redacted retained artifacts.
   - WARN covers successful probe, attempted GUI submit, no-REST runs,
     image-only/OCR-only observations, weak correlation, malformed/torn ledger
     tails, or fewer than 5 scoped live records.
   - FAIL covers broken readiness, missing user-authored GUI action, bot-token
     or REST substitution for user input, unsafe raw content, or success claims
     without marker/task evidence.

Debug failure classes used by the standard are:

- `configuration-or-scope`: wrong project status/surface/mode or template data
  mistaken for live proof.
- `transport-or-bridge`: SSH, bridge file, proxy socket, tool-list, timeout,
  `ENOENT`, or `ECONNREFUSED` failures before submit readiness.
- `ui-permission-or-submit`: macOS Accessibility/Screen Recording, Discord
  desktop access, slash selection, focus, or natural-ask submission failures.
- `observation-or-correlation`: missing or weak task correlation, ack, matched
  reply, REST observation, or marker/task-id/author agreement.
- `artifact-ledger-boundary`: missing append, malformed/torn ledger lines,
  unsafe raw fields, missing `artifactPath`/`outcome`, or insufficient live
  samples used as promotion evidence.

## Image-observe path (when GUI OCR cannot see the latest reply)

Discord 데스크톱 OCR이 최신 메시지를 안정적으로 노출하지 못하는 환경에서는
`run_turn`의 `observeMode` 파라미터를 사용해 post-submit 관찰을 PNG 캡처로
전환한다. 이 경로는 다음 입력을 지원한다.

- `observeMode`: `see` (기본 OCR), `image` (PNG만), `both` (둘 다), `none`.
- `imageCapturePath`: 원격 macOS 노드에서 만들어질 PNG 절대 경로. 공백 금지.
- `imageOutput`: 로컬 artifact 경로. 지정 시 `scp`로 PNG가 다운로드되어
  `localPathHash` (SHA-256)와 `byteLength`가 helper 결과 JSON에 기록된다.
- `imageCaptureDelayMs`: 이미지 캡처 직전 추가 대기(ms). 봇 ack가 아직 GUI에
  나타나지 않은 경우 사용한다. natural-ask 흐름에서 codex-runtime-driver가
  의미 있는 응답을 게시할 때까지 보통 30-60초가 필요하다.

이 경로는 추가 매개변수 외에는 기존 closeout 규칙과 동일하다. `scp` 다운로드는
PNG 바이너리만을 가져오며, 원시 토큰/프롬프트/응답을 노출하지 않는다.

권장 운영자 패턴:

1. 한 turn은 `observeMode='see'`로 OCR 텍스트 closeout을 시도한다.
2. OCR이 최신 메시지를 비면 같은 closeout 안에서 `observeMode='both'` +
   `imageCaptureDelayMs >= 30000`으로 PNG를 추가 증거로 첨부한다.
3. `imageOutput` 로컬 경로의 SHA-256/byteLength를 evidence_append `record`의
   `notes`/`outcome` 보조 필드에 redacted 형태로 보관한다.
4. PNG는 redaction 검토 후에만 평가에 첨부한다. 인증/세션 토큰을 노출할 수 있는
   영역이 보이면 즉시 폐기한다.

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

## Observation source attribution

Image-observe와 REST observation이 같은 evidence dimension에 기여할 때,
score만 보면 어느 경로가 통과 사유인지 모호해진다. scorecard와 비교 리포트는
다음 두 표면으로 이 갭을 메운다.

- `scorecard.evidence.observationSourceCounts`: 각 evidence dimension(submit /
  taskCorrelation / ack / matchedReply)에 대해 `captured` 상태 record를
  source key별로 카운트한다. source가 비어 있는 record는 `unspecified`로
  분류한다. probe / dry-run 또는 status='captured'가 아닌 record는 집계되지
  않는다.
- `comparison.deltas.observationSourceShifts`: 동일 dimension에서 candidate
  count - baseline count. 0인 entry는 생략하므로 소스 이동 (예: rest → image)
  이 한눈에 보인다.

운영 권고:

- `scorecard.recommendations`에 image-only single-source hint가 나오면
  (전체 ack가 image이고 matchedReply에 record가 없는 5+ 샘플) REST 보강
  record를 적어도 한 개 추가한 뒤 promotion gate를 재평가한다.
- promotion 결정은 여전히 `comparison.promotionGate.eligibleForPromotion`에
  복종한다. observationSourceShifts는 통과/탈락의 추가 변수가 아니라 **왜**
  점수가 움직였는지에 대한 진단 신호다.
- 같은 단일 ledger 안에서 baseline / candidate를 분리할 때 각 subscope이
  5-record floor를 만족해야 `insufficient-live-sample-for-promotion`이
  사라진다. 통합 scorecard가 5 records를 보였더라도 baseline/candidate
  분리 후 어느 한쪽이 5 미만이면 promotion은 차단된다.
- 실제 검증: 5 image-only records 기준 88/100 + image-only hint 발현 →
  REST-corroborated turn 1개 추가 → 89.998/100 + hint 사라짐을 라이브
  ledger에서 관측(2026-05-06 iter7). 운영 권고 라인이 actionable 신호로
  작동함을 단일 record 추가만으로 입증.
