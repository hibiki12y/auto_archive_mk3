import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse } from 'dotenv';

import { AUTO_ARCHIVE_COMPUTE_NODE } from '../core/compute-node-factory.js';
import { CurrentNodeComputeNode } from '../core/current-node-compute-node.js';
import { Dispatcher } from '../core/dispatcher.js';
import type { ComputeNode } from '../core/compute-node.js';
import { GitLabCloneComputeNode } from '../core/gitlab-clone-compute-node.js';
import {
  InMemoryTraitUsageTelemetry,
  type TraitUsageTelemetryPort,
} from '../core/trait-usage-telemetry.js';
import { AgentRuntime } from '../runtime/agent-runtime.js';
import {
  CodexRuntimeDriver,
  type CodexRuntimeDriverOptions,
} from '../runtime/codex-runtime-adapter.js';
import { resolveCodexBootstrapResolution } from '../runtime/codex-bootstrap-settings.js';
import {
  createRepositoryTraitRuntimeAgentOptionsFromEnv,
} from '../runtime/repository-trait-runtime-decorator-resolver.js';
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
  InMemoryRuntimeApprovalRegistry,
  createRegistryBackedApprovalHook,
} from '../core/runtime-approval-registry.js';
import {
  startDiscordFirstSliceBot,
  type StartedDiscordFirstSliceBot,
} from './discord-bot.js';
import type { DefaultDiscordTaskRequestFactoryOptions } from './discord-command-handlers.js';
import { DiscordSessionBindingManager } from './discord-session-binding.js';

export const AUTO_ARCHIVE_DISCORD_TOKEN = 'AUTO_ARCHIVE_DISCORD_TOKEN';
export const AUTO_ARCHIVE_DISCORD_APPLICATION_ID =
  'AUTO_ARCHIVE_DISCORD_APPLICATION_ID';
export const AUTO_ARCHIVE_DISCORD_GUILD_ID = 'AUTO_ARCHIVE_DISCORD_GUILD_ID';
export const AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT =
  'AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT';

const DISCORD_SMOKE_REQUEST_FACTORY_OPTIONS: DefaultDiscordTaskRequestFactoryOptions =
  Object.freeze({
    resources: {
      requested: {
        cpuCores: 2,
        memoryMiB: 4096,
        wallTimeSec: 900,
        gpuCards: 0,
      },
    },
    runtimeSettings: {
      networkProfile: 'provider-only' as const,
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'on-request' as const,
      workingDirectory: 'results/task-artifacts',
    },
    artifactLocation: 'results/task-artifacts',
  });

export class DiscordSmokeBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscordSmokeBootstrapError';
    Object.setPrototypeOf(this, DiscordSmokeBootstrapError.prototype);
  }
}

export interface DiscordSmokeBootstrapConfig {
  readonly token: string;
  readonly applicationId: string;
  readonly guildId: string;
  readonly enableMessageContentIntent: boolean;
  readonly requestFactoryOptions: DefaultDiscordTaskRequestFactoryOptions;
}

export interface DiscordSmokeBootstrapEnvLoadOptions {
  readonly rootDirectory?: string;
  readonly fileExists?: (path: string) => boolean;
  readonly readEnvFile?: (path: string) => string;
}

function requireEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new DiscordSmokeBootstrapError(
      `Missing required environment variable ${name}.`,
    );
  }
  return value;
}

function parseBooleanEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): boolean {
  const rawValue = env[name]?.trim().toLowerCase();
  if (rawValue === undefined || rawValue === '') {
    return false;
  }

  if (['1', 'true', 'yes', 'on'].includes(rawValue)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(rawValue)) {
    return false;
  }

  throw new DiscordSmokeBootstrapError(
    `${name} must be one of: 1, true, yes, on, 0, false, no, off; received "${env[name]}".`,
  );
}

function assertSmokeComputeNodeMode(env: NodeJS.ProcessEnv): void {
  const configuredMode = env[AUTO_ARCHIVE_COMPUTE_NODE];
  if (
    configuredMode !== undefined &&
    configuredMode !== '' &&
    configuredMode !== 'git-clone' &&
    configuredMode !== 'current-node'
  ) {
    throw new DiscordSmokeBootstrapError(
      `Discord smoke bootstrap requires ${AUTO_ARCHIVE_COMPUTE_NODE}=git-clone, current-node, or unset; received "${configuredMode}".`,
    );
  }
}

export function resolveDiscordSmokeBootstrapEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: DiscordSmokeBootstrapEnvLoadOptions = {},
): NodeJS.ProcessEnv {
  const envFilePath = resolve(options.rootDirectory ?? process.cwd(), '.env');
  const fileExists = options.fileExists ?? existsSync;

  if (!fileExists(envFilePath)) {
    return env;
  }

  const readEnvFile =
    options.readEnvFile ??
    ((path: string) => readFileSync(path, { encoding: 'utf8' }));

  return {
    ...parse(readEnvFile(envFilePath)),
    ...env,
  };
}

function resolveDiscordSmokeBootstrapConfigFromEnv(
  env: NodeJS.ProcessEnv,
): DiscordSmokeBootstrapConfig {
  assertSmokeComputeNodeMode(env);
  return {
    token: requireEnv(env, AUTO_ARCHIVE_DISCORD_TOKEN),
    applicationId: requireEnv(env, AUTO_ARCHIVE_DISCORD_APPLICATION_ID),
    guildId: requireEnv(env, AUTO_ARCHIVE_DISCORD_GUILD_ID),
    enableMessageContentIntent: parseBooleanEnv(
      env,
      AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT,
    ),
    requestFactoryOptions: DISCORD_SMOKE_REQUEST_FACTORY_OPTIONS,
  };
}

export function resolveDiscordSmokeBootstrapConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: DiscordSmokeBootstrapEnvLoadOptions = {},
): DiscordSmokeBootstrapConfig {
  return resolveDiscordSmokeBootstrapConfigFromEnv(
    resolveDiscordSmokeBootstrapEnv(env, options),
  );
}

export function resolveDiscordSmokeCodexRuntimeDriverOptions(
  env: NodeJS.ProcessEnv = process.env,
  options: DiscordSmokeBootstrapEnvLoadOptions = {},
): Pick<CodexRuntimeDriverOptions, 'codexOptions' | 'codexRuntimeConfig'> {
  const resolution = resolveCodexBootstrapResolution(
    resolveDiscordSmokeBootstrapEnv(env, options),
  );
  return {
    codexOptions: resolution.options,
    codexRuntimeConfig: resolution.runtimeConfig,
  };
}

function createDiscordSmokeAgentRuntimeFromEnv(
  env: NodeJS.ProcessEnv,
  traitUsageTelemetry?: TraitUsageTelemetryPort,
): AgentRuntime {
  const resolution = resolveCodexBootstrapResolution(env);
  return new AgentRuntime(
    new CodexRuntimeDriver({
      codexOptions: resolution.options,
      codexRuntimeConfig: resolution.runtimeConfig,
    }),
    createRepositoryTraitRuntimeAgentOptionsFromEnv(
      env,
      traitUsageTelemetry === undefined ? {} : { traitUsageTelemetry },
    ),
  );
}

function createDiscordSmokeComputeNodeFromEnv(
  env: NodeJS.ProcessEnv,
  traitUsageTelemetry?: TraitUsageTelemetryPort,
): ComputeNode {
  assertSmokeComputeNodeMode(env);
  const runtime = createDiscordSmokeAgentRuntimeFromEnv(env, traitUsageTelemetry);

  if (env[AUTO_ARCHIVE_COMPUTE_NODE] === 'current-node') {
    return new CurrentNodeComputeNode({
      runtime,
    });
  }

  return new GitLabCloneComputeNode({
    runtime,
  });
}

export function createDiscordSmokeComputeNode(
  env: NodeJS.ProcessEnv = process.env,
  options: DiscordSmokeBootstrapEnvLoadOptions = {},
): ComputeNode {
  return createDiscordSmokeComputeNodeFromEnv(
    resolveDiscordSmokeBootstrapEnv(env, options),
  );
}

export function createDiscordSmokeTraitUsageTelemetry(): TraitUsageTelemetryPort {
  return new InMemoryTraitUsageTelemetry();
}

export interface DiscordSmokeTraitUsageTelemetryBinding {
  readonly runtimeTraitUsageTelemetry: TraitUsageTelemetryPort;
  readonly botTraitUsageTelemetry: TraitUsageTelemetryPort;
}

export function createDiscordSmokeTraitUsageTelemetryBinding(): DiscordSmokeTraitUsageTelemetryBinding {
  const traitUsageTelemetry = createDiscordSmokeTraitUsageTelemetry();
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

export function createDiscordSmokeAronaOptions(
  env: NodeJS.ProcessEnv = process.env,
  options: DiscordSmokeBootstrapEnvLoadOptions = {},
): AronaOptions {
  return createAronaGitLabOptionsFromEnv(
    resolveDiscordSmokeBootstrapEnv(env, options),
  );
}

export async function startDiscordSmokeBootstrap(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StartedDiscordFirstSliceBot> {
  const smokeEnv = resolveDiscordSmokeBootstrapEnv(env);
  const config = resolveDiscordSmokeBootstrapConfigFromEnv(smokeEnv);
  const traitUsageTelemetryBinding =
    createDiscordSmokeTraitUsageTelemetryBinding();
  const dispatcher = new Dispatcher(
    createDiscordSmokeComputeNodeFromEnv(
      smokeEnv,
      traitUsageTelemetryBinding.runtimeTraitUsageTelemetry,
    ),
  );
  const approvalRegistry = new InMemoryRuntimeApprovalRegistry();
  const sessionBindings = new DiscordSessionBindingManager();
  const arona = new Arona(
    new Plana({
      approval: createRegistryBackedApprovalHook(approvalRegistry),
    }),
    dispatcher,
    createAronaGitLabOptionsFromEnv(smokeEnv),
  );

  return startDiscordFirstSliceBot({
    token: config.token,
    applicationId: config.applicationId,
    guildId: config.guildId,
    arona,
    dispatcher,
    approvalRegistry,
    sessionBindings,
    traitUsageTelemetry: traitUsageTelemetryBinding.botTraitUsageTelemetry,
    requestFactoryOptions: config.requestFactoryOptions,
    enableNaturalLanguageMessages: true,
    enableMessageContentIntent: config.enableMessageContentIntent,
    enableMessageContextHistory: true,
    enableMessageContextHistoryBackfill: true,
    enableNaturalLanguagePrefixNotice: true,
    messageContextHistoryLimit: 30,
    messageContextHistoryBackfillLimit: 30,
    naturalLanguageTriggerMode: 'mention',
    naturalLanguagePrefixes: ['arona', '아로나', 'plana', '플라나'],
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

export async function runDiscordSmokeLauncher(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StartedDiscordFirstSliceBot> {
  const bot = await startDiscordSmokeBootstrap(env);
  installShutdownHandlers(bot);
  return bot;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runDiscordSmokeLauncher().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
