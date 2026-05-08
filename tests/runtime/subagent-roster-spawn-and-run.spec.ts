/**
 * P4 Stage 4-4 — `SubagentRoster.spawnAndRun(...)` activation.
 *
 * Verifies the roster's new admit-and-launch path:
 *
 *   - Happy path: stub `runChild` returns success → roster admits, runs,
 *     terminates with the result's cause, and returns {descriptor, result}.
 *   - Disabled path: when no `runChild` is wired into the parent context,
 *     `spawnAndRun(...)` throws a clear, actionable error.
 *   - Error path: `runChild` throws → roster synthesizes a
 *     `provider-failure` cause, calls `terminate(...)` to release the
 *     slot, and rethrows the original error so the caller observes it.
 *   - Admission deny: when the policy enforcer denies the spawn, the
 *     roster never invokes `runChild`.
 *   - Envelope narrowing: the descriptor passed to `runChild` carries
 *     the parent-narrowed envelope (the same shape as `spawn(...)`'s
 *     return).
 *   - Idempotency: after `spawnAndRun(...)` resolves, the descriptor is
 *     terminated; a second `roster.terminate(subagentId, ...)` call
 *     fails closed with a `RuntimeVetoError` (same invariant as the
 *     existing `spawn(...)` lifecycle).
 */
import { describe, expect, it, vi } from 'vitest';

import { createResourceEnvelope } from '../../src/contracts/resource-envelope.js';
import type { RuntimeDriverResult } from '../../src/contracts/runtime-driver.js';
import { createRuntimeSettingsBundle } from '../../src/contracts/runtime-settings.js';
import type { SubagentDescriptor } from '../../src/contracts/subagent-roster.js';
import { SubagentPolicyEnforcer } from '../../src/runtime/subagent-policy-enforcer.js';
import {
  createSubagentRoster,
  RuntimeVetoError,
  type CreateSubagentRosterParentContext,
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
    taskId: 'task-spawn-and-run',
    instanceId: 'instance-spawn-and-run',
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

function createPolicyEnforcer(
  overrides: { allowedRoles?: ReadonlyArray<'explorer' | 'coder' | 'writer' | 'verifier'> } = {},
): SubagentPolicyEnforcer {
  return new SubagentPolicyEnforcer({
    policy: {
      maxDepth: 1,
      maxConcurrent: 2,
      allowedRoles: overrides.allowedRoles ?? [
        'explorer',
        'coder',
        'writer',
        'verifier',
      ],
    },
    logger: () => {
      // Silence — these tests only assert spawn-path behavior.
    },
  });
}

function makeChildSuccessResult(
  taskId: string,
  instanceId: string,
): RuntimeDriverResult {
  return {
    reason: 'child-driver-success',
    provenance: 'spawn-and-run-stub-driver',
    cause: {
      kind: 'success',
      taskId,
      runtimeInstanceId: instanceId,
      observedAt: new Date().toISOString(),
      provenance: 'spawn-and-run-stub-driver',
    },
  };
}

describe('SubagentRoster — spawnAndRun (Stage 4-4)', () => {
  it('admits via spawn(), invokes runChild, terminates with the result cause, and returns {descriptor, result}', async () => {
    const runChild = vi.fn(
      async ({ descriptor, instruction, parentContext }: RunChildInput) => {
        expect(descriptor.role).toBe('explorer');
        expect(descriptor.parent.taskId).toBe('task-spawn-and-run');
        expect(descriptor.parent.instanceId).toBe('instance-spawn-and-run');
        expect(parentContext.taskId).toBe('task-spawn-and-run');
        expect(parentContext.instanceId).toBe('instance-spawn-and-run');
        expect(instruction).toBe('reply with hello');
        return makeChildSuccessResult(
          `task-spawn-and-run.sub-${descriptor.subagentId}`,
          'child-instance',
        );
      },
    );
    const roster = createSubagentRoster(
      createParentContext({ runChild }),
    );

    const out = await roster.spawnAndRun({
      options: { role: 'explorer' },
      instruction: 'reply with hello',
    });

    expect(runChild).toHaveBeenCalledTimes(1);
    expect(out.descriptor.subagentId).toBe('subagent-1');
    // The descriptor snapshot returned from spawn() captures the
    // 'active' state at admission time; the post-run termination
    // observable lives on the roster events / snapshot, not on this
    // immutable handle.
    expect(out.descriptor.state).toBe('active');
    expect(out.result.cause.kind).toBe('success');
    // Post-run, the subagent has been terminated and removed from
    // the active set, so snapshot() reports 'terminated' state.
    const live = roster
      .snapshot()
      .find((d) => d.subagentId === out.descriptor.subagentId);
    expect(live?.state).toBe('terminated');
    // After spawnAndRun resolves, the slot has been released:
    // a second admit must succeed.
    const followUp = await roster.spawn({ role: 'coder' });
    expect(followUp.subagentId).toBe('subagent-2');
  });

  it('throws a clear error when no runChild callback was wired into the parent context', async () => {
    const roster = createSubagentRoster(createParentContext());
    await expect(
      roster.spawnAndRun({
        options: { role: 'explorer' },
        instruction: 'should never run',
      }),
    ).rejects.toThrow(
      'subagent.spawnAndRun is not enabled: parent context did not provide a runChild callback (Stage 4-4)',
    );
    // Sanity: the error path must NOT have admitted a descriptor.
    expect(roster.snapshot()).toHaveLength(0);
  });

  it('synthesizes a provider-failure cause and rethrows when runChild throws', async () => {
    const runChildError = new Error('child-driver-blew-up');
    const runChild = vi.fn(async () => {
      throw runChildError;
    });
    const events: string[] = [];
    const roster = createSubagentRoster(
      createParentContext({ runChild }),
    );

    // Drain events in the background so the failed event surfaces.
    void (async () => {
      for await (const event of roster.events) {
        events.push(event.kind);
        if (events.length >= 3) {
          break;
        }
      }
    })();

    await expect(
      roster.spawnAndRun({
        options: { role: 'explorer' },
        instruction: 'will throw',
      }),
    ).rejects.toBe(runChildError);

    // Slot was released — a follow-up spawn succeeds.
    const followUp = await roster.spawn({ role: 'explorer' });
    expect(followUp.subagentId).toBe('subagent-2');

    // Yield once so the background event-drain has a chance to run.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toContain('subagent.spawned');
    expect(events).toContain('subagent.failed');
  });

  it('does not invoke runChild when the policy enforcer denies admission', async () => {
    const runChild = vi.fn(async () =>
      makeChildSuccessResult('never', 'never'),
    );
    const roster = createSubagentRoster(
      createParentContext({
        runChild,
        // Allow only 'verifier' so a 'coder' spawn is denied.
        policyEnforcer: createPolicyEnforcer({ allowedRoles: ['verifier'] }),
      }),
    );

    await expect(
      roster.spawnAndRun({
        options: { role: 'coder' },
        instruction: 'should never reach runChild',
      }),
    ).rejects.toBeInstanceOf(RuntimeVetoError);
    expect(runChild).not.toHaveBeenCalled();
    expect(roster.snapshot()).toHaveLength(0);
  });

  it('passes a descriptor with the parent-narrowed envelope into runChild', async () => {
    let observedEnvelope: unknown;
    const runChild = vi.fn(async ({ descriptor }: RunChildInput) => {
      observedEnvelope = descriptor.envelope;
      return makeChildSuccessResult(
        `task-spawn-and-run.sub-${descriptor.subagentId}`,
        'child-instance',
      );
    });
    const parent = createParentContext({ runChild });
    const roster = createSubagentRoster(parent);
    const out = await roster.spawnAndRun({
      options: { role: 'explorer' },
      instruction: 'inspect envelope',
    });

    expect(observedEnvelope).toBeDefined();
    // The descriptor's envelope is frozen and shape-equal to the
    // parent's planned envelope (the parent context's envelope is the
    // single source of truth at admission time).
    expect(out.descriptor.envelope).toEqual(observedEnvelope);
    expect(Object.isFrozen(out.descriptor.envelope)).toBe(true);
    expect(out.descriptor.envelope.requested.cpuCores).toBe(
      parent.envelope.requested.cpuCores,
    );
  });

  it('rejects a follow-up roster.terminate(...) on the same subagentId after spawnAndRun resolves', async () => {
    const runChild = vi.fn(async ({ descriptor }: RunChildInput) =>
      makeChildSuccessResult(
        `task-spawn-and-run.sub-${descriptor.subagentId}`,
        'child-instance',
      ),
    );
    const roster = createSubagentRoster(
      createParentContext({ runChild }),
    );
    const out = await roster.spawnAndRun({
      options: { role: 'explorer' },
      instruction: 'one-shot',
    });

    // The descriptor was already terminated by spawnAndRun; a second
    // terminate(...) must fail closed (forged-subagent-id veto path).
    await expect(
      roster.terminate(out.descriptor.subagentId, {
        kind: 'external-cancel',
        taskId: 'task-spawn-and-run',
        runtimeInstanceId: 'instance-spawn-and-run',
        observedAt: new Date().toISOString(),
        provenance: 'test',
        reason: 'should be rejected',
        requestedAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(RuntimeVetoError);
  });
});
