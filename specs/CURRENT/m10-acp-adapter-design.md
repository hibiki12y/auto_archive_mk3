---
status: current
authority: implementation-explanation
last_verified: 2026-05-02
source_paths:
  - resource/hermes-agent/acp_adapter/
  - documents/references/hermes-agent/12-acp-server-editor-bridge.md
  - specs/CURRENT/hermes-pattern-adoption.md
  - src/discord/discord-command-registry.ts
  - src/acp/
  - tests/acp/
  - documents/host-setup-acp.md
scope: ACP(Agent Client Protocol) IDE 어댑터 — auto_archive_mk3를 Zed/VS Code/JetBrains 에디터에 노출하는 src/acp/ 슬라이스의 설계 + 실행 기록. 5-stage 실행이 완료되어 status=current로 격상되었다.
supersedes:
---

# M10 — ACP Adapter Design (executed; stages 1–5 landed)

## 0. 본 문서의 권한과 한계

- **권한**: `implementation-explanation` — 채택 결정의 기록이며 contract가 아니다. ACP wire shape의 contract는 SDK(`@agentclientprotocol/sdk`) 자체와 `src/acp/` 구현이 가진다.
- **상태 (2026-05-02)**: 5-stage 실행 완료. 본 spec은 설계 의도와 실제 land된 코드의 정합 기록을 함께 보관한다.
- **본 문서가 더 격상되는 시점**: 실 운영 1주 이상 incident 없이 dogfood되면 `stable`로 격상 + archive 후보 검토. 그전까지 `current`.

---

## 1. 배경

ACP(Agent Client Protocol)는 Zed Industries가 주도하는 에디터-에이전트 표준이다 (`https://agentclientprotocol.com/`). 핵심 가치:

- **양방향 stdio JSON-RPC**: 에디터가 자식 프로세스로 에이전트를 띄우고 stdin/stdout으로 통신.
- **Session abstraction**: 세션 생성/이력 재생/취소/포크가 표준 메서드로 노출.
- **Permission_request RPC**: 에이전트가 위험 작업 직전 에디터에 동의 요청 → 사용자가 IDE UI로 승인/거부.
- **Tool advertisement**: 에이전트가 자기 능력을 announce하면 에디터가 슬래시 명령으로 노출.

auto_archive_mk3는 현재 Discord-only 인터페이스이며, ACP 도입 시:
- 운영자가 IDE 내부에서 직접 슬래시 명령 사용
- IDE의 권한 UI 활용 (RuntimeApprovalRegistry의 IDE-side 카운터파트)
- 코드베이스 컨텍스트(현재 열린 파일)를 task instruction에 자동 첨부

Hermes는 `acp_adapter/` 9개 파일에 걸쳐 약 2,664 LOC Python으로 구현되어 있다 (`server.py` 1,210; `session.py` 634; `tools.py` 379; `events.py` 194; `permissions.py` 80; 기타). TypeScript 환산은 1,500-2,000 LoC 범위로 추산된다.

---

## 2. 의존 패키지 결정 (resolved 2026-05-02)

설계 시점의 후보 패키지 `@zed-industries/agent-client-protocol@0.4.5`는 **DEPRECATED** (7개월 전 폐기됨)으로 확인됨. 활성 후속 패키지는:

| 패키지 | 버전 | 라이선스 | 의존 | 상태 |
|---|---|---|---|---|
| `@agentclientprotocol/sdk` | `^0.21.0` | Apache-2.0 | `zod ^3.25 \|\| ^4` | **선택** (publish 4일 전) |
| `@zed-industries/agent-client-protocol` | `0.4.5` | Apache-2.0 | — | DEPRECATED |

`package.json`에 추가된 의존성은 정확히 1개 (`@agentclientprotocol/sdk`). `zod`는 이미 codex-sdk 경로로 트리에 있어 추가 transitive 부담은 0.

핵심 export: `AgentSideConnection`, `ClientSideConnection`, `Connection`, `TerminalHandle`, `RequestError`, `ndJsonStream`, schema type re-exports.

---

## 3. src/acp/ 디렉토리 레이아웃

Hermes 9개 파일을 5개 TS 모듈로 압축 (auto_archive_mk3에 이미 존재하는 인프라를 재활용하므로 분량 감소):

```
src/acp/
  index.ts                           # public surface re-exports
  acp-server.ts                      # ACP Agent class — initialize/authenticate/new_session/prompt/cancel
  acp-session-store.ts               # SessionState 관리, 이력 재생, 포크
  acp-permission-bridge.ts           # ACP permission_request ↔ RuntimeApprovalRegistry
  acp-tool-adapter.ts                # ACP tool_call ↔ existing trait runtime hooks
  acp-slash-commands.ts              # /help /tools /context /reset /compact /steer (M1 COMMAND_REGISTRY 재사용)
  acp-entrypoint.ts                  # `auto-archive acp` CLI launcher (스폰 가능한 stdio 바이너리)
contracts:
  src/contracts/acp-session.ts       # SessionState, SessionModelState 타입
  src/contracts/acp-tool.ts          # ToolDescriptor, ToolCall 타입
  src/contracts/acp-permission.ts    # PermissionRequestKind, PermissionDecision
```

---

## 4. Hermes → auto_archive_mk3 매핑

| Hermes 파일 | LOC | TS 카운터파트 | 차이 |
|---|---|---|---|
| `acp_adapter/server.py` | 1,210 | `src/acp/acp-server.ts` | initialize/authenticate/new_session/prompt 메서드는 그대로 차용. `_register_session_mcp_servers`는 우리 환경에 MCP 미통합이라 제거 (필요 시 후속). 슬래시 명령 핸들러(`_cmd_help` 등 7개)는 M1 COMMAND_REGISTRY로 위임. |
| `acp_adapter/session.py` | 634 | `src/acp/acp-session-store.ts` | SessionState 자체는 거의 그대로. 이력 저장은 control-plane-ledger의 conversation.* 이벤트를 재사용. |
| `acp_adapter/tools.py` | 379 | `src/acp/acp-tool-adapter.ts` | tool advertisement는 trait module manifest로 동적 생성. tool 호출은 codex/claude-agent SDK가 내부 처리하므로 어댑터는 thin proxy. |
| `acp_adapter/events.py` | 194 | `src/acp/acp-server.ts`(임베드) | 이벤트 변환 헬퍼만 필요 — 분리할 가치 없음. |
| `acp_adapter/permissions.py` | 80 | `src/acp/acp-permission-bridge.ts` | RuntimeApprovalRegistry(M0c-era)로 위임. ACP의 PermissionRequest는 바로 ApprovalRequest로 변환. |
| `acp_adapter/auth.py` | 24 | `src/acp/acp-server.ts`(임베드) | 24 LOC만 흡수. |
| `acp_adapter/entry.py` | 137 | `src/acp/acp-entrypoint.ts` | argparse → commander/단순 process.argv. logging은 우리 logger. |
| `acp_adapter/__main__.py` | 5 | `bin/auto-archive-acp.ts`(신규) 또는 package.json `bin` 항목 | 자식 프로세스 진입점. |

**TS 환산 LOC 추정 (모듈별 상한)**:
- `acp-server.ts`: 600
- `acp-session-store.ts`: 250
- `acp-tool-adapter.ts`: 200
- `acp-permission-bridge.ts`: 100
- `acp-slash-commands.ts`: 150
- `acp-entrypoint.ts`: 80
- contracts (3 파일): 100 합계
- index.ts: 30
- **합계**: ~1,510 LOC + 신규 단위테스트 ~600 LoC = 약 2,100 LoC

플랜 §B.3가 명시한 1,500 LoC 추정의 범위 내. 큰 footprint이므로 본 plan에서 분리한 결정은 정당.

---

## 5. 인터페이스 재사용 매트릭스

ACP 어댑터가 *재사용*하는 기존 인프라:

| 기존 모듈 | ACP에서의 역할 |
|---|---|
| `Arona` | new_session으로 들어오는 instruction을 `arona.handle()`로 그대로 주입 |
| `Dispatcher` | session prompt → dispatch.submit. ACP 세션은 dispatch 단위로 1:1 매핑 |
| `RuntimeApprovalRegistry` | ACP permission_request의 모든 백엔드 |
| `Plana` (curator/policy) | 변경 없음 — ACP는 단지 새로운 invocation surface |
| `M1 COMMAND_REGISTRY` | ACP `_available_commands` advertisement의 진실 소스 |
| `M3 prompt-cache invariant` | ACP fork_session = `rotateSession` 트리거 |
| `M5b commandIntercept` hooks | ACP 슬래시 명령도 commandIntercept를 통과 (단일 게이트) |
| `M5c providerSelectObserve` | ACP 세션 시작 시 자동으로 발화 |
| `M5c doctorProbeObserve` | `/doctor` ACP 슬래시 = 동일 코드 경로 |
| `M6 InsightsEngine` | ACP `/stats` 또는 `/insights` 명령 |
| `M9 SILENT_MARKER` | ACP에서도 silent 출력은 IDE에 표시되지 않음 |

ACP 어댑터가 *교체*하는 부분: **없음**. 모든 기존 인프라는 그대로 두고, ACP는 *새 channel*을 추가하는 형태.

ACP 어댑터가 *추가로 도입*하는 surface:
- ACP wire protocol 디코더/인코더 (의존 패키지가 처리)
- IDE-쪽 progressive update (assistant_message_chunks, tool_use_started, …)
- session 영속 (SessionState 직렬화)

---

## 6. 권한 흐름 (Permission Bridge)

가장 보안-민감한 surface. 이미 land된 `RuntimeApprovalRegistry`를 그대로 백엔드로 사용:

```
[ACP client]                [acp-permission-bridge]              [RuntimeApprovalRegistry]
    │                              │                                       │
    │ permission_request           │                                       │
    ├──────────────────────────────►                                       │
    │                              │ register(approval)                    │
    │                              ├───────────────────────────────────────►
    │                              │                                       │
    │                              │ approval-request envelope             │
    │                              │◄──────────────────────────────────────┤
    │ permission_response          │                                       │
    │◄──────────────────────────────                                       │
    │                              │ resolve(approvalId, decision)         │
    │                              ├───────────────────────────────────────►
```

`RuntimeApprovalRegistry.resolve()`는 이미 `single-use`, `drift`, `replay`, `expiry` 검사를 수행하므로 ACP bridge는 검증을 *추가하지 않고* 위임만 한다.

**미해결 질문 #2**: ACP의 `permission_request` 메서드가 모든 IDE에서 지원되는지 SDK 문서로 확인. 일부 IDE는 placeholder UI만 가지고 있을 가능성. 기본 정책: IDE 미지원 시 `denied` (fail-closed).

---

## 7. 세션 라이프사이클

| ACP 메서드 | auto_archive_mk3 매핑 |
|---|---|
| `initialize` | factory가 `runtime-driver`만 만들고 dispatcher는 *세션마다* 새로 생성 |
| `authenticate` | 토큰 검증 → `discord-auth-database` 패턴 미러 (별도 file-based store) |
| `new_session` | 신규 SessionState 생성 + control-plane-ledger에 `session.binding_created` 발행 |
| `load_session` | SessionState 디스크에서 로드 + ledger 재생 |
| `resume_session` | load + 이력 replay |
| `cancel` | dispatcher.cancel(taskId) |
| `fork_session` | M3 `rotateSession` 호출 + 새 sessionId로 lineage 기록 |
| `list_sessions` | session-store query |
| `prompt` | dispatcher.submit() + 스트림 결과를 ACP assistant_message_chunk로 변환 |

---

## 8. 슬래시 명령 통합

M1의 `COMMAND_REGISTRY`는 이미 단일 진실 소스. ACP는 그대로 import하여 advertisement 생성:

```ts
// acp-slash-commands.ts (개념)
import { COMMAND_REGISTRY } from '../discord/discord-command-registry.js';

export function buildAvailableCommands(): readonly AcpAvailableCommand[] {
  return COMMAND_REGISTRY
    .filter((cmd) => isAcpCompatible(cmd))
    .map((cmd) => ({ name: cmd.name, description: cmd.description }));
}
```

`isAcpCompatible` 게이트로 Discord-전용 명령(`/agenda` 등 일부)은 자동 제외 가능. M1이 등록한 모든 명령에 `surfaceTags?: ('discord'|'acp')[]` 옵션 필드를 추가하면 깔끔하지만, **본 design-only 단계에서는 결정 보류** — 실행 plan에서 정한다.

---

## 9. 단계적 land 전략

본 design을 실행 plan으로 옮길 때 권장 단계:

### Stage 1 — Skeleton (~300 LoC)
- 의존 패키지 추가
- `acp-entrypoint.ts` + `bin/auto-archive-acp.ts`
- `acp-server.ts`의 `initialize` / `authenticate` / `new_session` 만 구현
- `pnpm acp:dev`로 stdin/stdout 핸드셰이크 검증
- 기존 1,308 테스트가 모두 그대로 통과 — ACP는 별도 entry point이므로 디폴트 흐름 비영향

### Stage 2 — Prompt round-trip (~500 LoC)
- `prompt` 메서드 → dispatcher.submit
- streaming response → assistant_message_chunk 변환
- `cancel` 메서드 → dispatcher.cancel
- E2E test: fake ACP client로 prompt → response

### Stage 3 — Permission + slash commands (~400 LoC)
- `acp-permission-bridge.ts`로 RuntimeApprovalRegistry 위임
- `acp-slash-commands.ts`로 COMMAND_REGISTRY 어댑테이션
- M5b `commandIntercept` 훅 통과 보장

### Stage 4 — Session persistence (~200 LoC)
- SessionState 디스크 영속
- load_session / resume_session / fork_session
- M3 prompt-cache invariant와의 lineage 통합

### Stage 5 — Polish (~100 LoC)
- Error envelope 정합화
- 로깅 라벨 통일 (`acp-server-error`, `acp-permission-bridge-denied`, …)
- 문서: `documents/host-setup-acp.md` 신규 (운영 런북)

각 stage가 독립적으로 land 가능하며, stage 1 land 후 dogfood 1주 → stage 2 등으로 진행 권장. 한꺼번에 5 stages를 push하면 본 plan을 분리한 이유에 반한다.

---

## 10. 위험 평가

| ID | 위험 | 완화 |
|---|---|---|
| M10-R1 | ACP wire 호환성 — IDE 별로 sub-version 차이 | 의존 패키지의 versioning posture를 먼저 확인. 미발행이면 wire spec 직접 구현 + 통합 테스트는 mock client. |
| M10-R2 | session persistence 신규 surface (디스크 IO 추가) | JSON 파일 단순 영속 — DB/SQLite 도입은 후속. JsonlControlPlaneLedger와 같은 패턴. |
| M10-R3 | permission_request UI 부재 IDE | fail-closed 기본. 사용자에게 IDE upgrade 안내 메시지. |
| M10-R4 | Discord 명령 ↔ ACP 명령 drift | M1 COMMAND_REGISTRY가 단일 소스이므로 자동 동기. surfaceTags 필드는 stage 3에서 결정. |
| M10-R5 | ACP 어댑터 자체 dependency가 다른 코드 surface 오염 | `src/acp/`는 **다른 어디에서도 import되지 않는 leaf**. discord/runtime/core가 acp를 부를 일 없음. 역방향 의존 deny lint 룰 후속. |

---

## 11. 본 design의 미해결 질문 (모두 resolved 2026-05-02)

실행 plan(`~/.claude/plans/2-acp-adapter-execution.md`) 시작 시점에 모두 해결됨:

1. ✅ **ACP SDK 패키지 발행 상태** — `@agentclientprotocol/sdk@^0.21.0` 활성. 설계 시점 후보 `@zed-industries/agent-client-protocol`는 deprecated.
2. ✅ **IDE permission_request 지원 매트릭스** — 프로토콜이 client capability flag로 advertise하지 않음. fail-closed 기본 (error/timeout/cancelled = `denied`). 실제 land된 매핑: `acp-permission-bridge.ts`.
3. ✅ **session persistence 위치** — `${AUTO_ARCHIVE_HOME:-${HOME}/.auto-archive}/acp-sessions/<sessionId>.json`, atomic `.tmp+rename`, mode 0o600. `JsonAcpSessionStore`.
4. ✅ **bin entry point** — `package.json` `bin: { auto-archive-acp: dist/src/acp/acp-entrypoint.js }`. 별도 npm 패키지 분리 X.
5. ✅ **stage cadence** — Stage 1 → 1주 dogfood → Stage 2~5 sequential이 권장 시퀀스였으나 운영자 결정으로 dogfood window를 waive하고 같은 날 5 stage 모두 land. 운영자 권한 내 결정.
6. ✅ **테스트 전략** — `PassThrough` 기반 fake-stdio client로 자동 회귀 (74 tests across 7 files). IDE smoke는 Zed 우선, manual.

---

## 12. 본 design 닫기 조건 (충족 2026-05-02)

- ✅ 실행 plan(`~/.claude/plans/2-acp-adapter-execution.md`) 5 stage 모두 land
- ✅ `src/acp/` 존재 + 7 spec file / 74 tests PASS / `pnpm build` clean
- ✅ 본 spec `status: current` (위 frontmatter)
- ✅ `documents/references/hermes-agent/12-acp-server-editor-bridge.md` "Adoption Notes" 섹션 본 spec 링크 포함 — Stage 5 close-out에서 갱신
- ✅ `specs/CURRENT/hermes-pattern-adoption.md` §2 행 12 + §4 M10 행 `stages 1–5 landed` 갱신
- ✅ 운영 runbook `documents/host-setup-acp.md` 작성

---

## 13. 외부 링크

- Hermes ACP: `resource/hermes-agent/acp_adapter/`
- Reference 문서: `documents/references/hermes-agent/12-acp-server-editor-bridge.md`
- 본 plan 출처: `~/.claude/plans/1-hermes-starry-hummingbird.md` §B.3 M10 + §B.5 risk-assessment
- ACP 표준 공식: https://agentclientprotocol.com/
