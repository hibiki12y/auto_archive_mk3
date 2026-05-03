/**
 * WU-M AC-M4 — Resume-from-checkpoint preserves taskId across Dispatcher
 * instances (I-M2).
 *
 * Spec: `specs/wu-m-task-identity-invariant.md` AC-M4 + I-M2 + BC-5.
 *
 *   I-M2  ∀ task t, ∀ Dispatcher instances D₁, D₂ such that t is hosted
 *         by D₁ then resumed in D₂:  id_{D₁}(t) = id_{D₂}(t).
 *
 *   §6 Q5 governance oracle (cited, NOT redefined): the single-use
 *   Dispatcher invariant — a Dispatcher instance does not survive resume;
 *   instead, a fresh Dispatcher D₂ accepts the persisted state and the
 *   in-flight task continues. Identity is the property that crosses this
 *   instance boundary verbatim (BC-5).
 *
 * Test shape:
 *   1. Issue a taskId via D₁'s admission boundary (caller omits → BC-4
 *      single-issuer issues a fresh UUIDv7).
 *   2. Persist the post-admission acceptance + terminal evidence through
 *      a JSON round-trip (modelling the checkpoint serialization layer
 *      defined by AC-M3 / I-M6).
 *   3. Construct a brand-new Dispatcher D₂ (distinct instance, distinct
 *      backend) and re-admit the SAME taskId via the resume/replay path
 *      documented in `Dispatcher.submit()` JSDoc path #2 (caller-supplied
 *      UUIDv7 → `assertTaskId` validates and brands).
 *   4. Assert byte-exact equality across:
 *        - D₁ acceptance.taskId
 *        - D₁ completion evidence.taskId
 *        - JSON-roundtripped acceptance.taskId
 *        - D₂ acceptance.taskId
 *        - D₂ completion evidence.taskId
 *
 * BC-6 opacity: every assertion is `toBe` byte-equality on the string
 * representation; no parsing, no structural inspection.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  type ComputeAllocation,
  type ComputeNode,
  Dispatcher,
  Plana,
  createDispatchPlan,
  createTerminalEvidence,
  type DispatchPlan,
  type TerminalEvidence,
} from '../src/index.js';
import { isValidTaskId } from '../src/contracts/task-id.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

function createStubNode(): ComputeNode {
  return {
    capabilities: {
      kind: 'test-double',
      execution: {
        hasNetwork: true,
        hasFilesystemWrite: true,
        rootless: true,
      },
      capabilityFlags: [],
    },
    allocate: vi.fn(async (plan: DispatchPlan): Promise<ComputeAllocation> => ({
      allocationId: `resume-${plan.taskId}`,
      capability: {
        kind: 'test-double',
        execution: {
          hasNetwork: true,
          hasFilesystemWrite: true,
          rootless: true,
        },
        capabilityFlags: [],
      },
    })),
    dispatch: vi.fn(async (_allocation, plan: DispatchPlan): Promise<TerminalEvidence> => {
      const now = new Date().toISOString();
      return createTerminalEvidence({
        taskId: plan.taskId,
        runtimeInstanceId: `instance-${plan.taskId}`,
        reason: 'wu-m-ac-m4 stub-success',
        provenance: 'dispatcher-resume-task-id-spec',
        executionContext: {
          planCreatedAt: plan.createdAt,
          runtimeSettings: plan.runtimeSettings,
        },
        resourceEnvelope: plan.resourceEnvelope,
        startedAt: now,
        endedAt: now,
        cause: {
          kind: 'success',
          taskId: plan.taskId,
          runtimeInstanceId: `instance-${plan.taskId}`,
          observedAt: now,
          provenance: 'dispatcher-resume-task-id-spec',
        },
      });
    }),
    observe: vi.fn(),
    cancel: vi.fn(async () => undefined),
  };
}

function planWithoutTaskId(label: string): Omit<DispatchPlan, 'taskId'> {
  const { taskId: _drop, ...rest } = createDispatchPlan(
    createTaskRequest(`placeholder-${label}`),
  );
  void _drop;
  return rest;
}

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('WU-M AC-M4 — taskId stability across Dispatcher instances (I-M2 / BC-5)', () => {
  it('a fresh Dispatcher D₂ resumes a D₁-issued taskId verbatim', async () => {
    // ── Phase 1: D₁ admission issues identity ──────────────────────────
    const d1 = new Dispatcher(createStubNode());
    const d1Submission = d1.submit(planWithoutTaskId('d1'), new Plana());
    const d1Issued = d1Submission.acceptance.taskId;
    expect(isValidTaskId(d1Issued)).toBe(true);
    const d1Evidence = await d1Submission.completion;
    expect(d1Evidence.taskId).toBe(d1Issued);

    // ── Phase 2: persist (JSON checkpoint layer per AC-M3 / I-M6) ──────
    const checkpointed = jsonRoundTrip({
      acceptance: d1Submission.acceptance,
      evidence: d1Evidence,
    });
    expect(checkpointed.acceptance.taskId).toBe(d1Issued);
    expect(checkpointed.evidence.taskId).toBe(d1Issued);

    // ── Phase 3: D₂ — fresh dispatcher instance, fresh backend ─────────
    // Per §6 Q5 the original Dispatcher is single-use; resume materializes
    // a new instance receiving the persisted state. The caller supplies
    // the persisted UUIDv7 and the dispatcher routes through the
    // `assertTaskId`-validated resume/replay branch (Dispatcher.submit
    // JSDoc path #2).
    const d2 = new Dispatcher(createStubNode());
    const d2Submission = d2.submit(
      { ...planWithoutTaskId('d2'), taskId: checkpointed.acceptance.taskId },
      new Plana(),
    );

    // ── Phase 4: byte-exact equality across the entire chain ───────────
    expect(d2Submission.acceptance.taskId).toBe(d1Issued);
    const d2Evidence = await d2Submission.completion;
    expect(d2Evidence.taskId).toBe(d1Issued);

    // Cross-instance assertion: the two Dispatcher instances are distinct
    // objects (single-use invariant), but the task identity transitively
    // crosses the boundary verbatim.
    expect(d1).not.toBe(d2);
    expect(d2Submission.acceptance.boundary).toBe('dispatcher');
  });

  it('resume with the SAME taskId on the SAME dispatcher rejects (single-use within an instance)', () => {
    // Companion guard: BC-5 verbatim preservation crosses *instances*,
    // but within a single Dispatcher instance the BC-4 single-admission
    // invariant continues to apply — re-submitting the same id raises
    // DuplicateSubmissionError. This pins the orthogonality: instance
    // single-use ⊥ id permanence.
    const d1 = new Dispatcher(createStubNode());
    const first = d1.submit(planWithoutTaskId('reuse-1'), new Plana());
    const reusedId = first.acceptance.taskId;
    expect(() =>
      d1.submit(
        { ...planWithoutTaskId('reuse-2'), taskId: reusedId },
        new Plana(),
      ),
    ).toThrowError(/already been submitted/);
  });

  it('three sequential Dispatcher instances all preserve the same taskId byte-exact', async () => {
    // I-M2 quantifier sweep: ∀ Dispatcher instances. Three is enough to
    // demonstrate the invariant is not accidentally pair-specific.
    const d1 = new Dispatcher(createStubNode());
    const submission1 = d1.submit(planWithoutTaskId('chain-1'), new Plana());
    const issued = submission1.acceptance.taskId;
    await submission1.completion;

    const d2 = new Dispatcher(createStubNode());
    const submission2 = d2.submit(
      { ...planWithoutTaskId('chain-2'), taskId: issued },
      new Plana(),
    );
    expect(submission2.acceptance.taskId).toBe(issued);
    await submission2.completion;

    const d3 = new Dispatcher(createStubNode());
    const submission3 = d3.submit(
      { ...planWithoutTaskId('chain-3'), taskId: issued },
      new Plana(),
    );
    expect(submission3.acceptance.taskId).toBe(issued);
    const evidence3 = await submission3.completion;
    expect(evidence3.taskId).toBe(issued);
  });
});
