"""Unit tests for the templestay codex-gateway MCP server.

These tests exercise the pure helpers (path normalization, allowed-paths
validation, command builder, error classification, JSONL parsing). They do
not invoke the real Codex CLI. An integration test that depends on the
``codex`` binary is provided but is skipped when ``codex`` is unavailable
or ``TEMPLESTAY_CODEX_GATEWAY_LIVE=1`` is unset.
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "mcp-servers" / "codex-gateway" / "server.py"


def _load_server_module():
    """Import the gateway server.py as ``codex_gateway_server``."""
    spec = importlib.util.spec_from_file_location("codex_gateway_server", SERVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def server():
    return _load_server_module()


# ---------------------------------------------------------------------------
# server.py is importable and exposes the expected three MCP tools
# ---------------------------------------------------------------------------


def test_server_module_imports_cleanly(server):
    assert hasattr(server, "mcp")
    assert hasattr(server, "codex_preflight")
    assert hasattr(server, "codex_prompt")
    assert hasattr(server, "codex_apply")
    # Multi-vendor / council bits intentionally dropped.
    assert not hasattr(server, "codex_models")
    assert not hasattr(server, "KNOWN_MODELS")


def test_repo_fallback_model_is_high_performance(server):
    assert server.REPO_FALLBACK_MODEL == "gpt-5.5"


def test_failure_stage_constants_match_spec(server):
    expected = {
        "request_validation",
        "primary_precheck",
        "worktree_prepare",
        "codex_execution",
        "diff_validation",
        "apply_recheck",
        "apply_back",
        "cleanup",
    }
    actual = {
        getattr(server, name)
        for name in dir(server)
        if name.startswith("FAILURE_STAGE_")
    }
    assert expected == actual


# ---------------------------------------------------------------------------
# Command builder
# ---------------------------------------------------------------------------


def test_build_codex_command_canonical_form(server):
    cmd = server._build_codex_command(
        "do the thing",
        cwd="/tmp/wt",
        sandbox=server.SANDBOX_WORKSPACE_WRITE,
        model="gpt-5.5",
        output_file="/tmp/out.txt",
    )
    # The first arg is the resolved binary path; subsequent flags must match
    # the canonical form documented in the spec.
    assert cmd[0] == server.CODEX_BIN
    assert cmd[1:4] == ["-a", "never", "exec"]
    # Order of flags after `exec` is fixed by the builder.
    assert "--json" in cmd
    assert "--ephemeral" in cmd
    assert "--skip-git-repo-check" in cmd
    assert "--ignore-rules" in cmd
    assert cmd[cmd.index("-C") + 1] == "/tmp/wt"
    assert cmd[cmd.index("-s") + 1] == "workspace-write"
    assert cmd[cmd.index("-m") + 1] == "gpt-5.5"
    assert cmd[cmd.index("-o") + 1] == "/tmp/out.txt"
    # Prompt is the final positional argument.
    assert cmd[-1] == "do the thing"


def test_build_codex_command_omits_model_when_empty(server):
    cmd = server._build_codex_command(
        "p",
        cwd="/tmp/wt",
        sandbox=server.SANDBOX_READ_ONLY,
        model=None,
        output_file="/tmp/o.txt",
    )
    assert "-m" not in cmd


def test_build_codex_command_uses_read_only_for_prompt(server):
    cmd = server._build_codex_command(
        "p",
        cwd="/tmp/scratch",
        sandbox=server.SANDBOX_READ_ONLY,
        model=None,
        output_file="/tmp/o.txt",
    )
    assert cmd[cmd.index("-s") + 1] == "read-only"


# ---------------------------------------------------------------------------
# Model resolution
# ---------------------------------------------------------------------------


def test_resolve_default_model_prefers_explicit(server):
    name, source = server.resolve_default_model("gpt-9000")
    assert name == "gpt-9000"
    assert source == "explicit-request"


def test_resolve_default_model_falls_back(server):
    # When no explicit model is given and no env override, repo-fallback wins.
    name, source = server.resolve_default_model("")
    assert name == server.DEFAULT_MODEL
    assert source in {"repo-fallback", "runtime-config"}


def test_sanitize_configured_model_drops_unresolved_placeholder(server):
    assert server._sanitize_configured_model("${CODEX_DEFAULT_MODEL}") == ""
    assert server._sanitize_configured_model("") == ""
    assert server._sanitize_configured_model("gpt-5.5") == "gpt-5.5"


def test_resolve_codex_bin_drops_unresolved_placeholder(server, monkeypatch):
    """${CODEX_BIN} placeholder must fall back to PATH lookup, not be used as bin path."""
    monkeypatch.setenv("CODEX_BIN", "${CODEX_BIN}")
    bin_path, source = server.resolve_codex_bin_details()
    # Source must be `path` (which("codex")) or `repo-fallback`, never `env`.
    assert source in {"path", "repo-fallback"}
    assert "${" not in bin_path


# ---------------------------------------------------------------------------
# Path normalization & allowed_paths
# ---------------------------------------------------------------------------


def test_normalize_repo_relative_path_accepts_file(server):
    assert (
        server._normalize_repo_relative_path("dir/file.py", allow_directory=False)
        == "dir/file.py"
    )


def test_normalize_repo_relative_path_accepts_directory_scope(server):
    assert (
        server._normalize_repo_relative_path("dir/", allow_directory=True) == "dir/"
    )


def test_normalize_repo_relative_path_rejects_absolute(server):
    with pytest.raises(server.CodexApplyFailure) as exc:
        server._normalize_repo_relative_path("/etc/passwd", allow_directory=False)
    assert exc.value.category == server.ErrorCategory.REQUEST


def test_normalize_repo_relative_path_rejects_traversal(server):
    with pytest.raises(server.CodexApplyFailure):
        server._normalize_repo_relative_path("../escape", allow_directory=False)
    with pytest.raises(server.CodexApplyFailure):
        server._normalize_repo_relative_path("..", allow_directory=False)


def test_normalize_repo_relative_path_rejects_empty(server):
    with pytest.raises(server.CodexApplyFailure):
        server._normalize_repo_relative_path("", allow_directory=False)
    with pytest.raises(server.CodexApplyFailure):
        server._normalize_repo_relative_path("   ", allow_directory=False)


def test_normalize_allowed_paths_requires_non_empty_list(server, tmp_path):
    with pytest.raises(server.CodexApplyFailure) as exc:
        server._normalize_allowed_paths(str(tmp_path), [])
    assert exc.value.stage == server.FAILURE_STAGE_REQUEST_VALIDATION


def test_normalize_allowed_paths_dedupes_and_sorts(server, tmp_path):
    with pytest.raises(server.CodexApplyFailure):
        # Duplicate after normalization → reject.
        server._normalize_allowed_paths(str(tmp_path), ["a/b", "a/b"])


def test_normalize_allowed_paths_orders_results(server, tmp_path):
    # Create two real subdirs so symlink-touch check passes.
    (tmp_path / "z").mkdir()
    (tmp_path / "a").mkdir()
    paths = server._normalize_allowed_paths(str(tmp_path), ["z/file.py", "a/file.py"])
    assert paths == ["a/file.py", "z/file.py"]


def test_path_allowed_directory_scope(server):
    allowed = ["src/", "spec.md"]
    assert server._path_allowed("src/foo.py", allowed)
    assert server._path_allowed("src/nested/bar.py", allowed)
    assert server._path_allowed("spec.md", allowed)
    assert not server._path_allowed("docs/README.md", allowed)
    assert not server._path_allowed("src", allowed)  # exact dir without trailing slash


def test_repo_lock_path_is_outside_repo_and_deterministic(server, tmp_path):
    repo = str(tmp_path / "primary")
    p1 = server._repo_lock_path(repo)
    p2 = server._repo_lock_path(repo)
    assert p1 == p2, "lock path must be deterministic for the same repo"
    assert not p1.startswith(repo), "lock file must not live inside the validated tree"
    assert p1.endswith(".lock")


def test_repo_lock_paths_differ_per_repo(server, tmp_path):
    a = server._repo_lock_path(str(tmp_path / "alpha"))
    b = server._repo_lock_path(str(tmp_path / "beta"))
    assert a != b


def test_repo_apply_lock_is_reentrant_across_sequential_calls(server, tmp_path):
    repo = str(tmp_path / "repo")
    # Sequential acquire/release must not deadlock and must allow re-entry.
    with server._repo_apply_lock(repo):
        pass
    with server._repo_apply_lock(repo):
        pass


def test_repo_apply_lock_blocks_second_holder_in_other_process(server, tmp_path):
    """A second OS process trying to grab the same flock must wait.

    Fork a child that takes the lock and signals the parent via a pipe; the
    parent then attempts a non-blocking flock on the same path and expects
    EWOULDBLOCK. This is the actual cross-process guarantee that the
    threading.Lock alone cannot provide.
    """
    import fcntl as _fcntl
    import multiprocessing
    import time as _time

    repo = str(tmp_path / "repo-cp")
    lock_path = server._repo_lock_path(repo)

    barrier = multiprocessing.Event()
    release = multiprocessing.Event()

    def hold_lock(path, ready, done):
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        _fcntl.flock(fd, _fcntl.LOCK_EX)
        ready.set()
        done.wait(timeout=5)
        _fcntl.flock(fd, _fcntl.LOCK_UN)
        os.close(fd)

    proc = multiprocessing.Process(target=hold_lock, args=(lock_path, barrier, release))
    proc.start()
    try:
        assert barrier.wait(timeout=5), "child failed to take the lock"
        # Now the lock is held in another process; a non-blocking attempt
        # must fail.
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            blocked = False
            try:
                _fcntl.flock(fd, _fcntl.LOCK_EX | _fcntl.LOCK_NB)
            except BlockingIOError:
                blocked = True
            assert blocked, "second flock attempt should have been blocked"
        finally:
            os.close(fd)
    finally:
        release.set()
        proc.join(timeout=5)
        if proc.is_alive():
            proc.terminate()


def test_execute_codex_log_does_not_leak_prompt(server, monkeypatch, caplog, tmp_path):
    """logger.debug must redact the prompt — callers may pass secrets through it."""
    secret_prompt = "BEGIN-SECRET sk-not-a-real-token END-SECRET"

    class FakeCompleted:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(cmd, **kwargs):  # noqa: ARG001
        # The argv passed to subprocess.run still contains the prompt — that
        # is fine, the kernel will not log it. We only care about logger output.
        return FakeCompleted()

    monkeypatch.setattr(server.subprocess, "run", fake_run)
    # Force the -o file to a writable tmp path (tempfile.mkdtemp is fine here).
    caplog.set_level("DEBUG", logger="codex-gateway-mcp")

    result, elapsed_ms, output_text, error = server._execute_codex(
        secret_prompt,
        cwd=str(tmp_path),
        sandbox=server.SANDBOX_READ_ONLY,
        model="gpt-5.5",
        timeout=10,
    )
    log_text = "\n".join(record.getMessage() for record in caplog.records)
    assert "BEGIN-SECRET" not in log_text
    assert "sk-not-a-real-token" not in log_text
    # Fingerprint form must be present so operators can still tell which
    # invocation is which without seeing the body.
    assert "<prompt len=" in log_text
    assert "sha256:" in log_text


def test_is_ephemeral_codex_path_matches_only_codex_sentinels(server):
    # Codex CLI session marker (zero-byte file or directory at worktree root).
    assert server._is_ephemeral_codex_path(".codex")
    assert server._is_ephemeral_codex_path(".codex/session.json")
    # Nested .codex elsewhere is left to allowed_paths to police.
    assert not server._is_ephemeral_codex_path("src/.codex")
    # Don't catch unrelated dotfiles that merely start with `.codex`.
    assert not server._is_ephemeral_codex_path(".codexrc")
    assert not server._is_ephemeral_codex_path(".codex_config.toml")
    # Don't catch ordinary files.
    assert not server._is_ephemeral_codex_path("src/greet.py")
    assert not server._is_ephemeral_codex_path("README.md")


def test_prime_untracked_paths_filters_codex_sentinels(server, tmp_path, monkeypatch):
    captured: dict[str, list[str]] = {}

    def fake_run_git_checked(repo, args, **_kwargs):  # noqa: ARG001
        if args[:2] == ["ls-files", "--others"]:
            return "\0".join([".codex", ".codex/inner.txt", "src/greet.py"]) + "\0"
        if args[0] == "add":
            captured["paths"] = list(args[args.index("--") + 1 :])
            return ""
        raise AssertionError(f"unexpected git invocation: {args}")

    monkeypatch.setattr(server, "_run_git_checked", fake_run_git_checked)
    server._prime_untracked_paths_for_diff(str(tmp_path))
    # Ephemeral Codex sentinels are filtered before intent-to-add; legitimate
    # untracked work stays in the patch payload.
    assert captured.get("paths") == ["src/greet.py"]


def test_prime_untracked_paths_skips_intent_when_only_sentinels(server, tmp_path, monkeypatch):
    add_calls = 0

    def fake_run_git_checked(repo, args, **_kwargs):  # noqa: ARG001
        nonlocal add_calls
        if args[:2] == ["ls-files", "--others"]:
            return "\0".join([".codex", ".codex/state.bin"]) + "\0"
        if args[0] == "add":
            add_calls += 1
            return ""
        raise AssertionError(f"unexpected git invocation: {args}")

    monkeypatch.setattr(server, "_run_git_checked", fake_run_git_checked)
    server._prime_untracked_paths_for_diff(str(tmp_path))
    # No untracked work product → no `git add --intent-to-add` invocation at all.
    assert add_calls == 0


def test_validate_expected_head_requires_40_hex(server):
    server._validate_expected_head("a" * 40)
    with pytest.raises(server.CodexApplyFailure):
        server._validate_expected_head("ABCDEF" + "a" * 34)  # uppercase rejected
    with pytest.raises(server.CodexApplyFailure):
        server._validate_expected_head("z" * 40)
    with pytest.raises(server.CodexApplyFailure):
        server._validate_expected_head("a" * 39)
    with pytest.raises(server.CodexApplyFailure):
        server._validate_expected_head("")


# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "stderr,expected",
    [
        ("authentication failed: invalid api key", "EXTERNAL_AUTH"),
        ("connection timed out after 30s", "EXTERNAL_NETWORK"),
        ("503 service unavailable", "EXTERNAL_SERVICE"),
        ("rate limit exceeded", "EXTERNAL_SERVICE"),
        ("subscription does not include this feature", "EXTERNAL_ACCOUNT_MODEL_PLAN"),
        ("model not found: gpt-99", "EXTERNAL_MODEL_AVAILABILITY"),
        ("sandbox execution error: container died", "SANDBOX_EXECUTION"),
        ("entitlement missing for that model", "EXTERNAL_ACCOUNT_MODEL_PLAN"),
        ("totally unexpected error", None),
    ],
)
def test_classify_cli_exit(server, stderr, expected):
    result = server._classify_cli_exit(stderr)
    if expected is None:
        assert result is None
    else:
        assert result == getattr(server.ErrorCategory, expected)


# ---------------------------------------------------------------------------
# JSONL event parsing
# ---------------------------------------------------------------------------


def test_parse_jsonl_events_extracts_usage(server):
    stdout = (
        '{"type":"message","content":"hi"}\n'
        '{"type":"usage","input_tokens":100,"output_tokens":20}\n'
    )
    events, usage = server._parse_jsonl_events(stdout)
    assert len(events) == 2
    assert usage is not None
    assert usage.get("input_tokens") == 100


def test_parse_jsonl_events_handles_nested_usage(server):
    stdout = '{"type":"final","usage":{"input_tokens":50,"output_tokens":5}}\n'
    _, usage = server._parse_jsonl_events(stdout)
    assert usage == {"input_tokens": 50, "output_tokens": 5}


def test_parse_jsonl_events_skips_malformed_lines(server):
    stdout = "not json\n{\"type\":\"message\"}\n"
    events, _ = server._parse_jsonl_events(stdout)
    assert len(events) == 1


def test_parse_jsonl_events_handles_empty_input(server):
    events, usage = server._parse_jsonl_events("")
    assert events == []
    assert usage is None


# ---------------------------------------------------------------------------
# Error envelope shape
# ---------------------------------------------------------------------------


def test_error_envelope_carries_routing_observation(server):
    env = server._error_envelope("boom", category=server.ErrorCategory.LOCAL_CLI)
    assert env["success"] is False
    assert env["routing_status"] == server.RoutingStatus.DEGRADED
    obs = env["routing_observation"]
    assert obs["codex_route_attempted"] is True
    assert obs["fallback_required"] is True
    assert obs["failure_category"] == server.ErrorCategory.LOCAL_CLI


# ---------------------------------------------------------------------------
# Preflight (works without invoking codex)
# ---------------------------------------------------------------------------


def test_codex_preflight_returns_canonical_envelope(server):
    result = server.codex_preflight()
    assert set(result.keys()) >= {
        "ready",
        "codex_bin",
        "codex_bin_source",
        "default_model",
        "default_model_source",
        "failure_category",
        "failure_message",
        "routing_status",
        "routing_observation",
    }
    assert result["routing_status"] in {server.RoutingStatus.READY, server.RoutingStatus.DEGRADED}


# ---------------------------------------------------------------------------
# codex_apply request validation (no Codex invocation needed)
# ---------------------------------------------------------------------------


def test_codex_apply_rejects_relative_repo_root(server, tmp_path):
    result = server.codex_apply(
        prompt="x",
        repo_root="not/absolute",
        expected_head="a" * 40,
        allowed_paths=["foo"],
    )
    assert result["success"] is False
    assert result["failure_stage"] == server.FAILURE_STAGE_REQUEST_VALIDATION
    assert result["error_category"] == server.ErrorCategory.REQUEST


def test_codex_apply_rejects_bad_expected_head(server, tmp_path):
    result = server.codex_apply(
        prompt="x",
        repo_root=str(tmp_path),
        expected_head="not-a-sha",
        allowed_paths=["foo"],
    )
    assert result["success"] is False
    assert result["failure_stage"] == server.FAILURE_STAGE_REQUEST_VALIDATION


def test_codex_apply_rejects_empty_allowed_paths(server, tmp_path):
    # Use a real git repo so we get past _resolve_canonical_repo_root.
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit",
         "--allow-empty", "-m", "init", "-q"],
        cwd=tmp_path, check=True,
    )
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path, check=True, capture_output=True, text=True,
    ).stdout.strip()
    canonical = os.path.realpath(str(tmp_path))

    result = server.codex_apply(
        prompt="x",
        repo_root=canonical,
        expected_head=head,
        allowed_paths=[],
    )
    assert result["success"] is False
    assert result["failure_stage"] == server.FAILURE_STAGE_REQUEST_VALIDATION


# ---------------------------------------------------------------------------
# .mcp.json wiring sanity
# ---------------------------------------------------------------------------


def test_mcp_json_wires_codex_gateway():
    import json
    cfg = json.loads(
        (ROOT / "claude" / "templestay" / ".mcp.json").read_text(encoding="utf-8")
    )
    servers = cfg.get("mcpServers", {})
    assert "codex-gateway" in servers
    args = servers["codex-gateway"]["args"]
    assert any("codex-gateway/server.py" in a for a in args)
    assert any("codex-gateway/requirements.txt" in a for a in args)
    # The gateway intentionally has no env block: child processes inherit
    # CODEX_BIN / CODEX_DEFAULT_MODEL from the user's shell automatically,
    # and explicit ${VAR} interpolation breaks when the var is unset.
    assert "env" not in servers["codex-gateway"] or servers["codex-gateway"]["env"] == {}


def test_balanced_and_deep_presets_enable_codex_gateway():
    import json
    for preset in ("balanced", "deep"):
        cfg = json.loads(
            (ROOT / "claude" / "templestay" / "settings" / "presets" / f"{preset}.json").read_text(
                encoding="utf-8"
            )
        )
        assert "codex-gateway" in cfg["enabledMcpjsonServers"], preset


def test_minimal_preset_does_not_enable_codex_gateway():
    """Minimal preset is the Tier 3 cheap-mode escape hatch."""
    import json
    cfg = json.loads(
        (ROOT / "claude" / "templestay" / "settings" / "presets" / "minimal.json").read_text(
            encoding="utf-8"
        )
    )
    assert "codex-gateway" not in cfg.get("enabledMcpjsonServers", [])


def test_project_scope_install_writes_codex_gateway_into_mcp_json(tmp_path):
    """The project-scope installer's .mcp.json generator must include codex-gateway."""
    installer = (
        ROOT / "scripts" / "install_templestay_claude_cli.sh"
    ).read_text(encoding="utf-8")
    # The hardcoded Python heredoc that builds the project-scope .mcp.json
    # must contain a `codex-gateway` entry alongside memory / context-manager
    # / document-parser.
    assert '"codex-gateway"' in installer
    assert 'mcp-servers/codex-gateway/server.py' in installer
    assert 'mcp-servers/codex-gateway/requirements.txt' in installer
    # CODEX_DEFAULT_MODEL / CODEX_BIN guidance still appears in the help
    # text, but the .mcp.json itself does not declare an env block.
    assert "CODEX_DEFAULT_MODEL" in installer  # help/post-install note
    assert "CODEX_BIN" in installer  # readiness probe text


def test_install_script_help_describes_codex_gateway():
    text = (ROOT / "install.sh").read_text(encoding="utf-8")
    assert "codex-gateway" in text
    assert "CODEX_BIN" in text or "CODEX_DEFAULT_MODEL" in text


def test_claude_installer_warns_when_codex_missing():
    """The Claude installer should soft-warn (not fail) if codex is absent."""
    text = (
        ROOT / "scripts" / "install_templestay_claude_cli.sh"
    ).read_text(encoding="utf-8")
    # Soft check — the installer must classify gateway readiness without
    # exiting non-zero.
    assert "codex-gateway: ready" in text
    assert "codex-gateway: degraded" in text
    # Minimal preset is excluded from the codex-gateway check.
    assert 'PRESET" != "minimal"' in text


def test_codex_presets_drop_deprecated_compact_table():
    """Codex CLI 0.125+ rejects [codex.experimental_compact_prompt_file] as a
    table (it now expects a path string). All templestay presets must omit it
    so we don't write an invalid config into the user's ~/.codex/config.toml.
    """
    import tomllib
    for name in ("balanced", "deep", "minimal"):
        path = ROOT / "codex" / "templestay" / "config" / "presets" / f"{name}.toml"
        with path.open("rb") as fh:
            data = tomllib.load(fh)
        codex_block = data.get("codex", {})
        assert "experimental_compact_prompt_file" not in codex_block, (
            f"{name}.toml must not declare deprecated experimental_compact_prompt_file"
        )


def test_codex_installer_does_not_write_deprecated_compact_table():
    """The installer's TOML merge must not reference the deprecated table or
    its key, so it cannot reintroduce the broken shape on a future preset.
    """
    text = (
        ROOT / "scripts" / "install_templestay_codex_cli.sh"
    ).read_text(encoding="utf-8")
    assert "experimental_compact_prompt_file" not in text
    assert "no_memories_if_mcp_or_web_search" not in text


def test_preview_script_does_not_reference_deprecated_compact_table():
    text = (
        ROOT / "scripts" / "preview_templestay_presets.py"
    ).read_text(encoding="utf-8")
    assert "experimental_compact_prompt_file" not in text
    assert "no_memories_if_mcp_or_web_search" not in text


# ---------------------------------------------------------------------------
# Stale-process restart helper
# ---------------------------------------------------------------------------


def test_restart_helper_exists_and_is_executable():
    helper = ROOT / "scripts" / "restart_templestay_mcp_servers.sh"
    assert helper.exists()
    # Execute bit set (chmod +x done at creation).
    assert os.access(helper, os.X_OK)


def test_restart_helper_help_works():
    helper = ROOT / "scripts" / "restart_templestay_mcp_servers.sh"
    result = subprocess.run(
        ["bash", str(helper), "--help"],
        check=True, capture_output=True, text=True,
    )
    out = result.stdout
    assert "templestay MCP server restart helper" in out
    assert "--dry-run" in out
    assert "--grace" in out
    # Safety claim must be visible to the user.
    assert "current user" in out.lower() or "$USER" in out


def test_restart_helper_dry_run_does_not_kill_processes():
    """The helper must NEVER signal processes when --dry-run is set."""
    helper = ROOT / "scripts" / "restart_templestay_mcp_servers.sh"
    result = subprocess.run(
        ["bash", str(helper), "--dry-run"],
        check=True, capture_output=True, text=True,
    )
    out = result.stdout
    # Either it found nothing (clean test environment) or it announced the
    # would-SIGTERM line. In neither case does it actually signal.
    assert (
        "no stale templestay MCP server processes found" in out
        or "would SIGTERM" in out
    )
    # Negative assertion: dry-run must not print the post-kill confirmation.
    assert "force-killing" not in out
    assert "stale templestay MCP servers cleared" not in out


def test_restart_helper_rejects_invalid_grace():
    helper = ROOT / "scripts" / "restart_templestay_mcp_servers.sh"
    result = subprocess.run(
        ["bash", str(helper), "--grace", "abc", "--dry-run"],
        capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "non-negative integer" in result.stderr


def test_install_sh_invokes_restart_helper_in_dry_run():
    """install.sh --dry-run must reach the final restart step and propagate
    --dry-run to the helper, so no process is signalled during preview."""
    result = subprocess.run(
        ["bash", str(ROOT / "install.sh"), "--dry-run"],
        check=True, capture_output=True, text=True,
    )
    out = result.stdout
    assert "[6/6] templestay MCP server restart" in out
    assert "shared resource materialization check passed" in out
    # Helper's dry-run announcement must appear (or the no-stale-found line).
    assert (
        "would SIGTERM" in out
        or "no stale templestay MCP server processes found" in out
    )
    # And no actual kill happened.
    assert "force-killing" not in out


def test_install_sh_no_restart_mcp_skips_step():
    result = subprocess.run(
        ["bash", str(ROOT / "install.sh"), "--dry-run", "--no-restart-mcp"],
        check=True, capture_output=True, text=True,
    )
    out = result.stdout
    assert "[6/6] templestay MCP server restart" in out
    assert "Skipping MCP restart" in out
    # The restart helper output should not appear.
    assert "would SIGTERM" not in out


def test_install_sh_help_documents_restart_flag():
    result = subprocess.run(
        ["bash", str(ROOT / "install.sh"), "--help"],
        check=True, capture_output=True, text=True,
    )
    assert "--no-restart-mcp" in result.stdout


# ---------------------------------------------------------------------------
# Subagent and skill files exist and have the right shape
# ---------------------------------------------------------------------------


def test_codex_coder_subagent_has_no_edit_or_write_tools():
    text = (ROOT / "claude" / "templestay" / "agents" / "templestay-codex-coder.md").read_text(
        encoding="utf-8"
    )
    # Frontmatter line "tools: ..." must list the gateway+memory tools but
    # NOT Edit/Write/MultiEdit (driver does not author code itself).
    tools_line = next(
        line for line in text.splitlines() if line.strip().startswith("tools:")
    )
    assert "Edit" not in tools_line
    assert "Write" not in tools_line
    assert "MultiEdit" not in tools_line
    assert "mcp__codex-gateway__codex_apply" in tools_line
    assert "mcp__codex-gateway__codex_preflight" in tools_line
    assert "mcp__memory__memory_session_save" in tools_line


def test_delegation_skill_documents_three_tiers():
    text = (
        ROOT / "claude" / "templestay" / "skills" / "templestay-codex-delegation" / "SKILL.md"
    ).read_text(encoding="utf-8")
    for tier in ("Tier 3", "Tier 2", "Tier 1"):
        assert tier in text, tier
    # Bound enforced explicitly.
    assert "N = 2" in text or "N=2" in text
    # Architect/Editor framing.
    assert "Architect" in text and "Editor" in text


# ---------------------------------------------------------------------------
# Live integration test — opt-in only
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    shutil.which("codex") is None or os.environ.get("TEMPLESTAY_CODEX_GATEWAY_LIVE") != "1",
    reason="set TEMPLESTAY_CODEX_GATEWAY_LIVE=1 and install Codex CLI to enable",
)
def test_codex_preflight_reports_ready_when_binary_present(server):
    result = server.codex_preflight()
    assert result["ready"] is True
    assert result["codex_bin"]
