#!/usr/bin/env python3
"""Bounded CUDA Transformer train/eval smoke for Auto Archive.

This script is intentionally self-contained and synthetic-data only. It proves
that the host can run a modern Transformer-style training/evaluation loop on a
CUDA GPU without downloading datasets, reading secrets, or logging process
command lines.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import torch
from torch import nn
import torch.nn.functional as F


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--seq-len", type=int, default=64)
    parser.add_argument("--vocab-size", type=int, default=2048)
    parser.add_argument("--d-model", type=int, default=128)
    parser.add_argument("--n-heads", type=int, default=4)
    parser.add_argument("--n-layers", type=int, default=2)
    parser.add_argument("--min-free-memory-mib", type=int, default=24 * 1024)
    parser.add_argument("--device-index", type=int, default=None)
    parser.add_argument("--write", nargs="?", const="", default=None)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args([arg for arg in sys.argv[1:] if arg != "--"])


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def default_output_path(generated_at: str) -> Path:
    safe = generated_at.replace(":", "-").replace(".", "-")
    return Path("results/gpu-transformer-smoke") / f"transformer-smoke-{safe}.json"


def select_device(min_free_memory_mib: int, requested_index: int | None) -> int:
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available to PyTorch.")
    if requested_index is not None:
        return requested_index
    for index in range(torch.cuda.device_count()):
        torch.cuda.set_device(index)
        free_bytes, _total_bytes = torch.cuda.mem_get_info(index)
        if free_bytes // (1024 * 1024) >= min_free_memory_mib:
            return index
    raise RuntimeError(
        f"No CUDA device has at least {min_free_memory_mib} MiB free memory."
    )


class CausalSelfAttention(nn.Module):
    def __init__(self, d_model: int, n_heads: int) -> None:
        super().__init__()
        if d_model % n_heads != 0:
            raise ValueError("d_model must be divisible by n_heads")
        self.n_heads = n_heads
        self.head_dim = d_model // n_heads
        self.qkv = nn.Linear(d_model, 3 * d_model)
        self.proj = nn.Linear(d_model, d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        batch, seq_len, d_model = x.shape
        qkv = self.qkv(x).view(batch, seq_len, 3, self.n_heads, self.head_dim)
        q, k, v = qkv.permute(2, 0, 3, 1, 4)
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        y = y.transpose(1, 2).contiguous().view(batch, seq_len, d_model)
        return self.proj(y)


class TransformerBlock(nn.Module):
    def __init__(self, d_model: int, n_heads: int) -> None:
        super().__init__()
        self.ln1 = nn.LayerNorm(d_model)
        self.attn = CausalSelfAttention(d_model, n_heads)
        self.ln2 = nn.LayerNorm(d_model)
        self.mlp = nn.Sequential(
            nn.Linear(d_model, 4 * d_model),
            nn.GELU(),
            nn.Linear(4 * d_model, d_model),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.ln1(x))
        x = x + self.mlp(self.ln2(x))
        return x


class TinyCausalTransformer(nn.Module):
    def __init__(
        self,
        vocab_size: int,
        seq_len: int,
        d_model: int,
        n_heads: int,
        n_layers: int,
    ) -> None:
        super().__init__()
        self.token = nn.Embedding(vocab_size, d_model)
        self.position = nn.Embedding(seq_len, d_model)
        self.blocks = nn.ModuleList(
            [TransformerBlock(d_model, n_heads) for _ in range(n_layers)]
        )
        self.ln_f = nn.LayerNorm(d_model)
        self.head = nn.Linear(d_model, vocab_size, bias=False)

    def forward(self, idx: torch.Tensor) -> torch.Tensor:
        batch, seq_len = idx.shape
        pos = torch.arange(seq_len, device=idx.device).unsqueeze(0).expand(batch, -1)
        x = self.token(idx) + self.position(pos)
        for block in self.blocks:
            x = block(x)
        return self.head(self.ln_f(x))


def synthetic_batch(
    batch_size: int,
    seq_len: int,
    vocab_size: int,
    device: torch.device,
) -> tuple[torch.Tensor, torch.Tensor]:
    start = torch.randint(0, vocab_size, (batch_size, 1), device=device)
    offsets = torch.arange(seq_len + 1, device=device).unsqueeze(0)
    tokens = (start + offsets) % vocab_size
    return tokens[:, :-1], tokens[:, 1:]


def main() -> int:
    args = parse_args()
    if args.steps <= 0:
        raise ValueError("--steps must be positive")
    generated_at = utc_now()
    device_index = select_device(args.min_free_memory_mib, args.device_index)
    torch.cuda.set_device(device_index)
    device = torch.device(f"cuda:{device_index}")
    torch.manual_seed(20260504)
    torch.cuda.manual_seed_all(20260504)

    model = TinyCausalTransformer(
        vocab_size=args.vocab_size,
        seq_len=args.seq_len,
        d_model=args.d_model,
        n_heads=args.n_heads,
        n_layers=args.n_layers,
    ).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-4)

    train_losses: list[float] = []
    model.train()
    for _step in range(args.steps):
        x, y = synthetic_batch(args.batch_size, args.seq_len, args.vocab_size, device)
        optimizer.zero_grad(set_to_none=True)
        logits = model(x)
        loss = F.cross_entropy(logits.view(-1, args.vocab_size), y.reshape(-1))
        loss.backward()
        optimizer.step()
        train_losses.append(float(loss.detach().cpu()))

    torch.cuda.synchronize(device)
    model.eval()
    with torch.no_grad():
        x_eval, y_eval = synthetic_batch(
            args.batch_size, args.seq_len, args.vocab_size, device
        )
        eval_logits = model(x_eval)
        eval_loss = F.cross_entropy(
            eval_logits.view(-1, args.vocab_size),
            y_eval.reshape(-1),
        )
    torch.cuda.synchronize(device)

    free_bytes, total_bytes = torch.cuda.mem_get_info(device_index)
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "status": "pass",
        "artifactKind": "gpu-transformer-train-eval-smoke",
        "architecture": {
            "name": "tiny-causal-transformer-sdpa",
            "attentionPrimitive": "torch.nn.functional.scaled_dot_product_attention",
            "modernResearchTargets": [
                "FlashAttention-3-style GPU-efficient attention kernels",
                "Mamba-2/SSD Transformer-SSM comparisons",
                "MLA+MoE routing micro-batches",
                "Kimi Linear/KDA long-context attention alternatives",
            ],
        },
        "device": {
            "index": device_index,
            "name": torch.cuda.get_device_name(device_index),
            "freeMemoryMiBAfter": free_bytes // (1024 * 1024),
            "totalMemoryMiB": total_bytes // (1024 * 1024),
        },
        "software": {
            "python": ".".join(map(str, tuple(os.sys.version_info[:3]))),
            "torch": torch.__version__,
            "cuda": torch.version.cuda,
        },
        "config": {
            "steps": args.steps,
            "batchSize": args.batch_size,
            "seqLen": args.seq_len,
            "vocabSize": args.vocab_size,
            "dModel": args.d_model,
            "nHeads": args.n_heads,
            "nLayers": args.n_layers,
        },
        "metrics": {
            "trainLosses": train_losses,
            "initialTrainLoss": train_losses[0],
            "finalTrainLoss": train_losses[-1],
            "evalLoss": float(eval_loss.detach().cpu()),
            "evalPerplexity": float(math.exp(float(eval_loss.detach().cpu()))),
        },
    }

    if args.write is not None:
        output_path = Path(args.write) if args.write else default_output_path(generated_at)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
        print(f"wrote GPU transformer smoke artifact: {output_path}", file=os.sys.stderr)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("GPU Transformer train/eval smoke")
        print(f"Generated: {generated_at}")
        print("Status: PASS")
        print(f"Device: cuda:{device_index} {report['device']['name']}")
        print(
            f"Loss: initial={report['metrics']['initialTrainLoss']:.4f} "
            f"final={report['metrics']['finalTrainLoss']:.4f} "
            f"eval={report['metrics']['evalLoss']:.4f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
