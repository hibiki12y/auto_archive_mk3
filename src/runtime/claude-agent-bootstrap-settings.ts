/**
 * Bootstrap settings for the Claude Agent runtime driver.
 *
 * Mirrors `codex-bootstrap-settings.ts` for the second runtime provider
 * registered by `specs/CLARIFICATIONS/multi-provider-scope.md`. Reads the
 * minimal env surface needed to instantiate
 * `ClaudeAgentRuntimeDriver` and produces a typed resolution that the
 * runtime driver factory can consume directly.
 *
 * Auth invariants (multi-provider-scope.md §인증 invariant):
 *   - Production: `AUTO_ARCHIVE_ANTHROPIC_API_KEY` (env-backed) is the
 *     sanctioned credential path. The container should run with
 *     `--bare` Claude Code to skip OAuth entirely.
 *   - Local dev: `AUTO_ARCHIVE_CLAUDE_CLI_PATH` may point at a `claude`
 *     binary that already holds Pro/Max OAuth tokens — single-user only.
 *     Tokens MUST NOT be shared into containers / multi-user hosts.
 */

import {
  BoundaryValidationError,
} from '../contracts/boundary-validators.js';
import type { AuthFingerprint } from './codex-bootstrap-settings.js';

export type { AuthFingerprint } from './codex-bootstrap-settings.js';

export const CLAUDE_AGENT_API_KEY_ENV = 'AUTO_ARCHIVE_ANTHROPIC_API_KEY';
export const CLAUDE_AGENT_CLI_PATH_ENV = 'AUTO_ARCHIVE_CLAUDE_CLI_PATH';
export const CLAUDE_AGENT_MODEL_ENV = 'AUTO_ARCHIVE_CLAUDE_MODEL';
export const CLAUDE_AGENT_FALLBACK_MODEL_ENV =
  'AUTO_ARCHIVE_CLAUDE_FALLBACK_MODEL';
export const CLAUDE_AGENT_REASONING_EFFORT_ENV =
  'AUTO_ARCHIVE_CLAUDE_REASONING_EFFORT';
export const CLAUDE_AGENT_PERMISSION_MODE_ENV =
  'AUTO_ARCHIVE_CLAUDE_PERMISSION_MODE';
export const CLAUDE_AGENT_MAX_TURNS_ENV = 'AUTO_ARCHIVE_CLAUDE_MAX_TURNS';
export const CLAUDE_AGENT_MAX_BUDGET_USD_ENV =
  'AUTO_ARCHIVE_CLAUDE_MAX_BUDGET_USD';

export type ClaudeAgentBootstrapAuthSource = 'claude-cli' | 'api-key' | 'none';

export type ClaudeAgentReasoningEffort =
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

const CLAUDE_AGENT_REASONING_EFFORT_VALUES: readonly ClaudeAgentReasoningEffort[] =
  ['low', 'medium', 'high', 'xhigh', 'max'];

export type ClaudeAgentPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

const CLAUDE_AGENT_PERMISSION_MODE_VALUES: readonly ClaudeAgentPermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
];

export interface ClaudeAgentBootstrapResolution {
  readonly anthropicApiKey?: string;
  readonly pathToClaudeCodeExecutable?: string;
  readonly model?: string;
  readonly fallbackModel?: string;
  readonly effort?: ClaudeAgentReasoningEffort;
  readonly permissionMode?: ClaudeAgentPermissionMode;
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
  readonly authSource: ClaudeAgentBootstrapAuthSource;
}

function readNonEmpty(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readPositiveInteger(
  env: NodeJS.ProcessEnv,
  key: string,
): number | undefined {
  const raw = readNonEmpty(env, key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new BoundaryValidationError(
      'B-SET',
      `${key} must be a positive integer.`,
    );
  }
  return parsed;
}

function readPositiveNumber(
  env: NodeJS.ProcessEnv,
  key: string,
): number | undefined {
  const raw = readNonEmpty(env, key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BoundaryValidationError(
      'B-SET',
      `${key} must be a positive finite number.`,
    );
  }
  return parsed;
}

export function resolveClaudeAgentBootstrapResolution(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeAgentBootstrapResolution {
  const anthropicApiKey = readNonEmpty(env, CLAUDE_AGENT_API_KEY_ENV);
  const pathToClaudeCodeExecutable = readNonEmpty(
    env,
    CLAUDE_AGENT_CLI_PATH_ENV,
  );
  const model = readNonEmpty(env, CLAUDE_AGENT_MODEL_ENV);
  const fallbackModel = readNonEmpty(env, CLAUDE_AGENT_FALLBACK_MODEL_ENV);
  if (
    model !== undefined &&
    fallbackModel !== undefined &&
    fallbackModel === model
  ) {
    throw new BoundaryValidationError(
      'B-SET',
      `${CLAUDE_AGENT_FALLBACK_MODEL_ENV} must differ from ${CLAUDE_AGENT_MODEL_ENV}.`,
    );
  }

  const effortRaw = readNonEmpty(env, CLAUDE_AGENT_REASONING_EFFORT_ENV);
  if (
    effortRaw !== undefined &&
    !CLAUDE_AGENT_REASONING_EFFORT_VALUES.includes(
      effortRaw as ClaudeAgentReasoningEffort,
    )
  ) {
    throw new BoundaryValidationError(
      'B-SET',
      `${CLAUDE_AGENT_REASONING_EFFORT_ENV} must be one of: ${CLAUDE_AGENT_REASONING_EFFORT_VALUES.join(', ')}.`,
    );
  }
  const effort =
    effortRaw === undefined
      ? undefined
      : (effortRaw as ClaudeAgentReasoningEffort);

  const permissionModeRaw = readNonEmpty(env, CLAUDE_AGENT_PERMISSION_MODE_ENV);
  if (
    permissionModeRaw !== undefined &&
    !CLAUDE_AGENT_PERMISSION_MODE_VALUES.includes(
      permissionModeRaw as ClaudeAgentPermissionMode,
    )
  ) {
    throw new BoundaryValidationError(
      'B-SET',
      `${CLAUDE_AGENT_PERMISSION_MODE_ENV} must be one of: ${CLAUDE_AGENT_PERMISSION_MODE_VALUES.join(', ')}.`,
    );
  }
  const permissionMode =
    permissionModeRaw === undefined
      ? undefined
      : (permissionModeRaw as ClaudeAgentPermissionMode);

  const maxTurns = readPositiveInteger(env, CLAUDE_AGENT_MAX_TURNS_ENV);
  const maxBudgetUsd = readPositiveNumber(env, CLAUDE_AGENT_MAX_BUDGET_USD_ENV);

  const authSource: ClaudeAgentBootstrapAuthSource =
    anthropicApiKey !== undefined
      ? 'api-key'
      : pathToClaudeCodeExecutable !== undefined
        ? 'claude-cli'
        : 'none';

  return {
    ...(anthropicApiKey === undefined ? {} : { anthropicApiKey }),
    ...(pathToClaudeCodeExecutable === undefined
      ? {}
      : { pathToClaudeCodeExecutable }),
    ...(model === undefined ? {} : { model }),
    ...(fallbackModel === undefined ? {} : { fallbackModel }),
    ...(effort === undefined ? {} : { effort }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
    authSource,
  };
}

/**
 * P2-C-2 — build a Claude-Agent auth fingerprint from a resolved
 * `ClaudeAgentBootstrapResolution`. Mirrors `buildCodexAuthFingerprint`.
 *
 * Captures the `authSource` discriminator plus a structural label for
 * *where* the credential lives (`cliPath` for `claude-cli`,
 * `apiKeyEnvVarName` for `api-key`). The actual API key value is never
 * read or recorded.
 */
export function buildClaudeAgentAuthFingerprint(
  resolution: ClaudeAgentBootstrapResolution,
): AuthFingerprint {
  if (resolution.authSource === 'claude-cli') {
    const cliPath = resolution.pathToClaudeCodeExecutable;
    return {
      authSource: 'claude-cli',
      ...(cliPath === undefined ? {} : { cliPath }),
    };
  }
  if (resolution.authSource === 'api-key') {
    return {
      authSource: 'api-key',
      apiKeyEnvVarName: CLAUDE_AGENT_API_KEY_ENV,
    };
  }
  return { authSource: 'none' };
}
