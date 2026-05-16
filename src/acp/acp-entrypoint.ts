#!/usr/bin/env node
/**
 * M10 — ACP stdio entrypoint.
 *
 * Wires `process.stdin` / `process.stdout` to the ACP `ndJsonStream`,
 * instantiates the `AgentSideConnection` with our `AcpServer`, and
 * waits for the connection to close. Exit code is `0` on clean EOF
 * and `1` on any unhandled error (the SDK surfaces protocol errors
 * via JSON-RPC envelopes, not exceptions, so this is a backstop).
 *
 * IMPORTANT: stdout is the ACP wire. Anything we want to log goes
 * to stderr — `console.log` is reserved for protocol messages by the
 * SDK and must not be used here for diagnostic output.
 */

import { Readable, Writable } from 'node:stream';

import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

import { AcpServer } from './acp-server.js';
import { defaultAcpLogger } from './acp-logger.js';

async function main(): Promise<number> {
  const writable = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const readable = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(writable, readable);

  const serverRef: { current: AcpServer | null } = { current: null };
  const connection = new AgentSideConnection((conn) => {
    const server = new AcpServer(conn, { logger: defaultAcpLogger });
    serverRef.current = server;
    return server;
  }, stream);

  try {
    await connection.closed;
    serverRef.current?.notifyConnectionClosed('eof');
    return 0;
  } catch (err) {
    serverRef.current?.notifyConnectionClosed('error');
    defaultAcpLogger({
      level: 'error',
      label: 'acp-entrypoint-error',
      message: err instanceof Error ? err.message : String(err),
    });
    return 1;
  }
}

main().then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    defaultAcpLogger({
      level: 'error',
      label: 'acp-entrypoint-fatal',
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  },
);
