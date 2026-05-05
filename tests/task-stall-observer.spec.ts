import { describe, expect, it } from 'vitest';

import {
  AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS,
  TaskStallObserver,
  createRuntimeEvent,
  createTaskStallObserverFromEnv,
  isTaskStallObserverEnabledFromEnv,
  taskStallThresholdMsFromEnv,
} from '../src/index.js';

function eventAt(timestamp: string) {
  return createRuntimeEvent({
    kind: 'turn.completed',
    instanceId: 'instance-stall-1',
    timestamp,
    turnSequence: 1,
    usage: {
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
    },
    provenance: {
      producer: 'codex-runtime-driver',
      sdkEventType: 'turn.completed',
      threadId: 'thread-stall-1',
    },
  });
}

describe('TaskStallObserver', () => {
  it('rejects non-positive and non-integer direct thresholds', () => {
    expect(() => new TaskStallObserver({ thresholdMs: 0 })).toThrow(
      'TaskStallObserver thresholdMs must be a positive integer.',
    );
    expect(() => new TaskStallObserver({ thresholdMs: -1 })).toThrow(
      'TaskStallObserver thresholdMs must be a positive integer.',
    );
    expect(() => new TaskStallObserver({ thresholdMs: 1.5 })).toThrow(
      'TaskStallObserver thresholdMs must be a positive integer.',
    );
  });

  it('is disabled by env unless a positive integer threshold is configured', () => {
    expect(taskStallThresholdMsFromEnv({})).toBeUndefined();
    expect(isTaskStallObserverEnabledFromEnv({})).toBe(false);
    expect(
      createTaskStallObserverFromEnv({
        [AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS]: '',
      }),
    ).toBeUndefined();
    expect(
      createTaskStallObserverFromEnv({
        [AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS]: '0',
      }),
    ).toBeUndefined();
    expect(
      createTaskStallObserverFromEnv({
        [AUTO_ARCHIVE_TASK_STALL_THRESHOLD_MS]: '1000',
      }),
    ).toBeInstanceOf(TaskStallObserver);
  });

  it('emits one stall signal per no-progress interval and clears state on release', () => {
    const observer = new TaskStallObserver({ thresholdMs: 1000 });

    expect(observer.tick(Date.parse('2026-05-05T00:00:00.000Z'))).toEqual([]);

    observer.observe({
      taskId: 'task-stall-1',
      instanceId: 'instance-stall-1',
      event: eventAt('2026-05-05T00:00:00.000Z'),
    });

    expect(observer.currentStalls(Date.parse('2026-05-05T00:00:00.999Z'))).toEqual(
      [],
    );
    expect(observer.tick(Date.parse('2026-05-05T00:00:00.999Z'))).toEqual([]);
    expect(
      observer.currentStalls(Date.parse('2026-05-05T00:00:01.000Z')),
    ).toEqual([
      {
        taskId: 'task-stall-1',
        instanceId: 'instance-stall-1',
        observedAt: '2026-05-05T00:00:01.000Z',
        lastProgressAt: '2026-05-05T00:00:00.000Z',
        thresholdMs: 1000,
        lastEventKind: 'turn.completed',
      },
    ]);
    expect(
      observer.currentStalls(Date.parse('2026-05-05T00:00:01.000Z')),
    ).toEqual([
      {
        taskId: 'task-stall-1',
        instanceId: 'instance-stall-1',
        observedAt: '2026-05-05T00:00:01.000Z',
        lastProgressAt: '2026-05-05T00:00:00.000Z',
        thresholdMs: 1000,
        lastEventKind: 'turn.completed',
      },
    ]);
    expect(observer.tick(Date.parse('2026-05-05T00:00:01.000Z'))).toEqual([
      {
        taskId: 'task-stall-1',
        instanceId: 'instance-stall-1',
        observedAt: '2026-05-05T00:00:01.000Z',
        lastProgressAt: '2026-05-05T00:00:00.000Z',
        thresholdMs: 1000,
        lastEventKind: 'turn.completed',
      },
    ]);
    expect(observer.tick(Date.parse('2026-05-05T00:00:02.000Z'))).toEqual([]);
    expect(
      observer.currentStalls(Date.parse('2026-05-05T00:00:02.000Z')),
    ).toEqual([
      {
        taskId: 'task-stall-1',
        instanceId: 'instance-stall-1',
        observedAt: '2026-05-05T00:00:02.000Z',
        lastProgressAt: '2026-05-05T00:00:00.000Z',
        thresholdMs: 1000,
        lastEventKind: 'turn.completed',
      },
    ]);

    observer.observe({
      taskId: 'task-stall-1',
      instanceId: 'instance-stall-1',
      event: eventAt('2026-05-05T00:00:02.500Z'),
    });
    expect(observer.tick(Date.parse('2026-05-05T00:00:03.500Z'))).toEqual([
      {
        taskId: 'task-stall-1',
        instanceId: 'instance-stall-1',
        observedAt: '2026-05-05T00:00:03.500Z',
        lastProgressAt: '2026-05-05T00:00:02.500Z',
        thresholdMs: 1000,
        lastEventKind: 'turn.completed',
      },
    ]);

    observer.release('task-stall-1');
    expect(observer.snapshot()).toEqual([]);
    expect(observer.tick(Date.parse('2026-05-05T00:00:10.000Z'))).toEqual([]);

    observer.observe({
      taskId: 'task-stall-1',
      instanceId: 'instance-stall-1',
      event: eventAt('2026-05-05T00:00:11.000Z'),
    });
    expect(observer.tick(Date.parse('2026-05-05T00:00:12.000Z'))).toEqual([
      {
        taskId: 'task-stall-1',
        instanceId: 'instance-stall-1',
        observedAt: '2026-05-05T00:00:12.000Z',
        lastProgressAt: '2026-05-05T00:00:11.000Z',
        thresholdMs: 1000,
        lastEventKind: 'turn.completed',
      },
    ]);
  });

  it('tracks tasks independently', () => {
    const observer = new TaskStallObserver({ thresholdMs: 1000 });

    observer.observe({
      taskId: 'task-stall-a',
      instanceId: 'instance-a',
      event: eventAt('2026-05-05T00:00:00.000Z'),
    });
    observer.observe({
      taskId: 'task-stall-b',
      instanceId: 'instance-b',
      event: eventAt('2026-05-05T00:00:00.500Z'),
    });

    expect(
      observer
        .tick(Date.parse('2026-05-05T00:00:01.000Z'))
        .map((signal) => signal.taskId),
    ).toEqual(['task-stall-a']);
    expect(
      observer
        .tick(Date.parse('2026-05-05T00:00:01.500Z'))
        .map((signal) => signal.taskId),
    ).toEqual(['task-stall-b']);
  });
});
