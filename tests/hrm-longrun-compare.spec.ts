import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface SummaryOptions {
  readonly variantTag: string;
  readonly fusionMode: 'add' | 'gated';
  readonly deviceIndex?: number;
  readonly finalPathF1: number;
  readonly bestPathF1: number;
  readonly stepsPerSec?: number;
  readonly parameterCount?: number;
  readonly includeFinalTestEval?: boolean;
  readonly includeSelectedTestEval?: boolean;
}

function makeSummary(options: SummaryOptions): unknown {
  return {
    status: 'pass',
    researchTarget: {
      variantTag: options.variantTag,
    },
    device: {
      index: options.deviceIndex ?? 1,
      name: 'Quadro RTX 8000',
      computeCapability: '7.5',
    },
    config: {
      durationSec: 7200,
      evalEverySec: 600,
      gridSize: 8,
      wallProb: 0.22,
      trainSamples: 1024,
      evalSamples: 256,
      batchSize: 32,
      dModel: 64,
      nHeads: 4,
      cycles: 4,
      lowSteps: 4,
      fusionMode: options.fusionMode,
      oneStepGradient: true,
      lr: 0.0003,
      weightDecay: 0.01,
      seed: 20260621,
    },
    metrics: {
      elapsedSec: 7200,
      steps: 1234,
      stepsPerSec: options.stepsPerSec ?? 10,
      finalEval: {
        loss: 0.6,
        cellAccuracy: 0.7,
        pathPrecision: 0.4,
        pathRecall: 0.8,
        pathF1: options.finalPathF1,
      },
      ...(options.includeFinalTestEval === true
        ? {
            finalTestEval: {
              loss: 0.55,
              cellAccuracy: 0.72,
              pathPrecision: 0.42,
              pathRecall: 0.82,
              pathF1: options.finalPathF1 + 0.01,
              pathIoU: 0.33,
            },
          }
        : {}),
      ...(options.includeSelectedTestEval === true
        ? {
            selectedTestEval: {
              loss: 0.5,
              cellAccuracy: 0.74,
              pathPrecision: 0.44,
              pathRecall: 0.84,
              pathF1: options.finalPathF1 + 0.02,
              pathIoU: 0.35,
              operatingThresholdEval: {
                threshold: 0.6,
                pathPrecision: 0.46,
                pathRecall: 0.86,
                pathF1: options.finalPathF1 + 0.03,
                pathIoU: 0.37,
              },
              thresholdPolicy: {
                operatingThreshold: 0.6,
                source: 'fixed-validation-threshold',
              },
            },
          }
        : {}),
      bestEval: {
        loss: 0.5,
        cellAccuracy: 0.75,
        pathPrecision: 0.45,
        pathRecall: 0.85,
        pathF1: options.bestPathF1,
        step: 1000,
        elapsedSec: 5400,
      },
    },
    model: {
      parameterCount: options.parameterCount ?? 100,
    },
  };
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'hrm-compare-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

describe('hrm-longrun-compare package script', () => {
  it('compares matched additive/gated summaries and strips the pnpm -- sentinel', () => {
    withTempDir((dir) => {
      const baseline = join(dir, 'add.json');
      const candidate = join(dir, 'gated.json');
      const output = join(dir, 'comparison.json');
      writeJson(
        baseline,
        makeSummary({
          variantTag: 'additive-baseline-v1',
          fusionMode: 'add',
          finalPathF1: 0.4,
          bestPathF1: 0.55,
          stepsPerSec: 12,
          parameterCount: 100,
        }),
      );
      writeJson(
        candidate,
        makeSummary({
          variantTag: 'gated-fusion-followup-v1',
          fusionMode: 'gated',
          finalPathF1: 0.45,
          bestPathF1: 0.6,
          stepsPerSec: 10,
          parameterCount: 120,
        }),
      );

      const result = spawnSync(
        'pnpm',
        [
          'gpu:hrm:compare',
          '--',
          '--baseline',
          baseline,
          '--candidate',
          candidate,
          '--write',
          output,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );

      expect(result.status, result.stderr).toBe(0);
      const comparison = JSON.parse(readFileSync(output, 'utf8'));
      expect(comparison.matchedConfig.isMatchedExceptFusionModeAndVariantMetadata).toBe(
        true,
      );
      expect(comparison.matchedDevice.isMatched).toBe(true);
      expect(comparison.qualityGates.parameterMatchedWithin5Pct).toBe(false);
      expect(comparison.qualityGates.claimReadiness.status).toBe(
        'exploratory_only',
      );
      expect(comparison.deltas.finalPathF1.absolute).toBeCloseTo(0.05);
      expect(comparison.deltas.bestPathF1.absolute).toBeCloseTo(0.05);
      expect(comparison.baseline.stability.bestToFinalPathF1Drop).toBeCloseTo(
        0.15,
      );
      expect(comparison.candidate.stability.bestToFinalPathF1Drop).toBeCloseTo(
        0.15,
      );
    });
  });

  it('surfaces mismatched devices in the comparison artifact', () => {
    withTempDir((dir) => {
      const baseline = join(dir, 'add.json');
      const candidate = join(dir, 'gated.json');
      const output = join(dir, 'comparison.json');
      writeJson(
        baseline,
        makeSummary({
          variantTag: 'additive-baseline-v1',
          fusionMode: 'add',
          finalPathF1: 0.4,
          bestPathF1: 0.55,
        }),
      );
      writeJson(
        candidate,
        makeSummary({
          variantTag: 'gated-fusion-followup-v1',
          fusionMode: 'gated',
          deviceIndex: 2,
          finalPathF1: 0.45,
          bestPathF1: 0.6,
        }),
      );

      const result = spawnSync(
        'pnpm',
        [
          'gpu:hrm:compare',
          '--',
          '--baseline',
          baseline,
          '--candidate',
          candidate,
          '--write',
          output,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );

      expect(result.status, result.stderr).toBe(0);
      const comparison = JSON.parse(readFileSync(output, 'utf8'));
      expect(comparison.matchedConfig.isMatchedExceptFusionModeAndVariantMetadata).toBe(
        true,
      );
      expect(comparison.matchedDevice.isMatched).toBe(false);
      expect(comparison.matchedDevice.candidate.index).toBe(2);
    });
  });

  it('prefers held-out finalTestEval when present', () => {
    withTempDir((dir) => {
      const baseline = join(dir, 'add.json');
      const candidate = join(dir, 'gated.json');
      const output = join(dir, 'comparison.json');
      writeJson(
        baseline,
        makeSummary({
          variantTag: 'additive-baseline-v1',
          fusionMode: 'add',
          finalPathF1: 0.4,
          bestPathF1: 0.55,
          includeFinalTestEval: true,
        }),
      );
      writeJson(
        candidate,
        makeSummary({
          variantTag: 'gated-fusion-followup-v1',
          fusionMode: 'gated',
          finalPathF1: 0.45,
          bestPathF1: 0.6,
          includeFinalTestEval: true,
        }),
      );

      const result = spawnSync(
        'pnpm',
        [
          'gpu:hrm:compare',
          '--',
          '--baseline',
          baseline,
          '--candidate',
          candidate,
          '--write',
          output,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );

      expect(result.status, result.stderr).toBe(0);
      const comparison = JSON.parse(readFileSync(output, 'utf8'));
      expect(comparison.baseline.finalMetricSection).toBe('finalTestEval');
      expect(comparison.candidate.finalMetricSection).toBe('finalTestEval');
      expect(comparison.qualityGates.usesHeldOutFinalTestEval).toBe(true);
      expect(comparison.qualityGates.usesHeldOutTestEval).toBe(true);
      expect(comparison.deltas.finalPathF1.absolute).toBeCloseTo(0.05);
    });
  });

  it('prefers selectedTestEval from retained best weights over terminal finalTestEval', () => {
    withTempDir((dir) => {
      const baseline = join(dir, 'selected-add.json');
      const candidate = join(dir, 'selected-gated.json');
      const output = join(dir, 'comparison.json');
      writeJson(
        baseline,
        makeSummary({
          variantTag: 'additive-baseline-selected',
          fusionMode: 'add',
          finalPathF1: 0.4,
          bestPathF1: 0.55,
          includeFinalTestEval: true,
          includeSelectedTestEval: true,
        }),
      );
      writeJson(
        candidate,
        makeSummary({
          variantTag: 'gated-fusion-selected',
          fusionMode: 'gated',
          finalPathF1: 0.45,
          bestPathF1: 0.6,
          includeFinalTestEval: true,
          includeSelectedTestEval: true,
        }),
      );

      const result = spawnSync(
        'pnpm',
        [
          'gpu:hrm:compare',
          '--',
          '--baseline',
          baseline,
          '--candidate',
          candidate,
          '--write',
          output,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );

      expect(result.status, result.stderr).toBe(0);
      const comparison = JSON.parse(readFileSync(output, 'utf8'));
      expect(comparison.baseline.finalMetricSection).toBe('selectedTestEval');
      expect(comparison.candidate.finalMetricSection).toBe('selectedTestEval');
      expect(comparison.baseline.finalMetricPathSource).toBe(
        'operatingThresholdEval',
      );
      expect(comparison.qualityGates.usesHeldOutFinalTestEval).toBe(false);
      expect(comparison.qualityGates.usesHeldOutTestEval).toBe(true);
      expect(
        comparison.qualityGates.usesRetainedBestWeightsForTestEval,
      ).toBe(true);
      expect(comparison.deltas.finalPathF1.absolute).toBeCloseTo(0.05);
    });
  });

  it('keeps mixed legacy/test comparisons exploratory', () => {
    withTempDir((dir) => {
      const baseline = join(dir, 'legacy-add.json');
      const candidate = join(dir, 'test-gated.json');
      const output = join(dir, 'comparison.json');
      writeJson(
        baseline,
        makeSummary({
          variantTag: 'additive-baseline-v1',
          fusionMode: 'add',
          finalPathF1: 0.4,
          bestPathF1: 0.55,
        }),
      );
      writeJson(
        candidate,
        makeSummary({
          variantTag: 'gated-fusion-followup-v1',
          fusionMode: 'gated',
          finalPathF1: 0.45,
          bestPathF1: 0.6,
          includeFinalTestEval: true,
        }),
      );

      const result = spawnSync(
        'pnpm',
        [
          'gpu:hrm:compare',
          '--',
          '--baseline',
          baseline,
          '--candidate',
          candidate,
          '--write',
          output,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );

      expect(result.status, result.stderr).toBe(0);
      const comparison = JSON.parse(readFileSync(output, 'utf8'));
      expect(comparison.baseline.finalMetricSection).toBe('finalEval');
      expect(comparison.candidate.finalMetricSection).toBe('finalTestEval');
      expect(comparison.qualityGates.usesHeldOutFinalTestEval).toBe(false);
      expect(comparison.qualityGates.usesHeldOutTestEval).toBe(false);
      expect(comparison.qualityGates.claimReadiness.status).toBe(
        'exploratory_only',
      );
    });
  });
});
