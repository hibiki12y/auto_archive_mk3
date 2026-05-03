"""Unit tests for the templestay claude-gateway MCP server.

These tests exercise pure helpers and mocked CLI execution. They do not invoke
Claude Code or make network requests. A live preflight smoke is opt-in only.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "mcp-servers" / "claude-gateway" / "server.py"


def _load_server_module():
    spec = importlib.util.spec_from_file_location("claude_gateway_server", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def server():
    return _load_server_module()


# ---------------------------------------------------------------------------
# Module import sanity / public tools
# ---------------------------------------------------------------------------


def test_module_imports_and_exposes_expected_tools(server):
    assert hasattr(server, "mcp")
    assert callable(server.claude_preflight)
    assert callable(server.claude_prompt)
    assert callable(server.claude_route_probe)
    assert callable(server.claude_models)
    for forbidden in ("claude_apply", "claude_vote", "claude_council"):
        assert not hasattr(server, forbidden), f"unexpected tool found: {forbidden}"


def test_repo_fallback_model_is_claude_opus_47(server):
    assert server.REPO_FALLBACK_MODEL == "claude-opus-4-7"
    assert "claude-opus-4-7" in server.KNOWN_MODELS
    assert server.REPO_FALLBACK_EFFORT == "max"
    assert server.DEFAULT_EFFORT == "max"


# ---------------------------------------------------------------------------
# Command builder / config resolution
# ---------------------------------------------------------------------------


def test_build_command_uses_print_json_read_only_shape(server):
    cmd = server.build_command("explain", "claude-opus-4-7", 2, "max")
    assert cmd[0] == server.CLAUDE_BIN
    assert cmd[1:3] == ["-p", "explain"]
    assert cmd[cmd.index("--output-format") + 1] == "json"
    assert "--no-session-persistence" in cmd
    assert cmd[cmd.index("--max-turns") + 1] == "2"
    assert cmd[cmd.index("--model") + 1] == "claude-opus-4-7"
    assert cmd[cmd.index("--effort") + 1] == "max"
    assert "--disallowedTools" in cmd
    assert "Edit" in cmd and "Write" in cmd and "Bash" in cmd
    assert "--dangerously-skip-permissions" not in cmd


def test_build_command_omits_model_when_empty(server):
    cmd = server.build_command("p", "", 1)
    assert "--model" not in cmd


def test_sanitize_configured_model_drops_unresolved_placeholder(server):
    assert server._sanitize_configured_model("${CLAUDE_DEFAULT_MODEL}") == ""
    assert server._sanitize_configured_model("") == ""
    assert server._sanitize_configured_model("opus") == "opus"


def test_sanitize_configured_effort_accepts_only_known_levels(server):
    assert server._sanitize_configured_effort("${CLAUDE_DEFAULT_EFFORT}") == ""
    assert server._sanitize_configured_effort("") == ""
    assert server._sanitize_configured_effort("MAX") == "max"
    assert server._sanitize_configured_effort("extreme") == ""


def test_content_transfer_policy_defaults_to_synthetic_only(server, monkeypatch):
    monkeypatch.delenv("CLAUDE_GATEWAY_DESTINATION_TRUST", raising=False)
    monkeypatch.delenv("CLAUDE_GATEWAY_ALLOW_REPO_CONTENT", raising=False)
    policy = server.content_transfer_policy()
    assert policy["destination_trust"] == "untrusted_external"
    assert policy["destination_trust_source"] == "repo-default"
    assert policy["content_transfer_allowed"] is False
    assert policy["repo_content_policy"] == "synthetic_only_until_trust_established"
    assert policy["synthetic_route_check_supported"] is True
    assert "destination_trust=trusted_internal" in policy["content_transfer_requirements"]
    assert "policy preauthorization required before repository-content transfer" in policy["content_transfer_requirements"]


def test_content_transfer_policy_allows_repo_content_only_when_trusted(server, monkeypatch):
    monkeypatch.setenv("CLAUDE_GATEWAY_DESTINATION_TRUST", "trusted_internal")
    monkeypatch.setenv("CLAUDE_GATEWAY_ALLOW_REPO_CONTENT", "true")
    policy = server.content_transfer_policy()
    assert policy["destination_trust"] == "trusted_internal"
    assert policy["destination_trust_source"] == "runtime-config"
    assert policy["allow_repo_content_flag"] is True
    assert policy["content_transfer_allowed"] is True
    assert policy["repo_content_policy"] == "policy_preauthorized_repo_content_allowed"
    assert "per-call external-transfer approval not required" in policy["content_transfer_requirements"]


def test_resolve_claude_bin_drops_unresolved_placeholder(server, monkeypatch):
    monkeypatch.setenv("CLAUDE_BIN", "${CLAUDE_BIN}")
    bin_path, source = server.resolve_claude_bin_details()
    assert source in {"path", "repo-fallback"}
    assert "${" not in bin_path


def test_normalize_timeout_and_max_turns(server):
    assert server.normalize_timeout(0) == server.DEFAULT_TIMEOUT
    assert server.normalize_timeout("abc") == server.DEFAULT_TIMEOUT
    assert server.normalize_timeout(3) == 3
    assert server.normalize_max_turns(0) == server.DEFAULT_MAX_TURNS
    assert server.normalize_max_turns(999) == server.MAX_MAX_TURNS


# ---------------------------------------------------------------------------
# Redaction / classification
# ---------------------------------------------------------------------------


def test_redact_stderr_secrets_and_paths(server):
    text = "error /home/alice/proj sk-ant-" + "x" * 30 + " admin@example.com Bearer abc.def"
    out = server._redact_stderr(text)
    assert "/home/[REDACTED]/proj" in out
    assert "sk-ant-" not in out
    assert "admin@example.com" not in out
    assert "abc.def" not in out


@pytest.mark.parametrize(
    "stderr,expected",
    [
        ("authentication failed: invalid api key", "EXTERNAL_AUTH"),
        ("connection timed out after 30s", "EXTERNAL_NETWORK"),
        ("503 service unavailable", "EXTERNAL_SERVICE"),
        ("rate limit exceeded", "EXTERNAL_SERVICE"),
        ("model not found: claude-99", "EXTERNAL_MODEL_AVAILABILITY"),
        ("There's an issue with the selected model (claude-opus-4-7). It may not exist or you may not have access to it. Run --model to pick a different model.", "EXTERNAL_MODEL_AVAILABILITY"),
        ("permission denied by disallowed tool", "REQUEST"),
        ("totally unexpected error", None),
    ],
)
def test_classify_cli_exit(server, stderr, expected):
    result = server.classify_cli_exit(stderr)
    if expected is None:
        assert result is None
    else:
        assert result == getattr(server.ErrorCategory, expected)


def test_error_envelope_carries_routing_observation(server):
    env = server._error_envelope("boom", category=server.ErrorCategory.LOCAL_CLI)
    assert env["success"] is False
    assert env["routing_status"] == server.RoutingStatus.DEGRADED
    assert env["routing_observation"]["claude_route_attempted"] is True


# ---------------------------------------------------------------------------
# Mocked CLI execution
# ---------------------------------------------------------------------------


def test_run_claude_parses_json_result(server, monkeypatch, tmp_path):
    class FakeCompleted:
        returncode = 0
        stdout = json.dumps(
            {
                "type": "result",
                "subtype": "success",
                "result": '{"ok": true}',
                "model": "opus",
                "usage": {"input_tokens": 10, "output_tokens": 2},
                "duration_ms": 123,
                "session_id": "s1",
                "total_cost_usd": 0.01,
            }
        )
        stderr = ""

    def fake_run(cmd, **kwargs):  # noqa: ARG001
        return FakeCompleted()

    monkeypatch.setattr(server.subprocess, "run", fake_run)
    result = server.run_claude(
        prompt="p",
        model="opus",
        json_mode=True,
        timeout=1,
        max_turns=1,
        effort="max",
        cwd=str(tmp_path),
    )
    assert result["success"] is True
    assert result["response"] == '{"ok": true}'
    assert result["parsed"] is True
    assert result["data"] == {"ok": True}
    assert result["tokens"]["input_tokens"] == 10
    assert result["effort"] == "max"
    assert result["latency_ms"] == 123
    assert result["session_id"] == "s1"


def test_run_claude_classifies_nonzero_json_model_error(server, monkeypatch, tmp_path):
    class FakeCompleted:
        returncode = 1
        stdout = json.dumps(
            {
                "is_error": True,
                "result": (
                    "There's an issue with the selected model (claude-opus-4-7). "
                    "It may not exist or you may not have access to it."
                ),
            }
        )
        stderr = ""

    def fake_run(cmd, **kwargs):  # noqa: ARG001
        return FakeCompleted()

    monkeypatch.setattr(server.subprocess, "run", fake_run)
    result = server.run_claude(
        prompt="p",
        model="claude-opus-4-7",
        json_mode=False,
        timeout=1,
        max_turns=1,
        effort="max",
        cwd=str(tmp_path),
    )
    assert result["success"] is False
    assert result["error_category"] == server.ErrorCategory.EXTERNAL_MODEL_AVAILABILITY
    assert "selected model" in result["error"]


def test_claude_prompt_fails_if_scratch_mutated(server, monkeypatch):
    class FakeCompleted:
        returncode = 0
        stdout = json.dumps({"result": "ok"})
        stderr = ""

    def fake_run(cmd, **kwargs):  # noqa: ARG001
        Path(kwargs["cwd"], "unexpected.txt").write_text("mutation", encoding="utf-8")
        return FakeCompleted()

    monkeypatch.setattr(server.subprocess, "run", fake_run)
    result = server.claude_prompt("p")
    assert result["success"] is False
    assert result["error_category"] == server.ErrorCategory.LOCAL_CLI
    assert "read-only" in result["error"]


def test_claude_route_probe_uses_fixed_synthetic_prompt(server, monkeypatch):
    captured: dict[str, object] = {}

    def fake_run(**kwargs):
        captured.update(kwargs)
        return {
            "success": True,
            "response": "SYNTHETIC_ROUTE_OK",
            "error": None,
            "routing_status": server.RoutingStatus.ROUTED,
        }

    monkeypatch.setattr(server, "run_claude", fake_run)
    result = server.claude_route_probe(model="claude-opus-4-7", effort="max")

    assert result["success"] is True
    assert result["response"] == "SYNTHETIC_ROUTE_OK"
    assert result["synthetic_route_check"] is True
    assert result["contains_repository_content"] is False
    prompt = captured["prompt"]
    assert isinstance(prompt, str)
    assert "no repository content" in prompt
    assert "SYNTHETIC_ROUTE_OK" in prompt
    assert captured["max_turns"] == 1


def test_run_claude_rejects_oversized_prompt(server, tmp_path):
    result = server.run_claude(
        prompt="x" * (server.MAX_PROMPT_SIZE + 1),
        model="opus",
        json_mode=False,
        timeout=1,
        max_turns=1,
        effort="max",
        cwd=str(tmp_path),
    )
    assert result["success"] is False
    assert result["error_category"] == server.ErrorCategory.REQUEST


# ---------------------------------------------------------------------------
# Preflight and install-surface checks
# ---------------------------------------------------------------------------


def test_claude_preflight_returns_canonical_envelope(server):
    result = server.claude_preflight()
    assert set(result.keys()) >= {
        "ready",
        "claude_bin",
        "claude_bin_source",
        "default_model",
        "default_model_source",
        "default_effort",
        "default_effort_source",
        "failure_category",
        "failure_message",
        "content_transfer_policy",
        "routing_status",
        "routing_observation",
    }
    assert result["routing_status"] in {server.RoutingStatus.READY, server.RoutingStatus.DEGRADED}
    assert result["content_transfer_policy"]["synthetic_route_check_supported"] is True


def test_codex_installer_mentions_claude_gateway():
    text = (ROOT / "scripts" / "install_templestay_codex_cli.sh").read_text(encoding="utf-8")
    assert "claude-gateway" in text
    assert "CLAUDE_BIN" in text
    assert "CLAUDE_DEFAULT_MODEL" in text
    assert "CLAUDE_DEFAULT_EFFORT" in text
    assert "CLAUDE_GATEWAY_DESTINATION_TRUST" in text
    assert "CLAUDE_GATEWAY_ALLOW_REPO_CONTENT" in text
    assert "server.py" in text
    assert "requirements.txt" in text


@pytest.mark.skipif(
    shutil.which("claude") is None or os.environ.get("TEMPLESTAY_CLAUDE_GATEWAY_LIVE") != "1",
    reason="set TEMPLESTAY_CLAUDE_GATEWAY_LIVE=1 and install Claude Code to enable",
)
def test_claude_preflight_reports_ready_when_binary_present(server):
    result = server.claude_preflight()
    assert result["ready"] is True
    assert result["claude_bin"]
