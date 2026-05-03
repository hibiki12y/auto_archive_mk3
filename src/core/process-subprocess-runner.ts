/**
 * Production `SubprocessRunner` implementation.
 *
 * Backs the `SlurmApptainerComputeNode` seam declared in
 * `compute-node-slurm-apptainer.ts` with a real `node:child_process.spawn`
 * invocation of the three allowed CLIs (`salloc`, `apptainer`, `scancel`).
 *
 * Boundaries:
 *   - Only the three commands declared on `SubprocessRequest.command` may
 *     be spawned. Anything else throws synchronously before spawn.
 *   - The runner builds a minimal allowlisted environment (PATH/HOME/user
 *     locale/temp identity plus selected non-secret SLURM scheduler context)
 *     and overlays the subset of env declared on the request. It never
 *     inherits the full process environment.
 *   - stdout/stderr are captured as UTF-8 strings. `onStderrLine` (if
 *     supplied) receives one complete line per call as the child runs.
 *   - stdin (if supplied) is written and closed before stdout/stderr drain.
 */

import { spawn, type SpawnOptions } from 'node:child_process';

import type {
  SubprocessRequest,
  SubprocessResult,
  SubprocessRunner,
} from './compute-node-slurm-apptainer.js';

const ALLOWED_COMMANDS: ReadonlyArray<SubprocessRequest['command']> = Object.freeze([
  'salloc',
  'apptainer',
  'scancel',
]);

const HOST_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TERM',
]);

const SLURM_ENV_ALLOWLIST = /^SLURM_(?:JOB|STEP|SUBMIT|CLUSTER|CPUS|MEM|GPUS?|CUDA|NODE|NTASKS|PROCID|LOCALID|TASKS_PER_NODE|ACCOUNT|QOS|PARTITION)/u;

export interface ProcessSubprocessRunnerOptions {
  /**
   * Resolved binary path overrides. When supplied, the runner spawns this
   * exact path instead of searching `$PATH` for the command name. Used in
   * tests and to pin which `apptainer`/`salloc` binary the production
   * deployment invokes.
   */
  readonly commandPaths?: Partial<Record<SubprocessRequest['command'], string>>;
  /**
   * Optional spawn function override. Defaults to `node:child_process.spawn`.
   * Tests inject a synthetic spawn to assert behavior without touching real
   * processes.
   */
  readonly spawn?: typeof spawn;
  /**
   * Site-local non-secret host environment variables to pass through in
   * addition to the built-in allowlist. Secret-looking names are rejected so
   * operators cannot accidentally re-enable full credential inheritance.
   */
  readonly additionalHostEnvAllowlist?: readonly string[];
}

export class ProcessSubprocessRunner implements SubprocessRunner {
  private readonly commandPaths: Partial<Record<SubprocessRequest['command'], string>>;
  private readonly spawnFn: typeof spawn;
  private readonly additionalHostEnvAllowlist: ReadonlySet<string>;

  constructor(options: ProcessSubprocessRunnerOptions = {}) {
    this.commandPaths = options.commandPaths ?? {};
    this.spawnFn = options.spawn ?? spawn;
    this.additionalHostEnvAllowlist = new Set(
      (options.additionalHostEnvAllowlist ?? []).map(validateAdditionalHostEnvName),
    );
  }

  async run(request: SubprocessRequest): Promise<SubprocessResult> {
    if (!ALLOWED_COMMANDS.includes(request.command)) {
      throw new Error(
        `ProcessSubprocessRunner: command not allowed: ${String(request.command)}`,
      );
    }

    const executable = this.commandPaths[request.command] ?? request.command;

    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSubprocessEnv(request.env, this.additionalHostEnvAllowlist),
    };

    const child = this.spawnFn(executable, [...request.args], spawnOptions);

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let stderrBuffer = '';

    if (child.stdout !== null) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutChunks.push(chunk);
      });
    }

    if (child.stderr !== null) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrChunks.push(chunk);
        if (request.onStderrLine === undefined) {
          return;
        }
        stderrBuffer += chunk;
        let newlineIdx = stderrBuffer.indexOf('\n');
        while (newlineIdx !== -1) {
          const line = stderrBuffer.slice(0, newlineIdx);
          stderrBuffer = stderrBuffer.slice(newlineIdx + 1);
          try {
            request.onStderrLine(line);
          } catch {
            // best-effort: swallow handler errors
          }
          newlineIdx = stderrBuffer.indexOf('\n');
        }
      });
    }

    if (child.stdin !== null) {
      if (request.stdin !== undefined) {
        child.stdin.write(request.stdin, 'utf8');
      }
      child.stdin.end();
    }

    return await new Promise<SubprocessResult>((resolveResult, rejectResult) => {
      child.on('error', (err: Error) => {
        rejectResult(
          new Error(
            `ProcessSubprocessRunner: spawn ${executable} failed: ${err.message}`,
          ),
        );
      });
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (stderrBuffer.length > 0 && request.onStderrLine !== undefined) {
          try {
            request.onStderrLine(stderrBuffer);
          } catch {
            // best-effort
          }
          stderrBuffer = '';
        }

        const exitCode =
          code !== null ? code : signal !== null ? 128 + signalCode(signal) : 1;

        resolveResult({
          exitCode,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
        });
      });
    });
  }
}

const SIGNAL_CODES: Readonly<Record<string, number>> = Object.freeze({
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGTERM: 15,
});

function signalCode(signal: NodeJS.Signals): number {
  return SIGNAL_CODES[signal] ?? 0;
}

function buildSubprocessEnv(
  requestEnv: Readonly<Record<string, string>> | undefined,
  additionalHostEnvAllowlist: ReadonlySet<string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') {
      continue;
    }
    if (
      HOST_ENV_ALLOWLIST.has(key) ||
      SLURM_ENV_ALLOWLIST.test(key) ||
      additionalHostEnvAllowlist.has(key)
    ) {
      env[key] = value;
    }
  }

  if (requestEnv !== undefined) {
    for (const [key, value] of Object.entries(requestEnv)) {
      if (typeof value !== 'string') {
        throw new Error(
          `ProcessSubprocessRunner: env override ${key} must be a string.`,
        );
      }
      env[key] = value;
    }
  }

  return env;
}


const SECRET_LIKE_ENV_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|KEY)/iu;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

function validateAdditionalHostEnvName(name: string): string {
  const normalized = name.trim();
  if (!ENV_NAME_PATTERN.test(normalized)) {
    throw new Error(
      `ProcessSubprocessRunner: additional host env name is invalid: ${name}`,
    );
  }
  if (SECRET_LIKE_ENV_NAME.test(normalized)) {
    throw new Error(
      `ProcessSubprocessRunner: additional host env name looks secret-bearing: ${normalized}`,
    );
  }
  return normalized;
}
