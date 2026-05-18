import type {
  ProviderFailureClassification,
  TerminalCause,
} from './terminal-cause.js';

export const RESTART_RECIPE_SNAPSHOT_SCHEMA_VERSION = 1;

export type RestartRecipeRetryability =
  | 'not-needed'
  | 'retryable'
  | 'not-retryable'
  | 'operator-action-required'
  | 'unknown';

export type RestartRecipeRecommendedAction =
  | 'none'
  | 'rerun-same-input'
  | 'increase-deadline-or-reduce-scope'
  | 'review-external-cancel-source'
  | 'resolve-runtime-veto'
  | 'fix-driver-or-configuration'
  | 'inspect-provider-failure';

export interface RestartRecipeSnapshot {
  readonly schemaVersion: typeof RESTART_RECIPE_SNAPSHOT_SCHEMA_VERSION;
  readonly terminalCauseKind: TerminalCause['kind'];
  readonly retryability: RestartRecipeRetryability;
  readonly recommendedAction: RestartRecipeRecommendedAction;
  readonly operatorActionRequired: boolean;
  readonly providerFailureClassification?: ProviderFailureClassification;
  readonly providerFailureRetryable?: boolean;
  readonly retryAfterMs?: number;
  readonly attemptsExhausted?: number;
  readonly deadlineMs?: number;
  readonly rawTaskIdRendered: false;
  readonly rawRuntimeInstanceIdRendered: false;
  readonly rawReasonRendered: false;
  readonly rawProviderMessageRendered: false;
}

export function projectRestartRecipeSnapshot(
  cause: TerminalCause,
): RestartRecipeSnapshot {
  switch (cause.kind) {
    case 'success':
      return baseRecipe(cause, {
        retryability: 'not-needed',
        recommendedAction: 'none',
        operatorActionRequired: false,
      });
    case 'timeout':
      return baseRecipe(cause, {
        retryability: 'retryable',
        recommendedAction: 'increase-deadline-or-reduce-scope',
        operatorActionRequired: false,
        deadlineMs: cause.deadlineMs,
      });
    case 'external-cancel':
      return baseRecipe(cause, {
        retryability: 'operator-action-required',
        recommendedAction: 'review-external-cancel-source',
        operatorActionRequired: true,
      });
    case 'runtime-veto':
      return baseRecipe(cause, {
        retryability: 'operator-action-required',
        recommendedAction: 'resolve-runtime-veto',
        operatorActionRequired: true,
      });
    case 'driver-failure':
      return baseRecipe(cause, {
        retryability: 'operator-action-required',
        recommendedAction: 'fix-driver-or-configuration',
        operatorActionRequired: true,
      });
    case 'provider-failure':
      return baseRecipe(cause, {
        retryability: cause.retryable
          ? 'retryable'
          : 'operator-action-required',
        recommendedAction: 'inspect-provider-failure',
        operatorActionRequired: !cause.retryable,
        providerFailureClassification: cause.classification,
        providerFailureRetryable: cause.retryable,
        ...(cause.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: cause.retryAfterMs }),
        ...(cause.attemptsExhausted === undefined
          ? {}
          : { attemptsExhausted: cause.attemptsExhausted }),
      });
    default: {
      const _exhaustive: never = cause;
      return _exhaustive;
    }
  }
}

function baseRecipe(
  cause: TerminalCause,
  fields: Omit<RestartRecipeSnapshot, 'schemaVersion' | 'terminalCauseKind' | 'rawTaskIdRendered' | 'rawRuntimeInstanceIdRendered' | 'rawReasonRendered' | 'rawProviderMessageRendered'>,
): RestartRecipeSnapshot {
  return Object.freeze({
    schemaVersion: RESTART_RECIPE_SNAPSHOT_SCHEMA_VERSION,
    terminalCauseKind: cause.kind,
    ...fields,
    rawTaskIdRendered: false,
    rawRuntimeInstanceIdRendered: false,
    rawReasonRendered: false,
    rawProviderMessageRendered: false,
  });
}
