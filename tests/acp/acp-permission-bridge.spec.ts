/**
 * ACP permission bridge hardening tests.
 *
 * These tests lock the OpenClaw parity decision that execution
 * approvals are single-use only: ACP `allow_always` is not advertised
 * by default and any caller-provided persistent allow choice fails
 * closed with a stable denial reason.
 */
import { RequestError } from '@agentclientprotocol/sdk';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import type { AcpLogEvent } from '../../src/acp/acp-logger.js';
import {
  AcpPermissionBridge,
  type AcpPermissionBridgeOptions,
  DEFAULT_PERMISSION_OPTIONS,
} from '../../src/acp/acp-permission-bridge.js';
import type {
  AcpPermissionDeniedReason,
  AcpPermissionOption,
  AcpPermissionRequest,
} from '../../src/contracts/acp-permission.js';

type PermissionConnection = Parameters<AcpPermissionBridge['requestPermission']>[0];

function baseRequest(
  overrides: Partial<AcpPermissionRequest> = {},
): AcpPermissionRequest {
  return {
    approvalId: 'approval-1',
    sessionId: 'session-1',
    kind: 'tool-execute',
    toolCallId: 'tool-call-1',
    title: 'Run shell command',
    description: 'echo hello',
    options: [],
    requestedAt: '2026-05-05T00:00:00.000Z',
    ...overrides,
  };
}

function bridgeWithEvents(options: {
  readonly timeoutMs?: number;
  readonly schedule?: AcpPermissionBridgeOptions['schedule'];
} = {}): {
  readonly bridge: AcpPermissionBridge;
  readonly events: AcpLogEvent[];
} {
  const events: AcpLogEvent[] = [];
  const bridge = new AcpPermissionBridge({
    ...options,
    logger: (event) => events.push(event),
  });
  return { bridge, events };
}

function deniedEvents(events: readonly AcpLogEvent[]): readonly AcpLogEvent[] {
  return events.filter((event) => event.label === 'acp-permission-denied');
}

describe('AcpPermissionBridge', () => {
  it('does not advertise allow_always by default and maps the wire request', async () => {
    const { bridge, events } = bridgeWithEvents();
    let captured: RequestPermissionRequest | undefined;

    const decision = await bridge.requestPermission(
      {
        async requestPermission(
          request: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> {
          captured = request;
          return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
        },
      },
      baseRequest({ kind: 'shell-exec' }),
    );

    expect(decision).toEqual({ kind: 'allowed', optionId: 'allow_once' });
    expect(deniedEvents(events)).toHaveLength(0);
    expect(DEFAULT_PERMISSION_OPTIONS.map((option) => option.optionId)).toEqual([
      'allow_once',
      'reject_once',
      'reject_always',
    ]);
    expect(captured?.options).toEqual([
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
      { optionId: 'reject_always', name: 'Reject always', kind: 'reject_always' },
    ]);
    expect(captured?.toolCall).toMatchObject({
      toolCallId: 'tool-call-1',
      title: 'Run shell command',
      kind: 'execute',
      status: 'pending',
    });
  });

  it('fails closed when a caller-provided allow_always option is selected', async () => {
    const { bridge, events } = bridgeWithEvents();
    const customOptions: readonly AcpPermissionOption[] = [
      { optionId: 'allow_once', label: 'Allow once', intent: 'allow-once' },
      { optionId: 'allow_always', label: 'Allow always', intent: 'allow-always' },
      { optionId: 'reject_once', label: 'Reject once', intent: 'reject-once' },
    ];
    let captured: RequestPermissionRequest | undefined;

    const decision = await bridge.requestPermission(
      {
        async requestPermission(
          request: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> {
          captured = request;
          return { outcome: { outcome: 'selected', optionId: 'allow_always' } };
        },
      },
      baseRequest({ options: customOptions }),
    );

    expect(captured?.options.map((option) => option.kind)).toContain('allow_always');
    expect(decision).toEqual({
      kind: 'denied',
      reason: 'unsupported-allow-always',
    });
    expect(deniedEvents(events)).toHaveLength(1);
    expect(deniedEvents(events)[0].payload).toMatchObject({
      approvalId: 'approval-1',
      sessionId: 'session-1',
      kind: 'tool-execute',
      reason: 'unsupported-allow-always',
    });
  });

  it('does not reject a custom option list merely because allow_always is present', async () => {
    const { bridge, events } = bridgeWithEvents();
    const customOptions: readonly AcpPermissionOption[] = [
      { optionId: 'allow_once', label: 'Allow once', intent: 'allow-once' },
      { optionId: 'allow_always', label: 'Allow always', intent: 'allow-always' },
      { optionId: 'reject_once', label: 'Reject once', intent: 'reject-once' },
    ];

    const decision = await bridge.requestPermission(
      {
        async requestPermission(): Promise<RequestPermissionResponse> {
          return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
        },
      },
      baseRequest({ options: customOptions }),
    );

    expect(decision).toEqual({ kind: 'allowed', optionId: 'allow_once' });
    expect(deniedEvents(events)).toHaveLength(0);
  });

  it('maps reject, cancel, and malformed client responses to denied decisions', async () => {
    const cases: readonly {
      readonly name: string;
      readonly response: RequestPermissionResponse;
      readonly reason: AcpPermissionDeniedReason;
    }[] = [
      {
        name: 'reject_once',
        response: { outcome: { outcome: 'selected', optionId: 'reject_once' } },
        reason: 'user-rejected',
      },
      {
        name: 'reject_always',
        response: { outcome: { outcome: 'selected', optionId: 'reject_always' } },
        reason: 'user-rejected',
      },
      {
        name: 'cancelled',
        response: { outcome: { outcome: 'cancelled' } },
        reason: 'user-cancelled',
      },
      {
        name: 'unknown option id',
        response: { outcome: { outcome: 'selected', optionId: 'surprise' } },
        reason: 'client-rpc-error',
      },
    ];

    for (const testCase of cases) {
      const { bridge, events } = bridgeWithEvents();
      const decision = await bridge.requestPermission(
        {
          async requestPermission(): Promise<RequestPermissionResponse> {
            return testCase.response;
          },
        },
        baseRequest({ approvalId: `approval-${testCase.name}` }),
      );

      expect(decision).toEqual({ kind: 'denied', reason: testCase.reason });
      expect(deniedEvents(events)).toHaveLength(1);
      expect(deniedEvents(events)[0].payload).toMatchObject({
        approvalId: `approval-${testCase.name}`,
        reason: testCase.reason,
      });
    }
  });

  it('distinguishes unsupported clients from other RPC errors', async () => {
    const cases: readonly {
      readonly name: string;
      readonly connection: PermissionConnection;
      readonly reason: AcpPermissionDeniedReason;
      readonly payload: Readonly<Record<string, unknown>>;
    }[] = [
      {
        name: 'unsupported',
        connection: {
          async requestPermission(): Promise<RequestPermissionResponse> {
            throw RequestError.methodNotFound('session/request_permission');
          },
        },
        reason: 'unsupported-client',
        payload: {
          reason: 'unsupported-client',
          rpcMessage: '"Method not found": session/request_permission',
        },
      },
      {
        name: 'invalid-params',
        connection: {
          async requestPermission(): Promise<RequestPermissionResponse> {
            throw RequestError.invalidParams({ field: 'options' });
          },
        },
        reason: 'client-rpc-error',
        payload: {
          reason: 'client-rpc-error',
          rpcCode: -32602,
          rpcMessage: 'Invalid params',
        },
      },
      {
        name: 'plain-error',
        connection: {
          async requestPermission(): Promise<RequestPermissionResponse> {
            throw new Error('client exploded');
          },
        },
        reason: 'client-rpc-error',
        payload: {
          reason: 'client-rpc-error',
          rpcMessage: 'client exploded',
        },
      },
    ];

    for (const testCase of cases) {
      const { bridge, events } = bridgeWithEvents();
      const decision = await bridge.requestPermission(
        testCase.connection,
        baseRequest({ approvalId: `approval-${testCase.name}` }),
      );

      expect(decision).toEqual({ kind: 'denied', reason: testCase.reason });
      expect(deniedEvents(events)).toHaveLength(1);
      expect(deniedEvents(events)[0].payload).toMatchObject(testCase.payload);
    }
  });

  it('times out fail-closed and clears the scheduled timer', async () => {
    let timeoutCallback: (() => void) | undefined;
    let timeoutMs: number | undefined;
    const timerHandle = { id: 'timer-1' };
    const clearedHandles: unknown[] = [];
    const { bridge, events } = bridgeWithEvents({
      timeoutMs: 10,
      schedule: {
        setTimer: (callback, ms) => {
          timeoutCallback = callback;
          timeoutMs = ms;
          return timerHandle;
        },
        clearTimer: (handle) => {
          clearedHandles.push(handle);
        },
      },
    });

    const decisionPromise = bridge.requestPermission(
      {
        requestPermission: () => new Promise<RequestPermissionResponse>(() => {}),
      },
      baseRequest({ approvalId: 'approval-timeout' }),
    );

    expect(timeoutMs).toBe(1_000);
    timeoutCallback?.();
    await expect(decisionPromise).resolves.toEqual({
      kind: 'denied',
      reason: 'bridge-timeout',
    });
    expect(clearedHandles).toEqual([timerHandle]);
    expect(deniedEvents(events)).toHaveLength(1);
    expect(deniedEvents(events)[0].payload).toMatchObject({
      approvalId: 'approval-timeout',
      reason: 'bridge-timeout',
    });
  });
});
