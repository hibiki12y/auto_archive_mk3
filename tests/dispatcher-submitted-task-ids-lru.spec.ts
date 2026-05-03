/**
 * LRU bound on `Dispatcher.submittedTaskIds` (audit 2026-05-04 follow-up).
 *
 * Same audit class as PR #18 (`SubagentOperatorSurface.maxLogSubagents`),
 * PR #19 (compute-node allocations), PR #21
 * (`PromptCacheInvariant.forgetTask`). Without the cap, a long-running
 * dispatcher accumulates one Set entry per submitted task for the
 * lifetime of the host process.
 *
 * The cap trades dedup memory for bounded growth — a duplicate retry of
 * an *evicted* taskId is admitted, with `dispatcher.submitted-task-ids.evicted`
 * logged structurally so operators see when the rollover happens.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  Dispatcher,
  DuplicateSubmissionError,
  Plana,
  createDispatchPlan,
} from '../src/index.js';
import {
  createTaskRequest,
  inProcessNodeForRejectionTest,
} from './helpers/dispatcher-core.js';

describe('Dispatcher.submittedTaskIds LRU bound', () => {
  it('within the cap, duplicate submission still throws DuplicateSubmissionError', () => {
    const plana = new Plana();
    const dispatcher = new Dispatcher(inProcessNodeForRejectionTest(), {
      maxSubmittedTaskIds: 3,
    });
    dispatcher.submit(createDispatchPlan(createTaskRequest('task-a')), plana);
    expect(() =>
      dispatcher.submit(createDispatchPlan(createTaskRequest('task-a')), plana),
    ).toThrowError(DuplicateSubmissionError);
  });

  it('evicts the oldest entry when the cap is exceeded (insertion order)', () => {
    const plana = new Plana();
    const dispatcher = new Dispatcher(inProcessNodeForRejectionTest(), {
      maxSubmittedTaskIds: 2,
    });
    dispatcher.submit(createDispatchPlan(createTaskRequest('task-1')), plana);
    dispatcher.submit(createDispatchPlan(createTaskRequest('task-2')), plana);
    expect(dispatcher.submissionCount).toBe(2);

    // Third submission should evict task-1 (the oldest).
    dispatcher.submit(createDispatchPlan(createTaskRequest('task-3')), plana);
    expect(dispatcher.submissionCount).toBe(2);

    // task-1 was evicted: re-submitting it is admitted as a fresh task.
    expect(() =>
      dispatcher.submit(createDispatchPlan(createTaskRequest('task-1')), plana),
    ).not.toThrow();

    // task-2 and task-3 remain in the dedup set; task-2 is now the oldest.
    expect(() =>
      dispatcher.submit(createDispatchPlan(createTaskRequest('task-3')), plana),
    ).toThrowError(DuplicateSubmissionError);
  });

  it('emits a structured warn line when an entry is evicted', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const plana = new Plana();
      const dispatcher = new Dispatcher(inProcessNodeForRejectionTest(), {
        maxSubmittedTaskIds: 1,
      });
      dispatcher.submit(createDispatchPlan(createTaskRequest('task-old')), plana);
      dispatcher.submit(createDispatchPlan(createTaskRequest('task-new')), plana);

      const evictionCalls = warnSpy.mock.calls.filter((call) =>
        typeof call[0] === 'string' &&
        call[0].startsWith('dispatcher.submitted-task-ids.evicted '),
      );
      expect(evictionCalls).toHaveLength(1);

      const payloadJson = (evictionCalls[0][0] as string).slice(
        'dispatcher.submitted-task-ids.evicted '.length,
      );
      const payload = JSON.parse(payloadJson) as {
        evictedTaskId: string;
        cap: number;
        replacedBy: string;
      };
      expect(payload.evictedTaskId).toBe('task-old');
      expect(payload.cap).toBe(1);
      expect(payload.replacedBy).toBe('task-new');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('default cap does not fire on small workloads', () => {
    // Sanity check that omitting maxSubmittedTaskIds keeps pre-PR
    // dedup behavior intact for any realistic small-workload test.
    const plana = new Plana();
    const dispatcher = new Dispatcher(inProcessNodeForRejectionTest());
    for (let i = 0; i < 10; i++) {
      dispatcher.submit(createDispatchPlan(createTaskRequest(`task-${i}`)), plana);
    }
    expect(dispatcher.submissionCount).toBe(10);
    expect(() =>
      dispatcher.submit(createDispatchPlan(createTaskRequest('task-0')), plana),
    ).toThrowError(DuplicateSubmissionError);
  });

  it('floors fractional cap and clamps non-positive cap to the documented minimum', () => {
    const plana = new Plana();
    // Floor: 2.9 → 2
    const fractional = new Dispatcher(inProcessNodeForRejectionTest(), {
      maxSubmittedTaskIds: 2.9,
    });
    fractional.submit(createDispatchPlan(createTaskRequest('f-1')), plana);
    fractional.submit(createDispatchPlan(createTaskRequest('f-2')), plana);
    fractional.submit(createDispatchPlan(createTaskRequest('f-3')), plana);
    expect(fractional.submissionCount).toBe(2);

    // Clamp: 0 → 1 (MIN_MAX_SUBMITTED_TASK_IDS)
    const zero = new Dispatcher(inProcessNodeForRejectionTest(), {
      maxSubmittedTaskIds: 0,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      zero.submit(createDispatchPlan(createTaskRequest('z-1')), plana);
      zero.submit(createDispatchPlan(createTaskRequest('z-2')), plana);
      expect(zero.submissionCount).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
