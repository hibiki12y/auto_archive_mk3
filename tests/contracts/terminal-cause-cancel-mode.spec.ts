import { describe, expect, it } from 'vitest';

import {
  assertTerminalCause,
  cloneTerminalCause,
  CANCEL_ORIGIN_PORTS,
  type CancelMode,
  type CancelModeDetail,
  type CancelOriginPort,
  type TerminalCauseExternalCancel,
  type TerminalCauseRuntimeVeto,
} from '../../src/contracts/terminal-cause.js';
import { createVetoPath, type VetoPath } from '../../src/contracts/veto.js';

/**
 * WU-K — Cancel-mode metadata on TerminalCause.
 *
 * Covers AC-K1 (three-value reservation), AC-K2 (metadata-not-peer) for the
 * two cancel-bearing members `external-cancel` and `runtime-veto`, and
 * validator behaviour for the optional `cancelMode` field.
 *
 * See specs/wu-k-cancel-mode-metadata.md §3.2, §5 AC-K1/AC-K2.
 */

const BASE = {
  taskId: 'task-k',
  runtimeInstanceId: 'agent-task-k',
  observedAt: '2026-04-20T00:00:00.000Z',
  provenance: 'test-wu-k',
};

const SAMPLE_VETO: VetoPath = createVetoPath('runtime', 'blocked', 'unit-test-wu-k');

const CANCEL_MODES = ['cooperative', 'preemptive', 'degraded'] as const satisfies readonly CancelMode[];

describe('WU-K cancelMode metadata — TerminalCauseExternalCancel', () => {
  it.each(CANCEL_MODES)(
    'accepts external-cancel with cancelMode=%s (AC-K1)',
    (mode) => {
      const cause: TerminalCauseExternalCancel = {
        ...BASE,
        kind: 'external-cancel',
        reason: 'operator requested cancel',
        requestedAt: '2026-04-20T00:00:01.000Z',
        cancelMode: mode,
      };
      const result = assertTerminalCause(cause) as TerminalCauseExternalCancel;
      expect(result.cancelMode).toBe(mode);
    },
  );

  it('accepts external-cancel without cancelMode (field is optional)', () => {
    const cause: TerminalCauseExternalCancel = {
      ...BASE,
      kind: 'external-cancel',
      reason: 'operator requested cancel',
      requestedAt: '2026-04-20T00:00:01.000Z',
    };
    const result = assertTerminalCause(cause) as TerminalCauseExternalCancel;
    expect(result.cancelMode).toBeUndefined();
  });

  it('rejects external-cancel with cancelMode outside the three-value enum', () => {
    const bogus = {
      ...BASE,
      kind: 'external-cancel',
      reason: 'bad',
      requestedAt: '2026-04-20T00:00:01.000Z',
      cancelMode: 'bogus',
    };
    expect(() => assertTerminalCause(bogus)).toThrow(TypeError);
    expect(() => assertTerminalCause(bogus)).toThrow(/cancelMode/);
  });

  it('rejects external-cancel with non-string cancelMode', () => {
    const bogus = {
      ...BASE,
      kind: 'external-cancel',
      reason: 'bad',
      requestedAt: '2026-04-20T00:00:01.000Z',
      cancelMode: 42,
    };
    expect(() => assertTerminalCause(bogus)).toThrow(TypeError);
  });
});

describe('WU-K cancelMode metadata — TerminalCauseRuntimeVeto.cancellation', () => {
  it.each(CANCEL_MODES)(
    'accepts runtime-veto with cancellation.cancelMode=%s',
    (mode) => {
      const cause: TerminalCauseRuntimeVeto = {
        ...BASE,
        kind: 'runtime-veto',
        reason: 'policy veto',
        veto: SAMPLE_VETO,
        cancellation: {
          requestedAt: '2026-04-20T00:00:01.000Z',
          cancelMode: mode,
        },
      };
      const result = assertTerminalCause(cause) as TerminalCauseRuntimeVeto;
      expect(result.cancellation?.cancelMode).toBe(mode);
    },
  );

  it('accepts runtime-veto cancellation without cancelMode (optional)', () => {
    const cause: TerminalCauseRuntimeVeto = {
      ...BASE,
      kind: 'runtime-veto',
      reason: 'policy veto',
      veto: SAMPLE_VETO,
      cancellation: {
        requestedAt: '2026-04-20T00:00:01.000Z',
      },
    };
    const result = assertTerminalCause(cause) as TerminalCauseRuntimeVeto;
    expect(result.cancellation?.cancelMode).toBeUndefined();
  });

  it('accepts runtime-veto without any cancellation block (field itself optional)', () => {
    const cause: TerminalCauseRuntimeVeto = {
      ...BASE,
      kind: 'runtime-veto',
      reason: 'policy veto',
      veto: SAMPLE_VETO,
    };
    const result = assertTerminalCause(cause) as TerminalCauseRuntimeVeto;
    expect(result.cancellation).toBeUndefined();
  });

  it('rejects runtime-veto with cancellation.cancelMode outside the three-value enum', () => {
    const bogus = {
      ...BASE,
      kind: 'runtime-veto',
      reason: 'policy veto',
      veto: SAMPLE_VETO,
      cancellation: {
        requestedAt: '2026-04-20T00:00:01.000Z',
        cancelMode: 'forceful',
      },
    };
    expect(() => assertTerminalCause(bogus)).toThrow(TypeError);
    expect(() => assertTerminalCause(bogus)).toThrow(/cancelMode/);
  });

  it('rejects runtime-veto with non-string cancelMode', () => {
    const bogus = {
      ...BASE,
      kind: 'runtime-veto',
      reason: 'policy veto',
      veto: SAMPLE_VETO,
      cancellation: {
        requestedAt: '2026-04-20T00:00:01.000Z',
        cancelMode: null,
      },
    };
    expect(() => assertTerminalCause(bogus)).toThrow(TypeError);
  });
});

describe('WU-K CancelMode type — static reservation (AC-K1)', () => {
  it('exposes exactly the three reserved values cooperative|preemptive|degraded', () => {
    // Compile-time exhaustiveness: removing a member from this map would fail
    // type-checking, and adding a fourth literal here would also fail.
    const coverage: Record<CancelMode, true> = {
      cooperative: true,
      preemptive: true,
      degraded: true,
    };
    expect(Object.keys(coverage).sort()).toEqual(['cooperative', 'degraded', 'preemptive']);
  });
});

// ---------------------------------------------------------------------------
// WU-K cancelDetail — structured cancel-origin metadata
// ---------------------------------------------------------------------------

describe('WU-K cancelDetail — TerminalCauseExternalCancel', () => {
  it.each(CANCEL_ORIGIN_PORTS as readonly CancelOriginPort[])(
    'accepts external-cancel with cancelDetail.originPort=%s',
    (originPort) => {
      const cause: TerminalCauseExternalCancel = {
        ...BASE,
        kind: 'external-cancel',
        reason: 'r',
        requestedAt: '2026-04-20T00:00:01.000Z',
        cancelMode: 'cooperative',
        cancelDetail: { originPort },
      };
      const result = assertTerminalCause(cause) as TerminalCauseExternalCancel;
      expect(result.cancelDetail?.originPort).toBe(originPort);
    },
  );

  it('accepts external-cancel with full cancelDetail (signal, observedExitCode, observedAt)', () => {
    const detail: CancelModeDetail = {
      originPort: 'compute-node:container-signal',
      signal: 'SIGTERM',
      observedExitCode: 143,
      observedAt: '2026-04-20T00:00:02.000Z',
    };
    const cause: TerminalCauseExternalCancel = {
      ...BASE,
      kind: 'external-cancel',
      reason: 'r',
      requestedAt: '2026-04-20T00:00:01.000Z',
      cancelMode: 'preemptive',
      cancelDetail: detail,
    };
    const result = assertTerminalCause(cause) as TerminalCauseExternalCancel;
    expect(result.cancelDetail).toEqual(detail);
  });

  it('rejects external-cancel with non-enum originPort (AC-K9 — no provider plurality leak)', () => {
    const bogus = {
      ...BASE,
      kind: 'external-cancel',
      reason: 'r',
      requestedAt: '2026-04-20T00:00:01.000Z',
      cancelDetail: { originPort: 'local-compute-node:x' },
    };
    expect(() => assertTerminalCause(bogus)).toThrow(TypeError);
    expect(() => assertTerminalCause(bogus)).toThrow(/cancelDetail/);
  });

  it('rejects cancelDetail with non-string signal', () => {
    const bogus = {
      ...BASE,
      kind: 'external-cancel',
      reason: 'r',
      requestedAt: '2026-04-20T00:00:01.000Z',
      cancelDetail: { originPort: 'codex-sdk-abort', signal: 15 },
    };
    expect(() => assertTerminalCause(bogus)).toThrow(TypeError);
  });

  it('rejects cancelDetail with non-number observedExitCode', () => {
    const bogus = {
      ...BASE,
      kind: 'external-cancel',
      reason: 'r',
      requestedAt: '2026-04-20T00:00:01.000Z',
      cancelDetail: { originPort: 'codex-sdk-abort', observedExitCode: '0' },
    };
    expect(() => assertTerminalCause(bogus)).toThrow(TypeError);
  });

  it('rejects cancelDetail with non-finite observedExitCode', () => {
    const bogus = {
      ...BASE,
      kind: 'external-cancel',
      reason: 'r',
      requestedAt: '2026-04-20T00:00:01.000Z',
      cancelDetail: { originPort: 'codex-sdk-abort', observedExitCode: Number.NaN },
    };
    expect(() => assertTerminalCause(bogus)).toThrow(TypeError);
  });

  it('rejects cancelDetail with non-string observedAt', () => {
    const bogus = {
      ...BASE,
      kind: 'external-cancel',
      reason: 'r',
      requestedAt: '2026-04-20T00:00:01.000Z',
      cancelDetail: { originPort: 'codex-sdk-abort', observedAt: 42 },
    };
    expect(() => assertTerminalCause(bogus)).toThrow(TypeError);
  });
});

describe('WU-K cancelDetail — TerminalCauseRuntimeVeto.cancellation', () => {
  it.each(CANCEL_ORIGIN_PORTS as readonly CancelOriginPort[])(
    'accepts runtime-veto with cancellation.cancelDetail.originPort=%s',
    (originPort) => {
      const cause: TerminalCauseRuntimeVeto = {
        ...BASE,
        kind: 'runtime-veto',
        reason: 'policy veto',
        veto: SAMPLE_VETO,
        cancellation: {
          requestedAt: '2026-04-20T00:00:01.000Z',
          cancelMode: 'degraded',
          cancelDetail: { originPort },
        },
      };
      const result = assertTerminalCause(cause) as TerminalCauseRuntimeVeto;
      expect(result.cancellation?.cancelDetail?.originPort).toBe(originPort);
    },
  );

  it('rejects runtime-veto cancellation with non-enum originPort', () => {
    const bogus = {
      ...BASE,
      kind: 'runtime-veto',
      reason: 'policy veto',
      veto: SAMPLE_VETO,
      cancellation: {
        requestedAt: '2026-04-20T00:00:01.000Z',
        cancelDetail: { originPort: 'provider:openai' },
      },
    };
    expect(() => assertTerminalCause(bogus)).toThrow(TypeError);
    expect(() => assertTerminalCause(bogus)).toThrow(/cancelDetail/);
  });
});

describe('WU-K cloneTerminalCause preserves cancelDetail deep-copy', () => {
  it('external-cancel — cloned cancelDetail equals but is not the same reference', () => {
    const detail: CancelModeDetail = {
      originPort: 'compute-node:slurm-scancel',
      signal: 'SIGKILL',
      observedExitCode: 137,
      observedAt: '2026-04-20T00:00:02.000Z',
    };
    const cause: TerminalCauseExternalCancel = {
      ...BASE,
      kind: 'external-cancel',
      reason: 'r',
      requestedAt: '2026-04-20T00:00:01.000Z',
      cancelMode: 'preemptive',
      cancelDetail: detail,
    };
    const cloned = cloneTerminalCause(cause) as TerminalCauseExternalCancel;
    expect(cloned.cancelDetail).toEqual(detail);
    expect(cloned.cancelDetail).not.toBe(detail);
  });

  it('runtime-veto — cloned cancellation.cancelDetail equals but is not the same reference', () => {
    const detail: CancelModeDetail = {
      originPort: 'roster-saturation-latch',
    };
    const cause: TerminalCauseRuntimeVeto = {
      ...BASE,
      kind: 'runtime-veto',
      reason: 'policy veto',
      veto: SAMPLE_VETO,
      cancellation: {
        requestedAt: '2026-04-20T00:00:01.000Z',
        cancelMode: 'degraded',
        cancelDetail: detail,
      },
    };
    const cloned = cloneTerminalCause(cause) as TerminalCauseRuntimeVeto;
    expect(cloned.cancellation?.cancelDetail).toEqual(detail);
    expect(cloned.cancellation?.cancelDetail).not.toBe(detail);
  });
});
