/**
 * P4 Stage 4-3 deferred follow-up — bootstrap composes the
 * subagent operator evidence ledger sink and the Discord
 * session-log lifecycle sink behind the single
 * `subagentEvidenceLedgerSink` AgentRuntime hook.
 *
 * Verifies invariant 4-3.deferred-followup:
 *   - When `AUTO_ARCHIVE_DISCORD_SUBAGENT_LIFECYCLE_LOG !== 'on'`,
 *     no session-log sink is composed; the ledger sink alone is
 *     returned (regression — bit-for-bit compat with Stage 4-3).
 *   - When the env flag is `'on'` AND a session-log router is
 *     supplied, the composed sink invokes both constituents.
 *   - A throw in one constituent must NOT prevent the other from
 *     observing the event, and no error escapes the composed sink.
 *   - When the env flag is `'on'` but no router is available, the
 *     bootstrap falls back to ledger-only with a one-time stderr
 *     warning naming the env var.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RosterEvent } from '../../src/contracts/subagent-roster-event.js';
import type { SubagentEvidenceLedgerSink } from '../../src/runtime/agent-runtime.js';
import {
  composeSubagentEvidenceLedgerSinks,
  createSubagentLifecycleSessionLogSinkFromEnv,
} from '../../src/discord/discord-service-bootstrap.js';
import {
  AUTO_ARCHIVE_DISCORD_SUBAGENT_LIFECYCLE_LOG,
  type DiscordSessionLogThreadRouteInput,
  type DiscordSessionLogThreadRouteOutcome,
  type DiscordSessionLogThreadRouter,
} from '../../src/discord/discord-session-log-thread-router.js';

const correlationKey = {
  taskId: 'task-bootstrap-compose',
  instanceId: 'instance-bootstrap-compose',
  subagentId: 'subagent-bootstrap-1',
};

const spawnedEvent: RosterEvent = {
  kind: 'subagent.spawned',
  correlationKey,
  timestamp: '2026-05-08T00:00:00.000Z',
  descriptor: {
    subagentId: 'subagent-bootstrap-1',
    role: 'verifier',
    parent: { taskId: correlationKey.taskId, instanceId: correlationKey.instanceId },
    createdAt: '2026-05-08T00:00:00.000Z',
    state: 'active',
    envelope: {
      requested: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
      effective: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 60, gpuCards: 0 },
    },
  },
};

const progressEvent: RosterEvent = {
  kind: 'roster.progress',
  correlationKey,
  timestamp: '2026-05-08T00:01:00.000Z',
  completed: 0,
  aborted: 0,
  failed: 0,
  total: 1,
  inFlight: 1,
};

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
});

function createCapturingRouter(): {
  readonly router: DiscordSessionLogThreadRouter;
  readonly captured: DiscordSessionLogThreadRouteInput[];
} {
  const captured: DiscordSessionLogThreadRouteInput[] = [];
  const router: DiscordSessionLogThreadRouter = {
    async routeFollowUp(
      input: DiscordSessionLogThreadRouteInput,
    ): Promise<DiscordSessionLogThreadRouteOutcome> {
      captured.push(input);
      return { delivered: 'thread', threadId: 'thread-bootstrap-1' };
    },
  };
  return { router, captured };
}

describe('createSubagentLifecycleSessionLogSinkFromEnv', () => {
  it('returns undefined when the env flag is unset (regression: legacy behavior)', () => {
    const { router } = createCapturingRouter();
    expect(
      createSubagentLifecycleSessionLogSinkFromEnv(
        {} as NodeJS.ProcessEnv,
        router,
      ),
    ).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns undefined when the env flag is on but no router is available, with a one-time stderr warning', () => {
    const sink = createSubagentLifecycleSessionLogSinkFromEnv(
      {
        [AUTO_ARCHIVE_DISCORD_SUBAGENT_LIFECYCLE_LOG]: 'on',
      } as unknown as NodeJS.ProcessEnv,
      undefined,
    );
    expect(sink).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstCall = warnSpy.mock.calls[0];
    expect(firstCall?.[0]).toContain('subagent-lifecycle-session-log');
    expect(String(firstCall?.[1] ?? '')).toContain(
      AUTO_ARCHIVE_DISCORD_SUBAGENT_LIFECYCLE_LOG,
    );
  });

  it('returns a sink that forwards events through the router when env flag is on AND router is provided', async () => {
    const { router, captured } = createCapturingRouter();
    const sink = createSubagentLifecycleSessionLogSinkFromEnv(
      {
        [AUTO_ARCHIVE_DISCORD_SUBAGENT_LIFECYCLE_LOG]: 'on',
      } as unknown as NodeJS.ProcessEnv,
      router,
    );
    expect(sink).toBeDefined();
    sink?.(spawnedEvent);
    // The session-log sink fires the router asynchronously; await a
    // microtask so the captured array sees the routeFollowUp call.
    await Promise.resolve();
    await Promise.resolve();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.taskId).toBe(correlationKey.taskId);
    expect(captured[0]?.payload.content).toContain('subagent-bootstrap-1');
  });
});

describe('composeSubagentEvidenceLedgerSinks', () => {
  it('returns undefined when every constituent is undefined (legacy bit-compat)', () => {
    expect(composeSubagentEvidenceLedgerSinks(undefined)).toBeUndefined();
    expect(
      composeSubagentEvidenceLedgerSinks(undefined, undefined),
    ).toBeUndefined();
  });

  it('returns the lone ledger sink when env flag is off and only the ledger is wired (regression)', () => {
    const calls: RosterEvent[] = [];
    const ledger: SubagentEvidenceLedgerSink = (event) => {
      calls.push(event);
    };
    const composed = composeSubagentEvidenceLedgerSinks(ledger, undefined);
    expect(composed).toBe(ledger);
    composed?.(spawnedEvent);
    expect(calls).toHaveLength(1);
  });

  it('invokes both sinks when both ledger + session-log are wired', () => {
    const ledgerCalls: RosterEvent[] = [];
    const sessionLogCalls: RosterEvent[] = [];
    const composed = composeSubagentEvidenceLedgerSinks(
      (event) => ledgerCalls.push(event),
      (event) => sessionLogCalls.push(event),
    );
    expect(composed).toBeDefined();
    composed?.(spawnedEvent);
    composed?.(progressEvent);
    expect(ledgerCalls).toHaveLength(2);
    expect(sessionLogCalls).toHaveLength(2);
    expect(ledgerCalls[0]?.kind).toBe('subagent.spawned');
    expect(sessionLogCalls[1]?.kind).toBe('roster.progress');
  });

  it('keeps the second sink running when the first sink throws, and never propagates the throw outward', () => {
    const sessionLogCalls: RosterEvent[] = [];
    const composed = composeSubagentEvidenceLedgerSinks(
      () => {
        throw new Error('ledger-write-failed');
      },
      (event) => sessionLogCalls.push(event),
    );
    expect(() => composed?.(spawnedEvent)).not.toThrow();
    expect(sessionLogCalls).toHaveLength(1);
    expect(sessionLogCalls[0]?.kind).toBe('subagent.spawned');
    // The composer logs the per-sink failure to stderr so the operator
    // can see why the ledger silenced; the AgentRuntime observer
    // contract still holds (no outward throw).
    expect(warnSpy).toHaveBeenCalled();
    const message = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('subagent-evidence-sink-threw');
  });

  it('keeps the first sink running when the second sink throws (symmetry)', () => {
    const ledgerCalls: RosterEvent[] = [];
    const composed = composeSubagentEvidenceLedgerSinks(
      (event) => ledgerCalls.push(event),
      () => {
        throw new Error('session-log-write-failed');
      },
    );
    expect(() => composed?.(progressEvent)).not.toThrow();
    expect(ledgerCalls).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
  });
});
