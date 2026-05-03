#!/usr/bin/env node
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { parse } from 'dotenv';

const DEFAULT_OUTPUT_PATH = 'runtime-state/gitlab-bootstrap-runtime.env';
const DEFAULT_ADMIN_TOKEN_ENV = 'GITLAB_ADMIN_TOKEN';
const DEFAULT_RUNTIME_TOKEN_LIFETIME_DAYS = 365;
const MS_PER_DAY = 86_400_000;

function formatGitLabDate(date) {
  return date.toISOString().slice(0, 10);
}

function defaultRuntimeTokenExpiresAt(now = new Date()) {
  return formatGitLabDate(
    new Date(now.getTime() + DEFAULT_RUNTIME_TOKEN_LIFETIME_DAYS * MS_PER_DAY),
  );
}

function optionalNonEmpty(value) {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function readOptionValue(arg, argv, index) {
  if (arg.includes('=')) {
    return arg.slice(arg.indexOf('=') + 1);
  }
  return argv[index + 1];
}

function parseArgs(argv) {
  const args = {
    output: process.env.AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_ENV_OUTPUT ?? DEFAULT_OUTPUT_PATH,
    printSecret: false,
    prompt: true,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (
      arg === '--url' ||
      arg === '--gitlab-url' ||
      arg === '--server-url' ||
      arg.startsWith('--url=') ||
      arg.startsWith('--gitlab-url=') ||
      arg.startsWith('--server-url=')
    ) {
      const value = readOptionValue(arg, argv, i);
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a URL`);
      }
      args.gitLabUrl = value;
      if (!arg.includes('=')) {
        i += 1;
      }
      continue;
    }
    if (
      arg === '--runtime-token-expires-at' ||
      arg === '--expires-at' ||
      arg.startsWith('--runtime-token-expires-at=') ||
      arg.startsWith('--expires-at=')
    ) {
      const value = readOptionValue(arg, argv, i);
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a YYYY-MM-DD date`);
      }
      args.runtimeTokenExpiresAt = value;
      if (!arg.includes('=')) {
        i += 1;
      }
      continue;
    }
    if (arg === '--print-secret') {
      args.printSecret = true;
      continue;
    }
    if (arg === '--dry-run-config') {
      args.dryRunConfig = true;
      continue;
    }
    if (arg === '--no-prompt') {
      args.prompt = false;
      continue;
    }
    if (arg === '--no-output-file') {
      args.output = undefined;
      continue;
    }
    if (arg === '--output' || arg.startsWith('--output=')) {
      const value = readOptionValue(arg, argv, i);
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a path`);
      }
      args.output = value;
      if (!arg.includes('=')) {
        i += 1;
      }
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function loadEnv() {
  const envFilePath = resolve(process.cwd(), '.env');
  if (!existsSync(envFilePath)) {
    return process.env;
  }
  return {
    ...parse(readFileSync(envFilePath, { encoding: 'utf8' })),
    ...process.env,
  };
}

function printHelp() {
  console.log(`Usage: pnpm gitlab:admin-bootstrap [--url URL] [--runtime-token-expires-at YYYY-MM-DD] [--output PATH] [--no-output-file] [--print-secret]

Runs the one-time GitLab admin bootstrap:
  1. ensure the Auto Archive GitLab group,
  2. create a group-scoped runtime token,
  3. persist or explicitly print the runtime token,
  4. revoke the admin PAT when configured to discard it.

By default the runtime env block is written to:
  ${DEFAULT_OUTPUT_PATH}

If AUTO_ARCHIVE_GITLAB_URL or the admin PAT is missing, the script prompts for
them in an interactive terminal. Admin PAT input is hidden. The default admin PAT
env name is ${DEFAULT_ADMIN_TOKEN_ENV}; use AUTO_ARCHIVE_GITLAB_ADMIN_TOKEN_ENV
only when a custom secret env name is required.

Runtime group access tokens get a default expires_at value ${DEFAULT_RUNTIME_TOKEN_LIFETIME_DAYS} days
from the run date because many GitLab instances require expires_at.

Useful options:
  --url URL                              Provide the GitLab server URL without prompting.
  --runtime-token-expires-at YYYY-MM-DD  Override the runtime token expiration date.
  --dry-run-config                       Resolve inputs and show the redacted bootstrap config only.
  --no-prompt                            Fail instead of prompting for missing URL/token.

Secrets are redacted in stdout unless --print-secret is set.`);
}

async function promptLine(question, defaultValue) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const suffix = defaultValue === undefined ? ': ' : ` [${defaultValue}]: `;
    const answer = await rl.question(`${question}${suffix}`);
    return optionalNonEmpty(answer) ?? defaultValue;
  } finally {
    rl.close();
  }
}

async function promptSecret(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return promptLine(question);
  }

  return new Promise((resolveSecret, rejectSecret) => {
    let secret = '';
    const input = process.stdin;

    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
    };

    const rejectWithCleanup = (error) => {
      cleanup();
      rejectSecret(error);
    };

    const onData = (chunk) => {
      const text = String(chunk);
      for (const char of text) {
        if (char === '\u0003') {
          rejectWithCleanup(new Error('Interrupted while reading admin token.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolveSecret(secret);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          secret = secret.slice(0, -1);
          continue;
        }
        secret += char;
      }
    };

    process.stdout.write(`${question}: `);
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

function getAdminTokenEnvName(env) {
  return optionalNonEmpty(env.AUTO_ARCHIVE_GITLAB_ADMIN_TOKEN_ENV) ?? DEFAULT_ADMIN_TOKEN_ENV;
}

function getAdminToken(env) {
  return optionalNonEmpty(env.AUTO_ARCHIVE_GITLAB_ADMIN_TOKEN) ??
    optionalNonEmpty(env[getAdminTokenEnvName(env)]);
}

async function resolveBootstrapEnv(args) {
  const loadedEnv = loadEnv();
  const env = {
    AUTO_ARCHIVE_GITLAB_ADMIN_BOOTSTRAP_ENABLED: 'true',
    AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_NAME: 'Auto Archive',
    AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_PATH: 'auto-archive',
    AUTO_ARCHIVE_GITLAB_BOOTSTRAP_GROUP_VISIBILITY: 'private',
    AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_NAME: 'auto-archive-runtime',
    AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_SCOPES: 'api,write_repository',
    AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_ACCESS_LEVEL: '50',
    AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_EXPIRES_AT: defaultRuntimeTokenExpiresAt(),
    AUTO_ARCHIVE_GITLAB_ADMIN_BOOTSTRAP_DISCARD_ADMIN_TOKEN: 'true',
    ...loadedEnv,
  };
  if (optionalNonEmpty(args.runtimeTokenExpiresAt) !== undefined) {
    env.AUTO_ARCHIVE_GITLAB_BOOTSTRAP_RUNTIME_TOKEN_EXPIRES_AT =
      args.runtimeTokenExpiresAt;
  }

  const existingUrl = optionalNonEmpty(args.gitLabUrl) ??
    optionalNonEmpty(env.AUTO_ARCHIVE_GITLAB_URL);
  if (existingUrl === undefined) {
    if (!args.prompt || !process.stdin.isTTY) {
      throw new Error(
        'Missing GitLab server URL. Pass --url URL, set AUTO_ARCHIVE_GITLAB_URL, or run in an interactive terminal.',
      );
    }
    env.AUTO_ARCHIVE_GITLAB_URL = await promptLine('GitLab server URL', 'https://gitlab.example.com');
  } else {
    env.AUTO_ARCHIVE_GITLAB_URL = existingUrl;
  }

  if (getAdminToken(env) === undefined) {
    if (!args.prompt || !process.stdin.isTTY) {
      throw new Error(
        `Missing GitLab admin PAT. Set ${getAdminTokenEnvName(env)} or run in an interactive terminal.`,
      );
    }
    const adminToken = optionalNonEmpty(await promptSecret('GitLab admin PAT'));
    if (adminToken === undefined) {
      throw new Error('GitLab admin PAT cannot be empty.');
    }
    env[getAdminTokenEnvName(env)] = adminToken;
  }

  return env;
}

function writeRuntimeEnvFile(runtimeEnv, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, `${runtimeEnv}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, outputPath);
    chmodSync(outputPath, 0o600);
  } catch (error) {
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {
      // Preserve the original write/rename failure.
    }
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.dryRunConfig && args.output === undefined && !args.printSecret) {
    throw new Error(
      'Refusing to run without --output or --print-secret because the runtime token would not be persisted or shown before admin-token disposal.',
    );
  }
  const bootstrapEnv = await resolveBootstrapEnv(args);

  const {
    redactGitLabAdminBootstrapResult,
    resolveGitLabAdminBootstrapConfig,
    runGitLabAdminBootstrapFromEnv,
  } = await import('../dist/src/core/gitlab-admin-bootstrap.js');

  const outputPath = args.output === undefined ? undefined : resolve(process.cwd(), args.output);
  if (args.dryRunConfig) {
    const config = resolveGitLabAdminBootstrapConfig(bootstrapEnv);
    if (config === undefined) {
      throw new Error('GitLab admin bootstrap is disabled.');
    }
    console.log(JSON.stringify({
      ...config,
      adminToken: '[REDACTED_SECRET]',
      runtimeEnvOutputPath: outputPath ?? null,
      dryRunConfig: true,
    }, null, 2));
    return;
  }

  const result = await runGitLabAdminBootstrapFromEnv(bootstrapEnv, {
    onRuntimeEnvReady: outputPath === undefined
      ? undefined
      : (bootstrapResult) => {
          writeRuntimeEnvFile(bootstrapResult.runtimeEnv, outputPath);
        },
  });
  if (result === undefined) {
    throw new Error('GitLab admin bootstrap is disabled; set AUTO_ARCHIVE_GITLAB_ADMIN_BOOTSTRAP_ENABLED=true.');
  }

  const printable = args.printSecret ? result : redactGitLabAdminBootstrapResult(result);
  console.log(JSON.stringify({
    ...printable,
    runtimeEnvOutputPath: outputPath ?? null,
    secretPrintedToStdout: args.printSecret,
  }, null, 2));
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
