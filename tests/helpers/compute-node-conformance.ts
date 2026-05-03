/**
 * Reusable ComputeNode conformance harness (WU-I).
 *
 * Exports a single `runComputeNodeConformanceSuite(label, makeNode)` function
 * that any per-backend spec file may call to assert the full WU-I invariant
 * set against a `ComputeNode` implementation.
 *
 * Design constraints (per WU-I spec §BC-1…BC-6):
 *   - BC-2: Name-bound to ComputeNode (WU-P port), not a generic framework.
 *   - BC-3: All assertion bodies reference only port-typed values; no branching
 *     on impl identity.
 *   - BC-4: Cause vocabulary imported directly from WU-H `terminal-cause.ts`;
 *     not redefined here.
 *   - BC-5: No production wiring required — works against factory thunks only.
 *   - BC-6: Backends registered explicitly by callers; no reflection or scan.
 *
 * Anti-scope guard (WU-T §2.3): this module does NOT export reusable
 * scaffolding parameterized over arbitrary port types.  It is intentionally
 * narrow: ComputeNode conformance assertions, nothing more.
 */

import { describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  createDispatchPlan,
  DISPATCH_LIFECYCLE_PHASES,
  Plana,
  TERMINAL_CAUSE_KINDS,
  type RuntimeCancellationBoundary,
  type RuntimeDriver,
  type RuntimeDriverResult,
} from '../../src/index.js';
import { isComputeNode, type ComputeNode } from '../../src/core/compute-node.js';
import { createTaskRequest } from './dispatcher-core.js';
import { withSynthesizedCause } from './wu-v-cause.js';

// ---------------------------------------------------------------------------
// Internal fixture helpers (not exported — BC-2 anti-scope guard)
// ---------------------------------------------------------------------------

/** Minimal no-op cancellation boundary for harness dispatch calls. */
function makeNoopCancellationBoundary(): RuntimeCancellationBoundary {
  return {
    cancel: () => ({
      taskId: 'wu-i-noop',
      reason: 'harness-no-cancel',
      provenance: 'compute-node-conformance-harness',
      requestedAt: new Date().toISOString(),
    }),
  };
}

/** Minimal stub RuntimeDriver for InProcessComputeNode-backed nodes. */
function makeStubDriver(): RuntimeDriver {
  return {
    async run(context): Promise<RuntimeDriverResult> {
      return withSynthesizedCause(context, {
        outcome: 'success',
        reason: 'conformance-harness stub driver completed',
        provenance: 'compute-node-conformance-harness',
      });
    },
  };
}

/** Convenience: build a fresh AgentRuntime wrapping the stub driver. */
export function makeStubAgentRuntime(): AgentRuntime {
  return new AgentRuntime(makeStubDriver());
}

// ---------------------------------------------------------------------------
// Public harness entry point
// ---------------------------------------------------------------------------

/**
 * Run the WU-I ComputeNode conformance suite against the backend produced by
 * `makeNode`.  Call this once per concrete implementation from a per-backend
 * spec file.  Each `it()` in the suite creates a fresh node via `makeNode()`
 * to satisfy the fixture-isolation requirement (BC-3 / BC-6).
 *
 * Coverage per WU-I spec:
 *   CC-1  dispatch returns terminally
 *   CC-2  terminal evidence shape
 *   CC-3  cancellation acknowledged (cooperative semantics only — WU-J pending)
 *   CC-4  idempotent terminal observation / post-terminal cancel no-op
 *   CC-5  no observer events after dispatch() settles
 *   CC-6  capability surface availability pre-allocate
 *   CC-7  cause-kind closure (cause.kind ∈ TERMINAL_CAUSE_KINDS when present)
 *
 * @param label   Human-readable backend label for describe-block headings.
 * @param makeNode Factory thunk; invoked once per `it()` for isolation.
 */
export function runComputeNodeConformanceSuite(
  label: string,
  makeNode: () => ComputeNode,
): void {
  // ─────────────────────────────────────────────────────────────────────────
  // CC-6: Capability surface available before allocate()
  // ─────────────────────────────────────────────────────────────────────────
  describe(`CC-6 capability surface pre-allocate — ${label}`, () => {
    it('passes the isComputeNode structural type guard', () => {
      expect(isComputeNode(makeNode())).toBe(true);
    });

    it('capabilities is non-null before any allocate() call', () => {
      const node = makeNode();
      expect(node.capabilities).toBeDefined();
      expect(node.capabilities).not.toBeNull();
    });

    it('capabilities.kind is a non-empty string', () => {
      const node = makeNode();
      expect(typeof node.capabilities.kind).toBe('string');
      expect(node.capabilities.kind.length).toBeGreaterThan(0);
    });

    it('capabilities.execution.hasNetwork is a boolean', () => {
      const node = makeNode();
      expect(typeof node.capabilities.execution.hasNetwork).toBe('boolean');
    });

    it('capabilities.execution.hasFilesystemWrite is a boolean', () => {
      const node = makeNode();
      expect(typeof node.capabilities.execution.hasFilesystemWrite).toBe('boolean');
    });

    it('capabilities.execution.rootless is a boolean', () => {
      const node = makeNode();
      expect(typeof node.capabilities.execution.rootless).toBe('boolean');
    });

    it('capabilities reference is stable (same object on repeated reads)', () => {
      const node = makeNode();
      expect(node.capabilities).toBe(node.capabilities);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Allocate idempotency (CC-1 pre-dispatch surface; part of CC-2 shape)
  // ─────────────────────────────────────────────────────────────────────────
  describe(`allocate contract — ${label}`, () => {
    it('allocate() returns a ComputeAllocation with a non-empty allocationId', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-alloc`));
      const allocation = await node.allocate(plan);
      expect(typeof allocation.allocationId).toBe('string');
      expect(allocation.allocationId.length).toBeGreaterThan(0);
    });

    it('allocation.capability.kind matches node capabilities.kind', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-alloc-cap`));
      const allocation = await node.allocate(plan);
      expect(allocation.capability.kind).toBe(node.capabilities.kind);
    });

    it('successive allocate() calls return distinct allocationIds (no idempotent reuse)', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-alloc-distinct`));
      const a1 = await node.allocate(plan);
      const a2 = await node.allocate(plan);
      expect(a1.allocationId).not.toBe(a2.allocationId);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CC-1 / CC-2: Dispatch contract — terminal settlement and evidence shape
  // ─────────────────────────────────────────────────────────────────────────
  describe(`CC-1/CC-2 dispatch contract — ${label}`, () => {
    it('dispatch() resolves (does not reject) for a well-formed plan', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-dispatch-resolves`));
      const allocation = await node.allocate(plan);
      await expect(
        node.dispatch(allocation, plan, new Plana(), makeNoopCancellationBoundary()),
      ).resolves.toBeDefined();
    });

    it('evidence.taskId matches the plan taskId', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-taskid`));
      const allocation = await node.allocate(plan);
      const evidence = await node.dispatch(
        allocation,
        plan,
        new Plana(),
        makeNoopCancellationBoundary(),
      );
      expect(evidence.taskId).toBe(plan.taskId);
    });

    it('evidence.runtimeInstanceId is a non-empty string', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-rtid`));
      const allocation = await node.allocate(plan);
      const evidence = await node.dispatch(
        allocation,
        plan,
        new Plana(),
        makeNoopCancellationBoundary(),
      );
      expect(typeof evidence.runtimeInstanceId).toBe('string');
      expect(evidence.runtimeInstanceId.length).toBeGreaterThan(0);
    });

    it('evidence.cause.kind is a member of TERMINAL_CAUSE_KINDS', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-outcome`));
      const allocation = await node.allocate(plan);
      const evidence = await node.dispatch(
        allocation,
        plan,
        new Plana(),
        makeNoopCancellationBoundary(),
      );
      expect(TERMINAL_CAUSE_KINDS).toContain(evidence.cause.kind);
    });

    it('evidence.reason is a string', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-reason`));
      const allocation = await node.allocate(plan);
      const evidence = await node.dispatch(
        allocation,
        plan,
        new Plana(),
        makeNoopCancellationBoundary(),
      );
      expect(typeof evidence.reason).toBe('string');
    });

    it('evidence.startedAt and evidence.endedAt are non-empty strings', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-timestamps`));
      const allocation = await node.allocate(plan);
      const evidence = await node.dispatch(
        allocation,
        plan,
        new Plana(),
        makeNoopCancellationBoundary(),
      );
      expect(typeof evidence.startedAt).toBe('string');
      expect(evidence.startedAt.length).toBeGreaterThan(0);
      expect(typeof evidence.endedAt).toBe('string');
      expect(evidence.endedAt.length).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CC-7: Cause-kind closure — cause.kind ∈ TERMINAL_CAUSE_KINDS (WU-H union)
  // ─────────────────────────────────────────────────────────────────────────
  describe(`CC-7 terminal cause closure — ${label}`, () => {
    it('when evidence.cause is present its kind is a member of TERMINAL_CAUSE_KINDS (WU-H)', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-cause-kind`));
      const allocation = await node.allocate(plan);
      const evidence = await node.dispatch(
        allocation,
        plan,
        new Plana(),
        makeNoopCancellationBoundary(),
      );
      if (evidence.cause !== undefined) {
        // BC-4: assert membership in WU-H union; do NOT compare string literals.
        expect(TERMINAL_CAUSE_KINDS).toContain(evidence.cause.kind);
      }
    });

    it('when evidence.cause is present its base fields are non-empty strings', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-cause-base`));
      const allocation = await node.allocate(plan);
      const evidence = await node.dispatch(
        allocation,
        plan,
        new Plana(),
        makeNoopCancellationBoundary(),
      );
      if (evidence.cause !== undefined) {
        expect(typeof evidence.cause.taskId).toBe('string');
        expect(evidence.cause.taskId.length).toBeGreaterThan(0);
        expect(typeof evidence.cause.runtimeInstanceId).toBe('string');
        expect(evidence.cause.runtimeInstanceId.length).toBeGreaterThan(0);
        expect(typeof evidence.cause.observedAt).toBe('string');
        expect(evidence.cause.observedAt.length).toBeGreaterThan(0);
        expect(typeof evidence.cause.provenance).toBe('string');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CC-4 / CC-5: Observer event ordering and terminal boundary
  // ─────────────────────────────────────────────────────────────────────────
  describe(`CC-4/CC-5 observe semantics — ${label}`, () => {
    it('attached observer receives at least one phase during dispatch', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-obs-receives`));
      const allocation = await node.allocate(plan);

      const phases: string[] = [];
      node.observe(allocation, (obs) => {
        phases.push(obs.phase);
      });

      await node.dispatch(allocation, plan, new Plana(), makeNoopCancellationBoundary());

      expect(phases.length).toBeGreaterThan(0);
    });

    it('attached observer receives the same phase sequence as the dispatch-inline observer', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-obs-order`));
      const allocation = await node.allocate(plan);

      const directPhases: string[] = [];
      const attachedPhases: string[] = [];

      node.observe(allocation, (obs) => {
        attachedPhases.push(obs.phase);
      });

      await node.dispatch(
        allocation,
        plan,
        new Plana(),
        makeNoopCancellationBoundary(),
        (obs) => {
          directPhases.push(obs.phase);
        },
      );

      expect(attachedPhases.length).toBeGreaterThan(0);
      // BC-3: no branching on impl identity — both observers see identical sequence.
      expect(attachedPhases).toEqual(directPhases);
    });

    it('all observed phases are members of DISPATCH_LIFECYCLE_PHASES', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-obs-phases`));
      const allocation = await node.allocate(plan);

      const observed: string[] = [];
      await node.dispatch(
        allocation,
        plan,
        new Plana(),
        makeNoopCancellationBoundary(),
        (obs) => {
          observed.push(obs.phase);
        },
      );

      for (const phase of observed) {
        // BC-4 analogue: assert membership in the known phase set, no literals.
        expect(DISPATCH_LIFECYCLE_PHASES).toContain(phase);
      }
    });

    it('each observation carries the plan taskId', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-obs-taskid`));
      const allocation = await node.allocate(plan);

      const observedTaskIds: string[] = [];
      await node.dispatch(
        allocation,
        plan,
        new Plana(),
        makeNoopCancellationBoundary(),
        (obs) => {
          observedTaskIds.push(obs.taskId);
        },
      );

      for (const taskId of observedTaskIds) {
        expect(taskId).toBe(plan.taskId);
      }
    });

    it('no observer events are emitted after dispatch() settles (CC-5 terminal boundary)', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-obs-terminal`));
      const allocation = await node.allocate(plan);

      let postSettleEvents = 0;
      let settled = false;

      node.observe(allocation, () => {
        if (settled) {
          postSettleEvents++;
        }
      });

      await node.dispatch(allocation, plan, new Plana(), makeNoopCancellationBoundary());
      settled = true;

      // Yield the microtask queue once to allow any deferred callbacks.
      await Promise.resolve();

      expect(postSettleEvents).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC-M2 (WU-M Task Identity Invariant) — `taskId` stability at the
  // ComputeNode port boundary.
  //
  // Spec: `specs/wu-m-task-identity-invariant.md` AC-M2; verifies I-M1
  // (identity stability over time within a single task lifetime) and the
  // port-level analog of I-M2 (verbatim preservation across distinct
  // allocations sharing the same `plan.taskId` — the resume-from-checkpoint
  // analog at the port surface; the full Dispatcher-instance crossing is
  // exercised by `tests/dispatcher-resume-task-id.spec.ts`).
  //
  // BC-6 opacity: every assertion is byte-equality only; no parsing, no
  // structural inspection of the id.
  // ─────────────────────────────────────────────────────────────────────────
  describe(`AC-M2 WU-M taskId stability — ${label}`, () => {
    it('I-M1 — every lifecycle observation during one dispatch carries the same taskId byte-exact', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-im1-obs`));
      const allocation = await node.allocate(plan);

      const observed: string[] = [];
      const evidence = await node.dispatch(
        allocation,
        plan,
        new Plana(),
        makeNoopCancellationBoundary(),
        (obs) => {
          observed.push(obs.taskId);
        },
      );

      // Byte-equality across every emitted observation AND the final
      // terminal evidence — single, immutable identity for the lifetime
      // of the task at the port boundary.
      for (const id of observed) {
        expect(id).toBe(plan.taskId);
      }
      expect(evidence.taskId).toBe(plan.taskId);
    });

    it('I-M2 (port-boundary analog) — re-dispatching the same plan.taskId across distinct allocations preserves the id verbatim', async () => {
      // Two independent (allocation, dispatch) cycles on the SAME node
      // sharing the same plan.taskId model the resume-from-checkpoint
      // shape at the port: a freshly allocated execution surface MUST
      // honour the caller-supplied identity verbatim, never substituting
      // a derived or aliased value (BC-3 immutability + BC-5 verbatim).
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-im2-port`));

      const a1 = await node.allocate(plan);
      const e1 = await node.dispatch(a1, plan, new Plana(), makeNoopCancellationBoundary());

      const a2 = await node.allocate(plan);
      const e2 = await node.dispatch(a2, plan, new Plana(), makeNoopCancellationBoundary());

      expect(e1.taskId).toBe(plan.taskId);
      expect(e2.taskId).toBe(plan.taskId);
      expect(e1.taskId).toBe(e2.taskId);
      // Allocation ids are intentionally distinct (see allocate-contract
      // suite above); identity is task-scoped, not allocation-scoped.
      expect(a1.allocationId).not.toBe(a2.allocationId);
    });

    it('BC-6 opacity — taskId equality is the only inspection at the port boundary', async () => {
      // Negative guard: confirm that the harness itself does not inspect
      // the structural shape of taskId. Any parsing here would propagate
      // a BC-6 violation to every backend; the assertion deliberately
      // exercises only equality + length / type, never substring or
      // version-nibble extraction.
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-bc6-opaque`));
      const allocation = await node.allocate(plan);
      const evidence = await node.dispatch(
        allocation,
        plan,
        new Plana(),
        makeNoopCancellationBoundary(),
      );
      expect(typeof evidence.taskId).toBe('string');
      expect(evidence.taskId.length).toBeGreaterThan(0);
      expect(evidence.taskId).toBe(plan.taskId);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CC-3 / CC-4: Cancel acknowledgement and post-terminal no-op (cooperative)
  //
  // OQ-2 (bounded-time semantics) and WU-J (preemptive cancel contract) are
  // pending.  This suite asserts only the cooperative acknowledgement half:
  // cancel() MUST resolve without throwing in all observed states.
  // ─────────────────────────────────────────────────────────────────────────
  describe(`CC-3/CC-4 cancel acknowledgement — ${label}`, () => {
    it('cancel() for an allocated-but-undispatched allocation resolves without throwing', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-cancel-pre`));
      const allocation = await node.allocate(plan);
      await expect(node.cancel(allocation, 'pre-dispatch cancel')).resolves.toBeUndefined();
    });

    it('cancel() after dispatch() resolves (post-terminal no-op per CC-4)', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-cancel-post`));
      const allocation = await node.allocate(plan);
      await node.dispatch(allocation, plan, new Plana(), makeNoopCancellationBoundary());
      await expect(node.cancel(allocation, 'post-terminal cancel')).resolves.toBeUndefined();
    });

    it('cancel() for an unknown allocation resolves without throwing (cooperative semantics)', async () => {
      const node = makeNode();
      await expect(
        node.cancel(
          { allocationId: 'wu-i-never-allocated', capability: node.capabilities },
          'unknown allocation cancel',
        ),
      ).resolves.toBeUndefined();
    });

    it('repeated cancel() calls for the same allocation are all idempotent', async () => {
      const node = makeNode();
      const plan = createDispatchPlan(createTaskRequest(`${label}-cancel-idem`));
      const allocation = await node.allocate(plan);
      await node.cancel(allocation, 'first cancel');
      await expect(node.cancel(allocation, 'second cancel')).resolves.toBeUndefined();
      await expect(node.cancel(allocation, 'third cancel')).resolves.toBeUndefined();
    });
  });
}
