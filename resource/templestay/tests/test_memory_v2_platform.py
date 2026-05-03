"""memory-v2.5 platform-neutral root/session/audit tests."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_SERVER = Path(__file__).resolve().parents[1] / "mcp-servers" / "memory-v2" / "server.py"
_spec = importlib.util.spec_from_file_location("memory_v2_server_platform", str(_SERVER))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)


def test_templestay_memory_root_takes_priority(tmp_path, monkeypatch):
    root = tmp_path / "templestay-memory"
    legacy = tmp_path / "legacy-memory"
    monkeypatch.setenv("TEMPLATESTAY_MEMORY_ROOT", str(root))
    monkeypatch.setenv("MEMORY_V2_ROOT", str(legacy))
    monkeypatch.delenv("MEMORY_BASE_DIR", raising=False)

    assert _mod._memory_root_dir() == root.resolve()
    assert _mod._memory_base_dir() == root.resolve() / "memory"
    assert _mod._global_base_dir() == root.resolve() / "global-memory"
    assert _mod._session_state_base_dir() == root.resolve() / "session-state"


def test_memory_v2_root_is_generic_fallback(tmp_path, monkeypatch):
    root = tmp_path / "memory-v2-root"
    monkeypatch.delenv("TEMPLATESTAY_MEMORY_ROOT", raising=False)
    monkeypatch.setenv("MEMORY_V2_ROOT", str(root))
    monkeypatch.delenv("MEMORY_BASE_DIR", raising=False)

    assert _mod._memory_root_dir() == root.resolve()
    assert _mod._memory_base_dir() == root.resolve() / "memory"


def test_memory_base_dir_legacy_override_still_controls_project_base(tmp_path, monkeypatch):
    platform_root = tmp_path / "platform"
    project_base = tmp_path / "project-base"
    monkeypatch.setenv("TEMPLATESTAY_MEMORY_ROOT", str(platform_root))
    monkeypatch.setenv("MEMORY_BASE_DIR", str(project_base))

    assert _mod._memory_root_dir() == platform_root.resolve()
    assert _mod._memory_base_dir() == project_base.resolve()


def test_unresolved_interpolation_falls_back_to_default(tmp_path, monkeypatch):
    # `.mcp.json` may carry `"TEMPLATESTAY_MEMORY_ROOT": "${TEMPLATESTAY_MEMORY_ROOT}"`;
    # when the parent shell never set the variable, some clients pass the literal
    # `${...}` token through to the child instead of the empty string. The server
    # must treat that as unset rather than creating a literal-named directory.
    monkeypatch.setenv("TEMPLATESTAY_MEMORY_ROOT", "${TEMPLATESTAY_MEMORY_ROOT}")
    monkeypatch.delenv("MEMORY_V2_ROOT", raising=False)
    monkeypatch.delenv("MEMORY_BASE_DIR", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))

    # Falls through to the default ~/.copilot path.
    assert _mod._memory_root_dir() == (tmp_path / ".copilot").resolve()


def test_sanitize_root_env_drops_unresolved_and_whitespace(tmp_path):
    assert _mod._sanitize_root_env(None) is None
    assert _mod._sanitize_root_env("") is None
    assert _mod._sanitize_root_env("   ") is None
    assert _mod._sanitize_root_env("${TEMPLATESTAY_MEMORY_ROOT}") is None
    assert _mod._sanitize_root_env("/prefix/${VAR}/suffix") is None
    # Resolved real paths pass through (whitespace trimmed).
    target = str(tmp_path / "ok")
    assert _mod._sanitize_root_env(f"  {target}  ") == target


def test_unresolved_interpolation_skipped_for_secondary_var(tmp_path, monkeypatch):
    monkeypatch.delenv("TEMPLATESTAY_MEMORY_ROOT", raising=False)
    monkeypatch.setenv("MEMORY_V2_ROOT", "${MEMORY_V2_ROOT}")
    monkeypatch.delenv("MEMORY_BASE_DIR", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))

    assert _mod._memory_root_dir() == (tmp_path / ".copilot").resolve()


def test_session_id_detection_order_is_platform_neutral(monkeypatch):
    monkeypatch.setenv("COPILOT_SESSION_ID", "copilot-session")
    monkeypatch.setenv("CLAUDE_SESSION_ID", "claude-session")
    monkeypatch.setenv("CODEX_SESSION_ID", "codex-session")
    monkeypatch.setenv("TEMPLATESTAY_SESSION_ID", "templestay-session")

    assert _mod._detect_session_id() == "templestay-session"

    monkeypatch.delenv("TEMPLATESTAY_SESSION_ID")
    assert _mod._detect_session_id() == "codex-session"

    monkeypatch.delenv("CODEX_SESSION_ID")
    assert _mod._detect_session_id() == "claude-session"

    monkeypatch.delenv("CLAUDE_SESSION_ID")
    assert _mod._detect_session_id() == "copilot-session"


def test_session_dir_detection_and_explicit_session_id(tmp_path, monkeypatch):
    root = tmp_path / "root"
    env_session_dir = tmp_path / "runtime" / "claude-123"
    monkeypatch.setenv("TEMPLATESTAY_MEMORY_ROOT", str(root))
    monkeypatch.setenv("CLAUDE_SESSION_DIR", str(env_session_dir))
    for key in ("TEMPLATESTAY_SESSION_ID", "CODEX_SESSION_ID", "CLAUDE_SESSION_ID", "COPILOT_SESSION_ID"):
        monkeypatch.delenv(key, raising=False)

    auto_dir = _mod._session_memories_dir()
    assert auto_dir == env_session_dir / "memories"

    explicit_dir = _mod._session_memories_dir("explicit-id")
    assert explicit_dir == root.resolve() / "session-state" / "explicit-id" / "memories"


def test_frontmatter_includes_schema_and_platform(monkeypatch):
    monkeypatch.setenv("TEMPLATESTAY_PLATFORM", "claude")
    monkeypatch.setenv("MEMORY_V2_SERVICE_NAME", "templestay")
    fm = _mod._build_frontmatter("Name", "Desc", "project")
    assert fm["memory_schema_version"] == "2.5"
    assert fm["platform"] == "claude"
    assert fm["service_name"] == "templestay"


def test_frontmatter_service_name_picks_up_runtime_env(monkeypatch):
    # Capsules written *after* env was repaired should reflect the new service
    # without requiring a module reload — _detect_service_name reads at call.
    monkeypatch.setenv("MEMORY_V2_SERVICE_NAME", "templestay")
    fm_a = _mod._build_frontmatter("A", "desc", "project")
    monkeypatch.setenv("MEMORY_V2_SERVICE_NAME", "alt-service")
    fm_b = _mod._build_frontmatter("B", "desc", "project")
    assert fm_a["service_name"] == "templestay"
    assert fm_b["service_name"] == "alt-service"


def test_frontmatter_service_name_falls_back_to_default(monkeypatch):
    # Both env vars unset → fall back to GLOBAL_SERVICE_NAME captured at import
    # time (bound under the test process to whatever the runner has set).
    monkeypatch.delenv("MEMORY_V2_SERVICE_NAME", raising=False)
    monkeypatch.delenv("TEMPLATESTAY_MEMORY_SERVICE", raising=False)
    fm = _mod._build_frontmatter("Name", "Desc", "project")
    assert "service_name" in fm
    assert fm["service_name"]  # non-empty string


def test_detect_service_name_legacy_alias(monkeypatch):
    monkeypatch.delenv("MEMORY_V2_SERVICE_NAME", raising=False)
    monkeypatch.setenv("TEMPLATESTAY_MEMORY_SERVICE", "legacy-alias")
    assert _mod._detect_service_name() == "legacy-alias"


def _write_memory(path: Path, *, schema: bool = True, platform: bool = True, tags: str = "") -> None:
    lines = ["---", "name: Test", "description: Desc", "type: project"]
    if schema:
        lines.append("memory_schema_version: '2.5'")
    if platform:
        lines.append("platform: claude")
    if tags:
        lines.append(f"tags: [{tags}]")
    lines.extend(["created: '2020-01-01T00:00:00+00:00'", "updated: '2020-01-01T00:00:00+00:00'", "---", "body", ""])
    path.write_text("\n".join(lines), encoding="utf-8")


def test_memory_tier_audit_and_cleanup_candidates_are_read_only(tmp_path, monkeypatch):
    project = tmp_path / "project"
    global_dir = tmp_path / "global"
    session = tmp_path / "session"
    for directory in (project, global_dir, session):
        directory.mkdir()
    _write_memory(project / "missing-schema.md", schema=False, platform=False, tags="debug")
    _write_memory(global_dir / "ok.md")
    _write_memory(session / "session.md")

    monkeypatch.setattr(_mod, "_project_dir_readonly", lambda: project)
    monkeypatch.setattr(_mod, "_global_memories_dir_readonly", lambda: global_dir)
    monkeypatch.setattr(_mod, "_session_memories_dir_readonly", lambda session_id=None: session)

    audit = _mod.memory_tier_audit(json_output=True)
    assert audit["status"] == "WARN"
    assert {tier["tier"] for tier in audit["tiers"]} == {"session", "project", "global"}

    cleanup = _mod.memory_cleanup_candidates(stale_days=30)
    assert cleanup["status"] == "WARN"
    reasons = "\n".join(c["reason"] for c in cleanup["candidates"])
    assert "missing memory-v2.5 schema/platform metadata" in reasons
    assert "blocked/transient tags" in reasons


def test_memory_tier_audit_does_not_create_missing_tier_directories(tmp_path, monkeypatch):
    root = tmp_path / "memory-root"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("TEMPLATESTAY_MEMORY_ROOT", str(root))
    monkeypatch.setenv("CWD", str(workspace))
    monkeypatch.setattr(_mod, "_find_git_root", lambda cwd=None: None)
    for key in ("TEMPLATESTAY_SESSION_ID", "CODEX_SESSION_ID", "CLAUDE_SESSION_ID", "COPILOT_SESSION_ID"):
        monkeypatch.delenv(key, raising=False)
    for key in ("TEMPLATESTAY_SESSION_DIR", "CODEX_SESSION_DIR", "CLAUDE_SESSION_DIR", "COPILOT_SESSION_DIR"):
        monkeypatch.delenv(key, raising=False)

    audit = _mod.memory_tier_audit(json_output=True)

    assert audit["status"] == "WARN"
    assert not root.exists()
