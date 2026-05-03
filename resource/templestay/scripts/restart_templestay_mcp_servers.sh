#!/usr/bin/env bash
# Restart templestay-bound MCP server processes so a fresh install of
# server.py code is picked up by the next request.
#
# Background: Claude Code / Codex CLI spawn MCP servers (memory-v2,
# context-manager, document-parser, codex-gateway, claude-gateway,
# gemini-gateway) as stdio child processes at session start
# and reuses it for the lifetime of the connection. When server.py is updated
# in place, those children keep running the old code until the parent CLI
# tears them down. This script does the teardown for us so install.sh is a
# one-step "edit-and-go" experience.
#
# Safety:
#   - Only signals processes owned by the current user ($USER).
#   - Only signals processes whose commandline contains both an `mcp-servers/`
#     server.py path AND a templestay marker path (this repo's root, or a
#     user-scope Claude plugin cache directory). Other users' processes and
#     other projects' MCP servers are never touched.
#   - SIGTERM with a short grace period, SIGKILL only as a fallback for
#     unresponsive children.
#   - --dry-run prints the matched processes without sending signals.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
DRY_RUN=0
GRACE_SECONDS=5

show_help() {
  cat <<'HELP'
templestay MCP server restart helper

Usage: bash scripts/restart_templestay_mcp_servers.sh [--dry-run] [--grace SECONDS]

Finds MCP server processes (memory-v2, context-manager, document-parser,
codex-gateway, claude-gateway, gemini-gateway) bound to this templestay checkout
or to a user-scope Claude plugin cache, and signals them to exit so the next
Claude Code / Codex CLI request spawns fresh children that pick up updated
server.py code.

Options:
  --dry-run           Print matched processes without signalling.
  --grace SECONDS     SIGTERM grace period before SIGKILL fallback (default 5).
  --help, -h          Show this message.

Safe by construction: matches only processes owned by $USER whose commandline
contains both an `mcp-servers/<name>/server.py` path AND a templestay marker
path. Other users' processes and unrelated MCP servers are never touched.

CAVEAT — running mid-session:
  Claude Code does not auto-respawn killed stdio MCP children inside an
  already-attached session; the parent CLI must reconnect. Run this helper
  *between* sessions (or after `install.sh`, which prints the same advice).
  If you run it from inside an active Claude Code conversation, the
  templestay MCP tools will go away until you reload the session.
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --grace)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then echo "Missing value for $1" >&2; exit 1; fi
      GRACE_SECONDS="${2:-}"; shift 2 ;;
    --help|-h) show_help; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; show_help; exit 1 ;;
  esac
done

if ! [[ "$GRACE_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "--grace must be a non-negative integer (got: $GRACE_SECONDS)" >&2
  exit 1
fi

if ! command -v pgrep >/dev/null 2>&1; then
  echo "pgrep not found on PATH; cannot identify MCP server processes" >&2
  exit 1
fi

# Templestay marker paths — a process is only a candidate if its commandline
# mentions at least one of these. SCRIPT_DIR covers developer installs from
# this checkout; the plugin cache covers user-scope marketplace installs.
markers=(
  "$SCRIPT_DIR/"
  "$CLAUDE_HOME/plugins/cache/templestay/"
  "$CLAUDE_HOME/plugins/local/templestay/"
)

# Collect candidate `pid|cmd` rows.
candidates=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  pid="${line%% *}"
  cmd="${line#* }"
  for marker in "${markers[@]}"; do
    if [[ "$cmd" == *"$marker"* ]]; then
      candidates+=("$pid|$cmd")
      break
    fi
  done
done < <(pgrep -u "$USER" -af 'mcp-servers/[^/]+/server\.py' 2>/dev/null || true)

if [[ ${#candidates[@]} -eq 0 ]]; then
  echo "no stale templestay MCP server processes found (markers: ${markers[*]})"
  exit 0
fi

echo "found ${#candidates[@]} templestay MCP server process(es):"
for entry in "${candidates[@]}"; do
  pid="${entry%%|*}"
  cmd="${entry#*|}"
  # Truncate long commandlines for readability.
  if [[ ${#cmd} -gt 160 ]]; then
    printf "  pid=%-8s %s...\n" "$pid" "${cmd:0:160}"
  else
    printf "  pid=%-8s %s\n" "$pid" "$cmd"
  fi
done

if [[ "$DRY_RUN" == "1" ]]; then
  echo "dry-run: would SIGTERM the listed pids and SIGKILL after ${GRACE_SECONDS}s if still alive"
  exit 0
fi

# SIGTERM phase.
remaining=()
for entry in "${candidates[@]}"; do
  pid="${entry%%|*}"
  if kill -TERM "$pid" 2>/dev/null; then
    remaining+=("$pid")
  fi
done

# Grace period — poll once per second up to GRACE_SECONDS.
elapsed=0
while [[ $elapsed -lt $GRACE_SECONDS && ${#remaining[@]} -gt 0 ]]; do
  sleep 1
  elapsed=$((elapsed + 1))
  alive=()
  for pid in "${remaining[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      alive+=("$pid")
    fi
  done
  remaining=("${alive[@]}")
done

# SIGKILL fallback for any survivors.
if [[ ${#remaining[@]} -gt 0 ]]; then
  echo "force-killing ${#remaining[@]} unresponsive process(es) after ${GRACE_SECONDS}s grace"
  for pid in "${remaining[@]}"; do
    kill -KILL "$pid" 2>/dev/null || true
  done
fi

echo "stale templestay MCP servers cleared; Claude Code / Codex CLI will respawn fresh on next request"
