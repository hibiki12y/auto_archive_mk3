#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

python3 - <<'PY'
from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tomllib

root = Path.cwd()
failures: list[str] = []


def require(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


def read_text(path: str) -> str:
    target = root / path
    require(target.exists(), f"missing required file: {path}")
    if not target.exists():
        return ""
    return target.read_text(encoding="utf-8")

project = read_text("PROJECT.md")
require("status: \"ACTIVE\"" in project or "status: ACTIVE" in project, "PROJECT.md must report ACTIVE status for normal Codex work")
read_text("AGENTS.md")
read_text("codex.md")
readme = read_text("README.md")
guide = read_text("specs/GUIDES/peekaboo-remote-evaluation-mcp.md")
gitignore = read_text(".gitignore")

config_path = root / ".codex" / "config.toml"
require(config_path.exists(), "missing .codex/config.toml")
config: dict[str, object] = {}
if config_path.exists():
    try:
        config = tomllib.loads(config_path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        failures.append(f".codex/config.toml TOML parse failed: {exc}")

features = config.get("features", {}) if isinstance(config, dict) else {}
require(isinstance(features, dict), "[features] table is required")
if isinstance(features, dict):
    require(features.get("multi_agent") is True, "features.multi_agent must be true for Codex subagent dispatch")
    require(features.get("apps") is True, "features.apps must be true for Codex app/connector prompts")
    require(features.get("hooks") is False, "features.hooks must stay false unless repo hooks are intentionally added")
    require(features.get("memories") is False, "features.memories must stay false; use Memory MCP/project ledgers instead")
    multi_agent_v2 = features.get("multi_agent_v2")
    require(isinstance(multi_agent_v2, dict), "features.multi_agent_v2 table is required for Codex 0.130+ concurrency bounds")
    if isinstance(multi_agent_v2, dict):
        require(
            multi_agent_v2.get("enabled") is True,
            "features.multi_agent_v2.enabled must be true for the Codex 0.130+ subagent path",
        )
        require(
            multi_agent_v2.get("max_concurrent_threads_per_session") == 4,
            "features.multi_agent_v2.max_concurrent_threads_per_session must match the bounded Codex concurrency contract",
        )

apps = config.get("apps", {}) if isinstance(config, dict) else {}
if isinstance(apps, dict):
    app_default = apps.get("_default", {})
    require(isinstance(app_default, dict), "[apps._default] table is required")
    if isinstance(app_default, dict):
        require(app_default.get("default_tools_approval_mode") == "prompt", "apps default tool approval mode must stay prompt")
        require(app_default.get("destructive_enabled") is False, "destructive app tools must be disabled by default")
        require(app_default.get("open_world_enabled") is False, "open-world app tools must be disabled by default")
else:
    failures.append("[apps._default] table is required")

agents = config.get("agents", {}) if isinstance(config, dict) else {}
require(isinstance(agents, dict), "[agents] table is required")
if isinstance(agents, dict):
    require(
        "max_threads" not in agents,
        "agents.max_threads must not be set because codex-cli 0.130 rejects it when multi_agent_v2 is enabled",
    )
    for role in ("explorer", "worker", "verifier"):
        role_table = agents.get(role)
        require(isinstance(role_table, dict), f"[agents.{role}] role must be declared")
        if isinstance(role_table, dict):
            require(bool(str(role_table.get("description", "")).strip()), f"agents.{role}.description must be non-empty")

mcp_servers = config.get("mcp_servers", {}) if isinstance(config, dict) else {}
require(isinstance(mcp_servers, dict), "[mcp_servers] table is required")
if isinstance(mcp_servers, dict):
    peekaboo = mcp_servers.get("peekaboo-remote-eval")
    require(isinstance(peekaboo, dict), 'mcp_servers."peekaboo-remote-eval" must be configured')
    if isinstance(peekaboo, dict):
        require(peekaboo.get("command") == "node", "Peekaboo MCP command must be node")
        require(peekaboo.get("args") == ["scripts/start-peekaboo-remote-eval-mcp.mjs"], "Peekaboo MCP args must use the checked-in starter")
        require((root / "scripts" / "start-peekaboo-remote-eval-mcp.mjs").exists(), "Peekaboo MCP starter script missing")

require(".codex/auth.json" in gitignore, ".gitignore must keep local Codex auth untracked")
require(".codex/sessions/" in gitignore, ".gitignore must keep local Codex sessions untracked")
require(".codex/config.toml" not in gitignore, ".codex/config.toml must remain trackable")
require("Project-local Codex compatibility" in readme, "README.md must document project-local Codex compatibility")
require("project-scoped `.codex/config.toml`" in readme, "README.md must mention project-scoped .codex/config.toml")
require("codex-cli 0.130.0" in readme, "README.md must record the locally exercised Codex CLI version")
require('codex -C "$REPO_ROOT"' in readme, "README.md must document the project-root/-C launch expectation")
require("project-scoped `.codex/config.toml`" in guide, "Peekaboo guide must mention project-scoped .codex/config.toml")
require('codex -C "$REPO_ROOT"' in guide, "Peekaboo guide must document the project-root/-C launch expectation")
codex_doc = read_text("codex.md")
require("bash .codex/verify_alignment.sh" in codex_doc, "codex.md must point to the alignment verifier")
require("upstream Codex schema" in codex_doc, "codex.md must scope the verifier as local invariants rather than upstream schema proof")

script_mode = (root / ".codex" / "verify_alignment.sh").stat().st_mode
require(bool(script_mode & stat.S_IXUSR), ".codex/verify_alignment.sh should be executable by the owner")

codex_bin = shutil.which("codex")
if codex_bin:
    version_result = subprocess.run(
        [codex_bin, "--version"],
        cwd=root,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )
    require(version_result.returncode == 0, "codex --version must succeed when codex is on PATH")
    version_text = f"{version_result.stdout}\n{version_result.stderr}"
    version_match = re.search(r"(\d+)\.(\d+)\.(\d+)", version_text)
    require(version_match is not None, f"codex --version output must include a semver version; got {version_text.strip()!r}")
    if version_match is not None:
        version = tuple(int(part) for part in version_match.groups())
        require(version >= (0, 130, 0), f"codex CLI must be >= 0.130.0 for this compatibility surface; got {version_text.strip()!r}")
else:
    print("codex-alignment: WARN: codex CLI not found; skipped live version floor check", file=sys.stderr)

if failures:
    for failure in failures:
        print(f"codex-alignment: FAIL: {failure}", file=sys.stderr)
    raise SystemExit(1)

print("codex-alignment: PASS")
PY
