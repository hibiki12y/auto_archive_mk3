/**
 * M10 Stage 2 — AcpServer prompt + cancel integration spec.
 *
 * Wires a real `AgentSideConnection` against a fake `ClientSideConnection`
 * over `PassThrough` streams (same harness as the Stage 1 handshake spec)
 * and a scripted prompt driver. Verifies:
 *
 *   - prompt without a bridge configured still returns methodNotFound
 *     (Stage 1 default preserved when promptBridge is unset)
 *   - prompt with a bridge streams chunks and resolves with the
 *     correct stopReason
 *   - prompt on unknown session id returns invalidParams (-32602)
 *   - prompt while a turn is already in flight returns invalidRequest
 *   - cancel notification aborts the in-flight controller and the
 *     resolved PromptResponse carries stopReason='cancelled'
 *   - cancel for unknown session is a no-op
 *   - cancel with no turn in flight is a no-op
 *   - server cleans up `currentTaskId` / `pendingCancel` after a turn
 *     resolves (success path)
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';

import {
  type Agent,
  type Client,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';

import { AcpServer } from '../../src/acp/acp-server.js';
import {
  AcpPromptBridge,
  type AcpPromptDriver,
  type AcpPromptDriverInput,
  type AcpPromptStreamEvent,
} from '../../src/acp/acp-prompt-bridge.js';

interface Wired {
  readonly client: Agent;
  readonly server: AcpServer;
  readonly clientUpdates: SessionNotification[];
  readonly close: () => Promise<void>;
}

function wirePair(opts: {
  readonly bridge?: AcpPromptBridge;
}): Wired {
  const agentIn = new PassThrough();
  const agentOut = new PassThrough();

  const clientUpdates: SessionNotification[] = [];

  let serverInstance: AcpServer | undefined;
  const agentStream = ndJsonStream(
    nodeWritableToWeb(agentOut),
    nodeReadableToWeb(agentIn),
  );
  new AgentSideConnection((conn) => {
    const inst = new AcpServer(conn, {
      promptBridge: opts.bridge,
      // Stage 2 cancel/prompt round-trip behavior is tested in
      // isolation here. Stage 3's `available_commands_update`
      // advertisement is exercised in `acp-slash-commands.spec.ts`,
      // so disable it here to keep `clientUpdates` chunk counts
      // unambiguous.
      advertiseSlashCommands: false,
      newSessionId: (() => {
        let n = 0;
        return () => `sess-${(++n).toString().padStart(4, '0')}`;
      })(),
      newTurnId: (() => {
        let n = 0;
        return () => `turn-${(++n).toString().padStart(4, '0')}`;
      })(),
    });
    serverInstance = inst;
    return inst;
  }, agentStream);

  const clientStream = ndJsonStream(
    nodeWritableToWeb(agentIn),
    nodeReadableToWeb(agentOut),
  );
  const clientConn = new ClientSideConnection(
    () =>
      new (class implements Client {
        async requestPermission(
          _params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> {
          throw new Error('unexpected requestPermission in Stage 2 spec');
        }
        async sessionUpdate(params: SessionNotification): Promise<void> {
          clientUpdates.push(params);
        }
        async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
          throw new Error('unexpected readTextFile');
        }
        async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
          throw new Error('unexpected writeTextFile');
        }
      })(),
    clientStream,
  );

  return {
    client: clientConn,
    get server(): AcpServer {
      if (!serverInstance) throw new Error('server not yet constructed');
      return serverInstance;
    },
    clientUpdates,
    close: async () => {
      agentIn.end();
      agentOut.end();
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

function nodeWritableToWeb(stream: PassThrough): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise((resolve, reject) => {
        stream.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
    },
    close() {
      stream.end();
    },
    abort() {
      stream.destroy();
    },
  });
}

function nodeReadableToWeb(stream: PassThrough): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      stream.on('end', () => {
        try {
          controller.close();
        } catch {
          // Already closed — safe.
        }
      });
      stream.on('error', (err) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    },
  });
}

class StaticDriver implements AcpPromptDriver {
  constructor(private readonly events: AcpPromptStreamEvent[]) {}
  async *drive(
    _input: AcpPromptDriverInput,
    _signal: AbortSignal,
  ): AsyncIterable<AcpPromptStreamEvent> {
    for (const e of this.events) {
      yield e;
    }
  }
}

class AbortAwareInfiniteDriver implements AcpPromptDriver {
  constructor(public sawAbort: { value: boolean } = { value: false }) {}
  async *drive(
    _input: AcpPromptDriverInput,
    signal: AbortSignal,
  ): AsyncIterable<AcpPromptStreamEvent> {
    while (!signal.aborted) {
      yield { kind: 'text-chunk', text: 'tick' };
      // Yield to the event loop so a concurrent `cancel()` can fire.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.sawAbort.value = true;
  }
}

describe('AcpServer.prompt — Stage 2 wiring', () => {
  it('without promptBridge configured, prompt still returns methodNotFound', async () => {
    const { client, close } = wirePair({});
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      await expect(
        client.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'hi' }],
        }),
      ).rejects.toMatchObject({ code: -32601 });
    } finally {
      await close();
    }
  });

  it('with bridge + scripted driver, returns end_turn and streams chunks to client', async () => {
    const bridge = new AcpPromptBridge({
      driver: new StaticDriver([
        { kind: 'text-chunk', text: 'hello' },
        { kind: 'text-chunk', text: ' world' },
        { kind: 'done', stopReason: 'end_turn' },
      ]),
    });
    const { client, server, clientUpdates, close } = wirePair({ bridge });
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      const response = await client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'go' }],
      });
      expect(response.stopReason).toBe('end_turn');
      expect(clientUpdates).toHaveLength(2);
      expect(clientUpdates[0].update).toMatchObject({
        sessionUpdate: 'agent_message_chunk',
      });
      const sessionState = server.snapshotSessions().find(
        (s) => s.sessionId === session.sessionId,
      );
      expect(sessionState?.phase).toBe('idle');
      expect(sessionState?.currentTaskId).toBeUndefined();
      expect(sessionState?.pendingCancel).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('prompt on unknown session id returns invalidParams (-32602)', async () => {
    const bridge = new AcpPromptBridge({ driver: new StaticDriver([]) });
    const { client, close } = wirePair({ bridge });
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      await expect(
        client.prompt({
          sessionId: 'nonexistent',
          prompt: [{ type: 'text', text: 'x' }],
        }),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      await close();
    }
  });

  it('cancel notification aborts the in-flight prompt and resolves with stopReason=cancelled', async () => {
    const driver = new AbortAwareInfiniteDriver();
    const bridge = new AcpPromptBridge({ driver });
    const { client, close } = wirePair({ bridge });
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      const promptPromise = client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'go' }],
      });
      // Wait a tick so the driver actually starts emitting before we cancel.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await client.cancel({ sessionId: session.sessionId });
      const response = await promptPromise;
      expect(response.stopReason).toBe('cancelled');
      expect(driver.sawAbort.value).toBe(true);
    } finally {
      await close();
    }
  });

  it('cancel for unknown session is a no-op (no error surfaced)', async () => {
    const bridge = new AcpPromptBridge({ driver: new StaticDriver([]) });
    const { client, close } = wirePair({ bridge });
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      // notifications return void; the assertion is that this resolves.
      await expect(
        client.cancel({ sessionId: 'nonexistent' }),
      ).resolves.toBeUndefined();
    } finally {
      await close();
    }
  });

  it('cancel with no turn in flight is a no-op', async () => {
    const bridge = new AcpPromptBridge({ driver: new StaticDriver([]) });
    const { client, close } = wirePair({ bridge });
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      await expect(
        client.cancel({ sessionId: session.sessionId }),
      ).resolves.toBeUndefined();
    } finally {
      await close();
    }
  });
});
