import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AUTO_ARCHIVE_COMPUTE_NODE } from '../src/core/compute-node-factory.js';
import { CurrentNodeComputeNode } from '../src/core/current-node-compute-node.js';
import { GitLabCloneComputeNode } from '../src/core/gitlab-clone-compute-node.js';
import { SlurmApptainerComputeNode } from '../src/core/compute-node-slurm-apptainer.js';
import {
  AUTO_ARCHIVE_DISCORD_APPLICATION_ID,
  AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY,
  AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_BACKFILL,
  AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_BACKFILL_LIMIT,
  AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_LIMIT,
  AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_MAX_ENTRIES,
  AUTO_ARCHIVE_DISCORD_GUILD_ID,
  AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT,
  AUTO_ARCHIVE_DISCORD_NATURAL_LANGUAGE_PREFIXES,
  AUTO_ARCHIVE_DISCORD_NATURAL_LANGUAGE_TRIGGER_MODE,
  AUTO_ARCHIVE_DISCORD_TASK_ARTIFACT_LOCATION,
  AUTO_ARCHIVE_DISCORD_TASK_CPU_CORES,
  AUTO_ARCHIVE_DISCORD_TASK_GPU_CARDS,
  AUTO_ARCHIVE_DISCORD_TASK_MEMORY_MIB,
  AUTO_ARCHIVE_DISCORD_TASK_SANDBOX_MODE,
  AUTO_ARCHIVE_DISCORD_TASK_WALL_TIME_SEC,
  AUTO_ARCHIVE_DISCORD_TASK_WORKING_DIRECTORY,
  AUTO_ARCHIVE_DISCORD_TOKEN,
  AUTO_ARCHIVE_CONTROL_LEDGER_PATH,
  AUTO_ARCHIVE_DISCORD_ALLOWED_CHANNEL_IDS,
  AUTO_ARCHIVE_DISCORD_ALLOWED_USER_IDS,
  AUTO_ARCHIVE_DISCORD_ADMIN_USER_IDS,
  AUTO_ARCHIVE_DISCORD_ALLOW_BOTS,
  AUTO_ARCHIVE_OTEL_LOGS_URL,
  AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES,
  AUTO_ARCHIVE_DISCORD_AUTH_DB_DRIVER,
  AUTO_ARCHIVE_DISCORD_AUTH_DB_MODE,
  AUTO_ARCHIVE_DISCORD_AUTH_DB_PATH,
  AUTO_ARCHIVE_DISCORD_AUTH_DB_PYTHON_BIN,
  AUTO_ARCHIVE_DISCORD_AUTH_DB_SQLITE_BIN,
  AUTO_ARCHIVE_DISCORD_ENABLE_DMS,
  AUTO_ARCHIVE_TRAIT_MODULE_WORKSPACE_ROOT,
  AUTO_ARCHIVE_APPTAINER_IMAGE,
  AUTO_ARCHIVE_AGENT_INSTANCE_ENTRY,
  AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_LEDGER_PATH,
  AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER,
  AUTO_ARCHIVE_TASK_STALL_LEDGER_TICK_INTERVAL_MS,
  createDiscordServiceTaskHealthLedgerRecorderFromEnv,
  createDiscordServiceTaskHealthObserverBindingFromEnv,
  createDiscordServiceControlPlaneObserversFromEnv,
  createDiscordServiceComputeNode,
  createDiscordServicePlanaRuntimeAdvisorFromEnv,
  createDiscordServiceTraitUsageTelemetryBindingFromEnv,
  createDiscordServiceTraitUsageTelemetryFromEnv,
  createDiscordServiceAronaOptions,
  discoverDiscordServiceTraitModuleRegistry,
  DiscordServiceBootstrapError,
  isDiscordServiceLauncherEntrypoint,
  resolveDiscordServiceBootstrapConfig,
  resolveDiscordServiceBootstrapEnv,
  resolveDiscordServiceCodexRuntimeDriverOptions,
  wrapBotStopWithTaskHealthRecorder,
} from '../src/discord/discord-service-bootstrap.js';
import { InMemoryTraitUsageTelemetry } from '../src/core/trait-usage-telemetry.js';
import {
  AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS,
  InMemoryControlPlaneLedger,
  createRuntimeEvent,
} from '../src/index.js';
import {
  AUTO_ARCHIVE_GITLAB_ASSIGNMENT_ENABLED,
  AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_ID,
  AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_PATH,
  AUTO_ARCHIVE_GITLAB_AUTO_CREATE_PROJECTS,
  AUTO_ARCHIVE_GITLAB_ENABLED,
  AUTO_ARCHIVE_GITLAB_PROJECT_ID,
  AUTO_ARCHIVE_GITLAB_TOKEN,
  AUTO_ARCHIVE_GITLAB_URL,
  AUTO_ARCHIVE_GITLAB_WORK_RESULT_ISSUE_IID,
} from '../src/core/gitlab-project-manager.js';
import {
  CODEX_MODEL_ENV,
  CODEX_MODEL_FALLBACK_ENV,
  CODEX_REASONING_EFFORT_ENV,
} from '../src/runtime/codex-bootstrap-settings.js';
import { createDispatchPlan } from '../src/core/task.js';
import type { AgentInstance } from '../src/contracts/runtime-driver.js';
import type {
  ClaudeAgentQueryFactory,
} from '../src/runtime/claude-agent-runtime-adapter.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

function createEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    HOME: '/repo/missing-home',
    [AUTO_ARCHIVE_DISCORD_TOKEN]: 'discord-token',
    [AUTO_ARCHIVE_DISCORD_APPLICATION_ID]: 'discord-application-id',
    [AUTO_ARCHIVE_DISCORD_GUILD_ID]: 'discord-guild-id',
    ...overrides,
  };
}

const NO_REPO_ENV_OPTIONS = {
  rootDirectory: '/repo',
  fileExists: () => false,
};

function makeAdvisorFactoryReturning(text: string): ClaudeAgentQueryFactory {
  return () => ({
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'result',
        subtype: 'success',
        result: text,
      };
    },
  });
}

describe('discord service bootstrap', () => {
  it('recognizes the direct Docker/node entrypoint path only', () => {
    const scriptUrl =
      'file:///repo/dist/src/discord/discord-service-bootstrap.js';

    expect(
      isDiscordServiceLauncherEntrypoint(scriptUrl, [
        '/node',
        '/repo/dist/src/discord/discord-service-bootstrap.js',
      ]),
    ).toBe(true);
    expect(
      isDiscordServiceLauncherEntrypoint(
        scriptUrl,
        ['/node', '/pm2/lib/ProcessContainerFork.js'],
      ),
    ).toBe(false);
  });

  it('loads missing Discord variables from the repo-root .env fallback', () => {
    const config = resolveDiscordServiceBootstrapConfig(
      {},
      {
        rootDirectory: '/repo',
        fileExists: (path) => path === '/repo/.env',
        readEnvFile: () =>
          [
            'AUTO_ARCHIVE_DISCORD_TOKEN=dotenv-token',
            'AUTO_ARCHIVE_DISCORD_APPLICATION_ID=dotenv-application-id',
            'AUTO_ARCHIVE_DISCORD_GUILD_ID=dotenv-guild-id',
          ].join('\n'),
      },
    );

    expect(config).toMatchObject({
      token: 'dotenv-token',
      applicationId: 'dotenv-application-id',
      guildId: 'dotenv-guild-id',
    });
  });

  it('wires a redacted Plana advisor events ledger from service env', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'discord-advisor-ledger-'));
    try {
      const ledgerPath = join(workspace, 'plana-advisor-events.jsonl');
      const advisor = createDiscordServicePlanaRuntimeAdvisorFromEnv(
        createEnv({
          [AUTO_ARCHIVE_PLANA_ADVISOR_PROVIDER]: 'claude-agent',
          [AUTO_ARCHIVE_PLANA_ADVISOR_EVENTS_LEDGER_PATH]: ledgerPath,
        }),
        makeAdvisorFactoryReturning(
          '{"verdict":"veto","reason":"MODEL PAYLOAD SHOULD NOT LEAK"}',
        ),
      );
      expect(advisor).not.toBeUndefined();

      const plan = createDispatchPlan(
        createTaskRequest('task-discord-advisor-ledger', {
          instruction: 'PROMPT PAYLOAD SHOULD NOT LEAK',
        }),
      );
      const instance: AgentInstance = {
        taskId: plan.taskId,
        instanceId: 'agent-discord-advisor-ledger',
        createdAt: '2026-05-05T10:00:00.000Z',
        runtimeSettings: plan.runtimeSettings,
      };

      await advisor?.review({
        plan,
        instance,
        event: createRuntimeEvent({
          kind: 'item.completed',
          timestamp: '2026-05-05T10:00:01.000Z',
          instanceId: instance.instanceId,
          turnSequence: 1,
          item: {
            id: 'item-1',
            type: 'agent_message',
            summary: 'EVENT PAYLOAD SHOULD NOT LEAK',
          },
          provenance: {
            producer: 'codex-runtime-driver',
            sdkEventType: 'item.completed',
            threadId: null,
          },
        }),
      });

      const rawJsonl = readFileSync(ledgerPath, 'utf8');
      expect(rawJsonl).toContain('"verdictStatus":"veto"');
      expect(rawJsonl).not.toContain('PROMPT PAYLOAD SHOULD NOT LEAK');
      expect(rawJsonl).not.toContain('EVENT PAYLOAD SHOULD NOT LEAK');
      expect(rawJsonl).not.toContain('MODEL PAYLOAD SHOULD NOT LEAK');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps process environment values authoritative over .env values', () => {
    const resolvedEnv = resolveDiscordServiceBootstrapEnv(createEnv(), {
      rootDirectory: '/repo',
      fileExists: (path) => path === '/repo/.env',
      readEnvFile: () =>
        [
          'AUTO_ARCHIVE_DISCORD_TOKEN=dotenv-token',
          'AUTO_ARCHIVE_DISCORD_APPLICATION_ID=dotenv-application-id',
          'AUTO_ARCHIVE_DISCORD_GUILD_ID=dotenv-guild-id',
        ].join('\n'),
    });

    expect(resolvedEnv).toMatchObject({
      [AUTO_ARCHIVE_DISCORD_TOKEN]: 'discord-token',
      [AUTO_ARCHIVE_DISCORD_APPLICATION_ID]: 'discord-application-id',
      [AUTO_ARCHIVE_DISCORD_GUILD_ID]: 'discord-guild-id',
    });
  });

  it('passes repo-root .env Codex model settings into the service runtime driver options', () => {
    const driverOptions = resolveDiscordServiceCodexRuntimeDriverOptions(
      createEnv(),
      {
        rootDirectory: '/repo',
        fileExists: (path) => path === '/repo/.env',
        readEnvFile: () =>
          [
            'AUTO_ARCHIVE_CODEX_MODEL=gpt-5.4',
            'AUTO_ARCHIVE_CODEX_MODEL_FALLBACK=gpt-5.3-codex',
            'AUTO_ARCHIVE_CODEX_REASONING_EFFORT=high',
          ].join('\n'),
      },
    );

    expect(driverOptions.codexRuntimeConfig).toEqual({
      model: 'gpt-5.4',
      modelFallback: 'gpt-5.3-codex',
      modelReasoningEffort: 'high',
    });
  });

  it('keeps process Codex model settings authoritative over repo-root .env values', () => {
    const driverOptions = resolveDiscordServiceCodexRuntimeDriverOptions(
      createEnv({
        [CODEX_MODEL_ENV]: 'gpt-5.5',
        [CODEX_MODEL_FALLBACK_ENV]: 'gpt-5.4',
        [CODEX_REASONING_EFFORT_ENV]: 'xhigh',
      }),
      {
        rootDirectory: '/repo',
        fileExists: (path) => path === '/repo/.env',
        readEnvFile: () =>
          [
            'AUTO_ARCHIVE_CODEX_MODEL=gpt-5.4',
            'AUTO_ARCHIVE_CODEX_MODEL_FALLBACK=gpt-5.3-codex',
            'AUTO_ARCHIVE_CODEX_REASONING_EFFORT=high',
          ].join('\n'),
      },
    );

    expect(driverOptions.codexRuntimeConfig).toEqual({
      model: 'gpt-5.5',
      modelFallback: 'gpt-5.4',
      modelReasoningEffort: 'xhigh',
    });
  });

  it('treats a missing repo-root .env as non-fatal', () => {
    const resolvedEnv = resolveDiscordServiceBootstrapEnv(createEnv(), {
      rootDirectory: '/repo',
      fileExists: () => false,
    });

    expect(resolvedEnv).toMatchObject(createEnv());
  });

  it('requires the Discord service environment to be fully populated', () => {
    expect(() =>
      resolveDiscordServiceBootstrapConfig(
        createEnv({
          [AUTO_ARCHIVE_DISCORD_TOKEN]: '  ',
        }),
      ),
    ).toThrowError(
      new DiscordServiceBootstrapError(
        `Missing required environment variable ${AUTO_ARCHIVE_DISCORD_TOKEN}.`,
      ),
    );
  });

  it('uses service-grade request, natural language, and context-history defaults', () => {
    const config = resolveDiscordServiceBootstrapConfig(
      createEnv(),
      NO_REPO_ENV_OPTIONS,
    );

    expect(config).toMatchObject({
      token: 'discord-token',
      applicationId: 'discord-application-id',
      guildId: 'discord-guild-id',
      controlLedgerPath: 'runtime-state/research-control-events.jsonl',
      authDatabaseOptions: {
        mode: 'sqlite',
        path: 'runtime-state/discord-auth.sqlite',
        driver: 'python',
        pythonBinaryPath: 'python3',
        sqliteBinaryPath: 'sqlite3',
      },
      accessPolicyOptions: {
        allowedGuildIds: ['discord-guild-id'],
        adminUserIds: [],
        allowDms: false,
        allowBots: false,
      },
      enableMessageContentIntent: false,
      requestFactoryOptions: {
        resources: {
          requested: {
            cpuCores: 2,
            memoryMiB: 4096,
            wallTimeSec: 1800,
            gpuCards: 0,
          },
        },
        runtimeSettings: {
          networkProfile: 'provider-only',
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
          workingDirectory: '.',
        },
        artifactLocation: 'results/task-artifacts',
      },
      naturalLanguageOptions: {
        enableNaturalLanguageMessages: true,
        naturalLanguageTriggerMode: 'mention',
        enableMessageContextHistory: true,
        enableMessageContextHistoryBackfill: true,
        enableNaturalLanguagePrefixNotice: true,
        messageContextHistoryLimit: 30,
        messageContextHistoryMaxEntries: 500,
        messageContextHistoryBackfillLimit: 30,
      },
    });
    expect(config.naturalLanguageOptions.naturalLanguagePrefixes).toEqual([
      'arona',
      '아로나',
      'plana',
      '플라나',
    ]);
  });

  it('parses service message-content and context-history boolean flags', () => {
    const config = resolveDiscordServiceBootstrapConfig(
      createEnv({
        [AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT]: 'yes',
        [AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY]: 'off',
        [AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_BACKFILL]: '0',
      }),
    );

    expect(config.enableMessageContentIntent).toBe(true);
    expect(config.naturalLanguageOptions.enableMessageContextHistory).toBe(
      false,
    );
    expect(
      config.naturalLanguageOptions.enableMessageContextHistoryBackfill,
    ).toBe(false);
  });

  it('parses the Docker-only Codex sandbox mode override', () => {
    const config = resolveDiscordServiceBootstrapConfig(
      createEnv({
        [AUTO_ARCHIVE_DISCORD_TASK_SANDBOX_MODE]: 'danger-full-access',
      }),
      NO_REPO_ENV_OPTIONS,
    );

    expect(config.requestFactoryOptions.runtimeSettings.sandboxMode).toBe(
      'danger-full-access',
    );
  });

  it('fails closed on invalid service boolean flags', () => {
    expect(() =>
      resolveDiscordServiceBootstrapConfig(
        createEnv({
          [AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY]: 'maybe',
        }),
      ),
    ).toThrowError(
      new DiscordServiceBootstrapError(
        `${AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY} must be one of: 1, true, yes, on, 0, false, no, off; received "maybe".`,
      ),
    );
  });

  it('parses service task resource and context limit overrides', () => {
    const config = resolveDiscordServiceBootstrapConfig(
      createEnv({
        [AUTO_ARCHIVE_DISCORD_TASK_CPU_CORES]: '6',
        [AUTO_ARCHIVE_DISCORD_TASK_MEMORY_MIB]: '8192',
        [AUTO_ARCHIVE_DISCORD_TASK_WALL_TIME_SEC]: '3600',
        [AUTO_ARCHIVE_DISCORD_TASK_GPU_CARDS]: '1',
        [AUTO_ARCHIVE_DISCORD_TASK_WORKING_DIRECTORY]: 'workspace',
        [AUTO_ARCHIVE_DISCORD_TASK_ARTIFACT_LOCATION]: 'artifacts',
        [AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_LIMIT]: '12',
        [AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_MAX_ENTRIES]: '80',
        [AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_BACKFILL_LIMIT]: '9',
      }),
    );

    expect(config.requestFactoryOptions.resources.requested).toEqual({
      cpuCores: 6,
      memoryMiB: 8192,
      wallTimeSec: 3600,
      gpuCards: 1,
    });
    expect(config.requestFactoryOptions.runtimeSettings).toMatchObject({
      workingDirectory: 'workspace',
    });
    expect(config.requestFactoryOptions.artifactLocation).toBe('artifacts');
    expect(config.naturalLanguageOptions).toMatchObject({
      messageContextHistoryLimit: 12,
      messageContextHistoryMaxEntries: 80,
      messageContextHistoryBackfillLimit: 9,
    });
  });

  it('parses always-on control ledger and Discord access-policy overrides', () => {
    const config = resolveDiscordServiceBootstrapConfig(
      createEnv({
        [AUTO_ARCHIVE_CONTROL_LEDGER_PATH]: 'runtime-state/custom-control.jsonl',
        [AUTO_ARCHIVE_DISCORD_ALLOWED_USER_IDS]: 'user-1, user-2',
        [AUTO_ARCHIVE_DISCORD_ALLOWED_CHANNEL_IDS]: 'channel-1',
        [AUTO_ARCHIVE_DISCORD_ADMIN_USER_IDS]: 'admin-1',
        [AUTO_ARCHIVE_DISCORD_AUTH_DB_PATH]: 'runtime-state/custom-auth.sqlite',
        [AUTO_ARCHIVE_DISCORD_AUTH_DB_MODE]: 'memory',
        [AUTO_ARCHIVE_DISCORD_AUTH_DB_DRIVER]: 'sqlite3',
        [AUTO_ARCHIVE_DISCORD_AUTH_DB_PYTHON_BIN]: 'python-custom',
        [AUTO_ARCHIVE_DISCORD_AUTH_DB_SQLITE_BIN]: 'sqlite3-custom',
        [AUTO_ARCHIVE_DISCORD_ENABLE_DMS]: '1',
        [AUTO_ARCHIVE_DISCORD_ALLOW_BOTS]: 'yes',
      }),
    );

    expect(config.controlLedgerPath).toBe('runtime-state/custom-control.jsonl');
    expect(config.authDatabaseOptions).toEqual({
      mode: 'memory',
      path: 'runtime-state/custom-auth.sqlite',
      driver: 'sqlite3',
      pythonBinaryPath: 'python-custom',
      sqliteBinaryPath: 'sqlite3-custom',
    });
    expect(config.accessPolicyOptions).toEqual({
      allowedGuildIds: ['discord-guild-id'],
      allowedUserIds: ['user-1', 'user-2'],
      allowedChannelIds: ['channel-1'],
      adminUserIds: ['admin-1'],
      allowDms: true,
      allowBots: true,
    });
  });

  it('discovers TraitModule registry from an explicit service workspace root and contains discovery failures', () => {
    const registryDiscovery = discoverDiscordServiceTraitModuleRegistry(
      createEnv({
        [AUTO_ARCHIVE_TRAIT_MODULE_WORKSPACE_ROOT]: process.cwd(),
      }),
    );
    expect(
      registryDiscovery.traitModuleRegistry?.byRegistryKey.has(
        'trait.methodology.agent-methodology-origin.v1@1.0.0',
      ),
    ).toBe(true);

    const workspace = mkdtempSync(join(tmpdir(), 'auto-archive-traits-'));
    try {
      writeFileSync(join(workspace, 'traits'), 'not a directory');
      const failedDiscovery = discoverDiscordServiceTraitModuleRegistry(
        createEnv({
          [AUTO_ARCHIVE_TRAIT_MODULE_WORKSPACE_ROOT]: workspace,
        }),
      );
      expect(failedDiscovery.traitModuleRegistry).toBeUndefined();
      expect(failedDiscovery.traitModuleRegistryError).toContain(
        'Trait modules root is not a directory',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails closed on invalid service auth database options', () => {
    expect(() =>
      resolveDiscordServiceBootstrapConfig(
        createEnv({
          [AUTO_ARCHIVE_DISCORD_AUTH_DB_MODE]: 'json',
        }),
      ),
    ).toThrowError(
      new DiscordServiceBootstrapError(
        `${AUTO_ARCHIVE_DISCORD_AUTH_DB_MODE} must be one of: sqlite, memory; received "json".`,
      ),
    );

    expect(() =>
      resolveDiscordServiceBootstrapConfig(
        createEnv({
          [AUTO_ARCHIVE_DISCORD_AUTH_DB_DRIVER]: 'node',
        }),
      ),
    ).toThrowError(
      new DiscordServiceBootstrapError(
        `${AUTO_ARCHIVE_DISCORD_AUTH_DB_DRIVER} must be one of: python, sqlite3; received "node".`,
      ),
    );
  });

  it('fails closed on invalid service integer overrides', () => {
    expect(() =>
      resolveDiscordServiceBootstrapConfig(
        createEnv({
          [AUTO_ARCHIVE_DISCORD_TASK_GPU_CARDS]: '-1',
        }),
      ),
    ).toThrowError(
      new DiscordServiceBootstrapError(
        `${AUTO_ARCHIVE_DISCORD_TASK_GPU_CARDS} must be a non-negative integer; received "-1".`,
      ),
    );

    expect(() =>
      resolveDiscordServiceBootstrapConfig(
        createEnv({
          [AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_LIMIT]: '0',
        }),
      ),
    ).toThrowError(
      new DiscordServiceBootstrapError(
        `${AUTO_ARCHIVE_DISCORD_CONTEXT_HISTORY_LIMIT} must be a positive integer; received "0".`,
      ),
    );
  });

  it('parses service natural-language trigger and prefix overrides', () => {
    const config = resolveDiscordServiceBootstrapConfig(
      createEnv({
        [AUTO_ARCHIVE_DISCORD_NATURAL_LANGUAGE_TRIGGER_MODE]:
          'mention-or-prefix',
        [AUTO_ARCHIVE_DISCORD_NATURAL_LANGUAGE_PREFIXES]:
          'arona-test, 아로나-테스트',
      }),
    );

    expect(config.naturalLanguageOptions.naturalLanguageTriggerMode).toBe(
      'mention-or-prefix',
    );
    expect(config.naturalLanguageOptions.naturalLanguagePrefixes).toEqual([
      'arona-test',
      '아로나-테스트',
    ]);
  });

  it('fails closed on invalid service natural-language trigger modes', () => {
    expect(() =>
      resolveDiscordServiceBootstrapConfig(
        createEnv({
          [AUTO_ARCHIVE_DISCORD_NATURAL_LANGUAGE_TRIGGER_MODE]: 'prefix',
        }),
      ),
    ).toThrowError(
      new DiscordServiceBootstrapError(
        `${AUTO_ARCHIVE_DISCORD_NATURAL_LANGUAGE_TRIGGER_MODE} must be one of: mention, mention-or-prefix; received "prefix".`,
      ),
    );
  });

  it('uses slurm-apptainer by default for service bootstrap when compute mode is unset', () => {
    expect(
      createDiscordServiceComputeNode(
        createEnv({
          [AUTO_ARCHIVE_APPTAINER_IMAGE]: '/opt/images/auto-archive.sif',
          [AUTO_ARCHIVE_AGENT_INSTANCE_ENTRY]:
            '/opt/auto-archive/dist/src/runtime/agent-instance-entry.js',
        }),
        NO_REPO_ENV_OPTIONS,
      ),
    ).toBeInstanceOf(SlurmApptainerComputeNode);

    expect(
      createDiscordServiceComputeNode(
        createEnv({
          [AUTO_ARCHIVE_COMPUTE_NODE]: '  ',
          [AUTO_ARCHIVE_APPTAINER_IMAGE]: '/opt/images/auto-archive.sif',
          [AUTO_ARCHIVE_AGENT_INSTANCE_ENTRY]:
            '/opt/auto-archive/dist/src/runtime/agent-instance-entry.js',
        }),
        NO_REPO_ENV_OPTIONS,
      ),
    ).toBeInstanceOf(SlurmApptainerComputeNode);
  });

  it('fails closed when slurm-apptainer service mode lacks required runtime image wiring', () => {
    expect(() =>
      createDiscordServiceComputeNode(createEnv(), NO_REPO_ENV_OPTIONS),
    ).toThrowError(
      new DiscordServiceBootstrapError(
        `Missing required environment variable ${AUTO_ARCHIVE_APPTAINER_IMAGE} for slurm-apptainer service mode.`,
      ),
    );

    expect(() =>
      createDiscordServiceComputeNode(
        createEnv({
          [AUTO_ARCHIVE_APPTAINER_IMAGE]: '/opt/images/auto-archive.sif',
        }),
        NO_REPO_ENV_OPTIONS,
      ),
    ).toThrowError(
      new DiscordServiceBootstrapError(
        `Missing required environment variable ${AUTO_ARCHIVE_AGENT_INSTANCE_ENTRY} for slurm-apptainer service mode.`,
      ),
    );
  });

  it('constructs current-node and git-clone service compute nodes when explicitly requested', () => {
    expect(
      createDiscordServiceComputeNode(
        createEnv({
          [AUTO_ARCHIVE_COMPUTE_NODE]: 'current-node',
        }),
        NO_REPO_ENV_OPTIONS,
      ),
    ).toBeInstanceOf(CurrentNodeComputeNode);

    expect(
      createDiscordServiceComputeNode(
        createEnv({
          [AUTO_ARCHIVE_COMPUTE_NODE]: 'git-clone',
        }),
        NO_REPO_ENV_OPTIONS,
      ),
    ).toBeInstanceOf(GitLabCloneComputeNode);
  });

  it('creates trait usage telemetry only for in-process service compute modes', () => {
    expect(
      createDiscordServiceTraitUsageTelemetryFromEnv(createEnv()),
    ).toBeUndefined();
    expect(
      createDiscordServiceTraitUsageTelemetryFromEnv(
        createEnv({
          [AUTO_ARCHIVE_COMPUTE_NODE]: 'slurm-apptainer',
        }),
      ),
    ).toBeUndefined();
    expect(
      createDiscordServiceTraitUsageTelemetryFromEnv(
        createEnv({
          [AUTO_ARCHIVE_COMPUTE_NODE]: 'current-node',
        }),
      ),
    ).toBeInstanceOf(InMemoryTraitUsageTelemetry);
    expect(
      createDiscordServiceTraitUsageTelemetryFromEnv(
        createEnv({
          [AUTO_ARCHIVE_COMPUTE_NODE]: 'git-clone',
        }),
      ),
    ).toBeInstanceOf(InMemoryTraitUsageTelemetry);
  });

  it('creates control-plane OTLP observers only when the logs URL is configured', () => {
    expect(createDiscordServiceControlPlaneObserversFromEnv(createEnv())).toEqual(
      [],
    );

    const observers = createDiscordServiceControlPlaneObserversFromEnv(
      createEnv({
        [AUTO_ARCHIVE_OTEL_LOGS_URL]: 'https://otel.example/v1/logs',
        [AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES]:
          'deployment.environment=test',
      }),
    );

    expect(observers).toHaveLength(1);
  });

  it('wires task-health observers only when the stall threshold is configured', () => {
    expect(
      createDiscordServiceTaskHealthObserverBindingFromEnv(createEnv()),
    ).toMatchObject({
      midCycleObservers: [],
      taskHealthObserverEnabled: false,
    });
    for (const threshold of ['', '0', '-1', '1.5', 'NaN', 'not-a-number']) {
      const invalidBinding =
        createDiscordServiceTaskHealthObserverBindingFromEnv(
          createEnv({
            [AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS]: threshold,
          }),
        );
      expect(invalidBinding).toMatchObject({
        midCycleObservers: [],
        taskHealthObserverEnabled: false,
      });
      expect(invalidBinding.stallSignalSource).toBeUndefined();
    }

    const binding = createDiscordServiceTaskHealthObserverBindingFromEnv(
      createEnv({
        [AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS]: '1000',
      }),
      {
        nowMs: () => Date.parse('2026-05-05T00:00:01.000Z'),
      },
    );

    expect(binding.taskHealthObserverEnabled).toBe(true);
    expect(binding.midCycleObservers).toHaveLength(1);
    expect(binding.readInFlightProblems()).toEqual([]);
    binding.midCycleObservers[0]?.observe({
      taskId: 'task-health-service-1',
      instanceId: 'instance-health-service-1',
      event: createRuntimeEvent({
        kind: 'turn.started',
        instanceId: 'instance-health-service-1',
        timestamp: '2026-05-05T00:00:00.000Z',
        turnSequence: 1,
        provenance: {
          producer: 'codex-runtime-driver',
          sdkEventType: 'turn.started',
          threadId: 'thread-health-service-1',
        },
      }),
    });

    expect(binding.readInFlightProblems()).toEqual([
      {
        taskId: 'task-health-service-1',
        kind: 'stall',
        observedAt: '2026-05-05T00:00:01.000Z',
        lastProgressAt: '2026-05-05T00:00:00.000Z',
        thresholdMs: 1000,
      },
    ]);
  });

  it('starts task-health ledger recording only when threshold and tick interval are configured', () => {
    const disabledBinding = createDiscordServiceTaskHealthObserverBindingFromEnv(
      createEnv(),
    );
    const disabledScheduled: Array<() => void> = [];
    const disabledRecorder = createDiscordServiceTaskHealthLedgerRecorderFromEnv(
      createEnv({
        [AUTO_ARCHIVE_TASK_STALL_LEDGER_TICK_INTERVAL_MS]: '1000',
      }),
      disabledBinding,
      new InMemoryControlPlaneLedger(),
      {
        setInterval(callback) {
          disabledScheduled.push(callback);
          return 'disabled-handle';
        },
      },
    );
    expect(disabledRecorder.enabled).toBe(false);
    expect(disabledScheduled).toEqual([]);
    expect(() => {
      disabledRecorder.stop();
      disabledRecorder.stop();
    }).not.toThrow();

    const observerBinding = createDiscordServiceTaskHealthObserverBindingFromEnv(
      createEnv({
        [AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS]: '1000',
      }),
    );
    for (const interval of ['0', '-1', '1.5', 'not-a-number']) {
      const invalidRecorder = createDiscordServiceTaskHealthLedgerRecorderFromEnv(
        createEnv({
          [AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS]: '1000',
          [AUTO_ARCHIVE_TASK_STALL_LEDGER_TICK_INTERVAL_MS]: interval,
        }),
        observerBinding,
        new InMemoryControlPlaneLedger(),
      );
      expect(invalidRecorder.enabled).toBe(false);
    }
  });

  it('periodically records task-health stall events to the control ledger and stops cleanly', () => {
    const binding = createDiscordServiceTaskHealthObserverBindingFromEnv(
      createEnv({
        [AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS]: '1000',
      }),
    );
    const ledger = new InMemoryControlPlaneLedger();
    const scheduled: Array<{
      readonly callback: () => void;
      readonly intervalMs: number;
      readonly handle: { readonly id: string; unref(): void };
    }> = [];
    const cleared: unknown[] = [];
    const unrefCalls: string[] = [];
    let now = Date.parse('2026-05-05T00:00:00.000Z');
    const recorder = createDiscordServiceTaskHealthLedgerRecorderFromEnv(
      createEnv({
        [AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS]: '1000',
        [AUTO_ARCHIVE_TASK_STALL_LEDGER_TICK_INTERVAL_MS]: '250',
      }),
      binding,
      ledger,
      {
        nowMs: () => now,
        setInterval(callback, intervalMs) {
          const handle = {
            id: `handle-${scheduled.length + 1}`,
            unref() {
              unrefCalls.push(handle.id);
            },
          };
          scheduled.push({ callback, intervalMs, handle });
          return handle;
        },
        clearInterval(handle) {
          cleared.push(handle);
        },
      },
    );

    expect(recorder.enabled).toBe(true);
    expect(scheduled).toEqual([
      expect.objectContaining({
        intervalMs: 250,
        handle: expect.objectContaining({ id: 'handle-1' }),
      }),
    ]);
    expect(unrefCalls).toEqual(['handle-1']);
    binding.midCycleObservers[0]?.observe({
      taskId: 'task-health-ledger-service-1',
      instanceId: 'instance-health-ledger-service-1',
      event: createRuntimeEvent({
        kind: 'turn.started',
        instanceId: 'instance-health-ledger-service-1',
        timestamp: '2026-05-05T00:00:00.000Z',
        turnSequence: 1,
        provenance: {
          producer: 'codex-runtime-driver',
          sdkEventType: 'turn.started',
          threadId: 'thread-health-ledger-service-1',
        },
      }),
    });

    now = Date.parse('2026-05-05T00:00:00.999Z');
    scheduled[0]?.callback();
    expect(ledger.loadAll()).toEqual([]);

    now = Date.parse('2026-05-05T00:00:01.000Z');
    scheduled[0]?.callback();
    expect(ledger.loadAll()).toHaveLength(1);
    expect(ledger.loadAll()[0]).toMatchObject({
      type: 'task.health_stalled',
      taskId: 'task-health-ledger-service-1',
      correlationId: 'instance-health-ledger-service-1',
    });

    now = Date.parse('2026-05-05T00:00:02.000Z');
    scheduled[0]?.callback();
    expect(ledger.loadAll()).toHaveLength(1);

    recorder.stop();
    recorder.stop();
    expect(cleared).toEqual([scheduled[0]?.handle]);
  });

  it('contains task-health ledger recorder tick throws and continues on later ticks', () => {
    const ledger = new InMemoryControlPlaneLedger();
    const scheduled: Array<() => void> = [];
    const cleared: unknown[] = [];
    const loggerCalls: Array<{
      readonly event: string;
      readonly details: Record<string, unknown>;
    }> = [];
    let tickCalls = 0;
    const recorder = createDiscordServiceTaskHealthLedgerRecorderFromEnv(
      createEnv({
        [AUTO_ARCHIVE_TASK_STALL_LEDGER_TICK_INTERVAL_MS]: '250',
      }),
      {
        midCycleObservers: [],
        taskHealthObserverEnabled: true,
        stallSignalSource: {
          tick() {
            tickCalls += 1;
            if (tickCalls === 1) {
              throw new Error('tick failed');
            }
            return [
              {
                taskId: 'task-health-tick-contained',
                instanceId: 'instance-health-tick-contained',
                observedAt: '2026-05-05T00:00:02.000Z',
                lastProgressAt: '2026-05-05T00:00:00.000Z',
                thresholdMs: 1000,
                lastEventKind: 'turn.started',
              },
            ];
          },
        },
        readInFlightProblems: () => [],
      },
      ledger,
      {
        setInterval(callback) {
          scheduled.push(callback);
          return 'handle';
        },
        clearInterval(handle) {
          cleared.push(handle);
        },
        logger(event, details) {
          loggerCalls.push({ event, details });
        },
      },
    );

    expect(recorder.enabled).toBe(true);
    scheduled[0]?.();
    expect(ledger.loadAll()).toEqual([]);
    expect(loggerCalls).toEqual([
      {
        event: 'task-health-ledger-recorder-threw',
        details: { error: 'tick failed' },
      },
    ]);

    scheduled[0]?.();
    expect(ledger.loadAll()).toHaveLength(1);
    expect(ledger.loadAll()[0]).toMatchObject({
      type: 'task.health_stalled',
      taskId: 'task-health-tick-contained',
    });
    expect(scheduled).toHaveLength(1);
    expect(cleared).toEqual([]);
  });

  it('stops task-health recorder even when wrapped bot stop throws or rejects', async () => {
    const makeBot = (
      stop: () => Promise<void>,
    ): Parameters<typeof wrapBotStopWithTaskHealthRecorder>[0] =>
      ({
        client: {},
        handlers: {},
        taskRegistry: {},
        stop,
      }) as Parameters<typeof wrapBotStopWithTaskHealthRecorder>[0];
    const makeRecorder = (
      stop: () => void,
    ): Parameters<typeof wrapBotStopWithTaskHealthRecorder>[1] => ({
      enabled: true,
      stop,
    });

    let syncThrowStopCalls = 0;
    let syncThrowRecorderStops = 0;
    await expect(
      wrapBotStopWithTaskHealthRecorder(
        makeBot(() => {
          syncThrowStopCalls += 1;
          throw new Error('bot stop sync boom');
        }),
        makeRecorder(() => {
          syncThrowRecorderStops += 1;
        }),
      ).stop(),
    ).rejects.toThrow('bot stop sync boom');
    expect(syncThrowStopCalls).toBe(1);
    expect(syncThrowRecorderStops).toBe(1);

    let rejectedStopCalls = 0;
    let rejectedRecorderStops = 0;
    await expect(
      wrapBotStopWithTaskHealthRecorder(
        makeBot(() => {
          rejectedStopCalls += 1;
          return Promise.reject(new Error('bot stop rejected boom'));
        }),
        makeRecorder(() => {
          rejectedRecorderStops += 1;
        }),
      ).stop(),
    ).rejects.toThrow('bot stop rejected boom');
    expect(rejectedStopCalls).toBe(1);
    expect(rejectedRecorderStops).toBe(1);
  });

  it('shares one service trait usage telemetry sidecar between runtime hooks and /traits', () => {
    expect(
      createDiscordServiceTraitUsageTelemetryBindingFromEnv(createEnv()),
    ).toEqual({});

    const binding = createDiscordServiceTraitUsageTelemetryBindingFromEnv(
      createEnv({
        [AUTO_ARCHIVE_COMPUTE_NODE]: 'current-node',
      }),
    );

    expect(binding.runtimeTraitUsageTelemetry).toBeInstanceOf(
      InMemoryTraitUsageTelemetry,
    );
    expect(binding.botTraitUsageTelemetry).toBe(
      binding.runtimeTraitUsageTelemetry,
    );
  });

  it('wires optional GitLab project management into service Arona options', () => {
    const options = createDiscordServiceAronaOptions(
      createEnv({
        [AUTO_ARCHIVE_GITLAB_ENABLED]: 'true',
        [AUTO_ARCHIVE_GITLAB_URL]: 'https://gitlab.example.com',
        [AUTO_ARCHIVE_GITLAB_PROJECT_ID]: '42',
        [AUTO_ARCHIVE_GITLAB_TOKEN]: 'glpat-secret',
        [AUTO_ARCHIVE_GITLAB_WORK_RESULT_ISSUE_IID]: '77',
      }),
      NO_REPO_ENV_OPTIONS,
    );

    expect(options.gitLabProjectManager).toBeDefined();
    expect(options.gitLabInstanceManager).toBeDefined();
    expect(options.gitLabWorkResultRecorder).toBeDefined();
  });

  it('wires GitLab instance assignment without requiring a fixed project id', () => {
    const options = createDiscordServiceAronaOptions(
      createEnv({
        [AUTO_ARCHIVE_GITLAB_ENABLED]: 'true',
        [AUTO_ARCHIVE_GITLAB_URL]: 'https://gitlab.example.com',
        [AUTO_ARCHIVE_GITLAB_TOKEN]: 'glpat-secret',
        [AUTO_ARCHIVE_GITLAB_ASSIGNMENT_ENABLED]: 'true',
        [AUTO_ARCHIVE_GITLAB_AUTO_CREATE_PROJECTS]: 'true',
        [AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_ID]: '5',
        [AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_PATH]: 'research',
      }),
      NO_REPO_ENV_OPTIONS,
    );

    expect(options.gitLabProjectManager).toBeUndefined();
    expect(options.gitLabInstanceManager).toBeDefined();
    expect(options.gitLabProjectAssignmentManager).toBeDefined();
    expect(options.gitLabWorkResultRecorder).toBeDefined();
  });

  it('fails closed on unsupported service compute node modes', () => {
    expect(() =>
      createDiscordServiceComputeNode(
        createEnv({
          [AUTO_ARCHIVE_COMPUTE_NODE]: 'unsupported-mode',
        }),
        NO_REPO_ENV_OPTIONS,
      ),
    ).toThrowError(
      new DiscordServiceBootstrapError(
        `Unsupported ${AUTO_ARCHIVE_COMPUTE_NODE} value: unsupported-mode`,
      ),
    );
  });
});
