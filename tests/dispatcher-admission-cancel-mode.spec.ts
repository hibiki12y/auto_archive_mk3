/**
 * WU-K — dispatcher admission-veto producer wiring.
 *
 * Complements `tests/wu-x-admission-veto.spec.ts` (T2-codex path) and
 * `tests/wu-y-slurm-admission-veto.spec.ts` (T2-SLURM path) by pinning
 * the `cancelMode` metadata emitted from the Dispatcher's two
 * admission-gate producer sites:
 *
 *   Row 9 — T1_DispatcherEntry admission deny (short-circuit; runtime
 *           never reached) → `cancelMode: 'preemptive'`.
 *   Row 10 — T2-SLURM `AdmissionDeniedError` flip (thrown from
 *            `backend.run()` after chokepoint crossing) →
 *            `cancelMode: 'degraded'`.
 *
 * See specs/wu-k-cancel-mode-metadata.md §4 admission-mapping table.
 */

import { describe, expect, it } from 'vitest';

import {
  Dispatcher,
  Plana,
  createDispatchPlan,
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
// Local helpers — minimal mirrors of WU-X / WU-Y patterns.
// ---------------------------------------------------------------------------

const denyRule = (id: string, trigger: 'T1_DispatcherEntry' | 'T2_ChokepointCrossing', reason?: string): AdmissionRule => ({
  id,
  evaluate: () => ({
    verdict: 'deny',
    ruleId: id,
    triggerId: trigger,
    reason,
  }),
});

const stackOf = (...rules: AdmissionRule[]): AdmissionStack => ({
  layers: [{ id: 'wu-k-test-layer', rules }],
});

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

// ---------------------------------------------------------------------------
// WU-K.9 — T1_DispatcherEntry admission deny emits cancelMode='preemptive'.
// ---------------------------------------------------------------------------

describe('WU-K — Dispatcher admission-deny cancelMode metadata', () => {
  it('T1 deny emits runtime-veto with cancellation.cancelMode="preemptive"', async () => {
    const gate = new AdmissionGate({
      stack: stackOf(denyRule('rule-t1', 'T1_DispatcherEntry', 'blocked at T1')),
    });
    // Any backend works — the T1 short-circuit runs before backend.run.
    const runner = recordingRunner();
    const node = new SlurmApptainerComputeNode({ subprocessRunner: runner });
    const dispatcher = new Dispatcher(node, { admissionGate: gate });
    const plan = createDispatchPlan(createTaskRequest('task-wu-k-t1'));

    const evidence = await dispatcher.submit(plan, new Plana()).completion;

    expect(evidence.cause.kind).toBe('runtime-veto');
    const cause = evidence.cause as TerminalCauseRuntimeVeto;
    expect(cause.vetoSource).toBe('admission');
    expect(cause.cancellation).toBeDefined();
    expect(cause.cancellation?.cancelMode).toBe('preemptive');
    // Backend must NOT have been touched (T1 short-circuit).
    expect(runner.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // WU-K.10 — T2-SLURM AdmissionDeniedError flip emits cancelMode='degraded'.
  // -------------------------------------------------------------------------

  it('T2-SLURM AdmissionDeniedError flip emits runtime-veto with cancellation.cancelMode="degraded"', async () => {
    // Gate denies at T2; attached to the compute node (NOT to the
    // dispatcher) so the T1 short-circuit in the dispatcher does not
    // fire and the denial surfaces from backend.run() as an
    // AdmissionDeniedError → the dispatcher's WU-Y .catch translates
    // it into runtime-veto.
    const gate = new AdmissionGate({
      stack: stackOf(denyRule('rule-t2-slurm', 'T2_ChokepointCrossing', 'slurm policy violation')),
    });
    const runner = recordingRunner();
    const node = new SlurmApptainerComputeNode({
      subprocessRunner: runner,
      admissionGate: gate,
    });
    const dispatcher = new Dispatcher(node);
    const plan = createDispatchPlan(createTaskRequest('task-wu-k-t2-slurm'));

    const evidence = await dispatcher.submit(plan, new Plana()).completion;

    expect(evidence.cause.kind).toBe('runtime-veto');
    const cause = evidence.cause as TerminalCauseRuntimeVeto;
    expect(cause.vetoSource).toBe('admission');
    expect(cause.cancellation).toBeDefined();
    expect(cause.cancellation?.cancelMode).toBe('degraded');
    // Gate denied before salloc → runner untouched.
    expect(runner.calls).toHaveLength(0);
  });
});
