---
status: ratified
authority: binding-clarification
last_verified: 2026-04-29
source_paths:
  - README.md
  - PROJECT.md
scope: adapter/driver/trait 용어에 대한 구속 용어집과, 초안 시점 스캐폴드 스냅샷에서 보존된 역사적 분류 흔적.
---

# 스캐폴드 Adapter / Driver / Trait 정의

## 현재 구속 요약

용어가 분쟁 대상일 때 본 파일을 가장 먼저 읽는다. 현재 브랜치의 구속 규칙은
다음과 같다.

1. `templerun`은 참조 전용이며 런타임 컴포넌트나 프로바이더가 아니다.
2. `ComputeNode`는 통합된 SLURM + Apptainer 프로덕션 솔기이다.
3. 프로바이더 범위는 현재 브랜치에서 Codex SDK 단일이다.
4. **Driver**는 라이프사이클 소유자, **Adapter**는 경계 변환자, **Trait**는
   진입/거버넌스 능력 마커를 의미한다.

본 문서의 나머지는 위 구속을 만들어낸 비준된 역사적 흔적을 보존한다. 역사적
작업 단위 참조는 출처 전용으로 남으며 그 자체로 활성 큐가 아니다.

## 역사적 비준 노트

세션 116 종결 노트: 다섯 가지 원래 수락 기준이 모두 spec 문서 차원에서
충족되었으며, 모호성 사례는 이제 적용된 후속 작업으로 해결되었다. 본 파일은
구속 어휘와 역사적 흔적을 위해 보존한다. 라이브 능력 상태는 `specs/CURRENT/`를
사용한다.

---

## §0. 컨텍스트와 사용자 보정 프레임

본 spec은 `reimpl/arona-plana-dispatcher-core` 스캐폴드의 DT-Council Ultra 설계
검토에 대한 계획 입력으로 작성되었다. 본 문서는 **계획 전용**이다. 어떤 코드
변경도 승인하거나 수행하거나 암시하지 않는다. 여기에 명시된 모든 rename / split /
extract 행동은 §6에 후속 작업 단위로 기록되어 있다. 그것들은 현재 비준된 산출물
안에서 활성 큐가 아니라 역사적 흔적으로 유지된다.

다음 네 가지 보정은 본 spec 어휘에 대한 **구속 제약**이다. 이를 모순하는 후속
섹션은 본 문서의 결함으로 간주된다.

1. **`templerun`은 참조 지시 집합이며 런타임 컴포넌트가 아니다.**
   `templerun`은 spec과 검토를 생산하는 오케스트레이션 *프로세스*(즉, 사람 +
   Council 워크플로)가 *참조 문서*로 사용하는 Copilot CLI 행동 지시 집합을
   가리킨다. 이는 "에이전트 런타임"이 **아니며**, 중첩 서브에이전트 런타임이
   **아니며**, 인프로세스 실행 컴포넌트가 **아니다**. `src/` 내 오케스트레이터
   구현은 `templerun`에 의존하지 않으며 import, 임베드, 호출해서는 안 된다.
   다른 곳에서 "templerun"에 대한 참조는 코드가 아니라 문서에 대한 참조로
   읽혀야 한다.

2. **`compute node`는 SLURM 할당 + Apptainer (rootless) 격리를 감싸는 하나의
   통합된 추상화이다.**
   compute node는 두 형제가 아니라 단일 솔기이다. SLURM (작업 할당, 큐, 회계)와
   Apptainer (rootless 컨테이너, 파일시스템 및 네트워크 격리)는 *하나의 compute
   node의 부분*이다. SLURM 관심사를 노출하는 향후 스캐폴드 모듈은 동일 경계에서
   Apptainer 관심사도 노출해야 하며, 그 반대도 마찬가지이다. 이들을 독립
   어댑터로 취급하는 것은 명시적으로 허용되지 않는다.

3. **LLM 프로바이더 범위: Codex SDK 단일.**
   본 브랜치 슬라이스의 초안 시점 범위에서 지원되는 유일한 LLM 프로바이더는
   `@openai/codex-sdk` 기반의 Codex 드라이버였다. OpenAI 도구 호출 브리지,
   프로바이더로서의 Copilot CLI, 어떤 다중 프로바이더 자세도
   `reimpl/arona-plana-dispatcher-core`에서 명시적으로 **연기되었고
   범위 외**였다. 향후 프로바이더 다중화는 로드맵 항목으로 인지되었지만 여기에
   캡처된 Adapter/Driver/Trait 분류에 영향을 미치지 않아야 했다.

4. **사전 노트: 초안 시점 파일 경로.**
   원래 분석 입력을 생성한 디스패치 프롬프트는 `src/contracts/dispatch-backend.ts`와
   `src/contracts/dispatcher.ts`를 참조했다. 여기서 분석된 초안 시점 스캐폴드
   스냅샷에서는 두 파일 모두 존재하지 않았다. 관련 파일은
   `src/core/dispatch-backend.ts`와 `src/core/dispatcher.ts`였다. 본 문서는
   해당 스냅샷을 논의할 때 그 초안 시점 경로를 보존한다.

---

## §1. 본 spec이 존재하는 이유

본 spec이 분석한 `src/` 하위의 초안 시점 스캐폴드는 깨끗한 DT-Council 검토를
가로막는 두 가지 드리프트 증상을 보였다.

- **명명 드리프트.** `-driver.ts` 접미사는 적어도 세 가지 다른 역할에 사용된다.
  실제 라이프사이클 소유자(`runtime/agent-runtime.ts`가 `RuntimeDriver`를
  정의), 외부 SDK를 어댑트하는 경계 변환자(`runtime/codex-runtime-driver.ts`),
  그리고 라이프사이클 없는 부수효과 발행자(`core/gitlab-checkpoint-driver.ts`).
  검토자는 파일 이름에서 동작을 추론할 수 없다.
- **역할 드리프트.** 일부 파일은 포트(인터페이스)와 어댑터(구현)를 한 모듈에
  융합한다. 예를 들어 `core/dispatch-backend.ts`는 `DispatchBackend` 포트와
  `InProcessDispatchBackend` 어댑터를 모두 정의한다. 이는 의존성 방향을
  명시적이지 않고 암묵적으로 만든다.

본 spec의 목표는 **단일 구속 용어집**을 발행하여 다음을 가능하게 하는 것이다.

- 향후 재구현 슬라이스가 모호함 없이 카테고리를 이름으로 참조할 수 있다(예:
  "이 파일은 `DispatchBackend` 포트를 구현하는 Adapter이다").
- DT-Council 검토가 각 파일을 그 역할의 단일 정의에 대해 평가할 수 있다.
- 권장된 rename / split이 임시 정리가 아닌 추적 가능한 작업 단위가 된다.

본 spec은 의도적으로 아키텍처 변경을 *제안하지 않는다*. 분석된 스캐폴드 스냅샷에
존재한 것을 명명하고 명명·모듈 경계가 강화되어야 할 곳을 표시할 뿐이다.

---

## §2. 정의

### §2.1 Adapter

**정의.** Adapter는 외부 기술 표면(SDK, CLI, 네트워크 프로토콜, 파일시스템
배치, UI 프레임워크)과 도메인 또는 드라이버가 정의한 내부 포트(인터페이스) 사이를
번역하는 모듈이다. Adapter는 도메인과 드라이버가 자신만의 포트로만 말하고 결코
벤더 타입에 의존하지 않도록 존재한다.

- **의존성 방향.** Adapter는 (a) 외부 기술과 (b) 자신이 구현하는 내부 포트에
  의존한다. 내부 포트는 Adapter에 의존하지 **않는다**. 도메인과 드라이버는
  포트에 의존하며, Adapter에 직접 의존하지 않는다. Composition-Root는 시작 시
  구체 Adapter를 포트에 배선한다.
- **라이프사이클.** Adapter는 일반적으로 자체 장수 supervision 루프를 갖지
  않는다. 메서드 호출은 호출자(단일 드라이버 `run()`, 단일 `publish()`, 단일
  Discord 상호작용 등)의 라이프사이클에 의해 경계가 정해진다. Adapter는 호출당
  단명 상태(예: 변환된 이벤트 버퍼)를 가질 수 있지만 태스크 식별, abort latch,
  종료 증거를 소유해서는 안 된다.
- **테스트 경계.** Adapter는 *외부* 표면을 stub하고(가짜 SDK, 가짜
  `child_process`, 가짜 `discord.js` 클라이언트) Adapter가 포트를 올바르게
  호출하고 예상되는 내부 값 객체를 생산하는지 단언하여 테스트한다.
- **안티 패턴.** 자체 장수 supervision 루프, 단일 사용 보장, abort latch를
  소유하거나, 자기 책임으로 도메인 라이프사이클 이벤트를 발행하는 Adapter.
  이러한 책임은 Adapter가 아닌 Driver나 도메인에 속한다.

### §2.2 Driver

**정의.** Driver는 하나의 실행 인스턴스의 **라이프사이클**을 소유하는 모듈이다.
실행을 인스턴스화하고, 시작에서 종료 원인까지 구동하며, 런타임 이벤트 스트림을
발행하고, abort latch와 거부/타임아웃 escalation을 보유하며, 최종 종료 증거를
조립한다. Driver는 도메인과 포트 어휘로만 말한다. 외부 기술과 통신할 필요가 있을
때는 Adapter에 위임한다.

- **소유 항목.**
  - 인스턴스 식별(하나의 드라이버 호출 = 하나의 논리 실행).
  - abort latch (취소 / 거부 / 타임아웃이 여기에 수렴).
  - 런타임 이벤트 발행 스트림(`RuntimeEventInput` → 옵저버).
  - 종료 증거 조립(`TerminalEvidence`는 정확히 한 번 생성됨).
  - 실행 인스턴스에 대한 단일 사용 보장(재진입 없음).
- **라이프사이클.** Run-to-terminal-cause-wins: 드라이버가 시작되어 점진적
  이벤트를 받고, 정확히 하나의 `RuntimeTerminalCause`로 수렴한다. 도착하는
  첫 번째 cause(완료, abort, 거부, 타임아웃)가 이긴다. 후속 cause는 관찰되지만
  덮어쓰지 않는다. 드라이버 인스턴스는 태스크당 단일 사용이다.
- **관찰 가능 표면.** Driver는 세 솔기를 통해 도메인에 진행 상황을 노출한다.
  고수준 상태 전이용 `LifecycleObserver` 콜백, 실행 중 점진적 이벤트용
  `RuntimeEvent` 스트림, 종료 원인에서 반환되는(또는 옵저버로 노출되는)
  `TerminalEvidence` 값.
- **안티 패턴.** Adapter에 위임하지 않고 SDK 타입에 직접 경계 변환을 수행하는
  Driver. 또는 라이프사이클 없는 Driver(abort latch 없음, 종료 원인 수렴 없음,
  단순한 단일 부수효과 호출). 이는 잘못 명명된 Adapter이다.

### §2.3 Trait

**정의.** Trait는 진입 경계에서 요청이 진행되도록 허용할지, 거부할지, 또는
다운그레이드할지 결정하기 위해 참조되는 **능력 마커 / 기능 게이트**이다. Trait는
선언된 능력 형태(예: `networkAccessEnabled`, `webSearchMode`, `sandboxMode`,
`approvalPolicy`)이며, 진입 소비자가 정책에 대해 그것을 읽고 admit / 거부
결정으로 변환한다.

- **점검 위치.** Plana 내부의 진입 경계, 주로 `Plana.reviewPreDispatch`와
  (계획된) `Plana.reviewRuntimeSettings`. Trait는 SDK 경계나 드라이버 내부
  깊숙이에서 점검되어서는 안 된다. 실행이 시작되기 전에 평가되어야 하며,
  평가는 throw된 예외가 아닌 구조화된 결정(admit / VetoPath)을 만들어야 한다.
- **누가 admit / 거부하는가.** Plana가 **주된** 진입 소비자이다. Adapter는
  부차적 거부를 노출할 수 있지만(예: SDK가 Trait 정책이 이미 금지한 옵션을
  거부) 그러한 Adapter 측 거부는 원시 에러 escape가 아닌 `VetoPath` cause로
  보고되어야 한다.
- **`src/`의 역사적 스냅샷 상태.** 분석된 초안 시점 스캐폴드에서, **`src/`의 어떤
  파일도 TRAIT 역할을 하지 않았다.** Trait 형태의 *값*은 존재했다.
  - `src/contracts/runtime-settings.ts`의 `RuntimeSandboxMode`,
    `RuntimeApprovalPolicy`.
  - `src/contracts/network-policy.ts`의 `NetworkPolicyProfile`,
    `RuntimeNetworkProjection`.
  - `src/contracts/execution-checkpoint.ts`의 `ExecutionCheckpointSource`.
  해당 초안 시점 스캐폴드 스냅샷에서, 이들 중 어느 것도 진입 게이트로 소비되지
  않았다. 통과·관찰되었지만, 어떤 정책 모듈도 그것들을 읽고 admit/거부를
  결정하지 않았다. Plana가 그 소비자의 자연스러운 미래 거처였다.
- **안티 패턴.** SDK 호출 사이트 내부에서 수행되는 Trait 점검(호출 경로가
  바뀌면 게이트가 우회됨), 또는 throw된 에러로 보고되는 Trait 위반(그러면
  `TerminalEvidence`의 `VetoPath`로 결코 나타나지 않음).

### §2.4 보조 카테고리(완전성을 위해)

§3의 분류는 Adapter/Driver/Trait이 아니지만 모든 파일을 커버하기 위해 필요한
세 가지 카테고리도 사용한다.

- **Port-Contract.** `src/contracts/` 하위의 순수 인터페이스와 값 객체 선언.
  런타임 동작 없음. 도메인, 드라이버, 어댑터가 의존함. `src/` 안의 다른 계약
  외에는 어느 것에도 의존하지 않는다.
- **Domain-Core.** 외부 의존 없이 정책과 오케스트레이션 로직을 인코딩하는
  엔티티, 서비스, 값 객체. Port-Contract에 의존하며 Adapter에 의존하지 않는다.
- **Composition-Root.** 시작 시 구체 Adapter를 포트에 선택·배선하는 환경 변수
  게이트 팩토리와 부트스트랩 글루. 그 일이 변환이 아닌 배선이라는 점에서
  Adapter와 구별된다.
- **Other.** 자체 동작 없이 barrels와 re-exports만 갖는 항목.

---

## §3. 파일 분류 (초안 시점 스캐폴드 스냅샷)

아래 분류는 초안 시점 스캐폴드 스냅샷에 대해 원래 분석 입력을 권한 있는 것으로
취급한다. 이는 역사적 분류이며 브랜치의 현재 파일 트리에 대한 진술이 아니다.
각 파일에는 정확히 하나의 주요 카테고리가 할당된다. 그 스냅샷에서 한 파일이
두 역할을 가졌을 때, 보조 역할은 괄호로 표시되고 해결은 §4에 나타난다.

### §3.1 Port-Contract

- `src/contracts/dispatch-lifecycle.ts` — 라이프사이클 옵저버 인터페이스와 이벤트
  형태.
- `src/contracts/dispatch-submission.ts` — 제출 식별과 요청 envelope 타입.
- `src/contracts/execution-checkpoint.ts` — 실행 체크포인트 값 타입과
  `ExecutionCheckpointPublisher` 포트.
- `src/contracts/network-policy.ts` — 네트워크 정책 프로필과 런타임 네트워크 투영
  값 타입.
- `src/contracts/resource-envelope.ts` — 자원 envelope 값 타입.
- `src/contracts/runtime-event.ts` — 런타임 이벤트 입력/출력 형태.
- `src/contracts/runtime-settings.ts` — 런타임 설정 값 타입(sandbox 모드,
  승인 정책, 네트워크 투영).
- `src/contracts/terminal-evidence.ts` — 종료 증거 값 타입과 종료 원인 분류
  체계.
- `src/contracts/veto.ts` — `VetoPath` 형태와 헬퍼.

### §3.2 Domain-Core

- `src/core/arona.ts` — 관리자 엔티티. Dispatcher 포트 위에서 디스패치
  오케스트레이션과 디스패치 이전 정책 게이트.
- `src/core/plana.ts` — 정책 평가자 엔티티. 디스패치 이전 / 런타임 / 설정 거부
  검토자.
- `src/core/dispatcher.ts` — 제출 식별, 단일 사용 보장, 취소 상태 머신,
  라이프사이클 옵저버 fan-out을 소유함. `DispatchBackend` 포트를 소비함.
- `src/core/task.ts` — `TaskRequest` / `DispatchPlan` 값 객체와 팩토리.
- `src/core/terminal-cause-evidence.ts` — `RuntimeTerminalCause`를
  `TerminalEvidence`로 매핑하는 순수 헬퍼.

### §3.3 Driver

- `src/runtime/agent-runtime.ts` — 인프로세스 런타임 라이프사이클(인스턴스
  시작 → 런타임 이벤트 발행 → 거부/abort/타임아웃 처리 → 종료 증거 정착)을
  소유함. 다른 드라이버가 결합하는 `RuntimeDriver` 솔기를 정의함. (보조 역할:
  공동 위치한 `RuntimeDriver` 인터페이스는 Port-Contract 형태이며 §4의 해결
  #1의 대상이다.)

### §3.4 Adapter

- `src/runtime/codex-runtime-driver.ts` — 외부 `@openai/codex-sdk`
  thread/event 표면을 내부 `RuntimeDriver` 인터페이스(`run(context) →
  RuntimeDriverResult`)와 `RuntimeEventInput` 형태로 변환함. 라이프사이클은
  단일 `runtime.execute(...)` 호출로 경계가 정해짐. "driver"로 명명되었지만
  역할은 경계 변환임. (해결 #2 참조.)
- `src/core/dispatch-backend.ts` — `DispatchBackend` 포트(Port-Contract 역할)도
  정의하고 `AgentRuntime`을 백엔드 포트로 어댑트하는 `InProcessDispatchBackend`도
  탑재함. 한 파일, 두 역할. (해결 #3 참조.)
- `src/core/gitlab-clone-dispatch-backend.ts` — GitLab 클론 실행 모델(클론 루트,
  작업 디렉터리, 체크포인트 발행)을 `DispatchBackend` 포트로 어댑트함.
  `GitCommandClient`(외부)와 `AgentRuntime`(내부)을 감쌈.
- `src/core/gitlab-checkpoint-driver.ts` — `ExecutionCheckpointPublisher.publish(plan)`을
  노출함. git만 호출하고 `ExecutionCheckpoint`를 생산함. start/step/stop
  라이프사이클 없음. "driver"로 명명되었지만 역할은 발행 전용 어댑터임.
  (해결 #4 참조.)
- `src/core/git-command-client.ts` — `node:child_process` git 호출에 대한 얇은
  래퍼.
- `src/discord/discord-bot.ts` — `discord.js` 클라이언트와 부트스트랩을
  인프로세스 Arona / Dispatcher 솔기로 어댑트함.
- `src/discord/discord-command-handlers.ts` — slash 커맨드 상호작용을
  `Arona.requestDispatch` / `Dispatcher.cancel`로 어댑트함.
- `src/discord/discord-result-renderer.ts` — `TerminalEvidence`를 Discord 메시지
  형태로 렌더링.
- `src/discord/discord-task-registry.ts` — Discord에서 가시적인 태스크 추적을
  위한 어댑터 측 상태. Domain-Core 대비 가벼운 모호성 있음. (해결 #6 참조.)

### §3.5 Trait

- (분석된 스캐폴드 스냅샷에 없음) — 그 초안 시점 `src/` 트리의 어떤 파일도
  TRAIT 역할을 하지 않았다. Trait 형태의 값은 Port-Contract 파일 내부에
  존재했지만(§2.3 참조), 어떤 진입 소비자도 그것들을 게이트로 읽지 않았다.
  §4의 해결 #7은 Plana에서 첫 번째 TRAIT 소비자를 도입하는 권장 후속 작업을
  기록한다.

### §3.6 Composition-Root

- `src/core/dispatch-backend-factory.ts` — 환경 변수 게이트 팩토리.
  `InProcessDispatchBackend`와 `GitLabCloneDispatchBackend` 사이에서 선택함.

### §3.7 Other

- `src/index.ts` — barrel. re-exports 전용.

---

## §4. 모호성 해결 (구속 결정)

아래 각 모호성에 대해 **Resolution** 라인은 본 spec 안에서 구속력이 있다. 그것이
코드 변경을 트리거하는 곳에서, 그 변경은 미래 작업 단위로만 기록된다(§6 참조).
여기서는 수행되지 **않는다**.

### 모호성 #1 — `src/runtime/agent-runtime.ts`: Driver vs Port-Contract

`RuntimeDriver` 인터페이스, `RuntimeExecutionContext` 값, `RuntimeDriverResult`
값이 `AgentRuntime` 드라이버 구현과 공동 위치한다. 이는 포트가 드라이버 내부에
사는 것처럼 보이게 하며, 일반적인 의존성 규칙을 뒤집는다.

**Resolution.** 본 spec의 목적상 `agent-runtime.ts`를 **Driver**로 분류한다. §6의
**WU-A**는 `RuntimeDriver`, `RuntimeExecutionContext`, `RuntimeDriverResult`를
`src/runtime/agent-runtime.ts`에서 새로운 계약 파일 `src/contracts/runtime-driver.ts`로
추출한 역사적 후속 작업을 기록한다. 그 후 포트는 `src/contracts/`에 살게 되고,
`agent-runtime.ts`는 그것에 의존하는 순수 Driver가 된다.

### 모호성 #2 — `src/runtime/codex-runtime-driver.ts`: Adapter vs Driver

파일명이 `-driver.ts` 접미사를 사용한다. 동작은 독립 라이프사이클 없이
`@openai/codex-sdk`에 대한 경계 변환이다(라이프사이클은 `AgentRuntime`에
머무름).

**Resolution.** **Driver = 라이프사이클 소유자.** 본 spec은 다음과 같이 용어를
구속한다.

- 라이프사이클을 소유하는 파일(시작 → 종료 원인 → 종료 증거, abort latch와 단일
  사용 보장 포함)은 `-driver.ts` 접미사를 사용한다.
- Driver 포트로 어댑트하는 파일 — 즉, 외부 표면을 `RuntimeDriver`(또는 다른
  드라이버) 포트로 번역하는 것이 유일한 작업인 파일 — 은 `-adapter.ts`(또는
  계층을 명확히 할 때 `-runtime-adapter.ts`) 접미사를 사용한다.

이 구속 아래에서 `codex-runtime-driver.ts`는 잘못 명명되었다. 그것은 Driver가
아닌 Adapter이다. §6의 **WU-B**는 `codex-runtime-adapter.ts`로의 역사적 후속
rename과 관련 import 업데이트를 기록한다. 본 spec의 초안 시점 분류에서, 검토자는
오해의 소지가 있는 접미사를 무시하고 그 파일을 **Adapter**로 취급해야 했다(§3.4
참조).

### 모호성 #3 — `src/core/dispatch-backend.ts`: Port-Contract vs Adapter

이 파일은 `DispatchBackend` 인터페이스(포트)와 `InProcessDispatchBackend`
클래스(어댑터)를 모두 보유한다. 이는 포트가 `src/contracts/`에 살고 어댑터가
`src/core/`(또는 `src/runtime/`, `src/discord/`)에 산다는 관례를 위반한다.

**Resolution.** 파일을 주로 **Adapter**(런타임 배선에 영향을 주는 실행 가능
역할)로 분류하고, `src/contracts/dispatch-backend.ts`(포트)와
`src/core/in-process-dispatch-backend.ts`(어댑터)로의 역사적 후속 분리를 §6의
**WU-C**로 기록한다. 그 후속 작업 후 포트는 §3.1에, 어댑터는 §3.4에 중복 없이
속한다.

### 모호성 #4 — `src/core/gitlab-checkpoint-driver.ts`: Driver vs Adapter

`-driver.ts` 접미사로 명명되었지만 `ExecutionCheckpointPublisher.publish(plan)`만
노출한다. start/step/stop 없음, abort latch 없음, 종료 원인 수렴 없음. §2.2 안티
패턴 절에 따르면 이것은 Adapter이다.

**Resolution.** **Adapter**로 분류함(§3.4). §6의 **WU-D**는
`gitlab-checkpoint-publisher.ts`로의 역사적 후속 rename을 기록한다. 본 spec은
또한 이 코드베이스 내에서 **`-driver.ts` 접미사가 라이프사이클 소유를 함의함**을
문서화한다. 라이프사이클 없는 모듈은 그것을 사용해서는 안 된다.

### 모호성 #5 — `src/core/dispatch-backend-factory.ts`: Composition-Root vs Adapter

두 백엔드 어댑터 사이에서 선택하는 환경 변수 게이트 팩토리. 일부 이전 검토는
구체 어댑터 클래스를 import한다는 이유로 그것을 어댑터로 기술했다.

**Resolution.** **Composition-Root**로 분류함(§3.6). 본 spec은
Composition-Root를 어댑터와 구별되는 카테고리로 공식화한다. 팩토리는 여기에
속한다. §6의 **WU-E**는 문서 전용 확인을 기록한다(코드 변경 불필요).

### 모호성 #6 — `src/discord/discord-task-registry.ts`: Adapter-state vs Domain-Core

레지스트리는 Discord에서 가시적인 태스크 상태(상호작용 id, 채널 id, 마지막
알려진 라이프사이클 상태)를 보유한다. `discord-result-renderer.ts`가 읽고,
`discord-command-handlers.ts`와 라이프사이클 옵저버 배선이 쓴다. 이 상태가
"어댑터가 소유"(표현 캐시)인지 "도메인이 소유"(정본 태스크 식별)인지는
미해결이다. 이는 cancel 확인에 대한 **DT-Council Moderate 1** 발견과 겹친다.
취소 확인 상태를 누가 소유하는지에 대한 질문이 동일한 형태이다.

**Resolution.** 본 spec의 목적상 **Adapter**로 분류함(§3.4) — 레지스트리는
외부에 있는 Discord 상호작용 식별자로 키가 매겨지는 표현 측 캐시이다. §6의
**WU-F**는 DT-Council Moderate 1 수정과 조정된 역사적 후속 작업을 기록한다. 그
수정은 정본 태스크 상태가 Dispatcher(Domain-Core)가 소유하고 Discord 어댑터
측에 캐시될 뿐인지, 아니면 Discord 레지스트리가 Dispatcher 스냅샷에서 파생된
표현 전용 상태를 소유하는지를 명시적으로 진술해야 했다. 본 spec은 그 결정을
선점하지 않는다. 여기에 캡처된 초안 시점 분류만을 구속한다.

### 모호성 #7 — `src/contracts/runtime-settings.ts`의 `networkProjection` 필드: Port-Contract vs Trait

`runtime-settings.ts`는 `networkAccessEnabled`, `webSearchMode`, `sandboxMode`,
`approvalPolicy`를 투영 필드로 노출한다. 이들은 *trait 형태*(진입에서 참조되는
능력 마커)이지만, 분석된 스캐폴드 스냅샷에서는 단순히 통과되었다. 어떤 진입
소비자도 그것들을 게이트로 읽지 않았다.

**Resolution.** 이러한 계산된 투영 — `networkAccessEnabled`, `webSearchMode`,
`sandboxMode`, `approvalPolicy` — 을 스캐폴드의 **정본 TRAIT 표면**으로 선언한다.
값은 계속 `src/contracts/`에 살지만(값 선언에 대해 Port-Contract 위치가 정확함),
**TRAIT 역할**은 (초안 시점에 현재 부재인) 진입 소비자에게 할당된다. §6의
**WU-G**는 이러한 필드를 정책에 대해 읽고 admit / `VetoPath` 결정을 생산하는
Plana 진입 훅을 도입한 역사적 후속 작업을 기록한다.

---

## §5. Compute-node / templerun / LLM 프로바이더 진술

본 섹션은 §0의 보정을 본 spec이 분석한 초안 시점 스캐폴드를 어떻게 제약했는지의
관점에서 다시 진술한다.

### §5.1 templerun — 참조 전용

`templerun`은 오케스트레이션 *프로세스*가 참조 문서로 사용하는 Copilot CLI 행동
지시 집합이다. 코드가 아니며, 런타임 컴포넌트가 아니며, 인프로세스 서브에이전트
런타임이 아니다. 분석된 스캐폴드 스냅샷에 대한 제약은 기계적이다.

- `src/` 하위의 어떤 파일도 `templerun`을 import, 임베드, 파싱, 호출해서는
  안 된다.
- `src/contracts/`의 어떤 포트도 자신의 타입 어휘에 `templerun`을 명명해서는
  안 된다.
- 설계 문서의 `templerun` 참조는 문서에 대한 참조일 뿐이다.

향후 spec이 `templerun` 호출을 Adapter로 감싸는 것을 제안하면, 그것은 전혀
새로운 코드 경로(Copilot CLI 표면에 대한 CLI Adapter)가 될 것이며 자체 포트가
필요할 것이다. 그것은 여기에 분석된 초안 시점 스캐폴드의 일부로
`templerun`을 소급해 만들지 않는다.

### §5.2 컴퓨트 노드 — 하나의 추상화로서의 SLURM + Apptainer

컴퓨트 노드는 다음을 감싸는 단일 솔기이다.

- SLURM 작업 할당(큐, 회계, 수명).
- Apptainer rootless 격리(파일시스템, 네트워크, 프로세스 격리).

둘 모두 동일 경계에서 노출되어야 한다. 분석된 초안 시점 스캐폴드에는 두 개의
`DispatchBackend` Adapter가 있었다: `InProcessDispatchBackend`(인프로세스)와
`GitLabCloneDispatchBackend`(클론 기반). 향후 컴퓨트 노드 백엔드는 **세 번째
`DispatchBackend` 변종**이 되거나(또는 §7에 따라 기존 백엔드 주위 래퍼가 되며 —
Council이 결정함). 그것은 `src/`에서 SLURM과 Apptainer 관심사가 노출되는
**유일한** 장소가 될 것이다. 다른 어떤 Adapter도 일치하는 Apptainer 의존을 함께
취하지 않고 SLURM 의존을 취해서는 안 되며, 그 반대도 마찬가지이다.

이는 §3 분류에 중요하다: 분석된 초안 시점 스캐폴드에서, SLURM이나 Apptainer
Adapter의 부재는 갭이 아니라 정확한 것이었다. 컴퓨트 노드 지원은 연기된 작업
항목이었다. 그것을 도입하는 것은 전용 spec을 요구했다.

### §5.3 LLM 프로바이더 — Codex SDK 단일

`reimpl/arona-plana-dispatcher-core`의 초안 시점 범위 내에서, 유일한 LLM
프로바이더는 `@openai/codex-sdk` 기반의 Codex 드라이버였다. 스캐폴드 스냅샷은
이를 단일 LLM 측 Adapter로 반영했다.

- 역사적 초안 명 `src/runtime/codex-runtime-driver.ts`(WU-B 아래에서 다운스트림
  `codex-runtime-adapter.ts`로 rename됨) — 외부 LLM SDK를 내부
  `RuntimeDriver` 포트로 변환하는 유일한 Adapter.

OpenAI 도구 호출 브리지, LLM 프로바이더로서의 Copilot CLI, 어떤 다중 프로바이더
자세도 그 브랜치 슬라이스에 대해 **범위 외**였다. 그것들은 초안 시점
Adapter/Driver/Trait 분류에서 참조되어서는 안 되었고, 검토 중인 포트 형태에
영향을 주어서는 안 되었으며, 여기서 모호성 후보로 추가되어서는 안 되었다.
그것들이 나중에 범위 내가 되었을 때, 동일 `RuntimeDriver` 포트 뒤의 추가
Adapter로(또는 라이프사이클이 실질적으로 다르면 별도 spec을 통해 도입되는 새로운
Driver+Adapter 쌍으로) 나타나게 된다.

---

## §6. 역사적 후속 작업 단위 (추적성을 위해 보존됨; 다운스트림에서 해결되었거나 그렇게 문서화됨)

아래 각 작업 단위는 본 계획 spec이 가리켰던 초안 시점 후속 경로를 기록한다.
이들은 역사적 흔적으로만 유지된다. 본 섹션은 활성 잔여 작업 큐가 아니며, spec
자체는 코드 변경을 승인하지 않았다.

- **WU-A — `RuntimeDriver` 포트를 `src/contracts/runtime-driver.ts`로 추출.**
  모호성 #1 해결. `RuntimeDriver`, `RuntimeExecutionContext`,
  `RuntimeDriverResult`를 `src/runtime/agent-runtime.ts`에서 새 계약 파일로
  이동. import 업데이트. 그 후 `agent-runtime.ts`는 계약에 의존하는 순수
  Driver이다.

- **WU-B — `codex-runtime-driver.ts` → `codex-runtime-adapter.ts` rename.**
  모호성 #2 해결. `-driver.ts` 접미사가 라이프사이클 소유를 함의하고
  `-adapter.ts` 접미사가 경계 변환을 함의한다는 구속을 확립. 동작 변경 없는
  순수 rename + import 업데이트.

- **WU-C — `src/core/dispatch-backend.ts`를 포트와 어댑터 파일로 분리.**
  모호성 #3 해결. `src/contracts/dispatch-backend.ts`(포트:
  `DispatchBackend` 인터페이스 전용)와
  `src/core/in-process-dispatch-backend.ts`(어댑터:
  `InProcessDispatchBackend` 클래스 전용)를 생성. 팩토리와 다른 소비자
  업데이트.

- **WU-D — `gitlab-checkpoint-driver.ts` → `gitlab-checkpoint-publisher.ts` rename.**
  모호성 #4 해결. 파일명을 역할(발행 전용 어댑터)에 정렬. 동작 변경 없음.

- **WU-E — 팩토리를 Composition-Root로 문서화.**
  모호성 #5 해결. 본 spec에 이미 커버됨. **코드 변경 불필요.** 향후 감사가
  §3.6을 답으로 표시할 수 있도록 추적성을 위해 여기에 나열함.

- **WU-F — Discord 태스크 레지스트리 소유권 정의.**
  모호성 #6 해결. DT-Council Moderate 1 cancel 확인 수정과 조정하여, 정본
  상태 소유권과 표현 캐시 소유권이 한 수정 spec에서 함께 진술되도록 함.
  Dispatcher(Domain-Core)와 `discord-task-registry.ts`(Adapter) 사이에서
  필드를 옮기거나, 경계에서 명시적 스냅샷 타입을 도입할 수 있음.

- **WU-G — Plana에 첫 TRAIT 소비자 도입.**
  모호성 #7 해결. `networkAccessEnabled`, `webSearchMode`, `sandboxMode`,
  `approvalPolicy`를 정책에 대해 읽고 admit / `VetoPath`를 발행하는 Plana
  진입 훅(`Plana.reviewRuntimeSettings`를 확장할 가능성 큼)을 추가. trait
  형태의 값을 수동 투영에서 능동 게이트로 승격. `src/`에서 역할이 Trait인
  첫 파일이 됨.

---

## §7. DT-Council Ultra 설계 검토로 옮겨진 역사적 미해결 질문

다음은 Council 검토로 옮겨진 **질문**이며 지시가 아니었다. 작성 컨텍스트 전용으로
보존되며 스캐폴드 정리를 활성 작업으로 다시 열지 않는다.

- "Driver" 라이프사이클 소유는 `AgentRuntime`에서 통일되어야 하는가, 아니면
  각 `DispatchBackend` 변종(인프로세스, gitlab-clone, 향후 컴퓨트 노드)이
  자체 드라이버 라이프사이클을 소유해야 하는가? 초안 시점 스캐폴드 스냅샷에는
  하나의 드라이버가 있었다. 질문은 그것이 확장되는지였다.
- Plana가 TRAIT 진입의 올바른 거처인가, 아니면 Plana가 구성하는 별도 `TraitGate`
  컴포넌트가 있어야 하는가? 별도 게이트는 정책 평가와 trait 진입을 직교
  유지하고, 융합된 Plana는 진입 이야기를 한 곳에 둔다.
- 컴퓨트 노드를 (인프로세스와 gitlab-clone과 동급인) **세 번째 `DispatchBackend`
  변종**으로 모델링해야 하는가, 아니면 SLURM 할당과 Apptainer 격리로 기존
  백엔드를 데코레이트하는 **래퍼**로 모델링해야 하는가? 사용자 보정 프레임은
  SLURM과 Apptainer가 함께 노출될 것을 요구하지만 변종-vs-래퍼를 미리 결정하지
  않는다.
- `discord-task-registry.ts`가 정본 태스크 상태를 보유해야 하는가, 아니면
  Dispatcher 스냅샷에서 파생된 표현 캐시만 보유해야 하는가? DT-Council
  Moderate 1과 조정.
- `-driver.ts` / `-adapter.ts` 접미사 구속(§4 모호성 #2 해결)이 lint나 디렉터리
  관례로 강제되어야 하는가, 아니면 검토 시점 점검으로 남아야 하는가?
- 두 번째 LLM 프로바이더가 결국 범위에 들어올 때, 동일 `RuntimeDriver` 포트
  뒤의 두 번째 Adapter로 나타나야 하는가, 아니면 새로운 Driver+Adapter 쌍으로
  나타나야 하는가? Codex 단일 제약은 이 질문을 연기하지만 답하지 않는다.

---

## §8. 수락 기준 (자족적 종결을 위해 재진술)

1. Adapter / Driver / Trait는 의존성 방향, 라이프사이클, 테스트 경계가 진술된
   명확한 정의(각 한 단락)를 갖는다. — §2.1, §2.2, §2.3가 다룸.
2. 분석된 초안 시점 `src/` 스캐폴드 스냅샷의 모든 파일이 {Adapter, Driver, Trait,
   Port-Contract, Domain-Core, Composition-Root, Other}에서 추출한 정확히 하나의
   카테고리로 분류된다. — §3.1부터 §3.7까지 다룸.
3. §4의 7가지 모호성 사례가 구속 결정으로 명시적으로 해결된다. — 각각
   Resolution 라인과 해당하는 후속 작업 단위 참조를 가진 §4 모호성 #1부터 #7이
   다룸.
4. 사용자 보정 프레임(1: templerun = 참조 지시 집합 전용; 2: compute node = SLURM
   + Apptainer 통합 추상화; 3: LLM 프로바이더 = Codex SDK 단일)이 사전에
   진술되고 전반에 걸쳐 일관되게 사용된다. — §0이 다루고 §5에서 운영적으로
   강화됨.
5. 분석된 초안 시점 스캐폴드 스냅샷의 어떤 파일도 TRAIT가 아니었음을 spec이
   기록하고, Plana 훅을 자연스러운 미래 TRAIT 진입 지점으로 식별한다. — §2.3
   (역사적 스냅샷 상태), §3.5 (그 스냅샷에서 의도적으로 비어 있음), 그리고
   §4 모호성 #7 / §6 WU-G (첫 TRAIT 소비자로의 경로)가 다룸.
