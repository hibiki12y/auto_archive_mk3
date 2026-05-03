/**
 * WU-G — `src/contracts/capability-flag.ts` vocabulary tests.
 *
 * Spec: `specs/CURRENT/trait-module-submodule-plugin-system.md`. Covers the
 * capability-flag boundary introduced by the TraitModule redesign:
 *   - `CapabilityFlag` literal union (closed; canonical members only)
 *   - `CAPABILITY_FLAGS` frozen runtime enumeration (parity with `CapabilityFlag`)
 *   - `isCapabilityFlag` / `isCapabilityFlags` type guards
 *
 * Also enforces module-hygiene invariants from §6.7 (zero runtime
 * dependencies; whitelist purity).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  CAPABILITY_FLAGS,
  isCapabilityFlag,
  isCapabilityFlags,
  type CapabilityFlag,
  type CapabilityFlags,
} from '../../src/contracts/capability-flag.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPABILITY_FLAG_SOURCE = readFileSync(
  resolve(HERE, '../../src/contracts/capability-flag.ts'),
  'utf8',
);

describe('contracts/capability-flag — CapabilityFlag union', () => {
  it('has the canonical compute/resource capability identifiers', () => {
    expectTypeOf<CapabilityFlag>().toEqualTypeOf<
      | 'network-access'
      | 'sandbox-mode'
      | 'approval-policy'
      | 'web-search-mode'
    >();
  });

  it('CAPABILITY_FLAGS enumerates every member of CapabilityFlag (in order)', () => {
    expect([...CAPABILITY_FLAGS]).toEqual([
      'network-access',
      'sandbox-mode',
      'approval-policy',
      'web-search-mode',
    ]);
  });

  it('CAPABILITY_FLAGS is frozen at runtime', () => {
    expect(Object.isFrozen(CAPABILITY_FLAGS)).toBe(true);
  });

  it('CapabilityFlags is structurally a ReadonlyArray<CapabilityFlag>', () => {
    const flags: CapabilityFlags = ['network-access', 'sandbox-mode'];
    expectTypeOf(flags).toEqualTypeOf<ReadonlyArray<CapabilityFlag>>();
  });
});

describe('contracts/capability-flag — isCapabilityFlag', () => {
  it('returns true for every canonical CapabilityFlag', () => {
    for (const trait of CAPABILITY_FLAGS) {
      expect(isCapabilityFlag(trait)).toBe(true);
    }
  });

  it('returns false for non-CapabilityFlag strings', () => {
    expect(isCapabilityFlag('')).toBe(false);
    expect(isCapabilityFlag('Network-Access')).toBe(false); // case-sensitive
    expect(isCapabilityFlag('network')).toBe(false);
    expect(isCapabilityFlag('runtime-veto')).toBe(false);
    expect(isCapabilityFlag('methodology-skill')).toBe(false);
    expect(isCapabilityFlag('templerun')).toBe(false);
  });

  it('narrows the input type when true', () => {
    const candidate: string = 'network-access';
    if (isCapabilityFlag(candidate)) {
      expectTypeOf(candidate).toEqualTypeOf<CapabilityFlag>();
    }
  });
});

describe('contracts/capability-flag — isCapabilityFlags', () => {
  it('accepts an empty array', () => {
    expect(isCapabilityFlags([])).toBe(true);
  });

  it('accepts an array of all canonical capability flags', () => {
    expect(isCapabilityFlags([...CAPABILITY_FLAGS])).toBe(true);
  });

  it('rejects arrays containing a non-CapabilityFlag string', () => {
    expect(isCapabilityFlags(['network-access', 'bogus'])).toBe(false);
  });

  it('rejects arrays containing a non-string element', () => {
    expect(isCapabilityFlags(['network-access', 1])).toBe(false);
    expect(isCapabilityFlags(['network-access', null])).toBe(false);
  });

  it('rejects non-array inputs', () => {
    expect(isCapabilityFlags(undefined)).toBe(false);
    expect(isCapabilityFlags(null)).toBe(false);
    expect(isCapabilityFlags('network-access')).toBe(false);
    expect(isCapabilityFlags({ 0: 'network-access', length: 1 })).toBe(false);
  });
});

describe('contracts/capability-flag — module hygiene (§6.7)', () => {
  it('declares zero runtime imports (behavior-free, dependency-free)', () => {
    // The contract module must not import from src/core/, src/runtime/,
    // src/agents/, or any WU-specific path. Only sibling src/contracts/*
    // type-only re-exports would be permitted; none currently exist.
    const importLines = CAPABILITY_FLAG_SOURCE.split('\n').filter((line) =>
      /^\s*import\s/.test(line),
    );
    expect(importLines).toEqual([]);
  });

  it('does not leak the templerun reference identity (C4 / AC-G5)', () => {
    expect(/templerun/i.test(CAPABILITY_FLAG_SOURCE)).toBe(false);
  });

  it('exports no symbol whose name binds to a single consumer identity', () => {
    // Surface-level enforcement of C4 reframed: no exported type, value,
    // or function may carry a consumer-centric prefix (Plana, Arona,
    // TraitGate, etc.) at the contract layer.
    const exportedSymbols = Array.from(
      CAPABILITY_FLAG_SOURCE.matchAll(
        /^export\s+(?:type|interface|const|function|class)\s+(\w+)/gm,
      ),
    ).map((m) => m[1]);
    for (const name of exportedSymbols) {
      expect(name).not.toMatch(/^(Plana|Arona|TraitGate)/i);
    }
  });
});
