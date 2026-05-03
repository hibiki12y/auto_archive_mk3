#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { printf "${GREEN}[ok]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[warn]${NC} %s\n" "$*"; }
err()  { printf "${RED}[err]${NC} %s\n" "$*"; }
info() { printf "  %s\n" "$*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRESET="balanced"
CLAUDE_SCOPE="user"
MEMORY_PROFILE="shared"
RUN_CODEX=1
RUN_CLAUDE=1
DRY_RUN=0
HOOKS=0
REMOVE_LEGACY=0
UPDATE_MODE=0
RESTART_MCP=1
INSTALL_CLAUDE_CLI=1
INSTALL_CODEX_CLI=1
CLAUDE_NPM_PACKAGE="@anthropic-ai/claude-code"
CODEX_NPM_PACKAGE="@openai/codex"
MEMORY_ROOT="${TEMPLATESTAY_MEMORY_ROOT:-}"

show_help() {
  printf "${BOLD}templestay full installer${NC}\n\n"
  printf "Usage: bash install.sh [OPTIONS]\n\n"
  printf "Options:\n"
  info "--preset P             Preset: balanced, deep, or minimal (default: balanced)"
  info "--memory-profile P     Memory profile: none, shared, or full (default: shared)"
  info "--memory-root PATH     Shared memory root (default: \$TEMPLATESTAY_MEMORY_ROOT or ~/.templestay/memory-v2)"
  info "--claude-scope S       Claude scope: user, project, or local (default: user)"
  info "--codex-only           Install only the Codex templestay surface"
  info "--claude-only          Install only the Claude templestay surface"
  info "--with-hooks           Enable optional hardening hooks where component installers support them"
  info "--no-hooks             Keep optional hooks disabled (default)"
  info "--remove-legacy        Remove legacy Copilot/templerun-codex user-side wiring before installing"
  info "--update, -u           Refresh templestay surfaces in place (same install plan, compatibility flag)"
  info "--no-restart-mcp       Skip the post-install restart of templestay MCP server processes"
  info "                          (use this flag when running install.sh from inside an active"
  info "                          Claude Code session to avoid disconnecting its MCP tools)"
  info "--no-install-claude    Do not bootstrap the Claude Code CLI (npm install -g $CLAUDE_NPM_PACKAGE)"
  info "                          when it is missing — fail fast and let the user install it"
  info "--no-install-codex     Do not bootstrap the Codex CLI (npm install -g $CODEX_NPM_PACKAGE)"
  info "                          when it is missing — Codex setup will degrade gracefully"
  info "--dry-run              Print planned actions without changing user config"
  info "--help, -h             Show this help message"
  printf "\n"
  info "Default: install templestay (Codex + Claude + shared memory profile + gateway MCPs)."
  info "Shared instruction/skill resources are materialized from shared/templestay/"
  info "before platform surfaces are installed; dry-run performs a non-mutating check."
  info "balanced/deep presets wire Claude → Codex through codex-gateway and Codex → Claude"
  info "read-only consultation through claude-gateway (deep also enables gemini-gateway)."
  info "Codex hetero Critique defaults claude-gateway to Claude Opus 4.7"
  info "(model claude-opus-4-7, effort=max) and policy-preauthorizes the"
  info "minimal verifier evidence bundle by default"
  info "(CLAUDE_GATEWAY_DESTINATION_TRUST=trusted_internal,"
  info " CLAUDE_GATEWAY_ALLOW_REPO_CONTENT=true)."
  info "(set CODEX_BIN/CODEX_DEFAULT_MODEL or CLAUDE_BIN/CLAUDE_DEFAULT_MODEL/"
  info " CLAUDE_DEFAULT_EFFORT/CLAUDE_GATEWAY_DESTINATION_TRUST/"
  info " CLAUDE_GATEWAY_ALLOW_REPO_CONTENT to override; minimal omits gateways)."
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preset)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then err "Missing value for $1"; exit 1; fi
      PRESET="${2:-}"; shift 2 ;;
    --memory-profile)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then err "Missing value for $1"; exit 1; fi
      MEMORY_PROFILE="${2:-}"; shift 2 ;;
    --memory-root)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then err "Missing value for $1"; exit 1; fi
      MEMORY_ROOT="${2:-}"; shift 2 ;;
    --claude-scope)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then err "Missing value for $1"; exit 1; fi
      CLAUDE_SCOPE="${2:-}"; shift 2 ;;
    --codex-only)
      RUN_CLAUDE=0; shift ;;
    --claude-only)
      RUN_CODEX=0; shift ;;
    --with-hooks|--hooks|--hardened)
      HOOKS=1; shift ;;
    --no-hooks)
      HOOKS=0; shift ;;
    --remove-legacy)
      REMOVE_LEGACY=1; shift ;;
    --no-restart-mcp)
      RESTART_MCP=0; shift ;;
    --restart-mcp)
      RESTART_MCP=1; shift ;;
    --no-install-claude)
      INSTALL_CLAUDE_CLI=0; shift ;;
    --install-claude)
      INSTALL_CLAUDE_CLI=1; shift ;;
    --no-install-codex)
      INSTALL_CODEX_CLI=0; shift ;;
    --install-codex)
      INSTALL_CODEX_CLI=1; shift ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    --update|-u)
      UPDATE_MODE=1; shift ;;
    --help|-h)
      show_help ;;
    *)
      err "Unknown flag for templestay installer: $1"
      show_help ;;
  esac
done

case "$PRESET" in balanced|deep|minimal) ;; *) err "Invalid preset: $PRESET"; exit 1 ;; esac
case "$MEMORY_PROFILE" in none|shared|full) ;; *) err "Invalid memory profile: $MEMORY_PROFILE"; exit 1 ;; esac
case "$CLAUDE_SCOPE" in user|project|local) ;; *) err "Invalid Claude scope: $CLAUDE_SCOPE"; exit 1 ;; esac
if [[ "$RUN_CODEX" -eq 0 && "$RUN_CLAUDE" -eq 0 ]]; then
  err "--codex-only and --claude-only cannot both be used"
  exit 1
fi

printf "\n${BOLD}=== templestay full install ===${NC}\n"
info "Preset: $PRESET"
info "Memory profile: $MEMORY_PROFILE"
info "Claude scope: $CLAUDE_SCOPE"
info "Optional hooks requested: $HOOKS"
if [[ "$UPDATE_MODE" -eq 1 ]]; then
  info "Update mode: refresh templestay surfaces in place"
fi
if [[ "$DRY_RUN" -eq 1 ]]; then
  info "Dry run mode enabled"
fi
if [[ "$RUN_CODEX" -eq 1 && "$PRESET" != "minimal" ]]; then
  info "Codex hetero Critique: model=${CLAUDE_DEFAULT_MODEL:-claude-opus-4-7}, effort=${CLAUDE_DEFAULT_EFFORT:-max}, trust=${CLAUDE_GATEWAY_DESTINATION_TRUST:-trusted_internal}, allow_repo_content=${CLAUDE_GATEWAY_ALLOW_REPO_CONTENT:-true}"
fi

# Self-check: did an earlier (pre-fix) MCP child write capsules into a
# literal-named ${TEMPLATESTAY_MEMORY_ROOT}/ directory under the repo? Warn
# so the user can decide whether to delete it. We never delete automatically
# — the directory may carry uncopied work the user wants to migrate.
for stray in "$SCRIPT_DIR/\${TEMPLATESTAY_MEMORY_ROOT}" "$SCRIPT_DIR/\${MEMORY_V2_ROOT}"; do
  if [[ -e "$stray" ]]; then
    warn "Found legacy literal-interpolation memory directory: $stray"
    info "  This was created when an earlier .mcp.json passed an unresolved \${VAR} token to the memory MCP child."
    info "  The current code refuses such values, so it will not grow further. To remove (after copying anything you need): rm -rf \"$stray\""
  fi
done

if [[ "$REMOVE_LEGACY" -eq 1 ]]; then
  printf "\n${BOLD}[0/6] Remove legacy templerun wiring${NC}\n"
  legacy_args=()
  [[ "$DRY_RUN" -eq 1 ]] && legacy_args+=(--dry-run)
  "$SCRIPT_DIR/scripts/remove_templerun_legacy.sh" "${legacy_args[@]}"
  ok "Legacy removal pass complete"
fi

# Bootstrap CLI prerequisites. install_templestay_*_cli.sh both gate their
# work behind `command -v claude` / `command -v codex`; if those binaries are
# missing, the rest of install.sh would silently produce an incomplete setup.
# Auto-install via npm when possible; fall back to a clear error so the user
# can act. Sudoless ``npm install -g`` requires a user-prefix npm config; we
# do not escalate privileges automatically.
ensure_cli_present() {
  local label="$1" bin="$2" pkg="$3" enabled="$4" only_if_run="$5"
  if [[ "$only_if_run" -eq 0 ]]; then
    return 0  # The caller skipped this surface (e.g. --codex-only / --claude-only).
  fi
  if command -v "$bin" >/dev/null 2>&1; then
    info "$label CLI present: $("$bin" --version 2>/dev/null | head -n1)"
    return 0
  fi
  if [[ "$enabled" -eq 0 ]]; then
    warn "$label CLI ('$bin') not found and auto-install was disabled."
    info "Install manually: npm install -g $pkg"
    return 0
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "dry-run: would run: npm install -g $pkg"
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    err "$label CLI ('$bin') not found and 'npm' is unavailable to bootstrap it."
    info "Install Node.js + npm (https://nodejs.org), then re-run install.sh, or pass --no-install-$( [[ "$bin" == "claude" ]] && echo claude || echo codex ) to defer the install."
    exit 1
  fi
  printf "${BOLD}Bootstrapping $label CLI via 'npm install -g $pkg'...${NC}\n"
  if ! npm install -g "$pkg"; then
    err "Failed to install $pkg via npm."
    info "If this was a permissions error, configure a user-level npm prefix (e.g. 'npm config set prefix ~/.npm-global') and re-run, or install $pkg manually."
    exit 1
  fi
  ok "$label CLI installed: $(command -v "$bin" 2>/dev/null) ($("$bin" --version 2>/dev/null | head -n1))"
}

printf "\n${BOLD}[1/6] CLI prerequisites${NC}\n"
ensure_cli_present "Claude Code" claude "$CLAUDE_NPM_PACKAGE" "$INSTALL_CLAUDE_CLI" "$RUN_CLAUDE"
ensure_cli_present "Codex" codex "$CODEX_NPM_PACKAGE" "$INSTALL_CODEX_CLI" "$RUN_CODEX"

printf "\n${BOLD}[2/6] templestay shared resources${NC}\n"
if [[ "$DRY_RUN" -eq 1 ]]; then
  python3 "$SCRIPT_DIR/scripts/materialize_shared_resources.py" --check
else
  python3 "$SCRIPT_DIR/scripts/materialize_shared_resources.py"
fi
ok "templestay shared resource materialization complete"

printf "\n${BOLD}[3/6] templestay shared memory profile${NC}\n"
memory_args=(--profile "$MEMORY_PROFILE")
[[ -n "$MEMORY_ROOT" ]] && memory_args+=(--memory-root "$MEMORY_ROOT")
[[ "$DRY_RUN" -eq 1 ]] && memory_args+=(--dry-run)
"$SCRIPT_DIR/scripts/install_templestay_memory.sh" "${memory_args[@]}"
ok "templestay memory profile complete"

if [[ "$RUN_CODEX" -eq 1 ]]; then
  printf "\n${BOLD}[4/6] templestay Codex CLI${NC}\n"
  codex_args=(--preset "$PRESET" --memory-profile "$MEMORY_PROFILE")
  [[ -n "$MEMORY_ROOT" ]] && codex_args+=(--memory-root "$MEMORY_ROOT")
  [[ "$HOOKS" -eq 1 ]] && codex_args+=(--hooks) || codex_args+=(--no-hooks)
  [[ "$DRY_RUN" -eq 1 ]] && codex_args+=(--dry-run)
  "$SCRIPT_DIR/scripts/install_templestay_codex_cli.sh" "${codex_args[@]}"
  ok "templestay Codex setup complete"
else
  warn "Skipping templestay Codex CLI (--claude-only)"
fi

if [[ "$RUN_CLAUDE" -eq 1 ]]; then
  printf "\n${BOLD}[5/6] templestay Claude Code${NC}\n"
  claude_args=(--preset "$PRESET" --scope "$CLAUDE_SCOPE" --memory-profile "$MEMORY_PROFILE")
  [[ -n "$MEMORY_ROOT" ]] && claude_args+=(--memory-root "$MEMORY_ROOT")
  [[ "$HOOKS" -eq 1 ]] && claude_args+=(--hooks) || claude_args+=(--no-hooks)
  [[ "$DRY_RUN" -eq 1 ]] && claude_args+=(--dry-run)
  "$SCRIPT_DIR/scripts/install_templestay_claude_cli.sh" "${claude_args[@]}"
  ok "templestay Claude setup complete"
else
  warn "Skipping templestay Claude Code (--codex-only)"
fi

if [[ "$RESTART_MCP" -eq 1 ]]; then
  printf "\n${BOLD}[6/6] templestay MCP server restart${NC}\n"
  restart_args=()
  [[ "$DRY_RUN" -eq 1 ]] && restart_args+=(--dry-run)
  "$SCRIPT_DIR/scripts/restart_templestay_mcp_servers.sh" "${restart_args[@]}"
  ok "templestay MCP server restart pass complete"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    warn "If you ran install.sh from inside an active Claude Code session, that session's templestay MCP tools are now disconnected — reload (or restart) Claude Code so the parent CLI respawns the fresh stdio children."
  fi
else
  printf "\n${BOLD}[6/6] templestay MCP server restart${NC}\n"
  warn "Skipping MCP restart (--no-restart-mcp); existing stdio children will keep running old code until manually reconnected"
fi

printf "\n${BOLD}=== templestay full install complete ===${NC}\n"
info "Use './install.sh --dry-run' to preview the templestay-only install plan."
info "Use './install.sh --remove-legacy' to remove legacy templerun wiring before installing templestay."
info "Use './install.sh --no-restart-mcp' to keep existing MCP stdio children running (run the restart helper between sessions instead)."
