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
gitmodules = read_text(".gitmodules")
templestay_boundary = read_text("specs/CLARIFICATIONS/templestay-reference-boundary.md")

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
require(".codex/_templestay_dry_run_home/" in gitignore, ".gitignore must keep templestay dry-run CODEX_HOME scratch untracked")
require(".codex/_templestay_no_tavily_env" in gitignore, ".gitignore must keep templestay dry-run Tavily scratch untracked")
require(".codex/config.toml" not in gitignore, ".codex/config.toml must remain trackable")
require("Project-local Codex compatibility" in readme, "README.md must document project-local Codex compatibility")
require("project-scoped `.codex/config.toml`" in readme, "README.md must mention project-scoped .codex/config.toml")
require("codex-cli 0.130.0" in readme, "README.md must record the locally exercised Codex CLI version")
require('codex -C "$REPO_ROOT"' in readme, "README.md must document the project-root/-C launch expectation")
require("Templestay integration readiness" in readme, "README.md must document templestay integration readiness")
require("install_templestay_codex_cli.sh" in readme, "README.md must show the secret-safe templestay Codex installer preview")
require("project-scoped `.codex/config.toml`" in guide, "Peekaboo guide must mention project-scoped .codex/config.toml")
require('codex -C "$REPO_ROOT"' in guide, "Peekaboo guide must document the project-root/-C launch expectation")
codex_doc = read_text("codex.md")
require("bash .codex/verify_alignment.sh" in codex_doc, "codex.md must point to the alignment verifier")
require("upstream Codex schema" in codex_doc, "codex.md must scope the verifier as local invariants rather than upstream schema proof")
require("Templestay integration posture" in codex_doc, "codex.md must document templestay integration posture")
require("resource/templestay" in gitmodules, ".gitmodules must declare the resource/templestay submodule")
require("operator-owned integration path" in templestay_boundary, "templestay boundary must name the operator-owned integration path")
require("secret-free installer dry-runs" in templestay_boundary, "templestay boundary must allow secret-free installer dry-runs")
require("project-owned Codex concurrency contract" in templestay_boundary, "templestay boundary must preserve project-owned Codex concurrency")

templestay_root = root / "resource" / "templestay"
templestay_installer = templestay_root / "scripts" / "install_templestay_codex_cli.sh"
templestay_preset = templestay_root / "codex" / "templestay" / "config" / "presets" / "balanced.toml"
templestay_cli_readme = templestay_root / "prototypes" / "templestay-cli" / "README.md"

require(templestay_root.exists(), "resource/templestay submodule must be checked out")
require(templestay_installer.exists(), "templestay Codex installer missing")
require(templestay_preset.exists(), "templestay balanced Codex preset missing")
require(templestay_cli_readme.exists(), "templestay CLI harness README missing")

if templestay_installer.exists():
    installer_text = templestay_installer.read_text(encoding="utf-8")
    require(
        "Agent thread limits" in installer_text and "templestay does not write them" in installer_text,
        "templestay installer must keep Codex agent thread limits user/project/runtime-owned",
    )
    require("--no-tavily" in installer_text, "templestay installer must support a Tavily-free preview path")

if templestay_preset.exists():
    try:
        templestay_preset_data = tomllib.loads(templestay_preset.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        failures.append(f"templestay balanced preset TOML parse failed: {exc}")
        templestay_preset_data = {}
    templestay_block = templestay_preset_data.get("templestay", {}) if isinstance(templestay_preset_data, dict) else {}
    codex_block = templestay_preset_data.get("codex", {}) if isinstance(templestay_preset_data, dict) else {}
    codex_features = codex_block.get("features", {}) if isinstance(codex_block, dict) else {}
    codex_routing = codex_block.get("model_routing", {}) if isinstance(codex_block, dict) else {}
    require(isinstance(templestay_block, dict), "templestay preset must include [templestay]")
    require(isinstance(codex_block, dict), "templestay preset must include [codex]")
    if isinstance(templestay_block, dict):
        require(
            templestay_block.get("state_machine") == "Input → Atomize → Plan → Execute → Verify → Critique → Memory Consolidate → Report",
            "templestay balanced preset must expose the expected lifecycle state machine",
        )
    if isinstance(codex_block, dict):
        require(codex_block.get("model") == "gpt-5.5", "templestay balanced preset must keep GPT-5.5 parent model")
        require(codex_block.get("model_reasoning_effort") == "xhigh", "templestay balanced preset must keep xhigh parent effort")
    require(isinstance(codex_features, dict), "templestay balanced preset must include [codex.features]")
    if isinstance(codex_features, dict):
        require(codex_features.get("memories") is False, "templestay Codex preset must keep built-in memories disabled")
        require(codex_features.get("goals") is True, "templestay Codex preset must keep goals feature explicitly enabled")
    require(isinstance(codex_routing, dict), "templestay balanced preset must include [codex.model_routing]")
    if isinstance(codex_routing, dict):
        require(codex_routing.get("enabled") is True, "templestay balanced preset must enable cost-optimized route metadata")
        require(codex_routing.get("no_silent_reroute") is True, "templestay balanced preset must forbid silent reroute")

if templestay_cli_readme.exists():
    templestay_cli_doc = templestay_cli_readme.read_text(encoding="utf-8")
    require("tstay install --dry-run" in templestay_cli_doc, "templestay CLI README must document tstay install dry-run")
    require(
        "Codex and Claude provider" in templestay_cli_doc
        and "SDKs as exact-pinned runtime dependencies" in templestay_cli_doc,
        "templestay CLI README must document packaged provider SDKs",
    )

if templestay_installer.exists():
    dry_run_codex_home = root / ".codex" / "_templestay_dry_run_home"
    dry_run_tavily_file = root / ".codex" / "_templestay_no_tavily_env"
    shutil.rmtree(dry_run_codex_home, ignore_errors=True)
    try:
        dry_run_tavily_file.unlink()
    except FileNotFoundError:
        pass

    dry_run_env = os.environ.copy()
    dry_run_env.update(
        {
            "CODEX_HOME": str(dry_run_codex_home),
            "CLAUDE_BIN": "/__auto_archive_codex_verify_no_claude__",
            "TAVILY_API_KEY": "",
            "TAVILY_ENV_FILE": str(dry_run_tavily_file),
        }
    )
    dry_run_result = subprocess.run(
        [
            "bash",
            str(templestay_installer),
            "--preset",
            "balanced",
            "--memory-profile",
            "none",
            "--dry-run",
            "--no-tavily",
        ],
        cwd=root,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
        check=False,
        env=dry_run_env,
    )
    dry_run_output = f"{dry_run_result.stdout}\n{dry_run_result.stderr}"
    dry_run_artifacts: list[str] = []
    if dry_run_codex_home.exists():
        dry_run_artifacts.append(str(dry_run_codex_home.relative_to(root)))
        shutil.rmtree(dry_run_codex_home, ignore_errors=True)
    if dry_run_tavily_file.exists():
        dry_run_artifacts.append(str(dry_run_tavily_file.relative_to(root)))
        try:
            dry_run_tavily_file.unlink()
        except FileNotFoundError:
            pass

    require(dry_run_result.returncode == 0, f"templestay Codex installer dry-run must pass; got {dry_run_result.returncode}: {dry_run_output[-1000:]}")
    require("shared resource materialization check passed" in dry_run_output, "templestay dry-run must validate materialized shared resources")
    require("model: gpt-5.5" in dry_run_output, "templestay dry-run must preview the GPT-5.5 Codex preset")
    require("memory-profile=none" in dry_run_output, "templestay dry-run must prove memory-profile=none skip path")
    require("tavily-search skipped (--no-tavily)" in dry_run_output, "templestay dry-run must prove Tavily-free path")
    require("agent thread limits remain user/project/runtime-owned" in dry_run_output, "templestay dry-run must not claim ownership of Codex thread limits")
    require(
        not dry_run_artifacts,
        f"templestay dry-run must not leave project-local scratch artifacts: {', '.join(dry_run_artifacts)}",
    )

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
