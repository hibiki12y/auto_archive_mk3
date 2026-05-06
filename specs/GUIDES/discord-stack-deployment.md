---
status: pointer
authority: pointer-only
last_verified: 2026-04-29
source_paths:
  - README.md
  - docker-compose.yml
  - Dockerfile
  - scripts/check-discord-core-stack.mjs
  - .env.example
scope: Docker Compose 기반 Discord 컨트롤 플레인 스택 운영에 대한 빠른 운영자/spec 포인터.
---

# 가이드: Discord 컨트롤 플레인 스택 배포

## 사용 시점

Docker Compose `discord-service` 스택을 띄우거나 헬스 게이트를 점검해야 할 때
빠른 spec 차원 리마인더가 필요한 경우 본 가이드를 사용한다.

## 사전 조건

- Docker 24+와 Docker Compose v2 가용
- `.env`에 `AUTO_ARCHIVE_DISCORD_TOKEN`, `AUTO_ARCHIVE_CREDENTIAL_KEY`(32자 이상)
  최소 설정
- Codex 인증은 호스트의 `~/.codex`를 컨테이너 `/home/deepsky/.codex`로 mount하는
  계약을 따름

## 운영 요약

1. `pnpm core:stack:start` — 컨테이너 빌드와 기동
2. `pnpm core:stack:status` — 라이프사이클 게이트 상태 확인
3. `pnpm core:stack:health` — `client-ready-wait-complete` 및
   `command-registration-complete` 이벤트가 로그에 도달했는지 점검
4. `docker compose logs -f discord-service` — 실시간 로그 추적
5. `pnpm core:stack:stop` — 정상 정지

## 주요 규칙

- 호스트 PM2 / Node 서비스 실행은 지원 경로가 아님. 장수 Discord 서비스는 Docker
  Compose `discord-service`로만 실행한다.
- 컨테이너는 자체 실행 경계로 사용되므로
  `AUTO_ARCHIVE_DISCORD_TASK_SANDBOX_MODE=danger-full-access`가 설정되어 있어야
  중첩 Codex/bubblewrap 샌드박스 실패를 피할 수 있다.
- 호스트 절대 경로 Codex CLI 오버라이드가 컨테이너 내부에서 깨지지 않도록 서비스는
  `AUTO_ARCHIVE_CODEX_CLI_PATH=""`를 설정하고 이미지에 번들된 Codex SDK/CLI를
  사용한다. `gpt-5.5` primary 모델 사용 시 이미지 의존성의
  `@openai/codex-sdk` / `@openai/codex` 쌍이 `>=0.125.0`이어야 한다.
- 서비스는 `AUTO_ARCHIVE_CODEX_CLI_HOME_MODE=isolated-auth`를 기본으로 사용한다.
  이 모드는 host `~/.codex/auth.json`만 Codex child process 전용 home에 연결하고
  host `~/.codex/config.toml` / `~/.codex/.env`의 proxy/telemetry 설정은 격리한다.

## 권한 노트

본 가이드는 포인터 전용이다. 라이브 런타임/구현 진실은 root `README.md`,
`docker-compose.yml`, `.env.example`, 그리고 `scripts/check-discord-core-stack.mjs`에
머무른다. Discord 컨트롤 플레인의 spec 차원 정의는
`../CURRENT/discord-control-plane-always-on.md`에 있다.

## 주요 동반 문서

- `../CURRENT/discord-control-plane-always-on.md`
- 호스트 코덱 인증 흐름: `../CURRENT/codex-sdk-runtime-bootstrap.md`
- 우선순위 리마인더: `./bootstrap-codex-auth-precedence.md`
