---
status: ratified
authority: binding-clarification
last_verified: 2026-04-30
version: 1.1.0
supersedes: specs/CLARIFICATIONS/codex-sdk-provider-scope.md
source_paths:
  - README.md
  - specs/CURRENT/codex-sdk-runtime-bootstrap.md
  - src/runtime/codex-runtime-adapter.ts
  - src/runtime/claude-agent-runtime-adapter.ts
  - src/runtime/runtime-driver-factory.ts
  - src/core/plana.ts
  - src/core/plana-runtime-advisor.ts
  - src/core/plana-claude-runtime-advisor.ts
scope: Codex + Claude Agent 이중 프로바이더 범위에 대한 구속 명확화. selection seam, 허용된 인증 경로, 비용/감사 invariant 정의. 1.1.0에서 cross-vendor advisor 패턴 (Plana review consultation) 허용 추가.
---

# 다중 프로바이더 범위 (Codex + Claude Agent)

## 정책 변경 배경

직전 명확화(`codex-sdk-provider-scope.md`)는 "Codex SDK 단일"을 명시했다. 본 spec이 이를 supersede하여 두 프로바이더 동시 운용을 허용한다.

직접적 변경 트리거:
- Anthropic이 2026-04-04자 third-party agent framework 차단 정책을 그 후 철회. `claude -p` (헤드리스 CLI) 및 Claude Agent SDK 통한 third-party 프레임워크 임베딩이 다시 sanctioned 됨. 출처: `https://news.hada.io/topic?id=28761`, `https://docs.openclaw.ai/providers/anthropic`.
- Anthropic 공식 SDK인 `@anthropic-ai/claude-agent-sdk` (TypeScript)와 `claude-agent-sdk` (Python)이 `@openai/codex-sdk`와 거의 1:1 등가 표면 제공. 정본: `https://code.claude.com/docs/en/agent-sdk/typescript`.
- 본 프로젝트의 LLM provider 단일성은 정책 결정이었지 구조적 제약이 아니었으므로, 정책 환경이 바뀌면 명확화도 갱신한다.

## 구속 진술

런타임 프로바이더는 다음 두 가지 중 하나로 선택된다.

1. **`codex`** — `@openai/codex-sdk` 기반. 기본값 (default).
2. **`claude-agent`** — `@anthropic-ai/claude-agent-sdk` 기반.

선택은 환경변수 `AUTO_ARCHIVE_RUNTIME_PROVIDER`로 부트스트랩 시점에 1회 결정된다. 한 dispatch 안에서의 mid-flight 전환은 범위 외.

## 범위 내

- `src/runtime/codex-runtime-adapter.ts` (CodexRuntimeDriver) — 기본 driver.
- `src/runtime/claude-agent-runtime-adapter.ts` (ClaudeAgentRuntimeDriver) — Anthropic Agent SDK 기반 두 번째 driver.
- `src/runtime/runtime-driver-factory.ts` (혹은 동급) — `AUTO_ARCHIVE_RUNTIME_PROVIDER`를 읽어 적절한 driver를 instantiate하는 부트스트랩 helper.
- 두 driver 모두 동일한 `RuntimeDriver` port (`src/contracts/runtime-driver.ts`)를 구현.
- 양쪽의 인증 부트스트랩: API 키 (env-backed) + 로컬 CLI 인증 (선택적). 형식은 각 driver의 spec/CURRENT 문서에서 상세화.

## Advisor 패턴 (1.1.0 추가)

본 amendment에서 cross-vendor **review consultation** 패턴 한 가지를 명시적으로 허용한다. 이는 "두 driver 동시 spawn 금지"의 *예외*가 아니라 *경계 정의*이다 — runtime fan-out (같은 task를 두 provider에 dispatch하여 결과 비교)은 여전히 금지된다.

### 정의

**Plana runtime advisor** = dispatched task 진행 중 발생하는 `RuntimeEvent` stream을 read-only로 받아 *조언/거부* verdict를 내는 컴포넌트. Plana는 advisor가 'veto' verdict를 내면 자체 `VetoPath`를 합성하여 dispatched task를 중단시킬 수 있다.

권한:
- Advisor는 dispatched task를 *대신 실행*하지 않는다. dispatch는 한 driver에서만 일어난다.
- Advisor는 도구 호출, 파일 작성, MCP 호출을 하지 않는다. single-shot prompt → verdict.
- Advisor는 자기 자신의 dispatch를 spawn하지 않는다 (재귀 금지).

설정:
- `AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER=claude-agent` 시 활성화. unset = no advisor (룰 기반 review만).
- Advisor provider가 `AUTO_ARCHIVE_RUNTIME_PROVIDER`와 *달라야 함*은 강제되지 않는다 (둘 다 codex여도 작동); 그러나 권장 조합은 dispatched task와 advisor가 다른 vendor — "서로 다른 관점에서 평가" 의도와 일치.

비용 invariant:
- Advisor 호출 횟수는 dispatch당 명시적으로 bound (`AUTO_ARCHIVE_PLANA_ADVISOR_MAX_CALLS`, default 5).
- Advisor 호출은 sampling됨 — 모든 event가 아니라 `item.completed` (`error`/`agent_message`/`reasoning`) + `approval.requested`만.
- Advisor 호출 실패 (network, parse error)는 `'approve'`로 fail-open. Advisor가 review를 막지 못한다고 dispatched task가 막혀서는 안 된다.

감사:
- Advisor verdict는 `runtime-state/plana-advisor-events.jsonl` 옵션 ledger에 append.
- Advisor가 issued한 veto의 `provenance`는 `plana-claude-runtime-advisor` (또는 `plana-codex-runtime-advisor`) — dispatched task driver provenance와 구분 가능.

## 범위 외

- mid-flight provider 스위치 (한 dispatch 도중 switch).
- per-trait 또는 per-channel provider 라우팅 (모두 부트스트랩-time global 선택만).
- 두 driver를 동시 instantiate하여 *runtime fan-out* council을 구성하는 패턴 (같은 task를 두 provider에 동시 dispatch하여 결과 비교 — runtime에서 동시 spawn 금지). Advisor 패턴은 위 §Advisor 패턴에서 정의한 read-only review consultation에 한정된다.
- Anthropic Subscription OAuth 토큰을 컨테이너/공유 호스트에 배포하여 다중 사용자가 공유하는 패턴. **Anthropic Usage Policy의 "single-user account" 원칙을 따르며, 컨테이너/CI에는 API 키만 마운트한다.**
- 두 번째 프로바이더가 추가됨에 따른 비용 추상화 신규 도입은 본 spec에서는 하지 않음 (프로바이더별 cost 측정은 각 driver의 책임).

## 인증 invariant

| 프로바이더 | 허용 인증 | 명시적 금지 |
| --- | --- | --- |
| `codex` | `AUTO_ARCHIVE_CODEX_API_KEY` (env), `~/.codex/auth.json` (로컬 CLI 우선) | OpenAI 공유 API 키를 다중 사용자/컨테이너에 동시 마운트 |
| `claude-agent` | `AUTO_ARCHIVE_ANTHROPIC_API_KEY` (env), `pathToClaudeCodeExecutable`로 지정된 로컬 `claude` 바이너리(--bare 모드는 OAuth 스킵하므로 API 키만) | Pro/Max OAuth 토큰을 단일 사용자 외 환경에 배포; `~/.claude/` 토큰을 다중 컨테이너 인스턴스에 공유 마운트 |

`claude-agent` 프로덕션 권고: `--bare` 모드 + `ANTHROPIC_API_KEY`. OAuth 경로는 dev/local-only.

## 라이프사이클 / 불변식

1. 부트스트랩-time `AUTO_ARCHIVE_RUNTIME_PROVIDER` 값이 모든 dispatch에 단일하게 적용됨. 미설정 시 `codex` 기본.
2. 각 dispatch 결과의 `TerminalEvidence.provenance`는 사용된 driver를 식별 (`codex-runtime-driver` 또는 `claude-agent-runtime-driver`).
3. `claude-agent` 사용 시 `SDKResultMessage.total_cost_usd`, `usage`, `modelUsage`, `permission_denials`가 terminal evidence의 supplementary 필드로 기록됨 (선택적, schema additive).
4. provider failure cause (`TerminalCauseProviderFailure`)는 두 driver 공통 4-axis 분류(WU-H §6.12)를 따른다.
5. doctor는 부트스트랩-time 선택된 provider와 인증 경로의 readiness를 보고한다. `current-node` 등 호환되지 않는 경로 조합에서는 WARN.

## 검증 경계

- 각 driver는 자체 단위 테스트 셋(`tests/codex-runtime-adapter.spec.ts`, `tests/claude-agent-runtime-adapter.spec.ts`)을 가진다.
- 부트스트랩 selection helper (`runtime-driver-factory`)는 env 매트릭스 단위 테스트로 검증.
- doctor는 두 provider의 readiness(API 키 부재, CLI 경로 부재 등)를 모두 surface해야 한다.
- 통합/end-to-end는 라이브 자격증명이 필요하므로 본 spec의 검증 게이트 외부.

## 사후-정책 trip-wire

Anthropic이 third-party agent framework 정책을 다시 변경하여 `claude-agent` 경로가 봉쇄될 경우의 roll-back:

1. doctor의 `Runtime provider scope` section을 FAIL로 강등하는 신호 추가 (CLI 인증 거부, 401 from API 등 자동 감지).
2. 부트스트랩에서 `AUTO_ARCHIVE_RUNTIME_PROVIDER=claude-agent` 명시 설정을 일시적 거부 (env override 필요)하는 정책 spec 신규 추가.
3. 본 spec은 "ratified" 상태를 유지하되 `## 사후-정책 trip-wire` section에 변경 사유를 적는다.

이 trip-wire는 본 spec의 binding-clarification 권한 범위 내의 선언이며, 코드 변경 트리거는 별도 WU.

## 주요 동반 문서

- `../CURRENT/codex-sdk-runtime-bootstrap.md` (codex driver 부트스트랩)
- `../CURRENT/claude-agent-runtime-bootstrap.md` (claude-agent driver 부트스트랩, 신설 예정)
- 정책 출처: `https://news.hada.io/topic?id=28761`, `https://docs.openclaw.ai/providers/anthropic`, `https://code.claude.com/docs/en/agent-sdk/typescript`
