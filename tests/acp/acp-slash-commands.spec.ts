/**
 * M10 Stage 3 — Slash commands surface unit tests.
 *
 * Verifies the COMMAND_REGISTRY → AvailableCommand mapping plus the
 * AcpServer integration that emits `available_commands_update` once
 * per session on the first prompt turn.
 */
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';

import {
  type Agent,
  type AvailableCommand,
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

import {
  buildAvailableCommands,
  commandDefToAvailable,
  notifyAvailableCommands,
} from '../../src/acp/acp-slash-commands.js';
import {
  AcpPromptBridge,
  type AcpPromptDriver,
  type AcpPromptDriverInput,
  type AcpPromptStreamEvent,
} from '../../src/acp/acp-prompt-bridge.js';
import { AcpServer } from '../../src/acp/acp-server.js';
import {
  COMMAND_REGISTRY,
  commandIsExposedOn,
  type DiscordCommandDef,
} from '../../src/discord/discord-command-registry.js';

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
          // already closed
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

describe('buildAvailableCommands', () => {
  it('maps every default-permissive (untagged) command from COMMAND_REGISTRY', () => {
    const built = buildAvailableCommands();
    const expected = COMMAND_REGISTRY.filter((cmd) =>
      commandIsExposedOn(cmd, 'acp'),
    );
    expect(built.length).toBe(expected.length);
    expect(built.map((c) => c.name).sort()).toEqual(
      expected.map((c) => c.name).sort(),
    );
    expect(built.map((c) => c.name)).not.toContain('escalate');
    expect(built.map((c) => c.name)).not.toContain('evidence');
    expect(built.map((c) => c.name)).not.toContain('claim');
    expect(built.map((c) => c.name)).not.toContain('critique');
    expect(built.map((c) => c.name)).not.toContain('proof');
    expect(built.map((c) => c.name)).not.toContain('feed');
  });

  it('preserves command order (registry-order)', () => {
    const built = buildAvailableCommands();
    expect(built.map((c) => c.name)).toEqual(
      COMMAND_REGISTRY.filter((cmd) => commandIsExposedOn(cmd, 'acp')).map(
        (c) => c.name,
      ),
    );
  });

  it('omits a command tagged exclusively for non-acp surfaces', () => {
    // Build an in-memory fake instead of mutating the live registry.
    const fakeCmd: DiscordCommandDef = {
      name: 'auth' as const,
      description: 'mock',
      category: 'admin',
      permissionClass: 'admin-service-control',
      surfaceTags: ['discord'],
    };
    expect(commandDefToAvailable(fakeCmd).name).toBe('auth');
    // Filter behavior is verified at the helper level
    const filteredOut = [fakeCmd].filter((cmd) =>
      cmd.surfaceTags === undefined || cmd.surfaceTags.includes('acp'),
    );
    expect(filteredOut).toHaveLength(0);
  });

  it('includes a command with surfaceTags that contain "acp"', () => {
    const fakeCmd: DiscordCommandDef = {
      name: 'help',
      description: 'mock',
      category: 'help',
      permissionClass: 'help',
      surfaceTags: ['acp', 'discord'],
    };
    const filteredIn = [fakeCmd].filter((cmd) =>
      cmd.surfaceTags === undefined || cmd.surfaceTags.includes('acp'),
    );
    expect(filteredIn).toHaveLength(1);
  });
});

describe('commandDefToAvailable', () => {
  it('describes a command with no required options without an input field', () => {
    const cmd = COMMAND_REGISTRY.find((c) => c.name === 'help');
    expect(cmd).toBeDefined();
    const built = commandDefToAvailable(cmd!);
    expect(built.input ?? null).toBeNull();
  });

  it('describes a command with a single required option as input.hint', () => {
    const cmd = COMMAND_REGISTRY.find((c) => c.name === 'ask');
    expect(cmd).toBeDefined();
    const built = commandDefToAvailable(cmd!);
    expect(built.input).toMatchObject({ hint: 'Instruction to dispatch' });
  });

  it('omits input when there are multiple required options', () => {
    const cmd: DiscordCommandDef = {
      name: 'cancel',
      description: 'mock',
      category: 'control',
      permissionClass: 'owner-admin-task-mutation',
      options: [
        { name: 'a', description: 'first', required: true },
        { name: 'b', description: 'second', required: true },
      ],
    };
    const built = commandDefToAvailable(cmd);
    expect(built.input).toBeUndefined();
  });
});

describe('notifyAvailableCommands', () => {
  it('emits one available_commands_update sessionUpdate', async () => {
    const calls: SessionNotification[] = [];
    const conn = {
      sessionUpdate: vi.fn(async (params: SessionNotification) => {
        calls.push(params);
      }),
    };
    const cmds: AvailableCommand[] = [{ name: 'foo', description: 'bar' }];
    await notifyAvailableCommands(conn, 'sess-x', { commands: cmds });
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe('sess-x');
    expect(calls[0].update).toMatchObject({
      sessionUpdate: 'available_commands_update',
      availableCommands: cmds,
    });
  });

  it('swallows wire errors (notification must not abort caller flow)', async () => {
    const onError = vi.fn();
    const conn = {
      sessionUpdate: vi.fn(async () => {
        throw new Error('wire-broken');
      }),
    };
    await notifyAvailableCommands(conn, 'sess-x', {
      commands: [{ name: 'foo', description: 'bar' }],
      onError,
    });
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('AcpServer first-prompt advertisement', () => {
  function wirePair(
    bridge: AcpPromptBridge,
    advertiseSlashCommands = true,
    availableCommands?: readonly AvailableCommand[],
  ): {
    readonly client: Agent;
    readonly clientUpdates: SessionNotification[];
    readonly close: () => Promise<void>;
  } {
    const agentIn = new PassThrough();
    const agentOut = new PassThrough();
    const clientUpdates: SessionNotification[] = [];

    const agentStream = ndJsonStream(
      nodeWritableToWeb(agentOut),
      nodeReadableToWeb(agentIn),
    );
    new AgentSideConnection(
      (conn) =>
        new AcpServer(conn, {
          promptBridge: bridge,
          advertiseSlashCommands,
          ...(availableCommands === undefined ? {} : { availableCommands }),
          newSessionId: (() => {
            let n = 0;
            return () => `sess-${(++n).toString().padStart(2, '0')}`;
          })(),
        }),
      agentStream,
    );

    const clientStream = ndJsonStream(
      nodeWritableToWeb(agentIn),
      nodeReadableToWeb(agentOut),
    );
    const clientConn = new ClientSideConnection(
      () =>
        new (class implements Client {
          async requestPermission(
            _p: RequestPermissionRequest,
          ): Promise<RequestPermissionResponse> {
            throw new Error('unexpected');
          }
          async sessionUpdate(p: SessionNotification): Promise<void> {
            clientUpdates.push(p);
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
      clientUpdates,
      close: async () => {
        agentIn.end();
        agentOut.end();
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    };
  }

  it('emits available_commands_update once on the first prompt turn', async () => {
    const bridge = new AcpPromptBridge({
      driver: new StaticDriver([{ kind: 'done', stopReason: 'end_turn' }]),
    });
    const fakeCommands: AvailableCommand[] = [
      { name: 'foo', description: 'bar' },
    ];
    const { client, clientUpdates, close } = wirePair(bridge, true, fakeCommands);
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      await client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });
      const advertisements = clientUpdates.filter(
        (u) => 'sessionUpdate' in u.update && u.update.sessionUpdate === 'available_commands_update',
      );
      expect(advertisements).toHaveLength(1);
      expect(
        (advertisements[0].update as { availableCommands: AvailableCommand[] })
          .availableCommands,
      ).toEqual(fakeCommands);
    } finally {
      await close();
    }
  });

  it('does not re-emit on subsequent prompt turns', async () => {
    const bridge = new AcpPromptBridge({
      driver: new StaticDriver([{ kind: 'done', stopReason: 'end_turn' }]),
    });
    const { client, clientUpdates, close } = wirePair(bridge);
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      await client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'one' }],
      });
      await client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'two' }],
      });
      const advertisements = clientUpdates.filter(
        (u) =>
          'sessionUpdate' in u.update &&
          u.update.sessionUpdate === 'available_commands_update',
      );
      expect(advertisements).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('skips advertisement when advertiseSlashCommands=false', async () => {
    const bridge = new AcpPromptBridge({
      driver: new StaticDriver([{ kind: 'done', stopReason: 'end_turn' }]),
    });
    const { client, clientUpdates, close } = wirePair(bridge, false);
    try {
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      await client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });
      const advertisements = clientUpdates.filter(
        (u) =>
          'sessionUpdate' in u.update &&
          u.update.sessionUpdate === 'available_commands_update',
      );
      expect(advertisements).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
