---
status: pointer
authority: pointer-only
last_verified: 2026-05-01
source_paths:
  - specs/CURRENT/codex-sdk-runtime-bootstrap.md
  - specs/CLARIFICATIONS/multi-provider-scope.md
  - src/runtime/codex-bootstrap-settings.ts
scope: Codex provider 선택 시의 인증 우선순위와 부트스트랩 리마인더에 대한 빠른 운영자/spec 포인터. 정본 상세 구현 spec이 아님.
---

# 가이드: Codex 인증 우선순위

## 사용 시점

정본 현재 구현 spec(`../CURRENT/codex-sdk-runtime-bootstrap.md`)을 읽거나 인용하기
전에 빠른 우선순위 리마인더가 필요할 때 본 가이드를 사용한다.

## 사전 조건

- 현재 런타임 provider 범위는 bootstrap-time multi-provider임을 인지:
  `AUTO_ARCHIVE_RUNTIME_PROVIDER=codex`가 기본이고,
  `AUTO_ARCHIVE_RUNTIME_PROVIDER=claude-agent`는 별도 Claude Agent provider를
  선택한다.
- 본 가이드는 그중 **Codex provider가 선택되었을 때**의 인증 우선순위만 다룬다.
- 자격 증명 우선순위, settings 파일 동작, 또는 모델 오버라이드 중 무엇을
  점검하는지 인지

## 유효 순서

1. 유효한 `~/.codex/auth.json`
2. `AUTO_ARCHIVE_CODEX_API_KEY`
3. 자격 증명 소스 미검출 → 다운스트림 런타임 실패

## Claude Agent counterpart

`AUTO_ARCHIVE_RUNTIME_PROVIDER=claude-agent`를 선택한 경우 이 Codex 우선순위는
적용되지 않는다. Claude Agent provider의 빠른 인증 요약은 다음과 같다.

1. `AUTO_ARCHIVE_ANTHROPIC_API_KEY` — production/API-key path.
2. `AUTO_ARCHIVE_CLAUDE_CLI_PATH` — single-user local development path to a
   `claude` binary.
3. 둘 다 없음 → active `claude-agent` provider 또는 `claude-agent` advisor는
   `/doctor`에서 인증 없음으로 보고되어야 한다.

세부 runtime scope와 OAuth/token 금지 경계는
`../CLARIFICATIONS/multi-provider-scope.md`를 따른다.

## 주요 규칙

- 양성으로 검출된 손상된 CLI 인증은 fail-closed로 끝남
- `AUTO_ARCHIVE_CODEX_SETTINGS_FILE`은 `apiKey`와 `codexPathOverride`에 한해
  부가/폴백 전용
- 환경 변수는 겹치는 settings 파일 키보다 우선권 유지
- 모델 오버라이드는 환경 변수 전용
  (`AUTO_ARCHIVE_CODEX_MODEL`, fallback, reasoning effort)

## 권한 노트

본 가이드는 포인터 전용이다. 자세한 현재 동작은
`../CURRENT/codex-sdk-runtime-bootstrap.md`를 사용한다. 전체 provider 범위는
`../CLARIFICATIONS/multi-provider-scope.md`를 사용한다.

## 주요 동반 문서

- `../CURRENT/codex-sdk-runtime-bootstrap.md`
- `../CLARIFICATIONS/multi-provider-scope.md`
