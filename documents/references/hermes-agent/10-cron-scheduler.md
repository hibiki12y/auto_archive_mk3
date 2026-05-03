---
status: stable
authority: external-code-reference
last_verified: 2026-05-01
source_paths:
  - resource/hermes-agent/cron/jobs.py
  - resource/hermes-agent/cron/scheduler.py
scope: Hermes Agent cron scheduler 서브시스템의 reference material. auto_archive_mk3 동작에 대한 contract가 아니며 참조 전용.
---

# 10 — Cron Scheduler

## 1. Purpose & Boundary

`cron/jobs.py`(1,002 LOC)와 `cron/scheduler.py`(1,419 LOC)는 영구 작업 스케줄러를 구성한다. 사용자가 자연어/cron 표현으로 등록한 잡을 `~/.hermes/cron/jobs.json`에 직렬화하고 매분 `tick()`이 마감된 잡을 백그라운드 스레드로 실행해 18개 메시징 플랫폼 중 하나로 배달. `context_from` chaining(잡 출력 chaining), `[SILENT]` 마커(배달 억제), 잡 단위 `.env` 재로딩이 주요 책임이다. **본 문서는 등록·틱·실행·배달 파이프라인 전체**.

## 2. Source Anchors

| 항목 | 위치 |
| --- | --- |
| 모듈 docstring (jobs storage) | `resource/hermes-agent/cron/jobs.py:1-6` |
| `_jobs_file_lock` (in-process serialization) | `resource/hermes-agent/cron/jobs.py:40-43` |
| `ONESHOT_GRACE_SECONDS = 120` | `resource/hermes-agent/cron/jobs.py:45` |
| `_apply_skill_fields()` (canonical `skills` 필드) | `resource/hermes-agent/cron/jobs.py:65-71` |
| `parse_schedule()` (once/interval/cron 분류) | `resource/hermes-agent/cron/jobs.py:124-141` |
| `_resolve_cron_enabled_toolsets()` precedence | `resource/hermes-agent/cron/scheduler.py:44-72` |
| `_KNOWN_DELIVERY_PLATFORMS` 화이트리스트 | `resource/hermes-agent/cron/scheduler.py:74-81` |
| `_HOME_TARGET_ENV_VARS` 매핑 | `resource/hermes-agent/cron/scheduler.py:85-100` |
| `SILENT_MARKER = "[SILENT]"` | `resource/hermes-agent/cron/scheduler.py:115` |
| 파일 락 `~/.hermes/cron/.tick.lock` | `resource/hermes-agent/cron/scheduler.py:120-122` |
| `context_from` chaining 처리 | `resource/hermes-agent/cron/scheduler.py:698-731` |
| 자격증명 풀 + provider fallback | `resource/hermes-agent/cron/scheduler.py:971-1025` |
| AIAgent 인스턴스화 (잡 단위) | `resource/hermes-agent/cron/scheduler.py:1027-1057` |
| `tick()` 진입점 + 파일 락 | `resource/hermes-agent/cron/scheduler.py:1258-1297` |

## 3. Architecture Sketch

흐름은 4단이다. **(1) 등록**: `parse_schedule()`이 `"30m"`/`"every 2h"`/`"0 9 * * *"`/ISO 타임스탬프를 파싱해 `{kind, run_at|minutes|expr}` 생성, `_apply_skill_fields()`로 `skills` 정규화, atomic_replace로 `jobs.json` 직렬화(0700/0600). **(2) 틱**: `tick()`이 매분 호출되어 `~/.hermes/cron/.tick.lock` 파일 락을 `fcntl.flock(LOCK_EX|LOCK_NB)`로 획득(다른 게이트웨이/데몬/systemd timer와 직렬화), `get_due_jobs()`로 마감된 잡 수집, **실행 전에** `advance_next_run()`을 먼저 호출해 at-most-once 보장, 그 다음 `ThreadPoolExecutor`로 병렬 실행(line 1299-1302). **(3) 실행**: `_process_job()`이 `.env`를 `override=True`로 재로딩, `resolve_runtime_provider()`로 provider 결정(실패 시 fallback 체인), toolset 해석 후 `AIAgent(platform="cron", session_db=_session_db, ...)` 인스턴스화, 비활성 타임아웃 기반 실행. **(4) 배달**: `[SILENT]` 시작 시 로컬 저장만, 그 외에는 `_resolve_delivery_target()`이 `HERMES_CRON_AUTO_DELIVER_*` 환경변수에 주입해 18개 어댑터가 픽업.

## 4. Key Invariants

1. **at-most-once via prelock advance** — 실행 전 `next_run_at` 갱신, 잡 실패해도 재실행 없음 (`scheduler.py:1299-1302`).
2. **Cross-process 파일 락** — `.tick.lock` 미획득 시 `tick()` 즉시 `return 0` (line 1283-1287).
3. **In-process 잡 락 별도** — `_jobs_file_lock`이 `load→modify→save` 보호 (`jobs.py:40-43`).
4. **Platform 화이트리스트** — `_KNOWN_DELIVERY_PLATFORMS` 18종 frozenset 외는 거부, 환경변수 enumeration 차단 (`scheduler.py:74-81`).
5. **Toolset precedence 3단** — 잡 별 `enabled_toolsets` → `cron` 플랫폼 config → `None`(default) (`scheduler.py:44-72`). `_DEFAULT_OFF_TOOLSETS={moa, homeassistant, rl}`은 미설정 플랫폼에서 자동 제거(Norbert \$4.63 사건).
6. **잡별 fresh `.env` 재로딩** — `load_dotenv(override=True)`로 외부 갱신 토큰 즉시 반영 (`scheduler.py:900-903`).
7. **`context_from` job_id 12-hex 검증** — path traversal 차단, 출력 8K truncate (`scheduler.py:706-707, 722`).
8. **Cron AIAgent는 memory skip + soul identity** — `skip_memory=True`, `load_soul_identity=True`, `disabled_toolsets=["cronjob", "messaging", "clarify"]` 강제 (`scheduler.py:1045-1054`). 사용자 representation 오염 방지.

## 5. Notable Constants & Defaults

| 이름 | 값 | 비고 |
| --- | --- | --- |
| `JOBS_FILE` | `~/.hermes/cron/jobs.json` | `jobs.py:38` |
| `ONESHOT_GRACE_SECONDS` | 120 | once-job 약간 늦어도 실행 (`jobs.py:45`) |
| `SILENT_MARKER` | `"[SILENT]"` | `scheduler.py:115` |
| `_MAX_CONTEXT_CHARS` | 8000 | `scheduler.py:722` |
| `_DEFAULT_OFF_TOOLSETS` | `{moa, homeassistant, rl}` | 미설정 플랫폼에서 제거 |
| `_KNOWN_DELIVERY_PLATFORMS` | 18종 | telegram/discord/slack/whatsapp/signal/matrix/mattermost/homeassistant/dingtalk/feishu/wecom/wecom_callback/weixin/sms/email/webhook/bluebubbles/qqbot/yuanbao |
| `max_iterations` 기본 | 90 | `scheduler.py:966` |
| 워커 수 | unbounded → `HERMES_CRON_MAX_PARALLEL`/config 제한 |
| 권한 | 디렉터리 0700, 파일 0600 |

## 6. Comparison to auto_archive_mk3

| 측면 | Hermes | auto_archive_mk3 |
| --- | --- | --- |
| 스케줄러 | `tick()` + 파일 락 + ThreadPoolExecutor | 미정 — Plana cron equivalent (M9) |
| 잡 저장 | `~/.hermes/cron/jobs.json` (atomic_replace, 0600) | 별도 trait/config 또는 SQLite 권고 |
| 자격증명 재로딩 | 잡 단위 `.env override=True` | 단일 사용자라 동등 절차 단순화 가능 |
| 배달 플랫폼 | 18종 어댑터 (telegram/discord/...) | Discord 단일 + 웹 dashboard |
| `context_from` chaining | latest output 8K truncate, 12-hex 검증 | 동일 패턴 채택 권고 (M9) |
| Toolset 정책 | 잡 별 → 플랫폼 → default 3단 fallback | trait admission policy로 매핑 가능 |
| `[SILENT]` 마커 | 코드 verbatim 패턴 (`scheduler.py:115`) | 동일 어휘 채택 권고 |

## 7. Adoption Notes

**PORT-PARTIAL — M9.** 6개 개념 차용: (1) 파일 락 + in-process 락 이중화, (2) prelock advance(at-most-once), (3) `context_from` chaining(8K truncate + ID 검증), (4) `SILENT_MARKER` 어휘, (5) platform 화이트리스트(env enumeration 차단), (6) 잡 별 fresh `.env` 재로딩.

채택하지 않는 부분: 18개 메시징 어댑터(Discord만), `homeassistant`/`moa`/`rl` toolset 가드, `_HOME_TARGET_ENV_VARS` 매핑(single-user). 인접 도큐먼트: `04-tools-delegate-terminal-backends.md`, `03-memory-state-sessiondb.md`.

## 8. Pitfalls / Anti-Patterns Observed

- **Platform enumeration 공격** — `delivery_targets: ["secret"]`이 `os.getenv("SECRET_HOME_CHANNEL")`로 환경변수 존재 여부 누출. 화이트리스트 필수 (`scheduler.py:74-81`).
- **동시 틱 중복 실행** — 락 미획득 시 silent skip이 정답, 그렇지 않으면 N번 실행 (`scheduler.py:1283-1287`).
- **`context_from` path traversal** — 12-hex 정규성 미검증 시 `../../etc/passwd` 가능 (`scheduler.py:706-707`).
- **Provider fallback silent fall-through** — `runtime=None`으로 진행하면 NoneType crash + retry로 비용 무한 누적. `RuntimeError` 강제 (`scheduler.py:1003-1004`).
- **Cron 잡이 사용자 메모리 오염** — `skip_memory=True` + `load_soul_identity=True`로 SOUL.md만 inherit (`scheduler.py:1052-1053`).
- **Toolset 순서 역전** — `per-job > platform > default` 고정 (`scheduler.py:44-72`).
- **`override=True` 누락 시 stale 토큰** — `load_dotenv()` 기본은 `os.environ` 미덮어 → 401 루프 (`scheduler.py:900-903`).
