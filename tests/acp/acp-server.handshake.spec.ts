/**
 * M10 Stage 1 — ACP handshake spec.
 *
 * Drives an in-process ACP `ClientSideConnection` against our
 * `AcpServer` over a pair of `PassThrough` streams (no child process,
 * no real IDE). Verifies:
 *
 *   - initialize returns PROTOCOL_VERSION + agentInfo + loadSession=false
 *   - authenticate is a no-op success
 *   - newSession allocates a unique session, records cwd, fires the
 *     'session-created' lifecycle event
 *   - prompt and cancel return JSON-RPC method-not-found at Stage 1
 *   - notifyConnectionClosed emits one 'session-closed' event per
 *     active session
 *
 * This is the *only* automated test surface for Stage 1 — it locks the
 * wire contract. Stage 2+ specs build on this fixture.
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

import type { AcpSessionLifecycleEvent } from '../../src/contracts/acp-session.js';
import { AcpServer } from '../../src/acp/acp-server.js';

interface Wired {
  readonly client: Agent;
  readonly server: AcpServer;
  readonly events: AcpSessionLifecycleEvent[];
  readonly close: () => Promise<void>;
}

/**
 * Wires both ends of the ACP wire onto a shared `PassThrough` pair.
 * The agent reads from `agentIn`, writes to `agentOut`; the client
 * reads from `clientIn` (=agentOut) and writes to `clientOut`
 * (=agentIn). Web-stream conversion lets us reuse `ndJsonStream`.
 */
function wirePair(
  options: {
    readonly newSessionId?: () => string;
    readonly now?: () => string;
    readonly idCounter?: { value: number };
  } = {},
): Wired {
  const agentIn = new PassThrough();
  const agentOut = new PassThrough();

  const events: AcpSessionLifecycleEvent[] = [];

  const idCounter = options.idCounter ?? { value: 0 };
  const newSessionId =
    options.newSessionId ?? (() => `sess-${(++idCounter.value).toString().padStart(4, '0')}`);
  const now =
    options.now ?? (() => new Date(1_700_000_000_000).toISOString());

  let serverInstance: AcpServer | undefined;
  const agentStream = ndJsonStream(
    nodeWritableToWeb(agentOut),
    nodeReadableToWeb(agentIn),
  );
  new AgentSideConnection((conn) => {
    const inst = new AcpServer(conn, {
      now,
      newSessionId,
      onLifecycle: (event) => {
        events.push(event);
      },
    });
    serverInstance = inst;
    return inst;
  }, agentStream);

  const clientStream = ndJsonStream(
    nodeWritableToWeb(agentIn),
    nodeReadableToWeb(agentOut),
  );
  const clientConn = new ClientSideConnection(
    () => new SilentClient(),
    clientStream,
  );

  return {
    client: clientConn,
    get server(): AcpServer {
      if (!serverInstance) {
        throw new Error('agent side connection did not yet construct AcpServer');
      }
      return serverInstance;
    },
    events,
    close: async () => {
      agentIn.end();
      agentOut.end();
      // Allow the SDK time to settle the close promises.
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

class SilentClient implements Client {
  async requestPermission(
    _params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    // Stage 1 should never hit this — fail loudly if it does.
    throw new Error('client.requestPermission called unexpectedly in Stage 1 spec');
  }
  async sessionUpdate(_params: SessionNotification): Promise<void> {
    // No-op: Stage 1 does not stream session updates.
  }
  async readTextFile(_params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('client.readTextFile called unexpectedly in Stage 1 spec');
  }
  async writeTextFile(_params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('client.writeTextFile called unexpectedly in Stage 1 spec');
  }
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
          // Already closed — safe to ignore.
        }
      });
      stream.on('error', (err) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    },
  });
}

describe('AcpServer Stage 1 handshake', () => {
  it('initialize returns PROTOCOL_VERSION + agentInfo + loadSession=false', async () => {
    const { client, close } = wirePair();
    try {
      const response = await client.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(response.agentInfo?.name).toBe('auto-archive-acp');
      expect(response.agentCapabilities?.loadSession).toBe(false);
      expect(response.authMethods).toEqual([]);
    } finally {
      await close();
    }
  });

  it('authenticate is a no-op success', async () => {
    const { client, close } = wirePair();
    try {
      const result = await client.authenticate({ methodId: 'unused' });
      expect(result).toBeDefined();
    } finally {
      await close();
    }
  });

  it('newSession allocates a unique session and fires session-created', async () => {
    const { client, server, events, close } = wirePair();
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      const a = await client.newSession({ cwd: '/tmp/a', mcpServers: [] });
      const b = await client.newSession({ cwd: '/tmp/b', mcpServers: [] });
      expect(a.sessionId).not.toBe(b.sessionId);

      const sessions = server.snapshotSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.cwd).sort()).toEqual(['/tmp/a', '/tmp/b']);
      expect(sessions.every((s) => s.phase === 'idle')).toBe(true);

      const created = events.filter((e) => e.kind === 'session-created');
      expect(created).toHaveLength(2);
      expect(created.map((e) => e.cwd).sort()).toEqual(['/tmp/a', '/tmp/b']);
    } finally {
      await close();
    }
  });

  it('prompt returns JSON-RPC method-not-found at Stage 1', async () => {
    const { client, close } = wirePair();
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      const session = await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
      await expect(
        client.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'hello' }],
        }),
      ).rejects.toMatchObject({ code: -32601 });
    } finally {
      await close();
    }
  });

  it('cancel for an unknown session is a no-op (notification semantics)', async () => {
    // ACP `cancel` is a JSON-RPC notification, not a request. The SDK
    // does not surface notification errors to the caller, so the server
    // MUST NOT throw on legitimate redundant cancels (e.g. unknown
    // session id, or session with no in-flight turn). Stage 2 wiring
    // formalizes this; Stage 1 verifies the no-op behavior at the
    // server method level.
    const { server, close } = wirePair();
    try {
      await expect(
        server.cancel({ sessionId: 'never-existed' }),
      ).resolves.toBeUndefined();
    } finally {
      await close();
    }
  });

  it('notifyConnectionClosed emits one session-closed per active session', async () => {
    const { client, server, events, close } = wirePair();
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      await client.newSession({ cwd: '/tmp/p', mcpServers: [] });
      await client.newSession({ cwd: '/tmp/q', mcpServers: [] });
      events.length = 0; // discard the session-created events for clarity
      server.notifyConnectionClosed('eof');
      const closed = events.filter((e) => e.kind === 'session-closed');
      expect(closed).toHaveLength(2);
      expect(closed.every((e) => e.kind === 'session-closed' && e.reason === 'eof')).toBe(true);
      expect(server.snapshotSessions().every((s) => s.phase === 'closed')).toBe(true);
    } finally {
      await close();
    }
  });
});
