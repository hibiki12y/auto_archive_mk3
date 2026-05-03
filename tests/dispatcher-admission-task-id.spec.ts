/**
 * WU-M-INT — Dispatcher admission boundary owns taskId issuance (Option A).
 *
 * Spec: orchestrator dispatch "WU-M-INT (Option A — narrow seam)".
 *
 * Coverage:
 *   1. caller omits `plan.taskId` → dispatcher issues UUIDv7 `TaskId` and
 *      surfaces it on `acceptance` + lifecycle observer.
 *   2. caller provides valid UUIDv7 → preserved verbatim, branded.
 *   3. caller provides legacy non-UUIDv7 string → accepted via legacy-compat
 *      branch (no admission rejection); acceptance presents the same string.
 *   4. `generateTaskId()` is invoked EXACTLY once per `submit()` when the
 *      caller omits `plan.taskId` (BC-4 single-issuer at the actual seam).
 *   5. BC-5: two `submit()` calls with the same caller-supplied taskId reject
 *      the second via `DuplicateSubmissionError`.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  type ComputeAllocation,
  type ComputeNode,
  Dispatcher,
  DuplicateSubmissionError,
  InvalidLegacyTaskIdError,
  Plana,
  createDispatchPlan,
  createTerminalEvidence,
  type DispatchPlan,
  type TerminalEvidence,
} from '../src/index.js';
import {
  generateTaskId,
  isValidTaskId,
  type TaskId,
} from '../src/contracts/task-id.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

function createStubNode(): ComputeNode {
  return {
    capabilities: {
      kind: 'test-double',
      execution: {
        hasNetwork: true,
        hasFilesystemWrite: true,
        rootless: true,
      },
      capabilityFlags: [],
    },
    allocate: vi.fn(async (plan: DispatchPlan): Promise<ComputeAllocation> => ({
      allocationId: `stub-${plan.taskId}`,
      capability: {
        kind: 'test-double',
        execution: {
          hasNetwork: true,
          hasFilesystemWrite: true,
          rootless: true,
        },
        capabilityFlags: [],
      },
    })),
    dispatch: vi.fn(async (_allocation, plan: DispatchPlan): Promise<TerminalEvidence> => {
      const now = new Date().toISOString();
      return createTerminalEvidence({
        taskId: plan.taskId,
        runtimeInstanceId: `instance-${plan.taskId}`,
        reason: 'stub-success',
        provenance: 'admission-spec-stub',
        executionContext: {
          planCreatedAt: plan.createdAt,
          runtimeSettings: plan.runtimeSettings,
        },
        resourceEnvelope: plan.resourceEnvelope,
        startedAt: now,
        endedAt: now,
        cause: {
          kind: 'success',
          taskId: plan.taskId,
          runtimeInstanceId: `instance-${plan.taskId}`,
          observedAt: now,
          provenance: 'admission-spec-stub',
        },
      });
    }),
    observe: vi.fn(),
    cancel: vi.fn(async () => undefined),
  };
}

/**
 * Build a `DispatchPlan` whose `taskId` field is then dropped, modelling the
 * intended Option A admission shape (caller omits id; dispatcher issues).
 */
function planWithoutTaskId(label: string): Omit<DispatchPlan, 'taskId'> {
  // Use a placeholder for the underlying createDispatchPlan validator, then
  // strip it — `Dispatcher.submit()` accepts `taskId` as optional.
  const { taskId: _drop, ...rest } = createDispatchPlan(
    createTaskRequest(`placeholder-${label}`),
  );
  void _drop;
  return rest;
}

describe('Dispatcher admission boundary — taskId issuance (WU-M-INT Option A)', () => {
  it('issues a UUIDv7 TaskId when caller omits plan.taskId (#1)', async () => {
    const node = createStubNode();
    const dispatcher = new Dispatcher(node);
    const planAccepted: string[] = [];

    const submission = dispatcher.submit(planWithoutTaskId('omit'), new Plana(), {
      lifecycleObserver: (obs) => {
        if (obs.phase === 'accepted') {
          planAccepted.push(obs.taskId);
        }
      },
    });

    expect(isValidTaskId(submission.acceptance.taskId)).toBe(true);
    expect(planAccepted).toEqual([submission.acceptance.taskId]);
    await expect(submission.completion).resolves.toMatchObject({
      taskId: submission.acceptance.taskId,
    });
  });

  it('preserves a caller-supplied UUIDv7 verbatim and brands it (#2)', async () => {
    const node = createStubNode();
    const dispatcher = new Dispatcher(node);
    const callerId = generateTaskId();

    const plan: DispatchPlan = {
      ...planWithoutTaskId('uuid-resume'),
      taskId: callerId,
    };
    const submission = dispatcher.submit(plan, new Plana());

    expect(submission.acceptance.taskId).toBe(callerId);
    expect(isValidTaskId(submission.acceptance.taskId)).toBe(true);
    await submission.completion;
  });

  it('accepts legacy non-UUIDv7 caller string via legacy-compat branch (#3)', async () => {
    const node = createStubNode();
    const dispatcher = new Dispatcher(node);
    const legacyId = 'legacy-fixture-task-id';

    const plan: DispatchPlan = {
      ...planWithoutTaskId('legacy'),
      taskId: legacyId,
    };
    const submission = dispatcher.submit(plan, new Plana());

    // Acceptance presents the trusted string as a branded `TaskId` (the
    // documented legacy-trust cast inside the dispatcher). The string itself
    // is NOT UUIDv7-shaped, confirming we did NOT route through assertTaskId.
    expect(submission.acceptance.taskId).toBe(legacyId);
    expect(isValidTaskId(submission.acceptance.taskId)).toBe(false);
    await submission.completion;
  });

  it('rejects legacy taskId containing newline / shell metacharacters (#6 — F14 charset gate)', () => {
    const node = createStubNode();
    const dispatcher = new Dispatcher(node);
    const evilId = 'evil\nrm -rf /';

    const plan: DispatchPlan = {
      ...planWithoutTaskId('injection'),
      taskId: evilId,
    };

    expect(() => dispatcher.submit(plan, new Plana())).toThrowError(
      InvalidLegacyTaskIdError,
    );
  });

  it('invokes generateTaskId() EXACTLY once per submit when caller omits (#4 BC-4)', async () => {
    const node = createStubNode();
    const generator = vi.fn<() => TaskId>(() => generateTaskId());
    const dispatcher = new Dispatcher(node, { taskIdGenerator: generator });

    const submission = dispatcher.submit(planWithoutTaskId('bc4'), new Plana());

    expect(generator).toHaveBeenCalledTimes(1);
    expect(submission.acceptance.taskId).toBe(generator.mock.results[0]?.value);
    await submission.completion;
  });

  it('rejects duplicate caller-supplied taskId via DuplicateSubmissionError (#5 BC-5)', () => {
    const node = createStubNode();
    const dispatcher = new Dispatcher(node);
    const callerId = generateTaskId();

    const first = dispatcher.submit(
      { ...planWithoutTaskId('dup-1'), taskId: callerId },
      new Plana(),
    );
    expect(first.acceptance.taskId).toBe(callerId);

    expect(() =>
      dispatcher.submit(
        { ...planWithoutTaskId('dup-2'), taskId: callerId },
        new Plana(),
      ),
    ).toThrowError(DuplicateSubmissionError);
  });
});
