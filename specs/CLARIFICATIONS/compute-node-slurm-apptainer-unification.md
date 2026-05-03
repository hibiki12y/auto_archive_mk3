---
status: ratified
authority: binding-clarification
last_verified: 2026-04-29
source_paths:
  - src/core/compute-node.ts
  - src/core/compute-node-factory.ts
  - src/core/compute-node-slurm-apptainer.ts
scope: 통합된 컴퓨트 노드 프로덕션 솔기에 대한 구속 명확화.
---

# 컴퓨트 노드 = SLURM + Apptainer 통합

## 명확화

프로덕션 컴퓨트 경계는 하나의 통합된 `ComputeNode` 추상화이다.

- `slurm-apptainer`는 `AUTO_ARCHIVE_COMPUTE_NODE`가 미설정일 때의 프로덕션 기본값.
- `git-clone`과 `current-node`는 동일 포트의 다른 프로덕션 구현이다.
- 테스트 더블은 프로덕션 표면 바깥에 머무른다.

## 의미

- SLURM이 할당, 큐잉, 스케줄러 증거를 처리한다.
- Apptainer가 격리(containment)를 처리한다.
- 두 가지는 두 개의 동급 프로덕션 포트로 문서화되지 않는다.

## 불변식

1. 프로덕션 코드는 레거시 백엔드 분리가 아닌 `ComputeNode`로 말한다.
2. 프로바이더 다중화는 컴퓨트 노드 선택과 무관하다.
3. 자원 할당과 격리 증거는 동일한 실행 솔기에 귀속된다.
