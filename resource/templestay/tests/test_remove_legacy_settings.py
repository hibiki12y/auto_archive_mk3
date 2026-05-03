import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "remove_legacy_settings.py"
WRAPPER = ROOT / "scripts" / "remove_legacy_settings.sh"


def _run(tmp_path: Path, *args: str):
    return subprocess.run(
        ["python3", str(SCRIPT), "--json", *args],
        check=True,
        capture_output=True,
        text=True,
        cwd=tmp_path,
    )


def test_remove_legacy_settings_dry_run_is_default_and_preserves_files(tmp_path):
    codex_home = tmp_path / "codex"
    codex_home.mkdir()
    config = codex_home / "config.toml"
    original = """
developer_instructions = "custom\\n### BEGIN templerun-codex managed instructions\\nlegacy\\n### END templerun-codex managed instructions"
model_instructions_file = "/home/me/.codex/agents/templerun-codex/AGENTS.md"

[plugins."templerun-codex@local"]
enabled = true

[mcp_servers.memory]
command = "uv"
args = ["run", "/home/me/.copilot/installed-plugins/_direct/templerun/copilot/mcp-servers/memory-v2/server.py"]
""".lstrip()
    config.write_text(original, encoding="utf-8")

    result = _run(
        tmp_path,
        "--codex-home",
        str(codex_home),
        "--copilot-home",
        str(tmp_path / "copilot"),
        "--repo-root",
        str(tmp_path / "repo"),
        "--no-copilot",
        "--no-vscode",
    )

    data = json.loads(result.stdout)
    assert any(item["status"] == "DRYRUN" for item in data)
    assert config.read_text(encoding="utf-8") == original
    assert not list(codex_home.glob("*.bak.legacy-settings*"))


def test_remove_legacy_settings_cleans_codex_config_and_hooks(tmp_path):
    codex_home = tmp_path / "codex"
    codex_home.mkdir()
    config = codex_home / "config.toml"
    config.write_text(
        """
developer_instructions = "custom\\n### BEGIN templerun-codex managed instructions\\nlegacy\\n### END templerun-codex managed instructions"
model_instructions_file = "/home/me/.codex/agents/templerun-codex/AGENTS.md"

[features]
memories = false

[plugins."templerun-codex@local"]
enabled = true

[mcp_servers.memory]
command = "uv"
args = ["run", "/home/me/.copilot/installed-plugins/_direct/templerun/copilot/mcp-servers/memory-v2/server.py"]

[mcp_servers.templestay-memory]
command = "uv"
env = { TEMPLATESTAY_MEMORY_ROOT = "/tmp/memory-v2", MEMORY_V2_SERVICE_NAME = "templestay" }
""".lstrip(),
        encoding="utf-8",
    )
    hooks = codex_home / "hooks.json"
    hooks.write_text(
        json.dumps(
            {
                "hooks": {
                    "PreToolUse": [
                        {"hooks": [{"type": "command", "command": "python3 /x/templerun-codex/hook.py"}]},
                        {"hooks": [{"type": "command", "command": "python3 /x/templestay/hook.py"}]},
                    ]
                }
            }
        ),
        encoding="utf-8",
    )

    result = _run(
        tmp_path,
        "--apply",
        "--codex-home",
        str(codex_home),
        "--copilot-home",
        str(tmp_path / "copilot"),
        "--repo-root",
        str(tmp_path / "repo"),
        "--no-copilot",
        "--no-vscode",
    )

    data = json.loads(result.stdout)
    assert any(item["status"] == "UPDATED" for item in data)
    text = config.read_text(encoding="utf-8")
    assert "custom" in text
    assert "templerun-codex" not in text
    assert "model_instructions_file" not in text
    assert "[features]" in text
    assert "templestay-memory" in text
    assert "TEMPLATESTAY_MEMORY_ROOT" in text
    assert list(codex_home.glob("config.toml.bak.legacy-settings*"))

    hook_data = json.loads(hooks.read_text(encoding="utf-8"))
    groups = hook_data["hooks"]["PreToolUse"]
    assert len(groups) == 1
    assert "templestay" in json.dumps(groups[0])
    assert "templerun-codex" not in json.dumps(hook_data)


def test_remove_legacy_settings_cleans_copilot_and_vscode_mcp_but_keeps_templestay(tmp_path):
    copilot_home = tmp_path / "copilot"
    copilot_home.mkdir()
    mcp_config = copilot_home / "mcp-config.json"
    mcp_config.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "memory": {
                        "command": "uv",
                        "args": ["run", "/home/me/.copilot/plugin-data/_direct/templerun/copilot/mcp-servers/memory-v2/server.py"],
                    },
                    "templestay-memory": {
                        "command": "uv",
                        "args": ["run", "/repo/copilot/mcp-servers/memory-v2/server.py"],
                        "env": {"TEMPLATESTAY_MEMORY_ROOT": "/tmp/memory-v2", "MEMORY_V2_SERVICE_NAME": "templestay"},
                    },
                    "user-tool": {"command": "node", "args": ["server.js"]},
                }
            }
        ),
        encoding="utf-8",
    )
    repo = tmp_path / "repo"
    vscode = repo / ".vscode"
    vscode.mkdir(parents=True)
    (vscode / "mcp.json").write_text(
        json.dumps(
            {
                "servers": {
                    "memory": {"command": "uv", "args": ["${workspaceFolder}/copilot/mcp-servers/memory-v2/server.py"]},
                    "templestayMemory": {
                        "command": "uv",
                        "args": ["${workspaceFolder}/copilot/mcp-servers/memory-v2/server.py"],
                        "env": {"MEMORY_V2_SERVICE_NAME": "templestay"},
                    },
                }
            }
        ),
        encoding="utf-8",
    )

    _run(
        tmp_path,
        "--apply",
        "--codex-home",
        str(tmp_path / "codex"),
        "--copilot-home",
        str(copilot_home),
        "--repo-root",
        str(repo),
        "--no-codex",
    )

    cleaned_mcp = json.loads(mcp_config.read_text(encoding="utf-8"))["mcpServers"]
    assert "memory" not in cleaned_mcp
    assert "templestay-memory" in cleaned_mcp
    assert "user-tool" in cleaned_mcp

    cleaned_vscode = json.loads((vscode / "mcp.json").read_text(encoding="utf-8"))["servers"]
    assert "memory" not in cleaned_vscode
    assert "templestayMemory" in cleaned_vscode


def test_remove_legacy_settings_cleans_vscode_maps_without_aggressive_scalars(tmp_path):
    repo = tmp_path / "repo"
    vscode = repo / ".vscode"
    vscode.mkdir(parents=True)
    settings = vscode / "settings.json"
    settings.write_text(
        json.dumps(
            {
                "chat.agentFilesLocations": {"copilot/agents": True, "custom/agents": True},
                "chat.agent.maxRequests": 100,
                "editor.tabSize": 2,
                "github.copilot.chat.cli.customAgents.agentDirectory": "copilot/agents",
            }
        ),
        encoding="utf-8",
    )

    _run(
        tmp_path,
        "--apply",
        "--codex-home",
        str(tmp_path / "codex"),
        "--copilot-home",
        str(tmp_path / "copilot"),
        "--repo-root",
        str(repo),
        "--no-codex",
        "--no-copilot",
    )

    cleaned = json.loads(settings.read_text(encoding="utf-8"))
    assert cleaned["chat.agentFilesLocations"] == {"custom/agents": True}
    assert cleaned["chat.agent.maxRequests"] == 100
    assert cleaned["editor.tabSize"] == 2
    assert "github.copilot.chat.cli.customAgents.agentDirectory" not in cleaned


def test_remove_legacy_settings_wrapper_delegates_to_python():
    text = WRAPPER.read_text(encoding="utf-8")
    assert "remove_legacy_settings.py" in text
    assert '"$@"' in text
