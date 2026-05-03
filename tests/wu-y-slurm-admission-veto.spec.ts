/**
 * WU-Y — AdmissionDeniedError → runtime-veto materialization (T2-SLURM path).
 *
 * Sister fix to WU-X: the codex driver T2 surface already materializes
 * `AdmissionDeniedError` as `runtime-veto` (see wu-x-admission-veto.spec.ts).
 * The other T2 surface — `SlurmApptainerComputeNode.allocate()` — also
 * throws `AdmissionDeniedError`, but the throw historically propagated
 * unstructured into the rejected `completion` promise of
 * `Dispatcher.submit()`.
 *
 * WU-Y centralizes translation in `Dispatcher.submit()` via a `.catch`
 * on the compute-node allocate/dispatch chain, so any `ComputeNode`
 * impl that throws `AdmissionDeniedError` resolves into a
 * `TerminalEvidence` byte-identical (in
 * provenance + `vetoSource`) to the T1 dispatcher emit site.
 *
 * Cross-references:
 *   - T1 emit site: src/core/dispatcher.ts ~ lines 342–395
 *   - T2-codex emit site (WU-X): src/runtime/codex-runtime-adapter.ts ~ line 578
 *   - T2-SLURM emit site (this WU): src/core/dispatcher.ts ~ line 403 (.catch)
 *   - WU-L spec: specs/wu-l-admission-rule-evaluator.md §3.5, §4
 */

import { describe, expect, it } from 'vitest';

import {
  type ComputeAllocation,
  type ComputeNode,
  Dispatcher,
  Plana,
  createDispatchPlan,
  deriveOutcomeFromCause,
} from '../src/index.js';
import { AdmissionGate } from '../src/core/admission-gate.js';
import type {
  AdmissionRule,
  AdmissionStack,
} from '../src/contracts/admission-rule.js';
import type { TerminalCauseRuntimeVeto } from '../src/contracts/terminal-cause.js';
import { SlurmApptainerComputeNode } from '../src/core/compute-node-slurm-apptainer.js';
import type {
  SubprocessRequest,
  SubprocessResult,
  SubprocessRunner,
} from '../src/core/compute-node-slurm-apptainer.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

// ---------------------------------------------------------------------------
// Local helpers — minimal mirrors of wu-x-admission-veto.spec.ts patterns.
// ---------------------------------------------------------------------------

const denyRule = (id: string, reason?: string): AdmissionRule => ({
  id,
  evaluate: () => ({
    verdict: 'deny',
    ruleId: id,
    triggerId: 'T2_ChokepointCrossing',
    reason,
  }),
});

const stackOf = (...rules: AdmissionRule[]): AdmissionStack => ({
  layers: [{ id: 'wu-y-test-layer', rules }],
});

/**
 * Subprocess runner that records calls and (by default) succeeds. The
 * gate denies BEFORE allocate ever invokes salloc, so this runner's
 * `run` must NOT be called in the deny-path tests; we assert that
 * downstream.
 */
function recordingRunner(): SubprocessRunner & {
  readonly calls: SubprocessRequest[];
} {
  const calls: SubprocessRequest[] = [];
  return {
    calls,
    async run(request: SubprocessRequest): Promise<SubprocessResult> {
      calls.push(request);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

function buildSlurmNodeWithGate(gate: AdmissionGate): {
  node: SlurmApptainerComputeNode;
  runner: SubprocessRunner & { readonly calls: SubprocessRequest[] };
} {
  const runner = recordingRunner();
  const node = new SlurmApptainerComputeNode({
    subprocessRunner: runner,
    admissionGate: gate,
  });
  return { node, runner };
}

// ---------------------------------------------------------------------------
// WU-Y.a — completion resolves (does NOT reject) on T2-SLURM gate deny.
// ---------------------------------------------------------------------------

describe('WU-Y — Dispatcher materializes T2-SLURM AdmissionDeniedError as runtime-veto', () => {
  it('WU-Y.a: completion resolves (no reject) when SLURM admission gate denies at allocate()', async () => {
    const gate = new AdmissionGate({
      stack: stackOf(denyRule('rule-deny-slurm', 'slurm policy violation')),
    });
    const { node, runner } = buildSlurmNodeWithGate(gate);
    const dispatcher = new Dispatcher(node);
    const plan = createDispatchPlan(createTaskRequest('task-wu-y-a'));

    const submission = dispatcher.submit(plan, new Plana());

    // Must resolve, not reject.
    const evidence = await submission.completion;
    expect(evidence).toBeDefined();
    // Gate denied BEFORE salloc — the recording runner stays untouched.
    expect(runner.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // WU-Y.b — cause shape: kind + vetoSource + provenance byte-equal to T1.
  // -------------------------------------------------------------------------

  it("WU-Y.b: cause is runtime-veto with vetoSource='admission' and provenance='admission-gate'", async () => {
    const gate = new AdmissionGate({
      stack: stackOf(denyRule('rule-deny-shape', 'denied-shape')),
    });
    const { node } = buildSlurmNodeWithGate(gate);
    const dispatcher = new Dispatcher(node);
    const plan = createDispatchPlan(createTaskRequest('task-wu-y-b'));

    const evidence = await dispatcher.submit(plan, new Plana()).completion;

    expect(evidence.cause.kind).toBe('runtime-veto');
    const cause = evidence.cause as TerminalCauseRuntimeVeto;
    expect(cause.vetoSource).toBe('admission');
    expect(cause.provenance).toBe('admission-gate');
    expect(cause.veto.provenance).toBe('admission-gate');
    expect(cause.veto.origin).toBe('runtime');
    expect(cause.veto.propagation).toEqual({
      blocksSubmission: false,
      requestsCancellation: true,
      requestsTermination: true,
    });
  });

  // -------------------------------------------------------------------------
  // WU-Y.b2 — reason text uses gate decision.reason verbatim.
  // -------------------------------------------------------------------------

  it('WU-Y.b2: cause.reason carries gate decision.reason verbatim', async () => {
    const gate = new AdmissionGate({
      stack: stackOf(denyRule('rule-with-reason', 'over-quota')),
    });
    const { node } = buildSlurmNodeWithGate(gate);
    const dispatcher = new Dispatcher(node);
    const plan = createDispatchPlan(createTaskRequest('task-wu-y-b2'));

    const evidence = await dispatcher.submit(plan, new Plana()).completion;
    const cause = evidence.cause as TerminalCauseRuntimeVeto;
    expect(cause.reason).toBe('over-quota');
    expect(cause.veto.reason).toBe('over-quota');
  });

  // -------------------------------------------------------------------------
  // WU-Y.c — fallback reason "Denied by rule '<id>'" when reason absent.
  // -------------------------------------------------------------------------

  it('WU-Y.c: cause.reason falls back to "Denied by rule \'<id>\'" when gate omits reason', async () => {
    const gate = new AdmissionGate({
      stack: stackOf(denyRule('rule-no-reason')),
    });
    const { node } = buildSlurmNodeWithGate(gate);
    const dispatcher = new Dispatcher(node);
    const plan = createDispatchPlan(createTaskRequest('task-wu-y-c'));

    const evidence = await dispatcher.submit(plan, new Plana()).completion;
    const cause = evidence.cause as TerminalCauseRuntimeVeto;
    expect(cause.reason).toBe("Denied by rule 'rule-no-reason'");
    expect(cause.veto.reason).toBe("Denied by rule 'rule-no-reason'");
  });

  // -------------------------------------------------------------------------
  // WU-Y.d — regression: non-Admission throws still REJECT completion.
  // Critical guard: the `.catch` MUST re-throw any non-AdmissionDeniedError.
  // -------------------------------------------------------------------------

  it('WU-Y.d: non-AdmissionDeniedError thrown from compute-node dispatch still rejects completion', async () => {
    const boom = new Error('unexpected boom from compute node');
    const throwingNode: ComputeNode = {
      capabilities: {
        kind: 'test-double',
        execution: {
          hasNetwork: true,
          hasFilesystemWrite: true,
          rootless: true,
        },
        capabilityFlags: [],
      },
      async allocate(): Promise<ComputeAllocation> {
        return {
          allocationId: 'wu-y-d',
          capability: this.capabilities,
        };
      },
      async dispatch() {
        throw boom;
      },
      observe() {},
      async cancel() {},
    };
    const dispatcher = new Dispatcher(throwingNode);
    const plan = createDispatchPlan(createTaskRequest('task-wu-y-d'));

    const submission = dispatcher.submit(plan, new Plana());
    await expect(submission.completion).rejects.toBe(boom);
  });

  // -------------------------------------------------------------------------
  // WU-Y.shape — full TerminalEvidence shape sanity (mirrors WU-X shape test).
  // -------------------------------------------------------------------------

  it('WU-Y.shape: TerminalEvidence shape — taskId, observedAt ISO, abort outcome', async () => {
    const gate = new AdmissionGate({
      stack: stackOf(denyRule('rule-shape', 'shape-check')),
    });
    const { node } = buildSlurmNodeWithGate(gate);
    const dispatcher = new Dispatcher(node);
    const plan = createDispatchPlan(createTaskRequest('task-wu-y-shape'));

    const evidence = await dispatcher.submit(plan, new Plana()).completion;
    const cause = evidence.cause as TerminalCauseRuntimeVeto;

    expect(cause.taskId).toBe('task-wu-y-shape');
    expect(cause.runtimeInstanceId).toBe('compute-node-admission-denied');
    // ISO-8601 instant.
    expect(cause.observedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(() => new Date(cause.observedAt).toISOString()).not.toThrow();
    // Evidence-level fields.
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('abort');
    expect(evidence.reason).toBe('shape-check');
    expect(evidence.provenance).toBe('admission-gate');
  });
});
