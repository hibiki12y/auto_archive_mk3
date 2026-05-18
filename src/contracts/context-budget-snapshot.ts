export const CONTEXT_BUDGET_SNAPSHOT_SCHEMA_VERSION = 1;

export type TokenUsageProvenance = 'provider-reported' | 'unavailable';
export type ContextFillProvenance =
  | 'provider-reported'
  | 'estimated'
  | 'unavailable';
export type ContextPressure = 'low' | 'medium' | 'high' | 'critical' | 'unknown';
export type CompactionProvenance = 'unavailable';

export interface ContextBudgetTokenUsageSummary {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface ContextBudgetSnapshot {
  readonly schemaVersion: typeof CONTEXT_BUDGET_SNAPSHOT_SCHEMA_VERSION;
  readonly tokenUsage: {
    readonly provenance: TokenUsageProvenance;
    readonly inputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
  readonly contextFill: {
    readonly provenance: ContextFillProvenance;
    readonly pressure: ContextPressure;
    readonly usedTokens?: number;
    readonly estimatedContextWindowTokens?: number;
    readonly fillRatio?: number;
  };
  readonly compaction: {
    readonly provenance: CompactionProvenance;
  };
  readonly rawTranscriptRendered: false;
}

export interface ProjectContextBudgetSnapshotInput {
  readonly tokenUsage?: ContextBudgetTokenUsageSummary;
  readonly tokenUsageObserved: boolean;
  readonly estimatedContextWindowTokens?: number;
}

export function projectContextBudgetSnapshot(
  input: ProjectContextBudgetSnapshotInput,
): ContextBudgetSnapshot {
  const tokenUsage = input.tokenUsageObserved
    ? normalizeTokenUsage(input.tokenUsage)
    : undefined;
  const canEstimateContextFill =
    tokenUsage !== undefined && input.estimatedContextWindowTokens !== undefined;
  const fillRatio = canEstimateContextFill
    ? roundRatio(tokenUsage.totalTokens / input.estimatedContextWindowTokens)
    : undefined;

  return Object.freeze({
    schemaVersion: CONTEXT_BUDGET_SNAPSHOT_SCHEMA_VERSION,
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
    contextFill: Object.freeze(
      canEstimateContextFill && fillRatio !== undefined
        ? {
            provenance: 'estimated' as const,
            pressure: classifyContextPressure(fillRatio),
            usedTokens: tokenUsage.totalTokens,
            estimatedContextWindowTokens: input.estimatedContextWindowTokens,
            fillRatio,
          }
        : {
            provenance: 'unavailable' as const,
            pressure: 'unknown' as const,
          },
    ),
    compaction: Object.freeze({
      provenance: 'unavailable' as const,
    }),
    rawTranscriptRendered: false,
  });
}

function normalizeTokenUsage(
  usage: ContextBudgetTokenUsageSummary | undefined,
): ContextBudgetTokenUsageSummary {
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

function classifyContextPressure(fillRatio: number): ContextPressure {
  if (fillRatio >= 0.9) return 'critical';
  if (fillRatio >= 0.75) return 'high';
  if (fillRatio >= 0.5) return 'medium';
  return 'low';
}

function roundRatio(value: number): number {
  return Math.round(value * 10000) / 10000;
}
