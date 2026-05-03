/**
 * ResourceEnvelope tri-view — contract tests.
 *
 * Spec: redesign §2.3 (tri-view {requested, effective, observed?}),
 *        §7.3 (validators, invariants I1..I4, freeze).
 *
 * Covers invariants:
 *   I1 — requested is required.
 *   I2 — effective ≤ requested on every field.
 *   I3a — planning path rejects observed.
 *   I3b — runtime path accepts observed.
 *   I4  — observed field types / ranges validated.
 */

import { describe, expect, it } from 'vitest';

import {
  assertObservedResourceSummary,
  assertResourceEnvelope,
  assertResourceSpec,
  createPlannedResourceEnvelope,
  createResourceEnvelope,
  freezeResourceEnvelope,
} from '../../src/contracts/resource-envelope.js';

describe('ResourceEnvelope tri-view', () => {
  describe('createResourceEnvelope', () => {
    it('round-trips all three views', () => {
      const env = createResourceEnvelope({
        requested: {
          cpuCores: 4,
          memoryMiB: 8192,
          wallTimeSec: 3600,
          gpuCards: 1,
        },
        effective: {
          cpuCores: 2,
          memoryMiB: 4096,
          wallTimeSec: 1800,
          gpuCards: 0,
        },
        observed: {
          cpuCoresPeak: 2,
          memoryMiBPeak: 3500,
          wallTimeSec: 1700,
          gpuCardsPeak: 0,
          notes: 'nominal',
        },
      });

      expect(env.requested).toEqual({
        cpuCores: 4,
        memoryMiB: 8192,
        wallTimeSec: 3600,
        gpuCards: 1,
      });
      expect(env.effective).toEqual({
        cpuCores: 2,
        memoryMiB: 4096,
        wallTimeSec: 1800,
        gpuCards: 0,
      });
      expect(env.observed).toEqual({
        cpuCoresPeak: 2,
        memoryMiBPeak: 3500,
        wallTimeSec: 1700,
        gpuCardsPeak: 0,
        notes: 'nominal',
      });
    });

    it('defaults effective to a copy of requested when omitted', () => {
      const env = createResourceEnvelope({
        requested: { cpuCores: 2, memoryMiB: 1024, wallTimeSec: 60 },
      });
      expect(env.effective).toEqual({
        cpuCores: 2,
        memoryMiB: 1024,
        wallTimeSec: 60,
        gpuCards: 0,
      });
      expect(env.effective).not.toBe(env.requested);
    });

    it('applies per-field defaults from requested when effective is partial', () => {
      const env = createResourceEnvelope({
        requested: {
          cpuCores: 8,
          memoryMiB: 8192,
          wallTimeSec: 3600,
          gpuCards: 2,
        },
        effective: { cpuCores: 4 },
      });
      expect(env.effective).toEqual({
        cpuCores: 4,
        memoryMiB: 8192,
        wallTimeSec: 3600,
        gpuCards: 2,
      });
    });
  });

  describe('invariants', () => {
    it('I1: missing requested throws', () => {
      expect(() =>
        createResourceEnvelope({
          // @ts-expect-error intentional omission for invariant I1
          requested: undefined,
        }),
      ).toThrow();
    });

    it.each([
      ['cpuCores', { cpuCores: 5 }],
      ['memoryMiB', { memoryMiB: 99999 }],
      ['wallTimeSec', { wallTimeSec: 99999 }],
      ['gpuCards', { gpuCards: 5 }],
    ])(
      'I2: effective.%s > requested.%s throws',
      (_field, override) => {
        expect(() =>
          createResourceEnvelope({
            requested: {
              cpuCores: 2,
              memoryMiB: 1024,
              wallTimeSec: 60,
              gpuCards: 1,
            },
            effective: {
              cpuCores: 2,
              memoryMiB: 1024,
              wallTimeSec: 60,
              gpuCards: 1,
              ...override,
            },
          }),
        ).toThrow(/must not exceed requested/);
      },
    );

    it('I3a: createPlannedResourceEnvelope rejects observed', () => {
      expect(() =>
        createPlannedResourceEnvelope({
          requested: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 30 },
          // @ts-expect-error invariant I3a: planning path forbids observed
          observed: { cpuCoresPeak: 1 },
        }),
      ).toThrow(/observed/);
    });

    it('I3b: createResourceEnvelope accepts observed', () => {
      const env = createResourceEnvelope({
        requested: { cpuCores: 1, memoryMiB: 512, wallTimeSec: 30 },
        observed: { cpuCoresPeak: 1, notes: 'ok' },
      });
      expect(env.observed).toEqual({ cpuCoresPeak: 1, notes: 'ok' });
    });

    it('I4: non-integer cpuCoresPeak throws', () => {
      expect(() =>
        createResourceEnvelope({
          requested: { cpuCores: 2, memoryMiB: 512, wallTimeSec: 30 },
          observed: { cpuCoresPeak: 1.5 },
        }),
      ).toThrow(TypeError);
    });

    it('I4: negative cpuCoresPeak throws', () => {
      expect(() =>
        createResourceEnvelope({
          requested: { cpuCores: 2, memoryMiB: 512, wallTimeSec: 30 },
          observed: { cpuCoresPeak: -1 },
        }),
      ).toThrow(TypeError);
    });

    it('I4: non-finite memoryMiBPeak throws', () => {
      expect(() =>
        createResourceEnvelope({
          requested: { cpuCores: 2, memoryMiB: 512, wallTimeSec: 30 },
          observed: { memoryMiBPeak: Number.POSITIVE_INFINITY },
        }),
      ).toThrow(TypeError);
    });

    it('I4: non-string notes throws', () => {
      expect(() =>
        createResourceEnvelope({
          requested: { cpuCores: 2, memoryMiB: 512, wallTimeSec: 30 },
          // @ts-expect-error invariant I4
          observed: { notes: 123 },
        }),
      ).toThrow(TypeError);
    });
  });

  describe('assertResourceSpec', () => {
    it('returns a normalized ResourceSpec on valid input', () => {
      expect(
        assertResourceSpec({
          cpuCores: 1,
          memoryMiB: 1,
          wallTimeSec: 1,
          gpuCards: 0,
        }),
      ).toEqual({
        cpuCores: 1,
        memoryMiB: 1,
        wallTimeSec: 1,
        gpuCards: 0,
      });
    });

    it.each([null, undefined, [], 'x', 5])(
      'throws TypeError for non-object input (%p)',
      (bad) => {
        expect(() => assertResourceSpec(bad)).toThrow(TypeError);
      },
    );

    it('throws for gpuCards missing', () => {
      expect(() =>
        assertResourceSpec({ cpuCores: 1, memoryMiB: 1, wallTimeSec: 1 }),
      ).toThrow(TypeError);
    });
  });

  describe('assertObservedResourceSummary', () => {
    it('accepts empty object', () => {
      expect(assertObservedResourceSummary({})).toEqual({});
    });

    it('accepts all optional fields populated', () => {
      expect(
        assertObservedResourceSummary({
          cpuCoresPeak: 0,
          memoryMiBPeak: 0,
          wallTimeSec: 0,
          gpuCardsPeak: 0,
          notes: '',
        }),
      ).toEqual({
        cpuCoresPeak: 0,
        memoryMiBPeak: 0,
        wallTimeSec: 0,
        gpuCardsPeak: 0,
        notes: '',
      });
    });

    it('rejects non-object', () => {
      expect(() => assertObservedResourceSummary(null)).toThrow(TypeError);
      expect(() => assertObservedResourceSummary([])).toThrow(TypeError);
    });
  });

  describe('assertResourceEnvelope round-trip', () => {
    it('survives JSON serialize/parse with structural equality', () => {
      const env = createResourceEnvelope({
        requested: {
          cpuCores: 4,
          memoryMiB: 2048,
          wallTimeSec: 600,
          gpuCards: 1,
        },
        effective: { cpuCores: 2, memoryMiB: 1024 },
        observed: { cpuCoresPeak: 2, notes: 'x' },
      });
      const clone = assertResourceEnvelope(JSON.parse(JSON.stringify(env)));
      expect(clone).toEqual(env);
    });

    it('throws when requested is missing', () => {
      expect(() =>
        assertResourceEnvelope({
          effective: {
            cpuCores: 1,
            memoryMiB: 1,
            wallTimeSec: 1,
            gpuCards: 0,
          },
        }),
      ).toThrow(TypeError);
    });

    it('throws when effective exceeds requested', () => {
      expect(() =>
        assertResourceEnvelope({
          requested: {
            cpuCores: 1,
            memoryMiB: 1,
            wallTimeSec: 1,
            gpuCards: 0,
          },
          effective: {
            cpuCores: 2,
            memoryMiB: 1,
            wallTimeSec: 1,
            gpuCards: 0,
          },
        }),
      ).toThrow(TypeError);
    });
  });

  describe('freezeResourceEnvelope', () => {
    it('freezes all tri-view branches', () => {
      const env = createResourceEnvelope({
        requested: { cpuCores: 2, memoryMiB: 512, wallTimeSec: 30 },
        observed: { cpuCoresPeak: 1 },
      });
      const frozen = freezeResourceEnvelope(env);
      expect(Object.isFrozen(frozen)).toBe(true);
      expect(Object.isFrozen(frozen.requested)).toBe(true);
      expect(Object.isFrozen(frozen.effective)).toBe(true);
      expect(Object.isFrozen(frozen.observed)).toBe(true);
    });

    it('mutation of frozen.requested.cpuCores throws in strict mode', () => {
      'use strict';
      const frozen = freezeResourceEnvelope(
        createResourceEnvelope({
          requested: { cpuCores: 2, memoryMiB: 512, wallTimeSec: 30 },
        }),
      );
      expect(() => {
        (frozen.requested).cpuCores = 99;
      }).toThrow(TypeError);
    });

    it('leaves observed undefined when absent', () => {
      const frozen = freezeResourceEnvelope(
        createResourceEnvelope({
          requested: { cpuCores: 1, memoryMiB: 1, wallTimeSec: 1 },
        }),
      );
      expect(frozen.observed).toBeUndefined();
    });
  });
});
