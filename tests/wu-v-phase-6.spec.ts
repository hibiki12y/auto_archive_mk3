/**
 * WU-V Phase 6 — TerminalOutcome retirement verification.
 *
 * Spec: specs/wu-v-terminal-cause-tightening.md §3 Phase 6.
 *
 * Acceptance criteria:
 *   - AC-V6.1: `TerminalOutcome` type alias is no longer exported from
 *     either `src/contracts/terminal-evidence.ts` or `src/index.ts`.
 *   - AC-V6.2: `TerminalEvidence` no longer carries an `outcome` field;
 *     `cause` is the sole terminal-state carrier.
 */

import { describe, expect, it } from 'vitest';

import {
  createTerminalEvidence,
  deriveOutcomeFromCause,
  type TerminalEvidenceInput,
} from '../src/index.js';

describe('WU-V Phase 6 — TerminalOutcome fully retired', () => {
  it('AC-V6.1 — TerminalOutcome export is removed from the public surface', () => {
    // Compile-time sentinel: any attempt to reference the deleted alias
    // must surface as a TS2305 (no exported member). The two call sites
    // below pin both the contracts module and the package barrel.
    // @ts-expect-error — `TerminalOutcome` is no longer exported by terminal-evidence
    type _A = import('../src/contracts/terminal-evidence.js').TerminalOutcome;
    // @ts-expect-error — `TerminalOutcome` is no longer re-exported by the package barrel
    type _B = import('../src/index.js').TerminalOutcome;
    type _Suppress = _A | _B;
    void undefined as unknown as _Suppress | undefined;
    expect(true).toBe(true);
  });

  it('AC-V6.2 — TerminalEvidence carries cause but not outcome', () => {
    const now = new Date().toISOString();
    const input: TerminalEvidenceInput = {
      taskId: 'task-wu-v-phase-6',
      runtimeInstanceId: 'instance-wu-v-phase-6',
      reason: 'phase-6 verification',
      provenance: 'wu-v-phase-6-test',
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
        taskId: 'task-wu-v-phase-6',
        runtimeInstanceId: 'instance-wu-v-phase-6',
        observedAt: now,
        provenance: 'wu-v-phase-6-test',
      },
    };

    const evidence = createTerminalEvidence(input);

    // @ts-expect-error — `outcome` is no longer a field on TerminalEvidence
    const _outcome = evidence.outcome;
    void _outcome;

    expect(evidence.cause).toBeDefined();
    expect(evidence.cause.kind).toBe('success');
    // The Discord-renderer-style label derivation continues to work.
    expect(deriveOutcomeFromCause(evidence.cause)).toBe('success');
  });
});
