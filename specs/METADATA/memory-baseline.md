---
status: stable
authority: spec-governance
last_verified: 2026-04-29
version: 1.0.0
source_paths:
  - PROJECT.md
  - specs/ARCHIVE/discord-control-plane-always-on.md
scope: Wave 1 Memory Baseline Freeze. text-truth alignment 컨트랙트와 promotion-gate taxonomy의 정본 정의. 본 브랜치 코드에 memory 모듈이 없는 상태를 baseline으로 고정한다.
---

# Memory Baseline Freeze (Wave 1)

## §1. 목적과 baseline

- **text-truth alignment 컨트랙트 정의**: 본 브랜치는 `src/`에 메모리/지식 저장
  모듈이 없음을 baseline으로 고정한다. 미래 메모리 표면 도입 시 본 spec의
  promotion-gate taxonomy를 통과해야 한다.
- 본 spec은 거버넌스 spec이며 런타임 동작을 직접 변경하지 않는다.
- **text-truth** = 저장소가 보유한 텍스트(코드, spec, IMPLEMENTATION_LOG, control
  ledger)가 정본이다. 외부 모델 메모리 또는 휘발성 컨텍스트는 진실 출처가 아니다.

## §2. Promotion-gate taxonomy

다음 promotion-gate 4종을 정의한다. 각 gate는 (1) 이름 (2) 정의 (3) 증거 요구를
가진다. 본 spec은 anchor만 정의하고, 실제 통과 절차는 별도 후속 spec(M2 Memory
Text Truth Contract, M3 Memory Experimental Containment and Promotion)으로 위임한다.

| Gate | 정의 | 증거 요구 |
| --- | --- | --- |
| `session-anchor` | 단일 세션 컨텍스트 보존(memory MCP session-scoped) | 세션 종료 시 anchor save record |
| `runtime-state-replay` | `runtime-state/*.jsonl` 같은 append-only 원장 리플레이 | JSONL schemaVersion 명시 + 리플레이 테스트 |
| `experimental-promotion` | bounded experimental memory 표면(future Wave 3) | 명시적 운영자 승인 + RFC entry |
| `macos-host-posture-promotion` | macOS Track b PROVISIONAL → PASS 승격 | host 세션 증거 + B1-H/B3-H 정합 |

## §3. 비목표

- bounded experimental promotion 자동 승격 금지 (본 게이트는 명시 운영자 승인을
  항상 요구)
- Discord context history를 자동으로 memory로 승격 금지 (always-on 컨트롤 플레인
  슬라이스의 신뢰·안전 불변식 보존: Discord 메시지는 신뢰할 수 없는 입력)
- 외부 모델 메모리(Codex SDK 내장)를 진실 출처로 취급 금지
- `templerun`을 runtime memory 출처로 취급 금지 (참조 전용)

## §4. Reference

- `resource/templerun/specs/memory-tier-redesign.md`: 참조 전용. 본 저장소가
  import/벤더링하지 않는다.
- `specs/ARCHIVE/discord-control-plane-always-on.md`: control ledger 컨트랙트
  (text-truth의 한 axis)
- `specs/ARCHIVE/methodology-skill-admission-governance.md`: methodology skill의
  진입/거버넌스 경계 (memory와 직교)

## §5. 후속 게이트

다음 항목은 **M2 Memory Text Truth Contract** (Wave 2)로 위임:

- text-truth precedence 규칙 (코드 vs spec vs control ledger 충돌 해결)
- promotion-gate 통과 절차의 정형화
- runtime-state replay 표면의 결정적 검증 절차

다음 항목은 **M3 Memory Experimental Containment and Promotion** (Wave 3)으로 위임:

- bounded experimental memory 표면의 격리 경계
- 실험 promotion의 운영자 승인 흐름
- 실험 결과의 baseline 승격 또는 폐기 절차
