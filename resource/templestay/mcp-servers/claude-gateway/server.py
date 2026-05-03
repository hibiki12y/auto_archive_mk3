#!/usr/bin/env python3
"""Claude Gateway MCP server (templestay).

Invokes Claude Code through the local ``claude`` CLI in non-interactive print
mode and exposes read-only consultation tools for Codex-native templestay
workflows:

* ``claude_preflight`` — lightweight local readiness check for routing
* ``claude_prompt``    — read-only Claude prompt proxy in a neutral scratch cwd
* ``claude_route_probe`` — fixed no-repository synthetic route check
* ``claude_models``    — known model aliases / identifiers

The gateway deliberately exposes no ``claude_apply`` tool. Repository writes
stay in the Codex primary session; Claude returns attributed evidence only.
Run with ``python3 server.py`` to serve the stdio transport.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP


logger = logging.getLogger("claude-gateway-mcp")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_PROMPT_SIZE = 1_000_000  # bytes; keeps prompt proxy bounded for MCP calls
DEFAULT_TIMEOUT = 120
MIN_TIMEOUT = 1
DEFAULT_MAX_TURNS = 1
MIN_MAX_TURNS = 1
MAX_MAX_TURNS = 8
REPO_FALLBACK_MODEL = "claude-opus-4-7"
REPO_FALLBACK_EFFORT = "max"
KNOWN_EFFORT_LEVELS = {"low", "medium", "high", "xhigh", "max"}
KNOWN_DESTINATION_TRUST = {"untrusted_external", "trusted_internal"}
TRUE_VALUES = {"1", "true", "yes", "on"}

_UNRESOLVED_INTERPOLATION_RE = re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*\}$")

KNOWN_MODELS: list[str] = [
    "opus",
    "sonnet",
    "haiku",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
]


class ErrorCategory:
    """Stable error category labels for Claude gateway responses."""

    REPO_CONFIG = "repo_config_error"
    LOCAL_CLI = "local_cli_runtime_error"
    REQUEST = "request_error"
    TIMEOUT = "invocation_timeout"
    EXTERNAL_AUTH = "external_auth_error"
    EXTERNAL_NETWORK = "external_network_error"
    EXTERNAL_SERVICE = "external_service_error"
    EXTERNAL_MODEL_AVAILABILITY = "external_model_availability_error"
    UNDETERMINED = "undetermined_origin"


class RoutingStatus:
    READY = "ready"
    ROUTED = "routed"
    DEGRADED = "degraded"


CATEGORY_PREFIX = {
    ErrorCategory.REPO_CONFIG: "Repo-controlled Claude configuration error",
    ErrorCategory.LOCAL_CLI: "Local Claude CLI/runtime error",
    ErrorCategory.REQUEST: "Claude request error",
    ErrorCategory.TIMEOUT: "Claude invocation timeout",
    ErrorCategory.EXTERNAL_AUTH: "External Claude authentication error",
    ErrorCategory.EXTERNAL_NETWORK: "External Claude network error",
    ErrorCategory.EXTERNAL_SERVICE: "External Claude service error",
    ErrorCategory.EXTERNAL_MODEL_AVAILABILITY: "External Claude model-availability error",
    ErrorCategory.UNDETERMINED: "Claude CLI failure with undetermined origin",
}


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
            "CLAUDE_DEFAULT_MODEL received unresolved placeholder %r; falling back",
            value,
        )
        return ""
    return value


CONFIGURED_DEFAULT_MODEL = _sanitize_configured_model(os.environ.get("CLAUDE_DEFAULT_MODEL"))
DEFAULT_MODEL = CONFIGURED_DEFAULT_MODEL or REPO_FALLBACK_MODEL
DEFAULT_MODEL_SOURCE = "runtime-config" if CONFIGURED_DEFAULT_MODEL else "repo-fallback"


def _sanitize_configured_effort(raw: str | None) -> str:
    if not isinstance(raw, str):
        return ""
    value = raw.strip().lower()
    if not value:
        return ""
    if _UNRESOLVED_INTERPOLATION_RE.match(value):
        logger.warning(
            "CLAUDE_DEFAULT_EFFORT received unresolved placeholder %r; falling back",
            value,
        )
        return ""
    if value not in KNOWN_EFFORT_LEVELS:
        logger.warning(
            "CLAUDE_DEFAULT_EFFORT received unsupported value %r; falling back",
            value,
        )
        return ""
    return value


CONFIGURED_DEFAULT_EFFORT = _sanitize_configured_effort(os.environ.get("CLAUDE_DEFAULT_EFFORT"))
DEFAULT_EFFORT = CONFIGURED_DEFAULT_EFFORT or REPO_FALLBACK_EFFORT
DEFAULT_EFFORT_SOURCE = "runtime-config" if CONFIGURED_DEFAULT_EFFORT else "repo-fallback"


def resolve_claude_bin_details() -> tuple[str, str]:
    env_bin = os.environ.get("CLAUDE_BIN", "").strip()
    if env_bin and _UNRESOLVED_INTERPOLATION_RE.match(env_bin):
        logger.warning(
            "CLAUDE_BIN received unresolved placeholder %r; falling back to PATH lookup",
            env_bin,
        )
        env_bin = ""
    if env_bin:
        if os.path.sep in env_bin or (os.path.altsep and os.path.altsep in env_bin):
            return env_bin, "env"
        return shutil.which(env_bin) or env_bin, "env"
    which_bin = shutil.which("claude")
    if which_bin:
        return which_bin, "path"
    return "/usr/local/bin/claude", "repo-fallback"


CLAUDE_BIN, CLAUDE_BIN_SOURCE = resolve_claude_bin_details()


def resolve_default_model(model: str | None) -> tuple[str, str]:
    explicit = model.strip() if isinstance(model, str) else ""
    if explicit:
        return explicit, "explicit-request"
    if CONFIGURED_DEFAULT_MODEL:
        return CONFIGURED_DEFAULT_MODEL, "runtime-config"
    return REPO_FALLBACK_MODEL, "repo-fallback"


def resolve_default_effort(effort: str | None) -> tuple[str, str]:
    explicit = _sanitize_configured_effort(effort)
    if explicit:
        return explicit, "explicit-request"
    if CONFIGURED_DEFAULT_EFFORT:
        return CONFIGURED_DEFAULT_EFFORT, "runtime-config"
    return REPO_FALLBACK_EFFORT, "repo-fallback"


def _sanitize_destination_trust(raw: str | None) -> str:
    if not isinstance(raw, str):
        return "untrusted_external"
    value = raw.strip().lower().replace("-", "_")
    if value in KNOWN_DESTINATION_TRUST:
        return value
    if value:
        logger.warning(
            "CLAUDE_GATEWAY_DESTINATION_TRUST received unsupported value %r; falling back to untrusted_external",
            value,
        )
    return "untrusted_external"


def _env_truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in TRUE_VALUES


def content_transfer_policy() -> dict[str, Any]:
    """Return the repository-content transfer policy exposed by preflight.

    This gateway reports whether repository-derived content is preauthorized
    for the Claude route. By default it is not trusted; callers should use a
    no-repository synthetic route check and mark content-bearing
    Critique degraded until trust and the repo-content allow flag are
    explicitly configured.
    """
    trust = _sanitize_destination_trust(os.environ.get("CLAUDE_GATEWAY_DESTINATION_TRUST"))
    allow_repo_content = _env_truthy("CLAUDE_GATEWAY_ALLOW_REPO_CONTENT")
    content_transfer_allowed = trust == "trusted_internal" and allow_repo_content
    if content_transfer_allowed:
        repo_content_policy = "policy_preauthorized_repo_content_allowed"
        content_transfer_requirements = [
            "destination_trust=trusted_internal",
            "CLAUDE_GATEWAY_ALLOW_REPO_CONTENT=true",
            "per-call external-transfer approval not required",
            "secret-screened minimal evidence bundle",
        ]
    else:
        repo_content_policy = "synthetic_only_until_trust_established"
        content_transfer_requirements = [
            "destination_trust=trusted_internal",
            "CLAUDE_GATEWAY_ALLOW_REPO_CONTENT=true",
            "policy preauthorization required before repository-content transfer",
            "secret-screened minimal evidence bundle",
        ]
    return {
        "destination_trust": trust,
        "destination_trust_source": (
            "runtime-config"
            if os.environ.get("CLAUDE_GATEWAY_DESTINATION_TRUST", "").strip()
            else "repo-default"
        ),
        "allow_repo_content_flag": allow_repo_content,
        "content_transfer_allowed": content_transfer_allowed,
        "repo_content_policy": repo_content_policy,
        "synthetic_route_check_supported": True,
        "content_transfer_requirements": content_transfer_requirements,
    }


def check_claude_cli_ready() -> tuple[bool, str | None, str | None]:
    if not CLAUDE_BIN:
        return False, ErrorCategory.REPO_CONFIG, "Resolved Claude CLI path is empty"
    if not os.path.exists(CLAUDE_BIN):
        return False, ErrorCategory.LOCAL_CLI, f"Claude CLI not found at {CLAUDE_BIN}"
    if not os.access(CLAUDE_BIN, os.X_OK):
        return False, ErrorCategory.LOCAL_CLI, f"Claude CLI is not executable at {CLAUDE_BIN}"
    return True, None, None


# ---------------------------------------------------------------------------
# Normalisation and error helpers
# ---------------------------------------------------------------------------


def normalize_timeout(raw: Any) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT
    if value < MIN_TIMEOUT:
        return DEFAULT_TIMEOUT
    return value


def normalize_max_turns(raw: Any) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_MAX_TURNS
    if value < MIN_MAX_TURNS:
        return DEFAULT_MAX_TURNS
    return min(value, MAX_MAX_TURNS)


# Security: stderr from external CLIs can carry secrets/paths/tokens — scrub before propagating.
def _redact_stderr(text: str | None) -> str | None:
    if not text:
        return text
    redacted = text
    # Home-path usernames: /home/<user>/..., /Users/<user>/..., C:\Users\<user>\...
    redacted = re.sub(r"(/home/)([^/\s]+)", r"\1[REDACTED]", redacted)
    redacted = re.sub(r"(/Users/)([^/\s]+)", r"\1[REDACTED]", redacted)
    redacted = re.sub(r"(C:\\Users\\)([^\\\s]+)", r"\1[REDACTED]", redacted)
    # Anthropic, OpenAI, GitHub, AWS-like tokens and API-key prose.
    redacted = re.sub(r"sk-ant-[A-Za-z0-9_-]{20,}", "[REDACTED]", redacted)
    redacted = re.sub(r"sk-[A-Za-z0-9_-]{20,}", "[REDACTED]", redacted)
    redacted = re.sub(r"gh[pousr]_[A-Za-z0-9_]{20,}", "[REDACTED]", redacted)
    redacted = re.sub(r"AKIA[0-9A-Z]{16}", "[REDACTED]", redacted)
    redacted = re.sub(r"Bearer\s+\S+", "[REDACTED]", redacted)
    redacted = re.sub(r"(?i)(api[_ -]?key\s*[:=]\s*)\S+", r"\1[REDACTED]", redacted)
    redacted = re.sub(r"[\w.+-]+@[\w-]+\.[\w.-]+", "[REDACTED]", redacted)
    if len(redacted) > 2000:
        redacted = redacted[:2000] + "… [truncated]"
    return redacted


def _routing_observation(
    *, attempted: bool, failure_category: str | None = None, failure_message: str | None = None
) -> dict[str, Any]:
    return {
        "claude_route_attempted": attempted,
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
    prefix = CATEGORY_PREFIX.get(category, CATEGORY_PREFIX[ErrorCategory.UNDETERMINED])
    return {
        "success": False,
        "response": None,
        "data": None,
        "parsed": False,
        "model": None,
        "tokens": None,
        "latency_ms": None,
        "session_id": None,
        "cost_usd": None,
        "warnings": None,
        "error": f"{prefix}: {message}",
        "error_category": category,
        "routing_status": RoutingStatus.DEGRADED,
        "routing_observation": _routing_observation(
            attempted=attempted, failure_category=category, failure_message=message
        ),
    }


def classify_cli_exit(stderr: str) -> str | None:
    detail = stderr.lower()
    if any(t in detail for t in ("auth", "login", "unauth", "credential", "api key")):
        return ErrorCategory.EXTERNAL_AUTH
    if any(
        t in detail
        for t in (
            "network",
            "dns",
            "socket",
            "connection",
            "timed out",
            "timeout",
            "econn",
            "tls",
            "ssl",
        )
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
            "model not found",
            "unknown model",
            "unsupported model",
            "invalid model",
            "not available for model",
            "selected model",
            "pick a different model",
            "may not exist",
            "not have access",
        )
    ):
        return ErrorCategory.EXTERNAL_MODEL_AVAILABILITY
    if any(t in detail for t in ("permission", "disallowed tool", "not allowed")):
        return ErrorCategory.REQUEST
    return None


def _extract_response(envelope: Any) -> str:
    if isinstance(envelope, str):
        return envelope
    if not isinstance(envelope, dict):
        return ""
    for key in ("result", "response", "text", "content"):
        value = envelope.get(key)
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            chunks: list[str] = []
            for item in value:
                if isinstance(item, str):
                    chunks.append(item)
                elif isinstance(item, dict):
                    item_text = item.get("text") or item.get("content")
                    if isinstance(item_text, str):
                        chunks.append(item_text)
            if chunks:
                return "\n".join(chunks)
    message = envelope.get("message")
    if isinstance(message, str):
        return message
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "\n".join(
                item.get("text", "") for item in content if isinstance(item, dict)
            ).strip()
    return ""


def _extract_stats(envelope: dict[str, Any], effective_model: str) -> dict[str, Any]:
    usage = envelope.get("usage")
    if not isinstance(usage, dict):
        usage = None
    return {
        "model": envelope.get("model") or envelope.get("model_id") or effective_model,
        "tokens": usage,
        "latency_ms": envelope.get("duration_ms") or envelope.get("duration_api_ms"),
        "session_id": envelope.get("session_id"),
        "cost_usd": envelope.get("total_cost_usd") or envelope.get("cost_usd"),
        "num_turns": envelope.get("num_turns"),
    }


# ---------------------------------------------------------------------------
# Claude CLI invocation
# ---------------------------------------------------------------------------


def build_command(prompt: str, model: str, max_turns: int, effort: str = DEFAULT_EFFORT) -> list[str]:
    """Build the canonical non-interactive Claude Code command.

    Form::

        claude -p <prompt> --output-format json --no-session-persistence \
               --max-turns <n> [--model <model>] --effort <effort> \
               --disallowedTools Edit MultiEdit Write NotebookEdit Bash

    ``--dangerously-skip-permissions`` is intentionally never used. The gateway
    also runs from a neutral scratch directory and verifies that print mode did
    not create files there.
    """
    cmd = [
        CLAUDE_BIN,
        "-p",
        prompt,
        "--output-format",
        "json",
        "--no-session-persistence",
        "--max-turns",
        str(normalize_max_turns(max_turns)),
    ]
    if model:
        cmd.extend(["--model", model])
    resolved_effort, _ = resolve_default_effort(effort)
    if resolved_effort:
        cmd.extend(["--effort", resolved_effort])
    cmd.extend(
        [
            "--disallowedTools",
            "Edit",
            "MultiEdit",
            "Write",
            "NotebookEdit",
            "Bash",
        ]
    )
    return cmd


def run_claude(
    *,
    prompt: str,
    model: str,
    json_mode: bool,
    timeout: int,
    max_turns: int,
    effort: str,
    cwd: str,
) -> dict[str, Any]:
    prompt_size = len(prompt.encode("utf-8"))
    if prompt_size > MAX_PROMPT_SIZE:
        return _error_envelope(
            f"Prompt too large ({prompt_size} bytes, max {MAX_PROMPT_SIZE})",
            category=ErrorCategory.REQUEST,
        )

    effective_effort, _ = resolve_default_effort(effort)
    cmd = build_command(prompt, model, normalize_max_turns(max_turns), effective_effort)
    prompt_fingerprint = f"len={len(prompt)} sha256:{__import__('hashlib').sha256(prompt.encode('utf-8')).hexdigest()[:12]}"
    logger.debug("Running Claude CLI: %s <prompt %s>", " ".join(cmd[:2] + cmd[3:]), prompt_fingerprint)
    start_ms = time.monotonic_ns() // 1_000_000
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=normalize_timeout(timeout),
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return _error_envelope(
            f"Timed out after {normalize_timeout(timeout)}s while running model {model} (effort={effective_effort})",
            category=ErrorCategory.TIMEOUT,
        )
    except FileNotFoundError:
        return _error_envelope(
            f"Claude CLI not found at {CLAUDE_BIN}",
            category=ErrorCategory.LOCAL_CLI,
        )
    except OSError as exc:
        return _error_envelope(
            f"Failed to execute Claude CLI at {CLAUDE_BIN}: {exc}",
            category=ErrorCategory.LOCAL_CLI,
        )

    elapsed_ms = (time.monotonic_ns() // 1_000_000) - start_ms

    stderr = _redact_stderr(result.stderr.strip()) if result.stderr and result.stderr.strip() else None
    if result.returncode != 0:
        detail = stderr
        stdout = result.stdout.strip()
        if stdout:
            try:
                envelope_raw = json.loads(stdout)
            except json.JSONDecodeError:
                envelope_raw = None
            if isinstance(envelope_raw, dict):
                detail = _extract_response(envelope_raw) or json.dumps(envelope_raw, ensure_ascii=False)[:1000]
        if not detail:
            detail = "no stderr output"
        category = classify_cli_exit(detail) or ErrorCategory.UNDETERMINED
        return _error_envelope(
            f"Claude CLI exited with code {result.returncode} while using model {model} (effort={effective_effort}): {detail}",
            category=category,
        )

    stdout = result.stdout.strip()
    if not stdout:
        return _error_envelope("Claude CLI returned empty output", category=ErrorCategory.LOCAL_CLI)
    try:
        envelope_raw = json.loads(stdout)
    except json.JSONDecodeError as exc:
        return _error_envelope(f"Failed to parse Claude output: {exc}", category=ErrorCategory.LOCAL_CLI)

    if not isinstance(envelope_raw, dict):
        return _error_envelope("Claude CLI JSON output was not an object", category=ErrorCategory.LOCAL_CLI)

    if envelope_raw.get("is_error") is True or envelope_raw.get("subtype") == "error":
        msg = _extract_response(envelope_raw) or json.dumps(envelope_raw, ensure_ascii=False)[:1000]
        return _error_envelope(msg, category=classify_cli_exit(msg) or ErrorCategory.UNDETERMINED)

    response_text = _extract_response(envelope_raw).strip()
    stats = _extract_stats(envelope_raw, model)
    data: Any = None
    parsed = False
    if json_mode and response_text:
        try:
            data = json.loads(response_text)
            parsed = True
        except (json.JSONDecodeError, TypeError):
            parsed = False

    return {
        "success": True,
        "response": response_text,
        "data": data,
        "parsed": parsed,
        "model": stats["model"],
        "effort": effective_effort,
        "tokens": stats["tokens"],
        "latency_ms": stats["latency_ms"] or elapsed_ms,
        "session_id": stats["session_id"],
        "cost_usd": stats["cost_usd"],
        "num_turns": stats["num_turns"],
        "warnings": stderr,
        "error": None,
        "error_category": None,
        "routing_status": RoutingStatus.ROUTED,
        "routing_observation": _routing_observation(attempted=True),
        "raw_type": envelope_raw.get("type"),
        "raw_subtype": envelope_raw.get("subtype"),
    }


# ---------------------------------------------------------------------------
# MCP server / tools
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "claude-gateway",
    instructions=(
        "Claude Gateway MCP server (templestay) — invoke Claude Code through "
        "the local `claude` CLI in non-interactive print mode. `claude_preflight` "
        "reports readiness and content-transfer policy; `claude_prompt` sends "
        "a read-only consultation from a neutral scratch directory and returns "
        "a structured envelope; `claude_route_probe` runs a fixed no-repository "
        "synthetic route check; `claude_models` lists known aliases/model "
        "identifiers. No write/apply tool is exposed; Codex remains the "
        "repository writer."
    ),
)


@mcp.tool()
def claude_preflight() -> dict[str, Any]:
    """Lightweight Claude readiness check for Codex routing decisions."""
    ready, failure_category, failure_message = check_claude_cli_ready()
    return {
        "ready": ready,
        "claude_bin": CLAUDE_BIN,
        "claude_bin_source": CLAUDE_BIN_SOURCE,
        "default_model": DEFAULT_MODEL,
        "default_model_source": DEFAULT_MODEL_SOURCE,
        "default_effort": DEFAULT_EFFORT,
        "default_effort_source": DEFAULT_EFFORT_SOURCE,
        "failure_category": failure_category,
        "failure_message": failure_message,
        "content_transfer_policy": content_transfer_policy(),
        "routing_status": RoutingStatus.READY if ready else RoutingStatus.DEGRADED,
        "routing_observation": _routing_observation(
            attempted=False,
            failure_category=failure_category,
            failure_message=failure_message,
        ),
    }


@mcp.tool()
def claude_prompt(
    prompt: str,
    model: str = "",
    effort: str = "",
    json_mode: bool = False,
    timeout: int = DEFAULT_TIMEOUT,
    max_turns: int = DEFAULT_MAX_TURNS,
) -> dict[str, Any]:
    """Send a read-only prompt to Claude Code and return a structured result."""
    effective_model, _ = resolve_default_model(model)
    effective_effort, _ = resolve_default_effort(effort)
    if not effective_model:
        return _error_envelope(
            "No Claude model resolved (expected explicit request, propagated runtime config, or repo fallback)",
            category=ErrorCategory.REPO_CONFIG,
        )
    with tempfile.TemporaryDirectory(prefix="claude-gateway-prompt-") as scratch:
        result = run_claude(
            prompt=prompt,
            model=effective_model,
            json_mode=json_mode,
            timeout=normalize_timeout(timeout),
            max_turns=normalize_max_turns(max_turns),
            effort=effective_effort,
            cwd=scratch,
        )
        if result.get("success") and any(Path(scratch).iterdir()):
            return _error_envelope(
                "`claude_prompt` is read-only; Claude mutated the neutral scratch directory",
                category=ErrorCategory.LOCAL_CLI,
            )
        return result


@mcp.tool()
def claude_route_probe(
    model: str = "",
    effort: str = "",
    timeout: int = 30,
) -> dict[str, Any]:
    """Run a fixed no-repository synthetic Claude route check.

    This proves the Claude route can execute without sending repository-derived
    content. It is not a substitute for content-bearing Critique.
    """
    effective_model, _ = resolve_default_model(model)
    effective_effort, _ = resolve_default_effort(effort)
    if not effective_model:
        return _error_envelope(
            "No Claude model resolved (expected explicit request, propagated runtime config, or repo fallback)",
            category=ErrorCategory.REPO_CONFIG,
        )
    synthetic_prompt = (
        "Synthetic connectivity check only. This prompt contains no repository "
        "content, no private workspace details, no code, no logs, and no file "
        "names. Reply with exactly: SYNTHETIC_ROUTE_OK"
    )
    with tempfile.TemporaryDirectory(prefix="claude-gateway-route-probe-") as scratch:
        result = run_claude(
            prompt=synthetic_prompt,
            model=effective_model,
            json_mode=False,
            timeout=normalize_timeout(timeout),
            max_turns=1,
            effort=effective_effort,
            cwd=scratch,
        )
        if result.get("success") and any(Path(scratch).iterdir()):
            return _error_envelope(
                "`claude_route_probe` is read-only; Claude mutated the neutral scratch directory",
                category=ErrorCategory.LOCAL_CLI,
            )
        result["synthetic_route_check"] = True
        result["contains_repository_content"] = False
        result["expected_response"] = "SYNTHETIC_ROUTE_OK"
        return result


@mcp.tool()
def claude_models() -> dict[str, Any]:
    """List known Claude model aliases/identifiers available via the local CLI."""
    return {
        "models": list(KNOWN_MODELS),
        "default_model": DEFAULT_MODEL,
        "default_model_source": DEFAULT_MODEL_SOURCE,
        "default_effort": DEFAULT_EFFORT,
        "default_effort_source": DEFAULT_EFFORT_SOURCE,
        "claude_bin": CLAUDE_BIN,
        "claude_bin_source": CLAUDE_BIN_SOURCE,
        "content_transfer_policy": content_transfer_policy(),
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"[claude-gateway-mcp {ts}] {msg}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    _log(f"Starting claude-gateway MCP server (bin={CLAUDE_BIN}, default_model={DEFAULT_MODEL})")
    mcp.run(transport="stdio")
