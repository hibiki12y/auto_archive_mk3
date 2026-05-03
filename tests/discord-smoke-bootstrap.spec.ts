import { describe, expect, it } from 'vitest';

import {
  AUTO_ARCHIVE_COMPUTE_NODE,
} from '../src/core/compute-node-factory.js';
import { CurrentNodeComputeNode } from '../src/core/current-node-compute-node.js';
import { GitLabCloneComputeNode } from '../src/core/gitlab-clone-compute-node.js';
import {
  AUTO_ARCHIVE_DISCORD_APPLICATION_ID,
  AUTO_ARCHIVE_DISCORD_GUILD_ID,
  AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT,
  AUTO_ARCHIVE_DISCORD_TOKEN,
  createDiscordSmokeComputeNode,
  createDiscordSmokeAronaOptions,
  DiscordSmokeBootstrapError,
  resolveDiscordSmokeCodexRuntimeDriverOptions,
  resolveDiscordSmokeBootstrapEnv,
  resolveDiscordSmokeBootstrapConfig,
} from '../src/discord/discord-smoke-bootstrap.js';
import {
  CODEX_MODEL_ENV,
  CODEX_MODEL_FALLBACK_ENV,
  CODEX_REASONING_EFFORT_ENV,
} from '../src/runtime/codex-bootstrap-settings.js';
import {
  AUTO_ARCHIVE_GITLAB_ASSIGNMENT_ENABLED,
  AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_ID,
  AUTO_ARCHIVE_GITLAB_ASSIGNMENT_NAMESPACE_PATH,
  AUTO_ARCHIVE_GITLAB_AUTO_CREATE_PROJECTS,
  AUTO_ARCHIVE_GITLAB_ENABLED,
  AUTO_ARCHIVE_GITLAB_PROJECT_ID,
  AUTO_ARCHIVE_GITLAB_TOKEN,
  AUTO_ARCHIVE_GITLAB_URL,
} from '../src/core/gitlab-project-manager.js';

function createEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
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

describe('discord smoke bootstrap', () => {
  it('loads missing Discord variables from the repo-root .env fallback', () => {
    const config = resolveDiscordSmokeBootstrapConfig(
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

  it('keeps process environment values authoritative over .env values', () => {
    const resolvedEnv = resolveDiscordSmokeBootstrapEnv(createEnv(), {
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

  it('passes repo-root .env Codex model settings into the smoke runtime driver options', () => {
    const driverOptions = resolveDiscordSmokeCodexRuntimeDriverOptions(
      createEnv({
        HOME: '/repo/missing-home',
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
      model: 'gpt-5.4',
      modelFallback: 'gpt-5.3-codex',
      modelReasoningEffort: 'high',
    });
  });

  it('keeps process Codex model settings authoritative over repo-root .env values', () => {
    const driverOptions = resolveDiscordSmokeCodexRuntimeDriverOptions(
      createEnv({
        HOME: '/repo/missing-home',
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
    const resolvedEnv = resolveDiscordSmokeBootstrapEnv(createEnv(), {
      rootDirectory: '/repo',
      fileExists: () => false,
    });

    expect(resolvedEnv).toMatchObject(createEnv());
  });

  it('requires the Discord launcher environment to be fully populated', () => {
    expect(() =>
      resolveDiscordSmokeBootstrapConfig(
        createEnv({
          [AUTO_ARCHIVE_DISCORD_TOKEN]: '  ',
        }),
      ),
    ).toThrowError(
      new DiscordSmokeBootstrapError(
        `Missing required environment variable ${AUTO_ARCHIVE_DISCORD_TOKEN}.`,
      ),
    );
  });

  it('still fails closed when required variables are missing after .env fallback', () => {
    expect(() =>
      resolveDiscordSmokeBootstrapConfig(
        {},
        {
          rootDirectory: '/repo',
          fileExists: (path) => path === '/repo/.env',
          readEnvFile: () =>
            [
              'AUTO_ARCHIVE_DISCORD_APPLICATION_ID=dotenv-application-id',
              'AUTO_ARCHIVE_DISCORD_GUILD_ID=dotenv-guild-id',
            ].join('\n'),
        },
      ),
    ).toThrowError(
      new DiscordSmokeBootstrapError(
        `Missing required environment variable ${AUTO_ARCHIVE_DISCORD_TOKEN}.`,
      ),
    );
  });

  it('fails closed when a non-smoke compute node mode is forced', () => {
    expect(() =>
      resolveDiscordSmokeBootstrapConfig(
        createEnv({
          [AUTO_ARCHIVE_COMPUTE_NODE]: 'slurm-apptainer',
        }),
      ),
    ).toThrowError(
      new DiscordSmokeBootstrapError(
        `Discord smoke bootstrap requires ${AUTO_ARCHIVE_COMPUTE_NODE}=git-clone, current-node, or unset; received "slurm-apptainer".`,
      ),
    );
  });

  it('accepts current-node as a supported smoke compute mode', () => {
    expect(() =>
      resolveDiscordSmokeBootstrapConfig(
        createEnv({
          [AUTO_ARCHIVE_COMPUTE_NODE]: 'current-node',
        }),
      ),
    ).not.toThrow();
  });

  it('parses the optional Discord message-content intent flag', () => {
    expect(
      resolveDiscordSmokeBootstrapConfig(
        createEnv({
          [AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT]: 'yes',
        }),
      ).enableMessageContentIntent,
    ).toBe(true);

    expect(
      resolveDiscordSmokeBootstrapConfig(
        createEnv({
          [AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT]: 'off',
        }),
      ).enableMessageContentIntent,
    ).toBe(false);
  });

  it('fails closed on invalid Discord message-content intent flags', () => {
    expect(() =>
      resolveDiscordSmokeBootstrapConfig(
        createEnv({
          [AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT]: 'maybe',
        }),
      ),
    ).toThrowError(
      new DiscordSmokeBootstrapError(
        `${AUTO_ARCHIVE_DISCORD_MESSAGE_CONTENT_INTENT} must be one of: 1, true, yes, on, 0, false, no, off; received "maybe".`,
      ),
    );
  });

  it('uses git-clone by default for smoke bootstrap when the compute mode is unset', () => {
    expect(
      createDiscordSmokeComputeNode(createEnv(), NO_REPO_ENV_OPTIONS),
    ).toBeInstanceOf(GitLabCloneComputeNode);
  });

  it('constructs a current-node compute node when explicitly requested', () => {
    expect(
      createDiscordSmokeComputeNode(
        createEnv({
          [AUTO_ARCHIVE_COMPUTE_NODE]: 'current-node',
        }),
      ),
    ).toBeInstanceOf(CurrentNodeComputeNode);
  });

  it('wires optional GitLab project management into smoke Arona options', () => {
    const options = createDiscordSmokeAronaOptions(
      createEnv({
        [AUTO_ARCHIVE_GITLAB_ENABLED]: 'true',
        [AUTO_ARCHIVE_GITLAB_URL]: 'https://gitlab.example.com',
        [AUTO_ARCHIVE_GITLAB_PROJECT_ID]: '42',
        [AUTO_ARCHIVE_GITLAB_TOKEN]: 'glpat-secret',
      }),
      NO_REPO_ENV_OPTIONS,
    );

    expect(options.gitLabProjectManager).toBeDefined();
    expect(options.gitLabInstanceManager).toBeDefined();
    expect(options.gitLabWorkResultRecorder).toBeDefined();
  });

  it('wires GitLab instance assignment without requiring a fixed project id', () => {
    const options = createDiscordSmokeAronaOptions(
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

  it('returns the smoke-friendly git-clone request defaults', () => {
    const config = resolveDiscordSmokeBootstrapConfig(
      createEnv(),
      NO_REPO_ENV_OPTIONS,
    );

    expect(config).toMatchObject({
      token: 'discord-token',
      applicationId: 'discord-application-id',
      guildId: 'discord-guild-id',
      enableMessageContentIntent: false,
      requestFactoryOptions: {
        resources: {
          requested: {
            cpuCores: 2,
            memoryMiB: 4096,
            wallTimeSec: 900,
            gpuCards: 0,
          },
        },
        runtimeSettings: {
          networkProfile: 'provider-only',
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
          workingDirectory: 'results/task-artifacts',
        },
        artifactLocation: 'results/task-artifacts',
      },
    });
  });
});
