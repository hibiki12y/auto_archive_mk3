# HRM-derived experiment ledger

This ledger keeps a tracked, lightweight record of HRM-inspired GPU evaluation
artifacts. Raw `results/**/*.json` files remain gitignored; this file preserves
the reproducibility anchors, hashes, and interpretation guardrails needed to
re-check claims later.

Machine-readable ledger: `specs/CURRENT/hrm-experiment-ledger.json`.

Verify local raw artifact hashes with:

```bash
pnpm gpu:hrm:ledger:verify
```

On a clean checkout where raw `results/` artifacts are intentionally absent,
use `python3 scripts/hrm-verify-ledger.py --allow-missing` to audit ledger shape
without failing on missing local artifacts.

## Interpretation guardrails

- The current additive-vs-gated 2-hour result is **exploratory only**.
- It is single-seed and not parameter matched.
- The regenerated comparison artifact marks `claimReadiness.status` as
  `exploratory_only` until held-out selected-test, multi-seed, and
  parameter/compute matching gates pass.
- Future headline claims must cite held-out `selectedTestEval` from retained
  best-validation weights when available, not only validation
  `finalEval`/`bestEval` or terminal-weight `finalTestEval`.

## Entries

| Date | Artifact | Variant | Device | Seed | Duration | Key metrics | SHA-256 |
| --- | --- | --- | --- | ---: | ---: | --- | --- |
| 2026-05-04 | `results/hrm-small-gpu-longrun/hrm-additive-baseline-2h-2026-05-04.json` | `additive-baseline-v1` | `cuda:1 Quadro RTX 8000` | `20260621` | `7200s` | final `pathF1=0.459518`; best `pathF1=0.584887`; params `112,770`; steps/sec `67.308` | `47b04f796bddaa7109db7737172e47cbf46e1245279b4f64801124eb152b14a3` |
| 2026-05-04 | `results/hrm-small-gpu-longrun/hrm-gated-fusion-2h-2026-05-04.json` | `gated-fusion-followup-v1` | `cuda:1 Quadro RTX 8000` | `20260621` | `7200s` | final `pathF1=0.496866`; best `pathF1=0.614035`; params `133,378`; steps/sec `55.500` | `22a810781cca4df8bcc34eb9e5098be8667c80835bf3c49755c0bf144e3ab044` |
| 2026-05-04 | `results/hrm-small-gpu-longrun/hrm-add-vs-gated-2h-comparison-2026-05-04.json` | comparison | matched device/config; unmatched params/throughput | `20260621` | `7200s` | final `pathF1 Δ=+0.037347`; best `pathF1 Δ=+0.029148`; no held-out selected-test; `claimReadiness=exploratory_only` | `3a14e679f399bf2341e6577a208e7a46c710959f658c93fa1dd4a1572d791aea` |
| 2026-05-05 | `results/hrm-small-gpu-longrun/hrm-eval-hardening-smoke-2026-05-05.json` | `gated-eval-hardening-smoke` | `cuda:1 Quadro RTX 8000` | `20260621` | `20s` | validates validation/test split, threshold sweep, IoU, path buckets, gate stats, and selection policy | `9a9be922ce0f9ae1bcee4f1a0565cb81d3c942c36008c55514ac3b45d13ccaf9` |
| 2026-05-05 | `results/hrm-small-gpu-longrun/hrm-best-retention-smoke-2026-05-05.json` | `gated-best-retention-smoke` | `cuda:1 Quadro RTX 8000` | `20260621` | `20s` | validates retained best weights, held-out `selectedTestEval`, and `.best.pt` checkpoint (`80dd4c6a...b851`) | `886b4aedbf1810a1e613a4812d865407871729b80f15d800e416f14a0eabbbae` |

## Next required gates

1. Run parameter-matched additive/gated controls before architecture claims.
2. Run at least three paired seeds before reporting a directional improvement
   as robust.
3. Prefer `selectedTestEval` in comparisons once all arms retain
   best-validation weights; otherwise keep the claim exploratory and disclose
   terminal-weight `finalTestEval` usage.
4. Keep `supportOk=false` bucket metrics out of headline claims.
