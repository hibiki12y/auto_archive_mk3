---
status: current
authority: implementation-explanation
last_verified: 2026-05-05
source_paths:
  - src/contracts/capability-flag.ts
  - src/contracts/trait-module.ts
  - src/contracts/trait-runtime-hook.ts
  - src/contracts/methodology-skill.ts
  - src/core/compute-capability.ts
  - src/core/plana.ts
  - src/runtime/methodology-trait-runtime-decorator-resolver.ts
scope: TraitModule 재설계의 첫 구현 슬라이스 — 스펙, 계약, 기존 compute/plana 표면의 의미 분리.
---

# TraitModule Submodule Plugin System

## 1. 결정

개발 중 `Trait`가 능력 플래그, 진입 어휘, 방법론 스킬 이름을 동시에 의미하게 된
변질을 폐기한다. 현재 브랜치에서의 정본 분리는 다음과 같다.

| 표면 | 의미 | 구현 계약 |
| --- | --- | --- |
| `CapabilityFlag` | compute/resource grant를 나타내는 닫힌 플래그 | `src/contracts/capability-flag.ts` |
| `TraitModule` | 지시문, 스케줄 선언, 런타임 훅 선언을 담는 Auto Archive submodule plugin | `src/contracts/trait-module.ts` |
| methodology integration | 저장소 소유 built-in TraitModule manifest + 증거 전용 데코레이터 | `src/contracts/methodology-skill.ts` |

`TraitModule`은 Codex skill 설치 단위가 아니다. Auto Archive 자체의 플러그인
서브모듈이며, AgentSkills류 폴더 레이아웃을 참고하되 파일명과 런타임 로딩 경계는
Auto Archive가 소유한다.

## 2. 폴더 모델

현재 구현은 파일 시스템 loader/registry를 제공하며, 다음 레이아웃을 계약으로
고정한다. loader는 `traits/**/trait.json`을 발견하고 `TRAIT.md` 존재, deep schema,
그리고 duplicate `id@version` rejection을 검증한다.

```text
traits/
  methodology-agent-origin/
    trait.json
    TRAIT.md
    runtime/
      index.ts
    schedules/
      daily-review.json
```

- `trait.json`: `TraitModuleManifest`의 직렬화 대상.
- `TRAIT.md`: 사람이 읽는 지시/프로필 진입점. Codex의 `SKILL.md`와 혼동하지 않기
  위해 Auto Archive는 `TRAIT.md`를 사용한다.
- `runtime/`: 선택적 런타임 훅 코드. `src/core/trait-module-loader.ts`의 runtime hook boundary가 bounded dynamic import, named export shape, timeout, failure isolation, trust-boundary, capability self-request 검증을 수행한다.
- `schedules/`: 선택적 cron/job 선언. 현재 구현은 persistent JSON file scheduler state, dry-run materialization, `planTraitSchedulerTick()` UTC-only one-shot due-run selection, observe-only `cronTickObserve` summary hook, finalized plan을 caller-owned dispatch callback으로 넘기는 `runTraitSchedulerDueJobs()` bounded runner, `lastTickAt` cursor를 보수적 checkpoint에 따라 저장하는 JSON cursor store, planner→dispatch→cursor를 한 번의 host-invoked tick으로 묶는 `runTraitSchedulerTickOnce()` / `runTraitSchedulerTickOnceFromStores()` coordinator, 같은 Node.js 프로세스 안의 overlapping tick을 하나의 shared runner instance 기준으로 queueing하는 `InProcessTraitSchedulerTickOnceRunner`, TTL 기반 stale takeover를 지원하는 atomic-directory lease `JsonFileTraitSchedulerTickLease` / `runTraitSchedulerTickOnceWithLease()`, 그리고 ran/skipped tick evidence를 JSONL로 남기는 `JsonlTraitSchedulerTickEvidenceLedger` / `runTraitSchedulerTickOnceWithLeaseAndEvidence()`를 제공한다. `pnpm trait:scheduler:plan -- --state <path> [--cursor <path>]`는 persisted state/cursor 위에서 다음 due-job window를 read-only JSON으로 미리 보는 operator CLI이며 dispatch/cursor-save/evidence-write/lease/env-reload/daemon/Discord delivery를 수행하지 않는다. `buildTraitSchedulerTickEvidenceReport()`와 `pnpm trait:scheduler:evidence:report -- --ledger <path>`는 replayed evidence를 dispatch failure/checkpoint hold/lease contention/sample-size scorecard로 해석하는 read-only reporting surfaces이며, JSONL replay 경로는 total/empty/parsed/malformed line counter를 `replayAudit`으로 함께 노출한다. CLI들은 기본 byte guard를 적용하고 `--max-ledger-bytes` 또는 state/cursor byte guard로 조정할 수 있어 과대 입력은 bounded read 중 fail-closed 된다. evidence JSONL은 best-effort audit trail이며 replay는 torn/malformed line을 건너뛰지만 fsync, cross-process append lock, 파일 rotation/retention은 operator 책임이다. dispatch callback/observe hook은 caller-owned authority surface이며, cursor save 실패 후 재시도는 at-least-once semantics로 취급해야 한다. daemon wake loop/환경 reload/Discord delivery 자체는 별도 operator-owned slice로 남긴다.

## 3. CapabilityFlag 분리

`CapabilityFlag`는 다음 네 값만 가진다.

- `network-access`
- `sandbox-mode`
- `approval-policy`
- `web-search-mode`

방법론, 프로필, 프롬프트 출처, 제공자, runtime identity는 `CapabilityFlag`가 아니다.
따라서 `methodology-skill`은 capability 플래그에서 제거되며, compute bounding set
provenance도 `capabilityFlag` 필드로 기록한다.

## 4. TraitModule manifest

`TraitModuleManifest`는 다음 축을 갖는다.

- `id`: `trait.<namespace>.vN` 형식의 안정 id.
- `layout`: `trait.json`, `TRAIT.md`, optional `runtime/`, optional `schedules/`.
- `instructions`: markdown instruction profile 선언.
- `schedule`: `none` 또는 cron 선언. loader는 cron 선언을 deep-validate하고 scheduler dry-run은 retry/retention/delivery target을 persistent state로 materialize한다. one-shot tick planner는 UTC job만 due-run snapshot으로 선택하며, bounded dispatch runner는 host callback을 순차 호출하고 conservative checkpoint를 반환한다. one-shot coordinator는 caller-owned stores에서 state/cursor를 읽어 단일 tick 결과 cursor만 저장할 수 있고, in-process runner는 같은 프로세스 안의 low-fanout 호출이 하나의 runner instance를 공유할 때 다음 tick이 이전 save 이후 cursor를 다시 읽도록 직렬화할 수 있다. 파일 lease wrapper는 lease가 held이면 store load/dispatch 전에 skip하고, stale lease는 TTL 이후 takeover할 수 있다. evidence ledger는 ran/skipped tick 요약을 caller-owned JSONL에 best-effort로 남기며 ledger write failure가 tick semantics를 바꾸지 않는다. evidence report는 ledger records를 filter/limit한 뒤 advisory weighted quality score와 recommendations를 계산하지만 live daemon readiness, exactly-once proof, SLA, 또는 실행 지시 authority를 주장하지 않는다. zero-ran sample은 dispatch/checkpoint component에서 감점하지 않되 sample-size confidence gate를 통과하지 못하면 trend 안정성으로 해석하지 않는다. evidence record의 lease token은 기록하지 않고, `ownerId`는 비밀이 아닌 operator identifier로 취급해야 한다. lease storage의 atomic mkdir semantics, evidence ledger append/rotation/retention, clock alignment는 host deployment 책임이며 daemon/timezone wake loop는 수행하지 않는다. 정확히 한 번 실행, dispatch/observeHook side effect는 host policy 책임이다.
- `runtime`: `none`, `evidence-decorator`, 또는 `module-entrypoint` 선언.
  `module-entrypoint`는 bounded one-shot hook이고, `evidence-decorator`는
  `RuntimeDriver`를 감싸 증거 체크포인트만 추가하는 hook shape이다.
  runtime hook boundary는 동적 import 실행을 bounded/fail-isolated 방식으로
  수행한다.
- `admission`: 기본 요청 여부, required/forbidden capability flags, Plana
  provenance. `forbiddenCapabilityFlags`는 모듈 자체가 요청해서는 안 되는 플래그
  목록이며, host allocation의 ambient capability deny-list가 아니다.

## 5. Built-in repository modules

기존 methodology integration은 다음 built-in TraitModule로 표현한다.

- id: `trait.methodology.agent-methodology-origin.v1`
- layout root: `traits/methodology-agent-origin`
- instruction entrypoint: `TRAIT.md`
- runtime hook: `evidence-decorator`
- runtime export: `composeTraitRuntimeDriver`
- capability posture: `requiredCapabilityFlags=[]`, network/web/sandbox/approval flags는
  `forbiddenCapabilityFlags`로 선언된다. 즉 methodology runtime hook 자체가 이
  플래그들을 요청하지 않는다는 뜻이며, ambient host surface를 자동 거부하지 않는다.

이 모듈은 프로바이더 스위치, 프롬프트 출처 스위치, 또는 compute grant가 아니다.
런타임 동작은 기존 증거 전용 런타임 데코레이터 선언으로 제한된다.

DGM-inspired autonomous research integration은 다음 built-in TraitModule로
표현한다.

- id: `trait.research.autonomous-goal-loop.v1`
- layout root: `traits/autonomous-research-goal-loop`
- instruction entrypoint: `TRAIT.md`
- runtime hook: `evidence-decorator`
- runtime export: `composeTraitRuntimeDriver`
- source map: `https://arxiv.org/abs/2505.22954`
- capability posture: `requiredCapabilityFlags=[]`, network/web/sandbox/approval
  flags는 `forbiddenCapabilityFlags`로 선언된다. 즉 runtime decorator 자체가 이
  플래그들을 요청하지 않는다는 뜻이며, research execution에 필요한 host 권한을
  자동 부여하지 않는다.

이 모듈은 목표/중지조건, bounded iteration budget, archive stepping stones,
empirical evidence gate, completion audit를 요구하는 연구-governance trait이다.
숨은 무한 autonomous runner, 프로바이더 스위치, 프롬프트 출처 스위치, 또는 compute
grant가 아니다. 런타임 동작은 `autonomous-research.checkpoint` 증거 이벤트를
best-effort로 방출하는 증거 전용 데코레이터로 제한된다.

## 6. 현재 구현 범위

현재 구현은 다음을 보장한다.

1. 타입 계약과 문서 계약.
2. compute bounding 코드가 `capabilityFlags`를 소비하도록 의미 정정.
3. Plana 소비 표면이 capability flag 요청과 TraitModule 요청을 구분.
4. methodology integration과 autonomous research integration이 built-in
   TraitModule manifest를 export.
5. `src/core/trait-module-loader.ts`가 trait folder scanner/registry loader, deep manifest validation, duplicate `id@version` rejection을 제공.
6. scheduler dry-run이 cron 선언을 persistent job state로 materialize하고 `main-session` / `isolated-session` / `current-session` delivery target을 분리하며, `planTraitSchedulerTick()`이 그 state 위에서 bounded UTC-only due-run snapshots를 선택하고 `cronTickObserve`가 finalized summary를 observe-only로 방출한다. `runTraitSchedulerDueJobs()`는 finalized plan을 host dispatcher callback으로 순차 전달하고 per-job failure를 contain하며, plan이 truncated이거나 dispatch failure가 있으면 stored `lastTickAt` advance를 보수적으로 hold하고 `hold.reasons`에 두 원인을 모두 남긴다. planner-skipped jobs(예: invalid cron / unsupported timezone)는 audit count로 보존하지만 그 자체만으로 checkpoint를 hold하지 않는다. `applyTraitSchedulerDispatchCheckpoint()` / `JsonFileTraitSchedulerCursorStore`는 이 checkpoint advice를 cursor state에 순수 적용/검증 저장하며, held batch는 기존 `lastTickAt`을 유지한다.
7. runtime hook boundary가 bounded dynamic import, named export validation, timeout, failure isolation, trust-boundary allow flags, capability self-request 검증을 제공.
8. `forbiddenCapabilityFlags`는 host ambient deny-list가 아니라 module self-request ban-list라는 positive/negative tests가 있다.
9. TraitModule id major와 manifest package version의 공존/마이그레이션 정책은 `../CONTRACTS/trait-module-versioning.md`에 승격되어 있다.
10. microkernel 전체를 TraitModule로 변환하지 않는 경계는
    `../CONTRACTS/microkernel-module-boundary.md`에 고정되어 있다.

현재 구현은 여전히 외부/전역 skill 설치를 보장하지 않는다. `TraitModule`은 Auto Archive
workspace plugin이고 Codex skill 설치 단위가 아니다. 또한 `evidence-decorator`
loader는 decorator를 load/validate해서 반환하는 경계이며, `AgentRuntime`은
caller가 pre-admit해서 넘긴 decorator list를 dispatch-time에 opt-in composition할
수 있다. runtime은 TraitModule을 자동 enable하지 않으며, admission과 manifest
loading은 계속 Plana/loader/composition-root 쪽 책임이다. Discord `/traits`는
service bootstrap에서 발견한 repository/workspace manifest metadata를 read-only로
나열하는 UX surface이며 install, enable, 외부 registry fetch는 수행하지 않는다.
service launch cwd가 repository root가 아닐 경우
`AUTO_ARCHIVE_TRAIT_MODULE_WORKSPACE_ROOT`로 discovery root를 명시한다.
`/traits` 응답은 Discord `allowedMentions`를 비워 manifest metadata가 멘션을
발화하지 못하게 한다.

현재 composition-root wiring은 built-in repository modules에 대해
`AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION=evidence-only`와
`AUTO_ARCHIVE_AUTONOMOUS_RESEARCH_TRAIT_RUNTIME_DECORATION=bounded-evidence`를
제공한다. 해당 env가 켜졌을 때만 dispatch별 Plana admission을 거친 뒤 loader가
반환한 `TraitRuntimeDriverDecorator`가
`AgentRuntimeOptions.traitRuntimeDecoratorResolver`를 통해 주입된다.
