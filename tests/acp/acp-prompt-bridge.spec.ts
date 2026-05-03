/**
 * M10 Stage 2 — Prompt bridge unit tests.
 *
 * Drives `AcpPromptBridge` directly with a fake driver and a recording
 * `AgentSideConnection`-shaped double. No SDK plumbing — these tests
 * lock the bridge's translation contract from `AcpPromptStreamEvent`
 * to `sessionUpdate` calls and the `PromptResponse.stopReason`
 * resolution rules.
 */
import { describe, it, expect, vi } from 'vitest';

import type {
  AgentSideConnection,
  PromptResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';

import {
  AcpPromptBridge,
  type AcpPromptDriver,
  type AcpPromptDriverInput,
  type AcpPromptStreamEvent,
} from '../../src/acp/acp-prompt-bridge.js';

interface RecordedConnection {
  readonly mock: AgentSideConnection;
  readonly updates: SessionNotification[];
}

function recordConnection(): RecordedConnection {
  const updates: SessionNotification[] = [];
  const mock = {
    sessionUpdate: vi.fn(async (params: SessionNotification) => {
      updates.push(params);
    }),
  } as unknown as AgentSideConnection;
  return { mock, updates };
}

function fixedInput(over: Partial<AcpPromptDriverInput> = {}): AcpPromptDriverInput {
  return {
    sessionId: over.sessionId ?? 'sess-test',
    cwd: over.cwd ?? '/tmp',
    additionalDirectories: over.additionalDirectories ?? [],
    content: over.content ?? [{ type: 'text', text: 'hi' }],
  };
}

class ScriptedDriver implements AcpPromptDriver {
  constructor(private readonly events: AcpPromptStreamEvent[]) {}

  async *drive(
    _input: AcpPromptDriverInput,
    _signal: AbortSignal,
  ): AsyncIterable<AcpPromptStreamEvent> {
    for (const event of this.events) {
      yield event;
    }
  }
}

class AbortAwareDriver implements AcpPromptDriver {
  constructor(
    private readonly events: AcpPromptStreamEvent[],
    private readonly abortAfter: number,
    private readonly controller: AbortController,
  ) {}

  async *drive(
    _input: AcpPromptDriverInput,
    signal: AbortSignal,
  ): AsyncIterable<AcpPromptStreamEvent> {
    let count = 0;
    for (const event of this.events) {
      if (signal.aborted) {
        return;
      }
      yield event;
      count++;
      if (count === this.abortAfter) {
        this.controller.abort();
      }
    }
  }
}

class ThrowingDriver implements AcpPromptDriver {
   
  async *drive(
    _input: AcpPromptDriverInput,
    _signal: AbortSignal,
  ): AsyncIterable<AcpPromptStreamEvent> {
    yield { kind: 'text-chunk', text: 'partial' };
    throw new Error('driver-explode');
  }
}

describe('AcpPromptBridge.run', () => {
  it('empty driver stream resolves to stopReason="end_turn"', async () => {
    const { mock, updates } = recordConnection();
    const bridge = new AcpPromptBridge({
      driver: new ScriptedDriver([]),
    });
    const ctl = new AbortController();
    const response: PromptResponse = await bridge.run(mock, fixedInput(), ctl.signal);
    expect(response.stopReason).toBe('end_turn');
    expect(updates).toHaveLength(0);
  });

  it('text chunks emerge in order as agent_message_chunk', async () => {
    const { mock, updates } = recordConnection();
    const bridge = new AcpPromptBridge({
      driver: new ScriptedDriver([
        { kind: 'text-chunk', text: 'hello ' },
        { kind: 'text-chunk', text: 'world' },
        { kind: 'done', stopReason: 'end_turn' },
      ]),
    });
    const ctl = new AbortController();
    const response = await bridge.run(mock, fixedInput(), ctl.signal);
    expect(response.stopReason).toBe('end_turn');
    expect(updates).toHaveLength(2);
    expect(updates[0].update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello ' },
    });
    expect(updates[1].update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'world' },
    });
  });

  it('thought-chunk emerges as agent_thought_chunk', async () => {
    const { mock, updates } = recordConnection();
    const bridge = new AcpPromptBridge({
      driver: new ScriptedDriver([
        { kind: 'thought-chunk', text: 'reasoning...' },
        { kind: 'done', stopReason: 'end_turn' },
      ]),
    });
    await bridge.run(mock, fixedInput(), new AbortController().signal);
    expect(updates[0].update).toMatchObject({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'reasoning...' },
    });
  });

  it('tool-call-started + tool-call-update emerge as the matching sessionUpdate kinds', async () => {
    const { mock, updates } = recordConnection();
    const bridge = new AcpPromptBridge({
      driver: new ScriptedDriver([
        {
          kind: 'tool-call-started',
          toolCallId: 'call-1',
          title: 'Reading file',
          toolKind: 'read',
        },
        {
          kind: 'tool-call-update',
          toolCallId: 'call-1',
          status: 'in_progress',
        },
        {
          kind: 'tool-call-update',
          toolCallId: 'call-1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
        },
        { kind: 'done', stopReason: 'end_turn' },
      ]),
    });
    await bridge.run(mock, fixedInput(), new AbortController().signal);
    expect(updates).toHaveLength(3);
    expect(updates[0].update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'Reading file',
      status: 'pending',
      kind: 'read',
    });
    expect(updates[1].update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'in_progress',
    });
    expect(updates[2].update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
    });
  });

  it('pre-aborted signal returns "cancelled" without iterating the driver', async () => {
    const { mock, updates } = recordConnection();
    const driver = new ScriptedDriver([
      { kind: 'text-chunk', text: 'should-not-emit' },
      { kind: 'done', stopReason: 'end_turn' },
    ]);
    const driveSpy = vi.spyOn(driver, 'drive');
    const bridge = new AcpPromptBridge({ driver });
    const ctl = new AbortController();
    ctl.abort();
    const response = await bridge.run(mock, fixedInput(), ctl.signal);
    expect(response.stopReason).toBe('cancelled');
    expect(updates).toHaveLength(0);
    expect(driveSpy).not.toHaveBeenCalled();
  });

  it('mid-stream abort returns "cancelled" and stops emitting further updates', async () => {
    const { mock, updates } = recordConnection();
    const ctl = new AbortController();
    const bridge = new AcpPromptBridge({
      driver: new AbortAwareDriver(
        [
          { kind: 'text-chunk', text: 'one' },
          { kind: 'text-chunk', text: 'two' },
          { kind: 'text-chunk', text: 'three-should-not-emit' },
          { kind: 'done', stopReason: 'end_turn' },
        ],
        2, // abort after the second event yields
        ctl,
      ),
    });
    const response = await bridge.run(mock, fixedInput(), ctl.signal);
    expect(response.stopReason).toBe('cancelled');
    // The abort fires AFTER the 2nd yield; the bridge will have already
    // sent the corresponding sessionUpdate. The 3rd should be suppressed.
    expect(updates.length).toBeLessThanOrEqual(2);
    expect(
      updates.some((u) => 'content' in u.update && JSON.stringify(u.update).includes('three')),
    ).toBe(false);
  });

  it('done event with explicit stopReason is preserved', async () => {
    const { mock } = recordConnection();
    const bridge = new AcpPromptBridge({
      driver: new ScriptedDriver([
        { kind: 'text-chunk', text: 'partial' },
        { kind: 'done', stopReason: 'max_tokens' },
      ]),
    });
    const response = await bridge.run(mock, fixedInput(), new AbortController().signal);
    expect(response.stopReason).toBe('max_tokens');
  });

  it('driver error propagates to caller (no stopReason translation)', async () => {
    const { mock, updates } = recordConnection();
    const bridge = new AcpPromptBridge({ driver: new ThrowingDriver() });
    await expect(
      bridge.run(mock, fixedInput(), new AbortController().signal),
    ).rejects.toThrow(/driver-explode/);
    // The pre-throw text chunk should have already been sent.
    expect(updates).toHaveLength(1);
  });

  it('sessionUpdate calls are awaited in order (backpressure preserved)', async () => {
    const order: number[] = [];
    let resolveFirst!: () => void;
    const firstAck = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const mock = {
      sessionUpdate: vi.fn(async (_params: SessionNotification) => {
        const seq = order.length + 1;
        order.push(seq);
        if (seq === 1) {
          await firstAck;
        }
      }),
    } as unknown as AgentSideConnection;

    const bridge = new AcpPromptBridge({
      driver: new ScriptedDriver([
        { kind: 'text-chunk', text: 'first' },
        { kind: 'text-chunk', text: 'second' },
        { kind: 'done', stopReason: 'end_turn' },
      ]),
    });

    const runPromise = bridge.run(mock, fixedInput(), new AbortController().signal);
    // Allow the for-await loop to start and call sessionUpdate once.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual([1]);
    // Releasing the first ack lets the second call be made.
    resolveFirst();
    const result = await runPromise;
    expect(result.stopReason).toBe('end_turn');
    expect(order).toEqual([1, 2]);
  });
});
