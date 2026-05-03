/**
 * WU-R Boundary Validators — contract tests.
 *
 * Spec: `specs/wu-r-validator-process-boundaries.md` §2, §6 AC-R1..AC-R10,
 * §6.8 Session 115 RESOLVED (hand-rolled binding).
 *
 * Verifies the four named entry-points, TypeError normalization,
 * `BoundaryValidationError` shape (boundary tag + preserved cause),
 * `validateCheckpointLoad` version precondition, and the shared primitive
 * helpers (`requireObject`, `requireString`, `requireArray`, `formatPath`).
 *
 * Anti-scope: this file does NOT exercise wire-ins at any call site
 * (Discord, codex-runtime-adapter, settings loader, checkpoint loader) —
 * those are deferred to downstream WUs per the contract-module-only slice.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  BoundaryValidationError,
  formatPath,
  requireArray,
  requireObject,
  requireString,
  validateCheckpointLoad,
  validateCodexResponse,
  validateIpcIngress,
  validateSettingsLoad,
  type BoundaryAssert,
  type BoundaryName,
} from '../../src/contracts/boundary-validators.js';

interface Sample {
  readonly kind: 'sample';
  readonly value: string;
}

function assertSample(raw: unknown): asserts raw is Sample {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('sample must be an object');
  }
  const r = raw as Record<string, unknown>;
  if (r['kind'] !== 'sample') {
    throw new TypeError('sample.kind must be "sample"');
  }
  if (typeof r['value'] !== 'string') {
    throw new TypeError('sample.value must be a string');
  }
}

const entryPoints: ReadonlyArray<{
  boundary: BoundaryName;
  invoke: (raw: unknown, assert: BoundaryAssert<Sample>) => Sample;
}> = [
  { boundary: 'B-IPC', invoke: (r, a) => validateIpcIngress<Sample>(r, a) },
  { boundary: 'B-CDX', invoke: (r, a) => validateCodexResponse<Sample>(r, a) },
  { boundary: 'B-SET', invoke: (r, a) => validateSettingsLoad<Sample>(r, a) },
  {
    boundary: 'B-CKP',
    invoke: (r, a) => validateCheckpointLoad<Sample>(r, a, 'v1'),
  },
];

describe('WU-R boundary-validators contract', () => {
  describe('entry-point happy paths (narrowed T returned)', () => {
    for (const { boundary, invoke } of entryPoints) {
      it(`${boundary} returns the validated payload on success`, () => {
        const input: unknown = { kind: 'sample', value: 'ok' };
        const result = invoke(input, assertSample);
        expect(result).toBe(input);
        expect(result.value).toBe('ok');
      });
    }
  });

  describe('entry-point TypeError normalization', () => {
    for (const { boundary, invoke } of entryPoints) {
      it(`${boundary} wraps a TypeError as BoundaryValidationError with tag + cause`, () => {
        const original = new TypeError('sample.value must be a string');
        const assert: BoundaryAssert<Sample> = () => {
          throw original;
        };
        let caught: unknown;
        try {
          invoke({ broken: true }, assert);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(BoundaryValidationError);
        expect(caught).toBeInstanceOf(TypeError);
        const bve = caught as BoundaryValidationError;
        expect(bve.boundary).toBe(boundary);
        expect(bve.cause).toBe(original);
        expect(bve.message).toBe(`[${boundary}] sample.value must be a string`);
      });

      it(`${boundary} wraps a non-TypeError with a "non-TypeError" prefix`, () => {
        const original = new Error('plain failure');
        const assert: BoundaryAssert<Sample> = () => {
          throw original;
        };
        let caught: unknown;
        try {
          invoke({}, assert);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(BoundaryValidationError);
        const bve = caught as BoundaryValidationError;
        expect(bve.boundary).toBe(boundary);
        expect(bve.cause).toBe(original);
        expect(bve.message).toBe(
          `[${boundary}] validator threw non-TypeError: plain failure`,
        );
      });

      it(`${boundary} passes an already-BoundaryValidationError through without double-wrapping`, () => {
        const inner = new BoundaryValidationError(boundary, 'inner rejection');
        const assert: BoundaryAssert<Sample> = () => {
          throw inner;
        };
        let caught: unknown;
        try {
          invoke({}, assert);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBe(inner);
      });
    }

    it('normalizes a thrown non-Error primitive into a BoundaryValidationError', () => {
      const assert: BoundaryAssert<Sample> = () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'bare string';
      };
      let caught: unknown;
      try {
        validateIpcIngress<Sample>({}, assert);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BoundaryValidationError);
      const bve = caught as BoundaryValidationError;
      expect(bve.boundary).toBe('B-IPC');
      expect(bve.cause).toBe('bare string');
      expect(bve.message).toBe('[B-IPC] validator threw non-TypeError: bare string');
    });
  });

  describe('validateCheckpointLoad version precondition', () => {
    it('rejects empty-string version BEFORE invoking assert', () => {
      const assertSpy = vi.fn(assertSample);
      expect(() =>
        validateCheckpointLoad<Sample>(
          { kind: 'sample', value: 'ok' },
          assertSpy as BoundaryAssert<Sample>,
          '',
        ),
      ).toThrow(BoundaryValidationError);
      expect(assertSpy).not.toHaveBeenCalled();
    });

    it('rejects non-string version BEFORE invoking assert', () => {
      const assertSpy = vi.fn(assertSample);
      let caught: unknown;
      try {
        validateCheckpointLoad<Sample>(
          { kind: 'sample', value: 'ok' },
          assertSpy as BoundaryAssert<Sample>,
          // @ts-expect-error — deliberately wrong runtime type.
          42,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BoundaryValidationError);
      expect((caught as BoundaryValidationError).boundary).toBe('B-CKP');
      expect((caught as BoundaryValidationError).message).toContain(
        'checkpoint version must be a non-empty string',
      );
      expect(assertSpy).not.toHaveBeenCalled();
    });

    it('accepts a non-empty version string and forwards to assert', () => {
      const assertSpy = vi.fn(assertSample);
      const input: unknown = { kind: 'sample', value: 'ok' };
      const out = validateCheckpointLoad<Sample>(
        input,
        assertSpy as BoundaryAssert<Sample>,
        'v2',
      );
      expect(out).toBe(input);
      expect(assertSpy).toHaveBeenCalledTimes(1);
      expect(assertSpy).toHaveBeenCalledWith(input);
    });
  });

  describe('requireObject helper', () => {
    it('accepts a plain object', () => {
      const v: unknown = { a: 1 };
      expect(() => requireObject(v, 'B-IPC', ['root'])).not.toThrow();
    });

    it('rejects null, arrays, and primitives with a formatted path', () => {
      for (const bad of [null, ['x'], 'str', 7, true, undefined]) {
        let caught: unknown;
        try {
          requireObject(bad, 'B-SET', ['root', 'field']);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(BoundaryValidationError);
        expect((caught as BoundaryValidationError).boundary).toBe('B-SET');
        expect((caught as BoundaryValidationError).message).toBe(
          '[B-SET] root.field must be an object.',
        );
      }
    });
  });

  describe('requireString helper', () => {
    it('accepts a string', () => {
      expect(() => requireString('hi', 'B-IPC', ['root'])).not.toThrow();
    });

    it('rejects non-strings', () => {
      for (const bad of [0, null, undefined, {}, []]) {
        expect(() => requireString(bad, 'B-CDX', ['x'])).toThrow(
          BoundaryValidationError,
        );
      }
    });
  });

  describe('requireArray helper', () => {
    it('accepts an array', () => {
      expect(() => requireArray([], 'B-IPC', ['root'])).not.toThrow();
      expect(() => requireArray([1, 2], 'B-IPC', ['root'])).not.toThrow();
    });

    it('rejects non-arrays', () => {
      for (const bad of [{}, 'x', 0, null, undefined]) {
        expect(() => requireArray(bad, 'B-CKP', ['items'])).toThrow(
          BoundaryValidationError,
        );
      }
    });
  });

  describe('formatPath helper', () => {
    it('returns "<root>" for an empty segment list', () => {
      expect(formatPath([])).toBe('<root>');
    });

    it('joins string segments with dots', () => {
      expect(formatPath(['root', 'field', 'nested'])).toBe('root.field.nested');
    });

    it('renders numeric indices as bracket notation', () => {
      expect(formatPath(['root', 'items', 0, 'name'])).toBe(
        'root.items[0].name',
      );
    });

    it('handles a leading numeric segment', () => {
      expect(formatPath([0, 'name'])).toBe('[0].name');
    });

    it('handles mixed segments including consecutive indices', () => {
      expect(formatPath(['m', 0, 1, 'n'])).toBe('m[0][1].n');
    });
  });

  describe('BoundaryValidationError shape', () => {
    it('is a TypeError subclass carrying a readonly boundary tag', () => {
      const err = new BoundaryValidationError('B-IPC', 'bad');
      expect(err).toBeInstanceOf(TypeError);
      expect(err).toBeInstanceOf(BoundaryValidationError);
      expect(err.name).toBe('BoundaryValidationError');
      expect(err.boundary).toBe('B-IPC');
      expect(err.message).toBe('[B-IPC] bad');
      expect(err.cause).toBeUndefined();
    });

    it('preserves a supplied cause', () => {
      const root = new Error('root');
      const err = new BoundaryValidationError('B-CKP', 'nope', root);
      expect(err.cause).toBe(root);
    });
  });
});
