#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = spawnSync('npm', ['run', 'build'], {
  cwd: repoRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (build.stdout) {
  process.stderr.write(build.stdout);
}
if (build.stderr) {
  process.stderr.write(build.stderr);
}
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const serverPath = resolve(
  repoRoot,
  'dist/src/remote/peekaboo-remote-eval-mcp.js',
);
const child = spawn(process.execPath, [serverPath], {
  cwd: repoRoot,
  stdio: 'inherit',
});

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};
process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
