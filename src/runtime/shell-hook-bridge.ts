/**
 * M8 — Shell-hook bridge implementation.
 *
 * Bridges operator-supplied POSIX shell scripts to the M5a tier-1 trait
 * dispatch lifecycle hooks. See `src/contracts/shell-hook.ts` for the
 * wire contract and the security boundary.
 *
 * Module shape:
 *
 *   - `parseShellCommand(cmd)` → argv array, throwing on malformed input.
 *   - `loadAllowlist(path)` / `saveAllowlist(path, data)` → durable
 *     consent file at `~/.auto-archive/shell-hooks-allowlist.json`.
 *   - `isAllowed(allowlist, event, command)` → boolean gate consulted
 *     before any spawn.
 *   - `runShellHookOnce(spec, payload, options?)` → the single subprocess
 *     invocation site. All other paths funnel through this function.
 *   - `createShellHookBridge(options)` → public factory returning a
 *     `ShellHookBridgeBindings` object whose properties map to M5a hook
 *     fixtures: `bindings.beforeDispatch`, `bindings.afterDispatch`,
 *     `bindings.onTerminalEvidence`.
 *
 * The bridge is OFF by default. Enable by setting
 * `AUTO_ARCHIVE_SHELL_HOOKS=on` AND populating the allowlist (either via
 * a TTY consent flow — currently driven by callers — or by setting
 * `AUTO_ARCHIVE_ACCEPT_HOOKS=1` for non-interactive deployments).
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  NormalizedShellHookDecision,
  ShellHookDecision,
  ShellHookDiagnostic,
  ShellHookEntry,
  ShellHookEvent,
  ShellHookFireContext,
  ShellHookPayload,
} from '../contracts/shell-hook.js';
import type {
  TraitAfterDispatchHook,
  TraitBeforeDispatchHook,
  TraitDispatchHookContext,
  TraitDispatchModification,
  TraitEvidenceAnnotation,
  TraitOnTerminalEvidenceHook,
} from '../contracts/trait-runtime-hook.js';
import type { TerminalEvidence } from '../contracts/terminal-evidence.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SHELL_HOOKS_ENABLE_ENV = 'AUTO_ARCHIVE_SHELL_HOOKS';
export const SHELL_HOOKS_ACCEPT_ENV = 'AUTO_ARCHIVE_ACCEPT_HOOKS';

const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60000;

const STDOUT_CAPTURE_LIMIT = 64 * 1024;
const STDERR_CAPTURE_LIMIT = 64 * 1024;

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

export interface ShellHookAllowlistEntry {
  readonly event: ShellHookEvent;
  readonly command: string;
  readonly approvedAt: string;
}

export interface ShellHookAllowlist {
  readonly approvals: ReadonlyArray<ShellHookAllowlistEntry>;
}

export function defaultAllowlistPath(home: string = homedir()): string {
  return join(home, '.auto-archive', 'shell-hooks-allowlist.json');
}

export function loadAllowlist(path: string): ShellHookAllowlist {
  if (!existsSync(path)) {
    return { approvals: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { approvals: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { approvals: [] };
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return { approvals: [] };
  }
  const candidate = (parsed as { approvals?: unknown }).approvals;
  if (!Array.isArray(candidate)) {
    return { approvals: [] };
  }
  const approvals: ShellHookAllowlistEntry[] = [];
  for (const item of candidate) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as Record<string, unknown>).event !== 'string' ||
      typeof (item as Record<string, unknown>).command !== 'string'
    ) {
      continue;
    }
    const i = item as Record<string, unknown>;
    if (!isShellHookEvent(i.event as string)) {
      continue;
    }
    approvals.push({
      event: i.event as ShellHookEvent,
      command: i.command as string,
      approvedAt:
        typeof i.approvedAt === 'string'
          ? i.approvedAt
          : new Date(0).toISOString(),
    });
  }
  return { approvals };
}

export function saveAllowlist(
  path: string,
  data: ShellHookAllowlist,
): void {
  const dir = dirname(path);
  if (dir.length > 0 && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    path,
    JSON.stringify(
      { approvals: [...data.approvals] },
      null,
      2,
    ),
    'utf8',
  );
}

export function isAllowed(
  allowlist: ShellHookAllowlist,
  event: ShellHookEvent,
  command: string,
): boolean {
  return allowlist.approvals.some(
    (entry) => entry.event === event && entry.command === command,
  );
}

function isShellHookEvent(value: string): value is ShellHookEvent {
  return (
    value === 'before-dispatch' ||
    value === 'after-dispatch' ||
    value === 'on-terminal-evidence'
  );
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

/**
 * shlex-equivalent splitter. Supports single quotes, double quotes, and
 * backslash escapes. Throws when quotes are unterminated.
 */
export function parseShellCommand(command: string): string[] {
  const argv: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let saw = false;

  for (let i = 0; i < command.length; i++) {
    const c = command[i];

    if (escaped) {
      current += c;
      escaped = false;
      saw = true;
      continue;
    }

    if (c === '\\' && !inSingle) {
      escaped = true;
      saw = true;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      saw = true;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      saw = true;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(c)) {
      if (saw) {
        argv.push(current);
        current = '';
        saw = false;
      }
      continue;
    }
    current += c;
    saw = true;
  }

  if (inSingle || inDouble) {
    throw new Error(`shell command has unterminated quote: ${command}`);
  }
  if (saw) {
    argv.push(current);
  }

  if (argv.length === 0) {
    throw new Error('shell command is empty');
  }

  if (argv[0]?.startsWith('~')) {
    argv[0] = `${homedir()}${(argv[0]).slice(1)}`;
  }

  return argv;
}

// ---------------------------------------------------------------------------
// Decision parsing
// ---------------------------------------------------------------------------

export function parseShellHookStdout(
  event: ShellHookEvent,
  stdout: string,
): NormalizedShellHookDecision | undefined {
  if (event !== 'before-dispatch') {
    return undefined;
  }
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return undefined;
  }
  const data = parsed as ShellHookDecision;

  if (data.action === 'block') {
    const message = (data.message ?? data.reason ?? '').trim();
    if (message.length === 0) return undefined;
    return { action: 'block', message };
  }
  if (data.decision === 'block') {
    const message = (data.reason ?? data.message ?? '').trim();
    if (message.length === 0) return undefined;
    return { action: 'block', message };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export interface RunShellHookOptions {
  /** Override the default timeout (5000 ms). Clamped to [100, 60000]. */
  readonly timeoutMs?: number;
  /** Override the spawn function (testability). */
  readonly spawnFn?: typeof spawn;
}

/**
 * Spawn a shell-hook script once and return a structured diagnostic.
 *
 * - argv[0] is launched with `shell: false`. There is no shell
 *   interpolation. Tilde-expansion is applied only to the first token.
 * - The payload is written to stdin and stdin is closed.
 * - stdout/stderr are captured up to 64 KiB each.
 * - The child is killed when the timeout elapses; `timedOut: true` is
 *   set in the diagnostic.
 * - Any error is logged into `error` and the function resolves; it never
 *   throws.
 */
export async function runShellHookOnce(
  spec: ShellHookEntry,
  payload: ShellHookPayload,
  options?: RunShellHookOptions,
): Promise<ShellHookDiagnostic> {
  const t0 = Date.now();
  const timeoutMs = clampTimeout(spec.timeoutMs ?? options?.timeoutMs);

  let argv: string[];
  try {
    argv = parseShellCommand(spec.command);
  } catch (error) {
    return {
      returnCode: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      elapsedMs: 0,
      timedOut: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const spawnFn = options?.spawnFn ?? spawn;
  const stdinJson = JSON.stringify(payload);

  return new Promise<ShellHookDiagnostic>((resolve) => {
    let resolved = false;
    let stdoutLength = 0;
    let stderrLength = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    let child;
    try {
      child = spawnFn(argv[0], argv.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (error) {
      resolve({
        returnCode: null,
        stdoutBytes: 0,
        stderrBytes: 0,
        elapsedMs: Date.now() - t0,
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const timer = setTimeout(() => {
      if (resolved) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignored — already gone
      }
      resolved = true;
      resolve({
        returnCode: null,
        stdoutBytes: stdoutLength,
        stderrBytes: stderrLength,
        elapsedMs: Date.now() - t0,
        timedOut: true,
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutLength < STDOUT_CAPTURE_LIMIT) {
        const remaining = STDOUT_CAPTURE_LIMIT - stdoutLength;
        const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        stdoutChunks.push(slice);
      }
      stdoutLength += chunk.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrLength < STDERR_CAPTURE_LIMIT) {
        const remaining = STDERR_CAPTURE_LIMIT - stderrLength;
        const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        stderrChunks.push(slice);
      }
      stderrLength += chunk.length;
    });

    child.on('error', (error: Error) => {
      if (resolved) return;
      clearTimeout(timer);
      resolved = true;
      resolve({
        returnCode: null,
        stdoutBytes: stdoutLength,
        stderrBytes: stderrLength,
        elapsedMs: Date.now() - t0,
        timedOut: false,
        error: error.message,
      });
    });

    child.on('close', (code: number | null) => {
      if (resolved) return;
      clearTimeout(timer);
      resolved = true;
      const stdoutText = Buffer.concat(stdoutChunks).toString('utf8');
      const normalized = parseShellHookStdout(spec.event, stdoutText);
      resolve({
        returnCode: code,
        stdoutBytes: stdoutLength,
        stderrBytes: stderrLength,
        elapsedMs: Date.now() - t0,
        timedOut: false,
        ...(normalized === undefined ? {} : { normalized }),
      });
    });

    // EPIPE is expected when the child closes stdin without reading
    // (e.g. /bin/echo never reads its stdin). Containing it on the
    // stream itself prevents an unhandled error from crashing the
    // host process.
    child.stdin?.on('error', () => {
      // intentionally swallowed — exit code + stdout still surface via close()
    });
    try {
      child.stdin?.write(stdinJson);
      child.stdin?.end();
    } catch {
      // EPIPE — already gone. close() will still fire.
    }
  });
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  if (value < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  if (value > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// Bridge factory
// ---------------------------------------------------------------------------

export interface CreateShellHookBridgeOptions {
  /** All registered hook entries. The bridge filters by event per fire. */
  readonly entries: ReadonlyArray<ShellHookEntry>;
  /** Resolved allowlist (from `loadAllowlist`). */
  readonly allowlist: ShellHookAllowlist;
  /** Override env reader for tests. */
  readonly env?: NodeJS.ProcessEnv;
  /** Override clock for tests. */
  readonly clock?: () => string;
  /** Override spawn function for tests. */
  readonly spawnFn?: typeof spawn;
  /** Logger override (defaults to `console.warn`). */
  readonly logger?: (label: string, payload: unknown) => void;
}

export interface ShellHookBridgeBindings {
  /**
   * Hook bindings that can be passed to `AgentRuntime` /
   * `traitLifecycleHooks` etc. Each property is undefined when the
   * bridge has no enabled entry for that event.
   */
  readonly beforeDispatch: TraitBeforeDispatchHook | undefined;
  readonly afterDispatch: TraitAfterDispatchHook | undefined;
  readonly onTerminalEvidence: TraitOnTerminalEvidenceHook | undefined;
  /** Snapshot of which entries the bridge actually wired. */
  readonly enabledEntries: ReadonlyArray<ShellHookEntry>;
}

export function createShellHookBridge(
  options: CreateShellHookBridgeOptions,
): ShellHookBridgeBindings {
  const env = options.env ?? process.env;
  const enabled = (env[SHELL_HOOKS_ENABLE_ENV] ?? '').toLowerCase() === 'on';
  const clock = options.clock ?? (() => new Date().toISOString());
  const logger =
    options.logger ??
    ((label: string, payload: unknown) => {
      console.warn(label, JSON.stringify(payload));
    });

  if (!enabled) {
    return {
      beforeDispatch: undefined,
      afterDispatch: undefined,
      onTerminalEvidence: undefined,
      enabledEntries: [],
    };
  }

  // Filter to entries that are present in the allowlist.
  const enabledEntries = options.entries.filter((entry) => {
    const allowed = isAllowed(options.allowlist, entry.event, entry.command);
    if (!allowed) {
      logger('shell-hook-not-allowlisted', {
        event: entry.event,
        command: entry.command,
      });
    }
    return allowed;
  });

  const byEvent = (event: ShellHookEvent) =>
    enabledEntries.filter((e) => e.event === event);

  const before = byEvent('before-dispatch');
  const after = byEvent('after-dispatch');
  const onTerminal = byEvent('on-terminal-evidence');

  const beforeDispatch: TraitBeforeDispatchHook | undefined =
    before.length === 0
      ? undefined
      : async (context: TraitDispatchHookContext) => {
          for (const entry of before) {
            if (!matchesEntry(entry, context.taskId)) continue;
            const fireContext: ShellHookFireContext = {
              event: 'before-dispatch',
              taskId: context.taskId,
              runtimeInstanceId: context.runtimeInstanceId,
              observedAt: clock(),
            };
            const diagnostic = await invokeAndLog(
              entry,
              fireContext,
              options,
              logger,
            );
            if (diagnostic.normalized?.action === 'block') {
              const block: TraitDispatchModification = {
                kind: 'annotation-only',
                note: `shell-hook blocked dispatch: ${diagnostic.normalized.message ?? ''}`.trim(),
                evidence: {
                  shellHookCommand: entry.command,
                  shellHookMessage: diagnostic.normalized.message ?? '',
                  shellHookExitCode: diagnostic.returnCode ?? null,
                },
              };
              return block;
            }
          }
          return null;
        };

  const afterDispatch: TraitAfterDispatchHook | undefined =
    after.length === 0
      ? undefined
      : async (
          context: TraitDispatchHookContext,
          evidence: TerminalEvidence,
        ) => {
          for (const entry of after) {
            if (!matchesEntry(entry, context.taskId)) continue;
            const fireContext: ShellHookFireContext = {
              event: 'after-dispatch',
              taskId: context.taskId,
              runtimeInstanceId: context.runtimeInstanceId,
              observedAt: clock(),
              evidence,
            };
            await invokeAndLog(entry, fireContext, options, logger);
          }
        };

  const onTerminalEvidence: TraitOnTerminalEvidenceHook | undefined =
    onTerminal.length === 0
      ? undefined
      : async (
          context: TraitDispatchHookContext,
          evidence: TerminalEvidence,
        ) => {
          let annotation: TraitEvidenceAnnotation | null = null;
          for (const entry of onTerminal) {
            if (!matchesEntry(entry, context.taskId)) continue;
            const fireContext: ShellHookFireContext = {
              event: 'on-terminal-evidence',
              taskId: context.taskId,
              runtimeInstanceId: context.runtimeInstanceId,
              observedAt: clock(),
              evidence,
            };
            const diagnostic = await invokeAndLog(
              entry,
              fireContext,
              options,
              logger,
            );
            if (
              diagnostic.error === undefined &&
              !diagnostic.timedOut &&
              annotation === null
            ) {
              annotation = {
                note: `shell-hook observed terminal: ${entry.command}`,
                evidence: {
                  shellHookCommand: entry.command,
                  shellHookExitCode: diagnostic.returnCode ?? null,
                },
              };
            }
          }
          return annotation;
        };

  return {
    beforeDispatch,
    afterDispatch,
    onTerminalEvidence,
    enabledEntries,
  };
}

function matchesEntry(entry: ShellHookEntry, taskId?: string): boolean {
  if (entry.matcher === undefined) return true;
  if (taskId === undefined) return false;
  let re: RegExp;
  try {
    re = new RegExp(entry.matcher);
  } catch {
    return taskId === entry.matcher;
  }
  return re.test(taskId);
}

async function invokeAndLog(
  entry: ShellHookEntry,
  fireContext: ShellHookFireContext,
  options: CreateShellHookBridgeOptions,
  logger: (label: string, payload: unknown) => void,
): Promise<ShellHookDiagnostic> {
  const payload: ShellHookPayload = {
    hookEventName: fireContext.event,
    observedAt: fireContext.observedAt,
    ...(fireContext.taskId === undefined ? {} : { taskId: fireContext.taskId }),
    ...(fireContext.runtimeInstanceId === undefined
      ? {}
      : { runtimeInstanceId: fireContext.runtimeInstanceId }),
  };
  const runOptions: RunShellHookOptions = {
    ...(options.spawnFn === undefined ? {} : { spawnFn: options.spawnFn }),
  };
  const diagnostic = await runShellHookOnce(entry, payload, runOptions);
  if (diagnostic.error !== undefined) {
    logger('shell-hook-error', {
      event: entry.event,
      command: entry.command,
      error: diagnostic.error,
    });
  }
  if (diagnostic.timedOut) {
    logger('shell-hook-timeout', {
      event: entry.event,
      command: entry.command,
      elapsedMs: diagnostic.elapsedMs,
    });
  }
  return diagnostic;
}
