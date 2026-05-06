import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse } from 'dotenv';

import { createConfigCache } from '../config/config-cache.js';
import type { ConfigCachePort } from '../config/config-cache.js';

import { AUTO_ARCHIVE_COMPUTE_NODE } from '../core/compute-node-factory.js';
import { CurrentNodeComputeNode } from '../core/current-node-compute-node.js';
import { SlurmApptainerComputeNode } from '../core/compute-node-slurm-apptainer.js';
import {
  resolveAutonomousResearchEvidenceDoctorStatusFromEnv,
  resolveAgentHarnessRegistryDoctorStatusFromEnv,
  resolveControlPlaneOtelLogsDoctorStatusFromEnv,
  resolveLiveProofReportDoctorStatusFromEnv,
  resolvePeekabooEvidenceReportDoctorStatusFromEnv,
  resolvePersonaTelemetryReportDoctorStatusFromEnv,
  resolvePlanaAdvisorEventsDoctorStatusFromEnv,
  resolveRuntimeProviderEvidenceDoctorStatusFromEnv,
  resolveShellHookDoctorStatusFromEnv,
  resolveSessionBindingEvidenceReportDoctorStatusFromEnv,
  resolveSubagentOperatorEvidenceReportDoctorStatusFromEnv,
  resolveTaskArchiveEvidenceReportDoctorStatusFromEnv,
  resolveTaskHealthEvidenceReportDoctorStatusFromEnv,
  resolveTraitSchedulerTickEvidenceDoctorStatusFromEnv,
} from '../core/doctor.js';
import {
  InMemoryTraitUsageTelemetry,
  type TraitUsageTelemetryPort,
} from '../core/trait-usage-telemetry.js';
import {
  createTaskStallObserverFromEnv,
} from '../core/task-stall-observer.js';
import { ProcessSubprocessRunner } from '../core/process-subprocess-runner.js';
import { Dispatcher } from '../core/dispatcher.js';
import type { ComputeNode } from '../core/compute-node.js';
import { GitLabCloneComputeNode } from '../core/gitlab-clone-compute-node.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import type { CodexRuntimeDriverOptions } from '../runtime/codex-runtime-adapter.js';
import { resolveCodexBootstrapResolution } from '../runtime/codex-bootstrap-settings.js';
import {
  createRuntimeDriverFromEnv,
  resolveRuntimeProvider,
} from '../runtime/runtime-driver-factory.js';
import {
  createRepositoryTraitRuntimeAgentOptionsFromEnv,
} from '../runtime/repository-trait-runtime-decorator-resolver.js';
import {
  discoverTraitModuleManifests,
  type TraitModuleRegistry,
} from '../core/trait-module-loader.js';
import { resolveClaudeAgentBootstrapResolution } from '../runtime/claude-agent-bootstrap-settings.js';
import {
  createDefaultClaudeAgentQueryFactory,
  type ClaudeAgentQueryFactory,
} from '../runtime/claude-agent-runtime-adapter.js';
import type { RuntimeSandboxMode } from '../contracts/runtime-settings.js';
import { Arona } from '../core/arona.js';
import type { AronaOptions } from '../core/arona.js';
import {
  createGitLabArtifactPublisherFromEnv,
  createGitLabInstanceManagerFromEnv,
  createGitLabProjectAssignmentManagerFromEnv,
  createGitLabWorkResultRecorderFromEnv,
  resolveGitLabIntegrationConfig,
  GitLabHttpProjectManager,
} from '../core/gitlab-project-manager.js';
import { Plana } from '../core/plana.js';
import {
  JsonlPlanaClaudeAdvisorAuditLedger,
  PlanaClaudeRuntimeAdvisor,
} from '../core/plana-claude-runtime-advisor.js';
import type { PlanaRuntimeAdvisor } from '../core/plana-runtime-advisor.js';
import type { RuntimeMidCycleObserver } from '../contracts/runtime-mid-cycle-observer.js';
import {
  InMemoryRuntimeApprovalRegistry,
  createRegistryBackedApprovalHook,
} from '../core/runtime-approval-registry.js';
import {
  startDiscordFirstSliceBot,
  type DiscordBotLifecycleLogger,
  type StartedDiscordFirstSliceBot,
  type StartDiscordFirstSliceBotOptions,
} from './discord-bot.js';
import type { DiscordDoctorStatus } from './discord-result-renderer.js';
import type { DefaultDiscordTaskRequestFactoryOptions } from './discord-command-handlers.js';
import {
  JsonlControlPlaneLedger,
  type ControlPlaneLedgerPort,
  type ControlPlaneObserverPort,
} from '../control/control-plane-ledger.js';
import {
  createControlPlaneOtelLogsEmitterFromEnv,
} from '../control/control-plane-otel-emitter.js';
import {
  recordTaskHealthStallsToControlPlaneLedger,
  type TaskHealthStallSignalSource,
} from '../control/task-health-control-plane-recorder.js';
export {
  AUTO_ARCHIVE_OTEL_LOGS_URL,
  AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES,
} from '../control/control-plane-otel-emitter.js';
import {
  DiscordAccessPolicy,
  parseDiscordIdList,
  type DiscordAccessPolicyOptions,
} from './discord-access-policy.js';
import {
  SeededDiscordAuthDatabase,
  SqliteDiscordAuthDatabase,
  type DiscordAuthDatabase,
  type DiscordAuthDatabaseMode,
  type SqliteDiscordAuthDatabaseDriver,
} from './discord-auth-database.js';
import { DiscordTaskRegistry } from './discord-task-registry.js';
import { DiscordSessionBindingManager } from './discord-session-binding.js';
import { createPersonaTransformerFromEnv } from '../persona/persona-config.js';

/**
 * Process-level config file cache. Keyed on (absolute path, mtime, sha256).
 * Bypassed when AUTO_ARCHIVE_CONFIG_CACHE=off in the environment.
 */
const _bootstrapConfigCache: ConfigCachePort = createConfigCache();

export const AUTO_ARCHIVE_DISCORD_TOKEN = 'AUTO_ARCHIVE_DISCORD_TOKEN';
export const AUTO_ARCHIVE_DISCORD_APPLICATION_ID =
  'AUTO_ARCHIVE_DISCORD_APPLICATION_ID';
export const AUTO_ARCHIVE_DISCORD_GUILD_ID = 'AUTO_ARCHIVE_DISCORD_GUILD_ID';
export const AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT =
  'AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT';
export const AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY =
  'AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY';
export const AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_BACKFILL =
  'AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_BACKFILL';
export const AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_LIMIT =
  'AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_LIMIT';
export const AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_MAX_ENTRIES =
  'AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_MAX_ENTRIES';
export const AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_BACKFILL_LIMIT =
  'AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_BACKFILL_LIMIT';
export const AUTO_ARCHIVE_DISCORD_NATURAL_LANGUAGE_TRIGGER_MODE =
  'AUTO_ARCHIVE_DISCORD_NATURAL_LANGUAGE_TRIGGER_MODE';
export const AUTO_ARCHIVE_DISCORD_NATURAL_LANGUAGE_PREFIXES =
  'AUTO_ARCHIVE_DISCORD_NATURAL_LANGUAGE_PREFIXES';
export const AUTO_ARCHIVE_DISCORD_SESSION_LOG_PARENT_CHANNEL_ID =
  'AUTO_ARCHIVE_DISCORD_SESSION_LOG_PARENT_CHANNEL_ID';
export const AUTO_ARCHIVE_DISCORD_TASK_CPU_CORES =
  'AUTO_ARCHIVE_DISCORD_TASK_CPU_CORES';
export const AUTO_ARCHIVE_DISCORD_TASK_MEMORY_MIB =
  'AUTO_ARCHIVE_DISCORD_TASK_MEMORY_MIB';
export const AUTO_ARCHIVE_DISCORD_TASK_WALL_TIME_SEC =
  'AUTO_ARCHIVE_DISCORD_TASK_WALL_TIME_SEC';
export const AUTO_ARCHIVE_DISCORD_TASK_GPU_CARDS =
  'AUTO_ARCHIVE_DISCORD_TASK_GPU_CARDS';
export const AUTO_ARCHIVE_DISCORD_TASK_WORKING_DIRECTORY =
  'AUTO_ARCHIVE_DISCORD_TASK_WORKING_DIRECTORY';
export const AUTO_ARCHIVE_DISCORD_TASK_ARTIFACT_LOCATION =
  'AUTO_ARCHIVE_DISCORD_TASK_ARTIFACT_LOCATION';
export const AUTO_ARCHIVE_DISCORD_TASK_SANDBOX_MODE =
  'AUTO_ARCHIVE_DISCORD_TASK_SANDBOX_MODE';
export const AUTO_ARCHIVE_CONTROL_LEDGER_PATH =
  'AUTO_ARCHIVE_CONTROL_LEDGER_PATH';
export const AUTO_ARCHIVE_DISCORD_ALLOWED_USER_IDS =
  'AUTO_ARCHIVE_DISCORD_ALLOWED_USER_IDS';
export const AUTO_ARCHIVE_DISCORD_ALLOWED_CHANNEL_IDS =
  'AUTO_ARCHIVE_DISCORD_ALLOWED_CHANNEL_IDS';
export const AUTO_ARCHIVE_DISCORD_ADMIN_USER_IDS =
  'AUTO_ARCHIVE_DISCORD_ADMIN_USER_IDS';
export const AUTO_ARCHIVE_DISCORD_AUTH_DB_PATH =
  'AUTO_ARCHIVE_DISCORD_AUTH_DB_PATH';
export const AUTO_ARCHIVE_DISCORD_AUTH_DB_MODE =
  'AUTO_ARCHIVE_DISCORD_AUTH_DB_MODE';
export const AUTO_ARCHIVE_DISCORD_AUTH_DB_DRIVER =
  'AUTO_ARCHIVE_DISCORD_AUTH_DB_DRIVER';
export const AUTO_ARCHIVE_DISCORD_AUTH_DB_PYTHON_BIN =
  'AUTO_ARCHIVE_DISCORD_AUTH_DB_PYTHON_BIN';
export const AUTO_ARCHIVE_DISCORD_AUTH_DB_SQLITE_BIN =
  'AUTO_ARCHIVE_DISCORD_AUTH_DB_SQLITE_BIN';
export const AUTO_ARCHIVE_DISCORD_ENABLE_DMS =
  'AUTO_ARCHIVE_DISCORD_ENABLE_DMS';
export const AUTO_ARCHIVE_DISCORD_ALLOW_BOTS =
  'AUTO_ARCHIVE_DISCORD_ALLOW_BOTS';
export const AUTO_ARCHIVE_TRAIT_MODULE_WORKSPACE_ROOT =
  'AUTO_ARCHIVE_TRAIT_MODULE_WORKSPACE_ROOT';

const DEFAULT_SERVICE_CONTEXT_HISTORY_LIMIT = 30;
const DEFAULT_SERVICE_CONTEXT_HISTORY_MAX_ENTRIES = 500;
const DEFAULT_SERVICE_CONTEXT_HISTORY_BACKFILL_LIMIT = 30;
const DEFAULT_SERVICE_READY_TIMEOUT_MS = 45_000;
const DEFAULT_CONTROL_LEDGER_PATH = 'runtime-state/research-control-events.jsonl';
const DEFAULT_AUTH_DB_PATH = 'runtime-state/discord-auth.sqlite';
const DEFAULT_SERVICE_NATURAL_LANGUAGE_PREFIXES = Object.freeze([
  'arona',
  '아로나',
  'plana',
  '플라나',
]);

export class DiscordServiceBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscordServiceBootstrapError';
    Object.setPrototypeOf(this, DiscordServiceBootstrapError.prototype);
  }
}

export interface DiscordServiceBootstrapEnvLoadOptions {
  readonly rootDirectory?: string;
  readonly fileExists?: (path: string) => boolean;
  readonly readEnvFile?: (path: string) => string;
}

export interface DiscordServiceBootstrapConfig {
  readonly token: string;
  readonly applicationId: string;
  readonly guildId: string;
  readonly enableMessageContentIntent: boolean;
  readonly controlLedgerPath: string;
  readonly authDatabaseOptions: DiscordServiceAuthDatabaseOptions;
  readonly accessPolicyOptions: DiscordAccessPolicyOptions;
  readonly requestFactoryOptions: DefaultDiscordTaskRequestFactoryOptions;
  readonly naturalLanguageOptions: Pick<
    StartDiscordFirstSliceBotOptions,
    | 'enableNaturalLanguageMessages'
    | 'naturalLanguagePrefixes'
    | 'naturalLanguageTriggerMode'
    | 'enableMessageContextHistory'
    | 'enableMessageContextHistoryBackfill'
    | 'enableNaturalLanguagePrefixNotice'
    | 'messageContextHistoryLimit'
    | 'messageContextHistoryMaxEntries'
    | 'messageContextHistoryBackfillLimit'
  >;
}

export interface DiscordServiceAuthDatabaseOptions {
  readonly mode: DiscordAuthDatabaseMode;
  readonly path: string;
  readonly driver: SqliteDiscordAuthDatabaseDriver;
  readonly pythonBinaryPath: string;
  readonly sqliteBinaryPath: string;
}

function requireEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new DiscordServiceBootstrapError(
      `Missing required environment variable ${name}.`,
    );
  }
  return value;
}

function parseBooleanEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: boolean,
): boolean {
  const rawValue = env[name]?.trim().toLowerCase();
  if (rawValue === undefined || rawValue === '') {
    return defaultValue;
  }

  if (['1', 'true', 'yes', 'on'].includes(rawValue)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(rawValue)) {
    return false;
  }

  throw new DiscordServiceBootstrapError(
    `${name} must be one of: 1, true, yes, on, 0, false, no, off; received "${env[name]}".`,
  );
}

function parsePositiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
): number {
  const rawValue = env[name]?.trim();
  if (rawValue === undefined || rawValue === '') {
    return defaultValue;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DiscordServiceBootstrapError(
      `${name} must be a positive integer; received "${env[name]}".`,
    );
  }
  return parsed;
}

function parseNonNegativeIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
): number {
  const rawValue = env[name]?.trim();
  if (rawValue === undefined || rawValue === '') {
    return defaultValue;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new DiscordServiceBootstrapError(
      `${name} must be a non-negative integer; received "${env[name]}".`,
    );
  }
  return parsed;
}

function parseStringEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: string,
): string {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? defaultValue : value;
}

function parseRuntimeSandboxModeEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: RuntimeSandboxMode,
): RuntimeSandboxMode {
  const value = env[name]?.trim();
  if (value === undefined || value === '') {
    return defaultValue;
  }
  if (
    value === 'read-only' ||
    value === 'workspace-write' ||
    value === 'danger-full-access'
  ) {
    return value;
  }
  throw new DiscordServiceBootstrapError(
    `${name} must be one of: read-only, workspace-write, danger-full-access; received "${env[name]}".`,
  );
}

function parseAuthDatabaseMode(env: NodeJS.ProcessEnv): DiscordAuthDatabaseMode {
  const rawValue = env[AUTO_ARCHIVE_DISCORD_AUTH_DB_MODE]?.trim();
  if (rawValue === undefined || rawValue === '') {
    return 'sqlite';
  }
  if (rawValue === 'sqlite' || rawValue === 'memory') {
    return rawValue;
  }
  throw new DiscordServiceBootstrapError(
    `${AUTO_ARCHIVE_DISCORD_AUTH_DB_MODE} must be one of: sqlite, memory; received "${rawValue}".`,
  );
}

function parseAuthDatabaseDriver(
  env: NodeJS.ProcessEnv,
): SqliteDiscordAuthDatabaseDriver {
  const rawValue = env[AUTO_ARCHIVE_DISCORD_AUTH_DB_DRIVER]?.trim();
  if (rawValue === undefined || rawValue === '') {
    return 'python';
  }
  if (rawValue === 'python' || rawValue === 'sqlite3') {
    return rawValue;
  }
  throw new DiscordServiceBootstrapError(
    `${AUTO_ARCHIVE_DISCORD_AUTH_DB_DRIVER} must be one of: python, sqlite3; received "${rawValue}".`,
  );
}

function mergeDiscordIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function parseNaturalLanguageTriggerMode(
  env: NodeJS.ProcessEnv,
): 'mention' | 'mention-or-prefix' {
  const rawValue =
    env[AUTO_ARCHIVE_DISCORD_NATURAL_LANGUAGE_TRIGGER_MODE]?.trim();
  if (rawValue === undefined || rawValue === '') {
    return 'mention';
  }
  if (rawValue === 'mention' || rawValue === 'mention-or-prefix') {
    return rawValue;
  }
  throw new DiscordServiceBootstrapError(
    `${AUTO_ARCHIVE_DISCORD_NATURAL_LANGUAGE_TRIGGER_MODE} must be one of: mention, mention-or-prefix; received "${rawValue}".`,
  );
}

function parseNaturalLanguagePrefixes(env: NodeJS.ProcessEnv): readonly string[] {
  const rawValue = env[AUTO_ARCHIVE_DISCORD_NATURAL_LANGUAGE_PREFIXES]?.trim();
  if (rawValue === undefined || rawValue === '') {
    return DEFAULT_SERVICE_NATURAL_LANGUAGE_PREFIXES;
  }
  const prefixes = rawValue
    .split(',')
    .map((prefix) => prefix.trim())
    .filter(Boolean);
  if (prefixes.length === 0) {
    throw new DiscordServiceBootstrapError(
      `${AUTO_ARCHIVE_DISCORD_NATURAL_LANGUAGE_PREFIXES} must include at least one non-empty prefix when provided.`,
    );
  }
  return prefixes;
}

export function resolveDiscordServiceBootstrapEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: DiscordServiceBootstrapEnvLoadOptions = {},
): NodeJS.ProcessEnv {
  const envFilePath = resolve(options.rootDirectory ?? process.cwd(), '.env');
  const fileExists = options.fileExists ?? existsSync;

  if (!fileExists(envFilePath)) {
    return env;
  }

  // When a custom readEnvFile override is provided (e.g. in tests) bypass the
  // process-level cache and call it directly so test doubles stay in control.
  if (options.readEnvFile !== undefined) {
    return {
      ...parse(options.readEnvFile(envFilePath)),
      ...env,
    };
  }

  // Default path: route through the process-level config cache.
  const cached = _bootstrapConfigCache.get(envFilePath, (raw) => parse(raw));
  return {
    ...cached.value,
    ...env,
  };
}

function resolveDiscordServiceBootstrapConfigFromEnv(
  env: NodeJS.ProcessEnv,
): DiscordServiceBootstrapConfig {
  const adminUserIds = mergeDiscordIds(
    parseDiscordIdList(env[AUTO_ARCHIVE_DISCORD_ADMIN_USER_IDS]),
  );

  return {
    token: requireEnv(env, AUTO_ARCHIVE_DISCORD_TOKEN),
    applicationId: requireEnv(env, AUTO_ARCHIVE_DISCORD_APPLICATION_ID),
    guildId: requireEnv(env, AUTO_ARCHIVE_DISCORD_GUILD_ID),
    controlLedgerPath: parseStringEnv(
      env,
      AUTO_ARCHIVE_CONTROL_LEDGER_PATH,
      DEFAULT_CONTROL_LEDGER_PATH,
    ),
    authDatabaseOptions: {
      mode: parseAuthDatabaseMode(env),
      path: parseStringEnv(
        env,
        AUTO_ARCHIVE_DISCORD_AUTH_DB_PATH,
        DEFAULT_AUTH_DB_PATH,
      ),
      driver: parseAuthDatabaseDriver(env),
      pythonBinaryPath: parseStringEnv(
        env,
        AUTO_ARCHIVE_DISCORD_AUTH_DB_PYTHON_BIN,
        'python3',
      ),
      sqliteBinaryPath: parseStringEnv(
        env,
        AUTO_ARCHIVE_DISCORD_AUTH_DB_SQLITE_BIN,
        'sqlite3',
      ),
    },
    enableMessageContentIntent: parseBooleanEnv(
      env,
      AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT,
      false,
    ),
    requestFactoryOptions: {
      resources: {
        requested: {
          cpuCores: parsePositiveIntegerEnv(
            env,
            AUTO_ARCHIVE_DISCORD_TASK_CPU_CORES,
            2,
          ),
          memoryMiB: parsePositiveIntegerEnv(
            env,
            AUTO_ARCHIVE_DISCORD_TASK_MEMORY_MIB,
            4096,
          ),
          wallTimeSec: parsePositiveIntegerEnv(
            env,
            AUTO_ARCHIVE_DISCORD_TASK_WALL_TIME_SEC,
            1800,
          ),
          gpuCards: parseNonNegativeIntegerEnv(
            env,
            AUTO_ARCHIVE_DISCORD_TASK_GPU_CARDS,
            0,
          ),
        },
      },
      runtimeSettings: {
        networkProfile: 'provider-only',
        sandboxMode: parseRuntimeSandboxModeEnv(
          env,
          AUTO_ARCHIVE_DISCORD_TASK_SANDBOX_MODE,
          'workspace-write',
        ),
        approvalPolicy: 'on-request',
        workingDirectory: parseStringEnv(
          env,
          AUTO_ARCHIVE_DISCORD_TASK_WORKING_DIRECTORY,
          '.',
        ),
      },
      artifactLocation: parseStringEnv(
        env,
        AUTO_ARCHIVE_DISCORD_TASK_ARTIFACT_LOCATION,
        'results/task-artifacts',
      ),
    },
    naturalLanguageOptions: {
      enableNaturalLanguageMessages: true,
      naturalLanguagePrefixes: parseNaturalLanguagePrefixes(env),
      naturalLanguageTriggerMode: parseNaturalLanguageTriggerMode(env),
      enableMessageContextHistory: parseBooleanEnv(
        env,
        AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY,
        true,
      ),
      enableMessageContextHistoryBackfill: parseBooleanEnv(
        env,
        AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_BACKFILL,
        true,
      ),
      enableNaturalLanguagePrefixNotice: true,
      messageContextHistoryLimit: parsePositiveIntegerEnv(
        env,
        AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_LIMIT,
        DEFAULT_SERVICE_CONTEXT_HISTORY_LIMIT,
      ),
      messageContextHistoryMaxEntries: parsePositiveIntegerEnv(
        env,
        AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_MAX_ENTRIES,
        DEFAULT_SERVICE_CONTEXT_HISTORY_MAX_ENTRIES,
      ),
      messageContextHistoryBackfillLimit: parsePositiveIntegerEnv(
        env,
        AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_BACKFILL_LIMIT,
        DEFAULT_SERVICE_CONTEXT_HISTORY_BACKFILL_LIMIT,
      ),
    },
    accessPolicyOptions: {
      allowedGuildIds: [requireEnv(env, AUTO_ARCHIVE_DISCORD_GUILD_ID)],
      allowedUserIds: parseDiscordIdList(
        env[AUTO_ARCHIVE_DISCORD_ALLOWED_USER_IDS],
      ),
      allowedChannelIds: parseDiscordIdList(
        env[AUTO_ARCHIVE_DISCORD_ALLOWED_CHANNEL_IDS],
      ),
      adminUserIds,
      allowDms: parseBooleanEnv(env, AUTO_ARCHIVE_DISCORD_ENABLE_DMS, false),
      allowBots: parseBooleanEnv(env, AUTO_ARCHIVE_DISCORD_ALLOW_BOTS, false),
    },
  };
}

function createDiscordServiceAuthDatabase(
  config: DiscordServiceBootstrapConfig,
): DiscordAuthDatabase {
  if (config.authDatabaseOptions.mode === 'memory') {
    return new SeededDiscordAuthDatabase(config.accessPolicyOptions);
  }

  return new SqliteDiscordAuthDatabase({
    dbPath: config.authDatabaseOptions.path,
    driver: config.authDatabaseOptions.driver,
    pythonBinaryPath: config.authDatabaseOptions.pythonBinaryPath,
    sqliteBinaryPath: config.authDatabaseOptions.sqliteBinaryPath,
    seed: config.accessPolicyOptions,
  });
}

export function resolveDiscordServiceBootstrapConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: DiscordServiceBootstrapEnvLoadOptions = {},
): DiscordServiceBootstrapConfig {
  return resolveDiscordServiceBootstrapConfigFromEnv(
    resolveDiscordServiceBootstrapEnv(env, options),
  );
}

export function resolveDiscordServiceCodexRuntimeDriverOptions(
  env: NodeJS.ProcessEnv = process.env,
  options: DiscordServiceBootstrapEnvLoadOptions = {},
): Pick<CodexRuntimeDriverOptions, 'codexOptions' | 'codexRuntimeConfig'> {
  const resolution = resolveCodexBootstrapResolution(
    resolveDiscordServiceBootstrapEnv(env, options),
  );
  return {
    codexOptions: resolution.options,
    codexRuntimeConfig: resolution.runtimeConfig,
  };
}

function createDiscordServiceAgentRuntimeFromEnv(
  env: NodeJS.ProcessEnv,
  claudeAgentQueryFactoryOverride?: ClaudeAgentQueryFactory,
  traitUsageTelemetry?: TraitUsageTelemetryPort,
): AgentRuntime {
  const provider = resolveRuntimeProvider(env);
  const agentRuntimeOptions = createRepositoryTraitRuntimeAgentOptionsFromEnv(
    env,
    traitUsageTelemetry === undefined ? {} : { traitUsageTelemetry },
  );
  if (provider === 'claude-agent') {
    const claudeResolution = resolveClaudeAgentBootstrapResolution(env);
    const queryFactory =
      claudeAgentQueryFactoryOverride ?? createDefaultClaudeAgentQueryFactory();
    return new AgentRuntime(
      createRuntimeDriverFromEnv(env, {
        claudeAgent: {
          queryFactory,
          resolution: claudeResolution,
        },
      }),
      agentRuntimeOptions,
    );
  }
  const resolution = resolveCodexBootstrapResolution(env);
  return new AgentRuntime(
    createRuntimeDriverFromEnv(env, {
      codex: {
        codexOptions: resolution.options,
        codexRuntimeConfig: resolution.runtimeConfig,
      },
    }),
    agentRuntimeOptions,
  );
}

export const AUTO_ARCHIVE_APPTAINER_IMAGE = 'AUTO_ARCHIVE_APPTAINER_IMAGE';
export const AUTO_ARCHIVE_AGENT_INSTANCE_ENTRY =
  'AUTO_ARCHIVE_AGENT_INSTANCE_ENTRY';
export const AUTO_ARCHIVE_AGENT_INSTANCE_NODE_BIN =
  'AUTO_ARCHIVE_AGENT_INSTANCE_NODE_BIN';
export const AUTO_ARCHIVE_APPTAINER_CLI_PATH =
  'AUTO_ARCHIVE_APPTAINER_CLI_PATH';
export const AUTO_ARCHIVE_SLURM_SALLOC_PATH =
  'AUTO_ARCHIVE_SLURM_SALLOC_PATH';
export const AUTO_ARCHIVE_SLURM_SCANCEL_PATH =
  'AUTO_ARCHIVE_SLURM_SCANCEL_PATH';

function createSlurmApptainerComputeNodeFromEnv(
  env: NodeJS.ProcessEnv,
): SlurmApptainerComputeNode {
  const containerImage = env[AUTO_ARCHIVE_APPTAINER_IMAGE]?.trim();
  if (containerImage === undefined || containerImage.length === 0) {
    throw new DiscordServiceBootstrapError(
      `Missing required environment variable ${AUTO_ARCHIVE_APPTAINER_IMAGE} for slurm-apptainer service mode.`,
    );
  }

  const entryScriptPath = env[AUTO_ARCHIVE_AGENT_INSTANCE_ENTRY]?.trim();
  if (entryScriptPath === undefined || entryScriptPath.length === 0) {
    throw new DiscordServiceBootstrapError(
      `Missing required environment variable ${AUTO_ARCHIVE_AGENT_INSTANCE_ENTRY} for slurm-apptainer service mode.`,
    );
  }

  const entryNodeBinary = env[AUTO_ARCHIVE_AGENT_INSTANCE_NODE_BIN]?.trim();
  const apptainerPath = env[AUTO_ARCHIVE_APPTAINER_CLI_PATH];
  const sallocPath = env[AUTO_ARCHIVE_SLURM_SALLOC_PATH];
  const scancelPath = env[AUTO_ARCHIVE_SLURM_SCANCEL_PATH];

  const commandPaths: Partial<Record<'salloc' | 'apptainer' | 'scancel', string>> = {};
  if (apptainerPath !== undefined && apptainerPath.trim().length > 0) {
    commandPaths.apptainer = apptainerPath;
  }
  if (sallocPath !== undefined && sallocPath.trim().length > 0) {
    commandPaths.salloc = sallocPath;
  }
  if (scancelPath !== undefined && scancelPath.trim().length > 0) {
    commandPaths.scancel = scancelPath;
  }

  return new SlurmApptainerComputeNode({
    subprocessRunner: new ProcessSubprocessRunner({
      ...(Object.keys(commandPaths).length === 0 ? {} : { commandPaths }),
    }),
    containerImage,
    entryScriptPath,
    ...(entryNodeBinary === undefined || entryNodeBinary.length === 0
      ? {}
      : { entryNodeBinary }),
  });
}

function createDiscordServiceComputeNodeFromEnv(
  env: NodeJS.ProcessEnv,
  traitUsageTelemetry?: TraitUsageTelemetryPort,
): ComputeNode {
  const configuredMode = env[AUTO_ARCHIVE_COMPUTE_NODE]?.trim();

  if (configuredMode === 'git-clone') {
    const runtime = createDiscordServiceAgentRuntimeFromEnv(
      env,
      undefined,
      traitUsageTelemetry,
    );
    return new GitLabCloneComputeNode({
      runtime,
    });
  }

  if (configuredMode === 'current-node') {
    const runtime = createDiscordServiceAgentRuntimeFromEnv(
      env,
      undefined,
      traitUsageTelemetry,
    );
    return new CurrentNodeComputeNode({
      runtime,
    });
  }

  if (
    configuredMode === undefined ||
    configuredMode === '' ||
    configuredMode === 'slurm-apptainer'
  ) {
    return createSlurmApptainerComputeNodeFromEnv(env);
  }

  throw new DiscordServiceBootstrapError(
    `Unsupported ${AUTO_ARCHIVE_COMPUTE_NODE} value: ${configuredMode}`,
  );
}

export function createDiscordServiceComputeNode(
  env: NodeJS.ProcessEnv = process.env,
  options: DiscordServiceBootstrapEnvLoadOptions = {},
): ComputeNode {
  return createDiscordServiceComputeNodeFromEnv(
    resolveDiscordServiceBootstrapEnv(env, options),
  );
}

export function createDiscordServiceTraitUsageTelemetryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TraitUsageTelemetryPort | undefined {
  const configuredMode = env[AUTO_ARCHIVE_COMPUTE_NODE]?.trim();
  if (configuredMode === 'git-clone' || configuredMode === 'current-node') {
    return new InMemoryTraitUsageTelemetry();
  }
  return undefined;
}

export interface DiscordServiceTraitUsageTelemetryBinding {
  readonly runtimeTraitUsageTelemetry?: TraitUsageTelemetryPort;
  readonly botTraitUsageTelemetry?: TraitUsageTelemetryPort;
}

export function createDiscordServiceTraitUsageTelemetryBindingFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DiscordServiceTraitUsageTelemetryBinding {
  const traitUsageTelemetry =
    createDiscordServiceTraitUsageTelemetryFromEnv(env);
  if (traitUsageTelemetry === undefined) {
    return {};
  }
  return {
    runtimeTraitUsageTelemetry: traitUsageTelemetry,
    botTraitUsageTelemetry: traitUsageTelemetry,
  };
}

function createAronaGitLabOptionsFromEnv(env: NodeJS.ProcessEnv): AronaOptions {
  const config = resolveGitLabIntegrationConfig(env);
  if (config === undefined) {
    return {};
  }
  const gitLabInstanceManager = createGitLabInstanceManagerFromEnv(env);
  if (gitLabInstanceManager === undefined) {
    return {};
  }
  const gitLabProjectManager =
    config.projectId === undefined
      ? undefined
      : new GitLabHttpProjectManager({
          baseUrl: config.baseUrl,
          projectId: config.projectId,
          token: config.token,
        });

  const gitLabProjectAssignmentManager =
    createGitLabProjectAssignmentManagerFromEnv(gitLabInstanceManager, env);
  const gitLabArtifactPublisher =
    createGitLabArtifactPublisherFromEnv(gitLabInstanceManager, env);
  const gitLabWorkResultRecorder =
    config.projectId === undefined && gitLabProjectAssignmentManager === undefined
      ? undefined
      : createGitLabWorkResultRecorderFromEnv(
          gitLabProjectManager ?? gitLabInstanceManager,
          env,
          gitLabArtifactPublisher,
        );

  return {
    ...(gitLabProjectManager === undefined ? {} : { gitLabProjectManager }),
    gitLabInstanceManager,
    ...(gitLabProjectAssignmentManager === undefined
      ? {}
      : { gitLabProjectAssignmentManager }),
    ...(gitLabWorkResultRecorder === undefined
      ? {}
      : { gitLabWorkResultRecorder }),
  };
}

export function createDiscordServiceAronaOptions(
  env: NodeJS.ProcessEnv = process.env,
  options: DiscordServiceBootstrapEnvLoadOptions = {},
): AronaOptions {
  return createAronaGitLabOptionsFromEnv(
    resolveDiscordServiceBootstrapEnv(env, options),
  );
}

const serviceLifecycleLogger: DiscordBotLifecycleLogger = (event, details) => {
  console.log(
    'discord-service-bot-lifecycle',
    JSON.stringify({
      event,
      pid: process.pid,
      ...details,
    }),
  );
};

export const AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER =
  'AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER';
export const AUTO_ARCHIVE_PLANA_ADVISOR_MODEL =
  'AUTO_ARCHIVE_PLANA_ADVISOR_MODEL';
export const AUTO_ARCHIVE_PLANA_ADVISOR_FALLBACK_MODEL =
  'AUTO_ARCHIVE_PLANA_ADVISOR_FALLBACK_MODEL';
export const AUTO_ARCHIVE_PLANA_ADVISOR_MAX_CALLS =
  'AUTO_ARCHIVE_PLANA_ADVISOR_MAX_CALLS';
export const AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_LEDGER_PATH =
  'AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_LEDGER_PATH';
export const AUTO_ARCHIVE_TASK_STALL_LEDGER_TICK_INTERVAL_MS =
  'AUTO_ARCHIVE_TASK_STALL_LEDGER_TICK_INTERVAL_MS';

export function createDiscordServicePlanaRuntimeAdvisorFromEnv(
  env: NodeJS.ProcessEnv,
  queryFactory: ClaudeAgentQueryFactory = createDefaultClaudeAgentQueryFactory(),
): PlanaRuntimeAdvisor | undefined {
  const advisorProvider = env[AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER]?.trim();
  if (!advisorProvider || advisorProvider === '') {
    return undefined;
  }
  if (advisorProvider !== 'claude-agent') {
    throw new DiscordServiceBootstrapError(
      `Unsupported ${AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER} value: ${advisorProvider} (currently only "claude-agent").`,
    );
  }
  const apiKey = env['AUTO_ARCHIVE_ANTHROPIC_API_KEY']?.trim();
  const cliPath = env['AUTO_ARCHIVE_CLAUDE_CLI_PATH']?.trim();
  const model = env[AUTO_ARCHIVE_PLANA_ADVISOR_MODEL]?.trim();
  const fallbackModel = env[AUTO_ARCHIVE_PLANA_ADVISOR_FALLBACK_MODEL]?.trim();
  const maxCallsRaw = env[AUTO_ARCHIVE_PLANA_ADVISOR_MAX_CALLS]?.trim();
  const eventsLedgerPath =
    env[AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_LEDGER_PATH]?.trim();
  const maxCalls =
    maxCallsRaw === undefined || maxCallsRaw === ''
      ? undefined
      : Number(maxCallsRaw);
  if (
    maxCalls !== undefined &&
    (!Number.isFinite(maxCalls) || !Number.isInteger(maxCalls) || maxCalls < 0)
  ) {
    throw new DiscordServiceBootstrapError(
      `${AUTO_ARCHIVE_PLANA_ADVISOR_MAX_CALLS} must be a non-negative integer.`,
    );
  }
  return new PlanaClaudeRuntimeAdvisor({
    queryFactory,
    ...(model && model.length > 0 ? { model } : {}),
    ...(fallbackModel && fallbackModel.length > 0 ? { fallbackModel } : {}),
    ...(apiKey && apiKey.length > 0 ? { anthropicApiKey: apiKey } : {}),
    ...(cliPath && cliPath.length > 0
      ? { pathToClaudeCodeExecutable: cliPath }
      : {}),
    ...(maxCalls === undefined ? {} : { maxAdvisorCallsPerInstance: maxCalls }),
    ...(eventsLedgerPath && eventsLedgerPath.length > 0
      ? {
          auditLedger: new JsonlPlanaClaudeAdvisorAuditLedger(eventsLedgerPath),
        }
      : {}),
  });
}

function readOptionalEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function parseOptionalNonNegativeIntegerForDoctor(
  env: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const raw = readOptionalEnv(env, name);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new DiscordServiceBootstrapError(
      `${name} must be a non-negative integer.`,
    );
  }
  return parsed;
}

function resolveAnthropicAuthSourceForDoctor(
  env: NodeJS.ProcessEnv,
): NonNullable<DiscordDoctorStatus['anthropicAuthSource']> {
  return readOptionalEnv(env, 'AUTO_ARCHIVE_ANTHROPIC_API_KEY') !== undefined
    ? 'api-key'
    : readOptionalEnv(env, 'AUTO_ARCHIVE_CLAUDE_CLI_PATH') !== undefined
      ? 'claude-cli'
      : 'none';
}

function resolvePlanaAdvisorProviderForDoctor(
  env: NodeJS.ProcessEnv,
): NonNullable<DiscordDoctorStatus['planaAdvisorProvider']> {
  const provider = readOptionalEnv(env, AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER);
  return provider === 'claude-agent'
    ? 'claude-agent'
    : provider === 'codex'
      ? 'codex'
      : 'none';
}

export interface DiscordServiceTaskHealthObserverBinding {
  readonly midCycleObservers: readonly RuntimeMidCycleObserver[];
  readonly taskHealthObserverEnabled: boolean;
  readonly stallSignalSource?: TaskHealthStallSignalSource;
  readInFlightProblems(): NonNullable<DiscordDoctorStatus['inFlightProblems']>;
}

export interface DiscordServiceTaskHealthObserverBindingOptions {
  readonly nowMs?: () => number;
}

export function createDiscordServiceTaskHealthObserverBindingFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: DiscordServiceTaskHealthObserverBindingOptions = {},
): DiscordServiceTaskHealthObserverBinding {
  const observer = createTaskStallObserverFromEnv(env);
  if (observer === undefined) {
    return {
      midCycleObservers: [],
      taskHealthObserverEnabled: false,
      readInFlightProblems: () => [],
    };
  }
  const nowMs = options.nowMs ?? Date.now;
  return {
    midCycleObservers: [observer],
    taskHealthObserverEnabled: true,
    stallSignalSource: observer,
    readInFlightProblems: () =>
      observer.currentStalls(nowMs()).map((signal) => ({
        taskId: signal.taskId,
        kind: 'stall' as const,
        observedAt: signal.observedAt,
        lastProgressAt: signal.lastProgressAt,
        thresholdMs: signal.thresholdMs,
      })),
  };
}

function taskStallLedgerTickIntervalMsFromEnv(
  env: NodeJS.ProcessEnv,
): number | undefined {
  const raw = readOptionalEnv(
    env,
    AUTO_ARCHIVE_TASK_STALL_LEDGER_TICK_INTERVAL_MS,
  );
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0
    ? parsed
    : undefined;
}

export interface DiscordServiceTaskHealthLedgerRecorder {
  readonly enabled: boolean;
  stop(): void;
}

export interface DiscordServiceTaskHealthLedgerRecorderOptions {
  readonly nowMs?: () => number;
  readonly setInterval?: (
    callback: () => void,
    intervalMs: number,
  ) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  readonly logger?: (event: string, details: Record<string, unknown>) => void;
}

export function createDiscordServiceTaskHealthLedgerRecorderFromEnv(
  env: NodeJS.ProcessEnv,
  taskHealthObservers: DiscordServiceTaskHealthObserverBinding,
  ledger: ControlPlaneLedgerPort,
  options: DiscordServiceTaskHealthLedgerRecorderOptions = {},
): DiscordServiceTaskHealthLedgerRecorder {
  const intervalMs = taskStallLedgerTickIntervalMsFromEnv(env);
  const source = taskHealthObservers.stallSignalSource;
  if (intervalMs === undefined || source === undefined) {
    return {
      enabled: false,
      stop() {},
    };
  }

  const nowMs = options.nowMs ?? Date.now;
  const logger =
    options.logger ??
    ((event: string, details: Record<string, unknown>) => {
      console.warn(`[discord-service] ${event}`, JSON.stringify(details));
    });
  const schedule =
    options.setInterval ??
    ((callback: () => void, scheduledIntervalMs: number): unknown =>
      setInterval(callback, scheduledIntervalMs));
  const unschedule =
    options.clearInterval ??
    ((handle: unknown): void => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    });
  const runTick = (): void => {
    try {
      recordTaskHealthStallsToControlPlaneLedger(
        source,
        ledger,
        nowMs(),
        {
          logger: (event, details) => logger(event, details),
        },
      );
    } catch (error) {
      logger('task-health-ledger-recorder-threw', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const handle = schedule(runTick, intervalMs);
  if (
    typeof handle === 'object' &&
    handle !== null &&
    typeof (handle as { unref?: unknown }).unref === 'function'
  ) {
    (handle as { unref(): void }).unref();
  }
  let stopped = false;
  return {
    enabled: true,
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      unschedule(handle);
    },
  };
}

function createDiscordDoctorStatusFromEnv(
  env: NodeJS.ProcessEnv,
  config: DiscordServiceBootstrapConfig,
  taskHealthObservers?: DiscordServiceTaskHealthObserverBinding,
): DiscordDoctorStatus {
  const activeRuntimeProvider = resolveRuntimeProvider(env);
  return {
    runtimeProviderScope: 'multi-provider',
    activeRuntimeProvider,
    computeMode: env[AUTO_ARCHIVE_COMPUTE_NODE] ?? 'slurm-apptainer',
    modelOverride: readOptionalEnv(env, 'AUTO_ARCHIVE_CODEX_MODEL'),
    messageContentIntent: config.enableMessageContentIntent,
    anthropicAuthSource: resolveAnthropicAuthSourceForDoctor(env),
    anthropicCliPath: readOptionalEnv(env, 'AUTO_ARCHIVE_CLAUDE_CLI_PATH'),
    claudeModelOverride: readOptionalEnv(env, 'AUTO_ARCHIVE_CLAUDE_MODEL'),
    planaAdvisorProvider: resolvePlanaAdvisorProviderForDoctor(env),
    planaAdvisorModel: readOptionalEnv(env, AUTO_ARCHIVE_PLANA_ADVISOR_MODEL),
    planaAdvisorMaxCalls: parseOptionalNonNegativeIntegerForDoctor(
      env,
      AUTO_ARCHIVE_PLANA_ADVISOR_MAX_CALLS,
    ),
    ...(() => {
      const agentHarnessRegistry =
        resolveAgentHarnessRegistryDoctorStatusFromEnv(env);
      return agentHarnessRegistry === undefined
        ? {}
        : { agentHarnessRegistry };
    })(),
    ...(() => {
      const controlPlaneOtelLogs =
        resolveControlPlaneOtelLogsDoctorStatusFromEnv(env);
      return controlPlaneOtelLogs === undefined
        ? {}
        : { controlPlaneOtelLogs };
    })(),
    ...(() => {
      const autonomousResearchEvidence =
        resolveAutonomousResearchEvidenceDoctorStatusFromEnv(env);
      return autonomousResearchEvidence === undefined
        ? {}
        : { autonomousResearchEvidence };
    })(),
    ...(() => {
      const runtimeProviderEvidence =
        resolveRuntimeProviderEvidenceDoctorStatusFromEnv(env);
      return runtimeProviderEvidence === undefined
        ? {}
        : { runtimeProviderEvidence };
    })(),
    ...(() => {
      const liveProofReport = resolveLiveProofReportDoctorStatusFromEnv(env);
      return liveProofReport === undefined ? {} : { liveProofReport };
    })(),
    ...(() => {
      const peekabooEvidenceReport =
        resolvePeekabooEvidenceReportDoctorStatusFromEnv(env);
      return peekabooEvidenceReport === undefined
        ? {}
        : { peekabooEvidenceReport };
    })(),
    ...(() => {
      const personaTelemetryReport =
        resolvePersonaTelemetryReportDoctorStatusFromEnv(env);
      return personaTelemetryReport === undefined
        ? {}
        : { personaTelemetryReport };
    })(),
    ...(() => {
      const taskHealthEvidenceReport =
        resolveTaskHealthEvidenceReportDoctorStatusFromEnv(env);
      return taskHealthEvidenceReport === undefined
        ? {}
        : { taskHealthEvidenceReport };
    })(),
    ...(() => {
      const taskArchiveEvidenceReport =
        resolveTaskArchiveEvidenceReportDoctorStatusFromEnv(env);
      return taskArchiveEvidenceReport === undefined
        ? {}
        : { taskArchiveEvidenceReport };
    })(),
    ...(() => {
      const subagentOperatorEvidenceReport =
        resolveSubagentOperatorEvidenceReportDoctorStatusFromEnv(env);
      return subagentOperatorEvidenceReport === undefined
        ? {}
        : { subagentOperatorEvidenceReport };
    })(),
    ...(() => {
      const sessionBindingEvidenceReport =
        resolveSessionBindingEvidenceReportDoctorStatusFromEnv(env);
      return sessionBindingEvidenceReport === undefined
        ? {}
        : { sessionBindingEvidenceReport };
    })(),
    ...(() => {
      const planaAdvisorEvents =
        resolvePlanaAdvisorEventsDoctorStatusFromEnv(env);
      return planaAdvisorEvents === undefined
        ? {}
        : { planaAdvisorEvents };
    })(),
    taskHealthObserverEnabled:
      taskHealthObservers?.taskHealthObserverEnabled,
    get inFlightProblems() {
      return taskHealthObservers?.readInFlightProblems();
    },
    ...(() => {
      const traitSchedulerTickEvidence =
        resolveTraitSchedulerTickEvidenceDoctorStatusFromEnv(env);
      return traitSchedulerTickEvidence === undefined
        ? {}
        : { traitSchedulerTickEvidence };
    })(),
    ...resolveShellHookDoctorStatusFromEnv(env),
  };
}

export function discoverDiscordServiceTraitModuleRegistry(
  env: NodeJS.ProcessEnv = process.env,
): {
  readonly traitModuleRegistry?: TraitModuleRegistry;
  readonly traitModuleRegistryError?: string;
} {
  const workspaceRoot =
    readOptionalEnv(env, AUTO_ARCHIVE_TRAIT_MODULE_WORKSPACE_ROOT) ??
    process.cwd();
  try {
    return {
      traitModuleRegistry: discoverTraitModuleManifests({
        workspaceRoot,
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      '[discord-service] trait module discovery failed',
      JSON.stringify({ message }),
    );
    return { traitModuleRegistryError: message };
  }
}

export function createDiscordServiceControlPlaneObserversFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): readonly ControlPlaneObserverPort[] {
  const otelEmitter = createControlPlaneOtelLogsEmitterFromEnv(env, {
    logger: (event, details) => {
      console.warn(`[discord-service] ${event}`, JSON.stringify(details));
    },
  });
  return otelEmitter === undefined ? [] : [otelEmitter];
}

function wrapBotStopWithObserverShutdown(
  bot: StartedDiscordFirstSliceBot,
  observers: readonly ControlPlaneObserverPort[],
): StartedDiscordFirstSliceBot {
  const shutdownObservers = observers.filter(
    (
      observer,
    ): observer is ControlPlaneObserverPort & {
      shutdown(timeoutMs?: number): Promise<void>;
    } => typeof (observer as { shutdown?: unknown }).shutdown === 'function',
  );
  if (shutdownObservers.length === 0) {
    return bot;
  }

  const stop = bot.stop.bind(bot);
  return {
    ...bot,
    async stop(): Promise<void> {
      try {
        await stop();
      } finally {
        await Promise.allSettled(
          shutdownObservers.map((observer) => observer.shutdown()),
        );
      }
    },
  };
}

export function wrapBotStopWithTaskHealthRecorder(
  bot: StartedDiscordFirstSliceBot,
  recorder: DiscordServiceTaskHealthLedgerRecorder,
): StartedDiscordFirstSliceBot {
  if (!recorder.enabled) {
    return bot;
  }
  const stop = bot.stop.bind(bot);
  return {
    ...bot,
    async stop(): Promise<void> {
      try {
        await stop();
      } finally {
        recorder.stop();
      }
    },
  };
}

export async function startDiscordServiceBootstrap(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StartedDiscordFirstSliceBot> {
  const serviceEnv = resolveDiscordServiceBootstrapEnv(env);
  const config = resolveDiscordServiceBootstrapConfigFromEnv(serviceEnv);
  const traitUsageTelemetryBinding =
    createDiscordServiceTraitUsageTelemetryBindingFromEnv(serviceEnv);
  const dispatcher = new Dispatcher(
    createDiscordServiceComputeNodeFromEnv(
      serviceEnv,
      traitUsageTelemetryBinding.runtimeTraitUsageTelemetry,
    ),
  );
  const controlPlaneObservers =
    createDiscordServiceControlPlaneObserversFromEnv(serviceEnv);
  const controlLedger = new JsonlControlPlaneLedger(
    config.controlLedgerPath,
    [],
    controlPlaneObservers,
  );
  const approvalRegistry = new InMemoryRuntimeApprovalRegistry();
  const planaAdvisor = createDiscordServicePlanaRuntimeAdvisorFromEnv(serviceEnv);
  const taskHealthObservers =
    createDiscordServiceTaskHealthObserverBindingFromEnv(serviceEnv);
  const plana = new Plana({
    approval: createRegistryBackedApprovalHook(approvalRegistry, {
      ledger: controlLedger,
    }),
    ...(planaAdvisor === undefined ? {} : { runtimeAdvisor: planaAdvisor }),
    ...(taskHealthObservers.midCycleObservers.length === 0
      ? {}
      : { midCycleObservers: taskHealthObservers.midCycleObservers }),
  });
  const arona = new Arona(
    plana,
    dispatcher,
    createAronaGitLabOptionsFromEnv(serviceEnv),
  );
  const authDatabase = createDiscordServiceAuthDatabase(config);
  const accessPolicy = new DiscordAccessPolicy({
    authDatabase,
    allowDms: config.accessPolicyOptions.allowDms,
    allowBots: config.accessPolicyOptions.allowBots,
  });
  const taskRegistry = new DiscordTaskRegistry({ ledger: controlLedger });
  const sessionBindings = new DiscordSessionBindingManager({
    ledger: controlLedger,
    retainTerminalAfterMs: 24 * 60 * 60 * 1000,
  });
  const personaTransformer = createPersonaTransformerFromEnv({
    env: serviceEnv,
    logger: (event, details) => {
      console.warn(`[discord-service] ${event}`, JSON.stringify(details));
    },
  });
  const traitModuleDiscovery = discoverDiscordServiceTraitModuleRegistry(serviceEnv);

  const bot = await startDiscordFirstSliceBot({
    token: config.token,
    applicationId: config.applicationId,
    guildId: config.guildId,
    arona,
    dispatcher,
    taskRegistry,
    controlLedger,
    accessPolicy,
    authDatabase,
    approvalRegistry,
    sessionBindings,
    ...traitModuleDiscovery,
    ...(traitUsageTelemetryBinding.botTraitUsageTelemetry === undefined
      ? {}
      : {
          traitUsageTelemetry:
            traitUsageTelemetryBinding.botTraitUsageTelemetry,
        }),
    requestFactoryOptions: config.requestFactoryOptions,
    enableMessageContentIntent: config.enableMessageContentIntent,
    ...(personaTransformer === undefined ? {} : { personaTransformer }),
    doctorStatus: createDiscordDoctorStatusFromEnv(
      serviceEnv,
      config,
      taskHealthObservers,
    ),
    waitForReadyOnStart: true,
    readyTimeoutMs: DEFAULT_SERVICE_READY_TIMEOUT_MS,
    lifecycleLogger: serviceLifecycleLogger,
    ...config.naturalLanguageOptions,
  });
  const taskHealthLedgerRecorder =
    createDiscordServiceTaskHealthLedgerRecorderFromEnv(
      serviceEnv,
      taskHealthObservers,
      controlLedger,
    );
  return wrapBotStopWithTaskHealthRecorder(
    wrapBotStopWithObserverShutdown(bot, controlPlaneObservers),
    taskHealthLedgerRecorder,
  );
}

let unhandledRejectionHandlerRegistered = false;

/**
 * F12 (R4): register a single process-level `unhandledRejection` listener so
 * any stray promise rejection — including ones the Arona-side `.catch` did
 * not capture — is logged rather than terminating the Node process (Node
 * ≥15 default action). Idempotent: subsequent calls are no-ops.
 */
function ensureUnhandledRejectionHandler(): void {
  if (unhandledRejectionHandlerRegistered) {
    return;
  }
  unhandledRejectionHandlerRegistered = true;
  process.on('unhandledRejection', (reason: unknown) => {
    const formatted =
      reason instanceof Error
        ? reason.stack ?? reason.message
        : String(reason);
    console.error(`[discord-service] unhandledRejection: ${formatted}`);
  });
}

function installShutdownHandlers(bot: StartedDiscordFirstSliceBot): void {
  let stopping: Promise<void> | undefined;

  const stop = async (): Promise<void> => {
    if (stopping === undefined) {
      stopping = bot.stop();
    }
    await stopping;
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void stop().finally(() => {
        process.exitCode = 0;
      });
    });
  }
}

export async function runDiscordServiceLauncher(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StartedDiscordFirstSliceBot> {
  ensureUnhandledRejectionHandler();
  const bot = await startDiscordServiceBootstrap(env);
  installShutdownHandlers(bot);
  return bot;
}

export function isDiscordServiceLauncherEntrypoint(
  moduleUrl: string = import.meta.url,
  argv: readonly string[] = process.argv,
): boolean {
  return (
    argv[1] !== undefined &&
    moduleUrl === pathToFileURL(resolve(argv[1])).href
  );
}

if (isDiscordServiceLauncherEntrypoint()) {
  void runDiscordServiceLauncher().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
