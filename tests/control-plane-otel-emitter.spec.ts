import { describe, expect, it, vi } from 'vitest';

import {
  AUTO_ARCHIVE_OTEL_LOGS_URL,
  AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES,
  ControlPlaneOtelLogsEmitter,
  createControlPlaneEvent,
  createControlPlaneOtelLogsEmitterFromEnv,
  taskHealthStallSignalToControlPlaneEventInput,
  type ControlPlaneEvent,
  type ControlPlaneOtelFetch,
} from '../src/index.js';

function sampleEvent(): ControlPlaneEvent {
  return {
    schemaVersion: 1,
    eventId: 'event-1',
    timestamp: '2026-05-05T00:00:00.000Z',
    type: 'task.lifecycle_observed',
    actor: { kind: 'discord-user', userId: 'user-secret' },
    channel: { kind: 'discord', channelId: 'channel-secret' },
    conversationId: 'conversation-1',
    taskId: 'task-1',
    correlationId: 'correlation-1',
    trust: { source: 'system', inputTrust: 'trusted' },
    payload: {
      instruction: 'do not export this instruction',
      reason: 'do not export this reason',
      content: 'do not export this content',
      record: { nested: 'do not export this record' },
      phase: 'runtime-running',
      scope: 'task',
      commandName: 'ask',
    },
  };
}

describe('control-plane OTLP logs emitter', () => {
  it('is default-off when no OTLP logs URL is configured', () => {
    expect(createControlPlaneOtelLogsEmitterFromEnv({})).toBeUndefined();
    expect(
      createControlPlaneOtelLogsEmitterFromEnv({
        [AUTO_ARCHIVE_OTEL_LOGS_URL]: '   ',
      }),
    ).toBeUndefined();
  });

  it('posts a safe OTLP HTTP JSON log payload when configured', async () => {
    const fetchFn = vi.fn<ControlPlaneOtelFetch>().mockResolvedValue({
      ok: true,
      status: 200,
    });
    const emitter = createControlPlaneOtelLogsEmitterFromEnv(
      {
        [AUTO_ARCHIVE_OTEL_LOGS_URL]: 'http://otel.example/v1/logs',
        [AUTO_ARCHIVE_OTEL_RESOURCE_ATTRIBUTES]:
          'deployment.environment=test,service.instance.id=local',
      },
      { fetch: fetchFn },
    );

    expect(emitter).toBeDefined();
    emitter?.observe(sampleEvent());
    await emitter?.shutdown();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('http://otel.example/v1/logs');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    const body = String(init?.body);
    const parsed = JSON.parse(body) as {
      resourceLogs: Array<{
        resource: { attributes: Array<{ key: string }> };
        scopeLogs: Array<{
          logRecords: Array<{ attributes: Array<{ key: string }> }>;
        }>;
      }>;
    };
    const resourceKeys = parsed.resourceLogs[0]?.resource.attributes.map(
      (attribute) => attribute.key,
    );
    const eventKeys =
      parsed.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.attributes.map(
        (attribute) => attribute.key,
      );

    expect(resourceKeys).toContain('service.name');
    expect(resourceKeys).toContain('deployment.environment');
    expect(eventKeys).toContain('aa.control.event.type');
    expect(eventKeys).toContain('aa.control.lifecycle.phase');
    expect(eventKeys).toContain('aa.control.command.name');
    expect(body).toContain('control-plane task.lifecycle_observed');
    expect(body).not.toContain('do not export this instruction');
    expect(body).not.toContain('do not export this reason');
    expect(body).not.toContain('do not export this content');
    expect(body).not.toContain('do not export this record');
    expect(body).not.toContain('channel-secret');
    expect(body).not.toContain('conversation-1');
    expect(body).not.toContain('user-secret');
  });

  it('mirrors task-health stall events without exporting stall payload internals', async () => {
    const fetchFn = vi.fn<ControlPlaneOtelFetch>().mockResolvedValue({
      ok: true,
      status: 200,
    });
    const emitter = new ControlPlaneOtelLogsEmitter({
      url: 'https://otel.example/v1/logs',
      fetch: fetchFn,
    });
    emitter.observe(
      createControlPlaneEvent(
        taskHealthStallSignalToControlPlaneEventInput({
          taskId: 'task-health-otel',
          instanceId: 'instance-health-otel',
          observedAt: '2026-05-05T00:00:05.000Z',
          lastProgressAt: '2026-05-05T00:00:00.000Z',
          thresholdMs: 5000,
          lastEventKind: 'turn.completed',
        }),
      ),
    );
    await emitter.shutdown();

    const body = String(fetchFn.mock.calls[0]?.[1]?.body);
    expect(body).toContain('control-plane task.health_stalled');
    expect(body).toContain('aa.control.lifecycle.phase');
    expect(body).toContain('stalled');
    expect(body).toContain('aa.control.lifecycle.scope');
    expect(body).toContain('task-health');
    expect(body).not.toContain('thresholdMs');
    expect(body).not.toContain('lastProgressAt');
    expect(body).not.toContain('lastEventKind');
    expect(body).not.toContain('turn.completed');
  });

  it('fails open when fetch rejects or the collector returns non-2xx', async () => {
    const logger = vi.fn();
    const rejectFetch = vi
      .fn<ControlPlaneOtelFetch>()
      .mockRejectedValue(new Error('network unavailable'));
    const non2xxFetch = vi.fn<ControlPlaneOtelFetch>().mockResolvedValue({
      ok: false,
      status: 503,
    });

    const rejectingEmitter = new ControlPlaneOtelLogsEmitter({
      url: 'https://otel.example/v1/logs',
      fetch: rejectFetch,
      logger,
    });
    rejectingEmitter.observe(sampleEvent());
    await expect(rejectingEmitter.shutdown()).resolves.toBeUndefined();

    const non2xxEmitter = new ControlPlaneOtelLogsEmitter({
      url: 'https://otel.example/v1/logs',
      fetch: non2xxFetch,
      logger,
    });
    non2xxEmitter.observe(sampleEvent());
    await expect(non2xxEmitter.shutdown()).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith(
      'control-plane-otel-export-non-2xx',
      expect.objectContaining({ status: 503 }),
    );
  });

  it('bounds shutdown even when an export remains pending', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn<ControlPlaneOtelFetch>(
        () => new Promise(() => undefined),
      );
      const emitter = new ControlPlaneOtelLogsEmitter({
        url: 'https://otel.example/v1/logs',
        fetch: fetchFn,
      });

      emitter.observe(sampleEvent());
      const shutdown = emitter.shutdown(5);
      await vi.advanceTimersByTimeAsync(5);
      await expect(shutdown).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a hanging export and contains diagnostic logger failures', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn<ControlPlaneOtelFetch>(
        () => new Promise(() => undefined),
      );
      const logger = vi.fn(() => {
        throw new Error('logger failed');
      });
      const emitter = new ControlPlaneOtelLogsEmitter({
        url: 'https://otel.example/v1/logs',
        fetch: fetchFn,
        logger,
        exportTimeoutMs: 5,
      });

      emitter.observe(sampleEvent());
      await vi.advanceTimersByTimeAsync(5);
      await expect(emitter.shutdown()).resolves.toBeUndefined();
      expect(logger).toHaveBeenCalledWith(
        'control-plane-otel-export-timeout',
        expect.objectContaining({ timeoutMs: 5 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
