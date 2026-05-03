#!/usr/bin/env python3
"""Optional templestay Codex hardening hook.

Hooks are guardrails only. They may block obvious secret material, destructive
shell shapes, and forbidden secret-file reads, but templestay correctness still
comes from instructions, MCP boundaries, and deterministic verification.
"""
from __future__ import annotations

import json
import re
import sys
from typing import Any

SECRET_PATTERNS = [
    re.compile(r"-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
]

BLOCK_PATTERNS = [
    re.compile(r"Read\(\./\.env\b"),
    re.compile(r"\.env(?:\.|\b)"),
    re.compile(r"\b(?:id_rsa|id_ed25519|id_ecdsa)\b"),
    re.compile(r"\brm\s+-r[f]?\s+(?:/|~|\$HOME)"),
    re.compile(r"\bgit\s+push\s+--force\b"),
]


def _payload() -> dict[str, Any]:
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _event(payload: dict[str, Any]) -> str:
    raw = payload.get("hook_event_name") or payload.get("hookEventName") or ""
    return re.sub(r"[^a-z0-9]", "", str(raw).lower())


def _emit(obj: dict[str, Any]) -> None:
    print(json.dumps(obj, ensure_ascii=False))


def _allow(extra: dict[str, Any] | None = None) -> None:
    out = {"continue": True}
    if extra:
        out.update(extra)
    _emit(out)


def _block(reason: str) -> None:
    _emit({"continue": False, "stopReason": reason})


def _session_start() -> None:
    _allow(
        {
            "additionalContext": (
                "templestay preset active. Codex built-in memories are disabled; "
                "memory MCP is the durable cross-platform persistence target. "
                "For looping or long-running tasks, write a task-anchor capsule."
            )
        }
    )


def _scan_prompt(payload: dict[str, Any]) -> None:
    prompt = str(payload.get("prompt") or "")
    for pattern in SECRET_PATTERNS:
        if pattern.search(prompt):
            _block(
                "[templestay hook] Prompt appears to contain secret material. "
                "Replace it with a redacted placeholder before submitting."
            )
            return
    _allow()


def _pre_tool(payload: dict[str, Any]) -> None:
    text = json.dumps(payload, ensure_ascii=False)
    for pattern in SECRET_PATTERNS + BLOCK_PATTERNS:
        if pattern.search(text):
            _block("templestay optional hardening blocked a high-risk action")
            return
    _allow()


def main() -> None:
    payload = _payload()
    event = _event(payload)
    if event == "sessionstart":
        _session_start()
    elif event == "userpromptsubmit":
        _scan_prompt(payload)
    elif event == "pretooluse":
        _pre_tool(payload)
    else:
        _allow()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # Hooks are optional guardrails; never break Codex on hook errors.
        sys.exit(0)
