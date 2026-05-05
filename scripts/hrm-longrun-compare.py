#!/usr/bin/env python3
"""Compare paired HRM small-GPU long-run summaries.

The long-run harness is intentionally experiment-oriented: every run records a
variant tag, hypothesis, best evaluation, final evaluation, and config.  This
helper turns two matched summaries into a compact comparison artifact so a
follow-up experiment is not left as disconnected JSON files.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, help="Baseline summary JSON path")
    parser.add_argument("--candidate", required=True, help="Candidate summary JSON path")
    parser.add_argument("--write", default=None, help="Optional output JSON path")
    parser.add_argument("--json", action="store_true", help="Print the full comparison JSON")
    return parser.parse_args([arg for arg in sys.argv[1:] if arg != "--"])


def load_summary(path: str) -> dict[str, Any]:
    parsed = json.loads(Path(path).read_text(encoding="utf8"))
    if not isinstance(parsed, dict):
        raise ValueError(f"{path} did not contain a JSON object")
    return parsed


def nested(summary: dict[str, Any], *keys: str) -> Any:
    current: Any = summary
    for key in keys:
        if not isinstance(current, dict) or key not in current:
            raise KeyError(f"Missing {'.'.join(keys)}")
        current = current[key]
    return current


def metric(summary: dict[str, Any], section: str, name: str) -> float:
    value = nested(summary, "metrics", section, name)
    if not isinstance(value, (int, float)):
        raise TypeError(f"Expected numeric metrics.{section}.{name}; got {value!r}")
    return float(value)


def has_metric_section(summary: dict[str, Any], section: str) -> bool:
    metrics = summary.get("metrics")
    return isinstance(metrics, dict) and isinstance(metrics.get(section), dict)


def maybe_metric(summary: dict[str, Any], section: str, name: str) -> float | None:
    try:
        return metric(summary, section, name)
    except (KeyError, TypeError):
        return None


def run_label(summary: dict[str, Any]) -> str:
    return str(nested(summary, "researchTarget", "variantTag"))


def metric_section_object(summary: dict[str, Any], section: str) -> dict[str, Any]:
    value = nested(summary, "metrics", section)
    if not isinstance(value, dict):
        raise TypeError(f"metrics.{section} must be an object")
    return value


def path_metric_source(summary: dict[str, Any], section: str) -> tuple[dict[str, Any], str]:
    section_metrics = metric_section_object(summary, section)
    operating = section_metrics.get("operatingThresholdEval")
    if section in ("finalTestEval", "selectedTestEval") and isinstance(operating, dict):
        return operating, "operatingThresholdEval"
    return section_metrics, "directArgmaxPathMetrics"


def path_metric(summary: dict[str, Any], section: str, name: str) -> float:
    source, source_name = path_metric_source(summary, section)
    value = source.get(name)
    if not isinstance(value, (int, float)):
        raise TypeError(
            f"Expected numeric metrics.{section}.{source_name}.{name}; got {value!r}"
        )
    return float(value)


def comparable_config(summary: dict[str, Any]) -> dict[str, Any]:
    config = nested(summary, "config")
    if not isinstance(config, dict):
        raise TypeError("config must be an object")
    keys = [
        "durationSec",
        "evalEverySec",
        "gridSize",
        "wallProb",
        "trainSamples",
        "evalSamples",
        "batchSize",
        "dModel",
        "nHeads",
        "cycles",
        "lowSteps",
        "oneStepGradient",
        "lr",
        "weightDecay",
        "seed",
    ]
    return {key: config.get(key) for key in keys}


def device_identity(summary: dict[str, Any]) -> dict[str, Any]:
    device = nested(summary, "device")
    if not isinstance(device, dict):
        raise TypeError("device must be an object")
    return {
        "index": device.get("index"),
        "name": device.get("name"),
        "computeCapability": device.get("computeCapability"),
    }


def metric_block(summary: dict[str, Any]) -> dict[str, Any]:
    if has_metric_section(summary, "selectedTestEval"):
        final_section = "selectedTestEval"
    elif has_metric_section(summary, "finalTestEval"):
        final_section = "finalTestEval"
    else:
        final_section = "finalEval"
    final_path_f1 = path_metric(summary, final_section, "pathF1")
    _path_source, final_path_source_name = path_metric_source(summary, final_section)
    best_path_f1 = metric(summary, "bestEval", "pathF1")
    best_elapsed = maybe_metric(summary, "bestEval", "elapsedSec")
    final_elapsed = None
    elapsed = nested(summary, "metrics", "elapsedSec")
    if isinstance(elapsed, (int, float)):
        final_elapsed = float(elapsed)
    return {
        "status": summary.get("status"),
        "fusionMode": nested(summary, "config", "fusionMode"),
        "finalMetricSection": final_section,
        "finalMetricPathSource": final_path_source_name,
        "elapsedSec": final_elapsed,
        "steps": nested(summary, "metrics", "steps"),
        "stepsPerSec": nested(summary, "metrics", "stepsPerSec"),
        "parameterCount": nested(summary, "model", "parameterCount"),
        "final": {
            "loss": metric(summary, final_section, "loss"),
            "cellAccuracy": metric(summary, final_section, "cellAccuracy"),
            "pathPrecision": path_metric(summary, final_section, "pathPrecision"),
            "pathRecall": path_metric(summary, final_section, "pathRecall"),
            "pathF1": final_path_f1,
            **(
                {"pathIoU": path_metric(summary, final_section, "pathIoU")}
                if path_metric_source(summary, final_section)[0].get("pathIoU") is not None
                else {}
            ),
        },
        "best": {
            "loss": metric(summary, "bestEval", "loss"),
            "cellAccuracy": metric(summary, "bestEval", "cellAccuracy"),
            "pathPrecision": metric(summary, "bestEval", "pathPrecision"),
            "pathRecall": metric(summary, "bestEval", "pathRecall"),
            "pathF1": best_path_f1,
            "step": nested(summary, "metrics", "bestEval", "step"),
            "elapsedSec": best_elapsed,
        },
        "stability": {
            "finalMinusBestPathF1": final_path_f1 - best_path_f1,
            "bestToFinalPathF1Drop": best_path_f1 - final_path_f1,
        },
    }


def delta(candidate: float, baseline: float) -> dict[str, float]:
    return {
        "absolute": candidate - baseline,
        "relativeToBaseline": (candidate - baseline) / baseline if baseline != 0 else 0.0,
    }


def ratio(candidate: float, baseline: float) -> float:
    return candidate / baseline if baseline != 0 else 0.0


def comparison_quality_gates(
    baseline_metrics: dict[str, Any],
    candidate_metrics: dict[str, Any],
) -> dict[str, Any]:
    parameter_ratio = ratio(
        float(candidate_metrics["parameterCount"]),
        float(baseline_metrics["parameterCount"]),
    )
    throughput_ratio = ratio(
        float(candidate_metrics["stepsPerSec"]),
        float(baseline_metrics["stepsPerSec"]),
    )
    parameter_matched = abs(parameter_ratio - 1.0) <= 0.05
    throughput_matched = abs(throughput_ratio - 1.0) <= 0.10
    uses_held_out_test = (
        baseline_metrics["finalMetricSection"] in ("finalTestEval", "selectedTestEval")
        and candidate_metrics["finalMetricSection"] in ("finalTestEval", "selectedTestEval")
    )
    uses_retained_best_weights = (
        baseline_metrics["finalMetricSection"] == "selectedTestEval"
        and candidate_metrics["finalMetricSection"] == "selectedTestEval"
    )
    reasons: list[str] = []
    if not parameter_matched:
        reasons.append("parameter count differs by more than 5%")
    if not throughput_matched:
        reasons.append("throughput differs by more than 10%")
    if not uses_held_out_test:
        reasons.append("final comparison does not use held-out test eval for both runs")
    if not uses_retained_best_weights:
        reasons.append(
            "final comparison does not use retained best-validation weights for both runs"
        )
    reasons.append("single-run paired comparison; multi-seed aggregate is still required")
    return {
        "parameterRatio": parameter_ratio,
        "throughputRatio": throughput_ratio,
        "parameterMatchedWithin5Pct": parameter_matched,
        "throughputMatchedWithin10Pct": throughput_matched,
        "usesHeldOutFinalTestEval": (
            baseline_metrics["finalMetricSection"] == "finalTestEval"
            and candidate_metrics["finalMetricSection"] == "finalTestEval"
        ),
        "usesHeldOutTestEval": uses_held_out_test,
        "usesRetainedBestWeightsForTestEval": uses_retained_best_weights,
        "claimReadiness": {
            "status": "exploratory_only" if reasons else "comparison_ready",
            "reasons": reasons,
        },
    }


def compare(baseline_path: str, candidate_path: str) -> dict[str, Any]:
    baseline = load_summary(baseline_path)
    candidate = load_summary(candidate_path)
    baseline_config = comparable_config(baseline)
    candidate_config = comparable_config(candidate)
    baseline_device = device_identity(baseline)
    candidate_device = device_identity(candidate)
    baseline_metrics = metric_block(baseline)
    candidate_metrics = metric_block(candidate)
    quality_gates = comparison_quality_gates(baseline_metrics, candidate_metrics)

    return {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "artifactKind": "hrm-small-gpu-longrun-comparison",
        "baseline": {
            "path": baseline_path,
            "variantTag": run_label(baseline),
            **baseline_metrics,
        },
        "candidate": {
            "path": candidate_path,
            "variantTag": run_label(candidate),
            **candidate_metrics,
        },
        "matchedConfig": {
            "isMatchedExceptFusionModeAndVariantMetadata": baseline_config == candidate_config,
            "baseline": baseline_config,
            "candidate": candidate_config,
        },
        "matchedDevice": {
            "isMatched": baseline_device == candidate_device,
            "baseline": baseline_device,
            "candidate": candidate_device,
        },
        "qualityGates": quality_gates,
        "deltas": {
            "finalPathF1": delta(
                candidate_metrics["final"]["pathF1"],
                baseline_metrics["final"]["pathF1"],
            ),
            "bestPathF1": delta(
                candidate_metrics["best"]["pathF1"],
                baseline_metrics["best"]["pathF1"],
            ),
            "stabilityFinalMinusBestPathF1": delta(
                candidate_metrics["stability"]["finalMinusBestPathF1"],
                baseline_metrics["stability"]["finalMinusBestPathF1"],
            ),
            "stepsPerSec": delta(
                float(candidate_metrics["stepsPerSec"]),
                float(baseline_metrics["stepsPerSec"]),
            ),
            "parameterCount": delta(
                float(candidate_metrics["parameterCount"]),
                float(baseline_metrics["parameterCount"]),
            ),
        },
        "interpretationGuardrails": [
            "This paired comparison controls major harness settings and seed, but is still a single-seed result.",
            "When selectedTestEval is present, finalPathF1 compares held-out test metrics from retained best-validation weights rather than terminal weights.",
            "Use best-vs-terminal stability deltas to detect late-window degradation rather than reporting only terminal metrics.",
            "Sign convention: finalMinusBestPathF1 < 0 means terminal F1 was below the run's best F1; bestToFinalPathF1Drop > 0 is the late-window drop magnitude.",
            "Gated fusion adds parameters, so follow-up attribution should include a parameter-matched control before publication claims.",
            "claimReadiness.status must remain exploratory_only until held-out selected-test, multi-seed, and parameter/compute matching gates pass.",
        ],
    }


def main() -> int:
    args = parse_args()
    comparison = compare(args.baseline, args.candidate)
    if args.write:
        output = Path(args.write)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(comparison, indent=2) + "\n", encoding="utf8")
        print(f"wrote HRM longrun comparison: {output}")
    if args.json or not args.write:
        print(json.dumps(comparison, indent=2))
    else:
        print(
            "HRM longrun comparison "
            f"{comparison['baseline']['variantTag']} -> {comparison['candidate']['variantTag']}: "
            f"finalPathF1Δ={comparison['deltas']['finalPathF1']['absolute']:.6f} "
            f"bestPathF1Δ={comparison['deltas']['bestPathF1']['absolute']:.6f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
