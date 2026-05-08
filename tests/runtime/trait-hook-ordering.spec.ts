/**
 * Risk 10 — regression coverage for the
 * `afterDispatch -> onTerminalEvidence` ordering invariant.
 *
 * Source contract (`src/runtime/agent-runtime.ts:172`):
 *   "onTerminalEvidence (after afterDispatch, provides annotation channel)."
 *
 * The runtime currently schedules each trait binding's `afterDispatch` and
 * `onTerminalEvidence` hooks as independent microtasks pushed into the
 * `pendingTraitLifecycleHooks` queue. The microtask insertion order — and
 * therefore the call order observed by the trait module — is what implements
 * the documented "after afterDispatch" guarantee for each binding.
 *
 * If a future refactor ever:
 *   - merges the two hooks into one await chain,
 *   - reorders the queue (e.g. dispatching onTerminalEvidence first),
 *   - or replaces the per-binding microtask scheduling with `Promise.all` /
 *     `allSettled` parallel admission,
 * the per-binding ordering invariant could silently break. These tests pin
 * it: any reordering or accidental concurrency that flips the per-binding
 * order will fail here before it lands.
 *
 * Scope (Risk 10 §06): regression coverage only. The tests do NOT change
 * runtime behavior. Each case uses the public AgentRuntime constructor +
 * Arona/Plana/Dispatcher entrypoint that production tasks travel through.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  Plana,
  type RuntimeDriver,
  type RuntimeDriverResult,
} from '../../src/index.js';
import type {
  TraitAfterDispatchHook,
  TraitDispatchHookContext,
  TraitOnTerminalEvidenceHook,
} from '../../src/contracts/trait-runtime-hook.js';
import type { TerminalEvidence } from '../../src/contracts/terminal-evidence.js';
import type { TraitModuleId } from '../../src/contracts/trait-module.js';
import { InProcessComputeNode } from '../../src/core/__test__/compute-node-test-doubles.js';
import { createTaskRequest } from '../helpers/dispatcher-core.js';

function buildSuccessDriver(): RuntimeDriver {
  return {
    async run(context): Promise<RuntimeDriverResult> {
      return {
        reason: 'trait-hook-ordering-test-driver',
        provenance: 'trait-hook-ordering-test-driver',
        cause: {
          kind: 'success',
          taskId: context.plan.taskId,
          runtimeInstanceId: context.instance.instanceId,
          observedAt: new Date().toISOString(),
          provenance: 'trait-hook-ordering-test-driver',
          artifactLocation: context.plan.artifactLocation ?? 'artifact://test',
        },
      };
    },
  };
}

const MODULE_A = 'trait.test.ordering.a.v1' as TraitModuleId;
const MODULE_B = 'trait.test.ordering.b.v1' as TraitModuleId;
const MODULE_C = 'trait.test.ordering.c.v1' as TraitModuleId;
const VERSION = '1.0.0';

/**
 * Returns the entries of `log` whose label matches the predicate, in
 * insertion order. Used to assert that `afterDispatch:*` entries appear
 * in declaration order ahead of `onTerminalEvidence:*` entries.
 */
function pickInOrder(log: readonly string[], predicate: (label: string) => boolean): string[] {
  return log.filter(predicate);
}

describe('Risk 10 — afterDispatch -> onTerminalEvidence ordering invariant', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs onTerminalEvidence strictly after afterDispatch for the same binding (single binding)', async () => {
    const log: string[] = [];
    const afterDispatch: TraitAfterDispatchHook = (
      ctx: TraitDispatchHookContext,
      evidence: TerminalEvidence,
    ) => {
      log.push(`afterDispatch:${ctx.moduleId}:${evidence.cause.kind}`);
    };
    const onTerminalEvidence: TraitOnTerminalEvidenceHook = (
      ctx: TraitDispatchHookContext,
      evidence: TerminalEvidence,
    ) => {
      log.push(`onTerminalEvidence:${ctx.moduleId}:${evidence.cause.kind}`);
      return null;
    };

    const arona = new Arona(
      new Plana(),
      new Dispatcher(
        new InProcessComputeNode(
          new AgentRuntime(buildSuccessDriver(), {
            traitLifecycleHooks: [
              {
                moduleId: MODULE_A,
                moduleVersion: VERSION,
                afterDispatch,
                onTerminalEvidence,
              },
            ],
          }),
        ),
      ),
    );

    const result = await arona.requestDispatch(
      createTaskRequest('task-trait-hook-order-single'),
    );
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    await result.submission.completion;

    const afterIdx = log.indexOf(`afterDispatch:${MODULE_A}:success`);
    const terminalIdx = log.indexOf(`onTerminalEvidence:${MODULE_A}:success`);
    expect(afterIdx).toBeGreaterThanOrEqual(0);
    expect(terminalIdx).toBeGreaterThanOrEqual(0);
    expect(terminalIdx).toBeGreaterThan(afterIdx);
  });

  it('keeps the per-binding ordering invariant across multiple bindings (interleaving allowed, swap forbidden)', async () => {
    const log: string[] = [];
    const buildBinding = (id: TraitModuleId) => ({
      moduleId: id,
      moduleVersion: VERSION,
      afterDispatch: ((ctx) => {
        log.push(`afterDispatch:${ctx.moduleId}`);
      }) as TraitAfterDispatchHook,
      onTerminalEvidence: ((ctx) => {
        log.push(`onTerminalEvidence:${ctx.moduleId}`);
        return null;
      }) as TraitOnTerminalEvidenceHook,
    });

    const arona = new Arona(
      new Plana(),
      new Dispatcher(
        new InProcessComputeNode(
          new AgentRuntime(buildSuccessDriver(), {
            traitLifecycleHooks: [
              buildBinding(MODULE_A),
              buildBinding(MODULE_B),
              buildBinding(MODULE_C),
            ],
          }),
        ),
      ),
    );

    const result = await arona.requestDispatch(
      createTaskRequest('task-trait-hook-order-multi'),
    );
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    await result.submission.completion;

    // Per-binding invariant: for every moduleId, afterDispatch must come
    // before onTerminalEvidence in the global log. Cross-binding interleaving
    // (afterDispatch_A, afterDispatch_B, onTerminalEvidence_A, ...) is
    // explicitly allowed by the contract — the runtime only documents
    // "after afterDispatch" per-binding, not a strict global pairing.
    for (const id of [MODULE_A, MODULE_B, MODULE_C] as const) {
      const afterIdx = log.indexOf(`afterDispatch:${id}`);
      const terminalIdx = log.indexOf(`onTerminalEvidence:${id}`);
      expect(afterIdx).toBeGreaterThanOrEqual(0);
      expect(terminalIdx).toBeGreaterThanOrEqual(0);
      expect(terminalIdx).toBeGreaterThan(afterIdx);
    }

    // Sanity: 6 entries total (3 bindings * 2 hooks) and no dupes per label.
    const labelSet = new Set(log);
    expect(log.length).toBe(6);
    expect(labelSet.size).toBe(6);
  });

  it('still runs onTerminalEvidence even when the same binding\'s afterDispatch throws (error containment does not skip the next hook)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log: string[] = [];
    const afterDispatch: TraitAfterDispatchHook = (ctx) => {
      log.push(`afterDispatch:${ctx.moduleId}`);
      throw new Error('boom in afterDispatch');
    };
    const onTerminalEvidence: TraitOnTerminalEvidenceHook = (ctx) => {
      log.push(`onTerminalEvidence:${ctx.moduleId}`);
      return null;
    };

    const arona = new Arona(
      new Plana(),
      new Dispatcher(
        new InProcessComputeNode(
          new AgentRuntime(buildSuccessDriver(), {
            traitLifecycleHooks: [
              {
                moduleId: MODULE_A,
                moduleVersion: VERSION,
                afterDispatch,
                onTerminalEvidence,
              },
            ],
          }),
        ),
      ),
    );

    const result = await arona.requestDispatch(
      createTaskRequest('task-trait-hook-order-after-throws'),
    );
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;
    expect(evidence.cause.kind).toBe('success');

    // Pin current behavior: afterDispatch throwing is contained via
    // console.warn, but onTerminalEvidence for the SAME binding still runs.
    // If a future refactor accidentally couples the two (e.g. chains them)
    // and an afterDispatch throw skips onTerminalEvidence, this assertion
    // will fail and surface the regression before it lands.
    const afterIdx = log.indexOf(`afterDispatch:${MODULE_A}`);
    const terminalIdx = log.indexOf(`onTerminalEvidence:${MODULE_A}`);
    expect(afterIdx).toBeGreaterThanOrEqual(0);
    expect(terminalIdx).toBeGreaterThanOrEqual(0);
    expect(terminalIdx).toBeGreaterThan(afterIdx);

    const containedWarn = warnSpy.mock.calls.find(
      ([label]) => label === 'trait-runtime-hook-threw',
    );
    expect(containedWarn).toBeDefined();
    expect(containedWarn?.[1]).toContain('afterDispatch');
  });

  it('runs onTerminalEvidence for binding A even when binding A has no afterDispatch but binding B does (sparse hooks)', async () => {
    const log: string[] = [];
    const arona = new Arona(
      new Plana(),
      new Dispatcher(
        new InProcessComputeNode(
          new AgentRuntime(buildSuccessDriver(), {
            traitLifecycleHooks: [
              {
                moduleId: MODULE_A,
                moduleVersion: VERSION,
                onTerminalEvidence: (ctx) => {
                  log.push(`onTerminalEvidence:${ctx.moduleId}`);
                  return null;
                },
              },
              {
                moduleId: MODULE_B,
                moduleVersion: VERSION,
                afterDispatch: (ctx) => {
                  log.push(`afterDispatch:${ctx.moduleId}`);
                },
              },
            ],
          }),
        ),
      ),
    );

    const result = await arona.requestDispatch(
      createTaskRequest('task-trait-hook-order-sparse'),
    );
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    await result.submission.completion;

    expect(log).toContain(`onTerminalEvidence:${MODULE_A}`);
    expect(log).toContain(`afterDispatch:${MODULE_B}`);
    // Module A has no afterDispatch, so its onTerminalEvidence is the only
    // entry for it; module B has no onTerminalEvidence. Sparse-hook
    // configurations must not trip the ordering machinery — each binding
    // is independent.
    expect(log.filter((line) => line.endsWith(`:${MODULE_A}`))).toHaveLength(1);
    expect(log.filter((line) => line.endsWith(`:${MODULE_B}`))).toHaveLength(1);
  });

  it('awaits both hooks before execute() returns (no fire-and-forget escape)', async () => {
    // Pinning the F1-drain invariant: the runtime must NOT return from
    // execute()/dispatch() while afterDispatch or onTerminalEvidence are
    // still pending. If a future refactor reverts to fire-and-forget the
    // log will be empty at the time we measure it here.
    const log: string[] = [];
    let afterDispatchSettled = false;
    let onTerminalSettled = false;

    const afterDispatch: TraitAfterDispatchHook = async (ctx) => {
      // Microtask delay so the hook does not synchronously finish before
      // execute() returns.
      await new Promise<void>((resolve) => setImmediate(resolve));
      log.push(`afterDispatch:${ctx.moduleId}`);
      afterDispatchSettled = true;
    };
    const onTerminalEvidence: TraitOnTerminalEvidenceHook = async (ctx) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      log.push(`onTerminalEvidence:${ctx.moduleId}`);
      onTerminalSettled = true;
      return null;
    };

    const arona = new Arona(
      new Plana(),
      new Dispatcher(
        new InProcessComputeNode(
          new AgentRuntime(buildSuccessDriver(), {
            traitLifecycleHooks: [
              {
                moduleId: MODULE_A,
                moduleVersion: VERSION,
                afterDispatch,
                onTerminalEvidence,
              },
            ],
          }),
        ),
      ),
    );

    const result = await arona.requestDispatch(
      createTaskRequest('task-trait-hook-order-drained'),
    );
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    await result.submission.completion;

    // submission.completion waits for execute()'s finally drain — both
    // hooks must already be settled at this point per F1.
    expect(afterDispatchSettled).toBe(true);
    expect(onTerminalSettled).toBe(true);
    const afterIdx = log.indexOf(`afterDispatch:${MODULE_A}`);
    const terminalIdx = log.indexOf(`onTerminalEvidence:${MODULE_A}`);
    expect(afterIdx).toBeGreaterThanOrEqual(0);
    expect(terminalIdx).toBeGreaterThanOrEqual(0);
    expect(terminalIdx).toBeGreaterThan(afterIdx);
  });

  it('binding ordering is preserved across declaration order (A before B before C)', async () => {
    const log: string[] = [];
    const arona = new Arona(
      new Plana(),
      new Dispatcher(
        new InProcessComputeNode(
          new AgentRuntime(buildSuccessDriver(), {
            traitLifecycleHooks: [
              {
                moduleId: MODULE_A,
                moduleVersion: VERSION,
                afterDispatch: (ctx) => {
                  log.push(`afterDispatch:${ctx.moduleId}`);
                },
                onTerminalEvidence: (ctx) => {
                  log.push(`onTerminalEvidence:${ctx.moduleId}`);
                  return null;
                },
              },
              {
                moduleId: MODULE_B,
                moduleVersion: VERSION,
                afterDispatch: (ctx) => {
                  log.push(`afterDispatch:${ctx.moduleId}`);
                },
                onTerminalEvidence: (ctx) => {
                  log.push(`onTerminalEvidence:${ctx.moduleId}`);
                  return null;
                },
              },
              {
                moduleId: MODULE_C,
                moduleVersion: VERSION,
                afterDispatch: (ctx) => {
                  log.push(`afterDispatch:${ctx.moduleId}`);
                },
                onTerminalEvidence: (ctx) => {
                  log.push(`onTerminalEvidence:${ctx.moduleId}`);
                  return null;
                },
              },
            ],
          }),
        ),
      ),
    );

    const result = await arona.requestDispatch(
      createTaskRequest('task-trait-hook-order-declaration'),
    );
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    await result.submission.completion;

    // afterDispatch fires in declaration order; onTerminalEvidence does too.
    // Combined with the per-binding ordering invariant, the global log must
    // pair afterDispatch_X before onTerminalEvidence_X for every X.
    expect(pickInOrder(log, (label) => label.startsWith('afterDispatch:'))).toEqual([
      `afterDispatch:${MODULE_A}`,
      `afterDispatch:${MODULE_B}`,
      `afterDispatch:${MODULE_C}`,
    ]);
    expect(pickInOrder(log, (label) => label.startsWith('onTerminalEvidence:'))).toEqual([
      `onTerminalEvidence:${MODULE_A}`,
      `onTerminalEvidence:${MODULE_B}`,
      `onTerminalEvidence:${MODULE_C}`,
    ]);
    for (const id of [MODULE_A, MODULE_B, MODULE_C] as const) {
      const afterIdx = log.indexOf(`afterDispatch:${id}`);
      const terminalIdx = log.indexOf(`onTerminalEvidence:${id}`);
      expect(terminalIdx).toBeGreaterThan(afterIdx);
    }
  });
});
