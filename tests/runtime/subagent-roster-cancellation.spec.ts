/**
 * P4 Stage 4-5 (Commit 1) — `SubagentRoster.cancelActive(...)` and the
 * `RunChildHandle` shape returned from `runChild`.
 *
 * Verifies:
 *   - Legacy `runChild` shape (returns a bare `RuntimeDriverResult`):
 *     `cancelActive(...)` returns `false` because no cancel hook was
 *     registered. The roster MUST still finish the spawnAndRun cleanly.
 *   - Stage 4-5 `RunChildHandle` shape: `cancelActive(...)` invokes the
 *     handle's `cancel(reason)` and returns `true`. The handle's
 *     `result` promise can then resolve with whatever cause the child
 *     surfaces (here: a runtime-veto cause from the child runtime side).
 *   - After `spawnAndRun(...)` resolves, the active-handle table no
 *     longer carries the entry — a follow-up `cancelActive(...)` for
 *     the same subagentId returns `false`.
 *   - `terminateAll(...)` drains the active-handle table and invokes
 *     every registered child's `cancel('parent terminating')`.
 */
import { describe, expect, it, vi } from 'vitest';

import { createResourceEnvelope } from '../../src/contracts/resource-envelope.js';
import type { RuntimeDriverResult } from '../../src/contracts/runtime-driver.js';
import { createRuntimeSettingsBundle } from '../../src/contracts/runtime-settings.js';
import type { SubagentDescriptor } from '../../src/contracts/subagent-roster.js';
import {
  createSubagentRoster,
  type CreateSubagentRosterParentContext,
  type RunChildHandle,
} from '../../src/runtime/subagent-roster.js';

type RunChildInput = {
  readonly descriptor: SubagentDescriptor;
  readonly instruction: string;
  readonly parentContext: { readonly taskId: string; readonly instanceId: string };
};

function createParentContext(
  overrides: Partial<CreateSubagentRosterParentContext> = {},
): CreateSubagentRosterParentContext {
  return {
    taskId: 'task-cancel-active',
    instanceId: 'instance-cancel-active',
    envelope: createResourceEnvelope({
      requested: { cpuCores: 4, memoryMiB: 4096, wallTimeSec: 3600, gpuCards: 0 },
      effective: { cpuCores: 2, memoryMiB: 2048, wallTimeSec: 1200, gpuCards: 0 },
      observed: { cpuCoresPeak: 1, memoryMiBPeak: 1024, wallTimeSec: 64 },
    }),
    runtimeSettings: createRuntimeSettingsBundle({
      networkProfile: 'offline',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      workingDirectory: '/workspace/project',
    }),
    spawnAuthority: 'root',
    parentDepth: 0,
    ...overrides,
  };
}

function makeChildSuccessResult(
  taskId: string,
  instanceId: string,
): RuntimeDriverResult {
  return {
    reason: 'child-driver-success',
    provenance: 'cancel-active-stub-driver',
    cause: {
      kind: 'success',
      taskId,
      runtimeInstanceId: instanceId,
      observedAt: new Date().toISOString(),
      provenance: 'cancel-active-stub-driver',
    },
  };
}

function makeChildAbortedResult(
  taskId: string,
  instanceId: string,
): RuntimeDriverResult {
  return {
    reason: 'child-runtime-veto',
    provenance: 'cancel-active-stub-driver',
    cause: {
      kind: 'runtime-veto',
      taskId,
      runtimeInstanceId: instanceId,
      observedAt: new Date().toISOString(),
      provenance: 'cancel-active-stub-driver',
      reason: 'operator-cancel',
      veto: {
        origin: 'runtime',
        reason: 'operator-cancel',
        provenance: 'cancel-active-stub-driver',
        propagation: {
          blocksSubmission: false,
          requestsCancellation: true,
          requestsTermination: true,
        },
      },
      cancellation: {
        requestedAt: new Date().toISOString(),
        cancelMode: 'preemptive',
        cancelDetail: { originPort: 'plana-runtime-review' },
      },
    },
  };
}

describe('SubagentRoster.cancelActive — Stage 4-5 (Commit 1)', () => {
  it('legacy runChild (bare RuntimeDriverResult) — cancelActive returns false', async () => {
    const runChild = vi.fn(async ({ descriptor }: RunChildInput) =>
      makeChildSuccessResult(
        `task-cancel-active.sub-${descriptor.subagentId}`,
        'child-instance',
      ),
    );
    const roster = createSubagentRoster(createParentContext({ runChild }));

    const out = await roster.spawnAndRun({
      options: { role: 'explorer' },
      instruction: 'legacy runChild path',
    });
    expect(out.descriptor.subagentId).toBe('subagent-1');
    // After spawnAndRun resolved, the descriptor was terminated; calling
    // cancelActive can never find a handle for a legacy-shape return.
    expect(roster.cancelActive('subagent-1', 'late op kill')).toBe(false);
    expect(roster.cancelActive('does-not-exist', 'late op kill')).toBe(false);
  });

  it('RunChildHandle return — cancelActive invokes the handle cancel and returns true', async () => {
    const cancelSpy = vi.fn();
    let resolveResult: ((value: RuntimeDriverResult) => void) | undefined;
    const childResult = new Promise<RuntimeDriverResult>((resolve) => {
      resolveResult = resolve;
    });

    const runChild = vi.fn(
      async ({ descriptor }: RunChildInput): Promise<RunChildHandle> => ({
        result: childResult,
        cancel: (reason: string) => {
          cancelSpy(reason);
          // Real runtime would surface this through isAborted(); we
          // simulate by resolving with a runtime-veto cause.
          resolveResult?.(
            makeChildAbortedResult(
              `task-cancel-active.sub-${descriptor.subagentId}`,
              'child-instance-handle',
            ),
          );
        },
      }),
    );
    const roster = createSubagentRoster(createParentContext({ runChild }));

    // Kick off the child but don't await — we want to cancel mid-flight.
    const pending = roster.spawnAndRun({
      options: { role: 'explorer' },
      instruction: 'cancellable runChild path',
    });
    // Yield once so the runChild callback registers its handle.
    await Promise.resolve();
    await Promise.resolve();

    expect(roster.cancelActive('subagent-1', 'op kill from test')).toBe(true);
    expect(cancelSpy).toHaveBeenCalledWith('op kill from test');

    const out = await pending;
    expect(out.result.cause.kind).toBe('runtime-veto');
    // Roster's terminate(...) mapped runtime-veto → 'aborted', so the
    // descriptor's lifecycle landed in 'terminated' state.
    expect(roster.snapshot()[0]?.state).toBe('terminated');
  });

  it('after spawnAndRun completes successfully, cancelActive returns false (handle was cleaned up)', async () => {
    const cancelSpy = vi.fn();
    const runChild = vi.fn(
      async ({ descriptor }: RunChildInput): Promise<RunChildHandle> => ({
        result: Promise.resolve(
          makeChildSuccessResult(
            `task-cancel-active.sub-${descriptor.subagentId}`,
            'child-instance-clean',
          ),
        ),
        cancel: cancelSpy,
      }),
    );
    const roster = createSubagentRoster(createParentContext({ runChild }));

    await roster.spawnAndRun({
      options: { role: 'explorer' },
      instruction: 'clean run completes before cancel',
    });
    // Handle is removed in spawnAndRun's finally-block before the
    // post-run terminate(...) call.
    expect(roster.cancelActive('subagent-1', 'late op kill')).toBe(false);
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('terminateAll cancels every still-active child handle', async () => {
    const cancelA = vi.fn();
    const cancelB = vi.fn();
    const stillPendingA = new Promise<RuntimeDriverResult>(() => {
      // never resolves on its own — cancel is the only completion path
    });
    const stillPendingB = new Promise<RuntimeDriverResult>(() => {});

    let nextCancel: typeof cancelA = cancelA;
    let nextResult: Promise<RuntimeDriverResult> = stillPendingA;
    const runChild = vi.fn(
      async (): Promise<RunChildHandle> => {
        const handle: RunChildHandle = {
          result: nextResult,
          cancel: nextCancel,
        };
        // Swap to the second child for the second invocation.
        nextCancel = cancelB;
        nextResult = stillPendingB;
        return handle;
      },
    );
    const roster = createSubagentRoster(createParentContext({ runChild }));

    // Two concurrent admits; we ignore the pending results because
    // terminateAll's cancel signal is what we're verifying.
    void roster.spawnAndRun({
      options: { role: 'explorer' },
      instruction: 'A',
    });
    await Promise.resolve();
    await Promise.resolve();
    void roster.spawnAndRun({
      options: { role: 'coder' },
      instruction: 'B',
    });
    await Promise.resolve();
    await Promise.resolve();

    // Note: terminateAll synchronously walks the active-handle table
    // BEFORE awaiting any per-descriptor terminate(...) promise; the
    // cancel hooks fire immediately upon entry.
    const terminationCause = {
      kind: 'external-cancel' as const,
      taskId: 'task-cancel-active',
      runtimeInstanceId: 'instance-cancel-active',
      observedAt: new Date().toISOString(),
      provenance: 'test-terminate-all',
      reason: 'parent abort',
      requestedAt: new Date().toISOString(),
    };
    void roster.terminateAll(terminationCause);
    await Promise.resolve();

    expect(cancelA).toHaveBeenCalledWith('parent terminating');
    expect(cancelB).toHaveBeenCalledWith('parent terminating');
    // After terminateAll, the active-handle table is empty: a follow-up
    // cancelActive returns false.
    expect(roster.cancelActive('subagent-1', 'late')).toBe(false);
    expect(roster.cancelActive('subagent-2', 'late')).toBe(false);
  });
});
