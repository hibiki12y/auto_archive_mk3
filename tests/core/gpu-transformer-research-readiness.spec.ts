import { describe, expect, it } from 'vitest';

import {
  buildGpuTransformerResearchReadinessReport,
  parseNvidiaSmiGpuCsv,
  renderGpuTransformerResearchReadinessReport,
} from '../../src/core/gpu-transformer-research-readiness.js';

const LIVE_2026_05_04_CSV = [
  '0, Quadro RTX 8000, 49152, 29614, 100, 84, 250.07, 260.00, 7.5',
  '1, Quadro RTX 8000, 49152, 19648, 100, 79, 253.32, 260.00, 7.5',
  '2, NVIDIA GeForce GTX 1060 3GB, 3072, 2, 0, 56, 6.88, 120.00, 6.1',
].join('\n');

describe('GPU Transformer research readiness', () => {
  it('parses nvidia-smi CSV rows without process names or secret-bearing fields', () => {
    const rows = parseNvidiaSmiGpuCsv(LIVE_2026_05_04_CSV);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      index: 0,
      name: 'Quadro RTX 8000',
      memoryTotalMiB: 49152,
      memoryUsedMiB: 29614,
      utilizationGpuPercent: 100,
      temperatureC: 84,
      powerDrawW: 250.07,
      powerLimitW: 260,
      computeCapability: '7.5',
    });
  });

  it('warns when high-memory GPUs exist but are saturated and no device is eligible', () => {
    const report = buildGpuTransformerResearchReadinessReport({
      gpus: parseNvidiaSmiGpuCsv(LIVE_2026_05_04_CSV),
      generatedAt: '2026-05-04T11:05:00.000Z',
      source: 'operator-provided',
    });

    expect(report.status).toBe('warn');
    expect(report.eligibleGpuIndexes).toEqual([]);
    expect(report.summary).toContain('High-memory GPU(s) are present');
    expect(report.gpus[0]?.blockers).toContain(
      'utilization 100% > allowed 30%',
    );
    expect(report.gpus[1]?.blockers).toContain(
      'utilization 100% > allowed 30%',
    );
    expect(report.gpus[2]?.blockers[0]).toContain('free VRAM');
    expect(report.gpus[2]?.blockers).toContain(
      'compute capability 6.1 < required 7.5',
    );
  });

  it('passes when at least one GPU meets free-memory/utilization/temperature thresholds', () => {
    const report = buildGpuTransformerResearchReadinessReport({
      gpus: parseNvidiaSmiGpuCsv(
        '0, Quadro RTX 8000, 49152, 1024, 3, 55, 40, 260',
      ),
      generatedAt: '2026-05-04T11:06:00.000Z',
    });

    expect(report.status).toBe('pass');
    expect(report.eligibleGpuIndexes).toEqual([0]);
    expect(renderGpuTransformerResearchReadinessReport(report)).toContain(
      'Status: PASS',
    );
  });

  it('fails when no GPU rows are available', () => {
    const report = buildGpuTransformerResearchReadinessReport({
      gpus: [],
      generatedAt: '2026-05-04T11:07:00.000Z',
    });

    expect(report.status).toBe('fail');
    expect(report.recommendedNextAction).toContain('NVIDIA driver/container');
  });

  it('rejects malformed rows instead of producing misleading readiness', () => {
    expect(() => parseNvidiaSmiGpuCsv('0, GPU')).toThrow(/expected at least 6/u);
  });
});
