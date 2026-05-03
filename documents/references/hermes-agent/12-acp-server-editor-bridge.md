---
status: stable
authority: external-code-reference
last_verified: 2026-05-01
source_paths:
  - resource/hermes-agent/acp_adapter/
scope: Hermes Agent ACP server (editor bridge) 서브시스템의 reference material. auto_archive_mk3 동작에 대한 contract가 아니며 참조 전용.
---

# 12 — ACP Server (Editor Bridge)

## 1. Purpose & Boundary

`acp_adapter/`(~100KB, 7개 모듈)는 Hermes `AIAgent`를 **Agent Client Protocol (ACP)** 위에 노출해 VS Code/Zed/JetBrains와 stdio JSON-RPC 양방향 통신을 가능케 한다. 슬래시 커맨드 광고, multimodal 이미지 입력, 도구 승인 sync↔async 브리지, 세션 영속(SessionDB)/재개/fork, 모델 전환 알림이 책임이다. **본 문서는 ACP 외부 계약과 Hermes 내부 콜백 매핑**을 정리한다.

## 2. Source Anchors

| 항목 | 위치 |
| --- | --- |
| `class HermesACPAgent` + 모듈 docstring | `resource/hermes-agent/acp_adapter/server.py:1, 157-170` |
| ACP schema import 표면 | `resource/hermes-agent/acp_adapter/server.py:13-51` |
| `_image_block_to_openai_part()` (multimodal) | `resource/hermes-agent/acp_adapter/server.py:104-117` |
| `_SLASH_COMMANDS` / `_ADVERTISED_COMMANDS` | `resource/hermes-agent/acp_adapter/server.py:160-212` |
| `initialize()` (capabilities 광고) | `resource/hermes-agent/acp_adapter/server.py:389-430` |
| `_available_commands` / `_send_..._update` / `_handle_slash_command` | `resource/hermes-agent/acp_adapter/server.py:911-986` |
| approval callback 등록 (TLS) | `resource/hermes-agent/acp_adapter/server.py:752, 766-770` |
| `make_approval_callback()` + 매핑 | `resource/hermes-agent/acp_adapter/permissions.py:18-80` |
| `SessionState` / `SessionManager` / SessionDB persist | `resource/hermes-agent/acp_adapter/session.py:169-207, 399-421` |
| `entry.py` main + benign probe filter | `resource/hermes-agent/acp_adapter/entry.py:31-133` |
| ACP 의존성 선언 | `resource/hermes-agent/pyproject.toml:67` |
| 이미지 forward 릴리스 (v0.12.0 #18030) | `resource/hermes-agent/RELEASE_v0.12.0.md:272, 408` |

## 3. Architecture Sketch

4-layer 스택. **(1) Transport (entry.py)**: `acp.run_agent(agent, use_unstable_protocol=True)`이 stdin/stdout JSON-RPC 루프, 모든 로깅은 stderr 라우팅 (`entry.py:63-76`). `_BENIGN_PROBE_METHODS={ping, health, healthcheck}` 필터로 `-32601` traceback silence. **(2) Protocol (server.py)**: `HermesACPAgent`가 initialize/authenticate/new_session/load_session/resume_session/fork_session/prompt/cancel/set_session_model을 구현, `initialize()`가 `prompt_capabilities=PromptCapabilities(image=True)` + `session_capabilities`(fork/list/resume) 광고 (line 417-428). **(3) Session (session.py)**: `SessionManager`가 in-memory `_sessions` + `SessionDB`(`~/.hermes/state.db`) 이중 유지, `_persist()`가 매 turn 후 history를 DB에 덮어쓰기, `load_session`/`resume_session`이 DB에서 복원해 `AIAgent` 재구성. **(4) Bridges**: ACP `ImageContentBlock`→`_image_block_to_openai_part()`가 `data:image/png;base64,...` URL을 OpenAI `image_url` part로 변환 (line 104-117); 9개 슬래시 커맨드(help/model/tools/context/reset/compact/steer/queue/version)가 `_ADVERTISED_COMMANDS`에 정의되어 lifecycle event마다 `AvailableCommandsUpdate` push, `_handle_slash_command()`가 LLM 없이 로컬 응답; `make_approval_callback()`이 도구 스레드의 sync `approval_cb(cmd, desc)→str`을 `asyncio.run_coroutine_threadsafe`로 비동기 ACP `request_permission`에 브리지 후 `once/always/deny`로 매핑.

## 4. Key Invariants

1. **Stdout = ACP only** — print/logging이 stdout 건드리면 JSON-RPC 파싱 즉시 깨짐. stderr 강제 라우팅 (`entry.py:65-76`).
2. **Approval callback = 스레드별 TLS** — `set_approval_callback()`은 도구 실행 스레드 **안에서** 호출 필요. event loop 스레드에서 set하면 도구 스레드는 미열람. GHSA-qg5c-hvr5-hjgr (`server.py:766-770`).
3. **Sync↔async 브리지 단방향** — `run_coroutine_threadsafe(coro, loop)`만 사용, 도구 스레드 `await` 금지, 60s 만료 시 자동 `deny` (`permissions.py:60-64`).
4. **Permission outcome 매핑 4종** — `allow_once→"once"`, `allow_always→"always"`, `reject_once→"deny"`, `reject_always→"deny"` (`permissions.py:18-23`). 미지정 option_id는 fallback `"once"`.
5. **AvailableCommands lifecycle 재방송** — new/load/resume/set_session_model 모두 `_schedule_available_commands_update()` 호출 (`server.py:529, 549, 566, 596`).
6. **세션 영속 = 매 turn 후 전체 덮어쓰기** — `_persist()`가 부분 업데이트 아님 → 동시 turn 금지 (`session.py:423-429`).
7. **Liveness probe protocol-conformant rejection** — `ping/health`는 `-32601` 응답 + stderr silence (`entry.py:31-60`).
8. **Slash command fall-through** — `_handle_slash_command` `None` 반환 시 LLM에 전달 (`server.py:978-979`).
9. **모델 전환 = in-band 텍스트 응답** — 별도 ACP 알림 미사용 (`server.py:995-999`).

## 5. Notable Constants & Defaults

| 이름 | 값 | 비고 |
| --- | --- | --- |
| ACP 패키지 | `agent-client-protocol>=0.9.0,<1.0` | `pyproject.toml:67` |
| Approval timeout | 60.0s | `permissions.py:30` |
| 슬래시 커맨드 수 | 9 (help/model/tools/context/reset/compact/steer/queue/version) | `server.py:160-170` |
| `prompt_capabilities.image` | `True` | `server.py:422` |
| Session capabilities | fork + list + resume | `server.py:423-427` |
| `load_session` 광고 | `True` | `server.py:421` |
| 기본 image MIME | `image/png` | `server.py:108` |
| SessionDB 위치 | `~/.hermes/state.db` (lazy) | `session.py:417` |
| `_BENIGN_PROBE_METHODS` | `{ping, health, healthcheck}` | `entry.py:31` |

## 6. Comparison to auto_archive_mk3

| 측면 | Hermes | auto_archive_mk3 |
| --- | --- | --- |
| 외부 표면 | ACP stdio (VS Code/Zed) | Discord bot + 웹 dashboard |
| sync↔async 브리지 | `run_coroutine_threadsafe` | ACP 도입 시 동일 권고 |
| 세션 영속 | `~/.hermes/state.db` 이중화 | `03-...` 참조 (M3) |
| 슬래시 커맨드 | 9개 + LLM fall-through | Plana CLI 동일 (M10) |
| 멀티모달 | `ImageContentBlock`→image_url | Discord 첨부 동등 처리 |
| 권한 모델 | once/always/deny | 동일 어휘 + UI 권고 |
| Liveness probe | 필터 silence | 동일 패턴 |

## 7. Adoption Notes

**PORT — M10 stages 1–5 landed (2026-05-02).** 5개 패턴 차용: (1) **stdout 청정성 + stderr 강제** — `src/acp/acp-entrypoint.ts`가 stdout만 ACP 와이어로 사용하고 모든 진단 로그는 `src/acp/acp-logger.ts:defaultAcpLogger`를 통해 stderr ndjson(`<label> <json>\n`)으로만 흐름, (2) **3-tier 권한 매핑** allow_once/allow_always → `allowed`, reject_once/reject_always/cancelled/methodNotFound/timeout → `denied{reason}` (`src/acp/acp-permission-bridge.ts`, 5분 default + 30분 hard cap), (3) **sync↔async 브리지 등가물** — TS는 단일 event loop이므로 Hermes의 `run_coroutine_threadsafe` 대신 `AbortController`로 cancel 신호 전달(`src/acp/acp-prompt-bridge.ts`), (4) **AvailableCommandsUpdate** — first prompt마다 한 번 advertise하고 fork/resume 시 재광고(`src/acp/acp-slash-commands.ts`), (5) **세션 영속 = JSON-per-session 원자적 쓰기** — `~/.hermes/state.db` SQLite 대신 `${AUTO_ARCHIVE_HOME}/acp-sessions/<id>.json` (`.tmp.<pid>.<rand>` + rename, mode 0o600, schemaVersion 1, `parentSessionId` 체인) (`src/acp/acp-session-store.ts`), 그리고 `loadSession`/`resumeSession`/`unstable_forkSession`이 모두 `onSessionRotation` 훅으로 M3 prompt-cache invariant와 직접 연결.

채택 결정 기록: `specs/CURRENT/hermes-pattern-adoption.md` §2 row 12 + §4 M10. 설계 문서: `specs/CURRENT/m10-acp-adapter-design.md`. 운영 runbook(Zed 등록 + 트러블슈팅): `documents/host-setup-acp.md`.

인접 도큐먼트: `02-gateway-plugins-acp-adapter.md`, `03-memory-state-sessiondb.md`, `04-tools-delegate-terminal-backends.md`.

## 8. Pitfalls / Anti-Patterns Observed

- **stdout 오염 = 즉시 프로토콜 불통** — `print()`/progress bar 한 줄로 ACP 클라이언트 사망. 모든 로거 stderr 강제 + `httpx`/`httpcore`/`openai` WARNING으로 (`entry.py:79-81`).
- **Approval TLS 잘못된 스레드 set** — event loop 스레드에서 set 시 도구 스레드 TLS 비어, fail-closed(전부 deny) 또는 fail-open(전부 무방비) 위험. `_run_agent` 내부 스레드에서 set (`server.py:766-770`).
- **`request_permission` await 직접** — 도구 콜백 sync 시그니처 → `await` 불가. `run_coroutine_threadsafe + future.result(timeout=...)`만 정답 (`permissions.py:60-61`).
- **Permission timeout 무한** — 도구 스레드 영구 점유. 60s 기본 + 만료 시 fail-closed `"deny"` (`permissions.py:62-64`).
- **AvailableCommands 단발 광고** — 모델/toolset/fork 후 미재방송 시 자동완성 stale. 모든 lifecycle event 광고 (`server.py:529, 549, 566, 596`).
- **Liveness probe stderr 폭주** — `ping`/`health`의 `Background task failed` 트레이스가 매번 dump. 메서드별 silence 필터 필수 (`entry.py:31-60`).
- **세션 동시 turn** — `_persist()` 전체 덮어쓰기 → 마지막 쓴 쪽 승. `runtime_lock: Lock`으로 직렬화 (`session.py:181`).
- **`load_session=True` 광고 누락** — false 광고 시 클라이언트가 항상 새 세션 → SessionDB 무용. capabilities ↔ 핸들러 일치 필수 (`server.py:421 ↔ 535-548`).
- **이미지 데이터 URL 형식 분기 누락** — `ImageContentBlock.data`는 `data:` 접두사 또는 raw base64 양쪽 가능. 둘 다 처리해야 forward 안 깨짐 (`server.py:110-113`).
