"""Gemini Gateway MCP server (templestay).

Invokes Google Gemini models via the local ``gemini`` CLI and exposes two MCP
tools: ``gemini_prompt`` for prompt calls and ``gemini_models`` for known model
identifiers. Run with ``python3 server.py`` to serve the stdio transport.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
from typing import Any

from mcp.server.fastmcp import FastMCP


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logger = logging.getLogger("gemini-gateway-mcp")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_PROMPT_SIZE = 4_000_000   # bytes (~1M tokens; aligned with Gemini 3.x context window — covers the long_context capability trigger which fires at >~200K tokens)
DEFAULT_TIMEOUT = 120       # seconds
MIN_TIMEOUT = 1             # seconds — guard against zero/negative timeouts
REPO_FALLBACK_MODEL = "gemini-3.1-pro-preview"

_UNRESOLVED_INTERPOLATION_RE = re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*\}$")


class ErrorCategory:
    """Stable error category labels for Gemini gateway responses."""

    REPO_CONFIG = "repo_config_error"
    LOCAL_CLI = "local_cli_runtime_error"
    REQUEST = "request_error"
    TIMEOUT = "invocation_timeout"
    EXTERNAL_AUTH = "external_auth_error"
    EXTERNAL_NETWORK = "external_network_error"
    EXTERNAL_SERVICE = "external_service_error"
    EXTERNAL_MODEL_AVAILABILITY = "external_model_availability_error"
    UNDETERMINED = "undetermined_origin"


CATEGORY_PREFIX = {
    ErrorCategory.REPO_CONFIG: "Repo-controlled Gemini configuration error",
    ErrorCategory.LOCAL_CLI: "Local Gemini CLI/runtime error",
    ErrorCategory.REQUEST: "Gemini request error",
    ErrorCategory.TIMEOUT: "Gemini invocation timeout",
    ErrorCategory.EXTERNAL_AUTH: "External Gemini authentication error",
    ErrorCategory.EXTERNAL_NETWORK: "External Gemini network error",
    ErrorCategory.EXTERNAL_SERVICE: "External Gemini service error",
    ErrorCategory.EXTERNAL_MODEL_AVAILABILITY: "External Gemini model-availability error",
    ErrorCategory.UNDETERMINED: "Gemini CLI failure with undetermined origin",
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
            "GEMINI_DEFAULT_MODEL received unresolved placeholder %r; falling back",
            value,
        )
        return ""
    return value


CONFIGURED_DEFAULT_MODEL = _sanitize_configured_model(os.environ.get("GEMINI_DEFAULT_MODEL"))
DEFAULT_MODEL = CONFIGURED_DEFAULT_MODEL or REPO_FALLBACK_MODEL
DEFAULT_MODEL_SOURCE = "runtime-config" if CONFIGURED_DEFAULT_MODEL else "repo-fallback"

KNOWN_MODELS: list[str] = [
    "gemini-3.1-pro-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
]


# ---------------------------------------------------------------------------
# Normalisation helpers
# ---------------------------------------------------------------------------


def strip_markdown_fences(text: str | None) -> str | None:
    if not text:
        return text
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").rstrip()
    match = re.match(r"^```[\w+.-]*\n(.*?)```$", normalized, re.DOTALL)
    if match:
        return match.group(1).strip()
    return text


def find_main_model_stats(stats: dict[str, Any]) -> tuple[str | None, dict[str, Any] | None]:
    models = stats.get("models", {})
    if not models:
        return None, None
    for name, model_data in models.items():
        if "main" in model_data.get("roles", []):
            return name, model_data
    if len(models) == 1:
        return next(iter(models.items()))
    return None, None


def extract_stats(envelope: dict[str, Any]) -> dict[str, Any]:
    stats = envelope.get("stats", {})
    if not stats:
        return {"model": None, "tokens": None, "latency_ms": None}
    model_name, model_data = find_main_model_stats(stats)
    if model_data is None:
        return {"model": model_name, "tokens": None, "latency_ms": None}
    tokens_info = model_data.get("tokens")
    tokens = (
        {"input": tokens_info.get("input"), "output": tokens_info.get("candidates")}
        if tokens_info
        else None
    )
    return {
        "model": model_name,
        "tokens": tokens,
        "latency_ms": model_data.get("api", {}).get("totalLatencyMs"),
    }


# Security: stderr from external CLIs can carry secrets/paths/tokens — scrub before propagating.
def _redact_stderr(text: str) -> str:
    if not text:
        return text
    redacted = text
    # Home-path usernames: /home/<user>/..., /Users/<user>/..., C:\Users\<user>\...
    redacted = re.sub(r"(/home/)([^/\s]+)", r"\1[REDACTED]", redacted)
    redacted = re.sub(r"(/Users/)([^/\s]+)", r"\1[REDACTED]", redacted)
    redacted = re.sub(r"(C:\\Users\\)([^\\s\s]+)", r"\1[REDACTED]", redacted)
    # Gemini API keys: AIza + 35+ chars
    redacted = re.sub(r"AIza[A-Za-z0-9_-]{35,}", "[REDACTED]", redacted)
    # OpenAI-style keys: sk- + 20+ chars
    redacted = re.sub(r"sk-[A-Za-z0-9]{20,}", "[REDACTED]", redacted)
    # Bearer tokens
    redacted = re.sub(r"Bearer\s+\S+", "[REDACTED]", redacted)
    # Email addresses
    redacted = re.sub(r"[\w.+-]+@[\w-]+\.[\w.-]+", "[REDACTED]", redacted)
    # Hard-cap at 2000 chars
    if len(redacted) > 2000:
        redacted = redacted[:2000] + "… [truncated]"
    return redacted


def resolve_default_model(model: str | None) -> tuple[str, str]:
    explicit = model.strip() if isinstance(model, str) else ""
    if explicit:
        return explicit, "explicit-request"
    if CONFIGURED_DEFAULT_MODEL:
        return CONFIGURED_DEFAULT_MODEL, "runtime-config"
    return REPO_FALLBACK_MODEL, "repo-fallback"


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
        )
    ):
        return ErrorCategory.EXTERNAL_MODEL_AVAILABILITY
    return None


def normalize_timeout(raw: Any) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT
    if value < MIN_TIMEOUT:
        return DEFAULT_TIMEOUT
    return value


# ---------------------------------------------------------------------------
# Error envelope helpers
# ---------------------------------------------------------------------------


def _error_envelope(
    message: str,
    category: str = ErrorCategory.UNDETERMINED,
) -> dict[str, Any]:
    return {
        "success": False,
        "response": None,
        "data": None,
        "parsed": False,
        "model": None,
        "tokens": None,
        "latency_ms": None,
        "error": message,
        "error_category": category,
        "warnings": None,
    }


def attributed_error(category: str, message: str) -> dict[str, Any]:
    prefix = CATEGORY_PREFIX.get(category, CATEGORY_PREFIX[ErrorCategory.UNDETERMINED])
    return _error_envelope(f"{prefix}: {message}", category=category)


def attributed_uncertain_error(message: str) -> dict[str, Any]:
    return attributed_error(ErrorCategory.UNDETERMINED, message)


# ---------------------------------------------------------------------------
# Gemini binary resolution
# ---------------------------------------------------------------------------


def resolve_gemini_bin() -> str:
    env_bin = os.environ.get("GEMINI_BIN", "").strip()
    if env_bin:
        return env_bin
    which_bin = shutil.which("gemini")
    if which_bin:
        return which_bin
    return "/usr/bin/gemini"


GEMINI_BIN: str = resolve_gemini_bin()


# ---------------------------------------------------------------------------
# Gemini CLI invocation
# ---------------------------------------------------------------------------


def build_command(prompt: str, model: str, sandbox: bool) -> list[str]:
    cmd = [GEMINI_BIN, "--output-format", "json", "--model", model, "--prompt", prompt]
    if sandbox:
        cmd.append("--sandbox")
    return cmd


def run_gemini(
    *,
    prompt: str,
    model: str,
    json_mode: bool,
    sandbox: bool,
    timeout: int,
) -> dict[str, Any]:
    prompt_size = len(prompt.encode("utf-8"))
    if prompt_size > MAX_PROMPT_SIZE:
        return attributed_error(
            ErrorCategory.REQUEST,
            f"Prompt too large ({prompt_size} bytes, max {MAX_PROMPT_SIZE})",
        )

    effective_timeout = normalize_timeout(timeout)
    cmd = build_command(prompt, model, sandbox)
    logger.debug("Running Gemini CLI command: %r", cmd)
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=effective_timeout,
        )
    except subprocess.TimeoutExpired:
        return attributed_error(
            ErrorCategory.TIMEOUT,
            f"Timed out after {effective_timeout}s while running model {model}; "
            "the timeout signal alone does not distinguish local CLI/runtime slowdown "
            "from upstream Gemini latency. Subprocess was killed.",
        )
    except FileNotFoundError:
        return attributed_error(
            ErrorCategory.LOCAL_CLI,
            f"Gemini CLI not found at {GEMINI_BIN}",
        )
    except OSError as exc:
        return attributed_error(
            ErrorCategory.LOCAL_CLI,
            f"Failed to execute Gemini CLI at {GEMINI_BIN}: {exc}",
        )

    if result.returncode != 0:
        detail = _redact_stderr(result.stderr.strip()) if result.stderr and result.stderr.strip() else "no stderr output"
        category = classify_cli_exit(detail)
        if category is not None:
            return attributed_error(
                category,
                f"Gemini CLI exited with code {result.returncode} while using model "
                f"{model}: {detail}",
            )
        return attributed_uncertain_error(
            f"Gemini CLI exited with code {result.returncode} while using model "
            f"{model}: {detail}; stderr was not specific enough to attribute "
            "confidently to the local CLI/runtime or upstream Gemini"
        )

    stdout = result.stdout.strip()
    if not stdout:
        return attributed_error(ErrorCategory.LOCAL_CLI, "Gemini CLI returned empty output")
    try:
        envelope = json.loads(stdout)
    except json.JSONDecodeError as exc:
        return attributed_error(ErrorCategory.LOCAL_CLI, f"Failed to parse Gemini output: {exc}")

    raw_response = envelope.get("response", "")
    clean_response = strip_markdown_fences(raw_response)
    stats_info = extract_stats(envelope)
    warnings = _redact_stderr(result.stderr.strip()) if result.stderr and result.stderr.strip() else None
    output = {
        "success": True,
        "response": clean_response,
        "data": None,
        "parsed": False,
        "model": stats_info["model"],
        "tokens": stats_info["tokens"],
        "latency_ms": stats_info["latency_ms"],
        "error": None,
        "error_category": None,
        "warnings": warnings,
    }

    if json_mode:
        try:
            parsed_json = json.loads(clean_response)
            output["data"] = parsed_json
            output["parsed"] = True
        except (json.JSONDecodeError, TypeError):
            output["parsed"] = False
    return output


# ---------------------------------------------------------------------------
# MCP server / tools
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "gemini-gateway",
    instructions=(
        "Gemini Gateway MCP server (templestay) — invoke Google Gemini models "
        "via the local `gemini` CLI. `gemini_prompt` sends a prompt and returns "
        "a structured envelope with response text, optional JSON parsing, model/"
        "token/latency metadata, and error attribution. `gemini_models` lists "
        "known model identifiers. Read-only by contract: this gateway does not "
        "expose any write/apply tool."
    ),
)


@mcp.tool()
def gemini_prompt(
    prompt: str,
    model: str = "",
    json_mode: bool = False,
    sandbox: bool = False,
    timeout: int = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    """Send a prompt to a Gemini model and return a structured result."""
    effective_model, _ = resolve_default_model(model)
    if not effective_model:
        return attributed_error(
            ErrorCategory.REPO_CONFIG,
            "No Gemini model resolved (expected explicit request, propagated runtime config, or repo fallback)",
        )
    return run_gemini(
        prompt=prompt,
        model=effective_model,
        json_mode=json_mode,
        sandbox=sandbox,
        timeout=normalize_timeout(timeout),
    )


@mcp.tool()
def gemini_models() -> dict[str, Any]:
    """List known Gemini model identifiers available via the local CLI."""
    return {
        "models": list(KNOWN_MODELS),
        "default_model": DEFAULT_MODEL,
        "gemini_bin": GEMINI_BIN,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"[gemini-gateway-mcp {ts}] {msg}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    _log(f"Starting gemini-gateway MCP server (bin={GEMINI_BIN}, default_model={DEFAULT_MODEL})")
    mcp.run(transport="stdio")
