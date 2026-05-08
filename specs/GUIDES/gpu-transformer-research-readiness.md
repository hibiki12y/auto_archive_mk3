---
status: current
authority: operator-runbook
last_verified: 2026-05-04
source_paths:
  - src/core/gpu-transformer-research-readiness.ts
  - scripts/gpu-transformer-research-readiness.mjs
  - tests/core/gpu-transformer-research-readiness.spec.ts
scope: Non-mutating GPU readiness gate before launching modern Transformer architecture research.
---

# GPU Transformer Research Readiness

Auto Archive must not treat “GPU exists” as equivalent to “safe to launch a
high-end model training/evaluation run.” The readiness gate records a
non-secret `nvidia-smi` inventory, checks whether at least one GPU is actually
available, and writes an evidence artifact before a Discord/Codex research task
requests GPU training.

## Command

```bash
pnpm gpu:research:readiness -- --write
```

The command builds the TypeScript sources, invokes:

```bash
nvidia-smi \
  --query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw,power.limit,compute_cap \
  --format=csv,noheader,nounits
```

and writes JSON evidence under `results/gpu-research-readiness/`.

The script intentionally does **not** include process names, command lines,
usernames, environment variables, or token-bearing logs.

If the readiness status is `PASS`, run the bounded train/eval smoke:

```bash
pnpm gpu:transformer:smoke -- --write
```

The smoke runs a tiny causal Transformer using PyTorch
`scaled_dot_product_attention` on synthetic next-token data and writes a JSON
artifact under `results/gpu-transformer-smoke/`. It proves CUDA training and
evaluation plumbing; it is not a model-quality benchmark.

For the HRM-inspired small-GPU research lane, run a longer maze-reasoning
experiment:

```bash
pnpm gpu:hrm:longrun -- --duration-sec 600 --eval-every-sec 60 --write
```

This uses synthetic 2D mazes and a tiny two-timescale recurrent model with
high-level and low-level modules. Default mode follows the paper's one-step
gradient idea by unrolling all but the final local recurrent update under
`torch.no_grad()`, then backpropagating through the final high/low update. The
run writes a JSON summary plus periodic metrics JSONL under
`results/hrm-small-gpu-longrun/`.

The default harness is deliberately much smaller than the paper model: the
2026-05-04 long-run used `112,770` parameters versus HRM's reported ~27M
parameters. Treat it as a small-GPU instrumentation and stability lane. A
600-second run is the minimum accepted long-run artifact for this repository;
multi-hour runs (`--duration-sec 3600` or higher) are stronger evidence for
memory-leak, thermal, and metric-stability analysis.

## Follow-up research extensions

The harness is intended to support research questions derived from HRM, not only
a literal implementation. It currently exposes these follow-up axes:

- `--fusion-mode add` — baseline high/low/input element-wise addition.
- `--fusion-mode gated` — learned gates control how high-level state, low-level
  state, and input evidence mix. This tests whether adaptive high/low coupling
  improves path-mask precision/recall stability.
- `--full-bptt` — control condition against the default HRM-style one-step
  gradient approximation.
- `--cycles` and `--low-steps` — timescale/depth ablations.

Recommended multi-hour derivative lane:

```bash
pnpm gpu:hrm:longrun -- \
  --duration-sec 7200 \
  --eval-every-sec 600 \
  --fusion-mode gated \
  --variant-tag gated-fusion-followup-v1 \
  --save-best-checkpoint \
  --hypothesis "Learned gates between high/low recurrent states improve path-mask precision-recall stability over additive fusion." \
  --write results/hrm-small-gpu-longrun/hrm-gated-fusion-2h.json
```

Matched baseline protocol:

1. Run the same duration, seed, dataset size, and model depth with
   `--fusion-mode add`.
2. Compare additive vs. gated with `pnpm gpu:hrm:compare`.
3. Report `bestEval`, terminal `finalTestEval`, and retained-weight
   `selectedTestEval` when available; the comparison artifact includes
   `bestToFinalPathF1Drop` so late-window degradation is visible.

```bash
pnpm gpu:hrm:longrun -- \
  --duration-sec 7200 \
  --eval-every-sec 600 \
  --fusion-mode add \
  --variant-tag additive-baseline-v1 \
  --save-best-checkpoint \
  --write results/hrm-small-gpu-longrun/hrm-additive-baseline-2h.json

pnpm gpu:hrm:compare -- \
  --baseline results/hrm-small-gpu-longrun/hrm-additive-baseline-2h.json \
  --candidate results/hrm-small-gpu-longrun/hrm-gated-fusion-2h.json \
  --write results/hrm-small-gpu-longrun/hrm-add-vs-gated-2h-comparison.json
```

### 2026-05-04 paired 2-hour result

Artifacts:

- Additive baseline:
  `results/hrm-small-gpu-longrun/hrm-additive-baseline-2h-2026-05-04.json`
- Gated candidate:
  `results/hrm-small-gpu-longrun/hrm-gated-fusion-2h-2026-05-04.json`
- Comparison:
  `results/hrm-small-gpu-longrun/hrm-add-vs-gated-2h-comparison-2026-05-04.json`

The paired comparison matched major config and device
(`cuda:1 Quadro RTX 8000`, seed `20260621`). Gated fusion improved terminal
`pathF1` by `+0.037347` and best `pathF1` by `+0.029148` over the additive
baseline in this single-seed run. It was slower (`-17.54%` steps/sec) and used
`+20,608` parameters, so publication-grade attribution still needs
multi-seed and parameter-matched controls.

Stability sign convention: `finalMinusBestPathF1 < 0` means terminal F1 was
below that run's best F1; `bestToFinalPathF1Drop > 0` is the late-window drop
magnitude.

DT Audit hardening added the following evaluation safeguards for new runs:

- validation/test split controls: `--val-samples` and `--test-samples`
  default to `--eval-samples`; threshold tuning is recorded on validation and
  applied to held-out `finalTestEval`;
- threshold sweep and `pathIoU` in every eval record;
- path-length buckets with `supportOk` so low-support buckets are not promoted
  to headline claims;
- gated-mode `gateStats` (`mean`, `std`, saturation, entropy) to detect dead or
  collapsed gates;
- `selectionPolicy` that records whether best validation weights were retained.
  By default, the harness now retains best weights in memory, emits held-out
  `selectedTestEval`, and can write a `.best.pt` artifact with
  `--save-best-checkpoint`;
- comparison metric selection prefers held-out `selectedTestEval` and its
  validation-selected `operatingThresholdEval` when present, falls back to
  terminal-weight `finalTestEval`, then legacy validation `finalEval`;
- comparison `qualityGates.claimReadiness`, which remains `exploratory_only`
  until held-out selected-test, multi-seed, and parameter/compute matching gates
  pass.

Tracked ledger: `specs/CURRENT/hrm-experiment-ledger.md` records hashes and
guardrails for gitignored raw artifacts. Verify local raw artifacts with
`pnpm gpu:hrm:ledger:verify`.

Default threshold tie-breaker: if multiple thresholds tie on validation
`pathF1`, the harness selects the threshold closest to `0.5`. Bucket metrics
with `supportOk=false` are diagnostic only. Gate statistics are also diagnostic
until a future multi-seed sweep establishes acceptable saturation/entropy
bands.

## Default thresholds

| Gate | Default |
| --- | ---: |
| Free VRAM | `>= 24576 MiB` |
| GPU utilization | `<= 30%` |
| Temperature | `<= 85C` |
| Compute capability | `>= 7.5` when reported by `nvidia-smi` |

Status semantics:

- `PASS` — at least one GPU meets all thresholds.
- `WARN` — GPUs are visible, but no GPU is currently eligible. Do not start
  training; wait for/fix capacity and rerun the gate.
- `FAIL` — no GPU rows are visible; fix driver/container visibility first.

## 2026-05-04 live host observation

The host exposed two Quadro RTX 8000 48GB GPUs and one GTX 1060 3GB. An initial
operator snapshot had both RTX 8000 GPUs at 100% utilization and the GTX 1060
below the high-end free-memory threshold, so the correct readiness state was
`WARN`. A later readiness artifact collected after the RTX 8000 jobs ended was
`PASS` for GPU indexes 0 and 1; the GTX 1060 remained excluded by memory and
compute capability.

## Modern architecture research targets

The readiness gate is architecture-agnostic, but the current research lane
should be able to run bounded experiments against these modern Transformer or
Transformer-adjacent structures:

1. **GPU-efficient attention kernels** — FlashAttention-3 targets attention as
   a Transformer bottleneck and uses Hopper-specific asynchrony/FP8 ideas
   ([arXiv:2407.08608](https://arxiv.org/abs/2407.08608)).
2. **SSM/attention duality** — Mamba-2 / SSD connects state-space models and
   attention variants and reports 2-8x speedups in the core layer
   ([arXiv:2405.21060](https://arxiv.org/abs/2405.21060)).
3. **MLA + MoE architectures** — DeepSeek-V3 uses Multi-head Latent Attention
   plus DeepSeekMoE, auxiliary-loss-free balancing, and multi-token prediction
   ([arXiv:2412.19437](https://arxiv.org/abs/2412.19437)).
4. **Hybrid linear attention** — Kimi Linear / KDA combines linear attention
   with MLA-style layers and reports KV-cache and decoding-throughput gains for
   long contexts ([arXiv:2510.26692](https://arxiv.org/abs/2510.26692)).

For this repository, “researchable” means bounded smoke/evaluation artifacts,
not frontier-scale reproduction. A valid GPU research closeout must include:

- readiness JSON from this gate;
- selected architecture target and citation;
- training command/config artifact;
- terminal evidence;
- training artifact path;
- evaluation metric artifact;
- cleanup/closeout note.

For arXiv:2506.21734 specifically, the closeout should also state whether the
run used one-step gradient or full BPTT, how many high-level cycles / low-level
steps were used, and whether the model showed stable long-run metrics rather
than only a one-shot CUDA allocation.
