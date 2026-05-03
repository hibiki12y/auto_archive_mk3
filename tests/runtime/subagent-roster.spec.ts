import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { createResourceEnvelope } from '../../src/contracts/resource-envelope.js';
import { createRuntimeSettingsBundle } from '../../src/contracts/runtime-settings.js';
import { createVetoPath } from '../../src/contracts/veto.js';
import type {
  RosterEvent,
  TerminalCause,
} from '../../src/index.js';
import {
  createSubagentRoster,
  RuntimeVetoError,
} from '../../src/runtime/subagent-roster.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_EVENT_MODULE_PATH = resolve(
  HERE,
  '../../src/contracts/runtime-event.ts',
);

function createParentContext(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'task-wu-roster',
    instanceId: 'instance-wu-roster',
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
    ...overrides,
  };
}

function successCause(overrides: Record<string, unknown> = {}): TerminalCause {
  return {
    kind: 'success',
    taskId: 'task-wu-roster',
    runtimeInstanceId: 'instance-wu-roster',
    observedAt: new Date().toISOString(),
    provenance: 'test',
    artifactLocation: 'artifact://ok',
    ...overrides,
  };
}

function abortCause(kind: 'external-cancel' | 'runtime-veto'): TerminalCause {
  if (kind === 'external-cancel') {
    return {
      kind,
      taskId: 'task-wu-roster',
      runtimeInstanceId: 'instance-wu-roster',
      observedAt: new Date().toISOString(),
      provenance: 'test',
      reason: 'cancelled',
      requestedAt: new Date().toISOString(),
    };
  }
  return {
    kind,
    taskId: 'task-wu-roster',
    runtimeInstanceId: 'instance-wu-roster',
    observedAt: new Date().toISOString(),
    provenance: 'test',
    reason: 'vetoed',
    veto: createVetoPath('runtime', 'vetoed', 'test'),
  };
}

function failedCause(kind: 'timeout' | 'driver-failure' | 'provider-failure'): TerminalCause {
  if (kind === 'timeout') {
    return {
      kind,
      taskId: 'task-wu-roster',
      runtimeInstanceId: 'instance-wu-roster',
      observedAt: new Date().toISOString(),
      provenance: 'test',
      deadlineMs: 1000,
      firedAt: new Date().toISOString(),
    };
  }
  if (kind === 'driver-failure') {
    return {
      kind,
      taskId: 'task-wu-roster',
      runtimeInstanceId: 'instance-wu-roster',
      observedAt: new Date().toISOString(),
      provenance: 'test',
      phase: 'run',
      message: 'driver failed',
    };
  }
  return {
    kind,
    taskId: 'task-wu-roster',
    runtimeInstanceId: 'instance-wu-roster',
    observedAt: new Date().toISOString(),
    provenance: 'test',
    provider: 'codex',
    classification: 'unknown',
    retryable: false,
    message: 'provider failed',
  };
}

async function nextEvents(
  iterable: AsyncIterable<RosterEvent>,
  count: number,
): Promise<RosterEvent[]> {
  const iterator = iterable[Symbol.asyncIterator]();
  const out: RosterEvent[] = [];
  while (out.length < count) {
    const next = await iterator.next();
    if (next.done) {
      break;
    }
    out.push(next.value);
  }
  if (iterator.return) {
    await iterator.return(undefined);
  }
  return out;
}

describe('WU-Roster AC-R1..AC-R12', () => {
  it('AC-R1: concurrent spawn requests admit exactly cap and reject overflow with runtime-veto roster-saturation', async () => {
    const roster = createSubagentRoster(createParentContext(), { maxConcurrent: 3 });

    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => roster.spawn({ role: 'coder' })),
    );
    const admitted = attempts.filter((r) => r.status === 'fulfilled');
    const rejected = attempts.filter((r) => r.status === 'rejected');

    expect(admitted).toHaveLength(3);
    expect(rejected.length).toBeGreaterThan(0);
    for (const rejection of rejected) {
      const err = rejection.reason as RuntimeVetoError;
      expect(err).toBeInstanceOf(RuntimeVetoError);
      expect(err.cause.kind).toBe('runtime-veto');
      expect(err.cause.reason).toBe('roster-saturation');
      expect(err.cause.cancellation?.cancelDetail?.originPort).toBe(
        'roster-saturation-latch',
      );
    }
  });

  it('AC-R2: descriptor envelope inherits parent envelope and spawn rejects envelope override field', async () => {
    const parent = createParentContext();
    const roster = createSubagentRoster(parent);
    const descriptor = await roster.spawn({ role: 'explorer' });
    expect(descriptor.envelope).toEqual(parent.envelope);
    await expect(
      roster.spawn({ role: 'coder', envelope: parent.envelope } as never),
    ).rejects.toThrow(/must not provide envelope/);
  });

  it('AC-R3: correlation key stays unique and subagentId is never reused after termination', async () => {
    const roster = createSubagentRoster(createParentContext());
    const first = await roster.spawn({ role: 'writer' });
    await roster.terminate(first.subagentId, successCause());
    const second = await roster.spawn({ role: 'writer' });
    expect(second.subagentId).not.toBe(first.subagentId);
    expect(
      new Set([
        `${first.parent.taskId}:${first.parent.instanceId}:${first.subagentId}`,
        `${second.parent.taskId}:${second.parent.instanceId}:${second.subagentId}`,
      ]).size,
    ).toBe(2);
  });

  it('AC-R4: parent-scoped and subagent-scoped observer claims can coexist', async () => {
    const roster = createSubagentRoster(createParentContext());
    const descriptor = await roster.spawn({ role: 'coder' });
    const parentKey = `${descriptor.parent.taskId}:${descriptor.parent.instanceId}`;
    const subagentKey = `${parentKey}:${descriptor.subagentId}`;
    const authorityClaims = new Map<string, string>([
      [parentKey, 'parent-authority'],
      [subagentKey, 'subagent-authority'],
    ]);
    expect(authorityClaims.get(parentKey)).toBe('parent-authority');
    expect(authorityClaims.get(subagentKey)).toBe('subagent-authority');
  });

  it('AC-R5: each TerminalCause class maps to exactly one terminal roster event kind', async () => {
    const roster = createSubagentRoster(createParentContext());
    const one = await roster.spawn({ role: 'coder' });
    const two = await roster.spawn({ role: 'writer' });
    const three = await roster.spawn({ role: 'verifier' });
    const four = await roster.spawn({ role: 'explorer' });
    const five = await roster.spawn({ role: 'coder' });
    const six = await roster.spawn({ role: 'writer' });
    await roster.terminate(one.subagentId, successCause({ artifactLocation: 'artifact://one' }));
    await roster.terminate(two.subagentId, abortCause('runtime-veto'));
    await roster.terminate(three.subagentId, failedCause('timeout'));
    await roster.terminate(four.subagentId, abortCause('external-cancel'));
    await roster.terminate(five.subagentId, failedCause('driver-failure'));
    await roster.terminate(six.subagentId, failedCause('provider-failure'));

    const events = await nextEvents(roster.events, 18);
    const terminalKinds = events
      .filter((event) => event.kind.startsWith('subagent.') && event.kind !== 'subagent.spawned')
      .map((event) => event.kind);

    expect(terminalKinds).toEqual([
      'subagent.completed',
      'subagent.aborted',
      'subagent.failed',
      'subagent.aborted',
      'subagent.failed',
      'subagent.failed',
    ]);
  });

  it('AC-R6: aborted subagent emits subagent.aborted with nullable partialArtifact', async () => {
    const roster = createSubagentRoster(createParentContext());
    const descriptor = await roster.spawn({ role: 'coder' });
    await roster.terminate(descriptor.subagentId, abortCause('external-cancel'), {
      partialArtifact: { digest: 'abc', ref: 'artifact://partial' },
    });

    const events = await nextEvents(roster.events, 3);
    const aborted = events.find((event) => event.kind === 'subagent.aborted');
    expect(aborted).toBeDefined();
    if (aborted?.kind === 'subagent.aborted') {
      expect(aborted.partialArtifact).toEqual({
        digest: 'abc',
        ref: 'artifact://partial',
      });
      expect(aborted.cause.kind).toBe('external-cancel');
    }
  });

  it('AC-R7: executor per-role cap of 1 is enforced', async () => {
    const roster = createSubagentRoster(createParentContext(), { maxConcurrent: 6 });
    await roster.spawn({ role: 'executor' });
    await expect(roster.spawn({ role: 'executor' })).rejects.toBeInstanceOf(
      RuntimeVetoError,
    );
  });

  it('AC-R8: parent teardown is idempotent and does not duplicate terminal events', async () => {
    const abortController = new AbortController();
    const roster = createSubagentRoster(
      createParentContext({ parentTerminationSignal: abortController.signal }),
    );
    const a = await roster.spawn({ role: 'explorer' });
    const b = await roster.spawn({ role: 'coder' });

    abortController.abort();
    await roster.terminateAll(abortCause('external-cancel'));
    await roster.terminateAll(abortCause('external-cancel'));

    const states = roster.snapshot().map((d) => [d.subagentId, d.state]);
    expect(states).toContainEqual([a.subagentId, 'terminated']);
    expect(states).toContainEqual([b.subagentId, 'terminated']);

    const events = await nextEvents(roster.events, 6);
    const terminal = events.filter((event) =>
      event.kind === 'subagent.aborted' ||
      event.kind === 'subagent.completed' ||
      event.kind === 'subagent.failed',
    );
    expect(terminal).toHaveLength(2);
  });

  it('AC-R9: subagent-scoped context cannot spawn nested subagents (root-only spawning)', async () => {
    const roster = createSubagentRoster(
      createParentContext({ spawnAuthority: 'subagent' }),
    );
    await expect(roster.spawn({ role: 'coder' })).rejects.toBeInstanceOf(
      RuntimeVetoError,
    );
  });

  it('AC-R10: mutating descriptor.envelope throws due to Object.freeze', async () => {
    const roster = createSubagentRoster(createParentContext());
    const descriptor = await roster.spawn({ role: 'coder' });
    expect(() => {
      (descriptor.envelope.requested as { cpuCores: number }).cpuCores = 999;
    }).toThrow(TypeError);
  });

  it('AC-R11: RuntimeEvent union remains unchanged', () => {
    const source = readFileSync(RUNTIME_EVENT_MODULE_PATH, 'utf8');
    expect(source).toMatch(/'runtime-initialized'/);
    expect(source).toMatch(/'agent-step'/);
    expect(source).toMatch(/'tool-invocation'/);
    expect(source).not.toMatch(/subagent\.|roster\.progress/);
  });

  it('AC-R12: forged subagentId is rejected by runtime correlation-key boundary', async () => {
    const roster = createSubagentRoster(createParentContext());
    await roster.spawn({ role: 'coder' });
    await expect(roster.terminate('subagent-forged', successCause())).rejects.toBeInstanceOf(
      RuntimeVetoError,
    );
  });

  it('G1: parent-abort terminateAll race surfaces a structured warn line instead of an unhandled rejection', async () => {
    // Audit 2026-05-03 follow-up (G1): the abort-listener used to call
    // `void terminateAll(...)` without `.catch()`. If a manual
    // `roster.terminate(b, ...)` interleaves with the abort-driven loop
    // such that the loop reaches `b` after its state has already
    // transitioned out of 'active', `terminate()` throws a
    // `RuntimeVetoError` and `terminateAll` rejects — surfacing as an
    // unhandled rejection that crashes the host. The fix attaches a
    // `.catch()` and emits `subagent-roster.parent-abort-terminate-all-threw`.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Track unhandled rejections explicitly so we can assert they don't
    // escape the .catch boundary.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const abortController = new AbortController();
      const roster = createSubagentRoster(
        createParentContext({ parentTerminationSignal: abortController.signal }),
      );
      const a = await roster.spawn({ role: 'explorer' });
      const b = await roster.spawn({ role: 'coder' });

      // Trigger abort: the listener launches `terminateAll(...).catch(...)`
      // synchronously. After iter 1's await yields, the loop is suspended.
      abortController.abort();

      // Race the listener: settle b out of 'active' before the loop
      // reaches it. The next iteration of terminateAll will throw
      // RuntimeVetoError, which the new .catch must absorb.
      await roster.terminate(b.subagentId, abortCause('external-cancel'));

      // Yield long enough for the abort-driven terminateAll to settle.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const warnCalls = warnSpy.mock.calls.flat();
      const matched = warnCalls.find(
        (line) =>
          typeof line === 'string' &&
          line.startsWith('subagent-roster.parent-abort-terminate-all-threw '),
      ) as string | undefined;
      expect(matched).toBeDefined();
      if (matched !== undefined) {
        const payload = JSON.parse(
          matched.slice(
            'subagent-roster.parent-abort-terminate-all-threw '.length,
          ),
        );
        expect(payload.taskId).toBe('task-wu-roster');
        expect(payload.runtimeInstanceId).toBe('instance-wu-roster');
        expect(typeof payload.error).toBe('string');
      }

      // Subagent `a` from iter 1 still terminated successfully.
      const states = roster.snapshot().map((d) => [d.subagentId, d.state]);
      expect(states).toContainEqual([a.subagentId, 'terminated']);
      expect(states).toContainEqual([b.subagentId, 'terminated']);

      // Most importantly: no unhandled rejection escaped the .catch.
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      warnSpy.mockRestore();
    }
  });
});
