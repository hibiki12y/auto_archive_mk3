#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
PRESET="balanced"
DRY_RUN=0
HOOKS=0
MEMORY_PROFILE="shared"
MEMORY_ROOT="${TEMPLATESTAY_MEMORY_ROOT:-$HOME/.templestay/memory-v2}"

show_help() {
  cat <<'HELP'
templestay Codex CLI installer

Usage: bash scripts/install_templestay_codex_cli.sh [--preset balanced|deep|minimal] [--memory-profile none|shared|full] [--memory-root PATH] [--dry-run] [--hooks]

Installs the native templestay Codex package id. Hooks are optional hardening and
are disabled unless --hooks is passed.

Balanced/deep presets materialize the Codex MCP profile in ~/.codex/config.toml:
memory, context-manager, document-parser, and read-only claude-gateway
(plus gemini-gateway for deep). Claude CLI must be on PATH (or CLAUDE_BIN set)
for claude-gateway to be ready. Override the default Claude model with
CLAUDE_DEFAULT_MODEL (defaults to claude-opus-4-7) and CLAUDE_DEFAULT_EFFORT
(defaults to max) so Codex Critique gets Claude Opus 4.7 max-effort
double-checking. The standard Critique lane is policy-preauthorized for
minimal repository-derived evidence by default with
CLAUDE_GATEWAY_DESTINATION_TRUST=trusted_internal and
CLAUDE_GATEWAY_ALLOW_REPO_CONTENT=true; override those env vars before install
to opt out or use a different route policy.
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preset)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then echo "Missing value for $1" >&2; exit 1; fi
      PRESET="$2"; shift 2 ;;
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
case "$MEMORY_PROFILE" in none|shared|full) ;; *) echo "Invalid memory profile: $MEMORY_PROFILE" >&2; exit 1 ;; esac

PRESET_FILE="$SCRIPT_DIR/codex/templestay/config/presets/$PRESET.toml"
CONFIG_FILE="$CODEX_HOME/config.toml"

if [[ "$DRY_RUN" == "1" ]]; then
  python3 "$SCRIPT_DIR/scripts/materialize_shared_resources.py" --target codex --check
else
  python3 "$SCRIPT_DIR/scripts/materialize_shared_resources.py" --target codex
fi

python3 "$SCRIPT_DIR/scripts/preview_templestay_presets.py" codex --preset "$PRESET"
echo "templestay Codex memory profile: $MEMORY_PROFILE"

# claude-gateway readiness check (soft — installer never fails on this).
if [[ "$PRESET" != "minimal" ]]; then
  CLAUDE_RESOLVED="${CLAUDE_BIN:-$(command -v claude 2>/dev/null || true)}"
  if [[ -n "$CLAUDE_RESOLVED" && -x "$CLAUDE_RESOLVED" ]]; then
    echo "templestay claude-gateway: ready (claude=$CLAUDE_RESOLVED, model=${CLAUDE_DEFAULT_MODEL:-claude-opus-4-7}, effort=${CLAUDE_DEFAULT_EFFORT:-max}, trust=${CLAUDE_GATEWAY_DESTINATION_TRUST:-trusted_internal}, allow_repo_content=${CLAUDE_GATEWAY_ALLOW_REPO_CONTENT:-true})"
  else
    echo "templestay claude-gateway: degraded — claude binary not found on PATH"
    echo "  Codex will skip read-only Claude consultation until Claude Code is installed."
  fi
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "dry-run: would copy codex/templestay to $CODEX_HOME/plugins/local/templestay"
  echo "dry-run: would copy AGENTS.md to $CODEX_HOME/agents/templestay/AGENTS.md"
  echo "dry-run: would install templestay-* skills into $CODEX_HOME/skills"
  echo "dry-run: would merge [features] from preset $PRESET into $CONFIG_FILE (backup .bak.<ts>)"
  if [[ "$MEMORY_PROFILE" != "none" ]]; then
    echo "dry-run: would upsert [mcp_servers.templestay-memory] in $CONFIG_FILE so the Codex CLI shares the templestay memory-v2.5 store with Claude (root: $MEMORY_ROOT)"
  else
    echo "dry-run: memory-profile=none → skipping [mcp_servers.templestay-memory] registration"
  fi
  case "$PRESET" in
    balanced)
      echo "dry-run: would upsert [mcp_servers.templestay-context-manager], [mcp_servers.templestay-document-parser], and [mcp_servers.templestay-claude-gateway] in $CONFIG_FILE (CLAUDE_DEFAULT_MODEL=${CLAUDE_DEFAULT_MODEL:-claude-opus-4-7}, CLAUDE_DEFAULT_EFFORT=${CLAUDE_DEFAULT_EFFORT:-max}, CLAUDE_GATEWAY_DESTINATION_TRUST=${CLAUDE_GATEWAY_DESTINATION_TRUST:-trusted_internal}, CLAUDE_GATEWAY_ALLOW_REPO_CONTENT=${CLAUDE_GATEWAY_ALLOW_REPO_CONTENT:-true} for Codex hetero Critique)"
      ;;
    deep)
      echo "dry-run: would upsert [mcp_servers.templestay-context-manager], [mcp_servers.templestay-document-parser], [mcp_servers.templestay-claude-gateway], and [mcp_servers.templestay-gemini-gateway] in $CONFIG_FILE (CLAUDE_DEFAULT_MODEL=${CLAUDE_DEFAULT_MODEL:-claude-opus-4-7}, CLAUDE_DEFAULT_EFFORT=${CLAUDE_DEFAULT_EFFORT:-max}, CLAUDE_GATEWAY_DESTINATION_TRUST=${CLAUDE_GATEWAY_DESTINATION_TRUST:-trusted_internal}, CLAUDE_GATEWAY_ALLOW_REPO_CONTENT=${CLAUDE_GATEWAY_ALLOW_REPO_CONTENT:-true} for Codex hetero Critique)"
      ;;
    minimal)
      echo "dry-run: preset minimal → skipping context/document/gateway MCP registration"
      ;;
  esac
  echo "dry-run: memory profile handled by scripts/install_templestay_memory.sh"
  echo "dry-run: hooks optional; requested=$HOOKS"
  exit 0
fi

mkdir -p "$CODEX_HOME/plugins/local" "$CODEX_HOME/agents/templestay" "$CODEX_HOME/skills"
python3 - "$CODEX_HOME/plugins/local/templestay" <<'PYRM'
import shutil, sys
shutil.rmtree(sys.argv[1], ignore_errors=True)
PYRM
cp -R "$SCRIPT_DIR/codex/templestay" "$CODEX_HOME/plugins/local/templestay"
cp "$SCRIPT_DIR/codex/templestay/AGENTS.md" "$CODEX_HOME/agents/templestay/AGENTS.md"
for skill in "$SCRIPT_DIR"/codex/templestay/skills/templestay-*; do
  target="$CODEX_HOME/skills/$(basename "$skill")"
  python3 - "$target" <<'PYRM'
import shutil, sys
shutil.rmtree(sys.argv[1], ignore_errors=True)
PYRM
  cp -R "$skill" "$target"
done

python3 - "$PRESET_FILE" "$CONFIG_FILE" <<'PY'
"""Merge templestay-managed [features] keys from the preset into the user's
~/.codex/config.toml.

Conservative: preserves existing keys, comments, and unrelated tables. Only
templestay-owned keys (currently `memories`) are written or updated. A
timestamped backup is created on every run that would change the file.
"""
from __future__ import annotations

import sys
import time
import tomllib
from pathlib import Path

preset_path = Path(sys.argv[1])
config_path = Path(sys.argv[2])

with preset_path.open("rb") as fh:
    preset = tomllib.load(fh)

codex_block = preset.get("codex", {})
features = codex_block.get("features", {})

managed_features = {k: features[k] for k in ("memories",) if k in features}

if not managed_features:
    print(f"no templestay-managed memory keys in {preset_path.name}; skipping merge")
    sys.exit(0)

config_path.parent.mkdir(parents=True, exist_ok=True)
existing_text = config_path.read_text(encoding="utf-8") if config_path.exists() else ""


def fmt_value(v: object) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    return f'"{v}"'


def upsert_section(text: str, section: str, kv: dict[str, object]) -> tuple[str, bool]:
    if not kv:
        return text, False
    lines = text.splitlines()
    header = f"[{section}]"
    section_idx = -1
    for i, line in enumerate(lines):
        if line.strip() == header:
            section_idx = i
            break
    changed = False
    if section_idx == -1:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(header)
        for k, v in kv.items():
            lines.append(f"{k} = {fmt_value(v)}  # templestay-managed")
        changed = True
        return "\n".join(lines) + ("\n" if not text.endswith("\n") else ""), changed
    end_idx = len(lines)
    for j in range(section_idx + 1, len(lines)):
        stripped = lines[j].strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            end_idx = j
            break
    body = lines[section_idx + 1 : end_idx]
    new_body = list(body)
    for k, v in kv.items():
        replacement = f"{k} = {fmt_value(v)}  # templestay-managed"
        prefix = f"{k} ="
        prefix_quoted = f'"{k}" ='
        for idx, ln in enumerate(new_body):
            stripped = ln.lstrip()
            if stripped.startswith(prefix) or stripped.startswith(prefix_quoted):
                if ln.strip() != replacement:
                    new_body[idx] = replacement
                    changed = True
                break
        else:
            insert_at = len(new_body)
            while insert_at > 0 and not new_body[insert_at - 1].strip():
                insert_at -= 1
            new_body.insert(insert_at, replacement)
            changed = True
    if changed:
        lines[section_idx + 1 : end_idx] = new_body
        return "\n".join(lines) + ("\n" if not text.endswith("\n") else ""), True
    return text, False


updated_text = existing_text
total_changed = False
for section, kv in (("features", managed_features),):
    updated_text, changed = upsert_section(updated_text, section, kv)
    total_changed = total_changed or changed

if not total_changed:
    print(f"templestay-managed keys already match {config_path}; no change")
    sys.exit(0)

if config_path.exists():
    backup = config_path.with_suffix(config_path.suffix + f".bak.templestay.{int(time.time())}")
    backup.write_text(existing_text, encoding="utf-8")
    print(f"backed up existing config to {backup}")

config_path.write_text(updated_text, encoding="utf-8")
print(f"merged templestay-managed memory keys into {config_path}")
PY

# Materialize the Codex MCP profile in ~/.codex/config.toml. The preset's
# `mcp_profile` controls transient/context and gateway servers; memory_profile
# controls the shared durable memory server. Templestay-owned MCP entries are
# replaced as a set, while unrelated user-owned MCP entries are preserved.
python3 - "$CONFIG_FILE" "$SCRIPT_DIR" "$MEMORY_ROOT" "$PRESET_FILE" "$MEMORY_PROFILE" <<'PY'
"""Upsert templestay-managed MCP server entries for Codex CLI.

Managed entries:
- templestay-memory (when memory_profile != none)
- templestay-context-manager and templestay-document-parser (essential/full)
- templestay-claude-gateway (essential/full, read-only consultation)
- templestay-gemini-gateway (full only)

Unrelated MCP entries and the rest of config.toml are preserved verbatim. A
backup is written whenever the file changes.
"""
from __future__ import annotations

import sys
import time
import tomllib
import os
from pathlib import Path

config_path = Path(sys.argv[1])
repo = Path(sys.argv[2]).resolve()
memory_root = sys.argv[3]
preset_path = Path(sys.argv[4])
memory_profile = sys.argv[5]

with preset_path.open("rb") as fh:
    preset = tomllib.load(fh)
mcp_profile = preset.get("templestay", {}).get("mcp_profile", "none")


def fmt_str(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def fmt_array(values: list[str]) -> str:
    return "[" + ", ".join(fmt_str(v) for v in values) + "]"


def uv_args(server_dir: str) -> list[str]:
    return [
        "run",
        "--quiet",
        "--no-project",
        "--with-requirements",
        str(repo / f"mcp-servers/{server_dir}/requirements.txt"),
        str(repo / f"mcp-servers/{server_dir}/server.py"),
    ]


def block(name: str, server_dir: str, env: list[tuple[str, str]] | None = None) -> str:
    lines = [
        f"[mcp_servers.{name}]  # templestay-managed",
        f"command = {fmt_str('uv')}",
        f"args = {fmt_array(uv_args(server_dir))}",
    ]
    if env:
        lines.append("")
        lines.append(f"[mcp_servers.{name}.env]  # templestay-managed")
        for key, value in env:
            lines.append(f"{key} = {fmt_str(value)}")
    return "\n".join(lines) + "\n"

managed_order = [
    ("templestay-memory", "memory-v2"),
    ("templestay-context-manager", "context-manager"),
    ("templestay-document-parser", "document-parser"),
    ("templestay-claude-gateway", "claude-gateway"),
    ("templestay-gemini-gateway", "gemini-gateway"),
]
managed_names = {name for name, _ in managed_order}

desired: list[tuple[str, str, list[tuple[str, str]] | None]] = []
if memory_profile != "none":
    desired.append(
        (
            "templestay-memory",
            "memory-v2",
            [
                ("TEMPLATESTAY_MEMORY_ROOT", memory_root),
                ("MEMORY_V2_SCHEMA_VERSION", "2.5"),
                ("MEMORY_V2_SERVICE_NAME", "templestay"),
            ],
        )
    )
if mcp_profile in {"essential", "full"}:
    claude_gateway_env = [
        ("CLAUDE_DEFAULT_MODEL", os.environ.get("CLAUDE_DEFAULT_MODEL", "claude-opus-4-7")),
        ("CLAUDE_DEFAULT_EFFORT", os.environ.get("CLAUDE_DEFAULT_EFFORT", "max")),
        (
            "CLAUDE_GATEWAY_DESTINATION_TRUST",
            os.environ.get("CLAUDE_GATEWAY_DESTINATION_TRUST", "trusted_internal"),
        ),
        (
            "CLAUDE_GATEWAY_ALLOW_REPO_CONTENT",
            os.environ.get("CLAUDE_GATEWAY_ALLOW_REPO_CONTENT", "true"),
        ),
    ]
    desired.extend(
        [
            ("templestay-context-manager", "context-manager", None),
            ("templestay-document-parser", "document-parser", None),
            ("templestay-claude-gateway", "claude-gateway", claude_gateway_env),
        ]
    )
if mcp_profile == "full":
    desired.append(("templestay-gemini-gateway", "gemini-gateway", None))

config_path.parent.mkdir(parents=True, exist_ok=True)
existing = config_path.read_text(encoding="utf-8") if config_path.exists() else ""

# Remove any existing templestay-managed block (managed comment or historical
# unmanaged header form). User-owned MCP entries are left untouched.
lines = existing.splitlines()
out: list[str] = []
i = 0
removed: list[str] = []
while i < len(lines):
    stripped = lines[i].strip()
    matched_name = None
    for name in managed_names:
        if stripped in {
            f"[mcp_servers.{name}]",
            f"[mcp_servers.{name}]  # templestay-managed",
            f"[mcp_servers.{name}.env]",
            f"[mcp_servers.{name}.env]  # templestay-managed",
        }:
            matched_name = name
            break
    if matched_name is not None:
        removed.append(matched_name)
        i += 1
        while i < len(lines):
            inner = lines[i].strip()
            if inner.startswith("[") and inner.endswith("]"):
                break
            i += 1
        while out and out[-1].strip() == "":
            out.pop()
        continue
    out.append(lines[i])
    i += 1

new_text = "\n".join(out)
if new_text and not new_text.endswith("\n"):
    new_text += "\n"
if desired:
    if new_text and not new_text.endswith("\n\n"):
        new_text += "\n"
    new_text += "\n".join(block(name, server_dir, env).rstrip("\n") for name, server_dir, env in desired) + "\n"

if new_text == existing:
    desired_names = ", ".join(name for name, _, _ in desired) or "none"
    print(f"templestay MCP entries already match {config_path} ({desired_names}); no change")
    sys.exit(0)

if config_path.exists():
    backup = config_path.with_suffix(config_path.suffix + f".bak.templestay-mcp.{int(time.time())}")
    backup.write_text(existing, encoding="utf-8")
    print(f"backed up existing config to {backup}")

config_path.write_text(new_text, encoding="utf-8")
if desired:
    print("updated templestay MCP entries in " + str(config_path) + ": " + ", ".join(name for name, _, _ in desired))
else:
    print(f"removed templestay-managed MCP entries from {config_path}; no entries desired for current profiles")
PY

echo "installed templestay Codex package id to $CODEX_HOME"
echo "next: configure model_instructions_file to $CODEX_HOME/agents/templestay/AGENTS.md or run with --dry-run to inspect preset values"
if [[ "$HOOKS" == "1" ]]; then
  echo "note: optional hooks requested; copy codex/templestay/hooks assets after reviewing commands"
fi
