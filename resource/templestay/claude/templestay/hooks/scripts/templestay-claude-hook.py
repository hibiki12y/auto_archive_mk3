#!/usr/bin/env python3
"""Optional templestay Claude Code hardening hook.

Deliberately small. The Codex copilot-era hook took a heavier deny/warn/loop
posture; templestay keeps Claude's surface lighter so hooks remain optional
hardening rather than a correctness boundary.

Behavior by event:

- SessionStart:        emit a one-paragraph reminder that memory MCP is the
                       durable persistence target (auto-memory is off).
- UserPromptSubmit:    block obvious secret material in the prompt.
- PreToolUse (matched): block a small set of high-risk shell shapes and
                       forbidden secret-file reads.

Anything else: pass through.
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
    re.compile(r"\brm\s+-r[f]?\s+(?:/|~|\$HOME)"),
]


def _payload() -> dict[str, Any]:
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _event(payload: dict[str, Any]) -> str:
    raw = (
        payload.get("hook_event_name")
        or payload.get("hookEventName")
        or ""
    )
    return re.sub(r"[^a-z0-9]", "", str(raw).lower())


def _emit(obj: dict[str, Any]) -> None:
    print(json.dumps(obj, ensure_ascii=False))


def _session_start() -> None:
    _emit(
        {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": (
                    "templestay preset active. Auto-memory is off; the memory MCP "
                    "server is the durable cross-platform persistence target. If a "
                    "task may loop or run long, write a task-anchor capsule through "
                    "memory MCP rather than relying on local auto-memory."
                ),
            }
        }
    )


def _scan_prompt(payload: dict[str, Any]) -> None:
    prompt = str(payload.get("prompt") or "")
    for pattern in SECRET_PATTERNS:
        if pattern.search(prompt):
            _emit(
                {
                    "decision": "block",
                    "reason": (
                        "[templestay hook] Prompt appears to contain secret material. "
                        "Replace it with a redacted placeholder before submitting."
                    ),
                }
            )
            return


def _pre_tool(payload: dict[str, Any]) -> None:
    text = json.dumps(payload, ensure_ascii=False)
    for pattern in BLOCK_PATTERNS:
        if pattern.search(text):
            _emit(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": (
                            "templestay optional hardening blocked a high-risk action"
                        ),
                    }
                }
            )
            return


def main() -> None:
    payload = _payload()
    event = _event(payload)
    if event == "sessionstart":
        _session_start()
    elif event == "userpromptsubmit":
        _scan_prompt(payload)
    elif event == "pretooluse":
        _pre_tool(payload)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # Hooks are guardrails; never break Claude on a hook error.
        sys.exit(0)
