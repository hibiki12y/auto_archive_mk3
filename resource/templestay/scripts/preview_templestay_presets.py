#!/usr/bin/env python3
"""Preview or validate templestay native Codex/Claude presets."""
from __future__ import annotations

import argparse
import json
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_codex(preset: str) -> dict:
    path = ROOT / "codex" / "templestay" / "config" / "presets" / f"{preset}.toml"
    with path.open("rb") as fh:
        return tomllib.load(fh)


def load_claude(preset: str) -> dict:
    path = ROOT / "claude" / "templestay" / "settings" / "presets" / f"{preset}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform", nargs="?", choices=("codex", "claude", "all"), default="all")
    parser.add_argument("--preset", choices=("balanced", "deep", "minimal"), default="balanced")
    parser.add_argument("--scope", choices=("user", "project", "local"), default="user")
    args = parser.parse_args()

    if args.platform in ("codex", "all"):
        data = load_codex(args.preset)
        assert data["templestay"]["deployment_id"] == "templestay"
        codex = data.get("codex", {})
        features = codex.get("features", {})
        memories_enabled = features.get("memories", True)
        print(f"templestay Codex preset: {args.preset}")
        print(f"  deployment_id: {data['templestay']['deployment_id']}")
        print(f"  model: {codex.get('model', '<preserve-current>')}")
        print(f"  reasoning_effort: {codex.get('model_reasoning_effort', '<unset>')}")
        print(f"  verbosity: {codex.get('model_verbosity', '<unset>')}")
        mcp_profile = data["templestay"]["mcp_profile"]
        print(f"  mcp_profile: {mcp_profile}")
        mcp_servers = ["memory"] if mcp_profile != "none" else []
        if mcp_profile in {"essential", "full"}:
            mcp_servers.extend(["context-manager", "document-parser", "claude-gateway"])
        if mcp_profile == "full":
            mcp_servers.append("gemini-gateway")
        print(f"  mcp_servers: {', '.join(mcp_servers) if mcp_servers else 'none'}")
        if "claude-gateway" in mcp_servers:
            print("  critique_double_check: regular Claude Opus 4.7 via claude-gateway (effort=max)")
        hooks_required = str(data["templestay"]["hooks_required"]).lower()
        print(f"  hooks_required: {hooks_required}")
        print("  instructions: codex/templestay/AGENTS.md (generated from shared/templestay)")
        print(f"  state_machine: {data['templestay']['state_machine']}")
        verify_repair = data["templestay"].get("verify_repair_edge")
        if verify_repair:
            print(f"  verify_repair_edge: {verify_repair}")
        print(f"  repair_edge: {data['templestay']['repair_edge']}")
        print(f"  built_in_memories: {'enabled' if memories_enabled else 'disabled'}")
    if args.platform == "all":
        print()
    if args.platform in ("claude", "all"):
        data = load_claude(args.preset)
        print(f"templestay Claude preset: {args.preset}")
        print(f"  scope: {args.scope}")
        print(f"  model: {data.get('model', '<unset>')}")
        print(f"  effortLevel: {data.get('effortLevel', '<unset>')}")
        auto_memory = data.get("autoMemoryEnabled")
        if auto_memory is None:
            auto_memory_label = "default(enabled)"
        else:
            auto_memory_label = "enabled" if auto_memory else "disabled"
        print(f"  autoMemoryEnabled: {auto_memory_label}")
        print("  instructions: claude/templestay/CLAUDE.md (generated from shared/templestay)")
        print("  hooks_required: false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
