import { describe, expect, it, vi } from 'vitest';

import {
  InMemoryControlPlaneLedger,
  TaskStallObserver,
  appendTaskHealthStallSignalsToControlPlaneLedger,
  createRuntimeEvent,
  filterControlPlaneEvents,
  recordTaskHealthStallsToControlPlaneLedger,
  renderControlPlaneFeed,
  taskHealthStallSignalToControlPlaneEventInput,
} from '../src/index.js';
import type {
  ControlPlaneEventInput,
  ControlPlaneLedgerPort,
} from '../src/control/control-plane-ledger.js';

function eventAt(timestamp: string) {
  return createRuntimeEvent({
    kind: 'turn.started',
    instanceId: 'instance-health-recorder-1',
    timestamp,
    turnSequence: 1,
    provenance: {
      producer: 'codex-runtime-driver',
      sdkEventType: 'turn.started',
      threadId: 'thread-health-recorder-1',
    },
  });
}

describe('task-health control-plane recorder', () => {
  it('maps stall signals to safe task-scoped control-plane events', () => {
    expect(
      taskHealthStallSignalToControlPlaneEventInput({
        taskId: 'task-health-recorder-1',
        instanceId: 'instance-health-recorder-1',
        observedAt: '2026-05-05T00:00:01.000Z',
        lastProgressAt: '2026-05-05T00:00:00.000Z',
        thresholdMs: 1000,
        lastEventKind: 'turn.started',
      }),
    ).toEqual({
      type: 'task.health_stalled',
      timestamp: '2026-05-05T00:00:01.000Z',
      actor: { kind: 'system' },
      channel: { kind: 'system' },
      taskId: 'task-health-recorder-1',
      correlationId: 'instance-health-recorder-1',
      trust: {
        source: 'system',
        inputTrust: 'trusted',
      },
      payload: {
        phase: 'stalled',
        scope: 'task-health',
        provenance: 'task-health-control-plane-recorder',
        lastProgressAt: '2026-05-05T00:00:00.000Z',
        thresholdMs: 1000,
        lastEventKind: 'turn.started',
      },
    });
  });

  it('records one durable event per emitted stall signal and preserves tick duplicate suppression', () => {
    const observer = new TaskStallObserver({ thresholdMs: 1000 });
    const ledger = new InMemoryControlPlaneLedger();

    observer.observe({
      taskId: 'task-health-recorder-1',
      instanceId: 'instance-health-recorder-1',
      event: eventAt('2026-05-05T00:00:00.000Z'),
    });

    expect(
      recordTaskHealthStallsToControlPlaneLedger(
        observer,
        ledger,
        Date.parse('2026-05-05T00:00:00.999Z'),
      ),
    ).toEqual([]);
    const recorded = recordTaskHealthStallsToControlPlaneLedger(
      observer,
      ledger,
      Date.parse('2026-05-05T00:00:01.000Z'),
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      type: 'task.health_stalled',
      timestamp: '2026-05-05T00:00:01.000Z',
      taskId: 'task-health-recorder-1',
      correlationId: 'instance-health-recorder-1',
      payload: {
        phase: 'stalled',
        scope: 'task-health',
        lastProgressAt: '2026-05-05T00:00:00.000Z',
        thresholdMs: 1000,
        lastEventKind: 'turn.started',
      },
    });
    expect(
      recordTaskHealthStallsToControlPlaneLedger(
        observer,
        ledger,
        Date.parse('2026-05-05T00:00:02.000Z'),
      ),
    ).toEqual([]);
    expect(ledger.loadAll()).toHaveLength(1);

    observer.observe({
      taskId: 'task-health-recorder-1',
      instanceId: 'instance-health-recorder-1',
      event: eventAt('2026-05-05T00:00:03.000Z'),
    });
    expect(
      recordTaskHealthStallsToControlPlaneLedger(
        observer,
        ledger,
        Date.parse('2026-05-05T00:00:04.000Z'),
      ),
    ).toHaveLength(1);
    expect(ledger.loadAll()).toHaveLength(2);
  });

  it('keeps task health stalls visible to task-prefixed feed reads', () => {
    const ledger = new InMemoryControlPlaneLedger();
    appendTaskHealthStallSignalsToControlPlaneLedger(ledger, [
      {
        taskId: 'task-health-feed',
        instanceId: 'instance-health-feed',
        observedAt: '2026-05-05T00:00:05.000Z',
        lastProgressAt: '2026-05-05T00:00:00.000Z',
        thresholdMs: 5000,
        lastEventKind: 'turn.completed',
      },
    ]);

    expect(
      ledger
        .loadSince('2026-05-05T00:00:00.000Z', 10, { typePrefix: 'task.' })
        .map((event) => event.type),
    ).toEqual(['task.health_stalled']);
    expect(
      filterControlPlaneEvents(ledger.loadAll(), {
        taskId: 'task-health-feed',
      }).map((event) => event.type),
    ).toEqual(['task.health_stalled']);

    const rendered = renderControlPlaneFeed({
      events: ledger.loadAll(),
      since: '5m',
      kind: 'task',
      limit: 10,
    }).content;
    expect(rendered).toContain('task.health_stalled');
    expect(rendered).toContain('phase=stalled');
    expect(rendered).toContain('task=task-health-feed');
    expect(rendered).toContain('event=');
    expect(rendered).not.toContain('thresholdMs');
    expect(rendered).not.toContain('5000');
    expect(rendered).not.toContain('lastProgressAt');
  });

  it('does nothing when tick emits no stall signals', () => {
    const logger = vi.fn();
    const append = vi.fn();
    const ledger: ControlPlaneLedgerPort = {
      append,
      loadAll: () => [],
      loadSince: () => [],
    };

    expect(
      recordTaskHealthStallsToControlPlaneLedger(
        { tick: () => [] },
        ledger,
        Date.parse('2026-05-05T00:00:00.000Z'),
        { logger },
      ),
    ).toEqual([]);
    expect(append).not.toHaveBeenCalled();
    expect(logger).not.toHaveBeenCalled();
  });

  it('contains append failures and continues recording later signals', () => {
    const logger = vi.fn();
    let calls = 0;
    const appended: ControlPlaneEventInput[] = [];
    const ledger: ControlPlaneLedgerPort = {
      append(input) {
        calls += 1;
        if (calls === 1) {
          throw new Error('ledger unavailable');
        }
        appended.push(input);
        return {
          schemaVersion: 1,
          eventId: `event-${calls}`,
          timestamp: input.timestamp ?? '2026-05-05T00:00:00.000Z',
          type: input.type,
          actor: input.actor,
          ...(input.channel === undefined ? {} : { channel: input.channel }),
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
          ...(input.correlationId === undefined
            ? {}
            : { correlationId: input.correlationId }),
          trust: input.trust,
          payload: input.payload,
        };
      },
      loadAll: () => [],
      loadSince: () => [],
    };

    const recorded = appendTaskHealthStallSignalsToControlPlaneLedger(
      ledger,
      [
        {
          taskId: 'task-health-fail-1',
          instanceId: 'instance-health-fail-1',
          observedAt: '2026-05-05T00:00:01.000Z',
          lastProgressAt: '2026-05-05T00:00:00.000Z',
          thresholdMs: 1000,
          lastEventKind: 'turn.started',
        },
        {
          taskId: 'task-health-fail-2',
          instanceId: 'instance-health-fail-2',
          observedAt: '2026-05-05T00:00:02.000Z',
          lastProgressAt: '2026-05-05T00:00:00.000Z',
          thresholdMs: 1000,
          lastEventKind: 'turn.completed',
        },
      ],
      { logger },
    );

    expect(recorded).toHaveLength(1);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.taskId).toBe('task-health-fail-2');
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      'task-health-control-plane-append-failed',
      expect.objectContaining({
        taskId: 'task-health-fail-1',
        error: 'ledger unavailable',
      }),
    );
  });
});
