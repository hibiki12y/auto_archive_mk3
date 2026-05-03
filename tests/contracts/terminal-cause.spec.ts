import { describe, expect, it } from 'vitest';

import {
  PROVIDER_FAILURE_CLASSIFICATIONS,
  TERMINAL_CAUSE_KINDS,
  _exhaustProviderFailureClassification,
  assertTerminalCause,
  cloneTerminalCause,
  type ProviderFailureClassification,
  type TerminalCause,
  type TerminalCauseDriverFailure,
  type TerminalCauseExternalCancel,
  type TerminalCauseProviderFailure,
  type TerminalCauseRuntimeVeto,
  type TerminalCauseSuccess,
  type TerminalCauseTimeout,
} from '../../src/contracts/terminal-cause.js';
import { createVetoPath, type VetoPath } from '../../src/contracts/veto.js';

const BASE = {
  taskId: 'task-1',
  runtimeInstanceId: 'agent-task-1',
  observedAt: '2026-04-20T00:00:00.000Z',
  provenance: 'test',
};

const SAMPLE_VETO: VetoPath = createVetoPath('runtime', 'blocked', 'unit-test');

function buildProviderFailureSample(
  classification: ProviderFailureClassification,
  retryable: boolean,
  message: string,
): TerminalCauseProviderFailure {
  return {
    ...BASE,
    kind: 'provider-failure',
    provider: 'codex',
    classification,
    retryable,
    message,
  };
}

const PROVIDER_FAILURE_SAMPLES: Record<
  ProviderFailureClassification,
  TerminalCauseProviderFailure
> = {
  'rate-limit': buildProviderFailureSample('rate-limit', true, '429 too many requests'),
  'quota-exhausted': buildProviderFailureSample(
    'quota-exhausted',
    false,
    'insufficient_quota: billing exhausted',
  ),
  'transient-network': buildProviderFailureSample(
    'transient-network',
    true,
    'connection timed out',
  ),
  'transient-server': buildProviderFailureSample(
    'transient-server',
    true,
    '503 service unavailable',
  ),
  'transient-tool': buildProviderFailureSample(
    'transient-tool',
    true,
    'tool invocation failed transiently',
  ),
  'permanent-auth': buildProviderFailureSample(
    'permanent-auth',
    false,
    '401 unauthorized: invalid api key',
  ),
  'permanent-config': buildProviderFailureSample(
    'permanent-config',
    false,
    'invalid model configuration',
  ),
  'permanent-protocol': buildProviderFailureSample(
    'permanent-protocol',
    false,
    'malformed response from provider',
  ),
  unknown: buildProviderFailureSample('unknown', false, 'model unavailable'),
};

const SAMPLES: Record<TerminalCause['kind'], TerminalCause> = {
  success: { ...BASE, kind: 'success', artifactLocation: 'results/x' },
  timeout: {
    ...BASE,
    kind: 'timeout',
    deadlineMs: 5,
    firedAt: '2026-04-20T00:00:00.005Z',
  },
  'external-cancel': {
    ...BASE,
    kind: 'external-cancel',
    reason: 'operator stop',
    requestedAt: '2026-04-20T00:00:00.001Z',
    cancelMode: 'cooperative',
  },
  'runtime-veto': {
    ...BASE,
    kind: 'runtime-veto',
    reason: 'blocked',
    veto: SAMPLE_VETO,
    cancellation: { requestedAt: '2026-04-20T00:00:00.002Z' },
  },
  'driver-failure': {
    ...BASE,
    kind: 'driver-failure',
    phase: 'runtime execution',
    message: 'driver crashed',
  },
  'provider-failure': PROVIDER_FAILURE_SAMPLES['rate-limit'],
};

describe('TerminalCause discriminated union', () => {
  it('exposes all six kinds in TERMINAL_CAUSE_KINDS', () => {
    expect(new Set(TERMINAL_CAUSE_KINDS)).toEqual(
      new Set([
        'success',
        'timeout',
        'external-cancel',
        'runtime-veto',
        'driver-failure',
        'provider-failure',
      ]),
    );
  });

  it('exposes all nine provider-failure classifications', () => {
    expect(new Set(PROVIDER_FAILURE_CLASSIFICATIONS)).toEqual(
      new Set([
        'rate-limit',
        'quota-exhausted',
        'transient-network',
        'transient-server',
        'transient-tool',
        'permanent-auth',
        'permanent-config',
        'permanent-protocol',
        'unknown',
      ]),
    );
  });

  it('SAMPLES covers every kind (exhaustiveness via dispatch)', () => {
    for (const kind of TERMINAL_CAUSE_KINDS) {
      const sample = SAMPLES[kind];
      expect(sample.kind).toBe(kind);
    }
  });

  it('clone produces a deep equal but distinct object for every kind', () => {
    for (const kind of TERMINAL_CAUSE_KINDS) {
      const original = SAMPLES[kind];
      const cloned = cloneTerminalCause(original);
      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
    }
  });

  it('clone of provider-failure preserves optional forward-reserved fields when present', () => {
    const original: TerminalCauseProviderFailure = {
      ...PROVIDER_FAILURE_SAMPLES['rate-limit'],
      retryAfterMs: 1500,
      attemptsExhausted: 3,
      sdkErrorCode: 'rate_limit_exceeded',
    };
    const cloned = cloneTerminalCause(original) as TerminalCauseProviderFailure;
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned.retryAfterMs).toBe(1500);
    expect(cloned.attemptsExhausted).toBe(3);
    expect(cloned.sdkErrorCode).toBe('rate_limit_exceeded');
  });

  it('clone of provider-failure omits optional forward-reserved fields when absent', () => {
    const cloned = cloneTerminalCause(
      PROVIDER_FAILURE_SAMPLES['transient-network'],
    ) as TerminalCauseProviderFailure;
    expect('retryAfterMs' in cloned).toBe(false);
    expect('attemptsExhausted' in cloned).toBe(false);
    expect('sdkErrorCode' in cloned).toBe(false);
  });

  it('clone of runtime-veto deep-clones the nested VetoPath.propagation', () => {
    const original = SAMPLES['runtime-veto'] as TerminalCauseRuntimeVeto;
    const cloned = cloneTerminalCause(original) as TerminalCauseRuntimeVeto;
    expect(cloned.veto.propagation).not.toBe(original.veto.propagation);
  });

  it('exhaustiveness: switch on cause.kind compiles when all branches handled', () => {
    function describe(cause: TerminalCause): string {
      switch (cause.kind) {
        case 'success':
          return 'ok';
        case 'timeout':
          return `timed out after ${cause.deadlineMs}ms`;
        case 'external-cancel':
          return `cancelled at ${cause.requestedAt}`;
        case 'runtime-veto':
          return `vetoed: ${cause.reason}`;
        case 'driver-failure':
          return `driver-failure in ${cause.phase}`;
        case 'provider-failure':
          return `provider-failure[${cause.classification}]: ${cause.message}`;
        default: {
          const _exhaustive: never = cause;
          return _exhaustive;
        }
      }
    }
    for (const kind of TERMINAL_CAUSE_KINDS) {
      expect(typeof describe(SAMPLES[kind])).toBe('string');
    }
  });

  it('AC-3 exhaustiveness: switch on ProviderFailureClassification compiles for all nine axes', () => {
    // _exhaustProviderFailureClassification (terminal-cause.ts) is the canonical
    // proof: adding a new classification value will fail to compile until the
    // switch is updated AND every consumer that mirrors this pattern is updated.
    for (const classification of PROVIDER_FAILURE_CLASSIFICATIONS) {
      expect(_exhaustProviderFailureClassification(classification)).toBe(classification);
    }
  });
});

describe('assertTerminalCause validator', () => {
  it('accepts every valid sample', () => {
    for (const kind of TERMINAL_CAUSE_KINDS) {
      expect(() => assertTerminalCause(SAMPLES[kind])).not.toThrow();
    }
  });

  it('accepts all nine provider-failure classifications', () => {
    for (const classification of PROVIDER_FAILURE_CLASSIFICATIONS) {
      expect(() =>
        assertTerminalCause(PROVIDER_FAILURE_SAMPLES[classification]),
      ).not.toThrow();
    }
  });

  it('accepts provider-failure with optional forward-reserved fields when types are correct', () => {
    const ok: TerminalCauseProviderFailure = {
      ...PROVIDER_FAILURE_SAMPLES['rate-limit'],
      retryAfterMs: 250,
      attemptsExhausted: 2,
      sdkErrorCode: 'rate_limit',
    };
    expect(() => assertTerminalCause(ok)).not.toThrow();
  });

  it('rejects non-object input', () => {
    expect(() => assertTerminalCause(null)).toThrow(TypeError);
    expect(() => assertTerminalCause('success')).toThrow(TypeError);
    expect(() => assertTerminalCause(42)).toThrow(TypeError);
  });

  it('rejects unknown kind', () => {
    expect(() => assertTerminalCause({ ...BASE, kind: 'mystery' })).toThrow(
      /one of: success/,
    );
  });

  it('rejects missing base fields', () => {
    expect(() =>
      assertTerminalCause({
        kind: 'success',
        runtimeInstanceId: 'a',
        observedAt: 'b',
        provenance: 'c',
      }),
    ).toThrow(/taskId/);
  });

  it('rejects timeout with non-numeric deadlineMs', () => {
    const bad = { ...BASE, kind: 'timeout', deadlineMs: 'soon', firedAt: 'now' };
    expect(() => assertTerminalCause(bad)).toThrow(/deadlineMs/);
  });

  it('rejects external-cancel with bad cancelMode', () => {
    const bad = {
      ...BASE,
      kind: 'external-cancel',
      reason: 'r',
      requestedAt: 'now',
      cancelMode: 'forceful',
    };
    expect(() => assertTerminalCause(bad)).toThrow(/cancelMode/);
  });

  it('rejects runtime-veto with malformed veto', () => {
    const bad = {
      ...BASE,
      kind: 'runtime-veto',
      reason: 'r',
      veto: { origin: 'invalid-origin' },
    };
    expect(() => assertTerminalCause(bad)).toThrow(/veto/);
  });

  it('rejects driver-failure with empty phase', () => {
    const bad = { ...BASE, kind: 'driver-failure', phase: '', message: 'm' };
    expect(() => assertTerminalCause(bad)).toThrow(/phase/);
  });

  it('rejects provider-failure missing provider field', () => {
    const bad = {
      ...BASE,
      kind: 'provider-failure',
      classification: 'rate-limit',
      retryable: true,
      message: 'm',
    };
    expect(() => assertTerminalCause(bad)).toThrow(/provider/);
  });

  it('rejects provider-failure with provider !== codex', () => {
    const bad = { ...PROVIDER_FAILURE_SAMPLES['rate-limit'], provider: 'openai' };
    expect(() => assertTerminalCause(bad)).toThrow(/codex/);
  });

  it('rejects provider-failure missing classification', () => {
    const bad: Record<string, unknown> = { ...PROVIDER_FAILURE_SAMPLES['rate-limit'] };
    delete bad['classification'];
    expect(() => assertTerminalCause(bad)).toThrow(/classification/);
  });

  it('rejects provider-failure with classification outside the 4-axis enum', () => {
    const bad = {
      ...PROVIDER_FAILURE_SAMPLES['rate-limit'],
      classification: 'flaky',
    };
    expect(() => assertTerminalCause(bad)).toThrow(/classification/);
  });

  it('rejects provider-failure missing retryable', () => {
    const bad: Record<string, unknown> = { ...PROVIDER_FAILURE_SAMPLES['rate-limit'] };
    delete bad['retryable'];
    expect(() => assertTerminalCause(bad)).toThrow(/retryable/);
  });

  it('rejects provider-failure with non-boolean retryable (string)', () => {
    const bad = { ...PROVIDER_FAILURE_SAMPLES['rate-limit'], retryable: 'true' };
    expect(() => assertTerminalCause(bad)).toThrow(/retryable/);
  });

  it('rejects provider-failure missing message', () => {
    const bad: Record<string, unknown> = { ...PROVIDER_FAILURE_SAMPLES['rate-limit'] };
    delete bad['message'];
    expect(() => assertTerminalCause(bad)).toThrow(/message/);
  });

  it('rejects provider-failure with non-numeric retryAfterMs', () => {
    const bad = { ...PROVIDER_FAILURE_SAMPLES['rate-limit'], retryAfterMs: 'soon' };
    expect(() => assertTerminalCause(bad)).toThrow(/retryAfterMs/);
  });

  it('rejects provider-failure with non-numeric attemptsExhausted', () => {
    const bad = {
      ...PROVIDER_FAILURE_SAMPLES['rate-limit'],
      attemptsExhausted: '3',
    };
    expect(() => assertTerminalCause(bad)).toThrow(/attemptsExhausted/);
  });

  it('rejects provider-failure with non-string sdkErrorCode', () => {
    const bad = { ...PROVIDER_FAILURE_SAMPLES['rate-limit'], sdkErrorCode: 42 };
    expect(() => assertTerminalCause(bad)).toThrow(/sdkErrorCode/);
  });

  it('returns the value with TerminalCause typing on success', () => {
    const validated = assertTerminalCause(SAMPLES['success']);
    // Static assignability check (TS-only).
    const ok: TerminalCauseSuccess =
      validated.kind === 'success' ? validated : SAMPLES['success'] as TerminalCauseSuccess;
    expect(ok.kind).toBe('success');
  });
});

describe('TerminalCause is JSON round-trippable (VN-5)', () => {
  it('every sample round-trips through JSON.stringify / JSON.parse and re-validates', () => {
    for (const kind of TERMINAL_CAUSE_KINDS) {
      const original = SAMPLES[kind];
      const round = JSON.parse(JSON.stringify(original)) as unknown;
      expect(() => assertTerminalCause(round)).not.toThrow();
      expect(round).toEqual(original);
    }
  });

  it('every provider-failure classification sample round-trips', () => {
    for (const classification of PROVIDER_FAILURE_CLASSIFICATIONS) {
      const original = PROVIDER_FAILURE_SAMPLES[classification];
      const round = JSON.parse(JSON.stringify(original)) as unknown;
      expect(() => assertTerminalCause(round)).not.toThrow();
      expect(round).toEqual(original);
    }
  });
});

describe('TerminalCause type narrowing matrix', () => {
  it('discriminates success/timeout/external-cancel/runtime-veto/driver-failure/provider-failure', () => {
    const succ = SAMPLES['success'] as TerminalCauseSuccess;
    const tout = SAMPLES['timeout'] as TerminalCauseTimeout;
    const ext = SAMPLES['external-cancel'] as TerminalCauseExternalCancel;
    const veto = SAMPLES['runtime-veto'] as TerminalCauseRuntimeVeto;
    const drv = SAMPLES['driver-failure'] as TerminalCauseDriverFailure;
    const prov = SAMPLES['provider-failure'] as TerminalCauseProviderFailure;
    expect(succ.artifactLocation).toBe('results/x');
    expect(tout.deadlineMs).toBe(5);
    expect(ext.cancelMode).toBe('cooperative');
    expect(veto.veto.reason).toBe('blocked');
    expect(drv.phase).toBe('runtime execution');
    expect(prov.provider).toBe('codex');
    expect(prov.classification).toBe('rate-limit');
    expect(prov.retryable).toBe(true);
    expect(prov.message).toBe('429 too many requests');
  });
});
