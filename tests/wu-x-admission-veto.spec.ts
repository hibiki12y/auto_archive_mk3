/**
 * WU-X — AdmissionDeniedError → runtime-veto materialization (T2 path).
 *
 * Verifies that the codex driver (T2 chokepoint) catches
 * `AdmissionDeniedError` raised by the admission gate and materializes
 * it as a `runtime-veto` `RuntimeDriverResult` with provenance and
 * `vetoSource` byte-identical to the T1 dispatcher path
 * (`src/core/dispatcher.ts`), instead of letting the error escape
 * through WU-W Phase 2's blanket catch and emerge as a `driver-failure`.
 *
 * Cross-references:
 *   - T1 emit site: src/core/dispatcher.ts ~ lines 342–371
 *   - T2 emit site (this WU): src/runtime/codex-runtime-adapter.ts catch block
 *   - WU-L spec: specs/wu-l-admission-rule-evaluator.md §3.5, §4
 *   - WU-W Phase 2 spec: specs/wu-w-driver-fail-closed-origination.md
 */

import { describe, expect, it } from 'vitest';

import { AdmissionGate } from '../src/core/admission-gate.js';
import type {
  AdmissionRule,
  AdmissionStack,
} from '../src/contracts/admission-rule.js';
import { createDispatchPlan } from '../src/core/task.js';
import {
  CodexDriverFailureError,
  CodexRuntimeDriver,
} from '../src/runtime/codex-runtime-adapter.js';
import type {
  RuntimeDriverResult,
  RuntimeExecutionContext,
} from '../src/contracts/runtime-driver.js';
import type { TerminalCauseRuntimeVeto } from '../src/contracts/terminal-cause.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

// ---------------------------------------------------------------------------
// Local helpers
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

const admitRule = (id: string): AdmissionRule => ({
  id,
  evaluate: () => ({
    verdict: 'admit',
    ruleId: id,
    triggerId: 'T2_ChokepointCrossing',
  }),
});

const stackOf = (...rules: AdmissionRule[]): AdmissionStack => ({
  layers: [{ id: 'test-layer', rules }],
});

function createRuntimeContext(
  overrides: Partial<RuntimeExecutionContext> = {},
): RuntimeExecutionContext {
  const plan =
    overrides.plan ?? createDispatchPlan(createTaskRequest('task-wu-x'));
  return {
    plan,
    instance:
      overrides.instance ?? {
        taskId: plan.taskId,
        instanceId: 'agent-task-wu-x',
        createdAt: '2026-04-20T00:00:00.000Z',
        runtimeSettings: plan.runtimeSettings,
      },
    emit: overrides.emit ?? (async () => {}),
    requestApproval:
      overrides.requestApproval ?? (async () => ({ status: 'approved' })),
    isAborted: overrides.isAborted ?? (() => false),
  };
}

/**
 * SDK factory whose `runStreamed` would proceed if reached. The T2
 * admission gate runs strictly before `runStreamed`, so a denying gate
 * MUST short-circuit and `runStreamed` MUST NOT be invoked. We assert
 * that downstream by failing the test if the SDK is touched.
 */
function makeAssertingSdkFactory() {
  let runStreamedCalled = false;
  const factory = () => ({
    startThread: () => ({
      id: 'thread-x',
      async runStreamed() {
        runStreamedCalled = true;
        throw new Error('runStreamed must not be invoked when gate denies');
      },
    }),
  });
  return { factory, wasRunStreamedCalled: () => runStreamedCalled };
}

/**
 * SDK factory whose `runStreamed` throws an unstructured generic Error,
 * to exercise the WU-W Phase 2 driver-failure wrap regression case
 * (WU-X.d).
 */
function makeThrowingSdkFactory(error: Error) {
  return () => ({
    startThread: () => ({
      id: 'thread-x',
      async runStreamed() {
        throw error;
      },
    }),
  });
}

// ---------------------------------------------------------------------------
// WU-X.a — T2 admission deny → runtime-veto cause with vetoSource='admission'
// ---------------------------------------------------------------------------

describe('WU-X — AdmissionDeniedError materializes as runtime-veto at T2', () => {
  it('WU-X.a: codex driver returns runtime-veto with vetoSource="admission" on gate deny', async () => {
    const gate = new AdmissionGate({
      stack: stackOf(denyRule('rule-deny-1', 'policy violation')),
    });
    const { factory, wasRunStreamedCalled } = makeAssertingSdkFactory();
    const driver = new CodexRuntimeDriver({
      sdkFactory: factory,
      admissionGate: gate,
    });

    const result: RuntimeDriverResult = await driver.run(createRuntimeContext());

    expect(result.cause.kind).toBe('runtime-veto');
    const cause = result.cause as TerminalCauseRuntimeVeto;
    expect(cause.vetoSource).toBe('admission');
    // Sanity: the gate denied BEFORE runStreamed was invoked.
    expect(wasRunStreamedCalled()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // WU-X.b — reason carries the rule's reason / "Denied by rule '<id>'" fallback
  // -------------------------------------------------------------------------

  it('WU-X.b: cause.reason carries the gate decision reason verbatim', async () => {
    const gate = new AdmissionGate({
      stack: stackOf(denyRule('rule-with-reason', 'quota exceeded')),
    });
    const { factory } = makeAssertingSdkFactory();
    const driver = new CodexRuntimeDriver({
      sdkFactory: factory,
      admissionGate: gate,
    });

    const result = await driver.run(createRuntimeContext());
    const cause = result.cause as TerminalCauseRuntimeVeto;
    expect(cause.reason).toBe('quota exceeded');
    expect(cause.veto.reason).toBe('quota exceeded');
  });

  it('WU-X.b2: cause.reason falls back to "Denied by rule \'<id>\'" when reason is absent', async () => {
    // Rule emits no reason → AdmissionDecision.reason is undefined.
    const gate = new AdmissionGate({
      stack: stackOf(denyRule('rule-no-reason')),
    });
    const { factory } = makeAssertingSdkFactory();
    const driver = new CodexRuntimeDriver({
      sdkFactory: factory,
      admissionGate: gate,
    });

    const result = await driver.run(createRuntimeContext());
    const cause = result.cause as TerminalCauseRuntimeVeto;
    expect(cause.reason).toBe("Denied by rule 'rule-no-reason'");
    expect(cause.veto.reason).toBe("Denied by rule 'rule-no-reason'");
  });

  // -------------------------------------------------------------------------
  // WU-X.c — provenance byte-equality with T1 dispatcher emit site
  // -------------------------------------------------------------------------

  it("WU-X.c: cause.provenance === 'admission-gate' (matches T1 dispatcher emit site)", async () => {
    const gate = new AdmissionGate({
      stack: stackOf(denyRule('rule-prov', 'denied')),
    });
    const { factory } = makeAssertingSdkFactory();
    const driver = new CodexRuntimeDriver({
      sdkFactory: factory,
      admissionGate: gate,
    });

    const result = await driver.run(createRuntimeContext());
    const cause = result.cause as TerminalCauseRuntimeVeto;
    // T1 emits createVetoPath('runtime', reason, 'admission-gate') —
    // see src/core/dispatcher.ts:350-354. T2 must mirror byte-for-byte.
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
  // WU-X.d — non-admission throws still wrap as CodexDriverFailureError
  // -------------------------------------------------------------------------

  it('WU-X.d: non-admission throws still wrap as CodexDriverFailureError (regression)', async () => {
    const gate = new AdmissionGate({
      // Admission admits → driver proceeds to runStreamed which throws
      // a generic, unstructured Error. WU-W Phase 2 must still wrap it.
      stack: stackOf(admitRule('rule-admit')),
    });
    const driver = new CodexRuntimeDriver({
      sdkFactory: makeThrowingSdkFactory(new Error('unexpected boom')),
      admissionGate: gate,
    });

    await expect(driver.run(createRuntimeContext())).rejects.toBeInstanceOf(
      CodexDriverFailureError,
    );
  });

  // -------------------------------------------------------------------------
  // WU-X — DriverResult shape sanity (provenance/reason on the result, not
  // just on the cause): the surrounding agent-runtime relies on these for
  // observer telemetry. Asserting here keeps the contract obvious.
  // -------------------------------------------------------------------------

  it('WU-X: RuntimeDriverResult.reason and .provenance reflect the admission veto', async () => {
    const gate = new AdmissionGate({
      stack: stackOf(denyRule('rule-shape', 'shape check reason')),
    });
    const { factory } = makeAssertingSdkFactory();
    const driver = new CodexRuntimeDriver({
      sdkFactory: factory,
      admissionGate: gate,
    });

    const result = await driver.run(createRuntimeContext());
    expect(result.reason).toBe('shape check reason');
    expect(result.provenance).toBe('admission-gate');
  });
});
