---
status: current
authority: contract-design
last_verified: 2026-05-02
source_paths:
  - src/contracts/admission-rule.ts
  - src/core/admission-gate.ts
  - src/core/rate-throttle.ts
  - src/core/rate-throttle-rule.ts
  - src/core/dispatcher.ts
  - tests/wave-0-baseline.spec.ts
  - tests/admission-rule.rate-throttle-chokepoint.spec.ts
  - tests/rate-throttle.spec.ts
scope: PR5 — provider별 inflight cap을 admission-gate T2 chokepoint 'rate-throttle'로 격납.
---

# Dispatcher Rate Throttle — `ChokepointKind` widening

## 결정 요지

- **새 port 신설 X.** WU-L `AdmissionGate`가 이미 `T2_ChokepointCrossing` trigger
  와 `ChokepointKind` enum을 갖는다. provider별 동시 dispatch cap은 **`ChokepointKind`
  의 4번째 값 `'rate-throttle'`로 widening**해 기존 admission-gate vocabulary 안에
  격납한다.
- **별도 trigger 신설 X.** `T4_ExplicitReevaluation`은 operator kill-switch 전용.
  `T1_DispatcherEntry`/`T2_ChokepointCrossing`/`T3_RetryAttempt`/`T5_ResourceExhaustion`
  도 의미적으로 다른 축. 'rate-throttle' chokepoint는 **`T2_ChokepointCrossing`
  trigger 아래** 평가된다.
- **외부 throttle 라이브러리 도입 X.** Node 내장 + `DiscordDeliveryQueue`
  (`src/discord/delivery/discord-delivery-queue.ts:96-99`) `defaultSleep` 패턴
  mirror. p-limit/p-queue/bottleneck 의도적 거부 — 기존 throttle 어휘 통일.
- **fail-open default.** 두 env 미설정 시 unlimited (현재 동작 유지).

## 어휘 정정 (DT Audit v3)

| 어휘 | 출처 | 값 |
| --- | --- | --- |
| `AdmissionTrigger` | `src/contracts/admission-rule.ts:28-33` | `T1_DispatcherEntry` / `T2_ChokepointCrossing` / `T3_RetryAttempt` / `T4_ExplicitReevaluation` / `T5_ResourceExhaustion` (5, lifecycle 축, 닫힘) |
| `ChokepointKind` | `src/contracts/admission-rule.ts:41-44` | **이 PR에서 4번째 값 `'rate-throttle'` widening**. T2 trigger 아래에서만 의미. |
| `vetoSource` | `src/core/dispatcher.ts:411,575` 등 | `'admission' \| 'runtime' \| 'plana'` (역할 축). 본 PR 무관. |

본 PR은 절대 위 어휘를 혼용하지 않는다. `ChokepointKind` 외 surface는 변경 없음.

## Contract 변경

`src/contracts/admission-rule.ts:41-44`:

```ts
export type ChokepointKind =
  | 'compute-submit'
  | 'tool-invoke'
  | 'delivery'
  | 'rate-throttle';   // PR5 신규
```

`tests/wave-0-baseline.spec.ts` `KNOWN_CHOKEPOINT_KINDS`에 `'rate-throttle'`
함께 추가 (Wave 0 G4 schema-freeze gate 의도된 갱신).

## Logic — `src/core/rate-throttle.ts`

provider별 inflight count + lease 객체.

```
RuntimeProvider = 'codex' | 'claude-agent'
RateThrottleConfig { codexMaxInflight, claudeAgentMaxInflight }   # -1 = unlimited

createRateThrottle(config): RateThrottlePort
  reserve(provider) -> RateLease | undefined  # quota 없으면 undefined
  release(lease) -> void                       # lease 반환, counter 감소
  isQuotaAvailable(provider) -> boolean        # admission rule이 사용
  snapshot() -> RateThrottleSnapshot[]         # /doctor snapshot용
```

env helper:

```
rateThrottleConfigFromEnv(env)
  AUTO_ARCHIVE_CODEX_MAX_INFLIGHT        # 정수 0+, 미설정/비정수 → -1 (unlimited)
  AUTO_ARCHIVE_CLAUDE_AGENT_MAX_INFLIGHT
```

## AdmissionRule — `src/core/rate-throttle-rule.ts`

`createRateThrottleAdmissionRule()` 반환 `AdmissionRule { id: 'rate-throttle', evaluate(ctx) }`:

1. `ctx.trigger !== 'T2_ChokepointCrossing'` 또는 `ctx.chokepoint !== 'rate-throttle'`
   → `defer` (다른 chokepoint나 trigger의 평가 사이클에 끼지 않는다)
2. `ctx.metadata['quotaAvailable'] === true` → `admit`
3. `ctx.metadata['quotaAvailable'] === false` → `deny` reason='rate-throttle quota exhausted'
4. metadata 누락 → `defer` reason='rate-throttle quotaAvailable metadata absent'
   (caller가 pre-fetch 의무 — admission-rule §3.2 / §3.4 spec 준수)

### DT Audit ATTACK-3 가드 (1:1:1 보존)

`metadata`에는 **`quotaAvailable: boolean` 만 통과**. raw inflight count, queue
depth, slot id 같은 cross-task state는 절대 metadata에 넣지 않음. caller(dispatcher)
가 throttle.isQuotaAvailable(provider) 한 줄 평가 후 boolean 만 ctx.metadata에 담아
호출. `evaluatedRuleIds` audit trace는 `'rate-throttle'` rule이 평가되었음만 노출
(verdict + ruleId + reason은 그대로). admission-gate `defaultHashCtx`가 metadata
정렬 후 hash하므로 `quotaAvailable` boolean도 dedup key에 들어가지만 — 이는 의도된
효과(같은 quota 상태에서 같은 task 재요청은 dedup).

## Dispatcher integration (sub-PR-B, 본 PR 미포함)

- `src/core/dispatcher.ts`에서 compute submit chokepoint 직전에 'rate-throttle'
  chokepoint 추가 발화. throttle.reserve(provider)로 lease 획득 → success면
  ctx.metadata.quotaAvailable=true로 admission evaluate → admit이면 dispatch 진행,
  deny면 admission-denied lifecycle phase로 reject + lease release.
- terminal phase에서 lease.release(lease) 보장.
- `src/core/doctor.ts`에 throttle snapshot 섹션 추가.
- 본 PR (sub-A)는 contract + logic + rule + tests만. dispatcher integration은
  sub-B에서.

## 큐 / circuit breaker

이번 PR 미포함. 즉시 reject만. 필요 시 후속 PR에서 DiscordDeliveryQueue 패턴
재사용해 추가.

## 검증

```bash
pnpm typecheck
pnpm exec vitest run tests/wave-0-baseline.spec.ts \
  tests/admission-rule.rate-throttle-chokepoint.spec.ts \
  tests/rate-throttle.spec.ts \
  tests/admission-gate.spec.ts    # 회귀: 기존 chokepoint 동작 보존
```

### 회귀 보호

- 기존 admission-gate.spec.ts: T1/T2/T3/T4/T5 동작 보존, 기존 ChokepointKind
  3-값 동작 보존.
- baseline test (wave-0-baseline.spec.ts): KNOWN_CHOKEPOINT_KINDS 4 멤버,
  exhaustiveness compile-time check.

### Live evidence (operator-gated, 후속)

- `AUTO_ARCHIVE_CODEX_MAX_INFLIGHT=1` 후 동시 `/research` 2회 → 두 번째
  `admission-denied reason='rate-throttle'`.
- `live-proof-matrix.md` row 추가: provider별 cap 동작.

## 불변식

- 본 PR은 `AdmissionRule` `evaluate` predicate의 PURE 계약을 깨뜨리지 않는다
  (closure로 외부 state 읽지 않음, metadata 경로 사용).
- `ChokepointKind` widening 외 다른 contract 변경 없음.
- 기존 chokepoint 평가 경로 무영향 (rate-throttle rule은 다른 chokepoint에 defer).
- 1:1:1 lifecycle 보존: lease는 task scope, terminal에서 release.
- single-provider bootstrap 보존: env 두 변수 모두 fail-open.
