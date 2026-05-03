"""Unit tests for the templestay gemini-gateway MCP server.

These tests exercise the pure helpers, in particular the ``_redact_stderr``
security scrubber. They do not invoke the real Gemini CLI or make any network
requests.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "mcp-servers" / "gemini-gateway" / "server.py"


def _load_server_module():
    """Import the gateway server.py as ``gemini_gateway_server``."""
    spec = importlib.util.spec_from_file_location("gemini_gateway_server", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def server():
    return _load_server_module()


# ---------------------------------------------------------------------------
# 1. Module import sanity
# ---------------------------------------------------------------------------


def test_module_imports(server):
    assert hasattr(server, "_redact_stderr")
    assert callable(server._redact_stderr)
    assert hasattr(server, "gemini_prompt")
    assert callable(server.gemini_prompt)
    assert hasattr(server, "gemini_models")
    assert callable(server.gemini_models)
    assert hasattr(server, "MAX_PROMPT_SIZE")


# ---------------------------------------------------------------------------
# 2. Pass-through for empty / None
# ---------------------------------------------------------------------------


def test_redact_stderr_passthrough(server):
    assert server._redact_stderr("") == ""
    assert server._redact_stderr(None) is None


# ---------------------------------------------------------------------------
# 3. Home-path username redaction
# ---------------------------------------------------------------------------


def test_redact_stderr_home_path(server):
    linux_input = "error at /home/alice/secrets/foo.txt"
    linux_output = server._redact_stderr(linux_input)
    assert "/home/[REDACTED]/secrets/foo.txt" in linux_output
    assert "alice" not in linux_output

    mac_input = "error at /Users/bob/projects/bar.py line 5"
    mac_output = server._redact_stderr(mac_input)
    assert "/Users/[REDACTED]/projects/bar.py" in mac_output
    assert "bob" not in mac_output


# ---------------------------------------------------------------------------
# 4. Gemini API key redaction
# ---------------------------------------------------------------------------


def test_redact_stderr_gemini_key(server):
    fake_key = "AIza0123456789abcdefghijklmnopqrstuvwxyz12345"
    output = server._redact_stderr(f"using key {fake_key} for request")
    assert "[REDACTED]" in output
    assert "AIza0123456789abcdef" not in output


# ---------------------------------------------------------------------------
# 5. OpenAI-style key redaction
# ---------------------------------------------------------------------------


def test_redact_stderr_openai_key(server):
    fake_key = "sk-abcdefghijklmnopqrstuvwxyz1234"
    output = server._redact_stderr(fake_key)
    assert "sk-abcdefghij" not in output
    assert "[REDACTED]" in output


# ---------------------------------------------------------------------------
# 6. Bearer token redaction
# ---------------------------------------------------------------------------


def test_redact_stderr_bearer_token(server):
    header = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"
    output = server._redact_stderr(header)
    assert "eyJhbGciOiJIUzI1NiJ9" not in output
    assert "[REDACTED]" in output


# ---------------------------------------------------------------------------
# 7. Email address redaction
# ---------------------------------------------------------------------------


def test_redact_stderr_email(server):
    text = "contact admin@example.com for help"
    output = server._redact_stderr(text)
    assert "admin@example.com" not in output
    assert "[REDACTED]" in output


# ---------------------------------------------------------------------------
# 8. Truncation at 2000 chars
# ---------------------------------------------------------------------------


def test_redact_stderr_truncation(server):
    long_input = "x" * 5000
    output = server._redact_stderr(long_input)
    truncation_suffix = "… [truncated]"
    assert output.endswith(truncation_suffix)
    assert len(output) <= 2000 + len(truncation_suffix)


# ---------------------------------------------------------------------------
# 9. Exactly two MCP tool functions exposed
# ---------------------------------------------------------------------------


def test_two_mcp_tools_only(server):
    # The two registered tools must exist as callables.
    assert callable(server.gemini_prompt)
    assert callable(server.gemini_models)
    # Regression: no phantom council/vote/apply tools must be present.
    for forbidden in ("gemini_apply", "gemini_council", "gemini_vote"):
        assert not hasattr(server, forbidden), f"unexpected tool found: {forbidden}"


# ---------------------------------------------------------------------------
# 10. MAX_PROMPT_SIZE is large enough to cover the long-context trigger
# ---------------------------------------------------------------------------


def test_max_prompt_size_covers_long_context_trigger(server):
    # Long-context trigger fires at >~200K tokens; at ~4 bytes/token that is
    # >800_000 bytes.  The cap must comfortably exceed that threshold.
    assert server.MAX_PROMPT_SIZE > 200_000 * 4
