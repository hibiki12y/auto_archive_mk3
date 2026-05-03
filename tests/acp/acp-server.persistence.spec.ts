/**
 * M10 Stage 4 — AcpServer persistence + load/resume/fork integration.
 *
 * Drives a real ACP wire pair against an `AcpServer` configured with
 * a `JsonAcpSessionStore` over a tmpdir. Verifies:
 *
 *   - initialize advertises agentCapabilities.loadSession=true and
 *     sessionCapabilities.fork/resume only when sessionStore is wired
 *   - newSession persists a record
 *   - load_session restores the session on a fresh server bound to
 *     the same store directory (cross-process simulation)
 *   - resume_session does the same (no history replay tested at the
 *     wire level — that's IDE-side responsibility)
 *   - fork_session allocates a new sessionId, copies parent state,
 *     persists, and fires the rotation hook with reason=fork
 *   - load/resume/fork on unknown sessionId → invalidParams
 *   - load/resume/fork without sessionStore → methodNotFound
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
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

import { AcpServer, type AcpSessionRotationEvent } from '../../src/acp/acp-server.js';
import { JsonAcpSessionStore } from '../../src/acp/acp-session-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acp-persist-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Wired {
  readonly client: ClientSideConnection;
  readonly server: AcpServer;
  readonly close: () => Promise<void>;
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
      stream.on('data', (chunk: Buffer) =>
        controller.enqueue(new Uint8Array(chunk)),
      );
      stream.on('end', () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      stream.on('error', (err) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    },
  });
}

function wirePair(opts: {
  readonly store?: JsonAcpSessionStore;
  readonly seedSessionId?: string;
  readonly onSessionRotation?: (e: AcpSessionRotationEvent) => void;
}): Wired {
  const agentIn = new PassThrough();
  const agentOut = new PassThrough();

  let serverInstance: AcpServer | undefined;
  const agentStream = ndJsonStream(
    nodeWritableToWeb(agentOut),
    nodeReadableToWeb(agentIn),
  );
  new AgentSideConnection(
    (conn) => {
      const counter = { value: 0 };
      const inst = new AcpServer(conn, {
        ...(opts.store === undefined ? {} : { sessionStore: opts.store }),
        ...(opts.onSessionRotation === undefined
          ? {}
          : { onSessionRotation: opts.onSessionRotation }),
        advertiseSlashCommands: false,
        newSessionId: () => {
          if (opts.seedSessionId !== undefined && counter.value === 0) {
            counter.value += 1;
            return opts.seedSessionId;
          }
          counter.value += 1;
          return `sid-${counter.value.toString().padStart(2, '0')}`;
        },
      });
      serverInstance = inst;
      return inst;
    },
    agentStream,
  );

  const clientStream = ndJsonStream(
    nodeWritableToWeb(agentIn),
    nodeReadableToWeb(agentOut),
  );
  const clientConn = new ClientSideConnection(
    () =>
      new (class implements Client {
        async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
          throw new Error('unexpected');
        }
        async sessionUpdate(_p: SessionNotification): Promise<void> {
          /* noop */
        }
        async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
          throw new Error('unexpected');
        }
        async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
          throw new Error('unexpected');
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
    close: async () => {
      agentIn.end();
      agentOut.end();
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

describe('AcpServer Stage 4 persistence', () => {
  it('initialize advertises loadSession=true + sessionCapabilities.fork/resume when store is wired', async () => {
    const store = new JsonAcpSessionStore({ directory: dir });
    const { client, close } = wirePair({ store });
    try {
      const init = await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      expect(init.agentCapabilities?.loadSession).toBe(true);
      expect(init.agentCapabilities?.sessionCapabilities?.fork).toEqual({});
      expect(init.agentCapabilities?.sessionCapabilities?.resume).toEqual({});
    } finally {
      await close();
    }
  });

  it('initialize without store reports loadSession=false', async () => {
    const { client, close } = wirePair({});
    try {
      const init = await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      expect(init.agentCapabilities?.loadSession).toBe(false);
      expect(init.agentCapabilities?.sessionCapabilities).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('newSession persists a JSON record at the configured directory', async () => {
    const store = new JsonAcpSessionStore({ directory: dir });
    const { client, close } = wirePair({ store, seedSessionId: 'persisted-1' });
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
      // Allow the server's async write to settle.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const fromDisk = await store.read('persisted-1');
      expect(fromDisk).toMatchObject({
        sessionId: 'persisted-1',
        cwd: '/tmp/x',
        schemaVersion: 1,
      });
    } finally {
      await close();
    }
  });

  it('load_session restores a record persisted by an earlier process', async () => {
    const store = new JsonAcpSessionStore({ directory: dir });
    // Pre-seed the store as if a prior process had written it.
    await store.write({
      schemaVersion: 1,
      sessionId: 'sid-from-prev',
      cwd: '/tmp/prev',
      additionalDirectories: ['/tmp/extra'],
      createdAt: '2026-05-01T00:00:00.000Z',
      lastTouchedAt: '2026-05-01T00:00:00.000Z',
    });
    const { client, server, close } = wirePair({ store });
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      const result = await client.loadSession({
        sessionId: 'sid-from-prev',
        cwd: '/tmp/prev',
        mcpServers: [],
      });
      expect(result).toBeDefined();
      const snap = server
        .snapshotSessions()
        .find((s) => s.sessionId === 'sid-from-prev');
      expect(snap).toBeDefined();
      expect(snap?.cwd).toBe('/tmp/prev');
      expect(snap?.additionalDirectories).toEqual(['/tmp/extra']);
      expect(snap?.phase).toBe('idle');
    } finally {
      await close();
    }
  });

  it('resume_session has the same restoration semantics as load_session', async () => {
    const store = new JsonAcpSessionStore({ directory: dir });
    await store.write({
      schemaVersion: 1,
      sessionId: 'sid-resume',
      cwd: '/tmp/r',
      additionalDirectories: [],
      createdAt: '2026-05-01T00:00:00.000Z',
      lastTouchedAt: '2026-05-01T00:00:00.000Z',
    });
    const { client, server, close } = wirePair({ store });
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      await client.resumeSession({
        sessionId: 'sid-resume',
        cwd: '/tmp/r',
        mcpServers: [],
      });
      const snap = server
        .snapshotSessions()
        .find((s) => s.sessionId === 'sid-resume');
      expect(snap?.phase).toBe('idle');
    } finally {
      await close();
    }
  });

  it('fork_session allocates a new sessionId, copies parent state, fires rotation hook', async () => {
    const store = new JsonAcpSessionStore({ directory: dir });
    const rotations: AcpSessionRotationEvent[] = [];
    const { client, server, close } = wirePair({
      store,
      onSessionRotation: (e) => {
        rotations.push(e);
      },
    });
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      const parent = await client.newSession({
        cwd: '/tmp/parent',
        mcpServers: [],
      });
      // The SDK does not currently expose `unstable_forkSession` on the
      // ClientSideConnection helper alias as `forkSession`; we drive
      // the SDK's `unstable_forkSession` via its method directly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const forked = await (client as any).unstable_forkSession({
        sessionId: parent.sessionId,
        cwd: '/tmp/parent',
        mcpServers: [],
      });
      expect(forked.sessionId).not.toBe(parent.sessionId);
      const child = server
        .snapshotSessions()
        .find((s) => s.sessionId === forked.sessionId);
      expect(child?.parentSessionId).toBe(parent.sessionId);
      expect(child?.cwd).toBe('/tmp/parent');
      expect(rotations).toHaveLength(1);
      expect(rotations[0]).toMatchObject({
        previousSessionId: parent.sessionId,
        nextSessionId: forked.sessionId,
        reason: 'fork',
      });
      // Child must also be persisted.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const childRecord = await store.read(forked.sessionId);
      expect(childRecord?.parentSessionId).toBe(parent.sessionId);
    } finally {
      await close();
    }
  });

  it('load_session on unknown sessionId → invalidParams', async () => {
    const store = new JsonAcpSessionStore({ directory: dir });
    const { client, close } = wirePair({ store });
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      await expect(
        client.loadSession({
          sessionId: 'never-saved',
          cwd: '/tmp',
          mcpServers: [],
        }),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      await close();
    }
  });

  it('load_session without sessionStore → methodNotFound', async () => {
    const { client, close } = wirePair({});
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      await expect(
        client.loadSession({
          sessionId: 'x',
          cwd: '/tmp',
          mcpServers: [],
        }),
      ).rejects.toMatchObject({ code: -32601 });
    } finally {
      await close();
    }
  });

  it('rotation hook errors are swallowed (fork still resolves)', async () => {
    const store = new JsonAcpSessionStore({ directory: dir });
    const onSessionRotation = vi.fn(() => {
      throw new Error('rotation-hook-explodes');
    });
    const { client, close } = wirePair({ store, onSessionRotation });
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      const parent = await client.newSession({
        cwd: '/tmp',
        mcpServers: [],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const forked = await (client as any).unstable_forkSession({
        sessionId: parent.sessionId,
        cwd: '/tmp',
        mcpServers: [],
      });
      expect(forked.sessionId).toBeDefined();
      expect(onSessionRotation).toHaveBeenCalledOnce();
    } finally {
      await close();
    }
  });
});
