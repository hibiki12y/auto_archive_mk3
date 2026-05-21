#!/usr/bin/env python3
"""Verify HRM experiment ledger artifact hashes."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ledger",
        default="specs/ARCHIVE/hrm-experiment-ledger.json",
        help="Tracked HRM experiment ledger JSON.",
    )
    parser.add_argument(
        "--allow-missing",
        action="store_true",
        help="Report missing raw artifacts without failing. Useful on clean checkouts.",
    )
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    args = parse_args()
    ledger_path = Path(args.ledger)
    ledger: dict[str, Any] = json.loads(ledger_path.read_text(encoding="utf8"))
    failures: list[str] = []
    for entry in ledger.get("entries", []):
        artifact_path = Path(str(entry["path"]))
        expected = str(entry["sha256"])
        if not artifact_path.exists():
            message = f"missing artifact: {artifact_path}"
            if not args.allow_missing:
                failures.append(message)
            print(message)
            continue
        observed = sha256(artifact_path)
        if observed != expected:
            failures.append(
                f"hash mismatch for {artifact_path}: expected {expected}, observed {observed}"
            )
        else:
            print(f"ok {observed} {artifact_path}")
        metrics = entry.get("metrics")
        expected_checkpoint = (
            metrics.get("bestCheckpointSha256")
            if isinstance(metrics, dict)
            else None
        )
        if expected_checkpoint is None:
            continue
        try:
            artifact = json.loads(artifact_path.read_text(encoding="utf8"))
        except Exception as error:
            failures.append(f"failed to read summary for checkpoint verification: {artifact_path}: {error}")
            continue
        checkpoint = artifact.get("bestCheckpoint") if isinstance(artifact, dict) else None
        checkpoint_path_raw = (
            checkpoint.get("path")
            if isinstance(checkpoint, dict)
            else None
        )
        checkpoint_summary_sha = (
            checkpoint.get("sha256")
            if isinstance(checkpoint, dict)
            else None
        )
        if checkpoint_path_raw is None:
            failures.append(
                f"ledger expects best checkpoint sha for {artifact_path}, but summary has no bestCheckpoint.path"
            )
            continue
        if checkpoint_summary_sha != expected_checkpoint:
            failures.append(
                f"best checkpoint sha mismatch between ledger and summary for {artifact_path}: "
                f"ledger {expected_checkpoint}, summary {checkpoint_summary_sha}"
            )
        checkpoint_path = Path(str(checkpoint_path_raw))
        if not checkpoint_path.exists():
            message = f"missing best checkpoint: {checkpoint_path}"
            if not args.allow_missing:
                failures.append(message)
            print(message)
            continue
        observed_checkpoint = sha256(checkpoint_path)
        if observed_checkpoint != expected_checkpoint:
            failures.append(
                f"hash mismatch for {checkpoint_path}: expected {expected_checkpoint}, observed {observed_checkpoint}"
            )
        else:
            print(f"ok {observed_checkpoint} {checkpoint_path}")
    if failures:
        print("\n".join(failures))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
