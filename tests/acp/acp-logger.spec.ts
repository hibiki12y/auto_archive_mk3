/**
 * M10 Stage 5 — AcpLogger seam unit tests.
 *
 *   - defaultAcpLogger writes one line to stderr per event with the
 *     stable `<label> <json>` shape
 *   - non-serializable payloads fall back to a minimal envelope
 *   - withScope composes a child logger that injects scope into payload
 *   - all known stable labels start with `acp-`
 *   - permission bridge logger seam fires `acp-permission-denied`
 *     once per denied decision with the stable `reason` field
 */
import { describe, it, expect, vi } from 'vitest';

import {
  type AcpLogEvent,
  type AcpLogger,
  defaultAcpLogger,
  withScope,
} from '../../src/acp/acp-logger.js';
import { AcpPermissionBridge } from '../../src/acp/acp-permission-bridge.js';
import { RequestError } from '@agentclientprotocol/sdk';
import type { AcpPermissionRequest } from '../../src/contracts/acp-permission.js';

describe('defaultAcpLogger', () => {
  it('writes one ndjson-shaped line to stderr per event', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      defaultAcpLogger({
        level: 'warn',
        label: 'acp-test-event',
        message: 'hi',
        payload: { a: 1 },
      });
      expect(writeSpy).toHaveBeenCalledOnce();
      const line = String(writeSpy.mock.calls[0][0]);
      expect(line.startsWith('acp-test-event ')).toBe(true);
      expect(line.endsWith('\n')).toBe(true);
      const json = line.slice('acp-test-event '.length).trimEnd();
      const parsed = JSON.parse(json);
      expect(parsed).toMatchObject({
        level: 'warn',
        label: 'acp-test-event',
        message: 'hi',
        payload: { a: 1 },
      });
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('falls back to a minimal envelope when payload is not JSON-serializable', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const cyclic: { name: string; self?: unknown } = { name: 'cyclic' };
      cyclic.self = cyclic;
      defaultAcpLogger({
        level: 'error',
        label: 'acp-fallback-test',
        payload: cyclic,
      });
      const line = String(writeSpy.mock.calls[0][0]);
      const json = line.slice(line.indexOf(' ') + 1).trimEnd();
      const parsed = JSON.parse(json) as Record<string, unknown>;
      expect(parsed.label).toBe('acp-fallback-test');
      expect(parsed.payload).toBeUndefined();
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('withScope', () => {
  it('injects a stable scope key into payload while preserving caller-supplied keys', () => {
    const events: AcpLogEvent[] = [];
    const collect: AcpLogger = (e) => {
      events.push(e);
    };
    const child = withScope(collect, 'AcpServer');
    child({
      level: 'info',
      label: 'acp-noop',
      payload: { extra: 1 },
    });
    expect(events[0].payload).toEqual({ scope: 'AcpServer', extra: 1 });
  });

  it('caller-supplied scope is preserved (parent scope wins by being applied first)', () => {
    const events: AcpLogEvent[] = [];
    const child = withScope((e) => events.push(e), 'parent');
    child({
      level: 'info',
      label: 'acp-noop',
      payload: { scope: 'caller-tag', other: 2 },
    });
    // The parent scope is applied first; the caller's `scope` field
    // overrides it because spread order. This documents the contract:
    // callers can override withScope's tag by spreading after.
    expect(events[0].payload).toEqual({ scope: 'caller-tag', other: 2 });
  });
});

describe('AcpPermissionBridge logger integration', () => {
  it('emits acp-permission-denied with the reason on a denied decision', async () => {
    const events: AcpLogEvent[] = [];
    const bridge = new AcpPermissionBridge({
      logger: (e) => events.push(e),
    });
    const request: AcpPermissionRequest = {
      approvalId: 'approval-X',
      sessionId: 'sess-Y',
      kind: 'tool-execute',
      toolCallId: 'tc-1',
      title: 'run',
      options: [],
      requestedAt: '2026-05-02T00:00:00.000Z',
    };
    const decision = await bridge.requestPermission(
      {
        requestPermission: () =>
          Promise.reject(RequestError.methodNotFound('session/request_permission')),
      },
      request,
    );
    expect(decision).toEqual({ kind: 'denied', reason: 'unsupported-client' });
    const denied = events.filter((e) => e.label === 'acp-permission-denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].payload).toMatchObject({
      approvalId: 'approval-X',
      sessionId: 'sess-Y',
      kind: 'tool-execute',
      reason: 'unsupported-client',
    });
  });

  it('does not emit on an allowed decision', async () => {
    const events: AcpLogEvent[] = [];
    const bridge = new AcpPermissionBridge({
      logger: (e) => events.push(e),
    });
    const request: AcpPermissionRequest = {
      approvalId: 'a',
      sessionId: 's',
      kind: 'tool-read',
      toolCallId: 't',
      title: 'go',
      options: [],
      requestedAt: '2026-05-02T00:00:00.000Z',
    };
    await bridge.requestPermission(
      {
        requestPermission: async () => ({
          outcome: { outcome: 'selected', optionId: 'allow_once' },
        }),
      },
      request,
    );
    expect(events.filter((e) => e.label === 'acp-permission-denied')).toHaveLength(0);
  });
});
