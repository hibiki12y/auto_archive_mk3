/**
 * M5a — Plugin hook tier 1 (3 lifecycle hooks).
 *
 * Verifies that AgentRuntime invokes the three new dispatch-lifecycle hooks
 * in the documented order, with module identity passed through, and that
 * throwing hooks are error-contained (do NOT propagate to the dispatcher).
 *
 * Hooks under test:
 *   - beforeDispatch  (called after observeSystemPrompt, before driver run)
 *   - afterDispatch   (called after TerminalEvidence is finalized)
 *   - onTerminalEvidence (called after afterDispatch; annotation channel)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  Plana,
  type RuntimeDriver,
  type RuntimeDriverResult,
} from '../src/index.js';
import {
  TRAIT_RUNTIME_HOOK_ALLOWLIST,
} from '../src/core/trait-module-loader.js';
import type {
  TraitAfterDispatchHook,
  TraitBeforeDispatchHook,
  TraitDispatchHookContext,
  TraitOnTerminalEvidenceHook,
} from '../src/contracts/trait-runtime-hook.js';
import type { TerminalEvidence } from '../src/contracts/terminal-evidence.js';
import type { TraitModuleId } from '../src/contracts/trait-module.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

function buildSuccessDriver(): RuntimeDriver {
  return {
    async run(context): Promise<RuntimeDriverResult> {
      return {
        reason: 'lifecycle-hook-test-driver',
        provenance: 'trait-runtime-hook-lifecycle-test-driver',
        cause: {
          kind: 'success',
          taskId: context.plan.taskId,
          runtimeInstanceId: context.instance.instanceId,
          observedAt: new Date().toISOString(),
          provenance: 'trait-runtime-hook-lifecycle-test-driver',
          artifactLocation: context.plan.artifactLocation ?? 'artifact://test',
        },
      };
    },
  };
}

const TEST_MODULE_ID = 'test-module' as TraitModuleId;
const TEST_MODULE_VERSION = '0.0.1';

describe('M5a — Tier-1 lifecycle hooks (beforeDispatch / afterDispatch / onTerminalEvidence)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes the three hook names in TRAIT_RUNTIME_HOOK_ALLOWLIST', () => {
    expect(TRAIT_RUNTIME_HOOK_ALLOWLIST).toEqual(
      expect.arrayContaining([
        'beforeDispatch',
        'afterDispatch',
        'onTerminalEvidence',
      ]),
    );
  });

  it('invokes all three hooks in order with the bound module identity', async () => {
    const callLog: string[] = [];

    const beforeDispatch: TraitBeforeDispatchHook = vi.fn((ctx: TraitDispatchHookContext) => {
      callLog.push(`before:${ctx.moduleId}@${ctx.moduleVersion}:${ctx.taskId}`);
      return null;
    });
    const afterDispatch: TraitAfterDispatchHook = vi.fn(
      (ctx: TraitDispatchHookContext, evidence: TerminalEvidence) => {
        callLog.push(
          `after:${ctx.moduleId}:${evidence.cause?.kind ?? 'unknown'}`,
        );
      },
    );
    const onTerminalEvidence: TraitOnTerminalEvidenceHook = vi.fn(
      (ctx: TraitDispatchHookContext, evidence: TerminalEvidence) => {
        callLog.push(
          `terminal:${ctx.moduleId}:${evidence.cause?.kind ?? 'unknown'}`,
        );
        return null;
      },
    );

    const driver = buildSuccessDriver();
    const arona = new Arona(
      new Plana(),
      new Dispatcher(
        new InProcessComputeNode(
          new AgentRuntime(driver, {
            traitLifecycleHooks: [
              {
                moduleId: TEST_MODULE_ID,
                moduleVersion: TEST_MODULE_VERSION,
                beforeDispatch,
                afterDispatch,
                onTerminalEvidence,
              },
            ],
          }),
        ),
      ),
    );

    const result = await arona.requestDispatch(
      createTaskRequest('task-m5a-hooks', { instruction: 'M5a hooks test' }),
    );
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    await result.submission.completion;
    // Allow microtask queue to flush so afterDispatch + onTerminalEvidence
    // (fire-and-forget) complete before assertions.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(beforeDispatch).toHaveBeenCalledTimes(1);
    expect(afterDispatch).toHaveBeenCalledTimes(1);
    expect(onTerminalEvidence).toHaveBeenCalledTimes(1);

    expect(callLog).toEqual([
      `before:${TEST_MODULE_ID}@${TEST_MODULE_VERSION}:task-m5a-hooks`,
      `after:${TEST_MODULE_ID}:success`,
      `terminal:${TEST_MODULE_ID}:success`,
    ]);
  });

  it('exposes the same runtimeInstanceId to beforeDispatch and afterDispatch / onTerminalEvidence (F3)', async () => {
    const seenInstanceIds: { hook: string; runtimeInstanceId: string }[] = [];

    const beforeDispatch: TraitBeforeDispatchHook = (ctx) => {
      seenInstanceIds.push({
        hook: 'before',
        runtimeInstanceId: ctx.runtimeInstanceId,
      });
      return null;
    };
    const afterDispatch: TraitAfterDispatchHook = (ctx) => {
      seenInstanceIds.push({
        hook: 'after',
        runtimeInstanceId: ctx.runtimeInstanceId,
      });
    };
    const onTerminalEvidence: TraitOnTerminalEvidenceHook = (ctx, evidence) => {
      seenInstanceIds.push({
        hook: 'terminal',
        runtimeInstanceId: ctx.runtimeInstanceId,
      });
      seenInstanceIds.push({
        hook: 'evidence',
        runtimeInstanceId: evidence.runtimeInstanceId,
      });
      return null;
    };

    const driver = buildSuccessDriver();
    const arona = new Arona(
      new Plana(),
      new Dispatcher(
        new InProcessComputeNode(
          new AgentRuntime(driver, {
            traitLifecycleHooks: [
              {
                moduleId: TEST_MODULE_ID,
                moduleVersion: TEST_MODULE_VERSION,
                beforeDispatch,
                afterDispatch,
                onTerminalEvidence,
              },
            ],
          }),
        ),
      ),
    );

    const result = await arona.requestDispatch(
      createTaskRequest('task-m5a-instance-id-correlation'),
    );
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    await result.submission.completion;
    // Allow the fire-and-forget afterDispatch + onTerminalEvidence chain to flush.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const ids = seenInstanceIds.map((entry) => entry.runtimeInstanceId);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(1);
  });

  it('contains a beforeDispatch throw and continues dispatching', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const driver = buildSuccessDriver();
    const arona = new Arona(
      new Plana(),
      new Dispatcher(
        new InProcessComputeNode(
          new AgentRuntime(driver, {
            traitLifecycleHooks: [
              {
                moduleId: TEST_MODULE_ID,
                moduleVersion: TEST_MODULE_VERSION,
                beforeDispatch: () => {
                  throw new Error('boom in beforeDispatch');
                },
              },
            ],
          }),
        ),
      ),
    );

    const result = await arona.requestDispatch(
      createTaskRequest('task-m5a-throws-before'),
    );
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;
    expect(evidence.cause?.kind).toBe('success');

    const containedWarn = warnSpy.mock.calls.find(
      ([label]) => label === 'trait-runtime-hook-threw',
    );
    expect(containedWarn).toBeDefined();
    expect(containedWarn?.[1]).toContain('beforeDispatch');
  });

  it('contains an afterDispatch throw and the runtime still returns evidence', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const driver = buildSuccessDriver();
    const arona = new Arona(
      new Plana(),
      new Dispatcher(
        new InProcessComputeNode(
          new AgentRuntime(driver, {
            traitLifecycleHooks: [
              {
                moduleId: TEST_MODULE_ID,
                moduleVersion: TEST_MODULE_VERSION,
                afterDispatch: () => {
                  throw new Error('boom in afterDispatch');
                },
              },
            ],
          }),
        ),
      ),
    );

    const result = await arona.requestDispatch(
      createTaskRequest('task-m5a-throws-after'),
    );
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;
    expect(evidence.cause?.kind).toBe('success');

    await new Promise<void>((resolve) => setImmediate(resolve));
    const containedWarn = warnSpy.mock.calls.find(
      ([label]) => label === 'trait-runtime-hook-threw',
    );
    expect(containedWarn).toBeDefined();
    expect(containedWarn?.[1]).toContain('afterDispatch');
  });

  it('logs an annotation when onTerminalEvidence returns one (warn-only channel)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const driver = buildSuccessDriver();
    const arona = new Arona(
      new Plana(),
      new Dispatcher(
        new InProcessComputeNode(
          new AgentRuntime(driver, {
            traitLifecycleHooks: [
              {
                moduleId: TEST_MODULE_ID,
                moduleVersion: TEST_MODULE_VERSION,
                onTerminalEvidence: () => ({
                  note: 'curator-evidence-attached',
                  evidence: { traitFamily: 'methodology' },
                }),
              },
            ],
          }),
        ),
      ),
    );

    const result = await arona.requestDispatch(
      createTaskRequest('task-m5a-annotation'),
    );
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    await result.submission.completion;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const annotationWarn = warnSpy.mock.calls.find(
      ([label]) =>
        label === 'trait-runtime-hook-onTerminalEvidence-annotation',
    );
    expect(annotationWarn).toBeDefined();
    expect(annotationWarn?.[1]).toContain('curator-evidence-attached');
  });

  it('omitting traitLifecycleHooks leaves the runtime fully functional', async () => {
    const driver = buildSuccessDriver();
    const arona = new Arona(
      new Plana(),
      new Dispatcher(
        new InProcessComputeNode(new AgentRuntime(driver)),
      ),
    );
    const result = await arona.requestDispatch(
      createTaskRequest('task-no-hooks'),
    );
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;
    expect(evidence.cause?.kind).toBe('success');
  });

  it('hooks for multiple modules invoke in declaration order', async () => {
    const callOrder: string[] = [];
    const driver = buildSuccessDriver();
    const arona = new Arona(
      new Plana(),
      new Dispatcher(
        new InProcessComputeNode(
          new AgentRuntime(driver, {
            traitLifecycleHooks: [
              {
                moduleId: 'module-A' as TraitModuleId,
                moduleVersion: '1.0.0',
                beforeDispatch: () => {
                  callOrder.push('A');
                  return null;
                },
              },
              {
                moduleId: 'module-B' as TraitModuleId,
                moduleVersion: '1.0.0',
                beforeDispatch: () => {
                  callOrder.push('B');
                  return null;
                },
              },
              {
                moduleId: 'module-C' as TraitModuleId,
                moduleVersion: '1.0.0',
                beforeDispatch: () => {
                  callOrder.push('C');
                  return null;
                },
              },
            ],
          }),
        ),
      ),
    );

    const result = await arona.requestDispatch(
      createTaskRequest('task-m5a-order'),
    );
    if (result.kind !== 'dispatched') return;
    await result.submission.completion;

    expect(callOrder).toEqual(['A', 'B', 'C']);
  });
});
