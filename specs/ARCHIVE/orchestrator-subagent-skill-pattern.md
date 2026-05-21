---
status: current
authority: implementation-explanation
last_verified: 2026-04-29
source_paths:
  - src/core/arona.ts
  - src/core/plana.ts
  - src/core/dispatcher.ts
  - src/runtime/subagent-operator.ts
  - src/runtime/subagent-roster.ts
  - src/contracts/capability-flag.ts
  - src/contracts/trait-module.ts
  - src/contracts/methodology-skill.ts
scope: 현재의 오케스트레이터/서브에이전트/스킬 패턴과 그 한도.
---

# 오케스트레이터 → 서브에이전트 → 스킬 패턴

## 현재 패턴

- **Arona**는 사용자 응대 오케스트레이터이자 디스패치 소유자이다.
- **Plana**는 정책 평가자이자 진입/런타임 검토 표면이다.
- **Dispatcher**는 제출과 취소 라이프사이클 경계이다.
- **서브에이전트 런타임**은 경계가 정해진 운영자 표면으로 존재한다. 현재 자세는
  깊이를 제한하고 루트 소유로 유지한다.
- **TraitModule 계층**은 지시문, 스케줄 선언, 런타임 훅 선언을 담는
  Auto Archive submodule plugin 표면이며 프로바이더 스위치가 아니다. 현재 가장
  분명한 예는 `trait.methodology.agent-methodology-origin.v1`이다.
- **CapabilityFlag 계층**은 compute/resource grant만 표현하며 TraitModule
  identity를 담지 않는다.

## 현재 한도

- 프로바이더 다중 런타임 라우팅 없음.
- 무경계 중첩 spawn 깊이 없음.
- 계획된 모든 목표 상태 역할이 완전히 적용되었다는 주장 없음.

## 불변식

1. TraitModule identity는 `src/contracts/trait-module.ts`, compute grant 어휘는
   `src/contracts/capability-flag.ts`에서 비롯된다.
2. 런타임/프로바이더 선택은 TraitModule에 위임되지 않는다.
3. 서브에이전트 작업은 오케스트레이터 소유와 현재 브랜치 안전 게이트 아래에
   머무른다.

## 테스트 경계

- `tests/`의 Dispatcher, roster, 방법론 소스 텍스트/단위 테스트.
