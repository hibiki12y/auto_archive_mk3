---
status: current
authority: implementation-explanation
last_verified: 2026-04-30
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
- `schedules/`: 선택적 cron/job 선언. 현재 구현은 persistent JSON file scheduler state와 dry-run materialization을 제공한다. daemon wake loop는 이 state/contract 위에서 구현한다.

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
- `schedule`: `none` 또는 cron 선언. loader는 cron 선언을 deep-validate하고 scheduler dry-run은 retry/retention/delivery target을 persistent state로 materialize한다.
- `runtime`: `none`, `evidence-decorator`, 또는 `module-entrypoint` 선언.
  `module-entrypoint`는 bounded one-shot hook이고, `evidence-decorator`는
  `RuntimeDriver`를 감싸 증거 체크포인트만 추가하는 hook shape이다.
  runtime hook boundary는 동적 import 실행을 bounded/fail-isolated 방식으로
  수행한다.
- `admission`: 기본 요청 여부, required/forbidden capability flags, Plana
  provenance. `forbiddenCapabilityFlags`는 모듈 자체가 요청해서는 안 되는 플래그
  목록이며, host allocation의 ambient capability deny-list가 아니다.

## 5. Built-in methodology module

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

## 6. 현재 구현 범위

현재 구현은 다음을 보장한다.

1. 타입 계약과 문서 계약.
2. compute bounding 코드가 `capabilityFlags`를 소비하도록 의미 정정.
3. Plana 소비 표면이 capability flag 요청과 TraitModule 요청을 구분.
4. methodology integration이 built-in TraitModule manifest를 export.
5. `src/core/trait-module-loader.ts`가 trait folder scanner/registry loader, deep manifest validation, duplicate `id@version` rejection을 제공.
6. scheduler dry-run이 cron 선언을 persistent job state로 materialize하고 `main-session` / `isolated-session` / `current-session` delivery target을 분리.
7. runtime hook boundary가 bounded dynamic import, named export validation, timeout, failure isolation, trust-boundary allow flags, capability self-request 검증을 제공.
8. `forbiddenCapabilityFlags`는 host ambient deny-list가 아니라 module self-request ban-list라는 positive/negative tests가 있다.
9. TraitModule id major와 manifest package version의 공존/마이그레이션 정책은 `../CONTRACTS/trait-module-versioning.md`에 승격되어 있다.
10. microkernel 전체를 TraitModule로 변환하지 않는 경계는
    `../CONTRACTS/microkernel-module-boundary.md`에 고정되어 있다.

현재 구현은 여전히 외부/전역 skill 설치를 보장하지 않는다. `TraitModule`은 Auto Archive
workspace plugin이고 Codex skill 설치 단위가 아니다. 또한 `evidence-decorator`
loader는 decorator를 load/validate해서 반환하는 경계이며, `AgentRuntime`은
caller가 pre-admit해서 넘긴 decorator list를 dispatch-time에 opt-in composition할
수 있다. runtime은 TraitModule을 자동 discover/enable하지 않으며, admission과
manifest loading은 계속 Plana/loader/composition-root 쪽 책임이다.

현재 composition-root wiring은 built-in methodology module에 대해
`AUTO_ARCHIVE_METHODOLOGY_TRAIT_RUNTIME_DECORATION=evidence-only`를 제공한다.
이 env가 켜졌을 때만 dispatch별 Plana admission을 거친 뒤 loader가 반환한
`TraitRuntimeDriverDecorator`가 `AgentRuntimeOptions.traitRuntimeDecoratorResolver`를
통해 주입된다.
