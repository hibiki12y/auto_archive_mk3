#!/usr/bin/env python3
"""Small-GPU HRM-style long-duration maze reasoning experiment.

Research target: arXiv:2506.21734 "Hierarchical Reasoning Model" (HRM).

This is not an HRM reproduction. It is a bounded Auto Archive research harness
that makes the HRM idea runnable on modest GPUs:

- two recurrent modules with different timescales (high-level / low-level);
- a one-step-gradient mode inspired by the HRM pseudocode;
- synthetic 2D maze shortest-path supervision, no downloads or secrets;
- periodic JSONL metrics and a final JSON summary for long-run evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import torch
from torch import nn
import torch.nn.functional as F


HRM_ARXIV_URL = "https://arxiv.org/abs/2506.21734"
GATE_SATURATION_LOW = 0.05
GATE_SATURATION_HIGH = 0.95


@dataclass(frozen=True)
class MazeExample:
    tokens: list[int]
    path_mask: list[int]
    path_length: int


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration-sec", type=int, default=600)
    parser.add_argument("--max-steps", type=int, default=0)
    parser.add_argument("--eval-every-sec", type=int, default=60)
    parser.add_argument("--grid-size", type=int, default=8)
    parser.add_argument("--wall-prob", type=float, default=0.22)
    parser.add_argument("--train-samples", type=int, default=1024)
    parser.add_argument("--eval-samples", type=int, default=256)
    parser.add_argument(
        "--val-samples",
        type=int,
        default=None,
        help="Validation examples for threshold/selection tuning. Defaults to --eval-samples.",
    )
    parser.add_argument(
        "--test-samples",
        type=int,
        default=None,
        help="Held-out test examples for final reporting. Defaults to --eval-samples.",
    )
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--d-model", type=int, default=96)
    parser.add_argument("--n-heads", type=int, default=4)
    parser.add_argument("--cycles", type=int, default=4)
    parser.add_argument("--low-steps", type=int, default=4)
    parser.add_argument("--fusion-mode", choices=("add", "gated"), default="add")
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-2)
    parser.add_argument("--seed", type=int, default=20260621)
    parser.add_argument("--device-index", type=int, default=None)
    parser.add_argument("--min-free-memory-mib", type=int, default=1024)
    parser.add_argument("--min-compute-capability", type=float, default=7.5)
    parser.add_argument(
        "--full-bptt",
        action="store_true",
        help="Backpropagate through every recurrent step. Default uses HRM-style one-step gradient.",
    )
    parser.add_argument("--write", nargs="?", const="", default=None)
    parser.add_argument("--metrics-jsonl", default=None)
    parser.add_argument(
        "--no-retain-best-weights",
        dest="retain_best_weights",
        action="store_false",
        default=True,
        help=(
            "Disable in-memory retention of the best validation checkpoint. "
            "By default the harness keeps the best weights and reports selectedTestEval."
        ),
    )
    parser.add_argument(
        "--save-best-checkpoint",
        nargs="?",
        const="",
        default=None,
        help=(
            "Optionally write the retained best validation checkpoint. "
            "With no path, uses the summary path with .best.pt suffix."
        ),
    )
    parser.add_argument(
        "--thresholds",
        default="0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9",
        help="Comma-separated probability thresholds for path-mask calibration.",
    )
    parser.add_argument("--variant-tag", default="hrm-lite-additive")
    parser.add_argument(
        "--research-question",
        default=(
            "Can a small-GPU HRM-inspired recurrent model sustain maze "
            "reasoning training with periodic evaluation?"
        ),
    )
    parser.add_argument(
        "--hypothesis",
        default=(
            "Hierarchical high/low recurrent updates with one-step gradients "
            "can run stably on modest GPUs and produce interpretable path-mask metrics."
        ),
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_args([arg for arg in sys.argv[1:] if arg != "--"])


def default_summary_path(generated_at: str) -> Path:
    safe = generated_at.replace(":", "-").replace(".", "-")
    return Path("results/hrm-small-gpu-longrun") / f"hrm-longrun-{safe}.json"


def default_metrics_path(summary_path: Path) -> Path:
    return summary_path.with_suffix(".metrics.jsonl")


def default_best_checkpoint_path(summary_path: Path) -> Path:
    return summary_path.with_suffix(".best.pt")


def parse_thresholds(raw: str) -> list[float]:
    thresholds: list[float] = []
    for item in raw.split(","):
        text = item.strip()
        if not text:
            continue
        value = float(text)
        if not 0.0 < value < 1.0:
            raise ValueError(f"threshold must be in (0, 1); received {value}")
        thresholds.append(value)
    if not thresholds:
        raise ValueError("--thresholds must contain at least one threshold")
    return sorted(set(thresholds))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def preflight_writable_artifact_path(path: Path, label: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    probe = path.parent / f".{path.name}.write-test"
    try:
        with probe.open("wb") as handle:
            handle.write(b"")
    finally:
        probe.unlink(missing_ok=True)
    if path.exists():
        print(f"warning: {label} will overwrite existing artifact: {path}", file=sys.stderr)


def clone_state_dict_for_cpu(model: nn.Module) -> dict[str, torch.Tensor]:
    return {
        name: tensor.detach().cpu().clone()
        for name, tensor in model.state_dict().items()
    }


def select_device(
    min_free_memory_mib: int,
    min_compute_capability: float,
    requested_index: int | None,
) -> int:
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available to PyTorch.")
    candidates = (
        [requested_index]
        if requested_index is not None
        else list(range(torch.cuda.device_count()))
    )
    for index in candidates:
        if index is None:
            continue
        major, minor = torch.cuda.get_device_capability(index)
        compute_capability = major + minor / 10
        free_bytes, _total_bytes = torch.cuda.mem_get_info(index)
        free_mib = free_bytes // (1024 * 1024)
        if (
            free_mib >= min_free_memory_mib
            and compute_capability >= min_compute_capability
        ):
            return index
    raise RuntimeError(
        "No CUDA device satisfies "
        f"free_memory>={min_free_memory_mib}MiB and "
        f"compute_capability>={min_compute_capability}."
    )


def shortest_path(
    walls: list[list[bool]],
    start: tuple[int, int],
    goal: tuple[int, int],
) -> list[tuple[int, int]] | None:
    n = len(walls)
    parent: dict[tuple[int, int], tuple[int, int] | None] = {start: None}
    queue: deque[tuple[int, int]] = deque([start])
    while queue:
        r, c = queue.popleft()
        if (r, c) == goal:
            break
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nr, nc = r + dr, c + dc
            if (
                0 <= nr < n
                and 0 <= nc < n
                and not walls[nr][nc]
                and (nr, nc) not in parent
            ):
                parent[(nr, nc)] = (r, c)
                queue.append((nr, nc))
    if goal not in parent:
        return None
    path: list[tuple[int, int]] = []
    cur: tuple[int, int] | None = goal
    while cur is not None:
        path.append(cur)
        cur = parent[cur]
    path.reverse()
    return path


def generate_maze_example(n: int, wall_prob: float, rng: random.Random) -> MazeExample:
    start = (0, 0)
    goal = (n - 1, n - 1)
    min_path_len = max(n, (2 * n) - 2)
    for _attempt in range(10_000):
        walls = [
            [rng.random() < wall_prob for _c in range(n)]
            for _r in range(n)
        ]
        walls[start[0]][start[1]] = False
        walls[goal[0]][goal[1]] = False
        path = shortest_path(walls, start, goal)
        if path is None or len(path) < min_path_len:
            continue
        path_set = set(path)
        tokens: list[int] = []
        path_mask: list[int] = []
        for r in range(n):
            for c in range(n):
                if (r, c) == start:
                    tokens.append(2)
                elif (r, c) == goal:
                    tokens.append(3)
                elif walls[r][c]:
                    tokens.append(1)
                else:
                    tokens.append(0)
                path_mask.append(1 if (r, c) in path_set else 0)
        return MazeExample(tokens=tokens, path_mask=path_mask, path_length=len(path))
    raise RuntimeError("Failed to generate a solvable maze dataset sample.")


def generate_dataset(
    samples: int,
    grid_size: int,
    wall_prob: float,
    seed: int,
) -> tuple[torch.Tensor, torch.Tensor, list[int]]:
    rng = random.Random(seed)
    examples = [generate_maze_example(grid_size, wall_prob, rng) for _ in range(samples)]
    x = torch.tensor([example.tokens for example in examples], dtype=torch.long)
    y = torch.tensor([example.path_mask for example in examples], dtype=torch.long)
    path_lengths = [example.path_length for example in examples]
    return x, y, path_lengths


class TinyTransformerBlock(nn.Module):
    def __init__(self, d_model: int, n_heads: int) -> None:
        super().__init__()
        self.ln1 = nn.LayerNorm(d_model)
        self.attn = nn.MultiheadAttention(
            embed_dim=d_model,
            num_heads=n_heads,
            batch_first=True,
        )
        self.ln2 = nn.LayerNorm(d_model)
        self.mlp = nn.Sequential(
            nn.Linear(d_model, 4 * d_model),
            nn.SiLU(),
            nn.Linear(4 * d_model, d_model),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.ln1(x)
        attn, _weights = self.attn(y, y, y, need_weights=False)
        x = x + attn
        x = x + self.mlp(self.ln2(x))
        return x


class HRMLiteMazeModel(nn.Module):
    def __init__(
        self,
        seq_len: int,
        d_model: int,
        n_heads: int,
        cycles: int,
        low_steps: int,
        one_step_gradient: bool,
        fusion_mode: str,
    ) -> None:
        super().__init__()
        self.cycles = cycles
        self.low_steps = low_steps
        self.one_step_gradient = one_step_gradient
        self.fusion_mode = fusion_mode
        self.token = nn.Embedding(4, d_model)
        self.position = nn.Embedding(seq_len, d_model)
        self.z_h0 = nn.Parameter(torch.zeros(1, seq_len, d_model))
        self.z_l0 = nn.Parameter(torch.zeros(1, seq_len, d_model))
        self.low = TinyTransformerBlock(d_model, n_heads)
        self.high = TinyTransformerBlock(d_model, n_heads)
        if fusion_mode == "gated":
            self.low_gate = nn.Linear(3 * d_model, d_model)
            self.high_gate = nn.Linear(2 * d_model, d_model)
        elif fusion_mode != "add":
            raise ValueError(f"unknown fusion_mode: {fusion_mode}")
        self.head = nn.Sequential(nn.LayerNorm(d_model), nn.Linear(d_model, 2))
        self._gate_stats_enabled = False
        self._gate_stats: list[dict[str, float | str]] = []

    def set_gate_stats_enabled(self, enabled: bool) -> None:
        self._gate_stats_enabled = enabled
        self._gate_stats = []

    def consume_gate_stats(self) -> list[dict[str, float | str]]:
        stats = self._gate_stats
        self._gate_stats = []
        return stats

    def record_gate_stats(self, name: str, gate: torch.Tensor) -> None:
        if not self._gate_stats_enabled:
            return
        detached = gate.detach().float()
        entropy = -(
            detached.clamp(1e-6, 1.0 - 1e-6)
            * torch.log2(detached.clamp(1e-6, 1.0 - 1e-6))
            + (1.0 - detached).clamp(1e-6, 1.0 - 1e-6)
            * torch.log2((1.0 - detached).clamp(1e-6, 1.0 - 1e-6))
        )
        self._gate_stats.append(
            {
                "name": name,
                "mean": float(detached.mean().cpu()),
                "std": float(detached.std(unbiased=False).cpu()),
                "min": float(detached.min().cpu()),
                "max": float(detached.max().cpu()),
                "saturationLowPct": float(
                    (detached <= GATE_SATURATION_LOW).float().mean().cpu()
                ),
                "saturationHighPct": float(
                    (detached >= GATE_SATURATION_HIGH).float().mean().cpu()
                ),
                "entropyBitsMean": float(entropy.mean().cpu()),
            }
        )

    def fuse_low(self, z_l: torch.Tensor, z_h: torch.Tensor, x: torch.Tensor) -> torch.Tensor:
        if self.fusion_mode == "add":
            return z_l + z_h + x
        gate = torch.sigmoid(self.low_gate(torch.cat([z_l, z_h, x], dim=-1)))
        self.record_gate_stats("low", gate)
        return z_l + gate * z_h + (1.0 - gate) * x

    def fuse_high(self, z_h: torch.Tensor, z_l: torch.Tensor) -> torch.Tensor:
        if self.fusion_mode == "add":
            return z_h + z_l
        gate = torch.sigmoid(self.high_gate(torch.cat([z_h, z_l], dim=-1)))
        self.record_gate_stats("high", gate)
        return z_h + gate * z_l

    def low_update(self, z_l: torch.Tensor, z_h: torch.Tensor, x: torch.Tensor) -> torch.Tensor:
        return self.low(self.fuse_low(z_l, z_h, x))

    def high_update(self, z_h: torch.Tensor, z_l: torch.Tensor) -> torch.Tensor:
        return self.high(self.fuse_high(z_h, z_l))

    def forward(self, tokens: torch.Tensor) -> torch.Tensor:
        batch, seq_len = tokens.shape
        positions = torch.arange(seq_len, device=tokens.device).unsqueeze(0)
        x = self.token(tokens) + self.position(positions)
        z_h = self.z_h0.expand(batch, -1, -1)
        z_l = self.z_l0.expand(batch, -1, -1)

        if self.one_step_gradient:
            with torch.no_grad():
                total_steps = (self.cycles * self.low_steps) - 1
                for step in range(total_steps):
                    z_l = self.low_update(z_l, z_h, x)
                    if (step + 1) % self.low_steps == 0:
                        z_h = self.high_update(z_h, z_l)
            z_l = self.low_update(z_l, z_h, x)
            z_h = self.high_update(z_h, z_l)
        else:
            for cycle in range(self.cycles):
                for _step in range(self.low_steps):
                    z_l = self.low_update(z_l, z_h, x)
                if cycle < self.cycles - 1:
                    z_h = self.high_update(z_h, z_l)
            z_h = self.high_update(z_h, z_l)
        return self.head(z_h)


def take_batch(
    x: torch.Tensor,
    y: torch.Tensor,
    batch_size: int,
    device: torch.device,
) -> tuple[torch.Tensor, torch.Tensor]:
    idx = torch.randint(0, x.shape[0], (batch_size,))
    return x[idx].to(device), y[idx].to(device)


@torch.no_grad()
def evaluate(
    model: HRMLiteMazeModel,
    x: torch.Tensor,
    y: torch.Tensor,
    path_lengths: list[int],
    batch_size: int,
    device: torch.device,
    class_weights: torch.Tensor,
    grid_size: int,
    thresholds: list[float],
    fixed_threshold: float | None = None,
    split_name: str = "validation",
) -> dict[str, Any]:
    model.eval()
    losses: list[float] = []
    total = 0
    correct = 0
    tp = 0
    fp = 0
    fn = 0
    threshold_counts = {
        threshold: {"tp": 0, "fp": 0, "fn": 0, "intersection": 0, "union": 0}
        for threshold in thresholds
    }
    bucket_counts: dict[str, dict[str, int]] = {
        "short": {"examples": 0, "tp": 0, "fp": 0, "fn": 0},
        "medium": {"examples": 0, "tp": 0, "fp": 0, "fn": 0},
        "long": {"examples": 0, "tp": 0, "fp": 0, "fn": 0},
    }
    gate_records: list[dict[str, float | str]] = []
    if hasattr(model, "set_gate_stats_enabled"):
        model.set_gate_stats_enabled(model.fusion_mode == "gated")
    for start in range(0, x.shape[0], batch_size):
        xb = x[start : start + batch_size].to(device)
        yb = y[start : start + batch_size].to(device)
        logits = model(xb)
        gate_records.extend(model.consume_gate_stats())
        loss = F.cross_entropy(
            logits.view(-1, 2),
            yb.reshape(-1),
            weight=class_weights,
        )
        pred = logits.argmax(dim=-1)
        probs = torch.softmax(logits, dim=-1)[..., 1]
        losses.append(float(loss.detach().cpu()))
        total += int(yb.numel())
        correct += int((pred == yb).sum().detach().cpu())
        tp += int(((pred == 1) & (yb == 1)).sum().detach().cpu())
        fp += int(((pred == 1) & (yb == 0)).sum().detach().cpu())
        fn += int(((pred == 0) & (yb == 1)).sum().detach().cpu())

        for threshold in thresholds:
            threshold_pred = probs >= threshold
            y_positive = yb == 1
            threshold_counts[threshold]["tp"] += int(
                (threshold_pred & y_positive).sum().detach().cpu()
            )
            threshold_counts[threshold]["fp"] += int(
                (threshold_pred & ~y_positive).sum().detach().cpu()
            )
            threshold_counts[threshold]["fn"] += int(
                (~threshold_pred & y_positive).sum().detach().cpu()
            )
            threshold_counts[threshold]["intersection"] += int(
                (threshold_pred & y_positive).sum().detach().cpu()
            )
            threshold_counts[threshold]["union"] += int(
                (threshold_pred | y_positive).sum().detach().cpu()
            )

        for sample_index, path_length in enumerate(path_lengths[start : start + xb.shape[0]]):
            if path_length <= grid_size:
                bucket = "short"
            elif path_length <= 2 * grid_size:
                bucket = "medium"
            else:
                bucket = "long"
            pred_sample = pred[sample_index]
            y_sample = yb[sample_index]
            bucket_counts[bucket]["examples"] += 1
            bucket_counts[bucket]["tp"] += int(
                ((pred_sample == 1) & (y_sample == 1)).sum().detach().cpu()
            )
            bucket_counts[bucket]["fp"] += int(
                ((pred_sample == 1) & (y_sample == 0)).sum().detach().cpu()
            )
            bucket_counts[bucket]["fn"] += int(
                ((pred_sample == 0) & (y_sample == 1)).sum().detach().cpu()
            )
    if hasattr(model, "set_gate_stats_enabled"):
        model.set_gate_stats_enabled(False)
    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)
    f1 = 2 * precision * recall / max(1e-12, precision + recall)
    iou = tp / max(1, tp + fp + fn)
    sweep: list[dict[str, float]] = []
    for threshold, counts in threshold_counts.items():
        threshold_precision = counts["tp"] / max(1, counts["tp"] + counts["fp"])
        threshold_recall = counts["tp"] / max(1, counts["tp"] + counts["fn"])
        threshold_f1 = (
            2
            * threshold_precision
            * threshold_recall
            / max(1e-12, threshold_precision + threshold_recall)
        )
        threshold_iou = counts["intersection"] / max(1, counts["union"])
        sweep.append(
            {
                "threshold": threshold,
                "pathPrecision": threshold_precision,
                "pathRecall": threshold_recall,
                "pathF1": threshold_f1,
                "pathIoU": threshold_iou,
            }
        )
    best_threshold = max(
        sweep,
        key=lambda item: (item["pathF1"], -abs(item["threshold"] - 0.5)),
    )

    bucket_metrics: dict[str, dict[str, float | int]] = {}
    for bucket, counts in bucket_counts.items():
        bucket_precision = counts["tp"] / max(1, counts["tp"] + counts["fp"])
        bucket_recall = counts["tp"] / max(1, counts["tp"] + counts["fn"])
        bucket_f1 = (
            2
            * bucket_precision
            * bucket_recall
            / max(1e-12, bucket_precision + bucket_recall)
        )
        bucket_metrics[bucket] = {
            "examples": counts["examples"],
            "pathPrecision": bucket_precision,
            "pathRecall": bucket_recall,
            "pathF1": bucket_f1,
            "supportOk": counts["examples"] >= 30,
        }

    gate_stats: dict[str, dict[str, float | int]] = {}
    for gate_name in ("low", "high"):
        records = [record for record in gate_records if record["name"] == gate_name]
        if not records:
            continue
        numeric_keys = [
            "mean",
            "std",
            "min",
            "max",
            "saturationLowPct",
            "saturationHighPct",
            "entropyBitsMean",
        ]
        gate_stats[gate_name] = {
            "records": len(records),
            **{
                key: sum(float(record[key]) for record in records) / len(records)
                for key in numeric_keys
            },
        }

    operating_threshold = fixed_threshold if fixed_threshold is not None else 0.5
    operating = min(sweep, key=lambda item: abs(item["threshold"] - operating_threshold))
    return {
        "loss": sum(losses) / max(1, len(losses)),
        "cellAccuracy": correct / max(1, total),
        "pathPrecision": precision,
        "pathRecall": recall,
        "pathF1": f1,
        "pathIoU": iou,
        "split": split_name,
        "thresholdPolicy": {
            "operatingThreshold": operating["threshold"],
            "source": "fixed-validation-threshold"
            if fixed_threshold is not None
            else "argmax-default-0.5",
        },
        "operatingThresholdEval": operating,
        "thresholdSweep": {
            "metric": "pathF1",
            "selectionSplit": split_name,
            "best": best_threshold,
            "points": sweep,
        },
        "pathLengthBuckets": bucket_metrics,
        **({"gateStats": gate_stats} if gate_stats else {}),
    }


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def main() -> int:
    args = parse_args()
    if args.duration_sec <= 0:
        raise ValueError("--duration-sec must be positive")
    if args.eval_every_sec <= 0:
        raise ValueError("--eval-every-sec must be positive")
    val_samples = args.val_samples if args.val_samples is not None else args.eval_samples
    test_samples = args.test_samples if args.test_samples is not None else args.eval_samples
    if val_samples <= 0:
        raise ValueError("--val-samples must be positive")
    if test_samples <= 0:
        raise ValueError("--test-samples must be positive")
    if args.save_best_checkpoint is not None and not args.retain_best_weights:
        raise ValueError("--save-best-checkpoint requires retained best weights")
    thresholds = parse_thresholds(args.thresholds)
    generated_at = utc_now()
    summary_path = (
        Path(args.write)
        if args.write not in (None, "")
        else default_summary_path(generated_at)
        if args.write is not None
        else None
    )
    metrics_path = (
        Path(args.metrics_jsonl)
        if args.metrics_jsonl is not None
        else default_metrics_path(summary_path)
        if summary_path is not None
        else None
    )
    best_checkpoint_path = (
        Path(args.save_best_checkpoint)
        if args.save_best_checkpoint not in (None, "")
        else default_best_checkpoint_path(summary_path)
        if args.save_best_checkpoint is not None and summary_path is not None
        else default_best_checkpoint_path(default_summary_path(generated_at))
        if args.save_best_checkpoint is not None
        else None
    )
    if best_checkpoint_path is not None:
        preflight_writable_artifact_path(best_checkpoint_path, "best checkpoint")

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    torch.set_float32_matmul_precision("high")

    device_index = select_device(
        args.min_free_memory_mib,
        args.min_compute_capability,
        args.device_index,
    )
    torch.cuda.set_device(device_index)
    device = torch.device(f"cuda:{device_index}")
    torch.cuda.reset_peak_memory_stats(device)

    train_x, train_y, train_lengths = generate_dataset(
        args.train_samples,
        args.grid_size,
        args.wall_prob,
        args.seed,
    )
    val_x, val_y, val_lengths = generate_dataset(
        val_samples,
        args.grid_size,
        args.wall_prob,
        args.seed + 1,
    )
    test_x, test_y, test_lengths = generate_dataset(
        test_samples,
        args.grid_size,
        args.wall_prob,
        args.seed + 2,
    )

    seq_len = args.grid_size * args.grid_size
    model = HRMLiteMazeModel(
        seq_len=seq_len,
        d_model=args.d_model,
        n_heads=args.n_heads,
        cycles=args.cycles,
        low_steps=args.low_steps,
        one_step_gradient=not args.full_bptt,
        fusion_mode=args.fusion_mode,
    ).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=args.lr,
        weight_decay=args.weight_decay,
    )
    class_weights = torch.tensor([1.0, 3.0], device=device)

    start = time.monotonic()
    next_eval_at = start
    step = 0
    train_loss_window: list[float] = []
    last_eval: dict[str, float] | None = None
    best_eval: dict[str, float] | None = None
    best_state_dict: dict[str, torch.Tensor] | None = None
    status = "pass"
    terminal_reason = "duration elapsed"

    while True:
        now = time.monotonic()
        if now - start >= args.duration_sec:
            break
        if args.max_steps > 0 and step >= args.max_steps:
            terminal_reason = "max steps reached"
            break
        model.train()
        xb, yb = take_batch(train_x, train_y, args.batch_size, device)
        optimizer.zero_grad(set_to_none=True)
        logits = model(xb)
        loss = F.cross_entropy(
            logits.view(-1, 2),
            yb.reshape(-1),
            weight=class_weights,
        )
        if not torch.isfinite(loss):
            status = "fail"
            terminal_reason = "non-finite loss"
            break
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
        optimizer.step()
        step += 1
        train_loss_window.append(float(loss.detach().cpu()))

        now = time.monotonic()
        if now >= next_eval_at or step == 1:
            last_eval = evaluate(
                model,
                val_x,
                val_y,
                val_lengths,
                args.batch_size,
                device,
                class_weights,
                args.grid_size,
                thresholds,
                split_name="validation",
            )
            torch.cuda.synchronize(device)
            elapsed = time.monotonic() - start
            record = {
                "event": "hrm-small-gpu-longrun.metric",
                "generatedAt": utc_now(),
                "step": step,
                "elapsedSec": elapsed,
                "trainLossWindowMean": sum(train_loss_window) / max(1, len(train_loss_window)),
                "eval": last_eval,
            }
            if metrics_path is not None:
                append_jsonl(metrics_path, record)
            print(json.dumps(record, sort_keys=True), flush=True)
            if (
                best_eval is None
                or last_eval["pathF1"] > best_eval["pathF1"]
                or (
                    last_eval["pathF1"] == best_eval["pathF1"]
                    and last_eval["loss"] < best_eval["loss"]
                )
            ):
                best_eval = {
                    **last_eval,
                    "step": float(step),
                    "elapsedSec": elapsed,
                }
                if args.retain_best_weights:
                    best_state_dict = clone_state_dict_for_cpu(model)
            train_loss_window.clear()
            next_eval_at = now + args.eval_every_sec

    if last_eval is None:
        last_eval = evaluate(
            model,
            val_x,
            val_y,
            val_lengths,
            args.batch_size,
            device,
            class_weights,
            args.grid_size,
            thresholds,
            split_name="validation",
        )
    torch.cuda.synchronize(device)
    elapsed = time.monotonic() - start
    if best_eval is None:
        best_eval = {**last_eval, "step": float(step), "elapsedSec": elapsed}
        if args.retain_best_weights:
            best_state_dict = clone_state_dict_for_cpu(model)
    selected_threshold = float(best_eval["thresholdSweep"]["best"]["threshold"])
    final_test_eval = evaluate(
        model,
        test_x,
        test_y,
        test_lengths,
        args.batch_size,
        device,
        class_weights,
        args.grid_size,
        thresholds,
        fixed_threshold=selected_threshold,
        split_name="test",
    )
    selected_test_eval: dict[str, Any] | None = None
    if best_state_dict is not None:
        model.load_state_dict(best_state_dict)
        selected_test_eval = evaluate(
            model,
            test_x,
            test_y,
            test_lengths,
            args.batch_size,
            device,
            class_weights,
            args.grid_size,
            thresholds,
            fixed_threshold=selected_threshold,
            split_name="test",
        )
    final_path_f1 = float(last_eval["pathF1"])
    best_path_f1 = float(best_eval["pathF1"])
    final_loss = float(last_eval["loss"])
    best_loss = float(best_eval["loss"])
    free_bytes, total_bytes = torch.cuda.mem_get_info(device_index)
    major, minor = torch.cuda.get_device_capability(device_index)
    parameter_count = sum(p.numel() for p in model.parameters())
    config: dict[str, Any] = {
        "durationSec": args.duration_sec,
        "maxSteps": args.max_steps,
        "evalEverySec": args.eval_every_sec,
        "gridSize": args.grid_size,
        "wallProb": args.wall_prob,
        "trainSamples": args.train_samples,
        "evalSamples": args.eval_samples,
        "valSamples": val_samples,
        "testSamples": test_samples,
        "batchSize": args.batch_size,
        "dModel": args.d_model,
        "nHeads": args.n_heads,
        "cycles": args.cycles,
        "lowSteps": args.low_steps,
        "fusionMode": args.fusion_mode,
        "oneStepGradient": not args.full_bptt,
        "lr": args.lr,
        "weightDecay": args.weight_decay,
        "seed": args.seed,
        "thresholds": thresholds,
        "retainBestWeights": args.retain_best_weights,
        "saveBestCheckpoint": str(best_checkpoint_path)
        if best_checkpoint_path is not None
        else None,
    }
    best_checkpoint_info: dict[str, Any] | None = None
    if best_checkpoint_path is not None:
        if best_state_dict is None:
            raise RuntimeError("best checkpoint requested but no best state was retained")
        best_checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        torch.save(
            {
                "schemaVersion": 1,
                "artifactKind": "hrm-small-gpu-best-checkpoint",
                "generatedAt": generated_at,
                "completedAt": utc_now(),
                "researchTarget": {
                    "source": HRM_ARXIV_URL,
                    "variantTag": args.variant_tag,
                },
                "config": config,
                "model": {
                    "parameterCount": parameter_count,
                    "stateDictKeyCount": len(best_state_dict),
                },
                "selection": {
                    "primarySplit": "validation",
                    "primaryMetric": "pathF1",
                    "bestValidationEval": best_eval,
                    "selectedThreshold": selected_threshold,
                },
                "modelStateDict": best_state_dict,
            },
            best_checkpoint_path,
        )
        best_checkpoint_info = {
            "path": str(best_checkpoint_path),
            "sha256": sha256_file(best_checkpoint_path),
            "artifactKind": "hrm-small-gpu-best-checkpoint",
            "selectionSource": "bestValidationEval",
            "containsModelStateDict": True,
        }
    summary: dict[str, Any] = {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "completedAt": utc_now(),
        "status": status,
        "artifactKind": "hrm-small-gpu-longrun",
        "researchTarget": {
            "name": "HRM-inspired small-GPU maze reasoning",
            "source": HRM_ARXIV_URL,
            "variantTag": args.variant_tag,
            "researchQuestion": args.research_question,
            "hypothesis": args.hypothesis,
            "notes": [
                "Two-timescale recurrent high/low modules",
                "Default one-step-gradient mode; full BPTT is optional",
                "Synthetic shortest-path mask supervision on 2D mazes",
                "Gated fusion is a follow-up research extension, not a paper-faithful HRM reproduction",
            ],
        },
        "device": {
            "index": device_index,
            "name": torch.cuda.get_device_name(device_index),
            "computeCapability": f"{major}.{minor}",
            "freeMemoryMiBAfter": free_bytes // (1024 * 1024),
            "totalMemoryMiB": total_bytes // (1024 * 1024),
            "peakMemoryAllocatedMiB": torch.cuda.max_memory_allocated(device) // (1024 * 1024),
            "peakMemoryReservedMiB": torch.cuda.max_memory_reserved(device) // (1024 * 1024),
        },
        "software": {
            "python": ".".join(map(str, tuple(sys.version_info[:3]))),
            "torch": torch.__version__,
            "cuda": torch.version.cuda,
        },
        "config": config,
        "dataset": {
            "trainMeanPathLength": sum(train_lengths) / max(1, len(train_lengths)),
            "validationMeanPathLength": sum(val_lengths) / max(1, len(val_lengths)),
            "testMeanPathLength": sum(test_lengths) / max(1, len(test_lengths)),
            "evalMeanPathLength": sum(test_lengths) / max(1, len(test_lengths)),
        },
        "metrics": {
            "elapsedSec": elapsed,
            "steps": step,
            "stepsPerSec": step / max(1e-9, elapsed),
            "finalEval": last_eval,
            "finalValidationEval": last_eval,
            "finalTestEval": final_test_eval,
            **(
                {"selectedTestEval": selected_test_eval}
                if selected_test_eval is not None
                else {}
            ),
            "bestEval": best_eval,
            "stability": {
                "finalMinusBestPathF1": final_path_f1 - best_path_f1,
                "bestToFinalPathF1Drop": best_path_f1 - final_path_f1,
                "finalMinusBestLoss": final_loss - best_loss,
            },
            "selectionPolicy": {
                "primarySplit": "validation",
                "primaryMetric": "pathF1",
                "selectedEval": "bestValidationEval",
                "selectedThreshold": selected_threshold,
                "selectedWeightsRetained": best_state_dict is not None,
                "testEvalUsesFinalWeights": True,
                "selectedTestEvalUsesRetainedBestWeights": selected_test_eval is not None,
                "leakageGuardrail": (
                    "Threshold is selected on validation metrics and applied "
                    "to held-out test metrics. selectedTestEval, when present, "
                    "uses the retained best-validation weights; finalTestEval "
                    "uses terminal weights."
                ),
            },
        },
        "model": {
            "parameterCount": parameter_count,
        },
        **(
            {"bestCheckpoint": best_checkpoint_info}
            if best_checkpoint_info is not None
            else {}
        ),
        "terminalReason": terminal_reason,
        **(
            {"metricsJsonl": str(metrics_path)}
            if metrics_path is not None
            else {}
        ),
    }
    if summary_path is not None:
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf8")
        print(f"wrote HRM small-GPU longrun summary: {summary_path}", file=sys.stderr)
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print("HRM small-GPU longrun")
        print(f"Status: {status.upper()}")
        print(f"Device: cuda:{device_index} {summary['device']['name']}")
        print(f"Elapsed: {elapsed:.1f}s steps={step} steps/sec={summary['metrics']['stepsPerSec']:.3f}")
        print(f"Final eval: {json.dumps(last_eval, sort_keys=True)}")
        if selected_test_eval is not None:
            print(f"Selected test eval: {json.dumps(selected_test_eval, sort_keys=True)}")
    return 0 if status == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
