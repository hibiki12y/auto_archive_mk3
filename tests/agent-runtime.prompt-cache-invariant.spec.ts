/**
 * M3 integration — verifies that AgentRuntime calls the prompt-cache invariant
 * port at the documented boundaries:
 *   1. observeSystemPrompt(plan.taskId, 0, plan.instruction) at execute() entry
 *   2. freezeSystemPrompt(plan.taskId) immediately before driver.run()
 *
 * Cross-dispatch mutation detection is structurally prevented by the
 * dispatcher's DuplicateSubmissionError (single-use session model), so the
 * runtime's job is just to surface the right hooks at the right time. The
 * deeper violation-detection semantics live in tests/prompt-cache-invariant.spec.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  Plana,
  type RuntimeDriver,
  type RuntimeDriverResult,
} from '../src/index.js';
import {
  createPromptCacheInvariant,
  type PromptCacheInvariantPort,
} from '../src/runtime/prompt-cache-invariant.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

function buildSuccessDriver(): RuntimeDriver {
  return {
    async run(context): Promise<RuntimeDriverResult> {
      return {
        reason: 'integration-driver',
        provenance: 'prompt-cache-invariant-integration-driver',
        cause: {
          kind: 'success',
          taskId: context.plan.taskId,
          runtimeInstanceId: context.instance.instanceId,
          observedAt: new Date().toISOString(),
          provenance: 'prompt-cache-invariant-integration-driver',
          artifactLocation: context.plan.artifactLocation ?? 'artifact://test',
        },
      };
    },
  };
}

describe('AgentRuntime + prompt-cache invariant integration (M3)', () => {
  it('calls observeSystemPrompt at execute() entry and freezeSystemPrompt before driver.run()', async () => {
    const observeSpy = vi.fn();
    const freezeSpy = vi.fn();

    let driverInvokedAt = -1;
    const callOrder: string[] = [];

    const wrappedInvariant: PromptCacheInvariantPort = {
      mode: 'warn',
      observeSystemPrompt(taskId, turn, prompt) {
        observeSpy(taskId, turn, prompt);
        callOrder.push(`observe:${taskId}`);
      },
      freezeSystemPrompt(taskId) {
        freezeSpy(taskId);
        callOrder.push(`freeze:${taskId}`);
      },
      rotateSession(_event) {
        // unused in this test
      },
      getViolations() {
        return [];
      },
      drainPendingObserveHooks() {
        return Promise.resolve();
      },
    };

    const driver: RuntimeDriver = {
      async run(context): Promise<RuntimeDriverResult> {
        driverInvokedAt = callOrder.length;
        callOrder.push(`driver:${context.plan.taskId}`);
        return {
          reason: 'integration-driver',
          provenance: 'prompt-cache-invariant-integration-driver',
          cause: {
            kind: 'success',
            taskId: context.plan.taskId,
            runtimeInstanceId: context.instance.instanceId,
            observedAt: new Date().toISOString(),
            provenance: 'prompt-cache-invariant-integration-driver',
            artifactLocation:
              context.plan.artifactLocation ?? 'artifact://test',
          },
        };
      },
    };

    const arona = new Arona(
      new Plana(),
      new Dispatcher(
        new InProcessComputeNode(
          new AgentRuntime(driver, {
            promptCacheInvariant: wrappedInvariant,
          }),
        ),
      ),
    );

    const result = await arona.requestDispatch(
      createTaskRequest('task-m3-wiring', {
        instruction: 'M3 WIRING INSTRUCTION',
      }),
    );
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    await result.submission.completion;

    expect(observeSpy).toHaveBeenCalledTimes(1);
    expect(observeSpy).toHaveBeenCalledWith(
      'task-m3-wiring',
      0,
      'M3 WIRING INSTRUCTION',
    );
    expect(freezeSpy).toHaveBeenCalledTimes(1);
    expect(freezeSpy).toHaveBeenCalledWith('task-m3-wiring');

    expect(callOrder).toEqual([
      'observe:task-m3-wiring',
      'freeze:task-m3-wiring',
      'driver:task-m3-wiring',
    ]);
    expect(driverInvokedAt).toBe(2);
  });

  it('records zero violations on a single well-formed dispatch (warn mode)', async () => {
    const invariant = createPromptCacheInvariant({ mode: 'warn' });
    const driver = buildSuccessDriver();
    const arona = new Arona(
      new Plana(),
      new Dispatcher(
        new InProcessComputeNode(
          new AgentRuntime(driver, {
            promptCacheInvariant: invariant,
          }),
        ),
      ),
    );

    const result = await arona.requestDispatch(
      createTaskRequest('task-m3-clean', {
        instruction: 'CLEAN INSTRUCTION',
      }),
    );
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    await result.submission.completion;

    expect(invariant.getViolations()).toHaveLength(0);
  });

  it('omitting the invariant option leaves the runtime fully functional', async () => {
    const driver = buildSuccessDriver();
    const arona = new Arona(
      new Plana(),
      new Dispatcher(
        new InProcessComputeNode(new AgentRuntime(driver)),
      ),
    );

    const result = await arona.requestDispatch(
      createTaskRequest('task-no-invariant', {
        instruction: 'no-invariant test',
      }),
    );
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;
    expect(evidence.cause?.kind).toBe('success');
  });
});
