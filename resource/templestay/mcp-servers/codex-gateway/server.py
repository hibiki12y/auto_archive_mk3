#!/usr/bin/env python3
"""Codex Gateway MCP Server — isolated Codex CLI proxy and apply bridge.

Slim port of ``resource/templerun/copilot/mcp-servers/codex-gateway/server.py``
for templestay. Exposes three MCP tools:

* ``codex_preflight`` — lightweight local readiness check for routing decisions
* ``codex_prompt``    — read-only Codex prompt proxy in a neutral scratch cwd
* ``codex_apply``     — write-capable apply bridge: detached worktree at
  ``expected_head`` → Codex executes inside the disposable tree → diff is
  validated against ``allowed_paths`` → primary repo is re-checked under a
  per-repo lock → patch is applied back

Multi-vendor / council / RULERS / Ultra-Team semantics from the original are
intentionally dropped. The single-purpose contract here is: Claude Opus
orchestrator delegates code authoring to a Codex leaf via this gateway.

Run with::

    python3 server.py          # stdio transport (default)
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

logger = logging.getLogger("codex-gateway-mcp")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_PROMPT_SIZE = 200_000
DEFAULT_TIMEOUT = 300
REPO_FALLBACK_MODEL = "gpt-5.5"
SANDBOX_READ_ONLY = "read-only"
SANDBOX_WORKSPACE_WRITE = "workspace-write"

FAILURE_STAGE_REQUEST_VALIDATION = "request_validation"
FAILURE_STAGE_PRIMARY_PRECHECK = "primary_precheck"
FAILURE_STAGE_WORKTREE_PREPARE = "worktree_prepare"
FAILURE_STAGE_CODEX_EXECUTION = "codex_execution"
FAILURE_STAGE_DIFF_VALIDATION = "diff_validation"
FAILURE_STAGE_APPLY_RECHECK = "apply_recheck"
FAILURE_STAGE_APPLY_BACK = "apply_back"
FAILURE_STAGE_CLEANUP = "cleanup"

# Codex CLI drops its own session sentinels into the working directory (a
# zero-byte ``.codex`` marker, sometimes a ``.codex/`` directory). They are not
# part of the work product and must never count against ``allowed_paths``.
# Filter them at intent-to-add time so they never enter the validated diff or
# the apply patch; the worktree itself is wiped by cleanup regardless.
_EPHEMERAL_CODEX_TOPLEVEL = (".codex",)

CLEANUP_STATUS_CLEAN = "clean"
CLEANUP_STATUS_CLEANUP_FAILED = "cleanup_failed"
CLEANUP_STATUS_NOT_CREATED = "not_created"

_GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_UNRESOLVED_INTERPOLATION_RE = re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*\}$")
_RAW_STATUS_RE = re.compile(r"^[A-Z]+")

_APPLY_LOCKS: dict[str, threading.Lock] = {}
_APPLY_LOCKS_GUARD = threading.Lock()


class ErrorCategory:
    REPO_CONFIG = "repo_config_error"
    LOCAL_CLI = "local_cli_runtime_error"
    REQUEST = "request_error"
    TIMEOUT = "invocation_timeout"
    EXTERNAL_AUTH = "external_auth_error"
    EXTERNAL_NETWORK = "external_network_error"
    EXTERNAL_SERVICE = "external_service_error"
    EXTERNAL_ACCOUNT_MODEL_PLAN = "external_account_model_plan_error"
    EXTERNAL_MODEL_AVAILABILITY = "external_model_availability_error"
    SANDBOX_EXECUTION = "sandbox_execution_error"
    REPO_STATE = "repo_state_error"
    DIFF_VALIDATION = "diff_validation_error"
    APPLY_CONFLICT = "apply_conflict_error"
    CLEANUP = "cleanup_error"
    UNDETERMINED = "undetermined_origin"


class RoutingStatus:
    READY = "ready"
    ROUTED = "routed"
    DEGRADED = "degraded"


class CodexApplyFailure(RuntimeError):
    def __init__(self, stage: str, message: str, category: str) -> None:
        super().__init__(message)
        self.stage = stage
        self.category = category


# ---------------------------------------------------------------------------
# Configuration resolution
# ---------------------------------------------------------------------------


def _sanitize_configured_model(raw: str | None) -> str:
    if not isinstance(raw, str):
        return ""
    value = raw.strip()
    if not value:
        return ""
    if _UNRESOLVED_INTERPOLATION_RE.match(value):
        logger.warning(
            "CODEX_DEFAULT_MODEL received unresolved placeholder %r; falling back",
            value,
        )
        return ""
    return value


CONFIGURED_DEFAULT_MODEL = _sanitize_configured_model(
    os.environ.get("CODEX_DEFAULT_MODEL")
)
DEFAULT_MODEL = CONFIGURED_DEFAULT_MODEL or REPO_FALLBACK_MODEL
DEFAULT_MODEL_SOURCE = "runtime-config" if CONFIGURED_DEFAULT_MODEL else "repo-fallback"


def resolve_codex_bin_details() -> tuple[str, str]:
    env_bin = os.environ.get("CODEX_BIN", "").strip()
    if env_bin and _UNRESOLVED_INTERPOLATION_RE.match(env_bin):
        logger.warning(
            "CODEX_BIN received unresolved placeholder %r; falling back to PATH lookup",
            env_bin,
        )
        env_bin = ""
    if env_bin:
        if os.path.sep in env_bin or (os.path.altsep and os.path.altsep in env_bin):
            return env_bin, "env"
        return shutil.which(env_bin) or env_bin, "env"
    which_bin = shutil.which("codex")
    if which_bin:
        return which_bin, "path"
    return "/usr/local/bin/codex", "repo-fallback"


CODEX_BIN, CODEX_BIN_SOURCE = resolve_codex_bin_details()


def resolve_default_model(model: str | None) -> tuple[str, str]:
    explicit = model.strip() if isinstance(model, str) else ""
    if explicit:
        return explicit, "explicit-request"
    if CONFIGURED_DEFAULT_MODEL:
        return CONFIGURED_DEFAULT_MODEL, "runtime-config"
    return REPO_FALLBACK_MODEL, "repo-fallback"


def check_codex_cli_ready() -> tuple[bool, str | None, str | None]:
    if not CODEX_BIN:
        return False, ErrorCategory.REPO_CONFIG, "Resolved Codex CLI path is empty"
    if not os.path.exists(CODEX_BIN):
        return False, ErrorCategory.LOCAL_CLI, f"Codex CLI not found at {CODEX_BIN}"
    if not os.access(CODEX_BIN, os.X_OK):
        return False, ErrorCategory.LOCAL_CLI, f"Codex CLI is not executable at {CODEX_BIN}"
    return True, None, None


# ---------------------------------------------------------------------------
# Error envelope helpers
# ---------------------------------------------------------------------------


def _routing_observation(
    *, attempted: bool, failure_category: str | None = None, failure_message: str | None = None
) -> dict[str, Any]:
    return {
        "codex_route_attempted": attempted,
        "fallback_required": failure_category is not None,
        "failure_category": failure_category,
        "failure_message": failure_message,
    }


def _error_envelope(
    message: str,
    category: str = ErrorCategory.UNDETERMINED,
    *,
    attempted: bool = True,
) -> dict[str, Any]:
    return {
        "success": False,
        "response": None,
        "data": None,
        "parsed": False,
        "model": None,
        "tokens": None,
        "latency_ms": None,
        "warnings": None,
        "error": message,
        "error_category": category,
        "routing_status": RoutingStatus.DEGRADED,
        "routing_observation": _routing_observation(
            attempted=attempted, failure_category=category, failure_message=message
        ),
    }


def _classify_cli_exit(stderr: str) -> str | None:
    detail = stderr.lower()
    if any(t in detail for t in ("auth", "login", "unauth", "credential", "api key")):
        return ErrorCategory.EXTERNAL_AUTH
    if any(
        t in detail
        for t in ("network", "dns", "socket", "connection", "timed out", "timeout", "tls", "ssl")
    ):
        return ErrorCategory.EXTERNAL_NETWORK
    if any(
        t in detail
        for t in (
            "service unavailable",
            "unavailable",
            "internal error",
            "backend error",
            "rate limit",
            "quota",
            "resource exhausted",
            "overloaded",
            "503",
            "429",
        )
    ):
        return ErrorCategory.EXTERNAL_SERVICE
    if any(
        t in detail
        for t in (
            "entitlement",
            "not included in your plan",
            "for your plan",
            "subscription",
            "for your account",
            "account does not",
        )
    ):
        return ErrorCategory.EXTERNAL_ACCOUNT_MODEL_PLAN
    if any(t in detail for t in ("unsupported model", "not available for model")):
        return ErrorCategory.EXTERNAL_ACCOUNT_MODEL_PLAN
    if any(t in detail for t in ("model not found", "unknown model", "invalid model")):
        return ErrorCategory.EXTERNAL_MODEL_AVAILABILITY
    if any(t in detail for t in ("sandbox", "execution error", "container")):
        return ErrorCategory.SANDBOX_EXECUTION
    return None


# ---------------------------------------------------------------------------
# Codex CLI invocation
# ---------------------------------------------------------------------------


def _build_codex_command(
    prompt: str,
    *,
    cwd: str,
    sandbox: str,
    model: str | None,
    output_file: str,
) -> list[str]:
    """Build the canonical non-interactive Codex CLI command.

    Form::

        codex -a never exec --json --ephemeral --skip-git-repo-check \
              --ignore-rules -C <cwd> -s <sandbox> [-m <model>] \
              -o <output_file> "<prompt>"

    ``--skip-git-repo-check`` is required for ``codex_prompt`` (the scratch
    cwd has no .git) and harmless for ``codex_apply`` (the detached worktree
    is a valid git repo). ``--ignore-rules`` keeps Codex behavior independent
    of user/project execpolicy ``.rules`` files for predictability.
    """
    cmd = [
        CODEX_BIN,
        "-a", "never",
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-rules",
        "-C", cwd,
        "-s", sandbox,
    ]
    if model:
        cmd.extend(["-m", model])
    cmd.extend(["-o", output_file, prompt])
    return cmd


def _execute_codex(
    prompt: str,
    *,
    cwd: str,
    sandbox: str,
    model: str | None,
    timeout: int,
) -> tuple[subprocess.CompletedProcess[str] | None, int | None, str | None, dict[str, Any] | None]:
    """Execute Codex CLI; return (subprocess_result, elapsed_ms, output_text, error).

    ``output_text`` is the contents of the ``-o`` file (Codex's final message);
    JSONL events go to stdout and are returned via the subprocess result.
    """
    prompt_size = len(prompt.encode("utf-8"))
    if prompt_size > MAX_PROMPT_SIZE:
        return None, None, None, _error_envelope(
            f"Prompt too large ({prompt_size} bytes, max {MAX_PROMPT_SIZE})",
            category=ErrorCategory.REQUEST,
        )

    out_dir = tempfile.mkdtemp(prefix="codex-gateway-out-")
    output_file = os.path.join(out_dir, "last_message.txt")
    try:
        cmd = _build_codex_command(
            prompt, cwd=cwd, sandbox=sandbox, model=model, output_file=output_file
        )
        # Never log the prompt text directly: callers may pass secrets, paths,
        # or proprietary code through it, and ``logger.debug`` may surface in
        # CLI logs the user shares for support. Log a privacy-preserving
        # fingerprint (length + truncated sha256) plus the non-prompt argv so
        # operators can still confirm the canonical Codex invocation form.
        non_prompt_argv = cmd[:-1]
        prompt_fingerprint = (
            f"len={len(prompt)} sha256:{hashlib.sha256(prompt.encode('utf-8')).hexdigest()[:12]}"
        )
        logger.debug(
            "Executing: %s <prompt %s>",
            " ".join(non_prompt_argv),
            prompt_fingerprint,
        )
        start_ms = time.monotonic_ns() // 1_000_000

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=cwd,
                stdin=subprocess.DEVNULL,
            )
        except subprocess.TimeoutExpired:
            return None, None, None, _error_envelope(
                f"Codex timed out after {timeout}s using model {model or 'CLI default'}",
                category=ErrorCategory.TIMEOUT,
            )
        except FileNotFoundError:
            return None, None, None, _error_envelope(
                f"Codex CLI not found at {CODEX_BIN}", category=ErrorCategory.LOCAL_CLI
            )
        except OSError as exc:
            return None, None, None, _error_envelope(
                f"Failed to execute Codex CLI at {CODEX_BIN}: {exc}",
                category=ErrorCategory.LOCAL_CLI,
            )

        elapsed_ms = (time.monotonic_ns() // 1_000_000) - start_ms

        if result.returncode != 0:
            stderr = (result.stderr or "").strip() or "no stderr output"
            attribution = _classify_cli_exit(stderr) or ErrorCategory.UNDETERMINED
            return None, elapsed_ms, None, _error_envelope(
                f"Codex CLI exited with code {result.returncode} "
                f"using model {model or 'CLI default'}: {stderr}",
                category=attribution,
            )

        output_text = ""
        if os.path.exists(output_file):
            try:
                output_text = Path(output_file).read_text(encoding="utf-8", errors="replace")
            except OSError as exc:
                logger.warning("Failed reading Codex output file %s: %s", output_file, exc)

        return result, elapsed_ms, output_text, None
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


def _parse_jsonl_events(stdout: str) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    """Parse Codex's JSONL event stream; extract usage record if present."""
    events: list[dict[str, Any]] = []
    usage: dict[str, Any] | None = None
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        events.append(ev)
        if isinstance(ev, dict) and ev.get("type") in {"usage", "token_usage"}:
            usage = ev
        elif isinstance(ev, dict) and isinstance(ev.get("usage"), dict):
            usage = ev["usage"]
    return events, usage


# ---------------------------------------------------------------------------
# git / path helpers
# ---------------------------------------------------------------------------


def _elapsed_ms(start_ms: int) -> int:
    return (time.monotonic_ns() // 1_000_000) - start_ms


def _normalize_realpath(path: str) -> str:
    return os.path.realpath(path)


def _run_git(
    repo_root: str, args: list[str], *, input_text: str | None = None
) -> subprocess.CompletedProcess[str]:
    kw: dict[str, Any] = {
        "cwd": repo_root,
        "capture_output": True,
        "text": True,
        "check": False,
    }
    if input_text is None:
        kw["stdin"] = subprocess.DEVNULL
    else:
        kw["input"] = input_text
    return subprocess.run(["git", *args], **kw)


def _run_git_checked(
    repo_root: str,
    args: list[str],
    *,
    stage: str,
    category: str,
    input_text: str | None = None,
) -> str:
    result = _run_git(repo_root, args, input_text=input_text)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "git command failed").strip()
        raise CodexApplyFailure(
            stage, f"`git {' '.join(args)}` failed: {detail}", category
        )
    return result.stdout


def _resolve_canonical_repo_root(repo_root: str) -> str:
    if not isinstance(repo_root, str) or not repo_root:
        raise CodexApplyFailure(
            FAILURE_STAGE_REQUEST_VALIDATION, "`repo_root` is required", ErrorCategory.REQUEST
        )
    if not os.path.isabs(repo_root):
        raise CodexApplyFailure(
            FAILURE_STAGE_REQUEST_VALIDATION,
            "`repo_root` must be an absolute path",
            ErrorCategory.REQUEST,
        )
    canonical = _normalize_realpath(repo_root)
    if canonical != repo_root:
        raise CodexApplyFailure(
            FAILURE_STAGE_REQUEST_VALIDATION,
            "`repo_root` must be canonical (realpath)",
            ErrorCategory.REQUEST,
        )
    git_root = _run_git_checked(
        repo_root,
        ["rev-parse", "--show-toplevel"],
        stage=FAILURE_STAGE_REQUEST_VALIDATION,
        category=ErrorCategory.REQUEST,
    ).strip()
    if _normalize_realpath(git_root) != canonical:
        raise CodexApplyFailure(
            FAILURE_STAGE_REQUEST_VALIDATION,
            "`repo_root` must match the canonical git toplevel",
            ErrorCategory.REQUEST,
        )
    return canonical


def _validate_expected_head(expected_head: str) -> str:
    if not isinstance(expected_head, str) or not _GIT_SHA_RE.fullmatch(expected_head):
        raise CodexApplyFailure(
            FAILURE_STAGE_REQUEST_VALIDATION,
            "`expected_head` must be a 40-hex git commit id",
            ErrorCategory.REQUEST,
        )
    return expected_head


def _normalize_repo_relative_path(raw: str, *, allow_directory: bool) -> str:
    if not isinstance(raw, str):
        raise CodexApplyFailure(
            FAILURE_STAGE_REQUEST_VALIDATION,
            "`allowed_paths` entries must be strings",
            ErrorCategory.REQUEST,
        )
    value = raw.strip().replace("\\", "/")
    if not value:
        raise CodexApplyFailure(
            FAILURE_STAGE_REQUEST_VALIDATION,
            "`allowed_paths` entries must be non-empty",
            ErrorCategory.REQUEST,
        )
    if value.startswith("/"):
        raise CodexApplyFailure(
            FAILURE_STAGE_REQUEST_VALIDATION,
            "`allowed_paths` entries must be repo-relative",
            ErrorCategory.REQUEST,
        )
    is_dir = allow_directory and value.endswith("/")
    norm = posixpath.normpath(value.rstrip("/")) if is_dir else posixpath.normpath(value)
    if norm in ("", ".") or norm.startswith("../") or norm == "..":
        raise CodexApplyFailure(
            FAILURE_STAGE_REQUEST_VALIDATION,
            f"Unsupported `allowed_paths` entry: {raw!r}",
            ErrorCategory.REQUEST,
        )
    return f"{norm}/" if is_dir else norm


def _path_touches_symlink(repo_root: str, repo_relative_path: str) -> bool:
    current = Path(repo_root)
    for part in Path(repo_relative_path.rstrip("/")).parts:
        current = current / part
        if current.is_symlink():
            return True
    return False


def _normalize_allowed_paths(repo_root: str, allowed_paths: list[str]) -> list[str]:
    if not isinstance(allowed_paths, list) or not allowed_paths:
        raise CodexApplyFailure(
            FAILURE_STAGE_REQUEST_VALIDATION,
            "`allowed_paths` must be a non-empty list of repo-relative scopes",
            ErrorCategory.REQUEST,
        )
    seen: set[str] = set()
    out: list[str] = []
    for raw in allowed_paths:
        scope = _normalize_repo_relative_path(raw, allow_directory=True)
        if scope in seen:
            raise CodexApplyFailure(
                FAILURE_STAGE_REQUEST_VALIDATION,
                f"Duplicate normalized `allowed_paths` entry: {scope}",
                ErrorCategory.REQUEST,
            )
        if _path_touches_symlink(repo_root, scope):
            raise CodexApplyFailure(
                FAILURE_STAGE_REQUEST_VALIDATION,
                f"`allowed_paths` entry resolves through a symlink: {scope}",
                ErrorCategory.REQUEST,
            )
        seen.add(scope)
        out.append(scope)
    return sorted(out)


def _path_allowed(repo_relative_path: str, allowed_paths: list[str]) -> bool:
    for scope in allowed_paths:
        if scope.endswith("/"):
            if repo_relative_path.startswith(scope):
                return True
        elif repo_relative_path == scope:
            return True
    return False


def _require_primary_repo_state(repo_root: str, expected_head: str, *, stage: str) -> None:
    actual = _run_git_checked(
        repo_root, ["rev-parse", "HEAD"], stage=stage, category=ErrorCategory.REPO_STATE
    ).strip()
    if actual != expected_head:
        raise CodexApplyFailure(
            stage,
            f"Primary repository HEAD mismatch: expected {expected_head}, found {actual}",
            ErrorCategory.REPO_STATE,
        )
    status = _run_git_checked(
        repo_root,
        ["status", "--porcelain", "--untracked-files=normal"],
        stage=stage,
        category=ErrorCategory.REPO_STATE,
    ).strip()
    if status:
        raise CodexApplyFailure(
            stage,
            "Primary repository worktree must be clean before Codex apply",
            ErrorCategory.REPO_STATE,
        )


def _prepare_detached_worktree(repo_root: str, expected_head: str) -> tuple[str, str]:
    container = tempfile.mkdtemp(prefix="codex-gateway-worktree-")
    worktree_root = os.path.join(container, "repo")
    try:
        _run_git_checked(
            repo_root,
            ["worktree", "add", "--detach", worktree_root, expected_head],
            stage=FAILURE_STAGE_WORKTREE_PREPARE,
            category=ErrorCategory.LOCAL_CLI,
        )
    except CodexApplyFailure as exc:
        cleanup_error = _cleanup_detached_worktree(repo_root, container, worktree_root)
        if cleanup_error:
            raise CodexApplyFailure(
                exc.stage,
                f"{exc.args[0]} | cleanup failed: {cleanup_error}",
                exc.category,
            ) from exc
        raise
    return container, worktree_root


def _cleanup_detached_worktree(
    repo_root: str, container: str, worktree_root: str
) -> str | None:
    errors: list[str] = []
    if os.path.exists(worktree_root):
        result = _run_git(repo_root, ["worktree", "remove", "--force", worktree_root])
        if result.returncode != 0:
            errors.append(
                (result.stderr or result.stdout or "git worktree remove failed").strip()
            )
    prune = _run_git(repo_root, ["worktree", "prune"])
    if prune.returncode != 0:
        errors.append((prune.stderr or prune.stdout or "git worktree prune failed").strip())
    if os.path.exists(container):
        try:
            shutil.rmtree(container)
        except OSError as exc:
            errors.append(str(exc))
    if errors:
        return "; ".join(dict.fromkeys(errors))
    return None


def _parse_raw_diff_entries(raw_output: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    tokens = raw_output.split("\0")
    i = 0
    while i < len(tokens):
        header = tokens[i]
        if not header:
            i += 1
            continue
        if not header.startswith(":"):
            raise CodexApplyFailure(
                FAILURE_STAGE_DIFF_VALIDATION,
                "Unsupported git raw diff format from disposable worktree",
                ErrorCategory.DIFF_VALIDATION,
            )
        fields = header[1:].split()
        if len(fields) != 5:
            raise CodexApplyFailure(
                FAILURE_STAGE_DIFF_VALIDATION,
                "Unsupported git raw diff entry layout",
                ErrorCategory.DIFF_VALIDATION,
            )
        old_mode, new_mode, old_sha, new_sha, status_token = fields
        m = _RAW_STATUS_RE.match(status_token)
        if m is None:
            raise CodexApplyFailure(
                FAILURE_STAGE_DIFF_VALIDATION,
                f"Unsupported git diff status token: {status_token}",
                ErrorCategory.DIFF_VALIDATION,
            )
        status = m.group(0)
        path_count = 2 if status in {"R", "C"} else 1
        paths = tokens[i + 1 : i + 1 + path_count]
        if len(paths) != path_count or any(p == "" for p in paths):
            raise CodexApplyFailure(
                FAILURE_STAGE_DIFF_VALIDATION,
                "Malformed git diff path payload",
                ErrorCategory.DIFF_VALIDATION,
            )
        entries.append(
            {
                "old_mode": old_mode,
                "new_mode": new_mode,
                "old_sha": old_sha,
                "new_sha": new_sha,
                "status": status,
                "paths": paths,
            }
        )
        i += 1 + path_count
    return entries


def _parse_numstat_entries(numstat_output: str) -> dict[str, tuple[str, str]]:
    parsed: dict[str, tuple[str, str]] = {}
    for record in numstat_output.split("\0"):
        if not record:
            continue
        parts = record.split("\t", 2)
        if len(parts) != 3:
            raise CodexApplyFailure(
                FAILURE_STAGE_DIFF_VALIDATION,
                "Unsupported git numstat payload",
                ErrorCategory.DIFF_VALIDATION,
            )
        added, deleted, path = parts
        parsed[path] = (added, deleted)
    return parsed


def _is_ephemeral_codex_path(path: str) -> bool:
    """Return True for paths that Codex CLI drops as session sentinels.

    Matches the top-level ``.codex`` marker file and anything under a
    top-level ``.codex/`` directory. Other paths starting with ``.codex``
    (e.g. ``.codexrc``, ``.codex_config``) are *not* matched.
    """
    for prefix in _EPHEMERAL_CODEX_TOPLEVEL:
        if path == prefix or path.startswith(prefix + "/"):
            return True
    return False


def _prime_untracked_paths_for_diff(worktree_root: str) -> None:
    untracked_output = _run_git_checked(
        worktree_root,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        stage=FAILURE_STAGE_DIFF_VALIDATION,
        category=ErrorCategory.DIFF_VALIDATION,
    )
    paths = [
        p
        for p in untracked_output.split("\0")
        if p and not _is_ephemeral_codex_path(p)
    ]
    if not paths:
        return
    _run_git_checked(
        worktree_root,
        ["add", "--intent-to-add", "--", *paths],
        stage=FAILURE_STAGE_DIFF_VALIDATION,
        category=ErrorCategory.DIFF_VALIDATION,
    )


def _validate_diff(
    repo_root: str,
    worktree_root: str,
    expected_head: str,
    allowed_paths: list[str],
) -> tuple[list[str], str]:
    _prime_untracked_paths_for_diff(worktree_root)
    raw = _run_git_checked(
        worktree_root,
        ["diff", "--raw", "-z", "--find-renames", "--find-copies", expected_head],
        stage=FAILURE_STAGE_DIFF_VALIDATION,
        category=ErrorCategory.DIFF_VALIDATION,
    )
    entries = _parse_raw_diff_entries(raw)
    numstat = _parse_numstat_entries(
        _run_git_checked(
            worktree_root,
            ["diff", "--numstat", "-z", "--no-renames", expected_head],
            stage=FAILURE_STAGE_DIFF_VALIDATION,
            category=ErrorCategory.DIFF_VALIDATION,
        )
    )
    changed: list[str] = []
    for entry in entries:
        status = entry["status"]
        if status not in {"A", "M", "D"}:
            raise CodexApplyFailure(
                FAILURE_STAGE_DIFF_VALIDATION,
                f"Unsupported diff entry type: {status}",
                ErrorCategory.DIFF_VALIDATION,
            )
        path = entry["paths"][0]
        if _normalize_repo_relative_path(path, allow_directory=False) != path:
            raise CodexApplyFailure(
                FAILURE_STAGE_DIFF_VALIDATION,
                f"Disposable worktree produced non-normalized path: {path!r}",
                ErrorCategory.DIFF_VALIDATION,
            )
        if not _path_allowed(path, allowed_paths):
            raise CodexApplyFailure(
                FAILURE_STAGE_DIFF_VALIDATION,
                f"Out-of-scope change produced by Codex: {path}",
                ErrorCategory.DIFF_VALIDATION,
            )
        if entry["old_mode"] in {"120000", "160000"} or entry["new_mode"] in {"120000", "160000"}:
            raise CodexApplyFailure(
                FAILURE_STAGE_DIFF_VALIDATION,
                f"Symlink-touched or submodule path is unsupported: {path}",
                ErrorCategory.DIFF_VALIDATION,
            )
        if status == "M" and entry["old_mode"] != entry["new_mode"]:
            raise CodexApplyFailure(
                FAILURE_STAGE_DIFF_VALIDATION,
                f"Mode changes are unsupported: {path}",
                ErrorCategory.DIFF_VALIDATION,
            )
        if _path_touches_symlink(repo_root, path) or _path_touches_symlink(worktree_root, path):
            raise CodexApplyFailure(
                FAILURE_STAGE_DIFF_VALIDATION,
                f"Symlink-touched path is unsupported: {path}",
                ErrorCategory.DIFF_VALIDATION,
            )
        stat = numstat.get(path)
        if stat is None:
            raise CodexApplyFailure(
                FAILURE_STAGE_DIFF_VALIDATION,
                f"Diff entry missing text numstat payload: {path}",
                ErrorCategory.DIFF_VALIDATION,
            )
        if stat[0] == "-" or stat[1] == "-":
            raise CodexApplyFailure(
                FAILURE_STAGE_DIFF_VALIDATION,
                f"Binary or generated-heavy diff entry unsupported: {path}",
                ErrorCategory.DIFF_VALIDATION,
            )
        changed.append(path)
    patch = _run_git_checked(
        worktree_root,
        ["diff", "--binary", "--no-ext-diff", "--no-renames", expected_head],
        stage=FAILURE_STAGE_DIFF_VALIDATION,
        category=ErrorCategory.DIFF_VALIDATION,
    )
    return sorted(dict.fromkeys(changed)), patch


def _verify_primary_matches_worktree(
    repo_root: str, worktree_root: str, changed_files: list[str]
) -> None:
    for path in changed_files:
        primary = Path(repo_root) / path
        wt = Path(worktree_root) / path
        if not wt.exists():
            if primary.exists():
                raise CodexApplyFailure(
                    FAILURE_STAGE_APPLY_BACK,
                    f"Apply-back mismatch after deletion: {path}",
                    ErrorCategory.APPLY_CONFLICT,
                )
            continue
        if not primary.exists():
            raise CodexApplyFailure(
                FAILURE_STAGE_APPLY_BACK,
                f"Apply-back missing expected file: {path}",
                ErrorCategory.APPLY_CONFLICT,
            )
        if primary.read_bytes() != wt.read_bytes():
            raise CodexApplyFailure(
                FAILURE_STAGE_APPLY_BACK,
                f"Apply-back content mismatch for {path}",
                ErrorCategory.APPLY_CONFLICT,
            )


def _repo_lock_path(repo_root: str) -> str:
    """Resolve the cross-process flock file path for ``repo_root``.

    Lives outside the repo so it never enters the validated diff. The hash
    keeps it short enough for any tmpdir and avoids collisions between repos
    that share a basename.
    """
    repo_hash = hashlib.sha256(repo_root.encode("utf-8")).hexdigest()[:16]
    lock_dir = os.path.join(tempfile.gettempdir(), "codex-gateway-locks")
    os.makedirs(lock_dir, exist_ok=True)
    return os.path.join(lock_dir, f"apply.{repo_hash}.lock")


@contextmanager
def _repo_apply_lock(repo_root: str):
    """Serialize apply-back across both threads and processes.

    Two layers:
    1. **Process-internal** ``threading.Lock`` — keeps simultaneous
       ``codex_apply`` calls within the same MCP server child serial.
    2. **Cross-process** ``fcntl.flock`` — keeps a second MCP server child
       (e.g., a parallel Claude Code session attached to the same repo)
       from interleaving the apply_recheck → git apply window. ``apply_recheck``
       still catches stale-HEAD races; flock turns the dual-safety net into a
       deterministic queue.

    fcntl is BSD-style and Linux/macOS only. Windows hosts fall through with
    only the threading lock; templestay does not currently target Windows.
    """
    with _APPLY_LOCKS_GUARD:
        lock = _APPLY_LOCKS.setdefault(repo_root, threading.Lock())
    lock.acquire()
    fd: int | None = None
    try:
        try:
            import fcntl  # noqa: PLC0415 — platform-conditional import
        except ImportError:
            fcntl = None  # type: ignore[assignment]
        if fcntl is not None:
            try:
                fd = os.open(
                    _repo_lock_path(repo_root),
                    os.O_CREAT | os.O_RDWR,
                    0o600,
                )
                fcntl.flock(fd, fcntl.LOCK_EX)
            except OSError as exc:
                # Failed to take the cross-process lock; fall back to
                # threading-lock-only behaviour rather than blocking the
                # entire codex_apply pipeline. apply_recheck still protects
                # against stale-HEAD races.
                if fd is not None:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
                    fd = None
                logger.warning(
                    "cross-process flock unavailable for %s: %s; falling back to threading lock only",
                    repo_root,
                    exc,
                )
        yield
    finally:
        if fd is not None:
            try:
                # fcntl.flock auto-releases on close, but be explicit so the
                # file descriptor lifetime is unambiguous in tests/logs.
                import fcntl as _fcntl  # noqa: PLC0415

                _fcntl.flock(fd, _fcntl.LOCK_UN)
            except (OSError, ImportError):
                pass
            try:
                os.close(fd)
            except OSError:
                pass
        lock.release()


def _apply_validated_patch(
    repo_root: str, worktree_root: str, changed_files: list[str], patch: str
) -> None:
    if patch:
        check = _run_git(
            repo_root,
            ["apply", "--check", "--whitespace=nowarn", "-"],
            input_text=patch,
        )
        if check.returncode != 0:
            detail = (check.stderr or check.stdout or "git apply --check failed").strip()
            raise CodexApplyFailure(
                FAILURE_STAGE_APPLY_BACK,
                f"Validated diff could not be applied cleanly: {detail}",
                ErrorCategory.APPLY_CONFLICT,
            )
        apply = _run_git(
            repo_root,
            ["apply", "--whitespace=nowarn", "-"],
            input_text=patch,
        )
        if apply.returncode != 0:
            detail = (apply.stderr or apply.stdout or "git apply failed").strip()
            raise CodexApplyFailure(
                FAILURE_STAGE_APPLY_BACK,
                f"Validated diff apply-back failed: {detail}",
                ErrorCategory.APPLY_CONFLICT,
            )
    _verify_primary_matches_worktree(repo_root, worktree_root, changed_files)


def _apply_result(
    *,
    success: bool,
    applied: bool,
    changed_files: list[str],
    model: str | None,
    latency_ms: int | None,
    failure_stage: str | None,
    error: str | None,
    error_category: str | None,
    cleanup_status: str,
    usage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "success": success,
        "applied": applied,
        "changed_files": sorted(changed_files),
        "model": model,
        "latency_ms": latency_ms,
        "failure_stage": failure_stage,
        "error": error,
        "error_category": error_category,
        "cleanup_status": cleanup_status,
        "usage": usage,
        "routing_status": RoutingStatus.ROUTED if success else RoutingStatus.DEGRADED,
    }


# ---------------------------------------------------------------------------
# MCP server / tools
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "codex-gateway",
    instructions=(
        "Codex Gateway MCP server (templestay) — leaf bridge from Claude Opus "
        "orchestrator to OpenAI Codex CLI. `codex_preflight` reports readiness; "
        "`codex_prompt` proxies a read-only consultation in a neutral scratch "
        "directory; `codex_apply` is the only write path — Codex runs inside a "
        "detached git worktree at `expected_head`, the resulting diff is "
        "validated against `allowed_paths`, then applied back to the primary "
        "repo under a per-repo lock. Trivial single-file edits should stay on "
        "Sonnet `templestay-coder`. No reverse delegation, no council, no vote."
    ),
)


@mcp.tool()
def codex_preflight() -> dict[str, Any]:
    """Lightweight Codex readiness check for routing decisions."""
    ready, failure_category, failure_message = check_codex_cli_ready()
    return {
        "ready": ready,
        "codex_bin": CODEX_BIN,
        "codex_bin_source": CODEX_BIN_SOURCE,
        "default_model": DEFAULT_MODEL,
        "default_model_source": DEFAULT_MODEL_SOURCE,
        "failure_category": failure_category,
        "failure_message": failure_message,
        "routing_status": RoutingStatus.READY if ready else RoutingStatus.DEGRADED,
        "routing_observation": _routing_observation(
            attempted=False,
            failure_category=failure_category,
            failure_message=failure_message,
        ),
    }


@mcp.tool()
def codex_prompt(
    prompt: str,
    model: str = "",
    json_mode: bool = False,
    timeout: int = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    """Read-only Codex consultation in a neutral scratch directory.

    Fails closed if Codex mutates the scratch directory (read-only contract).
    Returns ``{success, response, data, parsed, model, tokens, latency_ms,
    warnings, error, error_category, routing_status, routing_observation}``.
    """
    effective_model, _ = resolve_default_model(model)
    with tempfile.TemporaryDirectory(prefix="codex-gateway-prompt-") as scratch:
        result, elapsed_ms, output_text, error = _execute_codex(
            prompt,
            cwd=scratch,
            sandbox=SANDBOX_READ_ONLY,
            model=effective_model,
            timeout=timeout,
        )
        if error is not None:
            return error
        assert result is not None and elapsed_ms is not None
        if any(Path(scratch).iterdir()):
            return _error_envelope(
                "`codex_prompt` is read-only; Codex mutated the neutral scratch directory",
                category=ErrorCategory.LOCAL_CLI,
            )
        response_text = (output_text or "").strip()
        events, usage = _parse_jsonl_events(result.stdout or "")
        data: Any = None
        parsed = False
        if json_mode and response_text:
            try:
                data = json.loads(response_text)
                parsed = True
            except (json.JSONDecodeError, TypeError):
                parsed = False
        warnings = (result.stderr or "").strip() or None
        return {
            "success": True,
            "response": response_text,
            "data": data,
            "parsed": parsed,
            "model": effective_model,
            "tokens": usage,
            "latency_ms": elapsed_ms,
            "warnings": warnings,
            "error": None,
            "error_category": None,
            "routing_status": RoutingStatus.ROUTED,
            "routing_observation": _routing_observation(attempted=True),
            "events_count": len(events),
        }


@mcp.tool()
def codex_apply(
    prompt: str,
    repo_root: str,
    expected_head: str,
    allowed_paths: list[str],
    model: str = "",
    timeout_sec: int = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    """Run Codex in a detached worktree and apply back the validated diff.

    Steps: validate request → check primary repo HEAD/clean → create detached
    worktree at ``expected_head`` → run Codex with ``-s workspace-write`` inside
    the worktree → validate diff against ``allowed_paths`` → re-check primary
    repo under per-repo lock → ``git apply`` patch → verify content matches.
    Cleanup runs on every exit path.
    """
    start_ms = time.monotonic_ns() // 1_000_000
    effective_model, _ = resolve_default_model(model)
    cleanup_status = CLEANUP_STATUS_NOT_CREATED
    cleanup_error: str | None = None
    container: str | None = None
    worktree_root: str | None = None
    changed_files: list[str] = []
    response: dict[str, Any] | None = None
    usage: dict[str, Any] | None = None

    try:
        canonical_repo_root = _resolve_canonical_repo_root(repo_root)
        validated_head = _validate_expected_head(expected_head)
        normalized_paths = _normalize_allowed_paths(canonical_repo_root, allowed_paths)

        _require_primary_repo_state(
            canonical_repo_root, validated_head, stage=FAILURE_STAGE_PRIMARY_PRECHECK
        )

        container, worktree_root = _prepare_detached_worktree(
            canonical_repo_root, validated_head
        )

        ready, failure_category, failure_message = check_codex_cli_ready()
        if not ready:
            raise CodexApplyFailure(
                FAILURE_STAGE_CODEX_EXECUTION,
                failure_message or "Codex CLI is not ready",
                failure_category or ErrorCategory.LOCAL_CLI,
            )

        result, _, _, codex_error = _execute_codex(
            prompt,
            cwd=worktree_root,
            sandbox=SANDBOX_WORKSPACE_WRITE,
            model=effective_model,
            timeout=timeout_sec,
        )
        if codex_error is not None:
            raise CodexApplyFailure(
                FAILURE_STAGE_CODEX_EXECUTION,
                codex_error["error"],
                codex_error["error_category"] or ErrorCategory.UNDETERMINED,
            )
        if result is not None:
            _, usage = _parse_jsonl_events(result.stdout or "")

        changed_files, patch = _validate_diff(
            canonical_repo_root, worktree_root, validated_head, normalized_paths
        )

        with _repo_apply_lock(canonical_repo_root):
            _require_primary_repo_state(
                canonical_repo_root, validated_head, stage=FAILURE_STAGE_APPLY_RECHECK
            )
            _apply_validated_patch(
                canonical_repo_root, worktree_root, changed_files, patch
            )

        response = _apply_result(
            success=True,
            applied=True,
            changed_files=changed_files,
            model=effective_model,
            latency_ms=_elapsed_ms(start_ms),
            failure_stage=None,
            error=None,
            error_category=None,
            cleanup_status=CLEANUP_STATUS_CLEAN,
            usage=usage,
        )
    except CodexApplyFailure as exc:
        response = _apply_result(
            success=False,
            applied=False,
            changed_files=[],
            model=effective_model,
            latency_ms=_elapsed_ms(start_ms),
            failure_stage=exc.stage,
            error=exc.args[0],
            error_category=exc.category,
            cleanup_status=cleanup_status,
            usage=usage,
        )
    except Exception as exc:  # pragma: no cover - defense-in-depth
        logger.exception("Unexpected codex_apply failure")
        response = _apply_result(
            success=False,
            applied=False,
            changed_files=[],
            model=effective_model,
            latency_ms=_elapsed_ms(start_ms),
            failure_stage=FAILURE_STAGE_CODEX_EXECUTION,
            error=f"Unexpected codex_apply failure: {exc}",
            error_category=ErrorCategory.UNDETERMINED,
            cleanup_status=cleanup_status,
            usage=usage,
        )
    finally:
        if container is not None and worktree_root is not None:
            cleanup_error = _cleanup_detached_worktree(
                _normalize_realpath(repo_root), container, worktree_root
            )
            cleanup_status = (
                CLEANUP_STATUS_CLEANUP_FAILED if cleanup_error else CLEANUP_STATUS_CLEAN
            )
        else:
            cleanup_status = CLEANUP_STATUS_NOT_CREATED

    assert response is not None
    response["cleanup_status"] = cleanup_status
    if cleanup_error:
        if response["error"]:
            response["error"] = f"{response['error']} | cleanup failed: {cleanup_error}"
        else:
            response["error"] = cleanup_error
            response["error_category"] = ErrorCategory.CLEANUP
        if response["failure_stage"] is None:
            response["failure_stage"] = FAILURE_STAGE_CLEANUP
        if response["success"]:
            response["success"] = False
            response["routing_status"] = RoutingStatus.DEGRADED
    return response


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"[codex-gateway-mcp {ts}] {msg}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    _log(
        f"Starting codex-gateway MCP server "
        f"(bin={CODEX_BIN}, default_model={DEFAULT_MODEL})"
    )
    mcp.run(transport="stdio")
