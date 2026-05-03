---
status: stable
authority: stable-contract-interpretation
last_verified: 2026-04-30
version: 1.0.0
source_paths:
  - src/contracts/admission-rule.ts
  - src/contracts/trait-module.ts
  - src/contracts/capability-flag.ts
  - src/core/admission-gate.ts
  - src/core/plana.ts
  - src/core/trait-module-loader.ts
  - specs/CONTRACTS/trait-module-versioning.md
scope: admission-rule, TraitModule id, capability flag 계약 의미의 안정적 해석.
---

# Admission Rule + Trait 계약

## 목적

실행이 진행되기 전에 진입 트리거, 규칙, 추적, TraitModule id, 그리고 compute
capability flag가 어떻게 표현되는지를 정의한다.

## 계약

- 진입 트리거 집합은 계약상 닫혀 있다.
- 규칙은 순수 `DispatchCtx` 스냅샷을 평가하여 `admit`, `deny`, 또는 `defer`를
  반환한다.
- `DispatchCtx.traits`는 admission hash 호환성을 위해 문자열 배열로 유지하며,
  새 의미론에서는 TraitModule id 또는 legacy opaque label만 담는다.
- compute/resource grant는 `DispatchCtx.traits`가 아니라
  `ComputeCapabilitySurface.capabilityFlags`와 `src/contracts/capability-flag.ts`에
  담는다.
- methodology integration의 정본 module id는
  `trait.methodology.agent-methodology-origin.v1`이다.
- TraitModule id의 `.vN` suffix는 contract-major identity이고 manifest `version`은
  package version이다. v1→v2 implicit rewrite는 금지되며, 공존/중복/마이그레이션
  정책은 `trait-module-versioning.md`가 정본이다.

## 라이프사이클 / 불변식

1. 정렬된 계층 전반에 걸쳐 first-deny-wins 적용.
2. 규칙 평가는 제공된 컨텍스트 스냅샷에 대해 순수하다.
3. TraitModule id 또는 capability flag 어휘 변경은 임시 리터럴이 아닌 명시적
   계약 변경을 요구한다.
4. Loader는 duplicate `TraitModuleId@manifest.version` registry key를 fail-closed로
   거부한다. 서로 다른 `.vN` id는 명시적 migration policy 없이 자동 대체되지 않는다.

## 테스트 경계

- 진입 게이트, Plana capability/TraitModule 소비자, 그리고 소스 텍스트 계약 테스트.
