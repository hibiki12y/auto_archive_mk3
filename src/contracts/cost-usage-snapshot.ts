export const COST_USAGE_SNAPSHOT_SCHEMA_VERSION = 1;

export type CostUsageTokenProvenance = 'provider-reported' | 'unavailable';
export type CostUsageProvenance =
  | 'provider-reported'
  | 'estimated'
  | 'configured-budget-only'
  | 'unavailable';

export interface CostUsageTokenSummary {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface CostUsageSnapshot {
  readonly schemaVersion: typeof COST_USAGE_SNAPSHOT_SCHEMA_VERSION;
  readonly tokenUsage: {
    readonly provenance: CostUsageTokenProvenance;
    readonly inputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
  readonly cost: {
    readonly provenance: CostUsageProvenance;
    readonly amountUsd?: number;
    readonly configuredBudgetUsd?: number;
  };
  readonly rawBillingRendered: false;
  readonly rawTranscriptRendered: false;
}

export interface ProjectCostUsageSnapshotInput {
  readonly tokenUsage?: CostUsageTokenSummary;
  readonly tokenUsageObserved: boolean;
  readonly costProvenance?: CostUsageProvenance;
  readonly amountUsd?: number;
  readonly configuredBudgetUsd?: number;
}

export function projectCostUsageSnapshot(
  input: ProjectCostUsageSnapshotInput,
): CostUsageSnapshot {
  const tokenUsage = input.tokenUsageObserved
    ? normalizeTokenUsage(input.tokenUsage)
    : undefined;
  const costProvenance = input.costProvenance ?? 'unavailable';

  return Object.freeze({
    schemaVersion: COST_USAGE_SNAPSHOT_SCHEMA_VERSION,
    tokenUsage: Object.freeze(
      tokenUsage === undefined
        ? { provenance: 'unavailable' as const }
        : {
            provenance: 'provider-reported' as const,
            inputTokens: tokenUsage.inputTokens,
            cachedInputTokens: tokenUsage.cachedInputTokens,
            outputTokens: tokenUsage.outputTokens,
            totalTokens: tokenUsage.totalTokens,
          },
    ),
    cost: Object.freeze({
      provenance: costProvenance,
      ...(input.amountUsd === undefined
        ? {}
        : { amountUsd: normalizeCurrencyAmount(input.amountUsd, 'amountUsd') }),
      ...(input.configuredBudgetUsd === undefined
        ? {}
        : {
            configuredBudgetUsd: normalizeCurrencyAmount(
              input.configuredBudgetUsd,
              'configuredBudgetUsd',
            ),
          }),
    }),
    rawBillingRendered: false,
    rawTranscriptRendered: false,
  });
}

function normalizeTokenUsage(
  usage: CostUsageTokenSummary | undefined,
): CostUsageTokenSummary {
  if (usage === undefined) {
    return {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
  }
  return {
    inputTokens: normalizeTokenCount(usage.inputTokens, 'inputTokens'),
    cachedInputTokens: normalizeTokenCount(
      usage.cachedInputTokens,
      'cachedInputTokens',
    ),
    outputTokens: normalizeTokenCount(usage.outputTokens, 'outputTokens'),
    totalTokens: normalizeTokenCount(usage.totalTokens, 'totalTokens'),
  };
}

function normalizeTokenCount(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer.`);
  }
  return value;
}

function normalizeCurrencyAmount(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative finite number.`);
  }
  return Math.round(value * 1_000_000) / 1_000_000;
}
