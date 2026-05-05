export type GpuTransformerResearchReadinessStatus = 'pass' | 'warn' | 'fail';

export interface NvidiaSmiGpuSnapshot {
  readonly index: number;
  readonly name: string;
  readonly memoryTotalMiB: number;
  readonly memoryUsedMiB: number;
  readonly utilizationGpuPercent: number;
  readonly temperatureC: number;
  readonly powerDrawW?: number;
  readonly powerLimitW?: number;
  readonly computeCapability?: string;
}

export interface GpuTransformerResearchThresholds {
  /**
   * Minimum free VRAM for the high-end smoke lane. Default targets
   * small-but-real modern Transformer architecture experiments (GQA/MLA,
   * MoE routing micro-batches, KDA/Mamba-style kernels) without requiring
   * full frontier-scale training.
   */
  readonly minFreeMemoryMiB: number;
  readonly maxUtilizationGpuPercent: number;
  readonly maxTemperatureC: number;
  readonly minComputeCapability?: string;
}

export interface GpuTransformerResearchGpuAssessment extends NvidiaSmiGpuSnapshot {
  readonly memoryFreeMiB: number;
  readonly highMemoryDevice: boolean;
  readonly eligible: boolean;
  readonly blockers: readonly string[];
}

export interface GpuTransformerResearchReadinessReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly source: 'nvidia-smi' | 'test-fixture' | 'operator-provided';
  readonly status: GpuTransformerResearchReadinessStatus;
  readonly thresholds: GpuTransformerResearchThresholds;
  readonly gpus: readonly GpuTransformerResearchGpuAssessment[];
  readonly eligibleGpuIndexes: readonly number[];
  readonly summary: string;
  readonly recommendedNextAction: string;
}

export const DEFAULT_GPU_TRANSFORMER_RESEARCH_THRESHOLDS: GpuTransformerResearchThresholds =
  Object.freeze({
    minFreeMemoryMiB: 24 * 1024,
    maxUtilizationGpuPercent: 30,
    maxTemperatureC: 85,
    minComputeCapability: '7.5',
  });

function parseFiniteNumber(value: string, fieldName: string, line: string): number {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    /^n\/a$/iu.test(normalized) ||
    /^\[?not supported\]?$/iu.test(normalized)
  ) {
    throw new Error(`${fieldName} is not numeric in nvidia-smi row: ${line}`);
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} is not numeric in nvidia-smi row: ${line}`);
  }
  return parsed;
}

function parseOptionalFiniteNumber(value: string): number | undefined {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    /^n\/a$/iu.test(normalized) ||
    /^\[?not supported\]?$/iu.test(normalized)
  ) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseNvidiaSmiGpuCsv(
  csv: string,
): readonly NvidiaSmiGpuSnapshot[] {
  const rows: NvidiaSmiGpuSnapshot[] = [];
  for (const rawLine of csv.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const columns = line.split(',').map((part) => part.trim());
    if (columns.length < 6) {
      throw new Error(`nvidia-smi row has ${columns.length} columns; expected at least 6: ${line}`);
    }
    const [
      indexRaw,
      name,
      memoryTotalRaw,
      memoryUsedRaw,
      utilizationRaw,
      temperatureRaw,
      powerDrawRaw,
      powerLimitRaw,
      computeCapabilityRaw,
    ] = columns;
    if (name === undefined || name.length === 0) {
      throw new Error(`GPU name is missing in nvidia-smi row: ${line}`);
    }
    rows.push({
      index: parseFiniteNumber(indexRaw ?? '', 'index', line),
      name,
      memoryTotalMiB: parseFiniteNumber(memoryTotalRaw ?? '', 'memory.total', line),
      memoryUsedMiB: parseFiniteNumber(memoryUsedRaw ?? '', 'memory.used', line),
      utilizationGpuPercent: parseFiniteNumber(
        utilizationRaw ?? '',
        'utilization.gpu',
        line,
      ),
      temperatureC: parseFiniteNumber(temperatureRaw ?? '', 'temperature.gpu', line),
      ...(powerDrawRaw === undefined
        ? {}
        : { powerDrawW: parseOptionalFiniteNumber(powerDrawRaw) }),
      ...(powerLimitRaw === undefined
        ? {}
        : { powerLimitW: parseOptionalFiniteNumber(powerLimitRaw) }),
      ...(computeCapabilityRaw === undefined || computeCapabilityRaw.trim().length === 0
        ? {}
        : { computeCapability: computeCapabilityRaw.trim() }),
    });
  }
  return Object.freeze(rows);
}

function parseComputeCapability(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?$/u);
  if (match === null) {
    return undefined;
  }
  const major = Number(match[1]);
  const minor = Number(match[2] ?? '0');
  return major + minor / 10;
}

export function buildGpuTransformerResearchReadinessReport(input: {
  readonly gpus: readonly NvidiaSmiGpuSnapshot[];
  readonly thresholds?: Partial<GpuTransformerResearchThresholds>;
  readonly generatedAt?: string;
  readonly source?: GpuTransformerResearchReadinessReport['source'];
}): GpuTransformerResearchReadinessReport {
  const thresholds: GpuTransformerResearchThresholds = {
    ...DEFAULT_GPU_TRANSFORMER_RESEARCH_THRESHOLDS,
    ...input.thresholds,
  };
  const assessments = input.gpus.map((gpu): GpuTransformerResearchGpuAssessment => {
    const memoryFreeMiB = Math.max(0, gpu.memoryTotalMiB - gpu.memoryUsedMiB);
    const blockers: string[] = [];
    if (memoryFreeMiB < thresholds.minFreeMemoryMiB) {
      blockers.push(
        `free VRAM ${memoryFreeMiB}MiB < required ${thresholds.minFreeMemoryMiB}MiB`,
      );
    }
    if (gpu.utilizationGpuPercent > thresholds.maxUtilizationGpuPercent) {
      blockers.push(
        `utilization ${gpu.utilizationGpuPercent}% > allowed ${thresholds.maxUtilizationGpuPercent}%`,
      );
    }
    if (gpu.temperatureC > thresholds.maxTemperatureC) {
      blockers.push(
        `temperature ${gpu.temperatureC}C > allowed ${thresholds.maxTemperatureC}C`,
      );
    }
    const minimumComputeCapability = parseComputeCapability(
      thresholds.minComputeCapability,
    );
    const gpuComputeCapability = parseComputeCapability(gpu.computeCapability);
    if (
      minimumComputeCapability !== undefined &&
      gpuComputeCapability !== undefined &&
      gpuComputeCapability < minimumComputeCapability
    ) {
      blockers.push(
        `compute capability ${gpu.computeCapability} < required ${thresholds.minComputeCapability}`,
      );
    }
    const highMemoryDevice = gpu.memoryTotalMiB >= thresholds.minFreeMemoryMiB;
    return {
      ...gpu,
      memoryFreeMiB,
      highMemoryDevice,
      eligible: blockers.length === 0,
      blockers: Object.freeze(blockers),
    };
  });

  const eligibleGpuIndexes = assessments
    .filter((gpu) => gpu.eligible)
    .map((gpu) => gpu.index);
  const highMemoryDevices = assessments.filter((gpu) => gpu.highMemoryDevice);
  const status: GpuTransformerResearchReadinessStatus =
    assessments.length === 0
      ? 'fail'
      : eligibleGpuIndexes.length > 0
        ? 'pass'
        : 'warn';
  const summary =
    status === 'pass'
      ? `${eligibleGpuIndexes.length} GPU(s) are eligible for a bounded modern-Transformer research smoke.`
      : status === 'warn'
        ? highMemoryDevices.length > 0
          ? 'High-memory GPU(s) are present but currently blocked by utilization, temperature, or free-memory thresholds.'
          : 'GPU(s) are present, but none meet the high-end Transformer research memory threshold.'
        : 'No NVIDIA GPU rows were available from nvidia-smi.';
  const recommendedNextAction =
    status === 'pass'
      ? 'Run a bounded GPU smoke that writes training and evaluation artifacts under results/task-artifacts before attempting larger experiments.'
      : status === 'warn'
        ? 'Wait for or free an eligible high-memory GPU, then rerun the readiness check; do not start training on saturated devices.'
        : 'Fix NVIDIA driver/container visibility before scheduling GPU Transformer research.';

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    source: input.source ?? 'nvidia-smi',
    status,
    thresholds,
    gpus: Object.freeze(assessments),
    eligibleGpuIndexes: Object.freeze(eligibleGpuIndexes),
    summary,
    recommendedNextAction,
  };
}

export function renderGpuTransformerResearchReadinessReport(
  report: GpuTransformerResearchReadinessReport,
): string {
  const lines = [
    'GPU Transformer research readiness',
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status.toUpperCase()}`,
    `Summary: ${report.summary}`,
    `Thresholds: free>=${report.thresholds.minFreeMemoryMiB}MiB, utilization<=${report.thresholds.maxUtilizationGpuPercent}%, temperature<=${report.thresholds.maxTemperatureC}C, computeCapability>=${report.thresholds.minComputeCapability ?? 'n/a'}`,
    `Eligible GPUs: ${
      report.eligibleGpuIndexes.length === 0
        ? '(none)'
        : report.eligibleGpuIndexes.join(', ')
    }`,
    '',
    'GPU assessments:',
    ...report.gpus.map((gpu) => {
      const blockers =
        gpu.blockers.length === 0 ? 'none' : gpu.blockers.join('; ');
      return `- GPU ${gpu.index} ${gpu.name}: free=${gpu.memoryFreeMiB}MiB/${gpu.memoryTotalMiB}MiB util=${gpu.utilizationGpuPercent}% temp=${gpu.temperatureC}C cc=${gpu.computeCapability ?? 'unknown'} eligible=${gpu.eligible ? 'yes' : 'no'} blockers=${blockers}`;
    }),
    '',
    `Recommended next action: ${report.recommendedNextAction}`,
  ];
  return lines.join('\n');
}
