#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
PRESET="balanced"
SCOPE="user"
DRY_RUN=0
HOOKS=0
MEMORY_PROFILE="shared"
MEMORY_ROOT="${TEMPLATESTAY_MEMORY_ROOT:-$HOME/.templestay/memory-v2}"
MARKETPLACE_NAME="templestay"
PLUGIN_NAME="templestay"

show_help() {
  cat <<'HELP'
templestay Claude Code installer

Usage: bash scripts/install_templestay_claude_cli.sh [--scope user|project|local] [--preset balanced|deep|minimal] [--memory-profile none|shared|full] [--memory-root PATH] [--dry-run] [--hooks]

Installs or previews the native templestay Claude Code package via the standard
Claude plugin marketplace flow:

  user    -> claude plugin marketplace add + claude plugin install (scope user)
  project -> writes .claude/settings.json + project-root CLAUDE.md + .mcp.json
  local   -> writes .claude/settings.local.json (gitignored)

Hooks are optional hardening and are disabled unless --hooks is passed.

The balanced and deep presets enable the codex-gateway MCP server, which
proxies to the OpenAI Codex CLI for Tier 2/Tier 1 code authoring. Codex CLI
must be on PATH (or CODEX_BIN set) for the gateway to be ready; otherwise
codex_preflight reports degraded and Tier 2/1 work falls back to Sonnet.
Override the default Codex model via CODEX_DEFAULT_MODEL (defaults to
gpt-5.5).
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preset)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then echo "Missing value for $1" >&2; exit 1; fi
      PRESET="$2"; shift 2 ;;
    --scope)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then echo "Missing value for $1" >&2; exit 1; fi
      SCOPE="$2"; shift 2 ;;
    --memory-profile)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then echo "Missing value for $1" >&2; exit 1; fi
      MEMORY_PROFILE="$2"; shift 2 ;;
    --memory-root)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then echo "Missing value for $1" >&2; exit 1; fi
      MEMORY_ROOT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --hooks|--hardened) HOOKS=1; shift ;;
    --no-hooks) HOOKS=0; shift ;;
    --help|-h) show_help; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; show_help; exit 1 ;;
  esac
done

case "$PRESET" in balanced|deep|minimal) ;; *) echo "Invalid preset: $PRESET" >&2; exit 1 ;; esac
case "$SCOPE" in user|project|local) ;; *) echo "Invalid scope: $SCOPE" >&2; exit 1 ;; esac
case "$MEMORY_PROFILE" in none|shared|full) ;; *) echo "Invalid memory profile: $MEMORY_PROFILE" >&2; exit 1 ;; esac

PLUGIN_DIR="$SCRIPT_DIR/claude/templestay"
MARKETPLACE_DIR="$SCRIPT_DIR/claude"
PRESET_FILE="$PLUGIN_DIR/settings/presets/$PRESET.json"

if [[ "$DRY_RUN" == "1" ]]; then
  python3 "$SCRIPT_DIR/scripts/materialize_shared_resources.py" --target claude --check
else
  python3 "$SCRIPT_DIR/scripts/materialize_shared_resources.py" --target claude
fi

python3 "$SCRIPT_DIR/scripts/preview_templestay_presets.py" claude --preset "$PRESET" --scope "$SCOPE"
echo "templestay Claude memory profile: $MEMORY_PROFILE"

# codex-gateway readiness check (soft — installer never fails on this).
if [[ "$PRESET" != "minimal" ]]; then
  CODEX_RESOLVED="${CODEX_BIN:-$(command -v codex 2>/dev/null || true)}"
  if [[ -n "$CODEX_RESOLVED" && -x "$CODEX_RESOLVED" ]]; then
    echo "templestay codex-gateway: ready (codex=$CODEX_RESOLVED, model=${CODEX_DEFAULT_MODEL:-gpt-5.5})"
  else
    echo "templestay codex-gateway: degraded — codex binary not found on PATH"
    echo "  Tier 2/Tier 1 code authoring will fall back to templestay-coder (Sonnet)."
    echo "  Install Codex CLI (npm install -g @openai/codex or equivalent) to enable."
  fi
fi

if [[ "$DRY_RUN" == "1" ]]; then
  case "$SCOPE" in
    user)
      echo "dry-run: would run: claude plugin marketplace add $MARKETPLACE_DIR --scope user"
      echo "dry-run: would run: claude plugin install $PLUGIN_NAME@$MARKETPLACE_NAME --scope user"
      ;;
    project)
      echo "dry-run: would write CLAUDE.md at project root"
      echo "dry-run: would write .claude/settings.json from preset $PRESET"
      echo "dry-run: would write project .mcp.json with absolute paths"
      ;;
    local)
      echo "dry-run: would write .claude/settings.local.json from preset $PRESET"
      ;;
  esac
  echo "dry-run: project MCP memory root would be $MEMORY_ROOT"
  echo "dry-run: memory profile handled by scripts/install_templestay_memory.sh"
  echo "dry-run: hooks optional; requested=$HOOKS"
  exit 0
fi

if command -v claude >/dev/null 2>&1; then
  claude plugin validate "$PLUGIN_DIR" >/dev/null
  claude plugin validate "$MARKETPLACE_DIR" >/dev/null
fi

case "$SCOPE" in
  user)
    if ! command -v claude >/dev/null 2>&1; then
      echo "claude CLI not found on PATH; skipping user-scope install" >&2
      exit 1
    fi
    if claude plugin marketplace list 2>/dev/null | grep -q "^$MARKETPLACE_NAME"; then
      claude plugin marketplace update "$MARKETPLACE_NAME" >/dev/null || true
    else
      claude plugin marketplace add "$MARKETPLACE_DIR" --scope user
    fi
    claude plugin install "$PLUGIN_NAME@$MARKETPLACE_NAME" --scope user
    ;;
  project)
    mkdir -p .claude
    cp "$PLUGIN_DIR/CLAUDE.md" CLAUDE.md
    cp "$PRESET_FILE" .claude/settings.json
    python3 - "$SCRIPT_DIR" "$MEMORY_ROOT" ".mcp.json" <<'PY'
import json
import sys
from pathlib import Path

repo = Path(sys.argv[1]).resolve()
memory_root = sys.argv[2]
out = Path(sys.argv[3])

data = {
    "mcpServers": {
        "memory": {
            "command": "uv",
            "args": [
                "run",
                "--quiet",
                "--no-project",
                "--with-requirements",
                str(repo / "mcp-servers/memory-v2/requirements.txt"),
                str(repo / "mcp-servers/memory-v2/server.py"),
            ],
            "env": {
                "TEMPLATESTAY_MEMORY_ROOT": memory_root,
                "MEMORY_V2_SCHEMA_VERSION": "2.5",
                "MEMORY_V2_SERVICE_NAME": "templestay",
            },
        },
        "context-manager": {
            "command": "uv",
            "args": [
                "run",
                "--quiet",
                "--no-project",
                "--with-requirements",
                str(repo / "mcp-servers/context-manager/requirements.txt"),
                str(repo / "mcp-servers/context-manager/server.py"),
            ],
        },
        "document-parser": {
            "command": "uv",
            "args": [
                "run",
                "--quiet",
                "--no-project",
                "--with-requirements",
                str(repo / "mcp-servers/document-parser/requirements.txt"),
                str(repo / "mcp-servers/document-parser/server.py"),
            ],
        },
        "codex-gateway": {
            "command": "uv",
            "args": [
                "run",
                "--quiet",
                "--no-project",
                "--with-requirements",
                str(repo / "mcp-servers/codex-gateway/requirements.txt"),
                str(repo / "mcp-servers/codex-gateway/server.py"),
            ],
        },
    }
}
out.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
    ;;
  local)
    mkdir -p .claude
    cp "$PRESET_FILE" .claude/settings.local.json
    ;;
esac

echo "installed templestay Claude package at scope=$SCOPE (marketplace=$MARKETPLACE_NAME plugin=$PLUGIN_NAME)"
if [[ "$PRESET" != "minimal" ]]; then
  echo "note: codex-gateway is enabled in preset $PRESET; set CODEX_DEFAULT_MODEL / CODEX_BIN in your shell to override defaults"
fi
if [[ "$HOOKS" == "1" ]]; then
  echo "note: optional hooks live in claude/templestay/hooks; enable them by adding the plugin's hooks/hooks.json content to your settings.json hooks block, or run with --hooks-merge in a future revision"
fi
