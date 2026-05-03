#!/usr/bin/env python3
"""
Memory v2 MCP Server — persistent project memory inspired by Claude Code's memdir/ system.

Stores individual .md files with YAML frontmatter in ~/.copilot/memory/<project>/,
auto-maintains MEMORY.md indexes, and exposes MCP tools for project, global, and
session memory save/update/search/list/read/delete/index/audit operations.

Memory taxonomy (four types from Claude Code):
  user      — always private: user's role, preferences, expertise level
  feedback  — default private: corrections AND confirmations from user
  project   — team-visible: ongoing initiatives, deadlines, non-derivable facts
  reference — team-visible: pointers to external systems (URLs, tools, APIs)
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import string
import subprocess
import threading
from collections import OrderedDict
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import yaml
from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MEMORY_TYPES = ("user", "feedback", "project", "reference")
INDEX_FILENAME = "MEMORY.md"
INDEX_MAX_LINES = 200
INDEX_MAX_BYTES = 25 * 1024  # 25 KB
MAX_OUTPUT_CHARS = 50_000  # Self-limiting: truncate tool outputs exceeding this
MAX_CONTENT_BYTES = 1_000_000  # 1 MB — W-12: input size limit
MAX_QUERY_BYTES = 10_000       # 10 KB — W-12: input size limit
MAX_NAME_BYTES = 500           # 500 bytes — W-12: input size limit

STALENESS_THRESHOLDS = [
    (30, "⚠️ VERY OLD — This memory is very old and likely stale."),
    (7, "⚠️ OUTDATED — This memory may be outdated. Verify against current state."),
    (1, "ℹ️ Age note: this memory is more than a day old."),
]

GLOBAL_MEMORY_TYPES = (
    "preference",
    "expertise",
    "convention",
    "pattern",
    "credential_ref",
    "service_config",
    "hypothesis",
    "experiment",
    "insight",
    "literature",
)
GLOBAL_INDEX_FILENAME = "MEMORY.md"
GLOBAL_INDEX_SECTION_TITLES = {
    "preference": "Preferences",
    "expertise": "Expertise",
    "convention": "Conventions",
    "pattern": "Patterns",
    "credential_ref": "Credential References",
    "service_config": "Service Configs",
    "hypothesis": "Hypotheses",
    "experiment": "Experiments",
    "insight": "Insights",
    "literature": "Literature",
}
GLOBAL_SERVICE_NAME = os.environ.get(
    "MEMORY_V2_SERVICE_NAME",
    os.environ.get("TEMPLATESTAY_MEMORY_SERVICE", "copilot-cli"),
)
GLOBAL_DIR_MODE = 0o700
GLOBAL_FILE_MODE = 0o600
GLOBAL_LOCK_TIMEOUT_SEC = 5.0
GLOBAL_LOCK_STALE_SEC = 30.0
GLOBAL_MERGE_LOG_MAX_BYTES = 1_000_000  # 1 MB per spec §8
GLOBAL_MERGE_LOG_MAX_ROTATIONS = 3
GLOBAL_DEFAULT_CONFIDENCE = 0.7

# Type mapping for promotion: local type → global type
PROMOTE_TYPE_MAP = {
    "user": "preference",
    "feedback": "pattern",
    "project": "convention",
    "reference": "convention",
}

SESSION_MEMORY_TYPES = ("context", "summary", "artifact")

# Type mapping for session→project promotion
SESSION_PROMOTE_TYPE_MAP = {
    "context": "project",
    "summary": "feedback",
    "artifact": "reference",
}

# Session memories eligible for promotion (by tag or content signal)
SESSION_PROMOTE_ELIGIBLE_TAGS = frozenset({
    "commit", "decision", "outcome", "lesson", "pattern",
    "completed", "result", "convention", "architecture",
})
SESSION_PROMOTE_BLOCKED_TAGS = frozenset({
    "debug", "wip", "abandoned", "transient", "scratch", "temp",
})

# Promotion criteria for project→global elevation
PROMOTE_MIN_CONFIDENCE = 0.8  # Minimum confidence score to auto-promote
PROMOTE_BLOCKED_TAGS = frozenset({
    "checkpoint", "transient", "wip", "debug", "scratch",
    "one-off", "temp", "abandoned",
})
PROMOTE_ELIGIBLE_TAGS = frozenset({
    "lesson", "pattern", "convention", "preference", "architecture",
    "reusable", "cross-project", "standard", "best-practice",
})

# memory-v2.5 compatibility layer for native templestay / multi-platform use.
# Existing Copilot env/path behavior remains the fallback for backward
# compatibility; platform-neutral variables take precedence when present.
MEMORY_SCHEMA_VERSION = os.environ.get("MEMORY_V2_SCHEMA_VERSION", "2.5")
PLATFORM_SESSION_ID_ENV_ORDER = (
    "TEMPLATESTAY_SESSION_ID",
    "CODEX_SESSION_ID",
    "CLAUDE_SESSION_ID",
    "COPILOT_SESSION_ID",
)
PLATFORM_SESSION_DIR_ENV_ORDER = (
    "TEMPLATESTAY_SESSION_DIR",
    "CODEX_SESSION_DIR",
    "CLAUDE_SESSION_DIR",
    "COPILOT_SESSION_DIR",
)

_file_lock = threading.Lock()
_git_root_lock = threading.Lock()
_cached_git_root: str | None = None

# ---------------------------------------------------------------------------
# Helpers — path resolution
# ---------------------------------------------------------------------------


_UNRESOLVED_INTERPOLATION_RE = re.compile(r"\$\{[^}]+\}")


def _sanitize_root_env(raw: str | None) -> str | None:
    """Drop unresolved ``${VAR}`` interpolations (and pure-whitespace values).

    A child MCP server can be launched with ``"env": {"X": "${X}"}`` in
    ``.mcp.json``. If the parent shell never set ``X``, some clients pass the
    literal ``${X}`` through to the child instead of substituting the empty
    string. Treat any value that still contains an interpolation token as
    unset so the default fallback path runs.
    """
    if raw is None:
        return None
    stripped = raw.strip()
    if not stripped:
        return None
    if _UNRESOLVED_INTERPOLATION_RE.search(stripped):
        return None
    return stripped


def _memory_root_dir() -> Path:
    """Return the platform-neutral memory root for templestay/memory-v2.5.

    Priority:
    1. TEMPLATESTAY_MEMORY_ROOT — native Codex/Claude/shared templestay root.
    2. MEMORY_V2_ROOT — generic future memory-v3 preparation root.
    3. ~/.copilot — legacy/default Copilot-compatible root.

    Values that still contain literal ``${...}`` interpolation markers are
    treated as unset (see ``_sanitize_root_env``).
    """
    raw = _sanitize_root_env(os.environ.get("TEMPLATESTAY_MEMORY_ROOT")) or _sanitize_root_env(
        os.environ.get("MEMORY_V2_ROOT")
    )
    if raw:
        return Path(raw).expanduser().resolve()
    return Path.home() / ".copilot"


def _memory_base_dir() -> Path:
    """Return the project-memory base directory, from env or default."""
    raw = os.environ.get("MEMORY_BASE_DIR", "")
    if raw:
        return Path(raw).expanduser().resolve()
    return _memory_root_dir() / "memory"


def _detect_platform() -> str:
    """Best-effort runtime platform label for v2.5 frontmatter metadata."""
    explicit = os.environ.get("TEMPLATESTAY_PLATFORM") or os.environ.get("MEMORY_V2_PLATFORM")
    if explicit:
        return explicit.strip().lower()
    if os.environ.get("CLAUDE_SESSION_ID") or os.environ.get("CLAUDE_SESSION_DIR"):
        return "claude"
    if os.environ.get("CODEX_SESSION_ID") or os.environ.get("CODEX_SESSION_DIR"):
        return "codex"
    if os.environ.get("COPILOT_SESSION_ID") or os.environ.get("COPILOT_SESSION_DIR"):
        return "copilot"
    return "unknown"


def _find_git_root(cwd: str | None = None) -> str | None:
    """Return the git repo root for *cwd*, or None if not inside a repo.

    Caches the result in a module-level variable to avoid repeated subprocess calls.
    Thread-safe via _git_root_lock.
    """
    global _cached_git_root
    with _git_root_lock:
        if _cached_git_root is not None:
            return _cached_git_root
        # PWD preserves the user's original directory even when CWD is overridden
        work_dir = cwd or os.environ.get("CWD") or os.environ.get("PWD") or os.getcwd()
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--show-toplevel"],
                capture_output=True,
                text=True,
                cwd=work_dir,
                timeout=5,
            )
            if result.returncode == 0:
                root = result.stdout.strip()
                # Skip git roots inside the Copilot plugin installation directory —
                # these are cloned plugin repos, not user project roots.
                copilot_dir = str(Path.home() / ".copilot")
                if root == copilot_dir or root.startswith(copilot_dir + os.sep):
                    return None
                _cached_git_root = root
                return _cached_git_root
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            pass
        return None


def _sanitize_project_key(path: str) -> str:
    """Turn an absolute path into a unique directory name.

    Appends a short hash to prevent collisions from lossy sanitization (W-10).
    """
    sanitized = path.replace(os.sep, "_").replace("/", "_").lstrip("_")
    path_hash = hashlib.sha256(path.encode("utf-8")).hexdigest()[:12]
    return f"{sanitized}_{path_hash}"


def _project_dir() -> Path:
    """Determine the project memory directory. Creates it if it doesn't exist."""
    project_path = _project_dir_readonly()
    project_path.mkdir(parents=True, exist_ok=True)
    return project_path


def _project_dir_readonly() -> Path:
    """Determine the project memory directory without creating it."""
    base = _memory_base_dir()
    git_root = _find_git_root()
    if git_root:
        key = _sanitize_project_key(git_root)
    else:
        # Fallback: PWD preserves user directory when process CWD differs
        cwd = os.environ.get("CWD") or os.environ.get("PWD") or os.getcwd()
        key = _sanitize_project_key(cwd)
    return base / key


# ---------------------------------------------------------------------------
# Helpers — global memory path resolution
# ---------------------------------------------------------------------------


def _global_base_dir() -> Path:
    """Global memory base: <memory-root>/global-memory (user-scoped).

    Creates the directory with ``0700`` permissions if it does not exist.
    Re-applies ``0700`` idempotently on each call so that migrations from a
    non-compliant layout (e.g. ``775``) become self-healing.
    """
    d = _memory_root_dir() / "global-memory"
    d.mkdir(parents=True, exist_ok=True)
    try:
        if os.name == "posix":
            os.chmod(d, GLOBAL_DIR_MODE)
    except OSError:
        pass
    return d


def _global_memories_dir() -> Path:
    """Return the global memories subdirectory, creating if needed (0700)."""
    d = _global_base_dir() / "memories"
    d.mkdir(parents=True, exist_ok=True)
    try:
        if os.name == "posix":
            os.chmod(d, GLOBAL_DIR_MODE)
    except OSError:
        pass
    return d


def _global_memories_dir_readonly() -> Path:
    """Return the global memories subdirectory path without creating it."""
    return _memory_root_dir() / "global-memory" / "memories"


def _global_services_dir() -> Path:
    """Return the global services subdirectory, creating if needed (0700)."""
    d = _global_base_dir() / "services"
    d.mkdir(parents=True, exist_ok=True)
    try:
        if os.name == "posix":
            os.chmod(d, GLOBAL_DIR_MODE)
    except OSError:
        pass
    return d


def _ensure_service_registered() -> None:
    """Register or refresh the current service per Global Memory Standard §10.

    Writes a standard-schema service descriptor and bumps ``last_active`` on
    every call so that session-start freshness is visible to other services.
    """
    svc_dir = _global_services_dir()
    svc_file = svc_dir / f"{GLOBAL_SERVICE_NAME}.yaml"
    now = _now_iso()
    existing: dict[str, Any] = {}
    if svc_file.exists():
        try:
            parsed = yaml.safe_load(svc_file.read_text(encoding="utf-8")) or {}
            if isinstance(parsed, dict):
                existing = parsed
        except (yaml.YAMLError, OSError):
            existing = {}

    svc = existing.get("service") if isinstance(existing.get("service"), dict) else {}
    first_registered = svc.get("first_registered") or existing.get("registered") or now

    content = {
        "service": {
            "name": GLOBAL_SERVICE_NAME,
            "display_name": "GitHub Copilot CLI",
            "version": "1.0.0",
            "first_registered": first_registered,
            "last_active": now,
            "capabilities": {
                "read": True,
                "write": True,
                "semantic_dedup": False,
                "promotion": True,
                "auto_index": True,
            },
            "settings": {
                "max_context_tokens": 2000,
                "preferred_types": list(GLOBAL_MEMORY_TYPES),
                "disabled_types": [],
            },
        }
    }
    _atomic_write(
        svc_file,
        yaml.dump(content, default_flow_style=False, allow_unicode=True, sort_keys=False),
        perms=GLOBAL_FILE_MODE,
    )


# ---------------------------------------------------------------------------
# Helpers — file naming
# ---------------------------------------------------------------------------

_KEBAB_STRIP = re.compile(r"[^a-z0-9]+")
_KEBAB_COLLAPSE = re.compile(r"-{2,}")


def _to_kebab(name: str) -> str:
    """Convert a human-readable name to a kebab-case slug."""
    slug = _KEBAB_STRIP.sub("-", name.lower()).strip("-")
    slug = _KEBAB_COLLAPSE.sub("-", slug)
    return slug or "memory"


def _random_suffix(length: int = 5) -> str:
    """Generate a short random alphanumeric suffix (no external deps)."""
    import secrets

    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _generate_filename(name: str) -> str:
    """Generate a unique filename: kebab-name-<random>.md"""
    slug = _to_kebab(name)
    # Truncate slug so total filename stays reasonable
    slug = slug[:60]
    return f"{slug}-{_random_suffix()}.md"


# ---------------------------------------------------------------------------
# Helpers — atomic file I/O
# ---------------------------------------------------------------------------


def _atomic_write(
    path: Path,
    content: str,
    encoding: str = "utf-8",
    perms: int | None = None,
) -> None:
    """Write content atomically via temp file + rename.

    On POSIX systems, rename() is atomic within the same filesystem.
    The temp file is created in the same directory to guarantee same-fs.

    If *perms* is provided, chmod the final file to that mode (POSIX only).
    Non-POSIX platforms silently ignore the permission request.
    """
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    try:
        tmp_path.write_text(content, encoding=encoding)
        if perms is not None and os.name == "posix":
            try:
                os.chmod(tmp_path, perms)
            except OSError:
                pass
        tmp_path.replace(path)  # atomic on POSIX
        if perms is not None and os.name == "posix":
            try:
                os.chmod(path, perms)
            except OSError:
                pass
    except BaseException:
        # Clean up temp file on any failure
        tmp_path.unlink(missing_ok=True)
        raise


# ---------------------------------------------------------------------------
# Helpers — frontmatter & staleness
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    """One-line description for _now_iso."""
    return datetime.now(timezone.utc).isoformat()


class _FlowList(list):
    """A list subclass that YAML serializes with flow style: [a, b, c]."""
    pass


def _flow_list_representer(dumper: yaml.Dumper, data: _FlowList) -> yaml.Node:
    """One-line description for _flow_list_representer."""
    return dumper.represent_sequence("tag:yaml.org,2002:seq", data, flow_style=True)


yaml.add_representer(_FlowList, _flow_list_representer)


def _parse_tags(tags_str: str) -> list[str]:
    """Parse a comma-separated tags string into a deduplicated, lowercased list."""
    if not tags_str or not tags_str.strip():
        return []
    return list(dict.fromkeys(t.strip().lower() for t in tags_str.split(",") if t.strip()))


def _normalize_tags(tags: Any) -> list[str]:
    """Normalize tags to a list of strings. Handles None, str, and list inputs."""
    if tags is None:
        return []
    if isinstance(tags, str):
        return [t.strip() for t in tags.split(",") if t.strip()]
    if isinstance(tags, list):
        return [str(t).strip() for t in tags if str(t).strip()]
    return []


def _detect_service_name() -> str:
    """Return the templestay service label from environment.

    Reads from ``MEMORY_V2_SERVICE_NAME`` (preferred) or
    ``TEMPLATESTAY_MEMORY_SERVICE`` (legacy) at *call time* so capsules
    written after the env was repaired pick up the new value without
    requiring a module reload. Falls back to ``GLOBAL_SERVICE_NAME``
    captured at import time, then to ``copilot-cli`` for backwards-compat.
    """
    raw = (
        os.environ.get("MEMORY_V2_SERVICE_NAME")
        or os.environ.get("TEMPLATESTAY_MEMORY_SERVICE")
        or GLOBAL_SERVICE_NAME
        or "copilot-cli"
    )
    return raw.strip() or "copilot-cli"


def _build_frontmatter(
    name: str,
    description: str,
    mem_type: str,
    created: str | None = None,
    updated: str | None = None,
    tags: list[str] | None = None,
) -> dict[str, Any]:
    """One-line description for _build_frontmatter."""
    now = _now_iso()
    fm: dict[str, Any] = {
        "name": name,
        "description": description,
        "type": mem_type,
        "memory_schema_version": MEMORY_SCHEMA_VERSION,
        "service_name": _detect_service_name(),
        "platform": _detect_platform(),
        "created": created or now,
        "updated": updated or now,
    }
    if tags:
        fm["tags"] = _FlowList(_normalize_tags(tags))
    return fm


def _serialize_memory(frontmatter: dict[str, Any], body: str) -> str:
    """Serialize frontmatter + body into a .md file with YAML header."""
    # Ensure tags use flow-style list formatting: tags: [a, b, c]
    fm = dict(frontmatter)
    if "tags" in fm and isinstance(fm["tags"], list) and not isinstance(fm["tags"], _FlowList):
        fm["tags"] = _FlowList(fm["tags"])
    fm_str = yaml.dump(fm, default_flow_style=False, allow_unicode=True, sort_keys=False).rstrip("\n")
    return f"---\n{fm_str}\n---\n{body}\n"


def _parse_memory_file(text: str) -> tuple[dict[str, Any], str]:
    """Parse a memory file into (frontmatter_dict, body_str).

    Handles the --- delimited YAML frontmatter block.
    Returns ({}, text) if no valid frontmatter is found.
    """
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return {}, text
    # Find the closing --- (must be an exact standalone delimiter)
    end_line = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_line = i
            break
    if end_line is None:
        return {}, text
    fm_raw = "\n".join(lines[1:end_line]).strip()
    body = "\n".join(lines[end_line + 1:]).lstrip("\n")
    try:
        fm = yaml.safe_load(fm_raw)
        if not isinstance(fm, dict):
            fm = {}
    except yaml.YAMLError:
        fm = {}
    return fm, body


# ---------------------------------------------------------------------------
# Parsed-frontmatter LRU cache (WU-5 / P0 item C4)
#
# Hot paths (_rebuild_index_for_dir, _unified_search, _unified_list) re-read
# every .md file in a tier on every invocation. At 240+ memories, this is an
# O(N_files) fan-out amplification for operations that touch unchanged files.
#
# This module-level LRU caches the (frontmatter, body) parse result keyed on
# (resolved_path, st_mtime_ns, st_size). Because writes in this module go
# through _atomic_write (which rename()s into place), mtime/size change on
# any mutation and the stale key naturally misses — no explicit invalidation
# hook is needed (Option 1 from the design).
#
# Rollback: set env MEMORY_V2_DISABLE_PARSE_CACHE=1 to both bypass the cache
# and purge any accumulated entries on the first bypassed call.
# ---------------------------------------------------------------------------

_PARSE_CACHE_MAX = 512
_parse_cache: "OrderedDict[tuple[str, int, int], tuple[dict[str, Any], str]]" = OrderedDict()
_parse_cache_lock = threading.Lock()


def _parse_cache_disabled() -> bool:
    return os.environ.get("MEMORY_V2_DISABLE_PARSE_CACHE", "") == "1"


def _parse_cache_clear() -> None:
    with _parse_cache_lock:
        _parse_cache.clear()


def _parse_one_file_uncached(path: Path) -> tuple[dict[str, Any], str]:
    """Read and parse a memory .md file without consulting the cache.

    Returns ({}, "") on read error (matching the existing error semantics in
    the hot paths, which skip files where frontmatter is empty).
    """
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return {}, ""
    return _parse_memory_file(text)


def _parse_frontmatter_cached(path: Path) -> tuple[dict[str, Any], str]:
    """LRU-cached parse of a memory .md file's frontmatter + body.

    Key: (str(path), st_mtime_ns, st_size). Invalidates automatically when the
    file's mtime_ns or size changes. Bypasses cache entirely (and purges
    accumulated state) when MEMORY_V2_DISABLE_PARSE_CACHE=1.
    """
    if _parse_cache_disabled():
        if _parse_cache:
            _parse_cache_clear()
        return _parse_one_file_uncached(path)

    try:
        st = path.stat()
    except OSError:
        return _parse_one_file_uncached(path)

    key = (str(path), st.st_mtime_ns, st.st_size)
    with _parse_cache_lock:
        hit = _parse_cache.get(key)
        if hit is not None:
            _parse_cache.move_to_end(key)
            return hit

    # Parse outside the lock so concurrent readers don't serialize on I/O.
    parsed = _parse_one_file_uncached(path)

    with _parse_cache_lock:
        _parse_cache[key] = parsed
        _parse_cache.move_to_end(key)
        while len(_parse_cache) > _PARSE_CACHE_MAX:
            _parse_cache.popitem(last=False)
    return parsed


# ---------------------------------------------------------------------------
# Access log — sidecar append-only JSONL (WU-P1-1 / WU-P1-2 / WU-P1-3)
#
# Prior design: _update_access_metadata did an atomic temp+rename of each .md
# file per search hit, producing O(N_hits) rename fan-out on every tracked
# read. This module replaces that with a sidecar append-only JSONL log per
# tier directory (<memory_dir>/.access.jsonl).
#
# Schema (one JSON object per line):
#   {"ts": "<ISO8601 UTC>", "filename": "<stem.md>", "op": "read"}
#
# Concurrency: POSIX O_APPEND guarantees atomicity for writes smaller than
# PIPE_BUF (4096 bytes on Linux). Each record is comfortably under that
# bound (ISO ts ~28 chars + filename ≤ ~200 chars + JSON overhead).
#
# Read path: _load_access_log_aggregates merges log deltas with frontmatter
# base at query time (LRU-cached, keyed on log (path, mtime_ns, size) so any
# append invalidates automatically).
#
# Compaction: _compact_access_log rolls aggregates into each .md frontmatter
# via the existing atomic temp+rename helper and truncates the log. Triggered
# either explicitly (memory_compact_access_log admin tool) or automatically
# when the log crosses ACCESS_LOG_COMPACT_SIZE_BYTES.
#
# Rollback: MEMORY_V2_DISABLE_ACCESS_LOG=1 bypasses appends AND purges any
# residual aggregate cache on the first bypassed call (mirrors the P0
# MEMORY_V2_DISABLE_PARSE_CACHE rollback invariant).
# ---------------------------------------------------------------------------

ACCESS_LOG_FILENAME = ".access.jsonl"
ACCESS_LOG_COMPACT_SIZE_BYTES = 1_048_576  # 1 MB
ACCESS_LOG_COMPACT_LINE_COUNT = 10_000  # advisory — size is the auto trigger

_ACCESS_AGG_CACHE_MAX = 32  # one log per tier, bounded across a few servers
_access_aggregate_cache: "OrderedDict[tuple[str, int, int], dict[str, tuple[int, str]]]" = OrderedDict()
_access_aggregate_cache_lock = threading.Lock()

# Module-level marker set so auto-compaction does not re-fire on every append
# once the size threshold has been crossed. The rename performed inside
# _compact_access_log drops size back to zero, naturally re-arming the check.
_compact_fired_for: set[str] = set()
_compact_fired_for_lock = threading.Lock()


def _access_log_disabled() -> bool:
    return os.environ.get("MEMORY_V2_DISABLE_ACCESS_LOG", "") == "1"


def _access_log_path(memory_dir: Path) -> Path:
    return memory_dir / ACCESS_LOG_FILENAME


def _access_aggregate_cache_clear() -> None:
    with _access_aggregate_cache_lock:
        _access_aggregate_cache.clear()


def _access_log_ts() -> str:
    """High-resolution ISO8601 UTC timestamp with microseconds + trailing Z."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _access_log_append(memory_dir: Path, filename: str, op: str = "read") -> None:
    """Atomically append one JSON record to the tier's sidecar access log.

    POSIX O_APPEND guarantees that writes under PIPE_BUF are atomic across
    concurrent writers. Errors are swallowed — access tracking must never
    disrupt user-facing memory operations.
    """
    if _access_log_disabled():
        # Rollback invariant: purge any residual aggregate cache on the first
        # bypassed call (matches MEMORY_V2_DISABLE_PARSE_CACHE semantics).
        if _access_aggregate_cache:
            _access_aggregate_cache_clear()
        return
    if not filename:
        return
    try:
        # Do NOT create the tier directory itself — if it's missing, the tier
        # is not initialised and we silently skip.
        if not memory_dir.is_dir():
            return
        log_path = _access_log_path(memory_dir)
        record = json.dumps(
            {"ts": _access_log_ts(), "filename": filename, "op": op},
            ensure_ascii=False,
        ) + "\n"
        fd = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        try:
            os.write(fd, record.encode("utf-8"))
        finally:
            os.close(fd)
    except (OSError, ValueError):
        return

    # Auto-compaction probe — runs only when size threshold tripped. Guarded
    # by _compact_fired_for so it does not re-fire for every subsequent append
    # after threshold. Never raises.
    try:
        _maybe_auto_compact(memory_dir)
    except Exception:  # noqa: BLE001 — best effort; never disrupt the append
        pass


def _load_access_log_aggregates(memory_dir: Path) -> dict[str, tuple[int, str]]:
    """Return {filename -> (count_delta, latest_ts)} from the sidecar log.

    Cache key is (log_path, mtime_ns, size); any append invalidates the entry.
    Returns {} if the log is absent, unreadable, or disabled via the rollback
    flag.
    """
    if _access_log_disabled():
        if _access_aggregate_cache:
            _access_aggregate_cache_clear()
        return {}
    log_path = _access_log_path(memory_dir)
    try:
        st = log_path.stat()
    except OSError:
        return {}

    key = (str(log_path), st.st_mtime_ns, st.st_size)
    with _access_aggregate_cache_lock:
        hit = _access_aggregate_cache.get(key)
        if hit is not None:
            _access_aggregate_cache.move_to_end(key)
            return hit

    agg: dict[str, tuple[int, str]] = {}
    try:
        with open(log_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                fn = rec.get("filename")
                ts = rec.get("ts", "") or ""
                if not fn:
                    continue
                cnt, latest = agg.get(fn, (0, ""))
                agg[fn] = (cnt + 1, ts if ts > latest else latest)
    except OSError:
        return {}

    with _access_aggregate_cache_lock:
        _access_aggregate_cache[key] = agg
        _access_aggregate_cache.move_to_end(key)
        while len(_access_aggregate_cache) > _ACCESS_AGG_CACHE_MAX:
            _access_aggregate_cache.popitem(last=False)
    return agg


def _compact_access_log(memory_dir: Path) -> dict:
    """Roll up sidecar .access.jsonl into frontmatter and truncate the log.

    Protocol (atomic, concurrent-safe):
      1. Rename .access.jsonl -> .access.jsonl.compacting-<ts> (POSIX-atomic).
         Concurrent appenders opening .access.jsonl after step 1 create a
         fresh empty file via O_CREAT|O_APPEND — no events lost.
      2. Read the snapshot file and aggregate per-filename counts + max ts.
      3. Merge each aggregate into the corresponding .md frontmatter using
         the existing _atomic_write temp+rename helper.
      4. On zero errors, unlink the snapshot; otherwise leave it for recovery.

    Returns: {"records", "files_updated", "errors", "disabled"}.
    """
    if _access_log_disabled():
        return {"records": 0, "files_updated": 0, "errors": 0, "disabled": True}

    log_path = _access_log_path(memory_dir)
    if not log_path.exists():
        return {"records": 0, "files_updated": 0, "errors": 0, "disabled": False}

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    compacting_path = memory_dir / f"{ACCESS_LOG_FILENAME}.compacting-{ts}"
    try:
        os.rename(str(log_path), str(compacting_path))
    except OSError:
        return {"records": 0, "files_updated": 0, "errors": 1, "disabled": False}

    # Both the active-log key and parsed frontmatter for affected files are
    # now stale — clear both caches.
    _access_aggregate_cache_clear()
    _parse_cache_clear()

    agg: dict[str, tuple[int, str]] = {}
    records = 0
    try:
        with open(compacting_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                fn = rec.get("filename")
                if not fn:
                    continue
                ts_rec = rec.get("ts", "") or ""
                cnt, latest = agg.get(fn, (0, ""))
                agg[fn] = (cnt + 1, ts_rec if ts_rec > latest else latest)
                records += 1
    except OSError:
        return {"records": 0, "files_updated": 0, "errors": 1, "disabled": False}

    files_updated = 0
    errors = 0
    for fn, (delta, latest_ts) in agg.items():
        md_path = memory_dir / fn
        if not md_path.is_file():
            # File deleted between append and compaction — not an error.
            continue
        try:
            text = md_path.read_text(encoding="utf-8")
            fm, body = _parse_memory_file(text)
            if not fm:
                # No frontmatter to merge into — skip without error.
                continue
            try:
                base_count = int(fm.get("access_count", 0) or 0)
            except (TypeError, ValueError):
                base_count = 0
            fm["access_count"] = base_count + delta
            base_ts = fm.get("last_accessed", "") or ""
            if latest_ts and latest_ts > base_ts:
                fm["last_accessed"] = latest_ts
            _atomic_write(md_path, _serialize_memory(fm, body))
            files_updated += 1
        except Exception:  # noqa: BLE001 — isolate per-file errors
            errors += 1

    if errors == 0:
        try:
            compacting_path.unlink()
        except OSError:
            pass

    # Cache now represents pre-compaction state; drop it so subsequent reads
    # reparse the newly-written frontmatter.
    _access_aggregate_cache_clear()
    _parse_cache_clear()

    return {
        "records": records,
        "files_updated": files_updated,
        "errors": errors,
        "disabled": False,
    }


def _maybe_auto_compact(memory_dir: Path) -> None:
    """Auto-compact when the sidecar log exceeds the size threshold.

    Guarded by _compact_fired_for so the same tier does not re-fire the check
    repeatedly once the threshold has been crossed; the rename inside
    _compact_access_log drops size to zero and naturally re-arms.
    """
    if _access_log_disabled():
        return
    key = str(memory_dir)
    with _compact_fired_for_lock:
        if key in _compact_fired_for:
            return
    try:
        st = _access_log_path(memory_dir).stat()
    except OSError:
        return
    if st.st_size < ACCESS_LOG_COMPACT_SIZE_BYTES:
        return
    with _compact_fired_for_lock:
        if key in _compact_fired_for:
            return
        _compact_fired_for.add(key)
    try:
        _compact_access_log(memory_dir)
    finally:
        with _compact_fired_for_lock:
            _compact_fired_for.discard(key)


def _age_days(iso_timestamp: str) -> int:
    """Return age in days from an ISO timestamp string. Clamps to 0."""
    try:
        dt = datetime.fromisoformat(iso_timestamp)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        delta = datetime.now(timezone.utc) - dt
        return max(0, delta.days)
    except (ValueError, TypeError):
        return 0


def _human_age(days: int) -> str:
    """One-line description for _human_age."""
    if days == 0:
        return "today"
    if days == 1:
        return "yesterday"
    return f"{days} days ago"


def _staleness_warning(days: int) -> str:
    """Return a staleness warning string, or '' for fresh memories."""
    for threshold, message in STALENESS_THRESHOLDS:
        if days >= threshold:
            return message
    return ""


def _truncate_output(text: str) -> str:
    """Self-limiting: truncate tool output to MAX_OUTPUT_CHARS with notice."""
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    truncated = text[:MAX_OUTPUT_CHARS]
    # Try to break at a newline boundary
    last_nl = truncated.rfind("\n")
    if last_nl > MAX_OUTPUT_CHARS * 0.8:
        truncated = truncated[:last_nl]
    return truncated + f"\n\n[Output truncated at {MAX_OUTPUT_CHARS:,} chars. Use memory_read for individual files.]"


# ---------------------------------------------------------------------------
# Helpers — MEMORY.md index
# ---------------------------------------------------------------------------


def _rebuild_index_for_dir(
    directory: Path,
    type_ordering: tuple[str, ...] = MEMORY_TYPES,
    title: str = "Project Memory Index",
) -> str:
    """Rebuild the MEMORY.md index from all .md files in the given directory.

    Args:
        directory: Directory containing memory .md files.
        type_ordering: Tuple of type names used for section ordering.
        title: Title string for the index header.

    Returns the index content as a string.
    """
    entries: list[dict[str, Any]] = []

    for md_file in sorted(directory.glob("*.md")):
        if md_file.name == INDEX_FILENAME:
            continue
        fm, _ = _parse_frontmatter_cached(md_file)
        if not fm:
            continue

        name = fm.get("name", md_file.stem)
        description = fm.get("description", "")
        mem_type = fm.get("type", "unknown")
        updated = fm.get("updated") or fm.get("created", "")
        tags = _normalize_tags(fm.get("tags"))
        days = _age_days(updated)

        entries.append(
            {
                "name": name,
                "filename": md_file.name,
                "description": description,
                "type": mem_type,
                "updated": updated,
                "days": days,
                "tags": tags,
            }
        )

    # Sort by type (alphabetical), then recency (newest first)
    type_order = {t: i for i, t in enumerate(type_ordering)}
    entries.sort(key=lambda e: (type_order.get(e["type"], 99), -_timestamp_sort_key(e["updated"])))

    # Build index lines
    lines: list[str] = [f"# MEMORY.md — {title}", ""]
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines.append(f"_Auto-generated on {now_str}. Do not edit manually._")
    lines.append("")

    # Counts per type
    type_counts: dict[str, int] = {}
    for e in entries:
        type_counts[e["type"]] = type_counts.get(e["type"], 0) + 1
    if type_counts:
        counts_str = ", ".join(f"{t}: {c}" for t, c in sorted(type_counts.items()))
        lines.append(f"**Totals:** {len(entries)} memories ({counts_str})")
        lines.append("")

    current_type = None
    for e in entries:
        if e["type"] != current_type:
            current_type = e["type"]
            lines.append(f"## {current_type}")
            lines.append("")

        age_str = _human_age(e["days"])
        line = f"- [{e['name']}]({e['filename']}) — {e['description']} ({e['type']}, {age_str})"
        if e.get("tags"):
            line += f" [tags: {', '.join(str(t) for t in e['tags'])}]"
        lines.append(line)

        # Enforce limits
        if len(lines) >= INDEX_MAX_LINES:
            lines.append("")
            lines.append(f"_Index truncated at {INDEX_MAX_LINES} lines._")
            break

    content = "\n".join(lines) + "\n"

    # Enforce size limit (W-22: safe UTF-8 boundary truncation)
    encoded = content.encode("utf-8")
    if len(encoded) > INDEX_MAX_BYTES:
        cut = INDEX_MAX_BYTES
        # Walk back to a valid UTF-8 character boundary
        while cut > 0 and (encoded[cut] & 0xC0) == 0x80:
            cut -= 1
        content = encoded[:cut].decode("utf-8")
        # Truncate at last complete line to avoid splitting entries
        content = content.rsplit("\n", 1)[0] + "\n\n_Index truncated at 25KB._\n"

    return content


def _rebuild_index(project_path: Path) -> str:
    """Rebuild the MEMORY.md index for a local project directory."""
    return _rebuild_index_for_dir(project_path, MEMORY_TYPES, "Project Memory Index")


def _rebuild_global_index() -> str:
    """Rebuild the MEMORY.md index for the global memory per Standard §4.

    Always emits the 10 fixed sections in priority order (with ``(none)`` for
    empty sections) and a single-line stats footer.
    """
    return _rebuild_global_standard_index()


def _write_global_index() -> str:
    """Rebuild and write the global MEMORY.md index. Returns the index content."""
    gdir = _global_memories_dir()
    content = _rebuild_global_index()
    index_path = gdir / GLOBAL_INDEX_FILENAME
    _atomic_write(index_path, content, perms=GLOBAL_FILE_MODE)
    return content


def _timestamp_sort_key(iso_str: str) -> float:
    """Convert ISO timestamp to a float for sorting. Returns 0.0 on failure."""
    try:
        dt = datetime.fromisoformat(iso_str)
        return dt.timestamp()
    except (ValueError, TypeError):
        return 0.0


def _write_index(project_path: Path) -> str:
    """Rebuild and write the MEMORY.md index. Returns the index content."""
    content = _rebuild_index(project_path)
    index_path = project_path / INDEX_FILENAME
    _atomic_write(index_path, content)
    return content


# ---------------------------------------------------------------------------
# Helpers — Global Memory Standard v1.0 compliance
# ---------------------------------------------------------------------------

# Secret detection heuristics (§11). These are intentionally conservative —
# a few false positives are preferable to leaking credentials into memory.
_SECRET_REGEXES: tuple[re.Pattern[str], ...] = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),           # OpenAI-style
    re.compile(r"\bpk-[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bghp_[A-Za-z0-9]{20,}\b"),          # GitHub classic PAT
    re.compile(r"\bghs_[A-Za-z0-9]{20,}\b"),          # GitHub server token
    re.compile(r"\bgho_[A-Za-z0-9]{20,}\b"),          # GitHub OAuth token
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),              # AWS access key ID
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),  # Slack tokens
    re.compile(
        r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"
    ),                                                 # JWT
)


def _shannon_entropy(value: str) -> float:
    """Compute Shannon entropy (bits/char) of *value*. Empty → 0.0."""
    if not value:
        return 0.0
    freq: dict[str, int] = {}
    for ch in value:
        freq[ch] = freq.get(ch, 0) + 1
    total = len(value)
    entropy = 0.0
    for count in freq.values():
        p = count / total
        entropy -= p * math.log2(p)
    return entropy


def _contains_potential_secret(body: str) -> tuple[bool, str]:
    """Return (True, reason) if *body* contains content that looks like a secret.

    Uses regex signatures for known key formats plus an entropy heuristic for
    long opaque blobs. Kept conservative; callers may override with explicit
    user consent.
    """
    for rx in _SECRET_REGEXES:
        if rx.search(body):
            return True, f"matches secret pattern: {rx.pattern[:40]}"
    # High-entropy opaque token heuristic: any whitespace-delimited token
    # longer than 32 chars whose entropy exceeds 4.5 bits/char and is made
    # solely of base64/hex characters.
    for token in re.findall(r"[A-Za-z0-9+/=_\-]{32,}", body):
        ent = _shannon_entropy(token)
        if ent >= 4.5:
            return True, f"high-entropy opaque token (len={len(token)}, entropy={ent:.2f})"
    return False, ""


def _compute_content_hash(body: str) -> str:
    """Compute ``sha256:<hex>`` of stripped *body* per Standard §3."""
    digest = hashlib.sha256(body.strip().encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def _parse_ttl_duration(ttl: Any) -> timedelta | None:
    """Parse a subset of ISO-8601 duration strings used by the Standard.

    Supports ``P<n>D`` / ``P<n>Y`` / ``PT<n>M`` / ``PT<n>H`` and combinations
    that cover the realistic TTL space (days/hours/minutes/years). Returns
    None for ``None`` / ``""`` / ``"null"`` or unparseable values.
    """
    if ttl is None:
        return None
    if not isinstance(ttl, str):
        return None
    s = ttl.strip()
    if not s or s.lower() == "null":
        return None
    m = re.fullmatch(
        r"P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?",
        s,
    )
    if not m or s == "P":
        return None
    years, months, weeks, days, hours, minutes, seconds = (int(g) if g else 0 for g in m.groups())
    return timedelta(
        days=years * 365 + months * 30 + weeks * 7 + days,
        hours=hours,
        minutes=minutes,
        seconds=seconds,
    )


def _is_ttl_expired(fm: dict[str, Any]) -> bool:
    """Return True if *fm* has a TTL and ``created + ttl < now``."""
    ttl = fm.get("ttl")
    delta = _parse_ttl_duration(ttl)
    if delta is None:
        return False
    created = fm.get("created")
    if not isinstance(created, str):
        return False
    try:
        created_dt = datetime.fromisoformat(created)
    except (ValueError, TypeError):
        return False
    if created_dt.tzinfo is None:
        created_dt = created_dt.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) > (created_dt + delta)


def _ensure_standard_global_fm(
    fm: dict[str, Any],
    body: str,
    *,
    service: str = GLOBAL_SERVICE_NAME,
    project: str | None = None,
    session: str | None = None,
    default_confidence: float = GLOBAL_DEFAULT_CONFIDENCE,
) -> tuple[dict[str, Any], bool]:
    """Return a copy of *fm* with all Standard §3 REQUIRED fields populated.

    Second tuple element is ``True`` when any field was added/normalised,
    signalling the caller that the file should be rewritten. Existing values
    are preserved; missing ones are filled with sensible defaults.
    """
    out = dict(fm)
    changed = False

    def _set_default(key: str, value: Any) -> None:
        nonlocal changed
        if key not in out or out[key] in (None, ""):
            out[key] = value
            changed = True

    if not out.get("id") or not isinstance(out.get("id"), str):
        out["id"] = str(uuid.uuid4())
        changed = True
    # Validate id is uuid-like; if not, regenerate.
    else:
        try:
            uuid.UUID(str(out["id"]))
        except (ValueError, AttributeError):
            out["id"] = str(uuid.uuid4())
            changed = True

    if out.get("scope") != "global":
        out["scope"] = "global"
        changed = True

    now = _now_iso()
    _set_default("created", now)
    _set_default("updated", out.get("created", now))

    source = out.get("source")
    if not isinstance(source, dict):
        source = {}
        changed = True
    if source.get("service") != service:
        source["service"] = service
        changed = True
    if project is not None and source.get("project") != project:
        source["project"] = project
        changed = True
    if session is not None and source.get("session") != session:
        source["session"] = session
        changed = True
    out["source"] = source

    if "tags" not in out or out["tags"] is None:
        out["tags"] = []
        changed = True

    if "confidence" not in out or out["confidence"] is None:
        out["confidence"] = default_confidence
        changed = True

    if "ttl" not in out:
        out["ttl"] = None
        changed = True

    if "access_count" not in out or not isinstance(out.get("access_count"), int):
        out["access_count"] = 0
        changed = True

    if "last_accessed" not in out or not out.get("last_accessed"):
        out["last_accessed"] = out.get("created", now)
        changed = True

    expected_hash = _compute_content_hash(body)
    if out.get("content_hash") != expected_hash:
        out["content_hash"] = expected_hash
        changed = True

    return out, changed


# Module-level guard so migration runs at most once per process.
_global_migration_done = False
_global_migration_lock = threading.Lock()


def _migrate_global_memories_once() -> None:
    """Scan the global memories dir and upgrade any files missing §3 fields.

    Idempotent: running multiple times is a no-op after the first completion.
    Also re-applies ``0600`` permissions to every .md file.
    """
    global _global_migration_done
    if _global_migration_done:
        return
    with _global_migration_lock:
        if _global_migration_done:
            return
        try:
            gdir = _global_memories_dir()
        except OSError:
            _global_migration_done = True
            return
        migrated_any = False
        for md_file in gdir.glob("*.md"):
            if md_file.name == GLOBAL_INDEX_FILENAME:
                continue
            try:
                text = md_file.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            try:
                fm, body = _parse_memory_file(text)
            except Exception:  # noqa: BLE001 — tolerate malformed files
                continue
            new_fm, changed = _ensure_standard_global_fm(fm, body)
            if changed:
                try:
                    _atomic_write(
                        md_file,
                        _serialize_memory(new_fm, body),
                        perms=GLOBAL_FILE_MODE,
                    )
                    migrated_any = True
                except OSError:
                    continue
            else:
                try:
                    if os.name == "posix":
                        os.chmod(md_file, GLOBAL_FILE_MODE)
                except OSError:
                    pass
        if migrated_any:
            try:
                _write_global_index()
            except Exception:  # noqa: BLE001 — index regen is best-effort
                pass
        _global_migration_done = True


def _find_duplicate_by_hash(content_hash: str) -> Path | None:
    """Return the first global memory file whose frontmatter matches *content_hash*."""
    gdir = _global_memories_dir()
    for md_file in gdir.glob("*.md"):
        if md_file.name == GLOBAL_INDEX_FILENAME:
            continue
        try:
            text = md_file.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        try:
            fm, _ = _parse_memory_file(text)
        except Exception:  # noqa: BLE001
            continue
        if fm.get("content_hash") == content_hash:
            return md_file
    return None


def _update_access_metadata(path: Path) -> None:
    """Record an access event via the sidecar append-only log (WU-P1-1).

    Previously this function performed an atomic temp+rename per call, which
    caused O(N_hits) rename fan-out on every tracked search/list/read. It
    now appends a single JSON record (POSIX O_APPEND, atomic for writes
    under PIPE_BUF). Frontmatter `access_count` / `last_accessed` remain the
    source of truth and are periodically reconciled via _compact_access_log
    (either auto-triggered on size threshold, or explicitly via the
    memory_compact_access_log MCP admin tool). Read-time consumers that
    need up-to-the-moment counts can call _load_access_log_aggregates.

    The call-site signature is preserved: callers pass the full .md path.
    Best-effort: any failure in the log path is silently swallowed —
    access tracking must never break a read.
    """
    try:
        _access_log_append(path.parent, path.name, op="read")
    except Exception:  # noqa: BLE001 — never disrupt user-facing reads
        return


class _GlobalLockError(RuntimeError):
    """Raised when the global advisory lock cannot be acquired."""


class _global_lock:
    """Context manager for the global-memory advisory ``.lock`` file (§6.1).

    Uses ``O_CREAT | O_EXCL`` for atomic creation. Stale lock detection
    (>30s) and PID-alive check are best-effort — if acquisition times out,
    callers receive a warning and may proceed; the standard designates the
    lock as advisory, not mandatory.
    """

    def __init__(self, timeout: float = GLOBAL_LOCK_TIMEOUT_SEC) -> None:
        self.timeout = timeout
        self.lock_path = _global_base_dir() / ".lock"
        self.acquired = False

    def __enter__(self) -> "_global_lock":
        start = time.monotonic()
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        while True:
            try:
                fd = os.open(self.lock_path, flags, GLOBAL_FILE_MODE)
            except FileExistsError:
                self._maybe_clear_stale()
                if time.monotonic() - start > self.timeout:
                    # Advisory lock: proceed without it.
                    return self
                time.sleep(0.1)
                continue
            try:
                payload = json.dumps(
                    {
                        "pid": os.getpid(),
                        "service": GLOBAL_SERVICE_NAME,
                        "acquired": _now_iso(),
                    }
                )
                os.write(fd, payload.encode("utf-8"))
            finally:
                os.close(fd)
            self.acquired = True
            return self

    def _maybe_clear_stale(self) -> None:
        try:
            st = self.lock_path.stat()
        except OSError:
            return
        age = time.time() - st.st_mtime
        if age <= GLOBAL_LOCK_STALE_SEC:
            return
        # Best-effort stale cleanup.
        try:
            self.lock_path.unlink()
        except OSError:
            pass

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        if not self.acquired:
            return
        try:
            self.lock_path.unlink()
        except OSError:
            pass


def _append_merge_log(event: dict[str, Any]) -> None:
    """Append *event* to ``.merge-log.jsonl`` and rotate when oversized.

    Silently tolerates filesystem errors — audit logging is best-effort.
    """
    try:
        base = _global_base_dir()
        log_path = base / ".merge-log.jsonl"
        # Rotate before appending so the new event always lands in a fresh file
        # when the current one has grown past the size cap.
        try:
            if log_path.exists() and log_path.stat().st_size >= GLOBAL_MERGE_LOG_MAX_BYTES:
                for n in range(GLOBAL_MERGE_LOG_MAX_ROTATIONS, 0, -1):
                    src = base / (
                        ".merge-log.jsonl" if n == 1 else f".merge-log.jsonl.{n - 1}"
                    )
                    dst = base / f".merge-log.jsonl.{n}"
                    if src.exists():
                        try:
                            src.replace(dst)
                        except OSError:
                            pass
                # Drop any rotation beyond the cap.
                overflow = base / f".merge-log.jsonl.{GLOBAL_MERGE_LOG_MAX_ROTATIONS + 1}"
                if overflow.exists():
                    try:
                        overflow.unlink()
                    except OSError:
                        pass
        except OSError:
            pass
        payload = dict(event)
        payload.setdefault("timestamp", _now_iso())
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        with log_path.open("a", encoding="utf-8") as f:
            f.write(line)
        try:
            if os.name == "posix":
                os.chmod(log_path, GLOBAL_FILE_MODE)
        except OSError:
            pass
    except OSError:
        return


def _rebuild_global_standard_index() -> str:
    """Render MEMORY.md per Standard §4 (10 fixed sections + stats footer)."""
    gdir = _global_memories_dir()
    buckets: dict[str, list[dict[str, Any]]] = {t: [] for t in GLOBAL_MEMORY_TYPES}

    for md_file in sorted(gdir.glob("*.md")):
        if md_file.name == GLOBAL_INDEX_FILENAME:
            continue
        try:
            text = md_file.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        try:
            fm, body = _parse_memory_file(text)
        except Exception:  # noqa: BLE001
            continue
        if _is_ttl_expired(fm):
            continue
        mem_type = fm.get("type")
        if mem_type not in buckets:
            # Unknown/legacy types go to "pattern" as a safe default bucket so
            # they are still discoverable; migration is expected to re-type
            # them eventually.
            mem_type = "pattern"
        name = fm.get("name") or fm.get("description") or md_file.stem
        tags = fm.get("tags") or []
        updated = fm.get("updated") or fm.get("created") or ""
        try:
            confidence = float(fm.get("confidence", GLOBAL_DEFAULT_CONFIDENCE))
        except (TypeError, ValueError):
            confidence = GLOBAL_DEFAULT_CONFIDENCE
        buckets[mem_type].append(
            {
                "name": str(name)[:80],
                "filename": md_file.name,
                "tags": [str(t) for t in tags] if isinstance(tags, list) else [],
                "updated": updated,
                "confidence": confidence,
            }
        )

    now_str = _now_iso()
    lines: list[str] = [
        "# Global Memory Index",
        "",
        "> Auto-generated by the Global Memory Standard. Do not edit manually.",
        f"> Last regenerated: {now_str}",
        "",
    ]

    for mem_type in GLOBAL_MEMORY_TYPES:
        title = GLOBAL_INDEX_SECTION_TITLES[mem_type]
        lines.append(f"## {title}")
        lines.append("")
        entries = sorted(
            buckets[mem_type],
            key=lambda e: (-_timestamp_sort_key(e["updated"]), e["name"].lower()),
        )
        if not entries:
            lines.append("(none)")
        else:
            for e in entries:
                # Truncate updated to YYYY-MM-DD for readability.
                updated_date = e["updated"][:10] if e["updated"] else ""
                tag_str = ", ".join(f"`{t}`" for t in e["tags"])
                summary_parts = [
                    f"- [{e['name']}](memories/{e['filename']})",
                    f"— confidence: {e['confidence']:.2f}",
                ]
                if tag_str:
                    summary_parts.append(f", tags: {tag_str}")
                if updated_date:
                    summary_parts.append(f"(updated: {updated_date})")
                lines.append(" ".join(summary_parts))
        lines.append("")

    total = sum(len(v) for v in buckets.values())
    type_counts = ", ".join(
        f"{t}: {len(buckets[t])}" for t in GLOBAL_MEMORY_TYPES
    )
    lines.append("---")
    lines.append("")
    lines.append(
        f"**Stats**: {total} memories | {type_counts} | Last updated: {now_str}"
    )
    return "\n".join(lines) + "\n"


GLOBAL_AUDIT_REQUIRED_FIELDS = (
    "id",
    "type",
    "scope",
    "created",
    "updated",
    "source",
    "tags",
    "confidence",
    "ttl",
    "access_count",
    "last_accessed",
    "content_hash",
)


def _parse_iso_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def _global_audit_add_issue(
    issues: list[dict[str, str]],
    severity: str,
    filename: str,
    code: str,
    message: str,
) -> None:
    issues.append(
        {
            "severity": severity,
            "filename": filename,
            "code": code,
            "message": message,
        }
    )


def _global_audit_query_hits(gdir: Path, query: str, *, limit: int = 5) -> list[str]:
    """Return filenames matched by the same lightweight TF-IDF search semantics.

    This helper is intentionally side-effect free: it does not update access
    metadata, rebuild indexes, migrate files, or register services. It exists
    so global memories can carry optional `retrieval_queries` fixtures that
    prove important memories remain discoverable.
    """
    keywords = [kw.lower() for kw in query.split() if kw]
    if not keywords:
        return []

    docs: list[tuple[Path, dict[str, Any], str, list[str], set[str]]] = []
    doc_freq: dict[str, int] = {}

    for md_file in sorted(gdir.glob("*.md")):
        if md_file.name == GLOBAL_INDEX_FILENAME:
            continue
        try:
            fm, body = _parse_memory_file(md_file.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, ValueError):
            continue
        if not fm or _is_ttl_expired(fm):
            continue
        searchable = f"{fm.get('name', md_file.stem)} {fm.get('description', '')} {body}"
        tokens = _tokenize(searchable)
        token_set = set(tokens)
        docs.append((md_file, fm, body, tokens, token_set))
        for kw in keywords:
            if kw in token_set:
                doc_freq[kw] = doc_freq.get(kw, 0) + 1

    total_docs = len(docs)
    scored: list[tuple[float, int, str]] = []
    for md_file, fm, _body, tokens, _token_set in docs:
        word_count = max(len(tokens), 1)
        score = 0.0
        for kw in keywords:
            tf = tokens.count(kw) / word_count
            df = doc_freq.get(kw, 0)
            idf = math.log(1 + total_docs / df) if df > 0 else 0.0
            score += tf * idf
        if score > 0:
            updated = fm.get("updated") or fm.get("created", "")
            scored.append((score, _age_days(updated), md_file.name))

    scored.sort(key=lambda item: (-item[0], item[1], item[2]))
    return [filename for _score, _days, filename in scored[: max(1, min(limit, 50))]]


def _global_audit_result(gdir: Path, *, max_issues: int = 50) -> dict[str, Any]:
    issues: list[dict[str, str]] = []
    files_checked = 0
    active_files = 0
    expired_files = 0
    content_hashes: dict[str, list[str]] = {}
    active_filenames: set[str] = set()

    index_path = gdir / GLOBAL_INDEX_FILENAME
    index_text = ""
    if index_path.is_file():
        try:
            index_text = index_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            _global_audit_add_issue(
                issues,
                "FAIL",
                GLOBAL_INDEX_FILENAME,
                "index_unreadable",
                f"Cannot read global MEMORY.md index: {exc}",
            )
    else:
        _global_audit_add_issue(
            issues,
            "WARN",
            GLOBAL_INDEX_FILENAME,
            "index_missing",
            "Global MEMORY.md index is missing; run memory_global_audit after a write/index refresh.",
        )

    for md_file in sorted(gdir.glob("*.md")):
        if md_file.name == GLOBAL_INDEX_FILENAME:
            continue
        files_checked += 1
        try:
            text = md_file.read_text(encoding="utf-8")
            fm, body = _parse_memory_file(text)
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            _global_audit_add_issue(
                issues,
                "FAIL",
                md_file.name,
                "parse_error",
                f"Cannot parse memory file: {exc}",
            )
            continue

        for field in GLOBAL_AUDIT_REQUIRED_FIELDS:
            if field not in fm:
                _global_audit_add_issue(
                    issues,
                    "FAIL",
                    md_file.name,
                    "missing_required_field",
                    f"Missing required frontmatter field: {field}",
                )

        try:
            uuid.UUID(str(fm.get("id", "")))
        except (ValueError, TypeError, AttributeError):
            _global_audit_add_issue(
                issues,
                "FAIL",
                md_file.name,
                "invalid_id",
                "Global memory id must be a UUID string.",
            )

        if fm.get("scope") != "global":
            _global_audit_add_issue(
                issues,
                "FAIL",
                md_file.name,
                "invalid_scope",
                "Global memory scope must be 'global'.",
            )

        mem_type = fm.get("type")
        if mem_type not in GLOBAL_MEMORY_TYPES:
            _global_audit_add_issue(
                issues,
                "FAIL",
                md_file.name,
                "invalid_type",
                f"Invalid global memory type: {mem_type!r}.",
            )

        source = fm.get("source")
        if not isinstance(source, dict) or not source.get("service"):
            _global_audit_add_issue(
                issues,
                "FAIL",
                md_file.name,
                "invalid_source",
                "source.service is required for global memory provenance.",
            )

        tags = fm.get("tags")
        if not isinstance(tags, list):
            _global_audit_add_issue(
                issues,
                "FAIL",
                md_file.name,
                "invalid_tags",
                "tags must be a YAML list.",
            )

        confidence = fm.get("confidence")
        try:
            confidence_value = float(confidence)
            if confidence_value < 0.0 or confidence_value > 1.0:
                raise ValueError
        except (TypeError, ValueError):
            _global_audit_add_issue(
                issues,
                "FAIL",
                md_file.name,
                "invalid_confidence",
                "confidence must be a number between 0.0 and 1.0.",
            )

        access_count = fm.get("access_count")
        if not isinstance(access_count, int) or access_count < 0:
            _global_audit_add_issue(
                issues,
                "FAIL",
                md_file.name,
                "invalid_access_count",
                "access_count must be a non-negative integer.",
            )

        for field in ("created", "updated", "last_accessed"):
            if field in fm and _parse_iso_datetime(fm.get(field)) is None:
                _global_audit_add_issue(
                    issues,
                    "FAIL",
                    md_file.name,
                    "invalid_timestamp",
                    f"{field} must be an ISO-8601 timestamp.",
                )

        if "ttl" in fm and fm.get("ttl") not in (None, "", "null"):
            if _parse_ttl_duration(fm.get("ttl")) is None:
                _global_audit_add_issue(
                    issues,
                    "WARN",
                    md_file.name,
                    "invalid_ttl",
                    "ttl is present but is not a supported ISO-8601 duration.",
                )

        if _is_ttl_expired(fm):
            expired_files += 1
        else:
            active_files += 1
            active_filenames.add(md_file.name)

        expected_hash = _compute_content_hash(body)
        actual_hash = str(fm.get("content_hash", ""))
        if actual_hash != expected_hash:
            _global_audit_add_issue(
                issues,
                "FAIL",
                md_file.name,
                "content_hash_mismatch",
                "content_hash does not match the stripped memory body.",
            )
        elif actual_hash:
            content_hashes.setdefault(actual_hash, []).append(md_file.name)

        has_secret, secret_reason = _contains_potential_secret(body)
        if has_secret:
            _global_audit_add_issue(
                issues,
                "FAIL",
                md_file.name,
                "secret_detected",
                f"Potential secret detected in memory body: {secret_reason}",
            )

        if not str(fm.get("description", "")).strip():
            _global_audit_add_issue(
                issues,
                "WARN",
                md_file.name,
                "missing_description",
                "description is empty; discoverability may be poor.",
            )

        retrieval_queries = fm.get("retrieval_queries")
        if retrieval_queries is not None:
            if not isinstance(retrieval_queries, list):
                _global_audit_add_issue(
                    issues,
                    "FAIL",
                    md_file.name,
                    "invalid_retrieval_queries",
                    "retrieval_queries must be a YAML list of non-empty strings.",
                )
            else:
                for raw_query in retrieval_queries:
                    if not isinstance(raw_query, str) or not raw_query.strip():
                        _global_audit_add_issue(
                            issues,
                            "FAIL",
                            md_file.name,
                            "invalid_retrieval_query",
                            "retrieval_queries entries must be non-empty strings.",
                        )
                        continue
                    hits = _global_audit_query_hits(gdir, raw_query, limit=5)
                    if md_file.name not in hits:
                        _global_audit_add_issue(
                            issues,
                            "FAIL",
                            md_file.name,
                            "retrieval_query_miss",
                            f"retrieval query did not return this memory in top 5: {raw_query!r}",
                        )

    for content_hash, filenames in sorted(content_hashes.items()):
        if len(filenames) > 1:
            _global_audit_add_issue(
                issues,
                "WARN",
                ", ".join(filenames),
                "duplicate_content_hash",
                f"{len(filenames)} global memories share {content_hash}.",
            )

    if index_text:
        index_refs = set(re.findall(r"memories/([^\)\s]+\.md)", index_text))
        for filename in sorted(active_filenames):
            if filename not in index_text:
                _global_audit_add_issue(
                    issues,
                    "WARN",
                    filename,
                    "index_missing_memory",
                    "Active memory is not referenced from MEMORY.md.",
                )
        for filename in sorted(index_refs):
            if not (gdir / filename).exists():
                _global_audit_add_issue(
                    issues,
                    "WARN",
                    GLOBAL_INDEX_FILENAME,
                    "index_stale_reference",
                    f"MEMORY.md references missing memory file: {filename}",
                )

    fail_count = sum(1 for issue in issues if issue["severity"] == "FAIL")
    warn_count = sum(1 for issue in issues if issue["severity"] == "WARN")
    status = "FAIL" if fail_count else ("WARN" if warn_count else "PASS")
    max_issues = max(1, min(int(max_issues or 50), 500))
    return {
        "status": status,
        "files_checked": files_checked,
        "active_files": active_files,
        "expired_files": expired_files,
        "issue_counts": {"fail": fail_count, "warn": warn_count},
        "issues": issues[:max_issues],
        "issues_truncated": len(issues) > max_issues,
    }


def _format_global_audit(result: dict[str, Any]) -> str:
    lines = [
        f"{result['status']}: global memory audit",
        (
            f"  Files checked: {result['files_checked']} "
            f"(active: {result['active_files']}, expired: {result['expired_files']})"
        ),
        (
            f"  Issues: FAIL={result['issue_counts']['fail']}, "
            f"WARN={result['issue_counts']['warn']}"
        ),
    ]
    if result["issues"]:
        lines.append("")
        for issue in result["issues"]:
            lines.append(
                f"- {issue['severity']} [{issue['code']}] {issue['filename']}: "
                f"{issue['message']}"
            )
        if result.get("issues_truncated"):
            lines.append("- WARN [truncated] Additional issues omitted by max_issues.")
    return _truncate_output("\n".join(lines))


# ---------------------------------------------------------------------------
# Helpers — session memory path resolution
# ---------------------------------------------------------------------------


def _detect_session_id() -> str | None:
    """Detect the current session ID across templestay-supported runtimes.

    Priority: TEMPLATESTAY_SESSION_ID → CODEX_SESSION_ID →
    CLAUDE_SESSION_ID → COPILOT_SESSION_ID → session-dir basename → None.
    """
    for env_name in PLATFORM_SESSION_ID_ENV_ORDER:
        sid = os.environ.get(env_name)
        if sid:
            return sid
    for env_name in PLATFORM_SESSION_DIR_ENV_ORDER:
        sdir = os.environ.get(env_name)
        if sdir:
            return Path(sdir).name
    return None


def _detect_session_dir() -> str | None:
    """Return an explicit runtime session directory, if one is provided."""
    for env_name in PLATFORM_SESSION_DIR_ENV_ORDER:
        sdir = os.environ.get(env_name)
        if sdir:
            return sdir
    return None


def _session_state_base_dir() -> Path:
    """Return the session-state base under the platform-neutral memory root."""
    return _memory_root_dir() / "session-state"


def _no_active_session_error() -> str:
    """Return the platform-neutral no-session guidance message."""
    return (
        "❌ Error: No active session detected. Set TEMPLATESTAY_SESSION_ID, "
        "CODEX_SESSION_ID, CLAUDE_SESSION_ID, COPILOT_SESSION_ID, or pass session_id."
    )


def _session_memories_dir_readonly(session_id: str | None = None) -> Path | None:
    """Resolve the session memory directory path without creating it."""
    explicit = session_id is not None
    if session_id is None:
        session_id = _detect_session_id()
    if session_id is None:
        return None

    if not explicit:
        sdir = _detect_session_dir()
        if sdir:
            return Path(sdir) / "memories"

    return _session_state_base_dir() / session_id / "memories"


def _session_memories_dir(session_id: str | None = None) -> Path | None:
    """Resolve session memory directory.

    When an explicit session_id is provided, it always takes priority and
    the path is built from <memory-root>/session-state/<session_id>/memories.
    Runtime session-dir env vars are only used when session_id was auto-detected.
    Returns None if no session can be determined.
    """
    d = _session_memories_dir_readonly(session_id)
    if d is None:
        return None
    d.mkdir(parents=True, exist_ok=True)
    return d


def _rebuild_session_index(session_id: str | None = None) -> str:
    """Rebuild the session MEMORY.md index."""
    sdir = _session_memories_dir(session_id)
    if sdir is None:
        return "No active session detected."
    return _rebuild_index_for_dir(sdir, SESSION_MEMORY_TYPES, "Session Memory Index")


def _write_session_index(session_id: str | None = None) -> None:
    """Regenerate and write the session MEMORY.md index."""
    sdir = _session_memories_dir(session_id)
    if sdir is None:
        return
    content = _rebuild_session_index(session_id)
    idx_path = sdir / INDEX_FILENAME
    _atomic_write(idx_path, content)


# ---------------------------------------------------------------------------
# Helpers — tokenization, validation, and input limits (W-4, W-11, W-12)
# ---------------------------------------------------------------------------

_WORD_RE = re.compile(r'[a-zA-Z0-9\u3130-\u318F\uAC00-\uD7AF\u4E00-\u9FFF]+')


def _tokenize(text: str) -> list[str]:
    """Split text into lowercase word tokens for TF-IDF scoring."""
    return _WORD_RE.findall(text.lower())


def _validate_path_containment(file_path: Path, container_dir: Path) -> str | None:
    """Verify file_path resolves within container_dir. Returns error message or None."""
    try:
        resolved = file_path.resolve()
        container = container_dir.resolve()
        if not str(resolved).startswith(str(container) + os.sep) and resolved != container:
            return "❌ Error: Path traversal detected."
    except (OSError, ValueError):
        return "❌ Error: Invalid file path."
    return None


def _validate_input_size(value: str, field_name: str, max_bytes: int) -> str | None:
    """Check input size. Returns error message or None."""
    if len(value.encode("utf-8")) > max_bytes:
        return f"❌ Error: {field_name} exceeds maximum size of {max_bytes:,} bytes."
    return None


# ---------------------------------------------------------------------------
# Helpers — unified search / list / read (W-8: eliminate tier duplication)
# ---------------------------------------------------------------------------


def _unified_search(
    memory_dir: Path,
    query: str,
    types: str = "",
    tags: str = "",
    limit: int = 10,
    valid_types: tuple[str, ...] = MEMORY_TYPES,
    tier_qualifier: str = "",
    search_emoji: str = "🔍",
    skip_if_expired: bool = False,
    track_access: bool = False,
) -> str:
    """Unified search across any memory directory with TF-IDF scoring.

    All three tiers (project, global, session) delegate to this function.

    Args:
        memory_dir: Directory containing memory .md files.
        query: Search keywords (already stripped/validated by caller).
        types: Comma-separated type filter string.
        tags: Comma-separated tag filter string.
        limit: Maximum results to return.
        valid_types: Tuple of valid memory types for this tier.
        tier_qualifier: Display qualifier (e.g. "", "global ", "session ").
        search_emoji: Emoji prefix for the results header.

    Returns:
        Formatted search results string.
    """
    # W-15: Validate and clamp limit parameter
    limit = max(1, min(int(limit or 10), 200))

    keywords = [kw.lower() for kw in query.split() if kw]

    # Parse type filter
    type_filter: set[str] | None = None
    if types.strip():
        type_filter = {t.strip().lower() for t in types.split(",") if t.strip()}
        invalid = type_filter - set(valid_types)
        if invalid:
            return (
                f"❌ Error: Invalid {tier_qualifier}type(s): {', '.join(sorted(invalid))}. "
                f"Valid types: {', '.join(valid_types)}"
            )

    # Parse tags filter
    tag_filter: list[str] | None = None
    if tags.strip():
        tag_filter = _parse_tags(tags)

    # First pass: collect all documents and compute document frequencies for TF-IDF
    all_docs: list[tuple[Path, dict[str, Any], str, list[str], set[str]]] = []
    doc_freq: dict[str, int] = {}

    for md_file in sorted(memory_dir.glob("*.md")):
        if md_file.name == INDEX_FILENAME:
            continue

        fm, body = _parse_frontmatter_cached(md_file)
        if not fm:
            continue
        if skip_if_expired and _is_ttl_expired(fm):
            continue

        name = fm.get("name", md_file.stem)
        description = fm.get("description", "")
        searchable = f"{name} {description} {body}"
        tokens = _tokenize(searchable)
        token_set = set(tokens)

        all_docs.append((md_file, fm, body, tokens, token_set))

        for kw in keywords:
            if kw in token_set:
                doc_freq[kw] = doc_freq.get(kw, 0) + 1

    total_docs = len(all_docs)
    results: list[dict[str, Any]] = []

    # Second pass: score each document with TF-IDF and apply filters
    for md_file, fm, body, tokens, token_set in all_docs:
        mem_type = fm.get("type", "unknown")
        if type_filter and mem_type not in type_filter:
            continue

        # Filter by tags (must contain ALL specified tags) — W-5: uses _normalize_tags
        if tag_filter:
            mem_tags = [str(t).lower() for t in _normalize_tags(fm.get("tags"))]
            if not all(t in mem_tags for t in tag_filter):
                continue

        name = fm.get("name", md_file.stem)
        description = fm.get("description", "")
        updated = fm.get("updated") or fm.get("created", "")

        # TF-IDF scoring: rare terms score higher than common terms (W-4: word tokenization)
        word_count = max(len(tokens), 1)
        score = 0.0
        for kw in keywords:
            tf = tokens.count(kw) / word_count
            df = doc_freq.get(kw, 0)
            idf = math.log(1 + total_docs / df) if df > 0 else 0.0
            score += tf * idf

        if score == 0:
            continue

        days = _age_days(updated)
        preview = body.strip()[:200]
        if len(body.strip()) > 200:
            preview += "…"

        results.append(
            {
                "name": name,
                "type": mem_type,
                "description": description,
                "filename": md_file.name,
                "age": _human_age(days),
                "days": days,
                "score": score,
                "preview": preview,
            }
        )

    # Sort by relevance (score desc), then recency (days asc)
    results.sort(key=lambda r: (-r["score"], r["days"]))
    results = results[:limit]

    if track_access:
        for r in results:
            _update_access_metadata(memory_dir / r["filename"])

    if not results:
        return f"No {tier_qualifier}memories found matching '{query}'."

    lines = [f"{search_emoji} Found {len(results)} {tier_qualifier}memor{'y' if len(results) == 1 else 'ies'} matching '{query}':", ""]
    for r in results:
        staleness = _staleness_warning(r["days"])
        lines.append(f"### [{r['type']}] {r['name']}")
        lines.append(f"  File: {r['filename']}")
        lines.append(f"  Description: {r['description']}")
        lines.append(f"  Age: {r['age']}  |  Relevance score: {r['score']:.4f}")
        if staleness:
            lines.append(f"  {staleness}")
        lines.append(f"  Preview: {r['preview']}")
        lines.append("")

    return _truncate_output("\n".join(lines))


def _unified_list(
    memory_dir: Path,
    type_filter_str: str = "",
    tags: str = "",
    sort_by: str = "recent",
    valid_types: tuple[str, ...] = MEMORY_TYPES,
    tier_qualifier: str = "",
    list_emoji: str = "📋",
    no_results_suffix: str = ".",
    skip_if_expired: bool = False,
    track_access: bool = False,
) -> str:
    """Unified list across any memory directory.

    All three tiers (project, global, session) delegate to this function.

    Args:
        memory_dir: Directory containing memory .md files.
        type_filter_str: Optional single type filter (raw string from caller).
        tags: Comma-separated tag filter string.
        sort_by: Sort order — 'recent', 'type', or 'name'.
        valid_types: Tuple of valid memory types for this tier.
        tier_qualifier: Display qualifier (e.g. "", "global ", "session ").
        list_emoji: Emoji prefix for the list header.
        no_results_suffix: Suffix for the "no results" message.

    Returns:
        Formatted list of memories.
    """
    # Validate optional type filter
    type_filter: str | None = None
    if type_filter_str.strip():
        type_filter = type_filter_str.strip().lower()
        if type_filter not in valid_types:
            return (
                f"❌ Error: Invalid {tier_qualifier}type '{type_filter_str}'. "
                f"Must be one of: {', '.join(valid_types)}"
            )

    # Parse tags filter
    tag_filter: list[str] | None = None
    if tags.strip():
        tag_filter = _parse_tags(tags)

    # Validate sort_by
    valid_sorts = ("recent", "type", "name")
    sort_by = sort_by.strip().lower()
    if sort_by not in valid_sorts:
        return f"❌ Error: Invalid sort_by '{sort_by}'. Must be one of: {', '.join(valid_sorts)}"

    entries: list[dict[str, Any]] = []

    for md_file in sorted(memory_dir.glob("*.md")):
        if md_file.name == INDEX_FILENAME:
            continue
        fm, _ = _parse_frontmatter_cached(md_file)
        if not fm:
            continue
        if skip_if_expired and _is_ttl_expired(fm):
            continue

        mem_type = fm.get("type", "unknown")
        if type_filter and mem_type != type_filter:
            continue

        # Filter by tags (must contain ALL specified tags) — W-5: uses _normalize_tags
        if tag_filter:
            mem_tags = [str(t).lower() for t in _normalize_tags(fm.get("tags"))]
            if not all(t in mem_tags for t in tag_filter):
                continue

        name = fm.get("name", md_file.stem)
        description = fm.get("description", "")
        updated = fm.get("updated") or fm.get("created", "")
        mem_tags_raw = _normalize_tags(fm.get("tags"))
        days = _age_days(updated)

        entries.append(
            {
                "name": name,
                "type": mem_type,
                "description": description,
                "filename": md_file.name,
                "age": _human_age(days),
                "days": days,
                "updated": updated,
                "tags": mem_tags_raw,
            }
        )

    if not entries:
        filter_msg = f" of type '{type_filter}'" if type_filter else ""
        if tag_filter:
            filter_msg += f" with tags [{', '.join(tag_filter)}]"
        return f"No {tier_qualifier}memories found{filter_msg}{no_results_suffix}"

    # Apply sorting
    if sort_by == "recent":
        entries.sort(key=lambda e: -_timestamp_sort_key(e["updated"]))
    elif sort_by == "type":
        type_order = {t: i for i, t in enumerate(valid_types)}
        entries.sort(key=lambda e: (type_order.get(e["type"], 99), -_timestamp_sort_key(e["updated"])))
    elif sort_by == "name":
        entries.sort(key=lambda e: e["name"].lower())

    if track_access:
        for e in entries:
            _update_access_metadata(memory_dir / e["filename"])

    header = f"{list_emoji} {len(entries)} {tier_qualifier}memor{'y' if len(entries) == 1 else 'ies'}"
    if type_filter:
        header += f" (type: {type_filter})"
    if tag_filter:
        header += f" (tags: {', '.join(tag_filter)})"
    header += f", sorted by {sort_by}"

    lines = [header, ""]
    for e in entries:
        staleness = _staleness_warning(e["days"])
        line = f"- [{e['type']}] **{e['name']}** — {e['description']}  ({e['age']})  `{e['filename']}`"
        if e.get("tags"):
            line += f"  [tags: {', '.join(str(t) for t in e['tags'])}]"
        if staleness:
            line += f"\n  {staleness}"
        lines.append(line)

    return _truncate_output("\n".join(lines))


def _unified_read(
    memory_dir: Path,
    filename: str,
    tier_qualifier: str = "",
    skip_if_expired: bool = False,
    track_access: bool = False,
) -> str:
    """Unified read for any memory directory.

    All three tiers (project, global, session) delegate to this function.

    Args:
        memory_dir: Directory containing memory .md files.
        filename: The .md filename to read.
        tier_qualifier: Display qualifier for error messages (e.g. "", "global ", "session ").

    Returns:
        Full file content with optional staleness warning prefix.
    """
    filename = filename.strip()
    if not filename:
        return "❌ Error: Filename cannot be empty."

    # Security: prevent path traversal
    if "/" in filename or "\\" in filename or ".." in filename:
        return "❌ Error: Invalid filename. Must be a plain filename, not a path."

    file_path = memory_dir / filename

    # W-11: Path containment validation
    containment_err = _validate_path_containment(file_path, memory_dir)
    if containment_err:
        return containment_err

    if not file_path.is_file():
        label = f"{tier_qualifier.strip().capitalize()} memory" if tier_qualifier.strip() else "Memory"
        return f"❌ Error: {label} file '{filename}' not found."

    try:
        text = file_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return f"❌ Error reading file: {exc}"

    fm, _ = _parse_memory_file(text)
    if skip_if_expired and _is_ttl_expired(fm):
        label = f"{tier_qualifier.strip().capitalize()} memory" if tier_qualifier.strip() else "Memory"
        return f"❌ Error: {label} file '{filename}' has expired (TTL)."
    updated = fm.get("updated") or fm.get("created", "")
    days = _age_days(updated)
    staleness = _staleness_warning(days)

    if track_access:
        _update_access_metadata(file_path)

    output_parts: list[str] = []
    if staleness:
        output_parts.append(staleness)
        output_parts.append("")
    output_parts.append(text)

    return _truncate_output("\n".join(output_parts))


def _unified_delete(
    memory_dir: Path,
    filename: str,
    write_index_fn: Callable[[], None],
    tier_qualifier: str = "",
) -> str:
    """Unified delete for any memory directory.

    All three tiers (project, global, session) delegate to this function.

    Args:
        memory_dir: Directory containing memory .md files.
        filename: The .md filename to delete.
        write_index_fn: Callable to regenerate the index after deletion.
        tier_qualifier: Display qualifier (e.g. "", "global ", "session ").

    Returns:
        Confirmation or error message.
    """
    filename = filename.strip()
    if not filename:
        return "❌ Error: Filename cannot be empty."

    # Security: prevent path traversal
    if "/" in filename or "\\" in filename or ".." in filename:
        return "❌ Error: Invalid filename. Must be a plain filename, not a path."

    if filename == INDEX_FILENAME:
        return "❌ Error: Cannot delete the MEMORY.md index file. Use memory_index() to regenerate it."

    file_path = memory_dir / filename

    # W-11: Path containment validation
    containment_err = _validate_path_containment(file_path, memory_dir)
    if containment_err:
        return containment_err

    tier_label = (
        f"{tier_qualifier.strip().capitalize()} memory" if tier_qualifier.strip() else "Memory"
    )

    if not file_path.is_file():
        return f"❌ Error: {tier_label} file '{filename}' not found."

    # Read name before deleting for confirmation
    try:
        text = file_path.read_text(encoding="utf-8")
        fm, _ = _parse_memory_file(text)
        name = fm.get("name", filename)
    except (OSError, UnicodeDecodeError):
        name = filename

    with _file_lock:
        try:
            file_path.unlink()
            write_index_fn()
        except OSError as exc:
            return f"❌ Error deleting file: {exc}"

    return f"✅ {tier_label} '{name}' deleted.\n  File: {filename}"


def _unified_update(
    memory_dir: Path,
    filename: str,
    content: str,
    name: str,
    description: str,
    tags: str,
    write_index_fn: Callable[[], None],
    tier_qualifier: str = "",
) -> str:
    """Unified update for any memory directory.

    All three tiers (project, global, session) delegate to this function.
    Supports the __CLEAR__ sentinel for explicitly clearing fields (W-14).

    Args:
        memory_dir: Directory containing memory .md files.
        filename: The .md filename to update.
        content: New body content. Empty string = unchanged. "__CLEAR__" = clear body.
        name: New display name. Empty string = unchanged. "__CLEAR__" = clear.
        description: New one-line summary. Empty string = unchanged. "__CLEAR__" = clear.
        tags: New comma-separated tags (replaces existing). Empty = unchanged.
              "__CLEAR__" = remove all tags.
        write_index_fn: Callable to regenerate the index after update.
        tier_qualifier: Display qualifier (e.g. "", "global ", "session ").

    Returns:
        Confirmation or error message.
    """
    filename = filename.strip()
    if not filename:
        return "❌ Error: Filename cannot be empty."

    # Security: prevent path traversal
    if "/" in filename or "\\" in filename or ".." in filename:
        return "❌ Error: Invalid filename. Must be a plain filename, not a path."

    if filename == INDEX_FILENAME:
        return "❌ Error: Cannot update the MEMORY.md index file."

    file_path = memory_dir / filename

    # W-11: Path containment validation
    containment_err = _validate_path_containment(file_path, memory_dir)
    if containment_err:
        return containment_err

    tier_label = (
        f"{tier_qualifier.strip().capitalize()} memory" if tier_qualifier.strip() else "Memory"
    )

    if not file_path.is_file():
        return f"❌ Error: {tier_label} file '{filename}' not found."

    # Read existing file
    try:
        text = file_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return f"❌ Error reading file: {exc}"

    fm, body = _parse_memory_file(text)
    if not fm:
        return f"❌ Error: File '{filename}' has no valid frontmatter."

    # Track what was updated
    updated_fields: list[str] = []

    # Update fields if provided; "__CLEAR__" explicitly clears a field (W-14)
    if name == "__CLEAR__":
        fm["name"] = ""
        updated_fields.append("name")
    elif name.strip():
        fm["name"] = name.strip()
        updated_fields.append("name")

    if description == "__CLEAR__":
        fm["description"] = ""
        updated_fields.append("description")
    elif description.strip():
        fm["description"] = description.strip()
        updated_fields.append("description")

    if content == "__CLEAR__":
        body = ""
        updated_fields.append("content")
    elif content.strip():
        body = content.strip()
        updated_fields.append("content")

    if tags == "__CLEAR__":
        fm.pop("tags", None)
        updated_fields.append("tags")
    elif tags.strip():
        parsed_tags = _parse_tags(tags)
        if parsed_tags:
            fm["tags"] = _FlowList(parsed_tags)
        updated_fields.append("tags")

    if not updated_fields:
        return "❌ Error: No fields to update. Provide at least one of: content, name, description, tags."

    # Preserve created timestamp, set new updated timestamp
    fm["updated"] = _now_iso()

    # Serialize and write
    file_content = _serialize_memory(fm, body)

    with _file_lock:
        try:
            _atomic_write(file_path, file_content)
            write_index_fn()
        except OSError as exc:
            return f"❌ Error writing memory file: {exc}"

    return (
        f"✅ {tier_label} updated successfully.\n"
        f"  File: {filename}\n"
        f"  Updated fields: {', '.join(updated_fields)}\n"
        f"  Name: {fm['name']}"
    )


# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------

mcp = FastMCP("memory-v2")


@mcp.tool()
def memory_save(
    type: str,
    name: str,
    content: str,
    description: str = "",
    tags: str = "",
) -> str:
    """Save a new memory to persistent storage.

    Args:
        type: Memory type — one of: user, feedback, project, reference.
        name: Short title for the memory (used as filename basis and display name).
        content: The body content of the memory (Markdown).
        description: Optional one-line summary. If omitted, the first line of content
                     is used (truncated to 120 chars).
        tags: Optional comma-separated tags (e.g. "important,project-x").
              Stored as a list in frontmatter.

    Returns:
        Confirmation message with the saved file path.
    """
    # Validate type
    mem_type = type.strip().lower()
    if mem_type not in MEMORY_TYPES:
        return f"❌ Error: Invalid memory type '{type}'. Must be one of: {', '.join(MEMORY_TYPES)}"

    name = name.strip()
    if not name:
        return "❌ Error: Memory name cannot be empty."

    content = content.strip()
    if not content:
        return "❌ Error: Memory content cannot be empty."

    # W-12: Input size limits
    err = _validate_input_size(name, "name", MAX_NAME_BYTES)
    if err:
        return err
    err = _validate_input_size(content, "content", MAX_CONTENT_BYTES)
    if err:
        return err

    # Auto-generate description from first line if not provided
    if not description:
        first_line = content.split("\n", 1)[0].strip()
        # Strip markdown heading markers
        first_line = re.sub(r"^#+\s*", "", first_line)
        description = first_line[:120]

    # Parse tags
    parsed_tags = _parse_tags(tags) if tags.strip() else None

    project_path = _project_dir()
    filename = _generate_filename(name)
    file_path = project_path / filename

    frontmatter = _build_frontmatter(name, description, mem_type, tags=parsed_tags)
    frontmatter["project_key"] = project_path.name
    file_content = _serialize_memory(frontmatter, content)

    with _file_lock:
        try:
            _atomic_write(file_path, file_content)
            _write_index(project_path)
        except OSError as exc:
            return f"❌ Error writing memory file: {exc}"

    return (
        f"✅ Memory saved successfully.\n"
        f"  File: {filename}\n"
        f"  Path: {file_path}\n"
        f"  Type: {mem_type}\n"
        f"  Name: {name}"
    )


@mcp.tool()
def memory_search(
    query: str,
    types: str = "",
    tags: str = "",
    limit: int = 10,
) -> str:
    """Search across all memory files for the current project.

    Args:
        query: Search keywords (case-insensitive). Matches against name, description, and body.
        types: Optional comma-separated list of types to filter by (e.g. "user,feedback").
        tags: Optional comma-separated tags to filter by. Memories must contain ALL specified tags.
        limit: Maximum number of results to return (default 10).

    Returns:
        Formatted list of matching memories with name, type, description, age, and preview.
    """
    query = query.strip()
    if not query:
        return "❌ Error: Search query cannot be empty."

    # W-12: Input size limits
    err = _validate_input_size(query, "query", MAX_QUERY_BYTES)
    if err:
        return err

    project_path = _project_dir()
    return _unified_search(
        project_path, query, types, tags, limit, MEMORY_TYPES,
        track_access=True,
    )


@mcp.tool()
def memory_list(
    type: str = "",
    tags: str = "",
    sort_by: str = "recent",
) -> str:
    """List all memories for the current project.

    Args:
        type: Optional type filter — one of: user, feedback, project, reference.
        tags: Optional comma-separated tags to filter by. Memories must contain ALL specified tags.
        sort_by: Sort order — 'recent' (default), 'type', or 'name'.

    Returns:
        Formatted list of memories with staleness annotations.
    """
    project_path = _project_dir()
    return _unified_list(
        project_path, type, tags, sort_by, MEMORY_TYPES,
        no_results_suffix=" for this project.",
        track_access=True,
    )


@mcp.tool()
def memory_read(filename: str) -> str:
    """Read a specific memory file by filename.

    Args:
        filename: The .md filename (e.g. "my-memory-abc12.md").

    Returns:
        Full file content including YAML frontmatter, with staleness warning if applicable.
    """
    project_path = _project_dir()
    return _unified_read(project_path, filename, track_access=True)


@mcp.tool()
def memory_delete(filename: str) -> str:
    """Delete a memory file and update the MEMORY.md index.

    Args:
        filename: The .md filename to delete (e.g. "my-memory-abc12.md").

    Returns:
        Confirmation message.
    """
    project_path = _project_dir()
    return _unified_delete(project_path, filename, lambda: _write_index(project_path))


@mcp.tool()
def memory_index() -> str:
    """Regenerate the MEMORY.md index from all memory files in the project directory.

    Scans the directory, reads frontmatter of each .md file, sorts by type then
    recency, and caps the index at 200 lines / 25KB.

    Returns:
        Index summary with counts per type.
    """
    project_path = _project_dir()

    with _file_lock:
        try:
            content = _write_index(project_path)
        except OSError as exc:
            return f"❌ Error regenerating index: {exc}"

    # W-17: Extract counts from the index content instead of scanning the
    # directory a second time.  _rebuild_index_for_dir already embeds a
    # **Totals:** line with per-type counts.
    type_counts: dict[str, int] = {}
    total = 0
    for line in content.split("\n"):
        m = re.match(r"\*\*Totals:\*\*\s+(\d+)\s+memories\s+\((.+)\)", line)
        if m:
            total = int(m.group(1))
            for part in m.group(2).split(","):
                part = part.strip()
                if ":" in part:
                    t, c = part.rsplit(":", 1)
                    type_counts[t.strip()] = int(c.strip())
            break

    counts_lines = [f"  {t}: {c}" for t, c in sorted(type_counts.items())]
    counts_str = "\n".join(counts_lines) if counts_lines else "  (none)"

    index_path = project_path / INDEX_FILENAME
    index_size = index_path.stat().st_size if index_path.is_file() else 0
    index_line_count = content.count("\n")

    return (
        f"✅ MEMORY.md index regenerated.\n"
        f"  Path: {index_path}\n"
        f"  Total memories: {total}\n"
        f"  Index: {index_line_count} lines, {index_size} bytes\n"
        f"  Counts by type:\n{counts_str}"
    )


@mcp.tool()
def memory_update(
    filename: str,
    content: str = "",
    name: str = "",
    description: str = "",
    tags: str = "",
) -> str:
    """Update an existing memory file in-place.

    Preserves the original created timestamp and updates the updated timestamp.
    Only specified (non-empty) fields are changed; omitted fields are preserved.
    Pass "__CLEAR__" as the value to explicitly clear a field.

    Args:
        filename: The .md filename to update (e.g. "my-memory-abc12.md").
        content: New body content (Markdown). If omitted, body is unchanged.
                 Use "__CLEAR__" to clear the body.
        name: New display name. If omitted, name is unchanged.
              Use "__CLEAR__" to clear.
        description: New one-line summary. If omitted, description is unchanged.
                     Use "__CLEAR__" to clear.
        tags: New comma-separated tags (replaces existing tags). If omitted, tags are unchanged.
              Use "__CLEAR__" to remove all tags.

    Returns:
        Confirmation message with updated fields.
    """
    project_path = _project_dir()
    # W-12: Input size limits
    if content:
        err = _validate_input_size(content, "content", MAX_CONTENT_BYTES)
        if err:
            return err
    return _unified_update(
        project_path, filename, content, name, description, tags,
        lambda: _write_index(project_path),
    )


# ---------------------------------------------------------------------------
# MCP Tools — Global memory tier
# ---------------------------------------------------------------------------


@mcp.tool()
def memory_promote(
    filename: str,
    global_type: str = "",
    global_tags: str = "",
    force: bool = False,
) -> str:
    """Promote a local project memory to the global memory tier.

    Copies the memory to ~/.copilot/global-memory/memories/ with type mapping.
    The original local memory is preserved (not deleted).

    Promotion criteria (enforced unless force=True):
    - No blocked tags (checkpoint, transient, wip, debug, scratch, etc.)
    - Confidence score ≥ 0.8 (if present in frontmatter)
    - Cross-project applicability: requires either a promotion-eligible tag
      (lesson, pattern, convention, etc.) or 'cross_project: true' in frontmatter

    Args:
        filename: The local .md filename to promote (e.g., "my-memory-abc12.md").
        global_type: Override the global type. If omitted, auto-mapped from local type.
                     Must be one of: preference, pattern, convention.
        global_tags: Additional comma-separated tags for the global copy.
                     Merged with existing tags + "promoted" tag.
        force: If true, bypass all promotion criteria checks.

    Returns:
        Confirmation with the global file path, or rejection with reason.
    """
    filename = filename.strip()
    if not filename:
        return "❌ Error: Filename cannot be empty."

    # Security: prevent path traversal
    if "/" in filename or "\\" in filename or ".." in filename:
        return "❌ Error: Invalid filename. Must be a plain filename, not a path."

    project_path = _project_dir()
    file_path = project_path / filename

    if not file_path.is_file():
        return f"❌ Error: Memory file '{filename}' not found in project directory."

    try:
        text = file_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return f"❌ Error reading file: {exc}"

    fm, body = _parse_memory_file(text)
    if not fm:
        return f"❌ Error: File '{filename}' has no valid frontmatter."

    local_type = fm.get("type", "unknown")

    # --- Promotion criteria enforcement (unless force=True) ---
    existing_tags = {str(t).lower() for t in _normalize_tags(fm.get("tags"))}

    if not force:
        blocked = existing_tags & PROMOTE_BLOCKED_TAGS
        if blocked:
            return (
                f"❌ Promotion blocked: memory has tags indicating non-permanent content: "
                f"{', '.join(sorted(blocked))}.\n"
                f"  Global memory is reserved for established, cross-project knowledge.\n"
                f"  Use force=true to override."
            )

        # Check confidence threshold
        confidence = fm.get("confidence")
        if confidence is not None:
            try:
                conf_val = float(confidence)
                if conf_val < PROMOTE_MIN_CONFIDENCE:
                    return (
                        f"❌ Promotion blocked: confidence {conf_val:.2f} is below "
                        f"the minimum threshold ({PROMOTE_MIN_CONFIDENCE}).\n"
                        f"  Only well-established knowledge should be promoted to global tier.\n"
                        f"  Use force=true to override."
                    )
            except (ValueError, TypeError):
                pass  # Non-numeric confidence — skip check

        # Check for cross-project applicability signal
        cross_project = fm.get("cross_project", None)
        has_eligible_tag = bool(existing_tags & PROMOTE_ELIGIBLE_TAGS)

        if not has_eligible_tag and cross_project is not True:
            return (
                f"❌ Promotion blocked: no cross-project applicability signal found.\n"
                f"  Memory needs either:\n"
                f"  - A promotion-eligible tag ({', '.join(sorted(PROMOTE_ELIGIBLE_TAGS)[:5])}, ...)\n"
                f"  - A 'cross_project: true' field in frontmatter\n"
                f"  Global memory is for knowledge valuable across multiple projects.\n"
                f"  Use force=true to override."
            )

    # Determine the global type
    if global_type.strip():
        mapped_type = global_type.strip().lower()
        if mapped_type not in GLOBAL_MEMORY_TYPES:
            return (
                f"❌ Error: Invalid global type '{global_type}'. "
                f"Must be one of: {', '.join(GLOBAL_MEMORY_TYPES)}"
            )
    else:
        mapped_type = PROMOTE_TYPE_MAP.get(local_type)
        if not mapped_type:
            return (
                f"❌ Error: Cannot auto-map local type '{local_type}' to a global type. "
                f"Provide an explicit global_type (one of: {', '.join(GLOBAL_MEMORY_TYPES)})."
            )

    # Build project key for provenance tracking
    git_root = _find_git_root()
    if git_root:
        project_key = _sanitize_project_key(git_root)
    else:
        cwd = os.environ.get("CWD") or os.environ.get("PWD") or os.getcwd()
        project_key = _sanitize_project_key(cwd)

    # Merge tags: existing + additional + promoted + from:<project>
    existing_tags_list = [str(t).lower() for t in _normalize_tags(fm.get("tags"))]
    additional_tags = _parse_tags(global_tags) if global_tags.strip() else []
    merged_tags = list(
        dict.fromkeys(existing_tags_list + additional_tags + ["promoted", f"from:{project_key}"])
    )

    # Build new frontmatter for the global copy
    local_name = fm.get("name", filename)
    local_description = fm.get("description", "")

    new_fm = _build_frontmatter(
        name=local_name,
        description=local_description,
        mem_type=mapped_type,
        tags=merged_tags,
    )
    # Add provenance metadata
    new_fm["promoted_from"] = {
        "project": project_key,
        "original_file": filename,
        "promoted_at": _now_iso(),
    }

    new_filename = _generate_filename(local_name)
    new_content = _serialize_memory(new_fm, body)

    gdir = _global_memories_dir()
    _ensure_service_registered()
    _migrate_global_memories_once()
    new_path = gdir / new_filename

    # §11 Secret scan — refuse to promote content with obvious credentials.
    has_secret, reason = _contains_potential_secret(body)
    if has_secret:
        return (
            "❌ Promotion blocked: potential secret detected in body "
            f"({reason}). Global memory MUST NOT contain credentials.\n"
            "  Use the 'credential_ref' type to record credential locations "
            "(pointers only, never values)."
        )

    # Inject Global Memory Standard v1.0 REQUIRED fields.
    new_fm, _ = _ensure_standard_global_fm(
        new_fm,
        body,
        project=project_key,
        session=os.environ.get("COPILOT_SESSION_ID", "") or None,
    )
    new_content = _serialize_memory(new_fm, body)

    with _global_lock():
        # §7.1 content-hash deduplication
        dup_path = _find_duplicate_by_hash(new_fm.get("content_hash", ""))
        if dup_path is not None:
            try:
                dup_text = dup_path.read_text(encoding="utf-8")
                dup_fm, dup_body = _parse_memory_file(dup_text)
                # Merge tags (union), bump access_count, max confidence.
                dup_tags = [str(t).lower() for t in _normalize_tags(dup_fm.get("tags"))]
                merged = list(dict.fromkeys(dup_tags + merged_tags))
                dup_fm["tags"] = merged
                dup_fm["access_count"] = int(dup_fm.get("access_count", 0) or 0) + 1
                try:
                    new_conf = float(new_fm.get("confidence", GLOBAL_DEFAULT_CONFIDENCE))
                    old_conf = float(dup_fm.get("confidence", GLOBAL_DEFAULT_CONFIDENCE))
                    dup_fm["confidence"] = max(new_conf, old_conf)
                except (TypeError, ValueError):
                    pass
                dup_fm["updated"] = _now_iso()
                _atomic_write(dup_path, _serialize_memory(dup_fm, dup_body), perms=GLOBAL_FILE_MODE)
                _write_global_index()
                _append_merge_log(
                    {
                        "event": "duplicate_merge",
                        "service": GLOBAL_SERVICE_NAME,
                        "memory_id": dup_fm.get("id"),
                        "filename": dup_path.name,
                        "promoted_from": filename,
                    }
                )
                return (
                    "✅ Memory merged with existing global memory (content_hash match).\n"
                    f"  Local file: {filename} (preserved)\n"
                    f"  Existing global file: {dup_path.name}\n"
                    f"  Tags merged, access_count bumped."
                )
            except (OSError, UnicodeDecodeError) as exc:
                return f"❌ Error merging duplicate: {exc}"

        try:
            _atomic_write(new_path, new_content, perms=GLOBAL_FILE_MODE)
            _write_global_index()
            _append_merge_log(
                {
                    "event": "promote",
                    "service": GLOBAL_SERVICE_NAME,
                    "memory_id": new_fm.get("id"),
                    "filename": new_filename,
                    "promoted_from": filename,
                    "project": project_key,
                }
            )
        except OSError as exc:
            return f"❌ Error writing global memory file: {exc}"

    return (
        f"✅ Memory promoted to global tier.\n"
        f"  Local file: {filename} (preserved)\n"
        f"  Global file: {new_filename}\n"
        f"  Global path: {new_path}\n"
        f"  Type: {local_type} → {mapped_type}\n"
        f"  Name: {local_name}\n"
        f"  Tags: {', '.join(merged_tags)}"
    )


@mcp.tool()
def memory_global_search(
    query: str,
    types: str = "",
    tags: str = "",
    limit: int = 10,
) -> str:
    """Search across all global memory files.

    Args:
        query: Search keywords (case-insensitive). Matches against name, description, and body.
        types: Optional comma-separated list of global types to filter (preference, pattern, convention).
        tags: Optional comma-separated tags to filter by. Memories must contain ALL specified tags.
        limit: Maximum number of results to return (default 10).

    Returns:
        Formatted list of matching global memories.
    """
    query = query.strip()
    if not query:
        return "❌ Error: Search query cannot be empty."

    # W-12: Input size limits
    err = _validate_input_size(query, "query", MAX_QUERY_BYTES)
    if err:
        return err

    gdir = _global_memories_dir()
    _ensure_service_registered()
    _migrate_global_memories_once()
    return _unified_search(
        gdir, query, types, tags, limit, GLOBAL_MEMORY_TYPES,
        tier_qualifier="global ",
        skip_if_expired=True,
        track_access=True,
    )


@mcp.tool()
def memory_global_list(
    type: str = "",
    tags: str = "",
    sort_by: str = "recent",
) -> str:
    """List all global memories.

    Args:
        type: Optional global type filter (preference, pattern, convention).
        tags: Optional comma-separated tags to filter by.
        sort_by: Sort order — 'recent' (default), 'type', or 'name'.

    Returns:
        Formatted list of global memories with staleness annotations.
    """
    gdir = _global_memories_dir()
    _ensure_service_registered()
    _migrate_global_memories_once()
    return _unified_list(
        gdir, type, tags, sort_by, GLOBAL_MEMORY_TYPES,
        tier_qualifier="global ", list_emoji="🌐",
        skip_if_expired=True,
        track_access=True,
    )


@mcp.tool()
def memory_global_read(
    filename: str,
) -> str:
    """Read a specific global memory file by filename.

    Args:
        filename: The .md filename (e.g., "my-memory-abc12.md").

    Returns:
        Full file content including YAML frontmatter.
    """
    gdir = _global_memories_dir()
    _ensure_service_registered()
    _migrate_global_memories_once()
    return _unified_read(
        gdir, filename, tier_qualifier="global ",
        skip_if_expired=True,
        track_access=True,
    )


@mcp.tool()
def memory_global_delete(filename: str) -> str:
    """Delete a global memory file and update the global MEMORY.md index.

    Args:
        filename: The .md filename to delete (e.g., "my-memory-abc12.md").

    Returns:
        Confirmation message.
    """
    gdir = _global_memories_dir()
    _ensure_service_registered()
    _migrate_global_memories_once()
    with _global_lock():
        result = _unified_delete(gdir, filename, _write_global_index, tier_qualifier="global ")
    _append_merge_log(
        {
            "event": "delete",
            "service": GLOBAL_SERVICE_NAME,
            "filename": filename,
        }
    )
    return result


@mcp.tool()
def memory_global_update(
    filename: str,
    content: str = "",
    name: str = "",
    description: str = "",
    tags: str = "",
) -> str:
    """Update an existing global memory file in-place.

    Preserves the original created timestamp and updates the updated timestamp.
    Only specified (non-empty) fields are changed; omitted fields are preserved.
    Pass "__CLEAR__" as the value to explicitly clear a field.

    Args:
        filename: The .md filename to update (e.g., "my-memory-abc12.md").
        content: New body content (Markdown). If omitted, body is unchanged.
                 Use "__CLEAR__" to clear the body.
        name: New display name. If omitted, name is unchanged.
              Use "__CLEAR__" to clear.
        description: New one-line summary. If omitted, description is unchanged.
                     Use "__CLEAR__" to clear.
        tags: New comma-separated tags (replaces existing tags). If omitted, tags are unchanged.
              Use "__CLEAR__" to remove all tags.

    Returns:
        Confirmation message with updated fields.
    """
    gdir = _global_memories_dir()
    _ensure_service_registered()
    _migrate_global_memories_once()
    # W-12: Input size limits
    if content:
        err = _validate_input_size(content, "content", MAX_CONTENT_BYTES)
        if err:
            return err
    # Secret scan (§11) — refuse updates introducing obvious secrets.
    if content and content != "__CLEAR__":
        has_secret, reason = _contains_potential_secret(content)
        if has_secret:
            return (
                "❌ Error: Update rejected — potential secret detected in content "
                f"({reason}). Credentials MUST NOT be stored in global memory. "
                "Use the 'credential_ref' type to record credential locations instead."
            )
    with _global_lock():
        result = _unified_update(
            gdir, filename, content, name, description, tags,
            _write_global_index, tier_qualifier="global ",
        )
        # Refresh content_hash / standard fields after update.
        file_path = gdir / filename
        if file_path.exists():
            try:
                text = file_path.read_text(encoding="utf-8")
                fm, body = _parse_memory_file(text)
                new_fm, changed = _ensure_standard_global_fm(fm, body)
                if changed:
                    _atomic_write(
                        file_path,
                        _serialize_memory(new_fm, body),
                        perms=GLOBAL_FILE_MODE,
                    )
            except (OSError, UnicodeDecodeError):
                pass
    _append_merge_log(
        {
            "event": "update",
            "service": GLOBAL_SERVICE_NAME,
            "filename": filename,
        }
    )
    return result


@mcp.tool()
def memory_global_audit(
    json_output: bool = False,
    max_issues: int = 50,
) -> str | dict[str, Any]:
    """Audit global memory quality without rewriting memory files.

    Checks Global Memory Standard frontmatter, content hashes, obvious secret
    leaks, duplicate content hashes, stale/missing index references, and optional
    `retrieval_queries` fixtures that prove important memories remain
    discoverable.

    Args:
        json_output: Return a structured dict instead of compact text.
        max_issues: Maximum number of issues to include in the response.

    Returns:
        PASS/WARN/FAIL audit summary as text or a structured dictionary.
    """
    gdir = _global_memories_dir()
    result = _global_audit_result(gdir, max_issues=max_issues)
    if json_output:
        return result
    return _format_global_audit(result)


# ---------------------------------------------------------------------------
# MCP Tools — Session memory tier
# ---------------------------------------------------------------------------


@mcp.tool()
def memory_session_save(
    name: str,
    content: str,
    type: str = "context",
    description: str = "",
    tags: str = "",
    session_id: str = "",
) -> str:
    """Save a memory to the current session's memory store.

    Session memories preserve full context snapshots that survive context compression.
    Use for: conversation turns, decision context, intermediate artifacts.

    Args:
        name: Short title for the memory.
        content: The body content (Markdown).
        type: Memory type — one of: context, summary, artifact. Default: context.
        description: Optional one-line summary. If omitted, first line of content is used.
        tags: Optional comma-separated tags.
        session_id: Optional session ID override. Auto-detected from COPILOT_SESSION_ID if omitted.

    Returns:
        Confirmation message with the saved file path.
    """
    # Pass raw session_id — let _session_memories_dir handle auto-detection (W-3)
    raw_sid = session_id.strip() if session_id.strip() else None
    if raw_sid is None and _detect_session_id() is None:
        return _no_active_session_error()

    # Validate type
    mem_type = type.strip().lower()
    if mem_type not in SESSION_MEMORY_TYPES:
        return (
            f"❌ Error: Invalid session memory type '{type}'. "
            f"Must be one of: {', '.join(SESSION_MEMORY_TYPES)}"
        )

    name = name.strip()
    if not name:
        return "❌ Error: Memory name cannot be empty."

    content = content.strip()
    if not content:
        return "❌ Error: Memory content cannot be empty."

    # W-12: Input size limits
    err = _validate_input_size(name, "name", MAX_NAME_BYTES)
    if err:
        return err
    err = _validate_input_size(content, "content", MAX_CONTENT_BYTES)
    if err:
        return err

    # Auto-generate description from first line if not provided
    if not description.strip():
        first_line = content.split("\n", 1)[0].strip()
        # Strip markdown heading markers
        first_line = re.sub(r"^#+\s*", "", first_line)
        description = first_line[:120]

    # Parse tags
    parsed_tags = _parse_tags(tags) if tags.strip() else None

    sdir = _session_memories_dir(raw_sid)
    if sdir is None:
        return "❌ Error: Could not resolve session memory directory."

    filename = _generate_filename(name)
    file_path = sdir / filename

    # Derive resolved session ID for metadata/display
    resolved_sid = raw_sid or _detect_session_id()
    frontmatter = _build_frontmatter(name, description.strip(), mem_type, tags=parsed_tags)
    # Include session_id in frontmatter for traceability
    frontmatter["session_id"] = resolved_sid
    file_content = _serialize_memory(frontmatter, content)

    with _file_lock:
        try:
            _atomic_write(file_path, file_content)
            _write_session_index(raw_sid)
        except OSError as exc:
            return f"❌ Error writing session memory file: {exc}"

    return (
        f"📎 Session memory saved successfully.\n"
        f"  File: {filename}\n"
        f"  Path: {file_path}\n"
        f"  Type: {mem_type}\n"
        f"  Name: {name}\n"
        f"  Session: {resolved_sid}"
    )


@mcp.tool()
def memory_session_search(
    query: str,
    types: str = "",
    tags: str = "",
    limit: int = 10,
    session_id: str = "",
) -> str:
    """Search across session memories for the current session.

    Args:
        query: Search keywords (case-insensitive).
        types: Optional comma-separated types to filter (context, summary, artifact).
        tags: Optional comma-separated tags to filter by.
        limit: Maximum results (default 10).
        session_id: Optional session ID override.

    Returns:
        Formatted list of matching session memories.
    """
    query = query.strip()
    if not query:
        return "❌ Error: Search query cannot be empty."

    # W-12: Input size limits
    err = _validate_input_size(query, "query", MAX_QUERY_BYTES)
    if err:
        return err

    # Pass raw session_id — let _session_memories_dir handle auto-detection (W-3)
    raw_sid = session_id.strip() if session_id.strip() else None

    sdir = _session_memories_dir(raw_sid)
    if sdir is None:
        return _no_active_session_error()

    return _unified_search(
        sdir, query, types, tags, limit, SESSION_MEMORY_TYPES,
        tier_qualifier="session ", search_emoji="📎",
        track_access=True,
    )


@mcp.tool()
def memory_session_list(
    type: str = "",
    tags: str = "",
    sort_by: str = "recent",
    session_id: str = "",
) -> str:
    """List all memories for the current session.

    Args:
        type: Optional type filter (context, summary, artifact).
        tags: Optional comma-separated tags to filter by.
        sort_by: Sort order — 'recent' (default), 'type', or 'name'.
        session_id: Optional session ID override.

    Returns:
        Formatted list of session memories.
    """
    # Pass raw session_id — let _session_memories_dir handle auto-detection (W-3)
    raw_sid = session_id.strip() if session_id.strip() else None

    sdir = _session_memories_dir(raw_sid)
    if sdir is None:
        return _no_active_session_error()

    return _unified_list(
        sdir, type, tags, sort_by, SESSION_MEMORY_TYPES,
        tier_qualifier="session ", list_emoji="📎",
        track_access=True,
    )


@mcp.tool()
def memory_session_read(
    filename: str,
    session_id: str = "",
) -> str:
    """Read a specific session memory file.

    Args:
        filename: The .md filename (e.g., "my-memory-abc12.md").
        session_id: Optional session ID override.

    Returns:
        Full file content including YAML frontmatter.
    """
    # Pass raw session_id — let _session_memories_dir handle auto-detection (W-3)
    raw_sid = session_id.strip() if session_id.strip() else None

    sdir = _session_memories_dir(raw_sid)
    if sdir is None:
        return _no_active_session_error()

    return _unified_read(sdir, filename, tier_qualifier="session ", track_access=True)


@mcp.tool()
def memory_session_delete(
    filename: str,
    session_id: str = "",
) -> str:
    """Delete a session memory file and update the session MEMORY.md index.

    Args:
        filename: The .md filename to delete (e.g., "my-memory-abc12.md").
        session_id: Optional session ID override. Auto-detected from COPILOT_SESSION_ID if omitted.

    Returns:
        Confirmation message.
    """
    # Pass raw session_id — let _session_memories_dir handle auto-detection (W-3)
    raw_sid = session_id.strip() if session_id.strip() else None

    sdir = _session_memories_dir(raw_sid)
    if sdir is None:
        return _no_active_session_error()

    return _unified_delete(sdir, filename, lambda: _write_session_index(raw_sid), tier_qualifier="session ")


@mcp.tool()
def memory_session_update(
    filename: str,
    content: str = "",
    name: str = "",
    description: str = "",
    tags: str = "",
    session_id: str = "",
) -> str:
    """Update an existing session memory file in-place.

    Preserves the original created timestamp and updates the updated timestamp.
    Only specified (non-empty) fields are changed; omitted fields are preserved.
    Pass "__CLEAR__" as the value to explicitly clear a field.

    Args:
        filename: The .md filename to update (e.g., "my-memory-abc12.md").
        content: New body content (Markdown). If omitted, body is unchanged.
                 Use "__CLEAR__" to clear the body.
        name: New display name. If omitted, name is unchanged.
              Use "__CLEAR__" to clear.
        description: New one-line summary. If omitted, description is unchanged.
                     Use "__CLEAR__" to clear.
        tags: New comma-separated tags (replaces existing tags). If omitted, tags are unchanged.
              Use "__CLEAR__" to remove all tags.
        session_id: Optional session ID override. Auto-detected from COPILOT_SESSION_ID if omitted.

    Returns:
        Confirmation message with updated fields.
    """
    # Pass raw session_id — let _session_memories_dir handle auto-detection (W-3)
    raw_sid = session_id.strip() if session_id.strip() else None

    sdir = _session_memories_dir(raw_sid)
    if sdir is None:
        return _no_active_session_error()

    # W-12: Input size limits
    if content:
        err = _validate_input_size(content, "content", MAX_CONTENT_BYTES)
        if err:
            return err
    return _unified_update(
        sdir, filename, content, name, description, tags,
        lambda: _write_session_index(raw_sid), tier_qualifier="session ",
    )


@mcp.tool()
def memory_session_promote(
    filename: str,
    session_id: str = "",
    project_type: str = "",
    project_tags: str = "",
    force: bool = False,
) -> str:
    """Promote a session memory to the project memory tier.

    Copies completed work, lessons, and established patterns from the session
    to the project tier. Blocks transient/debug/abandoned content by default.

    Args:
        filename: The session .md filename to promote (e.g., "my-memory-abc12.md").
        session_id: Optional session ID override. Auto-detected if omitted.
        project_type: Override the project type. If omitted, auto-mapped from session type.
                      Must be one of: user, feedback, project, reference.
        project_tags: Additional comma-separated tags for the project copy.
        force: If true, bypass eligibility checks (blocked tags, missing eligible tags).

    Returns:
        Confirmation with the project file path, or rejection with reason.
    """
    filename = filename.strip()
    if not filename:
        return "❌ Error: Filename cannot be empty."

    if "/" in filename or "\\" in filename or ".." in filename:
        return "❌ Error: Invalid filename. Must be a plain filename, not a path."

    raw_sid = session_id.strip() if session_id.strip() else None
    sdir = _session_memories_dir(raw_sid)
    if sdir is None:
        return _no_active_session_error()

    file_path = sdir / filename
    if not file_path.is_file():
        return f"❌ Error: Session memory file '{filename}' not found."

    try:
        text = file_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return f"❌ Error reading file: {exc}"

    fm, body = _parse_memory_file(text)
    if not fm:
        return f"❌ Error: File '{filename}' has no valid frontmatter."

    session_type = fm.get("type", "unknown")
    existing_tags = {str(t).lower() for t in _normalize_tags(fm.get("tags"))}

    # --- Eligibility checks (unless force=True) ---
    if not force:
        blocked = existing_tags & SESSION_PROMOTE_BLOCKED_TAGS
        if blocked:
            return (
                f"❌ Promotion blocked: memory has tags indicating transient content: "
                f"{', '.join(sorted(blocked))}.\n"
                f"  These memories are not suitable for project-level persistence.\n"
                f"  Use force=true to override."
            )

    has_eligible_tag = bool(existing_tags & SESSION_PROMOTE_ELIGIBLE_TAGS)
    promotable_field = fm.get("promotable", None)

    warning = ""
    if not force and not has_eligible_tag and promotable_field is not True:
        warning = (
            "⚠️ Note: This memory has no promotion-eligible tags "
            f"({', '.join(sorted(SESSION_PROMOTE_ELIGIBLE_TAGS)[:5])}, ...) "
            "and no 'promotable: true' field. Proceeding anyway.\n"
        )

    # --- Type mapping ---
    if project_type.strip():
        mapped_type = project_type.strip().lower()
        if mapped_type not in MEMORY_TYPES:
            return (
                f"❌ Error: Invalid project type '{project_type}'. "
                f"Must be one of: {', '.join(MEMORY_TYPES)}"
            )
    else:
        mapped_type = SESSION_PROMOTE_TYPE_MAP.get(session_type)
        if not mapped_type:
            return (
                f"❌ Error: Cannot auto-map session type '{session_type}' to project type. "
                f"Provide an explicit project_type (one of: user, feedback, project, reference)."
            )

    # --- Build promoted memory ---
    resolved_sid = raw_sid or _detect_session_id() or "unknown"

    existing_tags_list = [str(t).lower() for t in _normalize_tags(fm.get("tags"))]
    additional_tags = _parse_tags(project_tags) if project_tags.strip() else []
    merged_tags = list(
        dict.fromkeys(
            existing_tags_list + additional_tags + ["promoted", f"from_session:{resolved_sid}"]
        )
    )

    local_name = fm.get("name", filename)
    local_description = fm.get("description", "")

    new_fm = _build_frontmatter(
        name=local_name,
        description=local_description,
        mem_type=mapped_type,
        tags=merged_tags,
    )
    new_fm["promoted_from"] = {
        "session": resolved_sid,
        "original_file": filename,
        "promoted_at": _now_iso(),
    }

    new_filename = _generate_filename(local_name)
    new_content = _serialize_memory(new_fm, body)

    project_path = _project_dir()
    new_path = project_path / new_filename

    with _file_lock:
        try:
            _atomic_write(new_path, new_content)
            _write_index(project_path)
        except OSError as exc:
            return f"❌ Error writing project memory file: {exc}"

    result = (
        f"✅ Session memory promoted to project tier.\n"
        f"  Session file: {filename} (preserved)\n"
        f"  Project file: {new_filename}\n"
        f"  Project path: {new_path}\n"
        f"  Type: {session_type} → {mapped_type}\n"
        f"  Name: {local_name}\n"
        f"  Tags: {', '.join(merged_tags)}\n"
        f"  Session: {resolved_sid}"
    )
    if warning:
        result = warning + result
    return result


# ---------------------------------------------------------------------------
# MCP Tools — memory-v2.5 platform/audit/cleanup management
# ---------------------------------------------------------------------------


def _memory_platform_context() -> dict[str, Any]:
    """Return the resolved platform-neutral context without writing files."""
    detected_session_id = _detect_session_id()
    detected_session_dir = _detect_session_dir()
    return {
        "schema_version": MEMORY_SCHEMA_VERSION,
        "platform": _detect_platform(),
        "service": GLOBAL_SERVICE_NAME,
        "memory_root": str(_memory_root_dir()),
        "project_memory_base": str(_memory_base_dir()),
        "global_memory_base": str(_memory_root_dir() / "global-memory"),
        "session_state_base": str(_session_state_base_dir()),
        "detected_session_id": detected_session_id,
        "detected_session_dir": detected_session_dir,
        "session_env_order": list(PLATFORM_SESSION_ID_ENV_ORDER),
        "session_dir_env_order": list(PLATFORM_SESSION_DIR_ENV_ORDER),
    }


def _tier_dirs_for_request(tier: str) -> list[tuple[str, Path | None, str]]:
    """Resolve requested memory tier(s) to directories.

    Returns tuples of (tier_name, path_or_none, status). status is "ok" or a
    short warning/error string; callers must remain read-only when inspecting.
    """
    tier_norm = (tier or "all").strip().lower()
    if tier_norm not in {"all", "session", "project", "global"}:
        return [(tier_norm, None, "unknown-tier")]
    tiers = ["session", "project", "global"] if tier_norm == "all" else [tier_norm]
    result: list[tuple[str, Path | None, str]] = []
    for t in tiers:
        if t == "session":
            sdir = _session_memories_dir_readonly()
            if sdir is None:
                result.append((t, None, "no-active-session"))
            else:
                result.append((t, sdir, "ok"))
        elif t == "project":
            result.append((t, _project_dir_readonly(), "ok"))
        elif t == "global":
            result.append((t, _global_memories_dir_readonly(), "ok"))
    return result


def _memory_files_for_dir(memory_dir: Path) -> list[Path]:
    """Return real memory files, excluding indexes and sidecar metadata."""
    return sorted(
        p for p in memory_dir.glob("*.md")
        if p.name not in {INDEX_FILENAME, GLOBAL_INDEX_FILENAME}
    )


def _audit_memory_dir(tier: str, memory_dir: Path | None, status: str) -> dict[str, Any]:
    """Build a compact read-only audit record for one tier."""
    if memory_dir is None:
        return {
            "tier": tier,
            "status": "WARN",
            "path": None,
            "files": 0,
            "issues": [{"severity": "WARN", "code": status, "message": status}],
        }
    files = _memory_files_for_dir(memory_dir)
    issues: list[dict[str, str]] = []
    for path in files:
        try:
            fm, body = _parse_memory_file(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError) as exc:
            issues.append({
                "severity": "FAIL",
                "code": "read-error",
                "filename": path.name,
                "message": str(exc),
            })
            continue
        if not fm:
            issues.append({
                "severity": "FAIL",
                "code": "missing-frontmatter",
                "filename": path.name,
                "message": "memory file has no valid YAML frontmatter",
            })
            continue
        if not fm.get("memory_schema_version"):
            issues.append({
                "severity": "WARN",
                "code": "missing-schema-version",
                "filename": path.name,
                "message": "frontmatter lacks memory_schema_version for v3 migration readiness",
            })
        if not fm.get("platform"):
            issues.append({
                "severity": "WARN",
                "code": "missing-platform",
                "filename": path.name,
                "message": "frontmatter lacks platform metadata",
            })
        has_secret, reason = _contains_potential_secret(body)
        if has_secret:
            issues.append({
                "severity": "FAIL",
                "code": "potential-secret",
                "filename": path.name,
                "message": reason,
            })
    status_out = "FAIL" if any(i["severity"] == "FAIL" for i in issues) else (
        "WARN" if issues else "PASS"
    )
    access_log = _access_log_path(memory_dir)
    return {
        "tier": tier,
        "status": status_out,
        "path": str(memory_dir),
        "files": len(files),
        "index_exists": (memory_dir / INDEX_FILENAME).exists()
        or (memory_dir / GLOBAL_INDEX_FILENAME).exists(),
        "access_log_bytes": access_log.stat().st_size if access_log.exists() else 0,
        "issues": issues,
    }


def _format_tier_audit(result: dict[str, Any]) -> str:
    lines = [
        f"{result['status']}: memory tier audit",
        f"  Schema: {result['context']['schema_version']}",
        f"  Platform: {result['context']['platform']}",
        f"  Memory root: {result['context']['memory_root']}",
    ]
    for tier in result["tiers"]:
        lines.append(
            f"- {tier['status']} {tier['tier']}: files={tier['files']} "
            f"path={tier.get('path') or '<unavailable>'}"
        )
        for issue in tier.get("issues", [])[:5]:
            filename = issue.get("filename", "-")
            lines.append(
                f"  - {issue['severity']} [{issue['code']}] {filename}: {issue['message']}"
            )
        if len(tier.get("issues", [])) > 5:
            lines.append("  - WARN [truncated] Additional issues omitted.")
    return _truncate_output("\n".join(lines))


@mcp.tool()
def memory_platform_context(json_output: bool = False) -> str | dict[str, Any]:
    """Inspect the resolved memory-v2.5 platform/root/session context.

    Args:
        json_output: Return a structured dict instead of compact text.

    Returns:
        Platform-neutral memory root/session resolution context.
    """
    ctx = _memory_platform_context()
    if json_output:
        return ctx
    lines = [
        "memory-v2.5 platform context",
        f"  schema_version: {ctx['schema_version']}",
        f"  platform: {ctx['platform']}",
        f"  service: {ctx['service']}",
        f"  memory_root: {ctx['memory_root']}",
        f"  detected_session_id: {ctx['detected_session_id'] or '<none>'}",
    ]
    return "\n".join(lines)


@mcp.tool()
def memory_tier_audit(
    tier: str = "all",
    json_output: bool = False,
) -> str | dict[str, Any]:
    """Audit session/project/global tiers for memory-v3 readiness.

    This is read-only with respect to memory files: it surfaces schema,
    platform metadata, frontmatter, secret-scan, index, and access-log status.

    Args:
        tier: "all" | "session" | "project" | "global".
        json_output: Return a structured dict instead of compact text.
    """
    tiers = [
        _audit_memory_dir(tier_name, memory_dir, status)
        for tier_name, memory_dir, status in _tier_dirs_for_request(tier)
    ]
    status = "FAIL" if any(t["status"] == "FAIL" for t in tiers) else (
        "WARN" if any(t["status"] == "WARN" for t in tiers) else "PASS"
    )
    result = {
        "status": status,
        "context": _memory_platform_context(),
        "tiers": tiers,
    }
    if json_output:
        return result
    return _format_tier_audit(result)


@mcp.tool()
def memory_cleanup_candidates(
    tier: str = "all",
    stale_days: int = 30,
    limit: int = 50,
) -> dict[str, Any]:
    """Return read-only cleanup/management candidates without mutating memory.

    Candidates include stale entries, missing v2.5 schema/platform metadata,
    blocked transient tags, duplicate content hashes, and malformed files.
    The caller decides whether to archive, update, compact, or delete later.
    """
    stale_days = max(1, min(int(stale_days or 30), 3650))
    limit = max(1, min(int(limit or 50), 500))
    candidates: list[dict[str, Any]] = []
    seen_hashes: dict[str, tuple[str, str]] = {}
    now = datetime.now(timezone.utc)
    blocked_tags = set(PROMOTE_BLOCKED_TAGS) | set(SESSION_PROMOTE_BLOCKED_TAGS)

    for tier_name, memory_dir, status in _tier_dirs_for_request(tier):
        if memory_dir is None:
            candidates.append({
                "tier": tier_name,
                "filename": None,
                "reason": status,
                "suggested_action": "inspect-session-context",
            })
            continue
        for path in _memory_files_for_dir(memory_dir):
            try:
                fm, body = _parse_memory_file(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError) as exc:
                candidates.append({
                    "tier": tier_name,
                    "filename": path.name,
                    "reason": f"read error: {exc}",
                    "suggested_action": "manual-review",
                })
                continue
            if not fm:
                candidates.append({
                    "tier": tier_name,
                    "filename": path.name,
                    "reason": "missing frontmatter",
                    "suggested_action": "repair-or-archive",
                })
                continue
            if not fm.get("memory_schema_version") or not fm.get("platform"):
                candidates.append({
                    "tier": tier_name,
                    "filename": path.name,
                    "reason": "missing memory-v2.5 schema/platform metadata",
                    "suggested_action": "metadata-upgrade",
                })
            tags = {str(t).lower() for t in _normalize_tags(fm.get("tags"))}
            blocked = sorted(tags & blocked_tags)
            if blocked:
                candidates.append({
                    "tier": tier_name,
                    "filename": path.name,
                    "reason": "blocked/transient tags: " + ", ".join(blocked),
                    "suggested_action": "archive-or-delete-after-review",
                })
            updated = fm.get("updated") or fm.get("created")
            if isinstance(updated, str):
                try:
                    dt = datetime.fromisoformat(updated)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                    age_days = (now - dt).days
                    if age_days >= stale_days:
                        candidates.append({
                            "tier": tier_name,
                            "filename": path.name,
                            "reason": f"stale for {age_days} days",
                            "suggested_action": "refresh-or-archive",
                        })
                except ValueError:
                    pass
            content_hash = fm.get("content_hash") or _compute_content_hash(body)
            if content_hash in seen_hashes:
                prior_tier, prior_file = seen_hashes[content_hash]
                candidates.append({
                    "tier": tier_name,
                    "filename": path.name,
                    "reason": f"duplicate content hash with {prior_tier}/{prior_file}",
                    "suggested_action": "merge-duplicate",
                })
            else:
                seen_hashes[content_hash] = (tier_name, path.name)
            if len(candidates) >= limit:
                return {
                    "status": "WARN",
                    "truncated": True,
                    "limit": limit,
                    "context": _memory_platform_context(),
                    "candidates": candidates[:limit],
                }

    return {
        "status": "PASS" if not candidates else "WARN",
        "truncated": False,
        "limit": limit,
        "context": _memory_platform_context(),
        "candidates": candidates[:limit],
    }


# ---------------------------------------------------------------------------
# Admin — sidecar access-log compaction (WU-P1-3)
# ---------------------------------------------------------------------------


@mcp.tool()
def memory_compact_access_log(tier: str) -> dict:
    """Explicitly compact the sidecar access log for a tier.

    Rolls the append-only .access.jsonl records into each memory file's
    `access_count` / `last_accessed` frontmatter fields and truncates the log.
    Safe to run concurrently with appends — snapshot via atomic rename.

    Args:
        tier: "session" | "project" | "global".

    Returns:
        {"records": int, "files_updated": int, "errors": int,
         "disabled": bool, "tier": str, ...}.
        `disabled=True` when MEMORY_V2_DISABLE_ACCESS_LOG=1 is set.
    """
    tier_norm = (tier or "").strip().lower()
    if tier_norm == "global":
        memory_dir: Path | None = _global_memories_dir()
    elif tier_norm == "project":
        memory_dir = _project_dir()
    elif tier_norm == "session":
        memory_dir = _session_memories_dir()
        if memory_dir is None:
            return {
                "records": 0,
                "files_updated": 0,
                "errors": 1,
                "disabled": False,
                "tier": tier_norm,
                "error": "no active session detected",
            }
    else:
        return {
            "records": 0,
            "files_updated": 0,
            "errors": 1,
            "disabled": False,
            "tier": tier_norm,
            "error": f"unknown tier: {tier!r} (expected session|project|global)",
        }

    result = _compact_access_log(memory_dir)
    result["tier"] = tier_norm
    return result


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    mcp.run()
