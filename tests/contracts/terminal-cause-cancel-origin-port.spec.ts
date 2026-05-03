import { describe, expect, it } from 'vitest';

import {
  CANCEL_ORIGIN_PORTS,
  _exhaustCancelMode,
  type CancelMode,
} from '../../src/contracts/terminal-cause.js';

/**
 * WU-K — CancelOriginPort enum hygiene + CancelMode exhaustiveness.
 *
 * Guards AC-K9 (no provider plurality / originator / slurm-only /
 * local-compute-node prefixes) and §0 C1–C4 constraints from the spec:
 *   - C1: no multi-provider leak → reject any `provider:*` prefix.
 *   - C3: no originator plurality → reject `originator:*`.
 *   - C2: the unified ComputeNode port must be the only signal carrier →
 *         reject `slurm-only:*` and `local-compute-node:*` prefixes (the
 *         compute-node-shaped members use the shared `compute-node:*`
 *         prefix exclusively).
 */

describe('WU-K CancelOriginPort enum hygiene (AC-K9)', () => {
  const FORBIDDEN_PREFIXES = [
    'provider:',
    'originator:',
    'slurm-only:',
    'local-compute-node:',
  ] as const;

  for (const prefix of FORBIDDEN_PREFIXES) {
    it(`contains no member with forbidden prefix '${prefix}'`, () => {
      const offenders = CANCEL_ORIGIN_PORTS.filter((p) => p.startsWith(prefix));
      expect(offenders).toEqual([]);
    });
  }

  it('is a non-empty closed enumeration', () => {
    expect(CANCEL_ORIGIN_PORTS.length).toBeGreaterThan(0);
    // Uniqueness guard — catches accidental duplicate enum values.
    expect(new Set(CANCEL_ORIGIN_PORTS).size).toBe(CANCEL_ORIGIN_PORTS.length);
  });
});

describe('WU-K _exhaustCancelMode — switch coverage over the three values', () => {
  const MODES: readonly CancelMode[] = ['cooperative', 'preemptive', 'degraded'];

  for (const mode of MODES) {
    it(`returns the mode literal '${mode}'`, () => {
      expect(_exhaustCancelMode(mode)).toBe(mode);
    });
  }
});
