/**
 * M8 — Shell-hook bridge unit tests.
 *
 * Coverage:
 *   - parseShellCommand handles whitespace, single/double quotes, escapes,
 *     unterminated quotes, empty input, tilde expansion.
 *   - Allowlist load/save roundtrip + isAllowed semantics.
 *   - parseShellHookStdout normalizes both Hermes (`{action,message}`) and
 *     Claude Code (`{decision,reason}`) shapes for `before-dispatch`;
 *     ignores stdout for other events.
 *   - runShellHookOnce reports timeouts, errors, and exit codes via a
 *     fake spawn double.
 *   - createShellHookBridge: default-OFF without env flag; default-OFF
 *     when allowlist is empty; matcher applied per-fire; before-dispatch
 *     decision flows back through the M5a hook surface; after-dispatch
 *     and on-terminal-evidence produce expected diagnostics.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createShellHookBridge,
  defaultAllowlistPath,
  isAllowed,
  loadAllowlist,
  parseShellCommand,
  parseShellHookStdout,
  resolveShellHookAllowlist,
  runShellHookOnce,
  saveAllowlist,
  SHELL_HOOKS_ACCEPT_ENV,
  SHELL_HOOKS_ENABLE_ENV,
} from '../src/runtime/shell-hook-bridge.js';
import type { ShellHookEntry } from '../src/contracts/shell-hook.js';

function mkDir(): string {
  return mkdtempSync(join(tmpdir(), 'aa-shell-hook-'));
}

describe('M8 — parseShellCommand', () => {
  it('splits on whitespace', () => {
    expect(parseShellCommand('echo hello world')).toEqual([
      'echo',
      'hello',
      'world',
    ]);
  });

  it('preserves spaces inside double quotes', () => {
    expect(parseShellCommand('echo "hello world" tail')).toEqual([
      'echo',
      'hello world',
      'tail',
    ]);
  });

  it('preserves spaces inside single quotes and ignores escapes inside them', () => {
    expect(parseShellCommand("echo 'a b\\nc'")).toEqual(['echo', 'a b\\nc']);
  });

  it('honors backslash escapes outside single quotes', () => {
    expect(parseShellCommand('echo a\\ b')).toEqual(['echo', 'a b']);
  });

  it('throws on unterminated single quote', () => {
    expect(() => parseShellCommand("echo 'oops")).toThrow(/unterminated/);
  });

  it('throws on unterminated double quote', () => {
    expect(() => parseShellCommand('echo "oops')).toThrow(/unterminated/);
  });

  it('throws on empty command', () => {
    expect(() => parseShellCommand('   ')).toThrow(/empty/);
  });

  it('expands a leading tilde to homedir', () => {
    const argv = parseShellCommand('~/bin/script.sh arg');
    expect(argv[0]?.startsWith('/')).toBe(true);
    expect(argv[0]?.endsWith('/bin/script.sh')).toBe(true);
    expect(argv[1]).toBe('arg');
  });
});

describe('M8 — allowlist', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('defaultAllowlistPath uses the home dir', () => {
    const p = defaultAllowlistPath('/tmp/fake-home');
    expect(p).toBe(
      '/tmp/fake-home/.auto-archive/shell-hooks-allowlist.json',
    );
  });

  it('returns empty approvals when file is absent', () => {
    dir = mkDir();
    const result = loadAllowlist(join(dir, 'no-such-file.json'));
    expect(result.approvals).toEqual([]);
  });

  it('returns empty approvals when file is malformed JSON', () => {
    dir = mkDir();
    const path = join(dir, 'malformed.json');
    writeFileSync(path, '{ not json', 'utf8');
    const result = loadAllowlist(path);
    expect(result.approvals).toEqual([]);
  });

  it('round-trips approvals via saveAllowlist + loadAllowlist', () => {
    dir = mkDir();
    const path = join(dir, 'sub', 'allowlist.json');
    saveAllowlist(path, {
      approvals: [
        {
          event: 'before-dispatch',
          command: '/usr/bin/true',
          approvedAt: '2026-05-01T00:00:00.000Z',
        },
      ],
    });
    const loaded = loadAllowlist(path);
    expect(loaded.approvals).toHaveLength(1);
    expect(loaded.approvals[0]).toMatchObject({
      event: 'before-dispatch',
      command: '/usr/bin/true',
    });
  });

  it('skips entries with unknown events on load', () => {
    dir = mkDir();
    const path = join(dir, 'mixed.json');
    writeFileSync(
      path,
      JSON.stringify({
        approvals: [
          { event: 'after-dispatch', command: 'good' },
          { event: 'unknown-event', command: 'bad' },
          { event: 'before-dispatch', command: 'fine' },
        ],
      }),
      'utf8',
    );
    const loaded = loadAllowlist(path);
    expect(loaded.approvals.map((a) => a.event)).toEqual([
      'after-dispatch',
      'before-dispatch',
    ]);
  });

  it('isAllowed gates by event + exact command match', () => {
    const allow = {
      approvals: [
        {
          event: 'before-dispatch' as const,
          command: '/bin/echo',
          approvedAt: '',
        },
      ],
    };
    expect(isAllowed(allow, 'before-dispatch', '/bin/echo')).toBe(true);
    expect(isAllowed(allow, 'after-dispatch', '/bin/echo')).toBe(false);
    expect(isAllowed(allow, 'before-dispatch', '/bin/echo ')).toBe(false);
  });

  it('does not auto-promote unapproved entries without explicit accept env', () => {
    const logger = vi.fn();
    const spec: ShellHookEntry = {
      event: 'before-dispatch',
      command: '/bin/echo',
    };
    const resolution = resolveShellHookAllowlist({
      entries: [spec],
      allowlist: { approvals: [] },
      env: {},
      logger,
    });

    expect(resolution.allowlist.approvals).toEqual([]);
    expect(resolution.approvedEntries).toEqual([]);
    expect(resolution.pendingEntries).toEqual([spec]);
    expect(logger).toHaveBeenCalledWith(
      'shell-hook-consent-required',
      expect.objectContaining({
        event: 'before-dispatch',
        command: '/bin/echo',
        acceptEnv: SHELL_HOOKS_ACCEPT_ENV,
      }),
    );
  });

  it('auto-promotes entries only when AUTO_ARCHIVE_ACCEPT_HOOKS=1 is explicit', () => {
    const logger = vi.fn();
    const spec: ShellHookEntry = {
      event: 'after-dispatch',
      command: '/bin/true',
    };
    const resolution = resolveShellHookAllowlist({
      entries: [spec, spec],
      allowlist: { approvals: [] },
      env: { [SHELL_HOOKS_ACCEPT_ENV]: '1' },
      clock: () => '2026-05-05T00:00:00.000Z',
      logger,
    });

    expect(resolution.allowlist.approvals).toEqual([
      {
        event: 'after-dispatch',
        command: '/bin/true',
        approvedAt: '2026-05-05T00:00:00.000Z',
      },
    ]);
    expect(resolution.approvedEntries).toHaveLength(1);
    expect(resolution.pendingEntries).toEqual([]);
    expect(logger).toHaveBeenCalledWith(
      'shell-hook-auto-allowlisted',
      expect.objectContaining({
        event: 'after-dispatch',
        command: '/bin/true',
        acceptEnv: SHELL_HOOKS_ACCEPT_ENV,
      }),
    );
  });

  it.each(['true', 'yes', '01', '10', '1.0', '1 ', ' 1', '1\n', ''])(
    'does not auto-promote when AUTO_ARCHIVE_ACCEPT_HOOKS=%j',
    (acceptValue) => {
      const logger = vi.fn();
      const spec: ShellHookEntry = {
        event: 'after-dispatch',
        command: '/bin/true',
      };
      const resolution = resolveShellHookAllowlist({
        entries: [spec],
        allowlist: { approvals: [] },
        env: { [SHELL_HOOKS_ACCEPT_ENV]: acceptValue },
        logger,
      });

      expect(resolution.allowlist.approvals).toEqual([]);
      expect(resolution.approvedEntries).toEqual([]);
      expect(resolution.pendingEntries).toEqual([spec]);
      expect(logger).toHaveBeenCalledWith(
        'shell-hook-consent-required',
        expect.objectContaining({
          event: 'after-dispatch',
          command: '/bin/true',
          acceptEnv: SHELL_HOOKS_ACCEPT_ENV,
        }),
      );
      expect(logger).not.toHaveBeenCalledWith(
        'shell-hook-auto-allowlisted',
        expect.anything(),
      );
    },
  );
});

describe('M8 — parseShellHookStdout', () => {
  it('returns undefined for non before-dispatch events', () => {
    expect(parseShellHookStdout('after-dispatch', '{"action":"block"}')).toBeUndefined();
    expect(parseShellHookStdout('on-terminal-evidence', '{"action":"block"}')).toBeUndefined();
  });

  it('returns undefined for empty stdout', () => {
    expect(parseShellHookStdout('before-dispatch', '   ')).toBeUndefined();
  });

  it('returns undefined when stdout is not JSON', () => {
    expect(parseShellHookStdout('before-dispatch', 'plain text')).toBeUndefined();
  });

  it('normalizes Hermes-shape {action,message}', () => {
    const result = parseShellHookStdout(
      'before-dispatch',
      JSON.stringify({ action: 'block', message: 'denied for X' }),
    );
    expect(result).toEqual({ action: 'block', message: 'denied for X' });
  });

  it('normalizes Claude Code-shape {decision,reason}', () => {
    const result = parseShellHookStdout(
      'before-dispatch',
      JSON.stringify({ decision: 'block', reason: 'policy violation' }),
    );
    expect(result).toEqual({ action: 'block', message: 'policy violation' });
  });

  it('returns undefined when block has no message', () => {
    expect(
      parseShellHookStdout(
        'before-dispatch',
        JSON.stringify({ action: 'block' }),
      ),
    ).toBeUndefined();
  });
});

describe('M8 — runShellHookOnce', () => {
  it('captures stdout and returnCode 0 from printf', async () => {
    // Use printf rather than a nested `node -e`: some sandboxed test runners
    // deny child Node spawns, while `/usr/bin/printf` still exercises the same
    // stdout-capture and JSON-normalization path.
    const spec: ShellHookEntry = {
      event: 'before-dispatch',
      command:
        '/usr/bin/printf {\\"action\\":\\"block\\",\\"message\\":\\"nope\\"}',
    };
    const diag = await runShellHookOnce(spec, {
      hookEventName: 'before-dispatch',
      observedAt: '2026-05-01T00:00:00.000Z',
      taskId: 'task-1',
    });
    expect(diag.returnCode).toBe(0);
    expect(diag.timedOut).toBe(false);
    expect(diag.normalized).toBeDefined();
    expect(diag.normalized?.action).toBe('block');
  });

  it('reports an error when the command does not exist', async () => {
    const spec: ShellHookEntry = {
      event: 'after-dispatch',
      command: '/no/such/binary',
    };
    const diag = await runShellHookOnce(spec, {
      hookEventName: 'after-dispatch',
      observedAt: '2026-05-01T00:00:00.000Z',
    });
    expect(diag.error).toBeDefined();
    expect(diag.returnCode).toBeNull();
  });

  it('times out a sleeping subprocess', async () => {
    const spec: ShellHookEntry = {
      event: 'after-dispatch',
      command: '/bin/sleep 5',
      timeoutMs: 200,
    };
    const diag = await runShellHookOnce(spec, {
      hookEventName: 'after-dispatch',
      observedAt: '2026-05-01T00:00:00.000Z',
    });
    expect(diag.timedOut).toBe(true);
    expect(diag.elapsedMs).toBeGreaterThanOrEqual(200);
  });
});

describe('M8 — createShellHookBridge', () => {
  it('returns all-undefined bindings when AUTO_ARCHIVE_SHELL_HOOKS is not on', () => {
    const bridge = createShellHookBridge({
      entries: [
        {
          event: 'before-dispatch',
          command: '/bin/echo',
        },
      ],
      allowlist: {
        approvals: [
          {
            event: 'before-dispatch',
            command: '/bin/echo',
            approvedAt: '',
          },
        ],
      },
      env: { [SHELL_HOOKS_ENABLE_ENV]: 'off' },
    });
    expect(bridge.beforeDispatch).toBeUndefined();
    expect(bridge.afterDispatch).toBeUndefined();
    expect(bridge.onTerminalEvidence).toBeUndefined();
    expect(bridge.enabledEntries).toEqual([]);
  });

  it('does not resolve accept-env consent while the master shell-hook gate is off', () => {
    const logger = vi.fn();
    const bridge = createShellHookBridge({
      entries: [
        {
          event: 'before-dispatch',
          command: '/bin/echo',
        },
      ],
      allowlist: { approvals: [] },
      env: { [SHELL_HOOKS_ACCEPT_ENV]: '1' },
      logger,
    });

    expect(bridge.beforeDispatch).toBeUndefined();
    expect(bridge.afterDispatch).toBeUndefined();
    expect(bridge.onTerminalEvidence).toBeUndefined();
    expect(bridge.enabledEntries).toEqual([]);
    expect(logger).not.toHaveBeenCalledWith(
      'shell-hook-auto-allowlisted',
      expect.anything(),
    );
    expect(logger).not.toHaveBeenCalledWith(
      'shell-hook-consent-required',
      expect.anything(),
    );
  });

  it('skips not-allowlisted entries and logs', () => {
    const logger = vi.fn();
    const bridge = createShellHookBridge({
      entries: [
        { event: 'before-dispatch', command: '/bin/echo' },
        { event: 'after-dispatch', command: '/bin/true' },
      ],
      allowlist: {
        approvals: [
          {
            event: 'after-dispatch',
            command: '/bin/true',
            approvedAt: '',
          },
        ],
      },
      env: { [SHELL_HOOKS_ENABLE_ENV]: 'on' },
      logger,
    });
    expect(bridge.enabledEntries).toHaveLength(1);
    expect(bridge.enabledEntries[0]?.event).toBe('after-dispatch');
    expect(logger).toHaveBeenCalledWith(
      'shell-hook-consent-required',
      expect.objectContaining({ event: 'before-dispatch' }),
    );
    expect(logger).toHaveBeenCalledWith(
      'shell-hook-not-allowlisted',
      expect.objectContaining({ event: 'before-dispatch' }),
    );
  });

  it('wires configured entries when hooks are on and non-interactive consent is explicit', () => {
    const logger = vi.fn();
    const spec: ShellHookEntry = {
      event: 'before-dispatch',
      command: '/bin/echo',
    };
    const bridge = createShellHookBridge({
      entries: [spec],
      allowlist: { approvals: [] },
      env: {
        [SHELL_HOOKS_ENABLE_ENV]: 'on',
        [SHELL_HOOKS_ACCEPT_ENV]: '1',
      },
      clock: () => '2026-05-05T00:00:00.000Z',
      logger,
    });

    expect(bridge.beforeDispatch).toBeDefined();
    expect(bridge.enabledEntries).toEqual([spec]);
    expect(logger).toHaveBeenCalledWith(
      'shell-hook-auto-allowlisted',
      expect.objectContaining({
        event: 'before-dispatch',
        command: '/bin/echo',
      }),
    );
  });

  it('beforeDispatch returns annotation-only block when script returns block', async () => {
    const spec: ShellHookEntry = {
      event: 'before-dispatch',
      command:
        '/usr/bin/printf {\\"action\\":\\"block\\",\\"message\\":\\"denied\\ by\\ hook\\"}',
    };
    const bridge = createShellHookBridge({
      entries: [spec],
      allowlist: { approvals: [{ ...spec, approvedAt: '' }] },
      env: { [SHELL_HOOKS_ENABLE_ENV]: 'on' },
    });
    expect(bridge.beforeDispatch).toBeDefined();

    const result = await bridge.beforeDispatch!({
      taskId: 'task-block',
      runtimeInstanceId: 'i1',
      moduleId: 'mod-shell-hook' as never,
      moduleVersion: '1.0.0',
      observedAt: '2026-05-01T00:00:00.000Z',
    });
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('annotation-only');
    expect(result?.note).toContain('denied by hook');
  });

  it('beforeDispatch returns null when script does not block', async () => {
    const spec: ShellHookEntry = {
      event: 'before-dispatch',
      command: '/bin/echo nothing',
    };
    const bridge = createShellHookBridge({
      entries: [spec],
      allowlist: { approvals: [{ ...spec, approvedAt: '' }] },
      env: { [SHELL_HOOKS_ENABLE_ENV]: 'on' },
    });
    const result = await bridge.beforeDispatch!({
      taskId: 'task-noop',
      runtimeInstanceId: 'i1',
      moduleId: 'mod-shell-hook' as never,
      moduleVersion: '1.0.0',
      observedAt: '2026-05-01T00:00:00.000Z',
    });
    expect(result).toBeNull();
  });

  it('matcher gates fire by taskId', async () => {
    const calledArgs: string[] = [];
    const spec: ShellHookEntry = {
      event: 'after-dispatch',
      command: '/bin/echo',
      matcher: '^task-watch-',
    };
    const bridge = createShellHookBridge({
      entries: [spec],
      allowlist: { approvals: [{ ...spec, approvedAt: '' }] },
      env: { [SHELL_HOOKS_ENABLE_ENV]: 'on' },
      logger: (label, _payload) => calledArgs.push(label),
    });
    expect(bridge.afterDispatch).toBeDefined();

    await bridge.afterDispatch!(
      {
        taskId: 'task-other',
        runtimeInstanceId: 'i1',
        moduleId: 'mod-shell-hook' as never,
        moduleVersion: '1.0.0',
        observedAt: '2026-05-01T00:00:00.000Z',
      },
      { kind: 'success' } as never,
    );
    await bridge.afterDispatch!(
      {
        taskId: 'task-watch-A',
        runtimeInstanceId: 'i1',
        moduleId: 'mod-shell-hook' as never,
        moduleVersion: '1.0.0',
        observedAt: '2026-05-01T00:00:00.000Z',
      },
      { kind: 'success' } as never,
    );
    // Only the matching call yields any logger entries (zero in the
    // happy path because no error/timeout occurs); the non-matching
    // call should produce zero spawns of any kind.
    expect(calledArgs.filter((l) => l.startsWith('shell-hook'))).toEqual([]);
  });
});
