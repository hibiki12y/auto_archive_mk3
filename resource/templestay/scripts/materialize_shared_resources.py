#!/usr/bin/env python3
"""Materialize shared templestay resources into platform-native surfaces.

The repository keeps the source-of-truth for portable Claude/Codex content
under ``shared/templestay``.  This script renders those templates into the
files consumed by the Claude Code plugin and Codex CLI package.

It intentionally uses a tiny template language:

``{{include:relative/path.md}}``
    Inline a file relative to ``shared/templestay``.

No conditionals or arbitrary code are supported; platform-specific content
belongs in platform-specific templates in ``shared/templestay``.
"""
from __future__ import annotations

import argparse
import difflib
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHARED = ROOT / "shared" / "templestay"


@dataclass(frozen=True)
class RenderTarget:
    platform: str
    template: Path
    output: Path


TARGETS: tuple[RenderTarget, ...] = (
    RenderTarget("claude", SHARED / "instructions" / "CLAUDE.md.in", ROOT / "claude" / "templestay" / "CLAUDE.md"),
    RenderTarget("codex", SHARED / "instructions" / "AGENTS.md.in", ROOT / "codex" / "templestay" / "AGENTS.md"),
    RenderTarget("claude", SHARED / "skills" / "templestay-memory" / "SKILL.md.in", ROOT / "claude" / "templestay" / "skills" / "templestay-memory" / "SKILL.md"),
    RenderTarget("codex", SHARED / "skills" / "templestay-memory" / "SKILL.md.in", ROOT / "codex" / "templestay" / "skills" / "templestay-memory" / "SKILL.md"),
    RenderTarget("claude", SHARED / "skills" / "templestay-verification" / "SKILL.md.in", ROOT / "claude" / "templestay" / "skills" / "templestay-verification" / "SKILL.md"),
    RenderTarget("codex", SHARED / "skills" / "templestay-verification" / "CODEX.SKILL.md.in", ROOT / "codex" / "templestay" / "skills" / "templestay-verification" / "SKILL.md"),
    RenderTarget("claude", SHARED / "skills" / "templestay-research" / "SKILL.md.in", ROOT / "claude" / "templestay" / "skills" / "templestay-research" / "SKILL.md"),
    RenderTarget("codex", SHARED / "skills" / "templestay-research" / "SKILL.md.in", ROOT / "codex" / "templestay" / "skills" / "templestay-research" / "SKILL.md"),
    RenderTarget("claude", SHARED / "skills" / "templestay-deep-think" / "SKILL.md.in", ROOT / "claude" / "templestay" / "skills" / "templestay-deep-think" / "SKILL.md"),
    RenderTarget("codex", SHARED / "skills" / "templestay-deep-think" / "SKILL.md.in", ROOT / "codex" / "templestay" / "skills" / "templestay-deep-think" / "SKILL.md"),
    RenderTarget("claude", SHARED / "skills" / "templestay-memory-consolidation" / "SKILL.md.in", ROOT / "claude" / "templestay" / "skills" / "templestay-memory-consolidation" / "SKILL.md"),
    RenderTarget("codex", SHARED / "skills" / "templestay-memory-consolidation" / "SKILL.md.in", ROOT / "codex" / "templestay" / "skills" / "templestay-memory-consolidation" / "SKILL.md"),
)


def render(path: Path, stack: tuple[Path, ...] = ()) -> str:
    """Render one template file with ``{{include:...}}`` support."""
    if path in stack:
        cycle = " -> ".join(str(p.relative_to(SHARED)) for p in (*stack, path))
        raise RuntimeError(f"include cycle detected: {cycle}")
    text = path.read_text(encoding="utf-8")
    out: list[str] = []
    cursor = 0
    marker_open = "{{include:"
    marker_close = "}}"
    while True:
        start = text.find(marker_open, cursor)
        if start == -1:
            out.append(text[cursor:])
            break
        out.append(text[cursor:start])
        end = text.find(marker_close, start)
        if end == -1:
            raise RuntimeError(f"unterminated include marker in {path}")
        rel = text[start + len(marker_open): end].strip()
        include_path = (SHARED / rel).resolve()
        try:
            include_path.relative_to(SHARED.resolve())
        except ValueError as exc:
            raise RuntimeError(f"include escapes shared root in {path}: {rel}") from exc
        out.append(render(include_path, (*stack, path)))
        cursor = end + len(marker_close)
    rendered = "".join(out)
    if not rendered.endswith("\n"):
        rendered += "\n"
    return rendered


def selected_targets(platform: str) -> list[RenderTarget]:
    if platform == "all":
        return list(TARGETS)
    return [target for target in TARGETS if target.platform == platform]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=("all", "claude", "codex"), default="all")
    parser.add_argument("--check", action="store_true", help="fail if generated files are stale")
    parser.add_argument("--dry-run", action="store_true", help="print planned writes without changing files")
    parser.add_argument("--diff", action="store_true", help="print unified diffs for stale files")
    args = parser.parse_args()

    stale: list[tuple[RenderTarget, str, str]] = []
    changed: list[RenderTarget] = []
    targets = selected_targets(args.target)
    for target in targets:
        desired = render(target.template)
        current = target.output.read_text(encoding="utf-8") if target.output.exists() else ""
        if current != desired:
            stale.append((target, current, desired))
            if not args.check and not args.dry_run:
                target.output.parent.mkdir(parents=True, exist_ok=True)
                target.output.write_text(desired, encoding="utf-8")
                changed.append(target)

    if args.check:
        if stale:
            print("shared resource materialization check failed:")
            for target, current, desired in stale:
                print(f"  stale: {target.output.relative_to(ROOT)} <- {target.template.relative_to(ROOT)}")
                if args.diff:
                    print(
                        "".join(
                            difflib.unified_diff(
                                current.splitlines(keepends=True),
                                desired.splitlines(keepends=True),
                                fromfile=str(target.output.relative_to(ROOT)),
                                tofile=str(target.template.relative_to(ROOT)),
                            )
                        ),
                        end="",
                    )
            return 1
        print(f"shared resource materialization check passed ({len(targets)} files)")
        return 0

    if args.dry_run:
        if stale:
            print("dry-run: would refresh shared materialized resources:")
            for target, _, _ in stale:
                print(f"  {target.output.relative_to(ROOT)} <- {target.template.relative_to(ROOT)}")
        else:
            print(f"dry-run: shared materialized resources already current ({len(targets)} files)")
        return 0

    if changed:
        print("materialized shared templestay resources:")
        for target in changed:
            print(f"  {target.output.relative_to(ROOT)} <- {target.template.relative_to(ROOT)}")
    else:
        print(f"shared templestay resources already current ({len(targets)} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
