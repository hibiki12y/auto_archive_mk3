import { synthesizeDriverCause, UNUSED_IDENTITY } from '../helpers/wu-v-cause.js';
import { describe, expect, it, vi } from 'vitest';
import { deriveOutcomeFromCause } from '../../src/core/derive-outcome.js';

import {
  AgentRuntime,
  Dispatcher,
  Plana,
  createDispatchPlan,
  type LifecycleAuthorityAuditEntry,
  type LifecycleObserver,
  type LifecycleObserverDescriptor,
  type LifecyclePhaseObservation,
  type RuntimeCancellationBoundary,
  type RuntimeDriver,
  type RuntimeDriverResult,
  type RuntimeTerminalCause,
} from '../../src/index.js';
import { InProcessComputeNode } from '../../src/core/__test__/compute-node-test-doubles.js';
import { createTaskRequest } from '../helpers/dispatcher-core.js';

/**
 * WU-N Observer Authority Boundary tests.
 *
 * Exercises:
 *   - AC-N1/AC-N3: advisory observer throw is suppressed (does not affect
 *     dispatch outcome) and produces a structured warn line + audit entry.
 *   - AC-N3/AC-N7: authoritative observer throw produces a WU-H
 *     `runtime-veto` terminal cause via the documented surface (no
 *     side-channel mutation).
 *   - BC-4 / I-N5: multi-authoritative resolution is first-wins with audit.
 *   - BC-5 / BC-6 / I-N4: the runtime relays `taskId` opaquely (no
 *     production observer code path performs structural decomposition).
 */

function createSuccessfulDriver(): RuntimeDriver {
  return {
    async run(): Promise<RuntimeDriverResult> {
      return {
        reason: 'driver completed',
        provenance: 'wu-n-test-driver',
        cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'driver completed', provenance: 'wu-n-test-driver' }),
      };
    },
  };
}

function createMinimalBoundary(taskId: string): RuntimeCancellationBoundary {
  let terminalCause: RuntimeTerminalCause | undefined;
  return {
    cancel(veto) {
      const receipt = {
        taskId,
        reason: veto.reason,
        provenance: 'test-boundary-cancel',
        requestedAt: new Date().toISOString(),
      };
      terminalCause ??= { kind: 'external-cancel', ...receipt };
      return receipt;
    },
    latchRuntimeVeto(veto) {
      const cause: RuntimeTerminalCause = {
        kind: 'runtime-veto',
        taskId,
        reason: veto.reason,
        provenance: veto.provenance,
        requestedAt: new Date().toISOString(),
        veto,
      };
      terminalCause ??= cause;
      return cause;
    },
    currentTerminalCause: () =>
      terminalCause ? { ...terminalCause } : undefined,
  };
}

describe('WU-N observer authority boundary', () => {
  it('AC-N1/AC-N3 — advisory observer throw is suppressed; dispatch continues; structured warn + audit', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const auditEntries: LifecycleAuthorityAuditEntry[] = [];
    const advisory: LifecycleObserverDescriptor = {
      id: 'advisory-canary',
      notify: () => {
        throw new Error('advisory-explosion');
      },
    };

    const plan = createDispatchPlan(
      createTaskRequest('task-wu-n-advisory-throws'),
    );
    const evidence = await new AgentRuntime(createSuccessfulDriver()).execute(
      plan,
      new Plana({}),
      createMinimalBoundary(plan.taskId),
      advisory,
      (entry) => {
        auditEntries.push(entry);
      },
    );

    // Dispatch still produced a success terminal — advisory has no
    // authority over the outcome.
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
    expect(evidence.taskId).toBe(plan.taskId);

    // Structured warn line was emitted (replaces the prior silent swallow).
    const warnCalls = warnSpy.mock.calls.flat();
    const matchedWarn = warnCalls.find(
      (line) =>
        typeof line === 'string' &&
        line.startsWith('lifecycle.observer.advisory-throw '),
    ) as string | undefined;
    expect(matchedWarn).toBeDefined();
    if (matchedWarn !== undefined) {
      const payload = JSON.parse(
        matchedWarn.slice('lifecycle.observer.advisory-throw '.length),
      );
      expect(payload.observerId).toBe('advisory-canary');
      expect(payload.taskId).toBe(plan.taskId);
      expect(payload.error).toContain('advisory-explosion');
    }

    // Audit log shows advisory suppression at every phase the observer
    // threw on (every phase since the observer always throws).
    const suppressed = auditEntries.filter(
      (e) => e.outcome === 'advisory-suppressed',
    );
    expect(suppressed.length).toBeGreaterThan(0);
    expect(suppressed.every((e) => e.authority === 'advisory')).toBe(true);
    expect(suppressed.every((e) => e.observerId === 'advisory-canary')).toBe(
      true,
    );

    warnSpy.mockRestore();
  });

  it('AC-N3/AC-N7 — authoritative observer throw produces a WU-H runtime-veto terminal cause via the documented surface', async () => {
    const auditEntries: LifecycleAuthorityAuditEntry[] = [];
    const authoritative: LifecycleObserverDescriptor = {
      id: 'auth-killswitch',
      authoritative: true,
      notify: (obs: LifecyclePhaseObservation) => {
        // Only veto at the runtime-running phase to demonstrate that an
        // authoritative observer can stop a dispatch mid-flight via the
        // documented surface (BC-3) — not via side-channel mutation.
        if (obs.phase === 'runtime-running') {
          throw new Error('killswitch tripped');
        }
      },
    };

    const plan = createDispatchPlan(
      createTaskRequest('task-wu-n-authoritative-veto'),
    );
    const evidence = await new AgentRuntime(createSuccessfulDriver()).execute(
      plan,
      new Plana({}),
      createMinimalBoundary(plan.taskId),
      authoritative,
      (entry) => {
        auditEntries.push(entry);
      },
    );

    // Outcome is abort with a runtime-veto cause provenance pointing at
    // the observer (WU-H §3.4). No `driver-failure` synthesis — the
    // authority surface routed through `latchRuntimeVeto`.
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('abort');
    expect(evidence.cause?.kind).toBe('runtime-veto');
    expect(evidence.provenance).toBe('observer-authority:auth-killswitch');
    if (evidence.cause?.kind === 'runtime-veto') {
      expect(evidence.cause.reason).toContain('authoritative observer veto');
      expect(evidence.cause.reason).toContain('killswitch tripped');
    }

    const committed = auditEntries.find(
      (e) => e.outcome === 'authority-committed',
    );
    expect(committed).toBeDefined();
    expect(committed?.observerId).toBe('auth-killswitch');
    expect(committed?.authority).toBe('authoritative');
  });

  it('BC-4 / I-N5 — multi-authoritative resolution is first-wins; both votes appear in audit log', async () => {
    const auditEntries: LifecycleAuthorityAuditEntry[] = [];

    const first: LifecycleObserverDescriptor = {
      id: 'auth-A',
      authoritative: true,
      notify: (obs) => {
        if (obs.phase === 'runtime-running') {
          throw new Error('A vetoes');
        }
      },
    };
    const second: LifecycleObserverDescriptor = {
      id: 'auth-B',
      authoritative: true,
      notify: (obs) => {
        if (obs.phase === 'runtime-running') {
          throw new Error('B vetoes differently');
        }
      },
    };

    const plan = createDispatchPlan(
      createTaskRequest('task-wu-n-multi-auth'),
    );
    const evidence = await new AgentRuntime(createSuccessfulDriver()).execute(
      plan,
      new Plana({}),
      createMinimalBoundary(plan.taskId),
      [first, second],
      (entry) => {
        auditEntries.push(entry);
      },
    );

    // First-wins: A's veto latches the terminal cause; B's throw is
    // recorded but does NOT replace the latched cause.
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('abort');
    expect(evidence.provenance).toBe('observer-authority:auth-A');

    const committedAtRunning = auditEntries.filter(
      (e) =>
        e.phase === 'runtime-running' &&
        e.outcome === 'authority-committed',
    );
    const suppressedAtRunning = auditEntries.filter(
      (e) =>
        e.phase === 'runtime-running' &&
        e.outcome === 'authority-suppressed',
    );
    expect(committedAtRunning).toHaveLength(1);
    expect(committedAtRunning[0]?.observerId).toBe('auth-A');
    expect(suppressedAtRunning).toHaveLength(1);
    expect(suppressedAtRunning[0]?.observerId).toBe('auth-B');
    // Both authoritative votes accounted for — no silent loss.
    expect(suppressedAtRunning[0]?.error).toContain('B vetoes differently');
  });

  it('BC-5 / BC-6 / I-N4 — runtime relays taskId opaquely; production observer code paths contain no structural-decomposition calls', async () => {
    // Functional opacity check: the taskId observed by an observer is
    // byte-identical to the value supplied to the dispatcher. No
    // normalization, no rewriting, no re-issuance.
    const observed: string[] = [];
    const probe: LifecycleObserverDescriptor = {
      id: 'opacity-probe',
      notify: (obs) => {
        observed.push(obs.taskId);
      },
    };

    const plan = createDispatchPlan(
      createTaskRequest('task-wu-n-opaque-relay'),
    );
    await new AgentRuntime(createSuccessfulDriver()).execute(
      plan,
      new Plana({}),
      createMinimalBoundary(plan.taskId),
      probe,
    );

    expect(observed.length).toBeGreaterThan(0);
    expect(new Set(observed).size).toBe(1);
    expect(observed[0]).toBe(plan.taskId);

    // Static-shape check (AC-N5, grep-checkable form): the runtime fan-out
    // module MUST NOT decompose `observation.taskId`. We assert the source
    // text of the production observer call site does not contain any
    // structural-decomposition call against `taskId`. This is the
    // grep-checkable opacity invariant called out by the spec.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const runtimeSource = fs.readFileSync(
      path.resolve(here, '../../src/runtime/agent-runtime.ts'),
      'utf8',
    );
    // None of these structural-decomposition shapes may appear against
    // `taskId` in the production observer fan-out path.
    const forbidden = [
      /observation\.taskId\.split\b/,
      /observation\.taskId\.substring\b/,
      /observation\.taskId\.toLowerCase\b/,
      /observation\.taskId\.startsWith\b/,
      /observation\.taskId\.slice\b/,
    ];
    for (const pattern of forbidden) {
      expect(runtimeSource).not.toMatch(pattern);
    }
  });

  it('AC-N2 — only literal authoritative:true selects authoritative; truthy non-boolean values collapse to advisory', async () => {
    // BC-2 / I-N1: the authoritative gate is strict-equality `=== true`.
    // No truthy coercion (string 'true', number 1, non-empty object), no
    // ambient context, no environment variable. The runtime MUST treat
    // every non-`true` value as advisory and silently suppress its throws
    // rather than promoting them to runtime-veto.
    const auditEntries: LifecycleAuthorityAuditEntry[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Each impostor masquerades as authoritative via a truthy non-boolean
    // payload. The runtime contract forbids any of these from latching a
    // veto. We construct each via `as unknown as ...` because the public
    // type forbids them — at runtime we still want to prove no
    // back-channel coercion exists.
    const impostors: readonly LifecycleObserverDescriptor[] = [
      {
        id: 'impostor-string-true',
        authoritative: 'true' as unknown as boolean,
        notify: () => {
          throw new Error('impostor-string-true throws');
        },
      },
      {
        id: 'impostor-number-one',
        authoritative: 1 as unknown as boolean,
        notify: () => {
          throw new Error('impostor-number-one throws');
        },
      },
      {
        id: 'impostor-object',
        authoritative: {} as unknown as boolean,
        notify: () => {
          throw new Error('impostor-object throws');
        },
      },
      {
        id: 'impostor-undefined',
        // Field omitted entirely.
        notify: () => {
          throw new Error('impostor-undefined throws');
        },
      },
    ];

    const plan = createDispatchPlan(
      createTaskRequest('task-wu-n-ac-n2-strict-true'),
    );
    const evidence = await new AgentRuntime(createSuccessfulDriver()).execute(
      plan,
      new Plana({}),
      createMinimalBoundary(plan.taskId),
      impostors,
      (entry) => {
        auditEntries.push(entry);
      },
    );

    // None of the impostors latched a veto: outcome is success, no
    // observer-authority provenance leaked into the terminal evidence.
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
    expect(evidence.cause?.kind).not.toBe('runtime-veto');
    expect(evidence.provenance).not.toMatch(/^observer-authority:/);

    // Every impostor's throw was recorded as advisory-suppressed
    // (BC-1 default), never as authority-committed or authority-suppressed.
    const impostorIds = new Set(impostors.map((d) => d.id));
    const impostorEntries = auditEntries.filter((e) =>
      impostorIds.has(e.observerId),
    );
    expect(impostorEntries.length).toBeGreaterThan(0);
    for (const entry of impostorEntries) {
      expect(entry.authority).toBe('advisory');
      expect(['notified', 'advisory-suppressed']).toContain(entry.outcome);
    }
    expect(
      auditEntries.some((e) => e.outcome === 'authority-committed'),
    ).toBe(false);
    expect(
      auditEntries.some((e) => e.outcome === 'authority-suppressed'),
    ).toBe(false);

    warnSpy.mockRestore();
  });

  it('AC-N6 — dispatcher boundary observer surface is structurally advisory: bare-function throw does not perturb dispatch', async () => {
    // The original DIS-009 evidence cited `src/core/dispatcher.ts:165-177`
    // (the `safeNotify` site). Per the WU-N authority register
    // (`src/contracts/dispatch-lifecycle.ts`), this site is ADVISORY by
    // construction: `DispatchSubmitOptions.lifecycleObserver` is typed
    // `LifecycleObserver` (a bare function), not `LifecycleObserverInput`,
    // so there is no shape via which a caller could opt the dispatcher
    // observer into authoritative behavior. This test verifies the
    // behavioral half of that conformance criterion at the dispatcher
    // boundary — throws are absorbed and the dispatch outcome is
    // unaffected.
    const successfulDriver = (): RuntimeDriver => ({
      async run(): Promise<RuntimeDriverResult> {
        return {
          reason: 'driver completed',
          provenance: 'wu-n-ac-n6-driver',
          cause: synthesizeDriverCause(UNUSED_IDENTITY, { outcome: 'success', reason: 'driver completed', provenance: 'wu-n-ac-n6-driver' }),
        };
      },
    });

    const phasesObserved: string[] = [];
    const throwingObserver: LifecycleObserver = (obs) => {
      phasesObserved.push(obs.phase);
      throw new Error('dispatcher-observer-explosion');
    };

    const dispatcher = new Dispatcher(
      new InProcessComputeNode(new AgentRuntime(successfulDriver())),
    );
    const plan = createDispatchPlan(
      createTaskRequest('task-wu-n-ac-n6-dispatcher-advisory'),
    );
    const submission = dispatcher.submit(plan, new Plana(), {
      lifecycleObserver: throwingObserver,
    });
    const evidence = await submission.completion;

    // Dispatch outcome is unaffected by the dispatcher-observer throw —
    // exactly the contract advisory-only requires.
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
    expect(evidence.taskId).toBe(plan.taskId);
    // Throws did not short-circuit subsequent phases.
    expect(phasesObserved.length).toBeGreaterThan(1);

    // Structural conformance: there is no descriptor / `authoritative`
    // surface exposed by `DispatchSubmitOptions` itself. We assert this
    // via a grep-level static check on the dispatcher's public option
    // type — the field is typed as `LifecycleObserver` (a bare function),
    // not as `LifecycleObserverInput`, so the dispatcher API surface
    // cannot be opted into authoritative behavior. (Type-erasure escape
    // hatches that bypass the public type and reach the wider runtime
    // surface are out of scope for the dispatcher-boundary AC.)
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const dispatcherSource = fs.readFileSync(
      path.resolve(here, '../../src/core/dispatcher.ts'),
      'utf8',
    );
    expect(dispatcherSource).toMatch(
      /lifecycleObserver\?:\s*LifecycleObserver\s*;/,
    );
    expect(dispatcherSource).not.toMatch(/lifecycleObserver\?:\s*LifecycleObserverInput/);
    expect(dispatcherSource).not.toMatch(/lifecycleObserver\?:\s*LifecycleObserverDescriptor/);
  });

  it('F8 — dispatcher boundary observer throw is logged with a structured warn line (visibility upgrade)', async () => {
    // Audit 2026-05-03 / F8: the dispatcher's `safeNotify` previously
    // silently swallowed observer errors. The runtime layer (AC-N1)
    // already emitted `lifecycle.observer.advisory-throw`; this test
    // pins the same visibility upgrade at the dispatcher seam.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const successfulDriver = (): RuntimeDriver => ({
      async run(): Promise<RuntimeDriverResult> {
        return {
          reason: 'driver completed',
          provenance: 'f8-driver',
          cause: synthesizeDriverCause(UNUSED_IDENTITY, {
            outcome: 'success',
            reason: 'driver completed',
            provenance: 'f8-driver',
          }),
        };
      },
    });

    const dispatcher = new Dispatcher(
      new InProcessComputeNode(new AgentRuntime(successfulDriver())),
    );
    const plan = createDispatchPlan(
      createTaskRequest('task-f8-dispatcher-visibility'),
    );
    const submission = dispatcher.submit(plan, new Plana(), {
      lifecycleObserver: () => {
        throw new Error('dispatcher-observer-explosion');
      },
    });
    const evidence = await submission.completion;
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');

    const warnCalls = warnSpy.mock.calls.flat();
    const matched = warnCalls.find(
      (line) =>
        typeof line === 'string' &&
        line.startsWith('dispatcher.observer.advisory-throw '),
    ) as string | undefined;
    expect(matched).toBeDefined();
    if (matched !== undefined) {
      const payload = JSON.parse(
        matched.slice('dispatcher.observer.advisory-throw '.length),
      );
      expect(payload.taskId).toBe(plan.taskId);
      expect(typeof payload.phase).toBe('string');
      expect(payload.error).toContain('dispatcher-observer-explosion');
    }

    warnSpy.mockRestore();
  });

  it('AC-N8 / BC-6 / I-N2 — observer authority is immutable post-registration; mid-flight mutation of descriptor.authoritative does not promote', async () => {
    // BC-6 states authority is frozen at registration. The runtime
    // implementation snapshots the strict-equality coercion of
    // `authoritative` at `normalizeObserverInput` time. We prove
    // immutability by registering a descriptor as advisory (default),
    // mutating its `authoritative` field to `true` from inside the first
    // notify call, and asserting that subsequent phases still treat the
    // observer as advisory (throws suppressed, no `authority-committed`).
    const auditEntries: LifecycleAuthorityAuditEntry[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mutable: LifecycleObserverDescriptor & { authoritative?: boolean } = {
      id: 'self-promoter',
      // Registers as advisory (default).
      notify: (obs: LifecyclePhaseObservation) => {
        // Self-promote mid-flight via the `authoritative` field. Per BC-6,
        // this MUST be a no-op.
        mutable.authoritative = true;
        if (obs.phase === 'runtime-running') {
          throw new Error('self-promoter attempts veto');
        }
      },
    };

    const plan = createDispatchPlan(
      createTaskRequest('task-wu-n-ac-n8-immutable'),
    );
    const evidence = await new AgentRuntime(createSuccessfulDriver()).execute(
      plan,
      new Plana({}),
      createMinimalBoundary(plan.taskId),
      mutable,
      (entry) => {
        auditEntries.push(entry);
      },
    );

    // Authority did not promote. Outcome is the driver's success; no
    // runtime-veto cause; no observer-authority provenance.
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
    expect(evidence.cause?.kind).not.toBe('runtime-veto');
    expect(evidence.provenance).not.toMatch(/^observer-authority:/);

    // Audit entries for the runtime-running throw show the observer was
    // still treated as advisory after self-mutation.
    const promoterEntries = auditEntries.filter(
      (e) => e.observerId === 'self-promoter',
    );
    expect(promoterEntries.length).toBeGreaterThan(0);
    for (const entry of promoterEntries) {
      expect(entry.authority).toBe('advisory');
    }
    const runningThrow = promoterEntries.find(
      (e) => e.phase === 'runtime-running' && e.error !== undefined,
    );
    expect(runningThrow?.outcome).toBe('advisory-suppressed');

    // Inverse direction: an observer registered as authoritative cannot
    // demote itself mid-flight either. We verify by snapshotting the
    // descriptor at execute() entry — even after we externally null the
    // `authoritative` field below, the runtime continues to treat the
    // observer per its registration-time authority.
    const auditEntries2: LifecycleAuthorityAuditEntry[] = [];
    const auth: LifecycleObserverDescriptor & { authoritative?: boolean } = {
      id: 'self-demoter',
      authoritative: true,
      notify: (obs: LifecyclePhaseObservation) => {
        // Attempt to demote post-registration.
        auth.authoritative = false;
        if (obs.phase === 'runtime-running') {
          throw new Error('self-demoter still vetoes');
        }
      },
    };
    const plan2 = createDispatchPlan(
      createTaskRequest('task-wu-n-ac-n8-no-demotion'),
    );
    const evidence2 = await new AgentRuntime(createSuccessfulDriver()).execute(
      plan2,
      new Plana({}),
      createMinimalBoundary(plan2.taskId),
      auth,
      (entry) => {
        auditEntries2.push(entry);
      },
    );

    // Observer remained authoritative — its veto landed.
    expect(deriveOutcomeFromCause(evidence2.cause)).toBe('abort');
    expect(evidence2.cause?.kind).toBe('runtime-veto');
    expect(evidence2.provenance).toBe('observer-authority:self-demoter');
    const demoterEntries = auditEntries2.filter(
      (e) => e.observerId === 'self-demoter',
    );
    expect(demoterEntries.length).toBeGreaterThan(0);
    for (const entry of demoterEntries) {
      expect(entry.authority).toBe('authoritative');
    }

    warnSpy.mockRestore();
  });
});
