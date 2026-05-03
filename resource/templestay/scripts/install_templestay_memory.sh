#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="shared"
DRY_RUN=0
MEMORY_ROOT="${TEMPLATESTAY_MEMORY_ROOT:-$HOME/.templestay/memory-v2}"
TEMPLATESTAY_HOME="${TEMPLATESTAY_HOME:-$HOME/.templestay}"

show_help() {
  cat <<'HELP'
templestay shared memory profile installer

Usage: bash scripts/install_templestay_memory.sh [--profile none|shared|full] [--memory-root PATH] [--dry-run]

Creates a platform-neutral memory-v2 root for templestay and writes reusable env/MCP snippets.
The memory-v2 server remains backward compatible with legacy ~/.copilot memory paths.
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then echo "Missing value for $1" >&2; exit 1; fi
      PROFILE="${2:-}"; shift 2 ;;
    --memory-root)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then echo "Missing value for $1" >&2; exit 1; fi
      MEMORY_ROOT="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) show_help; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; show_help; exit 1 ;;
  esac
done

case "$PROFILE" in none|shared|full) ;; *) echo "Invalid memory profile: $PROFILE" >&2; exit 1 ;; esac

MEMORY_SERVER="$SCRIPT_DIR/mcp-servers/memory-v2/server.py"
MEMORY_REQS="$SCRIPT_DIR/mcp-servers/memory-v2/requirements.txt"

echo "templestay memory profile: $PROFILE"
echo "  memory_root: $MEMORY_ROOT"
echo "  server: $MEMORY_SERVER"
echo "  schema: memory-v2.5"

if [[ "$DRY_RUN" == "1" ]]; then
  if [[ "$PROFILE" == "none" ]]; then
    echo "dry-run: would write disabled memory profile to $TEMPLATESTAY_HOME/memory.env"
  else
    echo "dry-run: would create $MEMORY_ROOT/{memory,session-state,global-memory}"
    echo "dry-run: would write $TEMPLATESTAY_HOME/memory.env"
    echo "dry-run: would write $TEMPLATESTAY_HOME/mcp/claude-memory.mcp.json"
    echo "dry-run: would write $TEMPLATESTAY_HOME/mcp/codex-memory.env"
  fi
  exit 0
fi

if [[ "$PROFILE" == "none" ]]; then
  mkdir -p "$TEMPLATESTAY_HOME"
  cat > "$TEMPLATESTAY_HOME/memory.env" <<ENV
# templestay memory profile disabled
TEMPLATESTAY_MEMORY_PROFILE=none
MEMORY_V2_SERVICE_NAME=templestay
ENV
  echo "installed disabled templestay memory profile at $TEMPLATESTAY_HOME/memory.env"
  exit 0
fi

mkdir -p "$MEMORY_ROOT/memory" "$MEMORY_ROOT/session-state" "$MEMORY_ROOT/global-memory" "$TEMPLATESTAY_HOME/mcp"
cat > "$TEMPLATESTAY_HOME/memory.env" <<ENV
# templestay shared memory-v2.5 profile
TEMPLATESTAY_MEMORY_PROFILE=$PROFILE
TEMPLATESTAY_MEMORY_ROOT=$MEMORY_ROOT
MEMORY_V2_SCHEMA_VERSION=2.5
MEMORY_V2_SERVICE_NAME=templestay
ENV
cat > "$TEMPLATESTAY_HOME/mcp/codex-memory.env" <<ENV
TEMPLATESTAY_MEMORY_PROFILE=$PROFILE
TEMPLATESTAY_MEMORY_ROOT=$MEMORY_ROOT
MEMORY_V2_SCHEMA_VERSION=2.5
MEMORY_V2_SERVICE_NAME=templestay
ENV
python3 - "$TEMPLATESTAY_HOME/mcp/claude-memory.mcp.json" "$MEMORY_REQS" "$MEMORY_SERVER" "$MEMORY_ROOT" <<'PY'
import json, sys
out, reqs, server, root = sys.argv[1:]
data = {
    "mcpServers": {
        "memory": {
            "command": "uv",
            "args": ["run", "--quiet", "--no-project", "--with-requirements", reqs, server],
            "env": {
                "TEMPLATESTAY_MEMORY_ROOT": root,
                "MEMORY_V2_SCHEMA_VERSION": "2.5",
                "MEMORY_V2_SERVICE_NAME": "templestay",
            },
        }
    }
}
open(out, "w", encoding="utf-8").write(json.dumps(data, indent=2) + "\n")
PY

echo "installed templestay memory profile at $TEMPLATESTAY_HOME"
