#!/usr/bin/env node
/**
 * Fallback launcher for Codex with the repo-local Peekaboo remote-evaluation
 * MCP server.
 *
 * Normal trusted-repo Codex CLI/app sessions should use the checked-in
 * `.codex/config.toml` project layer. This helper remains for older Codex
 * builds, not-yet-trusted project sessions, temporary CODEX_HOME smoke runs, and
 * explicit per-invocation checks. It intentionally avoids `codex mcp add` and
 * injects the MCP server with `-c` overrides for this Codex process only.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const starterPath = resolve(
  repoRoot,
  'scripts/start-peekaboo-remote-eval-mcp.mjs',
);
const serverName = 'peekaboo-remote-eval';

const mcpConfigArgs = [
  '-c',
  `mcp_servers.${serverName}.command="node"`,
  '-c',
  `mcp_servers.${serverName}.args=[${JSON.stringify(starterPath)}]`,
];

const codexRepoArgs = ['-C', repoRoot, ...mcpConfigArgs];

function usage() {
  return `Usage:
  node scripts/dev/codex-with-peekaboo-mcp.mjs [codex-options...]
  node scripts/dev/codex-with-peekaboo-mcp.mjs exec [codex-exec-options...] [PROMPT]
  node scripts/dev/codex-with-peekaboo-mcp.mjs mcp-list [codex-mcp-list-options...]
  node scripts/dev/codex-with-peekaboo-mcp.mjs --print-command

Modes:
  default    Start interactive Codex with the Peekaboo MCP server injected.
             This requires a terminal (TTY).
  exec       Run "codex exec" non-interactively with the same MCP injection.
  mcp-list   Verify the fallback per-invocation MCP configuration without
             editing ~/.codex/config.toml.

Examples:
  pnpm peekaboo:codex
  pnpm peekaboo:codex:exec -- "List MCP tools and confirm Peekaboo is present."
  pnpm peekaboo:codex:mcp-list
`;
}

function commandMap(extraArgs = []) {
  return {
    repoRoot,
    serverName,
    starterPath,
    interactive: {
      command: 'codex',
      args: [...codexRepoArgs, ...extraArgs],
    },
    exec: {
      command: 'codex',
      args: ['exec', ...codexRepoArgs, ...extraArgs],
    },
    mcpList: {
      command: 'codex',
      args: ['mcp', ...mcpConfigArgs, 'list', '--json', ...extraArgs],
    },
  };
}

function run(command, args) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });

  child.on('error', (error) => {
    console.error(`Failed to launch ${command}: ${error.message}`);
    process.exit(127);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

const argv = process.argv.slice(2);
const mode = argv[0];

if (mode === '--help' || mode === '-h' || mode === 'help') {
  console.log(usage());
  process.exit(0);
}

if (mode === '--print-command' || mode === 'print-command') {
  console.log(JSON.stringify(commandMap(argv.slice(1)), null, 2));
  process.exit(0);
}

if (mode === 'exec') {
  const { command, args } = commandMap(argv.slice(1)).exec;
  run(command, args);
} else if (mode === 'mcp-list') {
  const { command, args } = commandMap(argv.slice(1)).mcpList;
  run(command, args);
} else {
  if (!process.stdin.isTTY) {
    console.error(
      [
        'Interactive `codex` requires a terminal (TTY); current stdin is not a terminal.',
        'Run this helper from an interactive shell, or use the non-interactive exec mode:',
        '  pnpm peekaboo:codex:exec -- "List MCP tools and confirm Peekaboo is present."',
        'For config-only verification, use:',
        '  pnpm peekaboo:codex:mcp-list',
      ].join('\n'),
    );
    process.exit(2);
  }

  const { command, args } = commandMap(argv).interactive;
  run(command, args);
}
