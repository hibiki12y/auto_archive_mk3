import json
import os
import re
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from mcp.server.fastmcp import FastMCP

MAX_RESULT_SIZE_CHARS = 50_000
PREVIEW_SIZE_BYTES = 2_000
MAX_RESULTS_PER_MESSAGE_CHARS = 200_000

DEFAULT_RESULTS_BASE_DIR = "~/.copilot/session-state"
SESSION_TOOL_RESULTS_DIRNAME = "tool-results"
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9._-]+$")

mcp = FastMCP("context-manager")


def _results_base_dir() -> Path:
    """One-line description for _results_base_dir."""
    return Path(os.path.expanduser(os.getenv("RESULTS_BASE_DIR", DEFAULT_RESULTS_BASE_DIR)))


def _normalize_session_id(session_id: Optional[str]) -> str:
    """One-line description for _normalize_session_id."""
    value = session_id or "default"
    if not IDENTIFIER_RE.fullmatch(value):
        raise ValueError("session_id must contain only letters, numbers, dot, underscore, or hyphen")
    return value


def _normalize_result_id(result_id: str) -> str:
    """One-line description for _normalize_result_id."""
    if not result_id or not IDENTIFIER_RE.fullmatch(result_id):
        raise ValueError("result_id must contain only letters, numbers, dot, underscore, or hyphen")
    return result_id


def _session_results_dir(session_id: Optional[str]) -> Path:
    """One-line description for _session_results_dir."""
    session_dir = _results_base_dir() / _normalize_session_id(session_id) / SESSION_TOOL_RESULTS_DIRNAME
    os.makedirs(session_dir, exist_ok=True)
    return session_dir


def _result_paths(result_id: str, session_id: Optional[str]) -> tuple[Path, Path]:
    """One-line description for _result_paths."""
    normalized_result_id = _normalize_result_id(result_id)
    results_dir = _session_results_dir(session_id)
    return (
        results_dir / f"{normalized_result_id}.txt",
        results_dir / f"{normalized_result_id}.meta.json",
    )


def _generate_result_id() -> str:
    """One-line description for _generate_result_id."""
    return uuid.uuid4().hex[:8]


def _create_preview(content: str) -> str:
    """One-line description for _create_preview."""
    raw = content.encode("utf-8")
    if len(raw) <= PREVIEW_SIZE_BYTES:
        return content

    preview_bytes = raw[:PREVIEW_SIZE_BYTES]
    newline_index = preview_bytes.rfind(b"\n")
    if newline_index > 0:
        preview_bytes = preview_bytes[: newline_index + 1]

    return preview_bytes.decode("utf-8", errors="ignore")


def _read_metadata(meta_path: Path) -> dict:
    """One-line description for _read_metadata."""
    if not meta_path.exists():
        return {}
    with meta_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _count_lines(content: str) -> int:
    """One-line description for _count_lines."""
    if not content:
        return 0
    return content.count("\n") + (0 if content.endswith("\n") else 1)


def _slice_lines(content: str, start_line: Optional[int], end_line: Optional[int]) -> tuple[str, int, list[int]]:
    """One-line description for _slice_lines."""
    lines = content.splitlines()
    total_lines = len(lines)

    if start_line is None and end_line is None:
        return content, total_lines, [1, total_lines] if total_lines else [0, 0]

    start = 1 if start_line is None else start_line
    end = total_lines if end_line is None else end_line

    if start < 1:
        raise ValueError("start_line must be >= 1")
    if end < start:
        raise ValueError("end_line must be >= start_line")

    bounded_start = min(start, total_lines + 1)
    bounded_end = min(end, total_lines)

    if total_lines == 0 or bounded_start > bounded_end:
        return "", total_lines, [bounded_start, bounded_end]

    selected = "\n".join(lines[bounded_start - 1 : bounded_end])
    if content.endswith("\n") and bounded_end == total_lines:
        selected += "\n"
    return selected, total_lines, [bounded_start, bounded_end]


@mcp.tool()
def store_result(tool_name: str, content: str, session_id: Optional[str] = None) -> dict:
    """Store a tool result on disk and return its identifier and preview."""
    try:
        results_dir = _session_results_dir(session_id)
        result_id = _generate_result_id()
        result_path = results_dir / f"{result_id}.txt"
        meta_path = results_dir / f"{result_id}.meta.json"

        result_path.write_text(content, encoding="utf-8")

        metadata = {
            "tool_name": tool_name,
            "size_chars": len(content),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")

        return {
            "result_id": result_id,
            "path": str(result_path),
            "size_chars": len(content),
            "preview": _create_preview(content),
        }
    except Exception as exc:
        return {"error": str(exc)}


@mcp.tool()
def retrieve_result(
    result_id: str,
    start_line: Optional[int] = None,
    end_line: Optional[int] = None,
    session_id: Optional[str] = None,
) -> dict:
    """Retrieve a stored tool result, optionally limited to a 1-indexed line range."""
    try:
        result_path, _ = _result_paths(result_id, session_id)
        if not result_path.exists():
            return {"error": f"Result not found: {result_id}"}

        content = result_path.read_text(encoding="utf-8")
        selected_content, total_lines, returned_lines_range = _slice_lines(content, start_line, end_line)

        response = {
            "result_id": _normalize_result_id(result_id),
            "content": selected_content,
            "total_lines": total_lines,
            "returned_lines_range": returned_lines_range,
        }
        if start_line is None and end_line is None and len(selected_content) > MAX_RESULT_SIZE_CHARS:
            # Self-limiting: truncate and save full content path
            truncated = selected_content[:MAX_RESULT_SIZE_CHARS]
            last_nl = truncated.rfind("\n")
            if last_nl > MAX_RESULT_SIZE_CHARS * 0.8:
                truncated = truncated[:last_nl]
            response["content"] = truncated
            response["truncated"] = True
            response["warning"] = (
                f"Output truncated at {MAX_RESULT_SIZE_CHARS:,} characters. "
                f"Full content ({len(selected_content):,} chars) available at: {result_path}. "
                "Use retrieve_result with start_line/end_line for range access."
            )
        return response
    except Exception as exc:
        return {"error": str(exc)}


@mcp.tool()
def list_results(session_id: Optional[str] = None) -> dict:
    """List stored tool results for a session."""
    try:
        results_dir = _session_results_dir(session_id)
        results = []
        total_size_chars = 0

        for meta_path in sorted(results_dir.glob("*.meta.json")):
            result_id = meta_path.name[: -len(".meta.json")]
            metadata = _read_metadata(meta_path)
            size_chars = int(metadata.get("size_chars", 0))
            total_size_chars += size_chars
            results.append(
                {
                    "result_id": result_id,
                    "tool_name": metadata.get("tool_name", "unknown"),
                    "size_chars": size_chars,
                    "created_at": metadata.get("created_at"),
                }
            )

        return {
            "results": results,
            "total_count": len(results),
            "total_size_chars": total_size_chars,
        }
    except Exception as exc:
        return {"error": str(exc)}


@mcp.tool()
def session_stats(session_id: Optional[str] = None) -> dict:
    """Return aggregate statistics for stored tool results in a session."""
    try:
        results_dir = _session_results_dir(session_id)
        results = []
        tool_counter: Counter[str] = Counter()

        for meta_path in results_dir.glob("*.meta.json"):
            result_id = meta_path.name[: -len(".meta.json")]
            metadata = _read_metadata(meta_path)
            tool_name = metadata.get("tool_name", "unknown")
            size_chars = int(metadata.get("size_chars", 0))
            tool_counter[tool_name] += 1
            results.append(
                {
                    "result_id": result_id,
                    "tool_name": tool_name,
                    "size_chars": size_chars,
                    "created_at": metadata.get("created_at"),
                }
            )

        total_size_chars = sum(item["size_chars"] for item in results)
        largest_result = max(results, key=lambda item: item["size_chars"], default=None)

        return {
            "total_results": len(results),
            "total_size_chars": total_size_chars,
            "total_size_mb": round(total_size_chars / (1024 * 1024), 4),
            "largest_result": largest_result,
            "results_by_tool": dict(tool_counter),
        }
    except Exception as exc:
        return {"error": str(exc)}


if __name__ == "__main__":
    mcp.run()
