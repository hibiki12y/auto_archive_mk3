/**
 * WU-V Phase 4a — derive-outcome mapper unit tests.
 *
 * Covers AC-V4.2, AC-V4.3 (§4 mapping table), AC-V4.4 (abort synthesis).
 *
 * @see specs/wu-v-terminal-cause-tightening.md §4 mapping (BINDING)
 * @see specs/wu-v-terminal-cause-tightening.md §4.1 abort handling / OQ-V1
 */

import { describe, expect, it } from 'vitest';

import {
  deriveAbortInfoFromCause,
  deriveOutcomeFromCause,
} from '../../src/core/derive-outcome.js';
import type {
  TerminalCause,
  TerminalCauseDriverFailure,
  TerminalCauseExternalCancel,
  TerminalCauseProviderFailure,
  TerminalCauseRuntimeVeto,
  TerminalCauseSuccess,
  TerminalCauseTimeout,
} from '../../src/contracts/terminal-cause.js';
import type { VetoPath } from '../../src/contracts/veto.js';

const BASE = {
  taskId: 'task-derive-outcome',
  runtimeInstanceId: 'agent-task-derive-outcome',
  observedAt: '2026-04-21T00:00:00.000Z',
  provenance: 'wu-v-phase-4a-test',
} as const;

const SUCCESS: TerminalCauseSuccess = { ...BASE, kind: 'success' };

const PROVIDER_FAILURE: TerminalCauseProviderFailure = {
  ...BASE,
  kind: 'provider-failure',
  provider: 'codex',
  classification: 'unknown',
  retryable: false,
  message: 'provider exploded',
};

const DRIVER_FAILURE: TerminalCauseDriverFailure = {
  ...BASE,
  kind: 'driver-failure',
  phase: 'turn-loop',
  message: 'driver contract violation',
};

const TIMEOUT: TerminalCauseTimeout = {
  ...BASE,
  kind: 'timeout',
  deadlineMs: 60_000,
  firedAt: '2026-04-21T00:01:00.000Z',
};

const EXTERNAL_CANCEL: TerminalCauseExternalCancel = {
  ...BASE,
  kind: 'external-cancel',
  reason: 'operator pressed kill switch',
  requestedAt: '2026-04-21T00:00:30.000Z',
};

const VETO_PATH: VetoPath = {
  origin: 'runtime',
  reason: 'destructive runtime action denied',
  provenance: 'runtime-policy',
  propagation: {
    blocksSubmission: false,
    requestsCancellation: true,
    requestsTermination: true,
  },
};

const RUNTIME_VETO: TerminalCauseRuntimeVeto = {
  ...BASE,
  kind: 'runtime-veto',
  reason: VETO_PATH.reason,
  veto: VETO_PATH,
};

describe('WU-V Phase 4a — deriveOutcomeFromCause (§4 mapping)', () => {
  it("AC-V4.3 row 1: 'success' → 'success'", () => {
    expect(deriveOutcomeFromCause(SUCCESS)).toBe('success');
  });

  it("AC-V4.3 row 2: 'provider-failure' → 'failure'", () => {
    expect(deriveOutcomeFromCause(PROVIDER_FAILURE)).toBe('failure');
  });

  it("AC-V4.3 row 3: 'driver-failure' → 'failure'", () => {
    expect(deriveOutcomeFromCause(DRIVER_FAILURE)).toBe('failure');
  });

  it("AC-V4.3 row 4: 'timeout' → 'timeout'", () => {
    expect(deriveOutcomeFromCause(TIMEOUT)).toBe('timeout');
  });

  it("AC-V4.3 row 5: 'external-cancel' → 'operator-cancel'", () => {
    expect(deriveOutcomeFromCause(EXTERNAL_CANCEL)).toBe('operator-cancel');
  });

  it("AC-V4.3 row 6: 'runtime-veto' → 'abort'", () => {
    expect(deriveOutcomeFromCause(RUNTIME_VETO)).toBe('abort');
  });

  it('AC-V4.2: never-arm rejects unknown kind at runtime (defensive guard)', () => {
    // Bypass the type system to inject an unknown kind; this exercises the
    // `default` arm whose compile-time `never` binding guarantees that any
    // future `TerminalCause.kind` addition must update this switch.
    const rogue = {
      ...BASE,
      kind: 'fabricated-kind',
    } as unknown as TerminalCause;
    expect(() => deriveOutcomeFromCause(rogue)).toThrow(
      /unhandled terminal cause kind: fabricated-kind/,
    );
  });
});

describe('WU-V Phase 4a — deriveAbortInfoFromCause (§4.1 / OQ-V1)', () => {
  it('AC-V4.4: synthesizes TerminalAbortInfo without cancellation when cause omits it', () => {
    const info = deriveAbortInfoFromCause(RUNTIME_VETO);
    expect(info).toEqual({ kind: 'veto', veto: VETO_PATH });
    expect(info.cancellation).toBeUndefined();
    // Veto reference is threaded verbatim (no clone in mapper layer).
    expect(info.veto).toBe(VETO_PATH);
  });

  it('AC-V4.4: synthesizes TerminalAbortInfo with cancellation when cause carries one', () => {
    const cause: TerminalCauseRuntimeVeto = {
      ...RUNTIME_VETO,
      cancellation: {
        requestedAt: '2026-04-21T00:00:45.000Z',
        cancelMode: 'cooperative',
      },
    };
    const info = deriveAbortInfoFromCause(cause);
    expect(info.kind).toBe('veto');
    expect(info.veto).toBe(VETO_PATH);
    expect(info.cancellation).toEqual({
      taskId: BASE.taskId,
      reason: VETO_PATH.reason,
      provenance: BASE.provenance,
      requestedAt: '2026-04-21T00:00:45.000Z',
      boundary: 'dispatcher',
    });
  });
});
