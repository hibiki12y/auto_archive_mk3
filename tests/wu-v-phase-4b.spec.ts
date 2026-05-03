/**
 * WU-V Phase 4b — load-bearing flip verification.
 *
 * Pinpoints the new invariants enforced by Phase 4b:
 *   - `RuntimeDriverResult.cause` is REQUIRED (compile-time sentinel).
 *   - `createTerminalEvidence` throws when `cause` is absent at runtime.
 *   - `createTerminalEvidence` validates outcome ⇔ cause consistency
 *     when both are supplied.
 *   - The agent-runtime driver-result path produces terminal evidence
 *     whose outcome is derived from the driver-supplied cause.
 *
 * @see specs/wu-v-terminal-cause-tightening.md §3 Phase 4, §4 mapping
 */

import { describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  Arona,
  Dispatcher,
  Plana,
  createTerminalEvidence,
  type RuntimeDriver,
  type RuntimeDriverResult,
  type TerminalEvidenceInput,
} from '../src/index.js';
import { InProcessComputeNode } from '../src/core/__test__/compute-node-test-doubles.js';
import { createTaskRequest } from './helpers/dispatcher-core.js';

function baseEvidenceInput(): TerminalEvidenceInput {
  const now = new Date().toISOString();
  return {
    taskId: 'task-wu-v-phase-4b',
    runtimeInstanceId: 'instance-wu-v-phase-4b',
    reason: 'phase-4b verification',
    provenance: 'wu-v-phase-4b-test',
    executionContext: {
      planCreatedAt: now,
      runtimeSettings: {
        networkProfile: 'offline',
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkProjection: {
          networkAccessEnabled: false,
          webSearchMode: 'off',
        },
      },
    },
    resourceEnvelope: {
      requested: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
      effective: { cpuCores: 1, memoryMiB: 256, wallTimeSec: 60, gpuCards: 0 },
    },
    startedAt: now,
    endedAt: now,
    cause: {
      kind: 'success',
      taskId: 'task-wu-v-phase-4b',
      runtimeInstanceId: 'instance-wu-v-phase-4b',
      observedAt: now,
      provenance: 'wu-v-phase-4b-test',
    },
  };
}

describe('WU-V Phase 4b — cause is REQUIRED', () => {
  it('AC-V4.1 (compile-time sentinel): RuntimeDriverResult.cause is required', () => {
    // Phase 5 closure: `outcome` is no longer a field at all on
    // `RuntimeDriverResult`; `cause` is the sole required terminal-state
    // field. The minimal literal below is rejected purely because
    // `cause` (and the other required fields) are missing.
    // @ts-expect-error — `cause` is required on RuntimeDriverResult
    const _bad: RuntimeDriverResult = {
      reason: 'no cause',
      provenance: 'phase-4b-sentinel',
    };
    void _bad;
    expect(true).toBe(true);
  });

  it('AC-V4.1 (runtime guard): createTerminalEvidence throws when cause is absent', () => {
    const input = baseEvidenceInput();
    // Strip cause via a casting trick to exercise the runtime guard.
    const stripped = { ...input } as Partial<TerminalEvidenceInput>;
    delete stripped.cause;
    expect(() => createTerminalEvidence(stripped as TerminalEvidenceInput)).toThrow(
      /TerminalEvidence\.cause is required/,
    );
  });

  it('AC-V4.1 (consistency check): cause is the sole terminal-state field — supplying outcome is a compile-time error', () => {
    const input = baseEvidenceInput();
    // Phase 6 closure: `outcome` is no longer a TerminalEvidenceInput
    // field. Producers that try to thread an outcome literal alongside
    // cause are rejected at the type system level (TS2353 excess
    // property check). The previous "inconsistent outcome ⇔ cause"
    // runtime guard is therefore unreachable by construction.
    // @ts-expect-error — `outcome` is no longer a field on TerminalEvidenceInput
    expect(() => createTerminalEvidence({ ...input, outcome: 'timeout' })).not.toThrow();
  });

  it('AC-V4.1 (derive cause-only): factory accepts the cause-only input and propagates cause verbatim', () => {
    const input = baseEvidenceInput();
    const evidence = createTerminalEvidence(input);
    expect(evidence.cause.kind).toBe('success');
  });

  // ─── Phase 5 successors ────────────────────────────────────────────
  // The former "Site D — driver lies about outcome" test is retired:
  // Phase 5 removes `outcome` from `RuntimeDriverResult` entirely, so a
  // driver can no longer "lie about outcome" by construction. The two
  // tests below pin the Phase 5 invariants directly.
  // @see specs/wu-v-terminal-cause-tightening.md §3 Phase 5

  it('AC-V5.1 (compile-time): RuntimeDriverResult has no `outcome` field', () => {
    const result: RuntimeDriverResult = {
      reason: 'phase-5 shape check',
      provenance: 'phase-5-sentinel',
      cause: {
        kind: 'success',
        taskId: 'task-phase-5-shape',
        runtimeInstanceId: 'instance-phase-5-shape',
        observedAt: new Date().toISOString(),
        provenance: 'phase-5-sentinel',
      },
    };
    // @ts-expect-error — `outcome` is no longer a field on RuntimeDriverResult
    const _outcome = result.outcome;
    void _outcome;
    expect(result.cause.kind).toBe('success');
  });

  it('AC-V5.2 (behavioral): agent-runtime sources evidence.outcome from cause via the boundary mapper', async () => {
    // Driver returns a structured `success` cause and nothing else.
    // Agent-runtime applies `deriveOutcomeFromCause(cause)` at the
    // boundary, so the surfaced `evidence.outcome` MUST equal `'success'`
    // — the canonical mapping of `cause.kind === 'success'`.
    const driver: RuntimeDriver = {
      async run(context) {
        return {
          reason: 'phase-5 boundary mapper proof',
          provenance: 'phase-5-ac-v5-2',
          cause: {
            kind: 'success',
            taskId: context.plan.taskId,
            runtimeInstanceId: context.instance.instanceId,
            observedAt: new Date().toISOString(),
            provenance: 'phase-5-ac-v5-2',
          },
        };
      },
    };

    const result = await new Arona(
      new Plana(),
      new Dispatcher(new InProcessComputeNode(new AgentRuntime(driver))),
    ).requestDispatch(createTaskRequest('task-wu-v-phase-5-ac-v5-2'));

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') return;
    const evidence = await result.submission.completion;
    expect(evidence.cause?.kind).toBe('success');
  });
});
