/**
 * M8 — Shell-hook bridge contract.
 *
 * Lets operators register POSIX shell scripts as observers of M5a tier-1
 * dispatch lifecycle events. The bridge spawns the script with the event
 * payload as JSON-on-stdin and parses the script's JSON-on-stdout into a
 * structured decision (Claude Code-compatible wire shape; see Hermes
 * `agent/shell_hooks.py:484-531` for the canonical reference).
 *
 * Defensive design points:
 *   - Default-OFF: registering hooks requires the operator to set
 *     `AUTO_ARCHIVE_SHELL_HOOKS=on` AND each command must be present in
 *     the allowlist file. Non-TTY callers without `AUTO_ARCHIVE_ACCEPT_HOOKS=1`
 *     never auto-promote a new entry.
 *   - Argument parsing is shell-injection-safe: the command string is split
 *     on whitespace with shlex-equivalent quoting awareness, then passed to
 *     `spawn(argv[0], argv.slice(1), { shell: false })` directly. There is
 *     no shell interpreter in the loop.
 *   - All scripts are run with a short timeout (default 5s; configurable
 *     per-entry up to 60s). Timed-out or erroring scripts are logged and
 *     skipped — they never block dispatch.
 *   - The hook surface is observe-by-default. Only the `before-dispatch`
 *     event consumes a structured decision (`{action:'block', message?}`);
 *     all other events ignore the script's stdout entirely.
 */

import type { TerminalEvidence } from './terminal-evidence.js';

/**
 * Events to which a shell-hook may subscribe. Maps to M5a tier-1 hooks.
 * `cron` and `acp` variants are intentionally absent — those subsystems
 * don't yet exist in auto_archive_mk3.
 */
export type ShellHookEvent =
  | 'before-dispatch'
  | 'after-dispatch'
  | 'on-terminal-evidence';

/**
 * One configured shell-hook entry. Operators populate this from
 * a config file or programmatic registration.
 */
export interface ShellHookEntry {
  readonly event: ShellHookEvent;
  /**
   * The command line to run. Parsed with shlex-equivalent rules and then
   * passed to `child_process.spawn` with `shell: false`. Tilde expansion
   * is applied to the first token only.
   */
  readonly command: string;
  /**
   * Optional regular-expression matcher applied to a string identifier
   * carried in the event payload (e.g., `taskId`). When set, the hook
   * fires only if `RegExp(matcher).test(identifier)` succeeds.
   */
  readonly matcher?: string;
  /**
   * Per-entry timeout in milliseconds. Clamped to `[100, 60000]`. If
   * unset, the bridge default (5000ms) applies.
   */
  readonly timeoutMs?: number;
}

/**
 * The wire-shape decision returned by a `before-dispatch` hook script.
 * Other events SHOULD return `{}` (no action) — the bridge ignores any
 * fields except `action: 'block' | undefined`.
 *
 * Both `{action,'message'}` (Hermes shape) and `{decision,'reason'}`
 * (Claude Code shape) are accepted. The bridge normalizes them.
 */
export interface ShellHookDecision {
  readonly action?: 'block';
  readonly message?: string;
  readonly decision?: 'block';
  readonly reason?: string;
  readonly context?: string;
}

/** Normalized decision after parsing & validation. */
export interface NormalizedShellHookDecision {
  readonly action: 'block' | 'noop';
  readonly message?: string;
}

/**
 * Per-entry diagnostic returned by `runShellHookOnce`. Useful for tests
 * and for operator dashboards that surface hook health.
 */
export interface ShellHookDiagnostic {
  readonly returnCode: number | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly elapsedMs: number;
  readonly timedOut: boolean;
  readonly error?: string;
  readonly normalized?: NormalizedShellHookDecision;
}

/** The wire-shape JSON payload written to the child's stdin. */
export interface ShellHookPayload {
  readonly hookEventName: ShellHookEvent;
  readonly observedAt: string;
  readonly taskId?: string;
  readonly runtimeInstanceId?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * The control-plane envelope passed to the bridge for every fire. The
 * bridge filters by `event` and `matcher` then spawns the script.
 */
export interface ShellHookFireContext {
  readonly event: ShellHookEvent;
  readonly taskId?: string;
  readonly runtimeInstanceId?: string;
  readonly observedAt: string;
  readonly evidence?: TerminalEvidence;
  readonly extra?: Readonly<Record<string, unknown>>;
}
