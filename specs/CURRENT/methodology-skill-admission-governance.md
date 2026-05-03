---
status: current
authority: implementation-explanation
last_verified: 2026-04-29
source_paths:
  - README.md
  - src/contracts/trait-module.ts
  - src/contracts/capability-flag.ts
  - src/contracts/methodology-skill.ts
  - src/core/plana.ts
  - src/runtime/methodology-skill-runtime-driver.ts
  - tests/agent-methodology-origin-integration.spec.ts
scope: 현재의 methodology TraitModule, 진입 경계, 증거 전용 런타임 데코레이터, 그리고 사용 한도.
---

# Methodology-Skill 진입 거버넌스

## 1. 목적과 구속 경계

이 작업 단위는 매핑된 방법론(methodology)을 Auto Archive 에이전트 운영에
저장소가 소유하는 진입/거버넌스 TraitModule과 옵트인 증거 전용 런타임 데코레이터를
통해 통합한다.

구속 경계:

- `resource/templerun`은 참조 전용이다.
- 런타임 컴포넌트가 아니다.
- 프로바이더가 아니다.
- 인프로세스 컴포넌트가 아니다.
- Auto Archive 에이전트는 `resource/templerun`의 지시 텍스트를 import, 복사,
  실행 또는 프롬프트 주입해서는 안 된다.
- 저장소가 소유하는 methodology TraitModule
  `trait.methodology.agent-methodology-origin.v1`은 진입/거버넌스 전용으로
  유지된다. 기존 `methodology-skill` 문자열은 profile/legacy 설명 텍스트로만
  남으며 compute capability flag가 아니다.
- 런타임이 뒷받침하는 동작은 증거 전용 런타임 데코레이터로 한정된다.
- 증거 전용 런타임 데코레이터는 프롬프트 콘텐츠, 프로바이더 선택, Codex SDK
  옵션, 런타임 설정, 또는 종료 원인 의미를 변경해서는 안 된다.

본 spec은 `resource/templerun`에 대한 어떤 숨은 의존도, 프로바이더/런타임 모드
스위치도 승인하지 않으며, 방법론 출처를 부트스트랩 셀렉터로 변환하지 않는다.

---

## 2. 출처 증거에 대한 내부 발견

내부 발견:

- `resource/templerun`에서 명시적인 학술 인용은 발견되지 않았다.
- 따라서 가장 가까운 방법론 계보는 그 참조 자료에서 명시적 인용 흔적으로
  주장되는 것이 아니라 프로토콜 형태로부터 추론된다.
- 본 저장소에서 출처에 관한 어떤 진술도 `resource/templerun`이 해당 논문을 직접
  인용하거나 구현한다고 주장하는 형태가 아니라 best-fit 출처 매핑으로 표현되어야
  한다.

---

## 3. 방법론 형태에 대한 best-fit 출처 매핑

| 방법 계열 | 가장 근접한 매핑 출처 | Auto Archive 해석 |
| --- | --- | --- |
| Chain-of-Thought 프롬프팅 | https://arxiv.org/abs/2201.11903 | 출력은 숨겨진/사적 chain-of-thought 덤프가 아닌 관찰 가능한 요약으로 유지하면서, 구조화된 분해와 중간 추론 규율을 사용한다. |
| Self-Consistency / Best-of-N | https://arxiv.org/abs/2203.11171 | 다중 후보 접근을 비교한 뒤 명시적 기준, 증거, 분기 진실성으로 선택한다. |
| Tree of Thoughts | https://arxiv.org/abs/2305.10601 | 구현 또는 운영자 행동에 커밋하기 전 경계가 정해진 대안 분기를 탐색한다. |
| Graph of Thoughts | https://arxiv.org/abs/2308.09687 | 너무 일찍 단일 선형 초안을 강요하는 대신 교차 연결된 옵션, 의존성, 증거를 추적한다. |
| ReAct | https://arxiv.org/abs/2210.03629 | 추론 요약과 파일 검사, 코드 편집, 테스트, 증거 캡처 같은 구체적 행동을 교대로 수행한다. |
| Constitutional AI | https://arxiv.org/abs/2212.08073 | 저장소 규칙, 프로젝트 게이트, 범위 한도, 그리고 명시된 정책 텍스트에 대한 자기 비판을 적용한다. |
| Process supervision | https://arxiv.org/abs/2305.20050 | 검증되지 않은 최종 답변 신뢰 대신 단계별 검토, 테스트, 검증 산출물, 수락 점검을 우선한다. |
| Red-teaming language models | https://arxiv.org/abs/2209.07858 | 실패 모드 검토, 프롬프트 경계 강화, 오용 분석을 일급 운영자 안전장치로 취급한다. |

이는 방법론 출처 추론을 위한 출처 매핑이다. 본 저장소가 위 논문 또는
`resource/templerun`을 임베드하거나, 벤더링하거나, 런타임 실행한다는 주장이
아니다.

---

## 4. 허용된 통합 모드

본 작업 단위에서 허용:

- 정본 TraitModule manifest `trait.methodology.agent-methodology-origin.v1`
- methodology TraitModule에 대한 Plana 진입/거버넌스 처리
- 증거 전용 런타임 데코레이터를 위한 명시적 옵트인 컴포지션 헬퍼
- 관찰 가능한 요약, 기준, 체크포인트, 출처 매핑 id를 사용하는 증거 전용
  런타임 데코레이터 체크포인트
- 운영자와 에이전트를 위한 문서 표준
- 현재 브랜치 사용과 경계를 구속하는 spec 텍스트
- 소스 텍스트/문서 계약 테스트
- 관찰 가능한 추론 요약, 결정 기준, 증거 참조, 검증 산출물
- 분기 비교, 후보 평가, 검토 체크포인트로 기술된 경계가 정해진 다중 옵션 계획
- 라이브 상호작용 증거 경로로서의 Peekaboo/Discord 직접 제어 검증

---

## 5. 금지된 모드

본 작업 단위에서 금지:

- `resource/templerun`을 런타임 의존성으로 취급
- `resource/templerun`을 프로바이더 스위치 또는 부트스트랩 모드로 취급
- methodology TraitModule을 프로바이더 스위치 또는 프롬프트 출처 스위치로 취급
- `src/` 아래에서 `resource/templerun`을 import
- `resource/templerun`의 지시 텍스트를 런타임 프롬프트나 코드에 복사
- `resource/templerun` 콘텐츠의 실행 또는 프롬프트 주입
- 리터럴 `templerun` 트레이트 종류 도입
- 발견되지 않은 명시적 학술 인용이 `resource/templerun`에 있다고 주장
- 관찰 가능한 요약과 증거 대신 숨겨진/사적 chain-of-thought 노출 요청
- 현재 스캐폴드 브랜치를 프로덕션 준비된 자율 프레임워크로 표현

---

## 6. 라이브 검증과 증거 경로

본 방법론 통합의 라이브 상호작용 검증은 합성 런타임 주장이 아닌
Peekaboo/Discord 직접 제어 경로이다.

요구되는 증거 자세:

- macOS agent-node + Peekaboo + Discord 데스크톱 경로를 통한 자연어 직접 제어
- 라이브 변경 이전의 readiness 분리
- 캡처된 결과에 대한 증거 점수
- 지속형 원장 append/query 지원
- 무경계 자율 실행이 아닌 경계가 정해진 배치 계획

이 경로는 현재 브랜치 경계(평가된 스캐폴드 표면이지 프로덕션 준비된 자율은
아님)를 보존하면서 실제 방법론 사용에 대한 운영자 가시 증거 표면을 제공한다.

---

## 7. TraitModule과 거버넌스 경계

본 작업 단위에서 적용된 정본 변경:

- `src/contracts/capability-flag.ts`는 compute/resource grant만 포함하며
  `methodology-skill`을 포함하지 않는다.
- `src/contracts/trait-module.ts`는 Auto Archive submodule plugin으로서의
  TraitModule manifest 계약을 정의한다.
- `src/contracts/methodology-skill.ts`는
  `trait.methodology.agent-methodology-origin.v1` built-in manifest를 export한다.
- methodology TraitModule은 진입/거버넌스 표면이며, 런타임/프로바이더 스위치가
  아니다.
- 첫 번째 런타임 뒷받침 동작은 저장소가 소유하는 증거 전용 런타임
  데코레이터로 한정된다.
- 데코레이터는 옵트인 컴포지션 전용이다. 본 작업 단위는 프로덕션 기본 배선을
  의미하지 않는다.
- 증거 전용 데코레이션을 넘어선 향후 확대는 별도 검토를 요구한다.

---

## 8. 적용된 산출물

본 spec은 다음 저장소 산출물에 의해 구현된다.

- `src/contracts/methodology-skill.ts`
- `src/core/plana.ts`
- `src/runtime/methodology-skill-runtime-driver.ts`
- `README.md` 브랜치 상태 노트
- `PROJECT.md` 메타데이터 노트
- `tests/agent-methodology-origin-integration.spec.ts`
