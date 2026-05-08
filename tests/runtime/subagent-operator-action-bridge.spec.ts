/**
 * P4 Stage 4-5 (Commit 3) — `/subagents kill <id>` invokes a real
 * per-child cancel via `roster.cancelActive(...)`; `/subagents send`
 * and `/subagents steer` return an explanatory `denied` because the
 * current provider session shape does not support mid-flight prompt
 * injection.
 *
 * Verifies the operator surface contract:
 *   - `kill <id>` on an active in-flight subagent (with a registered
 *     `RunChildHandle`) calls `cancelActive(...)` and returns ok.
 *   - `kill <id>` on a subagent without an in-flight handle (legacy
 *     spawn() without spawnAndRun, or already-terminated) returns
 *     denied with a clear reason.
 *   - `send <id> "..."` always returns denied with the explanatory
 *     reason; appendLog still records the attempt (audit trail).
 *   - `steer <id> "..."` always returns denied with the same reason.
 */
import { describe, expect, it, vi } from 'vitest';

import { createResourceEnvelope } from '../../src/contracts/resource-envelope.js';
import type { RuntimeDriverResult } from '../../src/contracts/runtime-driver.js';
import { createRuntimeSettingsBundle } from '../../src/contracts/runtime-settings.js';
import type { SubagentDescriptor } from '../../src/contracts/subagent-roster.js';
import { SubagentOperatorSurface } from '../../src/runtime/subagent-operator.js';
import {
  createSubagentRoster,
  type CreateSubagentRosterParentContext,
  type RunChildHandle,
} from '../../src/runtime/subagent-roster.js';

interface RunChildInput {
  readonly descriptor: SubagentDescriptor;
  readonly instruction: string;
  readonly parentContext: { readonly taskId: string; readonly instanceId: string };
}

function createParentContext(
  overrides: Partial<CreateSubagentRosterParentContext> = {},
): CreateSubagentRosterParentContext {
  return {
    taskId: 'task-action-bridge',
    instanceId: 'instance-action-bridge',
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

function makeAbortedResult(
  taskId: string,
  instanceId: string,
): RuntimeDriverResult {
  return {
    reason: 'child-runtime-veto',
    provenance: 'action-bridge-test-driver',
    cause: {
      kind: 'runtime-veto',
      taskId,
      runtimeInstanceId: instanceId,
      observedAt: new Date().toISOString(),
      provenance: 'action-bridge-test-driver',
      reason: 'operator-cancel',
      veto: {
        origin: 'runtime',
        reason: 'operator-cancel',
        provenance: 'action-bridge-test-driver',
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

describe('SubagentOperatorSurface — action bridge (Stage 4-5 Commit 3)', () => {
  it('kill <id> on an active in-flight subagent triggers cancelActive and returns ok', async () => {
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
          resolveResult?.(
            makeAbortedResult(
              `task-action-bridge.sub-${descriptor.subagentId}`,
              'child-instance-bridge',
            ),
          );
        },
      }),
    );
    const roster = createSubagentRoster(createParentContext({ runChild }));
    const operator = new SubagentOperatorSurface({ roster });

    // Kick off the child; do NOT await — kill happens mid-flight.
    const pending = roster.spawnAndRun({
      options: { role: 'explorer' },
      instruction: 'cancellable child',
    });
    // Yield twice so the runChild registers its handle in the roster.
    await Promise.resolve();
    await Promise.resolve();

    const result = await operator.kill('subagent-1', 'op kill via /subagents');
    expect(result.status).toBe('ok');
    expect(cancelSpy).toHaveBeenCalledWith('op kill via /subagents');

    // Drain the pending spawnAndRun so the test does not leak a
    // floating microtask chain.
    await pending;

    const log = operator.log('subagent-1');
    expect(log.status === 'ok' ? log.message : '').toContain(
      'kill (cancel signaled): op kill via /subagents',
    );
  });

  it('kill <id> on a non-active or unknown subagent returns denied', async () => {
    // Path A: legacy spawn-without-spawnAndRun. The roster has the
    // descriptor but no RunChildHandle was registered, so cancelActive
    // returns false; the operator surface translates that to denied.
    const rosterA = createSubagentRoster(createParentContext());
    const descriptorA = await rosterA.spawn({ role: 'coder' });
    const operatorA = new SubagentOperatorSurface({ roster: rosterA });
    const denyResult = await operatorA.kill(
      descriptorA.subagentId,
      'op kill on legacy spawn',
    );
    expect(denyResult.status).toBe('denied');
    expect(denyResult.status === 'denied' ? denyResult.reason : '').toContain(
      'not in an active dispatch state',
    );
    // Audit trail captured the denied attempt.
    const logA = operatorA.log(descriptorA.subagentId);
    expect(logA.status === 'ok' ? logA.message : '').toContain(
      'kill (denied): op kill on legacy spawn',
    );

    // Path B: unknown subagent id.
    const rosterB = createSubagentRoster(createParentContext());
    const operatorB = new SubagentOperatorSurface({ roster: rosterB });
    const notFoundResult = await operatorB.kill(
      'subagent-does-not-exist',
      'late kill',
    );
    expect(notFoundResult.status).toBe('not-found');
  });

  it('send <id> "..." returns denied with the explanatory reason; appendLog records the attempt', async () => {
    const roster = createSubagentRoster(createParentContext());
    const descriptor = await roster.spawn({ role: 'coder' });
    const operator = new SubagentOperatorSurface({ roster });

    const result = operator.send(
      descriptor.subagentId,
      'please continue with token sk-secret1234567890abcd',
    );
    expect(result.status).toBe('denied');
    if (result.status === 'denied') {
      expect(result.reason).toContain(
        'mid-flight injection is not supported',
      );
      expect(result.reason).toContain('/subagents kill');
    }

    // appendLog recorded the attempt (with secret redaction).
    const log = operator.log(descriptor.subagentId);
    expect(log.status).toBe('ok');
    if (log.status === 'ok') {
      expect(log.message).toContain('send (denied):');
      expect(log.message).toContain('[REDACTED_SECRET]');
      expect(log.message).not.toContain('sk-secret1234567890');
    }
  });

  it('steer <id> "..." returns denied with the same reason; appendLog records the attempt', async () => {
    const roster = createSubagentRoster(createParentContext());
    const descriptor = await roster.spawn({ role: 'coder' });
    const operator = new SubagentOperatorSurface({ roster });

    const result = operator.steer(
      descriptor.subagentId,
      'narrow scope to filesystem search only',
    );
    expect(result.status).toBe('denied');
    if (result.status === 'denied') {
      expect(result.reason).toContain(
        'mid-flight injection is not supported',
      );
      expect(result.reason).toContain('/subagents kill');
    }

    const log = operator.log(descriptor.subagentId);
    expect(log.status).toBe('ok');
    if (log.status === 'ok') {
      expect(log.message).toContain('steer (denied):');
      expect(log.message).toContain('narrow scope to filesystem search only');
    }
  });
});
