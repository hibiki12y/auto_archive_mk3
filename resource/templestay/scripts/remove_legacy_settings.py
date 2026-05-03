#!/usr/bin/env python3
"""Remove legacy templerun/Copilot/Codex settings after templestay migration.

The script is intentionally dry-run by default. Pass --apply to write changes.
It edits only configuration files and never removes secrets, memory, session
state, plugin packages, caches, or templestay settings.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tomllib
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Iterable

LEGACY_MARKERS = tuple(
    marker.lower()
    for marker in (
        "templerun-codex",
        "codex/templerun-codex",
        "codex\\templerun-codex",
        "installed-plugins/_direct/templerun",
        "installed-plugins\\_direct\\templerun",
        "plugin-data/_direct/templerun",
        "plugin-data\\_direct\\templerun",
        ".copilot/installed-plugins/_direct/templerun",
        ".copilot/plugin-data/_direct/templerun",
        "### BEGIN templerun-codex managed instructions",
        "### END templerun-codex managed instructions",
        ".codex/agents/templerun-codex",
        ".codex\\agents\\templerun-codex",
        ".codex/hooks/templerun-codex",
        ".codex\\hooks\\templerun-codex",
    )
)

TEMPLATESTAY_GUARDS = tuple(
    marker.lower()
    for marker in (
        "templestay",
        "TEMPLATESTAY_MEMORY_ROOT",
        "MEMORY_V2_SERVICE_NAME",
        "memory-v2.5",
    )
)

COPILOT_MCP_MARKERS = (
    "copilot/mcp-servers",
    "copilot\\mcp-servers",
    "${workspacefolder}/copilot/mcp-servers",
)

LEGACY_MCP_NAMES = {
    "templerun-arxiv",
    "templerun-context7",
    "templerun-memory",
    "templerun-tavily-search",
    "templerun-session-gate",
    "templerun-context-manager",
    "templerun-gemini",
    "templerun-document-parser",
    "templerun-codex-gateway",
}

VSCODE_MAP_ENTRIES = {
    "chat.pluginLocations": {
        "copilot/agents",
        "shared/skills",
        "shared/instructions",
        "copilot/hooks.json",
        ".github/agents",
        ".github/skills",
        ".github/instructions",
        ".github/hooks.json",
        "~/.copilot/agents",
        "~/.copilot/skills",
        "~/.copilot/instructions",
        "~/.copilot/hooks.json",
    },
    "chat.agentFilesLocations": {"copilot/agents", ".github/agents", "~/.copilot/agents"},
    "chat.agentSkillsLocations": {"shared/skills", ".github/skills", "~/.copilot/skills"},
    "chat.instructionsFilesLocations": {
        "shared/instructions",
        ".github/instructions",
        "~/.copilot/instructions",
    },
    "chat.hookFilesLocations": {"copilot/hooks.json", ".github/hooks.json", "~/.copilot/hooks.json"},
}

# Historical scalar keys written by scripts/install_vsc.sh. These are only
# removed with --aggressive-vscode because they may overlap with user preference.
AGGRESSIVE_VSCODE_SCALAR_KEYS = {
    "chat.plugins.enabled",
    "chat.useAgentSkills",
    "chat.useAgentsMdFile",
    "chat.useNestedAgentsMdFiles",
    "chat.useCustomizationsInParentRepositories",
    "chat.includeApplyingInstructions",
    "chat.includeReferencedInstructions",
    "chat.useCustomAgentHooks",
    "chat.agent.maxRequests",
    "github.copilot.chat.agent.autoFix",
    "github.copilot.chat.codesearch.enabled",
    "github.copilot.chat.tools.memory.enabled",
    "github.copilot.chat.summarizeAgentConversationHistory.enabled",
    "github.copilot.chat.virtualTools.threshold",
    "github.copilot.chat.cli.customAgents.enabled",
    "chat.mcp.discovery.enabled",
    "chat.mcp.apps.enabled",
    "chat.mcp.autoStart",
    "chat.mcp.autostart",
    "chat.checkpoints.enabled",
    "chat.checkpoints.showFileChanges",
    "chat.requestQueuing.defaultAction",
    "chat.tools.terminal.blockDetectedFileWrites",
    "chat.agent.thinkingStyle",
    "workbench.startupEditor",
    "chat.viewSessions.enabled",
    "chat.viewSessions.orientation",
    "chat.customAgentInSubagent.enabled",
    "chat.subagents.allowInvocationsFromSubagents",
}


@dataclass
class Result:
    target: str
    status: str
    detail: str
    changed: bool = False
    backup: str = ""


def _text_has_any(text: str, markers: Iterable[str]) -> bool:
    lower = text.lower()
    return any(marker in lower for marker in markers)


def _encode(value: Any) -> str:
    try:
        return json.dumps(value, sort_keys=True, ensure_ascii=False)
    except TypeError:
        return str(value)


def _is_templestay_text(text: str) -> bool:
    return _text_has_any(text, TEMPLATESTAY_GUARDS)


def _is_legacy_mcp(name: str, value: Any) -> bool:
    lower_name = name.lower()
    encoded = _encode(value).lower()
    if lower_name in LEGACY_MCP_NAMES or lower_name.startswith("templerun-"):
        return True
    if _text_has_any(encoded, LEGACY_MARKERS):
        return True
    # Legacy Copilot/VS Code MCP settings point at copilot/mcp-servers without
    # the templestay memory-v2.5 env guards. Keep templestay-generated .mcp.json.
    if _text_has_any(encoded, COPILOT_MCP_MARKERS) and not _is_templestay_text(encoded):
        return True
    return False


def _backup_path(path: Path, suffix: str = ".bak.legacy-settings") -> Path:
    candidate = path.with_name(path.name + suffix)
    if not candidate.exists():
        return candidate
    for index in range(1, 1000):
        numbered = path.with_name(path.name + f"{suffix}.{index}")
        if not numbered.exists():
            return numbered
    raise RuntimeError(f"could not allocate backup filename for {path}")


def _write_text(path: Path, text: str, apply: bool) -> str:
    if not apply:
        return ""
    backup = _backup_path(path)
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, backup)
    path.write_text(text, encoding="utf-8")
    return str(backup)


def _load_json_object(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - report parse errors compactly
        return None, str(exc)
    if not isinstance(data, dict):
        return None, "not a JSON object"
    return data, None


def _clean_mcp_servers(data: dict[str, Any], key: str) -> list[str]:
    servers = data.get(key)
    if not isinstance(servers, dict):
        return []
    removed: list[str] = []
    for name in list(servers):
        if _is_legacy_mcp(name, servers.get(name)):
            servers.pop(name, None)
            removed.append(name)
    return removed


def clean_json_mcp_file(path: Path, apply: bool, key: str) -> Result:
    if not path.exists():
        return Result(str(path), "ABSENT", "not present")
    data, error = _load_json_object(path)
    if data is None:
        return Result(str(path), "SKIPPED", error or "parse error")
    removed = _clean_mcp_servers(data, key)
    if not removed:
        return Result(str(path), "UNCHANGED", "no legacy MCP servers found")
    new_text = json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    backup = _write_text(path, new_text, apply)
    status = "UPDATED" if apply else "DRYRUN"
    return Result(str(path), status, "removed MCP servers: " + ", ".join(removed), True, backup)


def _clean_hooks_object(data: dict[str, Any]) -> int:
    hooks = data.get("hooks")
    if not isinstance(hooks, dict):
        return 0
    removed = 0
    for event in list(hooks):
        groups = hooks.get(event)
        if not isinstance(groups, list):
            continue
        kept = []
        for group in groups:
            encoded = _encode(group).lower()
            is_legacy = _text_has_any(encoded, LEGACY_MARKERS) or (
                "copilot/hooks" in encoded and not _is_templestay_text(encoded)
            )
            if is_legacy:
                removed += 1
            else:
                kept.append(group)
        if kept:
            hooks[event] = kept
        else:
            hooks.pop(event, None)
    return removed


def clean_hooks_json(path: Path, apply: bool) -> Result:
    if not path.exists():
        return Result(str(path), "ABSENT", "not present")
    data, error = _load_json_object(path)
    if data is None:
        return Result(str(path), "SKIPPED", error or "parse error")
    removed = _clean_hooks_object(data)
    if not removed:
        return Result(str(path), "UNCHANGED", "no legacy hook groups found")
    new_text = json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    backup = _write_text(path, new_text, apply)
    status = "UPDATED" if apply else "DRYRUN"
    return Result(str(path), status, f"removed legacy hook groups: {removed}", True, backup)


def _remove_managed_block(value: str) -> str:
    begin = "### BEGIN templerun-codex managed instructions"
    end = "### END templerun-codex managed instructions"
    pattern = re.compile(rf"\n?{re.escape(begin)}\n.*?\n{re.escape(end)}\n?", re.DOTALL)
    return pattern.sub("\n", value).strip()


def _table_name(line: str) -> str | None:
    stripped = line.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        return stripped[1:-1]
    return None


def _sectionize_toml(text: str) -> list[tuple[str | None, list[str]]]:
    sections: list[tuple[str | None, list[str]]] = []
    current_name: str | None = None
    current_lines: list[str] = []
    for line in text.splitlines():
        name = _table_name(line)
        if name is not None:
            sections.append((current_name, current_lines))
            current_name = name
            current_lines = [line]
        else:
            current_lines.append(line)
    sections.append((current_name, current_lines))
    return sections


def clean_codex_config(path: Path, apply: bool) -> Result:
    if not path.exists():
        return Result(str(path), "ABSENT", "not present")
    text = path.read_text(encoding="utf-8")
    removed: list[str] = []
    preserved_developer_instructions = ""
    had_managed_developer_instructions = "### BEGIN templerun-codex managed instructions" in text
    if had_managed_developer_instructions:
        try:
            parsed = tomllib.loads(text)
            dev = parsed.get("developer_instructions", "")
            if isinstance(dev, str):
                preserved_developer_instructions = _remove_managed_block(dev)
        except Exception:
            preserved_developer_instructions = ""

    kept_sections: list[list[str]] = []
    inserted_developer = False
    for section_name, lines in _sectionize_toml(text):
        section_text = "\n".join(lines)
        if section_name == 'plugins."templerun-codex@local"':
            removed.append(section_name)
            continue
        if section_name and section_name.startswith("mcp_servers."):
            server_name = section_name.split(".", 1)[1].strip('"')
            if _is_legacy_mcp(server_name, section_text):
                removed.append(section_name)
                continue

        new_lines: list[str] = []
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("model_instructions_file") and _text_has_any(line, LEGACY_MARKERS):
                removed.append("model_instructions_file")
                continue
            if had_managed_developer_instructions and stripped.startswith("developer_instructions"):
                removed.append("developer_instructions managed block")
                if preserved_developer_instructions and not inserted_developer:
                    new_lines.append(
                        "developer_instructions = "
                        + json.dumps(preserved_developer_instructions, ensure_ascii=False)
                    )
                    inserted_developer = True
                continue
            new_lines.append(line)
        kept_sections.append(new_lines)

    new_text = "\n".join("\n".join(lines).rstrip() for lines in kept_sections if lines).strip() + "\n"
    if new_text == text:
        return Result(str(path), "UNCHANGED", "no legacy Codex config found")
    backup = _write_text(path, new_text, apply)
    status = "UPDATED" if apply else "DRYRUN"
    detail = "removed: " + ", ".join(dict.fromkeys(removed))
    return Result(str(path), status, detail, True, backup)


def clean_vscode_settings(path: Path, apply: bool, aggressive: bool) -> Result:
    if not path.exists():
        return Result(str(path), "ABSENT", "not present")
    data, error = _load_json_object(path)
    if data is None:
        return Result(str(path), "SKIPPED", error or "parse error")
    removed: list[str] = []
    for key, entries in VSCODE_MAP_ENTRIES.items():
        value = data.get(key)
        if not isinstance(value, dict):
            continue
        for entry in list(value):
            if entry in entries or "templerun" in entry.lower():
                value.pop(entry, None)
                removed.append(f"{key}.{entry}")
        if not value:
            data.pop(key, None)
    custom_agents = data.get("github.copilot.chat.cli.customAgents.agentDirectory")
    if isinstance(custom_agents, str) and custom_agents in {"copilot/agents", "~/.copilot/agents"}:
        data.pop("github.copilot.chat.cli.customAgents.agentDirectory", None)
        removed.append("github.copilot.chat.cli.customAgents.agentDirectory")
    if aggressive:
        for key in sorted(AGGRESSIVE_VSCODE_SCALAR_KEYS):
            if key in data:
                data.pop(key, None)
                removed.append(key)
    if not removed:
        return Result(str(path), "UNCHANGED", "no legacy VS Code settings found")
    new_text = json.dumps(data, indent=4, sort_keys=True, ensure_ascii=False) + "\n"
    backup = _write_text(path, new_text, apply)
    status = "UPDATED" if apply else "DRYRUN"
    return Result(str(path), status, f"removed VS Code settings: {len(removed)}", True, backup)


def default_vscode_targets(repo_root: Path, include_server: bool, include_user: bool) -> list[Path]:
    targets = [repo_root / ".vscode" / "settings.json", repo_root / ".vscode" / "mcp.json"]
    home = Path.home()
    if include_server:
        targets.extend(
            [
                home / ".vscode-server" / "data" / "Machine" / "settings.json",
                home / ".vscode-server-insiders" / "data" / "Machine" / "settings.json",
            ]
        )
    if include_user:
        targets.extend(
            [
                home / ".config" / "Code" / "User" / "settings.json",
                home / ".config" / "Code - Insiders" / "User" / "settings.json",
            ]
        )
    return targets


def collect_results(args: argparse.Namespace) -> list[Result]:
    apply = bool(args.apply)
    repo_root = Path(args.repo_root).expanduser().resolve()
    codex_home = Path(args.codex_home).expanduser()
    copilot_home = Path(args.copilot_home).expanduser()
    results: list[Result] = []

    if not args.no_codex:
        results.append(clean_codex_config(codex_home / "config.toml", apply))
        results.append(clean_hooks_json(codex_home / "hooks.json", apply))
    if not args.no_copilot:
        results.append(clean_json_mcp_file(copilot_home / "mcp-config.json", apply, "mcpServers"))
        results.append(clean_hooks_json(copilot_home / "hooks.json", apply))
    if not args.no_vscode:
        explicit = [Path(p).expanduser() for p in args.vscode_settings]
        targets = explicit or default_vscode_targets(repo_root, args.include_server_vscode, args.include_user_vscode)
        for target in targets:
            if target.name == "mcp.json":
                results.append(clean_json_mcp_file(target, apply, "servers"))
            else:
                results.append(clean_vscode_settings(target, apply, args.aggressive_vscode))
    return results


def parse_args(argv: list[str]) -> argparse.Namespace:
    repo_root_default = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description="Safely remove legacy templerun settings after templestay migration. Dry-run by default.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="write changes and create backups")
    mode.add_argument("--dry-run", action="store_true", help="preview changes only (default)")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON results")
    parser.add_argument("--repo-root", default=str(repo_root_default), help="repo root for workspace VS Code targets")
    parser.add_argument("--codex-home", default=os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    parser.add_argument("--copilot-home", default=os.environ.get("COPILOT_HOME", str(Path.home() / ".copilot")))
    parser.add_argument("--vscode-settings", action="append", default=[], help="explicit VS Code settings/mcp JSON target; repeatable")
    parser.add_argument("--include-server-vscode", action="store_true", help="also inspect VS Code Server/Remote user settings")
    parser.add_argument("--include-user-vscode", action="store_true", help="also inspect local desktop VS Code user settings")
    parser.add_argument("--aggressive-vscode", action="store_true", help="remove historical scalar VS Code keys installed by legacy templerun")
    parser.add_argument("--no-codex", action="store_true", help="skip Codex config/hooks cleanup")
    parser.add_argument("--no-copilot", action="store_true", help="skip Copilot MCP/hooks cleanup")
    parser.add_argument("--no-vscode", action="store_true", help="skip VS Code settings cleanup")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    results = collect_results(args)
    if args.json:
        print(json.dumps([asdict(r) for r in results], indent=2, ensure_ascii=False))
    else:
        print("legacy settings cleanup " + ("apply" if args.apply else "dry-run"))
        for result in results:
            prefix = "*"
            print(f"{prefix} {result.status:9} {result.target} — {result.detail}")
            if result.backup:
                print(f"  backup: {result.backup}")
        print("preserved: secrets, memory roots, session-state, plugin packages, caches, and templestay settings")
        if not args.apply:
            print("pass --apply to write changes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
