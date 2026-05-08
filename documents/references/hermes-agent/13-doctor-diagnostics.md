---
status: stable
authority: external-code-reference
last_verified: 2026-05-05
source_paths:
  - resource/hermes-agent/hermes_cli/doctor.py
scope: Hermes Agent Doctor / Diagnostics 서브시스템의 reference material. auto_archive_mk3 동작에 대한 contract가 아니며 참조 전용. 현재 Auto Archive doctor parity 기록은 `specs/CURRENT/hermes-pattern-adoption.md`, `specs/CURRENT/openclaw-gap-implementation.md`, `README.md`, `src/core/doctor.ts`가 우선한다.
---

# Doctor / Diagnostics

## 1. Purpose & Boundary

`hermes doctor` 명령은 Hermes 설치/설정 상태를 점검해 사용자가 즉시 고칠 수 있는 형식으로 결과를 출력한다. Python 환경, 필수/선택 패키지, 프로바이더 인증, 모델 가용성, 디렉터리 구조, gateway service linger, profile 일관성, memory provider 등 다층의 관심사를 한 명령에서 묶어 검사한다. 이 모듈은 정상 경로의 일부가 아니라 **운영 보조 진단 도구**로, 다른 코드가 import해서 결과를 기계적으로 소비하지 않는다 — 출력이 사람을 향한다.

## 2. Source Anchors

| 영역 | Citation |
| --- | --- |
| 모듈 헤더 / .env 로드 | `resource/hermes-agent/hermes_cli/doctor.py:1-30` |
| `_PROVIDER_ENV_HINTS` 튜플 | `resource/hermes-agent/hermes_cli/doctor.py:39-63` |
| Termux 감지 / 설치 명령 빌더 | `resource/hermes-agent/hermes_cli/doctor.py:66-78` |
| Output helpers (`check_ok/warn/fail/info`) | `resource/hermes-agent/hermes_cli/doctor.py:132-142` |
| Gateway linger 검사 | `resource/hermes-agent/hermes_cli/doctor.py:145-175` |
| `run_doctor` entry / Python 버전 | `resource/hermes-agent/hermes_cli/doctor.py:178-218` |
| Required/optional package 검사 | `resource/hermes-agent/hermes_cli/doctor.py:226-253` |
| `~/.hermes/.env` / config.yaml 검사 | `resource/hermes-agent/hermes_cli/doctor.py:262-518` |
| 디렉터리/SOUL.md/state.db 검사 | `resource/hermes-agent/hermes_cli/doctor.py:606-717` |
| Symlink (`~/.local/bin/hermes`) | `resource/hermes-agent/hermes_cli/doctor.py:724-799` |
| Memory provider 분기 | `resource/hermes-agent/hermes_cli/doctor.py:1296-1344` |
| 요약 / `--fix` 결과 | `resource/hermes-agent/hermes_cli/doctor.py:1393-1422` |

## 3. Architecture Sketch

```
hermes doctor [--fix]
      │
      ▼
run_doctor(args) ── Python env / packages / .env / config.yaml /
                    dirs / SOUL.md / state.db+WAL / gateway linger /
                    bin symlink / memory provider / profiles
      │
      ▼
check_ok | check_warn | check_fail   (stdout, colored)
+ issues[] (auto-fixable)  + manual_issues[] (human-only)
      │
      ▼
Summary + `hermes doctor --fix` hint
```

각 검사는 stdout에 컬러 텍스트를 직접 찍고 실패 항목을 두 리스트 중 하나에 누적한다. `--fix`는 안전한 항목만 그 자리에서 수정한다. 검사 함수가 값을 리턴해 조립되는 구조가 아니라 **side-effect 기반의 절차형 흐름**이 본질이다.

## 4. Key Invariants

- 점검 결과는 항상 사람이 읽을 수 있는 단일 페이지 출력으로 끝난다 (machine-readable JSON 출력 없음).
- `_python_install_cmd()` / `_system_package_install_cmd()`는 플랫폼(Termux/macOS/Linux)에 따라 정확한 한 줄 명령을 반환한다 — 사용자에게 추측 명령을 권하지 않는다.
- 실패 항목마다 즉시 활용 가능한 remediation hint(설치 커맨드, config 경로, `hermes setup`/`hermes auth add` 같은 후속 명령)를 동봉한다. 단순한 PASS/FAIL bool이 아니다.
- `--fix`로 수정 가능한 issue와 사용자가 직접 손대야 하는 issue는 별도 리스트(`issues` vs `manual_issues`)로 분리되며, 마지막 요약에서 그대로 보여진다.
- `_check_gateway_service_linger`처럼 플랫폼 전용 검사는 비-Linux에서는 조용히 스킵된다 (검사 자체가 false-positive를 만들지 않도록 보호).

## 5. Notable Constants & Defaults

- `_PROVIDER_ENV_HINTS` (`doctor.py:39-63`): 24종의 provider 인증 환경변수 튜플 — `.env`에서 어느 한 키라도 발견되면 "API key configured"로 판정.
- Required packages: `openai`, `rich`, `dotenv`, `yaml`, `httpx` (`doctor.py:226-232`).
- Optional packages: `croniter`, `telegram`, `discord` (`doctor.py:234-238`).
- 예상 서브디렉터리: `cron`, `sessions`, `logs`, `skills`, `memories` (`doctor.py:620`).
- WAL size 임계: 50MB 초과 시 warn + 자동 PASSIVE checkpoint (`doctor.py:699-713`).
- Python 권장 버전: 3.11+ (RL 도구), 최소 3.10.
- 명령 심볼릭 링크 위치: Termux는 `$PREFIX/bin/hermes`, 그 외는 `~/.local/bin/hermes` (`doctor.py:737-744`).

## 6. Comparison to auto_archive_mk3

| 측면 | Hermes Doctor | auto_archive_mk3 (현재) |
| --- | --- | --- |
| 진단 명령 | `hermes doctor [--fix]` 단일 진입점 | `pnpm run doctor` (`npm run doctor`) → `scripts/auto-archive-doctor.mjs`, Discord `/doctor` |
| 출력 형식 | 컬러 텍스트, side-effect 출력 | `DoctorReport` 구조체(`sections[]`)를 먼저 만든 뒤 사람이 읽는 텍스트로 렌더링 |
| 자동 수정 | `--fix` 플래그로 일부 항목 즉시 패치 | 없음 — 현재 slice는 non-mutating trust-baseline doctor |
| 항목 수 | ~12 영역, 각각 다수 sub-check | 서비스 준비도, Discord auth/access, runtime provider, Codex/Claude auth, Plana advisor, approval/tool-loop/subagent 정책, shell-hook bridge, GitLab, TLS CA, rate-throttle(활성 시), secret redaction |
| 결과 구조 | `issues[]` / `manual_issues[]` 리스트 | `DoctorSection { name, status, details, remediation? }` |
| Remediation hint | 항상 동봉 | WARN/FAIL 섹션은 가능한 경우 `remediation` 필드에 즉시 실행 가능한 operator hint를 동봉 |

## 7. Adoption Notes

**채택 결정: PORT 소형 — trust-baseline doctor landed (OC-3A), `--fix` 제외**

Auto Archive는 Hermes doctor에서 다음 패턴을 가져왔다.

- 진단 영역 분리 패턴 (env / config / dirs / symlinks / providers).
- 각 항목 PASS/WARN/FAIL + 즉시 실행 가능한 remediation hint 동봉.
- 정상 경로와 분리된 운영 보조 진단 도구.
- 출력 전 구조화된 section collector를 구성해 Discord/CLI가 같은 진단 payload를 공유.

아직 가져오지 않은 부분:

- `--fix` 자동 패치 가능 항목과 수동 항목의 명시적 분리. Auto Archive는
  아직 non-mutating baseline만 채택했으므로, 자동 수정은 operator UX가
  명확해질 때까지 의도적으로 제외한다.
- Hermes 고유 항목(SOUL.md, gateway systemd linger, profiles, memory provider 분기), Python-only 패키지 검사 (우리는 Node/TS).

연결 spec: 현재 parity 상태는 `specs/CURRENT/openclaw-gap-implementation.md`의 OC-3A와 `specs/CURRENT/hermes-pattern-adoption.md`의 13번 행에 기록한다.

## 8. Pitfalls / Anti-Patterns Observed

- **Prose-only 출력**: Hermes 결과는 컬러 텍스트로만 흐르고 JSON export가 없다. Auto Archive는 이 함정을 피하기 위해 먼저 `DoctorReport`/`DoctorSection`을 수집하고 마지막에 텍스트로 렌더링한다.
- **Hint 누락 가능 분기**: Hermes에는 일부 `check_warn`만 호출되고 `issues`에 안 들어가는 케이스가 있다. Auto Archive invariant: WARN/FAIL 섹션은 가능한 경우 `remediation`을 섹션 자체에 붙인다.
- **Side-effect 기반 절차**: `run_doctor`가 1,200+ 줄 직선 코드이며 stdout capture에 의존하는 테스트밖에 못 짠다. PORT 시 검사를 순수 함수 + collector로 분리.
- **`_safe_which` 패턴**: `shutil.which`를 try/except로 감싼 작은 함수(`doctor.py:81-86`) — 진단 도구는 어떤 변형 환경에서도 죽지 않아야 한다는 원칙. PORT 시 동일 invariant.
- **자동 수정의 위험성**: `--fix`가 WAL checkpoint, config migration, symlink, 빈 `.env`, SOUL.md 템플릿까지 건드린다. PORT 시 `--fix` 동작은 idempotent + 화이트리스트 + 사용자 확인 없는 신규 파일 생성은 의식적 결정.
