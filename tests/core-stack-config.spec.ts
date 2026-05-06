import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

function readPackageJson(): {
  dependencies: Record<string, string | undefined>;
  scripts: Record<string, string | undefined>;
} {
  return JSON.parse(readFileSync('package.json', 'utf8')) as {
    dependencies: Record<string, string | undefined>;
    scripts: Record<string, string | undefined>;
  };
}

function parseVersion(value: string): [number, number, number] {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/u);
  if (match === null) {
    throw new Error(`Unable to parse semantic version from ${value}`);
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeastVersion(
  value: string | undefined,
  minimum: [number, number, number],
): boolean {
  if (value === undefined) {
    return false;
  }

  const parsed = parseVersion(value);

  for (let index = 0; index < minimum.length; index += 1) {
    if (parsed[index] > minimum[index]) {
      return true;
    }

    if (parsed[index] < minimum[index]) {
      return false;
    }
  }

  return true;
}

describe('core stack process configuration', () => {
  it('keeps the Discord bot service in the Docker Compose core stack', () => {
    const compose = readFileSync('docker-compose.yml', 'utf8');

    expect(compose).toContain('discord-service:');
    expect(compose).toContain('container_name: auto-archive-discord-service');
    expect(compose).toContain('dockerfile: Dockerfile');
    expect(compose).toContain('restart: unless-stopped');
    expect(compose).toContain(
      'network_mode: ${AUTO_ARCHIVE_DISCORD_SERVICE_NETWORK_MODE:-bridge}',
    );
    expect(compose).toContain('runtime-state/gitlab-bootstrap-runtime.env');
    expect(compose).toContain('required: false');
    expect(compose).toContain('HOME: /home/deepsky');
    expect(compose).toContain('CODEX_HOME: /home/deepsky/.codex');
    expect(compose).toContain('AUTO_ARCHIVE_CODEX_AUTH_SOURCE: ${AUTO_ARCHIVE_CODEX_AUTH_SOURCE:-auto}');
    expect(compose).toContain('AUTO_ARCHIVE_CODEX_CLI_HOME_MODE: ${AUTO_ARCHIVE_CODEX_CLI_HOME_MODE:-isolated-auth}');
    expect(compose).toContain('AUTO_ARCHIVE_CODEX_ISOLATED_HOME: /home/deepsky/.auto-archive/codex-home');
    expect(compose).toContain('AUTO_ARCHIVE_CODEX_CLI_PATH: ""');
    expect(compose).toContain('AUTO_ARCHIVE_DISCORD_TASK_WORKING_DIRECTORY: /workspace/auto_archive_mk3');
    expect(compose).toContain('AUTO_ARCHIVE_DISCORD_TASK_SANDBOX_MODE: danger-full-access');
    expect(compose).toContain('${HOME}/.codex:/home/deepsky/.codex');
    expect(compose).toContain(
      '${AUTO_ARCHIVE_CODEX_CA_CERTS_HOST_DIR:-/opt/ai-gateway/certs}:/opt/ai-gateway/certs:ro',
    );
    expect(compose).toContain('host.docker.internal:host-gateway');
    expect(compose).not.toContain('${HOME}/.codex:/home/deepsky/.codex:ro');
    expect(compose).not.toContain('/home/node/.codex');
  });

  it('exposes Docker-only core stack lifecycle scripts for the Discord service', () => {
    const packageJson = readPackageJson();

    expect(packageJson.scripts['core:stack:start']).toContain(
      'docker compose up -d --build discord-service',
    );
    expect(packageJson.scripts['core:stack:start']).toContain(
      'node scripts/check-discord-core-stack.mjs --wait-ms 50000',
    );
    expect(packageJson.scripts['core:stack:restart']).toContain(
      'docker compose up -d --build --force-recreate discord-service',
    );
    expect(packageJson.scripts['core:stack:stop']).toBe(
      'docker compose stop discord-service',
    );
    expect(packageJson.scripts['core:stack:status']).toContain(
      'docker compose ps discord-service',
    );
    expect(packageJson.scripts['core:stack:health']).toBe(
      'node scripts/check-discord-core-stack.mjs',
    );
    expect(packageJson.scripts['discord:service']).toBe(
      'npm run core:stack:start',
    );
    expect(packageJson.scripts['discord:service:start']).toBe(
      'npm run core:stack:start',
    );
    expect(packageJson.scripts['gpu:research:readiness']).toContain(
      'scripts/gpu-transformer-research-readiness.mjs',
    );
    expect(packageJson.scripts['gpu:transformer:smoke']).toBe(
      'python3 scripts/gpu-transformer-smoke.py',
    );
    expect(packageJson.scripts['gpu:hrm:longrun']).toBe(
      'python3 scripts/hrm-small-gpu-longrun.py',
    );
    expect(JSON.stringify(packageJson.scripts)).not.toContain('pm2');
    expect(packageJson.scripts['stack:start']).toBe('npm run core:stack:start');
    expect(packageJson.scripts['stack:health']).toBe('npm run core:stack:health');
  });

  it('keeps the bundled Codex SDK new enough for gpt-5.5 Docker primary runs', () => {
    const packageJson = readPackageJson();
    const lockfile = readFileSync('pnpm-lock.yaml', 'utf8');

    expect(
      isAtLeastVersion(packageJson.dependencies['@openai/codex-sdk'], [0, 125, 0]),
    ).toBe(true);
    expect(lockfile).toContain("'@openai/codex-sdk@0.125.0':");
    expect(lockfile).toContain("'@openai/codex@0.125.0':");
  });

  it('keeps repo agent memory persistence conditional on runtime tool availability', () => {
    const agents = readFileSync('AGENTS.md', 'utf8');

    expect(agents).toContain('If an appropriate Memory MCP write');
    expect(agents).toContain('If Memory MCP write tools are not');
    expect(agents).toContain('continue without attempting unavailable');
    expect(agents).toContain(
      'control ledger, GitLab work-result issue, and explicit',
    );
    expect(agents).not.toContain(
      'then load context and store it in Memory MCP (`session-context, project-spec`)',
    );
  });
});
