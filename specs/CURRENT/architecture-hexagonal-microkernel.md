---
status: current
authority: implementation-explanation
last_verified: 2026-05-01
source_paths:
  - README.md
  - specs/CONTRACTS/microkernel-module-boundary.md
  - src/contracts/
  - src/core/
  - src/runtime/
  - specs/CLARIFICATIONS/multi-provider-scope.md
  - src/discord/
scope: 현재 브랜치 스캐폴드의 아키텍처 형태와 불변식.
---

# 헥사고날 + 마이크로커널 현재 아키텍처

## 현재 형태

- **헥사고날 경계**: `src/contracts/`가 안정된 포트/값 어휘를 정의하고, `src/core/`가 디스패치·정책·태스크·컴퓨트 오케스트레이션을 보유하며, runtime 및 Discord 계층이 외부 시스템을 그 계약 위로 어댑트한다.
- **마이크로커널 자세**: 저장소는 작은 오케스트레이션 커널(`Arona`, `Plana`, `Dispatcher`, `ComputeNode`)을 유지하고 그 주위에 서브에이전트, 방법론(methodology) 데코레이션, 승인 라우팅, Discord 컨트롤 플레인, GitLab 결과 기록 같은 경계가 명확한 능력 슬라이스를 추가한다.
- **현재 실행 솔기**: `Dispatcher`는 하나의 태스크를 하나의 `ComputeNode` 할당에 제출하고 하나의 `TerminalEvidence` 레코드를 반환한다.
- **현재 프로바이더 범위**: bootstrap-time multi-provider. 기본값은
  `codex`(`@openai/codex-sdk`)이며,
  `AUTO_ARCHIVE_RUNTIME_PROVIDER=claude-agent`는
  `@anthropic-ai/claude-agent-sdk` 기반 `ClaudeAgentRuntimeDriver`를 선택한다.
  선택은 서비스 시작 시 1회만 수행되며, mid-flight provider switching,
  runtime fan-out/council execution, Copilot CLI provider, OpenAI tool-calling
  bridge는 범위 밖이다. 구속 상세는
  `specs/CLARIFICATIONS/multi-provider-scope.md`가 가진다.
- **모듈 경계 표준**: `specs/CONTRACTS/microkernel-module-boundary.md`가
  `kernel-core`, `port-contract`, `infrastructure-adapter`, `trait-module`
  분류를 고정한다. TraitModule은 선택적 확장 계층이며 `Arona`,
  `Plana`, `Dispatcher`, `AgentRuntime`, `ComputeNode`, `RuntimeDriver`,
  `TerminalEvidence`, `CapabilityFlag`를 대체하지 않는다.

## 불변식

1. 계약은 `src/contracts/`에 머무르고, 어댑터가 외부 표면을 그 계약으로 변환한다.
2. `ComputeNode`는 통합 실행 추상화이다.
3. 정책 검토는 `Plana`를 통해 명시적으로 유지되고, 사용자 응대 오케스트레이션은 `Arona`가 담당한다.
4. 이 브랜치는 구현된 스캐폴드이지, 목표 상태의 완성을 주장하지 않는다.

## 테스트 경계

- `tests/` 하위 계약 및 오케스트레이션 테스트가 커널 표면을 검증한다.
- 라이브 Discord 증거는 REST 전용 시뮬레이션이 아닌 Peekaboo 직접 제어 경로에 머무른다.
