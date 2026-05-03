/**
 * WU-W Phase 3 — Fallback demotion + observability.
 *
 * Spec: specs/wu-w-driver-fail-closed-origination.md §3 Phase 3,
 *       §5 AC-W4 / AC-W5.f / AC-W6, §6 OQ-W2.
 *
 * Scope of this file:
 *   - The synthesis branch in `agent-runtime.buildFailClosedCause` is now
 *     formally demoted to a defense-in-depth fallback. When it fires, the
 *     synthesized `TerminalCauseDriverFailure` carries the dedicated
 *     sentinel provenance `'agent-runtime-fail-closed-fallback'` so
 *     observers can distinguish originated vs synthesized causes (AC-W4).
 *   - The driver-originated path (Phase 2) and provider-failure path
 *     (Phase 2) remain unaffected — they keep producing causes with their
 *     own structured provenance (`'driver-adapter'` and
 *     `'codex-runtime-driver'` respectively).
 *   - On entry to the fallback synthesis branch the runtime emits a
 *     structured `console.warn` line tagged `wu-w-fallback-synthesis`
 *     so log consumers (Discord, validators) can filter / alert
 *     (OQ-W2 v1; counter metric deferred).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  Plana,
  type RuntimeDriver,
  type RuntimeDriverResult,
} from '../src/index.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import {
  CodexDriverFailureError,
  CodexProviderFailureError,
  CodexRuntimeDriver,
} from '../src/runtime/codex-runtime-adapter.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

const FALLBACK_PROVENANCE = 'agent-runtime-fail-closed-fallback';

describe('WU-W Phase 3 — fallback demotion + observability', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('AC-W4.a: raw (unstructured) driver throw → cause synthesized with sentinel fallback provenance', async () => {
    const driver: RuntimeDriver = {
      run: vi.fn(
        async (): Promise<RuntimeDriverResult> => {
          throw new Error('raw unstructured driver explosion');
        },
      ),
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
    ).requestDispatch(createTaskRequest('task-wu-w-phase-3-raw'));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;

    expect(evidence.cause.kind).toBe('driver-failure');
    // Sentinel — distinguishes synthesized cause from any driver- or
    // provider-originated cause.
    expect(evidence.cause.provenance).toBe(FALLBACK_PROVENANCE);
    expect(evidence.cause.taskId).toBe('task-wu-w-phase-3-raw');
    if (evidence.cause.kind === 'driver-failure') {
      expect(evidence.cause.message).toContain(
        'raw unstructured driver explosion',
      );
    }
  });

  it('AC-W4.b: driver-originated CodexDriverFailureError still produces driver-adapter provenance (Phase 2 regression check)', async () => {
    const driverCause = {
      kind: 'driver-failure' as const,
      taskId: 'task-wu-w-phase-3-originated',
      runtimeInstanceId: 'sentinel-driver-instance',
      observedAt: '2099-09-09T00:00:00.000Z',
      provenance: 'driver-adapter',
      phase: 'codex-run',
      message: 'driver-originated failure (phase 3 regression)',
      stack: 'Error: driver-originated failure (phase 3 regression)\n    at <test>',
      requestContext: {
        taskId: 'task-wu-w-phase-3-originated',
        phase: 'codex-run',
      },
    };

    const driver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => {
        throw new CodexDriverFailureError(
          'driver-originated failure (phase 3 regression)',
          driverCause,
        );
      }),
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
    ).requestDispatch(createTaskRequest('task-wu-w-phase-3-originated'));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;

    expect(evidence.cause.kind).toBe('driver-failure');
    expect(evidence.cause.provenance).toBe('driver-adapter');
    expect(evidence.cause.provenance).not.toBe(FALLBACK_PROVENANCE);

    // The driver-originated branch must NOT trip the fallback
    // observability hook — synthesis warn should be silent.
    const fallbackWarns = warnSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' &&
      (args[0] as string).startsWith('wu-w-fallback-synthesis'),
    );
    expect(fallbackWarns).toHaveLength(0);
  });

  it('AC-W4.c: structured fallback log emitted on synthesis path', async () => {
    const driver: RuntimeDriver = {
      run: vi.fn(
        async (): Promise<RuntimeDriverResult> => {
          throw new Error('synthesis-path observable error');
        },
      ),
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
    ).requestDispatch(createTaskRequest('task-wu-w-phase-3-log'));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    await result.submission.completion;

    const fallbackWarns = warnSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' &&
      (args[0] as string).startsWith('wu-w-fallback-synthesis '),
    );
    expect(fallbackWarns.length).toBeGreaterThanOrEqual(1);

    const line = fallbackWarns[0]![0] as string;
    const jsonStart = line.indexOf('{');
    expect(jsonStart).toBeGreaterThan(0);
    const payload = JSON.parse(line.slice(jsonStart)) as Record<
      string,
      unknown
    >;
    expect(payload.event).toBe('wu-w-fallback-synthesis');
    expect(payload.taskId).toBe('task-wu-w-phase-3-log');
    expect(typeof payload.runtimeInstanceId).toBe('string');
    expect(payload.errorMessage).toContain('synthesis-path observable error');
    expect(payload.errorName).toBe('Error');
    // No stack in the log line itself — stack still goes into the cause.
    expect('stack' in payload).toBe(false);
  });

  it('AC-W5.f: when driver omits a structured cause AND throws raw, fallback path stamps the sentinel provenance', async () => {
    // AC-W5.f wording: a non-codex (or misbehaving codex) adapter that
    // fails to wrap its throw in CodexDriverFailureError must still
    // produce a fail-closed terminal — but with the sentinel provenance
    // so operators can tell the cause was synthesized rather than
    // originated.
    const driver: RuntimeDriver = {
      run: vi.fn(
        async (): Promise<RuntimeDriverResult> =>
          Promise.reject('raw string rejection — no structured cause'),
      ),
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
    ).requestDispatch(createTaskRequest('task-wu-w-phase-3-acw5f'));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;

    expect(evidence.cause.kind).toBe('driver-failure');
    expect(evidence.cause.provenance).toBe(FALLBACK_PROVENANCE);
    if (evidence.cause.kind === 'driver-failure') {
      expect(evidence.cause.message).toContain(
        'raw string rejection — no structured cause',
      );
    }
  });

  it('AC-W4.d: provider-failure CodexProviderFailureError still produces codex-runtime-driver provenance (Phase 2 unaffected)', async () => {
    const driver: RuntimeDriver = {
      run: vi.fn(async (): Promise<RuntimeDriverResult> => {
        throw new CodexProviderFailureError(
          'rate-limited by upstream',
          'turn.failed',
          { classification: 'rate-limit', retryable: true },
        );
      }),
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
    ).requestDispatch(createTaskRequest('task-wu-w-phase-3-provider'));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;

    expect(evidence.cause.kind).toBe('provider-failure');
    expect(evidence.cause.provenance).toBe('codex-runtime-driver');
    expect(evidence.cause.provenance).not.toBe(FALLBACK_PROVENANCE);

    const fallbackWarns = warnSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' &&
      (args[0] as string).startsWith('wu-w-fallback-synthesis'),
    );
    expect(fallbackWarns).toHaveLength(0);
  });

  it('B-CDX malformed ingress from CodexRuntimeDriver still lands as provider-failure/permanent-protocol', async () => {
    const driver = new CodexRuntimeDriver({
      sdkFactory: (() => ({
        startThread: () => ({
          id: 'thread-bcdx-malformed',
          async runStreamed() {
            return {
              events: (async function* () {
                yield {
                  type: 'turn.failed',
                  error: { message: 42 },
                };
              })(),
            } as never;
          },
        }),
      })) as never,
    });

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
    ).requestDispatch(createTaskRequest('task-wu-w-phase-3-bcdx'));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;

    expect(evidence.cause.kind).toBe('provider-failure');
    expect(evidence.cause.provenance).toBe('codex-runtime-driver');
    expect(evidence.cause.provenance).not.toBe(FALLBACK_PROVENANCE);
    if (evidence.cause.kind === 'provider-failure') {
      expect(evidence.cause.classification).toBe('permanent-protocol');
      expect(evidence.cause.retryable).toBe(false);
      expect(evidence.cause.message).toContain('invalid Codex response shape:');
      expect(evidence.cause.message).toContain('[B-CDX]');
    }

    const fallbackWarns = warnSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' &&
      (args[0] as string).startsWith('wu-w-fallback-synthesis'),
    );
    expect(fallbackWarns).toHaveLength(0);
  });
});
