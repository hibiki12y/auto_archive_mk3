---
status: pointer
authority: pointer-only
last_verified: 2026-04-29
source_paths:
  - src/remote/peekaboo-remote-evaluation.ts
  - src/remote/peekaboo-remote-eval-mcp.ts
  - scripts/start-peekaboo-remote-eval-mcp.mjs
  - scripts/dev/codex-with-peekaboo-mcp.mjs
  - README.md
  - specs/CURRENT/discord-control-plane-always-on.md
scope: 라이브 Peekaboo 원격 평가 증거 경로에 대한 빠른 운영자/spec 포인터.
---

# 가이드: Peekaboo 원격 평가 MCP

## 사용 시점

라이브 Discord 증거에 대한 짧은 spec 차원 규칙이 필요하거나 전체 운영자 runbook을
찾아야 할 때 본 가이드를 사용한다.

## 사전 조건

- 라이브 Discord 변경에는 Peekaboo/macOS 경로가 필요함을 이해
- Discord REST는 관찰/증거 전용임을 이해
- 라이브 변경 이전에 readiness/probe 워크플로가 가용함

## 주요 운영자 가이드

- `README.md`의 "Peekaboo remote evaluation MCP path"
- `src/remote/peekaboo-remote-evaluation.ts`
- `src/remote/peekaboo-remote-eval-mcp.ts`
- `scripts/start-peekaboo-remote-eval-mcp.mjs`
- `scripts/dev/codex-with-peekaboo-mcp.mjs`

## Spec 차원 읽기

- 라이브 Discord GUI 증거에 Peekaboo를 사용한다. 임의의 자동화 주장에는 사용하지
  않는다.
- Discord REST는 관찰/증거 전용으로 유지한다.
- 라이브 변경 이전에 probe/readiness 증명을 요구한다.
- 지속형 증거가 필요하면 명시적인 원장 append/query를 사용한다.

## 권한 노트

본 가이드는 포인터 전용이다. 현재 구현 응대 동반 spec은
`../CURRENT/discord-control-plane-always-on.md`이다.

## 주요 동반 문서

- `../CURRENT/discord-control-plane-always-on.md`

## Local Codex MCP helper boundary

`scripts/dev/codex-with-peekaboo-mcp.mjs` is **project-local per-invocation MCP
injection**. It passes `-c mcp_servers...` overrides for the current Codex
process and does not run `codex mcp add`, does not edit `~/.codex/config.toml`,
and is not a first-class Codex CLI repository-scoped install.

If Codex CLI later provides repository-scoped MCP registration, update this guide
and the helper tests before changing operator instructions.

## Evidence ledger closeout fields

Every live evidence closeout must keep these fields separate:

1. readiness/probe status (`CONFIG_OK`, `SSH_OK`, `BRIDGE_PRESENT`, proxy, submit,
   and live matched-reply gates),
2. GUI submit evidence from the macOS Peekaboo path,
3. REST/matched-reply observation evidence, if an operator-authorized `envFile`
   or `botTokenEnv` is supplied,
4. `artifactPath` pointing at the durable JSONL/evidence artifact,
5. final PASS/WARN/FAIL outcome.

GUI submit without REST/matched reply evidence is WARN/unknown readiness, not a
PASS closeout.
