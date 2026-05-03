#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
REMOVE_CACHE=0
COPILOT_DIR="${COPILOT_HOME:-$HOME/.copilot}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

show_help() {
  cat <<'HELP'
remove legacy templerun wiring

Usage: bash scripts/remove_templerun_legacy.sh [--dry-run] [--remove-cache]

Removes legacy templerun/Copilot/templerun-codex install wiring while preserving
secrets, global memory, and session state. This script does not remove templestay.
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --remove-cache) REMOVE_CACHE=1; shift ;;
    --help|-h) show_help; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; show_help; exit 1 ;;
  esac
done

remove_path() {
  local path="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "dry-run: would remove $path"
    return 0
  fi
  python3 - "$path" <<'PY'
import shutil, sys
from pathlib import Path
path = Path(sys.argv[1]).expanduser()
if path.is_symlink() or path.is_file():
    path.unlink(missing_ok=True)
elif path.is_dir():
    shutil.rmtree(path, ignore_errors=True)
PY
  echo "removed: $path"
}

try_cmd() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf 'dry-run:'; printf ' %q' "$@"; printf '\n'
  else
    "$@" >/dev/null 2>&1 || true
  fi
}

echo "legacy templerun removal"
echo "  preserves: $COPILOT_DIR/.env, $COPILOT_DIR/global-memory, $COPILOT_DIR/session-state"
echo "  preserves: $CODEX_HOME/session-state and templestay paths"

if command -v copilot >/dev/null 2>&1; then
  try_cmd copilot plugin uninstall templerun
fi
remove_path "$COPILOT_DIR/installed-plugins/_direct/templerun"
remove_path "$COPILOT_DIR/plugin-data/_direct/templerun"

remove_path "$CODEX_HOME/plugins/local/templerun-codex"
remove_path "$CODEX_HOME/agents/templerun-codex"
remove_path "$CODEX_HOME/hooks/templerun-codex"

for skill in templerun-orchestration templerun-verification templerun-researcher templerun-session-memory templerun-deep-think; do
  remove_path "$CODEX_HOME/skills/$skill"
done

# Strip leftover templerun-codex entries from hooks.json and the managed
# `### BEGIN templerun-codex managed instructions` block from config.toml.
# The hooks/ directory is already removed above, but the registry that points
# at the deleted scripts must be cleaned too — otherwise Codex blocks every
# prompt with `UserPromptSubmit Blocked` while it tries to invoke missing
# hook scripts. `scripts/remove_legacy_settings.py` already handles this
# precisely (with backups + Templestay-aware guards), so delegate to it.
SETTINGS_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/remove_legacy_settings.py"
if [[ -x "$SETTINGS_SCRIPT" || -f "$SETTINGS_SCRIPT" ]]; then
  settings_args=(--codex-home "$CODEX_HOME" --no-copilot --no-vscode)
  if [[ "$DRY_RUN" == "1" ]]; then
    settings_args+=(--dry-run)
  else
    settings_args+=(--apply)
  fi
  python3 "$SETTINGS_SCRIPT" "${settings_args[@]}" || true
fi

if command -v codex >/dev/null 2>&1; then
  for name in arxiv templerun-arxiv context7 templerun-context7 memory templerun-memory tavily-search templerun-tavily-search session-gate templerun-session-gate context-manager templerun-context-manager gemini templerun-gemini document-parser templerun-document-parser codex-gateway templerun-codex-gateway; do
    try_cmd codex mcp remove "$name"
  done
fi

if [[ "$REMOVE_CACHE" == "1" ]]; then
  remove_path "$COPILOT_DIR/mcp-memory-data"
  remove_path "$CODEX_HOME/mcp-memory-data"
else
  echo "preserved cache/data directories; pass --remove-cache to remove disposable budget/cache data"
fi

echo "legacy templerun removal complete"
