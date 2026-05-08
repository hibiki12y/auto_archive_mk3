/**
 * P4 Stage 4-3 — subagent lifecycle session-log routing helpers.
 *
 * Verifies the read-only render + dispatcher surfaces:
 *   - `buildSubagentLifecycleSessionLogPayload` emits redacted, short
 *     operator-facing strings for every RosterEvent kind. Free-text
 *     fields like `cause.reason`, `cause.message`, and `cause.phase`
 *     are NEVER inlined.
 *   - `routeSubagentLifecycleEventToSessionLog` invokes the supplied
 *     router with the rendered payload + event taskId.
 *   - `resolveSubagentLifecycleSessionLogEnabledFromEnv` returns
 *     `true` only when the env flag is exactly `'on'` (default off
 *     preserves legacy behavior).
 *
 * Production bootstrap wiring of these helpers is deferred to a
 * follow-up PR — see the Stage 4-3 sub-section of the P4 plan. This
 * test file documents the shape so the deferred PR has a stable
 * surface to land on.
 */
import { describe, expect, it, vi } from 'vitest';

import type { RosterEvent } from '../../src/contracts/subagent-roster-event.js';
import {
  AUTO_ARCHIVE_DISCORD_SUBAGENT_LIFECYCLE_LOG,
  buildSubagentLifecycleSessionLogPayload,
  resolveSubagentLifecycleSessionLogEnabledFromEnv,
  routeSubagentLifecycleEventToSessionLog,
  type DiscordSessionLogThreadRouteInput,
  type DiscordSessionLogThreadRouteOutcome,
  type DiscordSessionLogThreadRouter,
} from '../../src/discord/discord-session-log-thread-router.js';

const correlationKey = {
  taskId: 'task-lifecycle-session-log',
  instanceId: 'instance-lifecycle-session-log',
  subagentId: 'subagent-7',
};

const spawnedEvent: RosterEvent = {
  kind: 'subagent.spawned',
  correlationKey,
  timestamp: '2026-05-08T00:00:00.000Z',
  descriptor: {
    subagentId: 'subagent-7',
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

const completedEvent: RosterEvent = {
  kind: 'subagent.completed',
  correlationKey,
  timestamp: '2026-05-08T00:01:00.000Z',
  artifact: { digest: 'sha256:abc' },
  cause: {
    kind: 'success',
    taskId: correlationKey.taskId,
    runtimeInstanceId: correlationKey.instanceId,
    observedAt: '2026-05-08T00:01:00.000Z',
    provenance: 'lifecycle-session-log-test',
  },
};

const failedEvent: RosterEvent = {
  kind: 'subagent.failed',
  correlationKey,
  timestamp: '2026-05-08T00:02:00.000Z',
  cause: {
    kind: 'driver-failure',
    taskId: correlationKey.taskId,
    runtimeInstanceId: correlationKey.instanceId,
    observedAt: '2026-05-08T00:02:00.000Z',
    provenance: 'lifecycle-session-log-test',
    phase: 'must-not-leak-this-phase',
    message: 'must-not-leak-this-message',
  },
};

const progressEvent: RosterEvent = {
  kind: 'roster.progress',
  correlationKey,
  timestamp: '2026-05-08T00:03:00.000Z',
  completed: 2,
  aborted: 1,
  failed: 0,
  total: 3,
  inFlight: 0,
};

describe('buildSubagentLifecycleSessionLogPayload', () => {
  it('renders spawn lines with subagent id, role, state', () => {
    const payload = buildSubagentLifecycleSessionLogPayload(spawnedEvent);
    expect(payload.content).toContain('subagent-7');
    expect(payload.content).toContain('verifier');
    expect(payload.content).toContain('active');
    expect(payload.content.toLowerCase()).toContain('spawn');
  });

  it('renders terminal lines without leaking free-text cause fields', () => {
    const completed = buildSubagentLifecycleSessionLogPayload(completedEvent);
    expect(completed.content).toContain('subagent-7');
    expect(completed.content).toContain('completed');
    const failed = buildSubagentLifecycleSessionLogPayload(failedEvent);
    expect(failed.content).toContain('subagent-7');
    expect(failed.content).toContain('failed');
    expect(failed.content).not.toContain('must-not-leak-this-phase');
    expect(failed.content).not.toContain('must-not-leak-this-message');
  });

  it('renders roster.progress counters as a single short line', () => {
    const payload = buildSubagentLifecycleSessionLogPayload(progressEvent);
    expect(payload.content).toContain('total=3');
    expect(payload.content).toContain('completed=2');
    expect(payload.content).toContain('aborted=1');
    expect(payload.content).toContain('inFlight=0');
  });
});

describe('routeSubagentLifecycleEventToSessionLog', () => {
  it('forwards the rendered payload with the event taskId', async () => {
    const captured: DiscordSessionLogThreadRouteInput[] = [];
    const router: DiscordSessionLogThreadRouter = {
      async routeFollowUp(
        input: DiscordSessionLogThreadRouteInput,
      ): Promise<DiscordSessionLogThreadRouteOutcome> {
        captured.push(input);
        return { delivered: 'thread', threadId: 'thread-1' };
      },
    };
    const outcome = await routeSubagentLifecycleEventToSessionLog(
      router,
      spawnedEvent,
    );
    expect(outcome.delivered).toBe('thread');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.taskId).toBe(correlationKey.taskId);
    expect(captured[0]?.payload.content).toContain('subagent-7');
  });

  it('propagates the router channel-fallback outcome verbatim', async () => {
    const router: DiscordSessionLogThreadRouter = {
      routeFollowUp: vi.fn(
        async (): Promise<DiscordSessionLogThreadRouteOutcome> => ({
          delivered: 'channel-fallback',
          fallbackReason: 'thread-create-failed',
        }),
      ),
    };
    const outcome = await routeSubagentLifecycleEventToSessionLog(
      router,
      progressEvent,
    );
    expect(outcome.delivered).toBe('channel-fallback');
    expect(outcome.fallbackReason).toBe('thread-create-failed');
  });
});

describe('resolveSubagentLifecycleSessionLogEnabledFromEnv', () => {
  it("returns false by default (preserve legacy behavior)", () => {
    expect(
      resolveSubagentLifecycleSessionLogEnabledFromEnv({} as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("returns true only for exact 'on' value", () => {
    expect(
      resolveSubagentLifecycleSessionLogEnabledFromEnv({
        [AUTO_ARCHIVE_DISCORD_SUBAGENT_LIFECYCLE_LOG]: 'on',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      resolveSubagentLifecycleSessionLogEnabledFromEnv({
        [AUTO_ARCHIVE_DISCORD_SUBAGENT_LIFECYCLE_LOG]: 'true',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      resolveSubagentLifecycleSessionLogEnabledFromEnv({
        [AUTO_ARCHIVE_DISCORD_SUBAGENT_LIFECYCLE_LOG]: '1',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("trims whitespace and matches 'on' exactly", () => {
    expect(
      resolveSubagentLifecycleSessionLogEnabledFromEnv({
        [AUTO_ARCHIVE_DISCORD_SUBAGENT_LIFECYCLE_LOG]: '  on  ',
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});
