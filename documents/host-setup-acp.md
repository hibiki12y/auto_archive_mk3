# Host Setup — ACP (Agent Client Protocol) IDE Adapter

This document describes how to register the Auto Archive ACP adapter
(`auto-archive-acp`) as an external agent in an ACP-compatible IDE,
how to read its diagnostic logs, and how to recover from common
operational failures. The adapter ships under `src/acp/` and is
exposed via `dist/src/acp/acp-entrypoint.js` after `pnpm build`.

The adapter is a leaf surface: nothing in `src/discord/`,
`src/runtime/`, or `src/core/` calls it back. The blast radius of an
ACP misconfiguration is contained to whichever IDE has registered the
adapter as an external agent.

## Scope and supported IDEs

- The adapter implements ACP via `@agentclientprotocol/sdk` (currently
  `^0.21.0`, Apache-2.0).
- **Primary smoke target**: Zed (the originator of the protocol).
- **Listed ACP clients**: Zed, VS Code, JetBrains, Neovim, Emacs,
  Obsidian, Unity, Chrome. Auto Archive is dogfooded against Zed
  only. Other IDEs may expose the adapter; their permission UX is
  best-effort and may be unsupported.
- **Out of scope**: Auto Archive does not ship an IDE-side extension
  for any of these editors. Registration is per the IDE's own
  external-agent configuration.

## Build prerequisites

1. `pnpm install` — pulls `@agentclientprotocol/sdk` and `zod`.
2. `pnpm build` — emits `dist/src/acp/acp-entrypoint.js` with a
   shebang preserved so the file can be executed directly.
3. Confirm with `node dist/src/acp/acp-entrypoint.js < /dev/null;
   echo $?` — the process should exit `0` cleanly.

The `package.json` `bin: { auto-archive-acp: ... }` field is a stable
path-marker — the project is `private: true`, so global `npm install
-g` does not apply. IDEs reference the absolute path to the built
file.

## Registering with Zed

Zed exposes external agents via its settings (Editor → Settings →
Agent → External Agents). The minimum configuration:

```json
{
  "agents": {
    "auto-archive": {
      "command": "/absolute/path/to/auto_archive_mk3/dist/src/acp/acp-entrypoint.js",
      "args": [],
      "env": {}
    }
  }
}
```

To enable session persistence (so prompts survive Zed restarts),
also set `AUTO_ARCHIVE_HOME` in `env`. Sessions land at
`${AUTO_ARCHIVE_HOME}/acp-sessions/<sessionId>.json` (one file per
session, mode 0o600). When `AUTO_ARCHIVE_HOME` is unset the path
defaults to `${HOME}/.auto-archive/acp-sessions/`.

## Permission UX expectations

The adapter is **fail-closed**: every approval-gated dispatch goes
through ACP `requestPermission`. The IDE response maps as follows:

| IDE response                                 | Decision                                  |
| -------------------------------------------- | ----------------------------------------- |
| `selected` + `allow_once`                    | `allowed`                                 |
| `selected` + `allow_always`                  | `denied: unsupported-allow-always`        |
| `selected` + `reject_once` / `reject_always`  | `denied: user-rejected`                   |
| `cancelled`                                  | `denied: user-cancelled`                  |
| RPC error `methodNotFound` (-32601)          | `denied: unsupported-client`              |
| Other RPC error                              | `denied: client-rpc-error`                |
| No response within 5 minutes                 | `denied: bridge-timeout`                  |
| Unknown optionId in response                 | `denied: client-rpc-error`                |

There is **no auto-allow** path. An IDE that does not implement
`requestPermission` (or stalls indefinitely) cannot accidentally
approve a sensitive operation — every such case is `denied`.
Auto Archive also does not advertise `allow_always` in its default
permission options because execution approvals are single-use only in
the current implementation batch; a custom/persistent allow option
returned by an IDE fails closed instead of becoming an implicit
long-lived grant.

If permission denials are firing on every action, check the IDE's ACP
client logs first; the most common cause is an IDE that returns
`methodNotFound`. The user-facing remedy is to upgrade the IDE or
enable the relevant extension.

## Slash commands

The adapter advertises slash commands derived from the Discord
`COMMAND_REGISTRY` (single source of truth). On the first prompt
turn for each session the adapter sends one
`available_commands_update` notification; subsequent prompts do not
re-emit unless the session is reloaded. Commands tagged
`surfaceTags: ['discord']` are filtered out of the ACP advertisement.

## Diagnostic logs

The adapter writes one ndjson-shaped line per event to **stderr**
(stdout is reserved for the ACP wire). Each line has the shape
`<label> <json>` so a `grep` against the label still works. The
default logger is `defaultAcpLogger` from
`src/acp/acp-logger.ts`; ops deployments can plug a different sink
(syslog, OTel, etc.) by passing a custom `AcpLogger` to
`AcpServerOptions.logger`.

### Stable label inventory

| Label                                | Level | When it fires                                                    |
| ------------------------------------ | ----- | ----------------------------------------------------------------- |
| `acp-entrypoint-error`                | error | Connection threw inside `main`                                   |
| `acp-entrypoint-fatal`                | error | `main()` itself rejected (out of `try/catch`)                    |
| `acp-session-store-write-failed`      | warn  | `JsonAcpSessionStore.write` failed; in-memory state authoritative |
| `acp-permission-denied`               | warn  | Bridge produced a denied decision (carries stable `reason`)      |
| `acp-slash-commands-notify-failed`    | warn  | `available_commands_update` notification threw on the wire       |

### Sample log lines

```
acp-permission-denied {"level":"warn","label":"acp-permission-denied","payload":{"approvalId":"a-1","sessionId":"s-1","kind":"tool-execute","reason":"user-rejected"}}
acp-session-store-write-failed {"level":"warn","label":"acp-session-store-write-failed","message":"EACCES: permission denied","payload":{"sessionId":"s-2","phase":"newSession"}}
acp-entrypoint-fatal {"level":"error","label":"acp-entrypoint-fatal","message":"<root cause>"}
```

## Troubleshooting

### Adapter exits immediately on launch

Likely causes:

1. The shebang on `dist/src/acp/acp-entrypoint.js` was lost (e.g.
   archive extraction stripped the executable bit). Run
   `node dist/src/acp/acp-entrypoint.js` directly to bypass.
2. `@agentclientprotocol/sdk` is missing — `pnpm install` again.
3. The IDE closed stdin before the handshake completed. The adapter
   exits `0` on clean EOF, which a watchdog may interpret as a
   crash.

### Wire corruption / "invalid JSON-RPC" in the IDE log

Diagnostic output went to stdout instead of stderr. Audit any
custom `logger` injection — the default `defaultAcpLogger` writes to
stderr. Anything you wrap around it MUST also avoid stdout.

### Persistence directory has wrong permissions

The store creates the directory lazily on first write with mode
0o700 and writes files with mode 0o600. If umask is unusually
permissive, the on-disk permissions may be looser. Tighten with:

```sh
chmod -R go-rwx "${AUTO_ARCHIVE_HOME:-$HOME/.auto-archive}/acp-sessions"
```

### Permission requests stall forever

The bridge enforces a 5-minute timeout. If users see persistent
`acp-permission-denied` with `reason: bridge-timeout`, raise the
client-side question of whether the IDE permission UI is
modal-blocking or hidden. There is no server-side knob to extend
beyond 30 minutes (a hard cap inside the bridge).

### `..stray.json` or other orphan files in the persistence dir

The store tolerates orphan files in its directory (anything not
matching `^[A-Za-z0-9][A-Za-z0-9._-]*\.json$` is skipped by `list()`
and unreadable via `read()`). Operators may safely move or delete
such files. The store never produces them itself; they only appear
if something external writes into the directory.

## Capability advertisement

The adapter's `initialize` response advertises:

- `agentInfo: { name: 'auto-archive-acp', version: 'X.Y.Z' }`
- `agentCapabilities.loadSession: true`  *only when sessionStore is
  wired*
- `agentCapabilities.sessionCapabilities.fork: {}` and `resume: {}`
  *only when sessionStore is wired*
- `authMethods: []` (no auth methods advertised; `authenticate` is a
  no-op success)

If the IDE reports a missing capability, confirm whether
`AUTO_ARCHIVE_HOME` (or an explicit `sessionStore`) is configured —
without persistence the adapter does not advertise load/resume/fork.

## What to do when stage 5 ages

This document was written at ACP M10 stage 5 closeout (2026-05-02)
against `@agentclientprotocol/sdk@^0.21.0`. The SDK is pre-1.0; minor
bumps may break wire compatibility. When the SDK changes:

1. Re-run `pnpm vitest run tests/acp/`. The 74-test suite (handshake,
   prompt+cancel, permission bridge, slash commands, session store,
   persistence integration, logger) is the canary.
2. Read the SDK changelog. Fields renamed under `unstable_*` are the
   most common breakage.
3. Update this document's "Permission UX" and "Capability
   advertisement" tables if the wire shape changed.
4. Bump the package pin in `package.json`. Keep a single dep — extra
   transitive packages are out of scope.

The full M10 plan close-out lives in
`specs/CURRENT/m10-acp-adapter-design.md` (status `current` after
stage 5) and `~/.claude/plans/2-acp-adapter-execution.md`.
