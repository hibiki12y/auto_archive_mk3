/**
 * WU-O — CapabilityFlag → Capability Bounding Sets (Apptainer flag-bundle compile).
 *
 * Acceptance: covers AC-O1 (schema), AC-O2 (deny-by-default), AC-O3 (§5.1
 * compile rules + CR-1..CR-4 invariants), AC-O4 (capability consumer integration),
 * AC-O5 (typed unknown-capability rejection). Spec:
 * `specs/wu-o-trait-capability-bounding-sets.md` §8.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DENIAL_FLOOR,
  UnknownCapabilityError,
  type ApptainerInvocation,
  type CapabilityBoundingSet,
} from '../../src/core/compute-capability.js';
import {
  compileApptainerInvocation,
  compileCapabilityBoundingSet,
  capabilityFlagToApptainerFlags,
} from '../../src/core/compute-node-slurm-apptainer.js';
import { CAPABILITY_FLAGS, type CapabilityFlag } from '../../src/contracts/capability-flag.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPILE_SOURCE = readFileSync(
  resolve(__dirname, '../../src/core/compute-node-slurm-apptainer.ts'),
  'utf8',
);
const CAPABILITY_SOURCE = readFileSync(
  resolve(__dirname, '../../src/core/compute-capability.ts'),
  'utf8',
);

// =====================================================================
// AC-O1 — capability set schema exists with the §3 fields
// =====================================================================

describe('AC-O1: CapabilityBoundingSet schema (§3)', () => {
  it('exports CapabilityBoundingSet defined exactly once in src/core/compute-capability.ts', () => {
    const matches = CAPABILITY_SOURCE.match(/interface\s+CapabilityBoundingSet\b/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it('DENIAL_FLOOR carries schemaVersion=1, all four grant groups, and provenance', () => {
    expect(DENIAL_FLOOR.schemaVersion).toBe(1);
    expect(DENIAL_FLOOR.network).toBeDefined();
    expect(DENIAL_FLOOR.filesystem).toBeDefined();
    expect(DENIAL_FLOOR.process).toBeDefined();
    expect(DENIAL_FLOOR.devices).toBeDefined();
    expect(Array.isArray(DENIAL_FLOOR.provenance)).toBe(true);
  });

  it('CapabilityBoundingSet is JSON-round-trippable (VN-5)', () => {
    const round = JSON.parse(JSON.stringify(DENIAL_FLOOR)) as CapabilityBoundingSet;
    expect(round).toEqual(DENIAL_FLOOR);
  });
});

// =====================================================================
// AC-O2 — deny-by-default semantics (§4 DBD-1..DBD-5)
// =====================================================================

describe('AC-O2: deny-by-default (§4)', () => {
  it('DBD-1: compile([]) ≡ DENIAL_FLOOR (deep equal)', () => {
    expect(compileCapabilityBoundingSet([])).toEqual(DENIAL_FLOOR);
  });

  it('DBD-1: floor has network.mode = "none" and no filesystem write', () => {
    expect(DENIAL_FLOOR.network.mode).toBe('none');
    expect(DENIAL_FLOOR.filesystem.scratchWrite).toBe(false);
    expect(DENIAL_FLOOR.filesystem.readOnlyMounts).toEqual([]);
    expect(DENIAL_FLOOR.filesystem.writeMounts).toEqual([]);
    expect(DENIAL_FLOOR.process).toEqual({ fork: false, exec: false, ptrace: false });
    expect(DENIAL_FLOOR.devices).toEqual({ gpu: false, tty: false });
    expect(DENIAL_FLOOR.provenance).toEqual([]);
  });

  it('DBD-2: monotonicity — adding a capability flag never revokes a grant', () => {
    const t1: CapabilityFlag[] = ['network-access'];
    const t2: CapabilityFlag[] = ['network-access', 'sandbox-mode'];
    const a = compileCapabilityBoundingSet(t1);
    const b = compileCapabilityBoundingSet(t2);
    // any boolean true in `a` remains true in `b`
    expect(b.filesystem.scratchWrite || !a.filesystem.scratchWrite).toBe(true);
    // network rank in b ≥ rank in a
    const rank = { none: 0, 'loopback-only': 1, 'egress-allowlist': 2 } as const;
    expect(rank[b.network.mode] >= rank[a.network.mode]).toBe(true);
  });

  it('DBD-3: conflict resolution — least-permissive upper bound across multiple network-grant flags', () => {
    const set = compileCapabilityBoundingSet(['network-access', 'web-search-mode']);
    expect(set.network.mode).toBe('egress-allowlist');
  });

  it('DBD-4: every non-floor field carries a provenance entry attributing it to a capability flag', () => {
    const set = compileCapabilityBoundingSet(['sandbox-mode']);
    expect(set.filesystem.scratchWrite).toBe(true);
    expect(set.provenance.length).toBeGreaterThan(0);
    const sandboxEntry = set.provenance.find(p => p.capabilityFlag === 'sandbox-mode');
    expect(sandboxEntry).toBeDefined();
    expect(sandboxEntry!.grantedFields).toContain('filesystem.scratchWrite');
  });
});

// =====================================================================
// AC-O3 — Apptainer flag compilation (§5.1) and CR-1..CR-4
// =====================================================================

describe('AC-O3: Apptainer flag-bundle compile (§5.1)', () => {
  it('network.mode = "none" emits --net --network=none', () => {
    const inv = compileApptainerInvocation(DENIAL_FLOOR);
    expect(inv.flags).toContain('--net');
    expect(inv.flags).toContain('--network=none');
  });

  it('filesystem.scratchWrite=false emits --containall and --read-only', () => {
    const inv = compileApptainerInvocation(DENIAL_FLOOR);
    expect(inv.flags).toContain('--containall');
    expect(inv.flags).toContain('--read-only');
    expect(inv.flags).toContain('--no-mount=tmp');
  });

  it('filesystem.scratchWrite=true emits --workdir/--no-mount=home (no --read-only)', () => {
    const set = compileCapabilityBoundingSet(['sandbox-mode']);
    const inv = compileApptainerInvocation(set);
    expect(inv.flags).toContain('--workdir');
    expect(inv.flags).toContain('--no-mount=home');
    expect(inv.flags).not.toContain('--read-only');
  });

  it('readOnlyMounts emits one --bind <p>:<p>:ro per entry', () => {
    const set: CapabilityBoundingSet = {
      ...DENIAL_FLOOR,
      filesystem: {
        scratchWrite: false,
        readOnlyMounts: ['/data', '/etc/cfg'],
        writeMounts: [],
      },
    };
    const inv = compileApptainerInvocation(set);
    expect(inv.flags).toContain('--bind');
    expect(inv.flags).toContain('/data:/data:ro');
    expect(inv.flags).toContain('/etc/cfg:/etc/cfg:ro');
  });

  it('writeMount intersecting readOnlyMount throws UnknownCapabilityError', () => {
    const set: CapabilityBoundingSet = {
      ...DENIAL_FLOOR,
      filesystem: {
        scratchWrite: false,
        readOnlyMounts: ['/data'],
        writeMounts: ['/data'],
      },
    };
    expect(() => compileApptainerInvocation(set)).toThrow(UnknownCapabilityError);
  });

  it('process.fork|exec compiles to seccomp profile "fork-exec" (no flag leak)', () => {
    const set = compileCapabilityBoundingSet(['approval-policy']);
    const inv = compileApptainerInvocation(set);
    expect(inv.seccompProfile).toBe('fork-exec');
    // Process grants do NOT compile to Apptainer CLI flags.
    for (const flag of inv.flags) {
      expect(flag).not.toMatch(/seccomp/i);
      expect(flag).not.toMatch(/fork|exec=/i);
    }
  });

  it('process.ptrace without devices.tty rejects (§5.1 row)', () => {
    const set: CapabilityBoundingSet = {
      ...DENIAL_FLOOR,
      process: { fork: false, exec: false, ptrace: true },
    };
    expect(() => compileApptainerInvocation(set)).toThrow(UnknownCapabilityError);
  });

  it('devices.gpu emits --nv; devices.tty emits --tty', () => {
    const set: CapabilityBoundingSet = {
      ...DENIAL_FLOOR,
      devices: { gpu: true, tty: true },
    };
    const inv = compileApptainerInvocation(set);
    expect(inv.flags).toContain('--nv');
    expect(inv.flags).toContain('--tty');
  });

  it('egress-allowlist mode emits --network=fakeroot and exposes egressAllowlist out-of-band', () => {
    const set = compileCapabilityBoundingSet(['web-search-mode']);
    const inv = compileApptainerInvocation(set);
    expect(inv.flags).toContain('--network=fakeroot');
    expect(inv.egressAllowlist).toBeDefined();
  });

  it('CR-2: no flag string contains provider/codex/openai/templerun substrings', () => {
    // Build a maximally-permissive bounding set to exercise every emitter.
    const set = compileCapabilityBoundingSet([...CAPABILITY_FLAGS]);
    const inv = compileApptainerInvocation({
      ...set,
      devices: { gpu: true, tty: true },
    });
    const blacklist = ['provider', 'codex', 'openai', 'templerun'];
    for (const flag of inv.flags) {
      const lower = flag.toLowerCase();
      for (const banned of blacklist) {
        expect(lower).not.toContain(banned);
      }
    }
  });

  it('CR-3: source switch on CapabilityFlag union has assertNever fallthrough', () => {
    expect(COMPILE_SOURCE).toMatch(/assertNever\(t,\s*['"]capabilityFlagToApptainerFlags['"]\)/);
    expect(COMPILE_SOURCE).toMatch(/assertNever\(t,\s*['"]capabilityFlagToGrantDelta['"]\)/);
  });

  it('CR-4: compile module imports no I/O / clock / random APIs', () => {
    expect(COMPILE_SOURCE).not.toMatch(/from\s+['"]node:fs['"]/);
    expect(COMPILE_SOURCE).not.toMatch(/from\s+['"]node:child_process['"]/);
    expect(COMPILE_SOURCE).not.toMatch(/from\s+['"]node:crypto['"]/);
    expect(COMPILE_SOURCE).not.toMatch(/from\s+['"]crypto['"]/);
  });

  it('CR-1 / CR-4: compile is pure — same input produces deep-equal output', () => {
    const a = compileApptainerInvocation(DENIAL_FLOOR);
    const b = compileApptainerInvocation(DENIAL_FLOOR);
    expect(a).toEqual(b);
    expect(a.flags).toEqual(b.flags);
  });
});

// =====================================================================
// AC-O4 — CapabilityFlag consumer wiring (Stage B: empty / non-empty input)
// =====================================================================

describe('AC-O4: CapabilityFlag consumer compiles to capability set + provenance', () => {
  it('Stage B (empty producer): compile([]) yields the floor with empty provenance', () => {
    const set = compileCapabilityBoundingSet([]);
    expect(set.provenance).toEqual([]);
    expect(set).toEqual(DENIAL_FLOOR);
  });

  it('Stage C-style (non-empty producer): every non-floor grant attributes to a capability flag', () => {
    const set = compileCapabilityBoundingSet(['network-access', 'sandbox-mode']);
    const capabilityFlags = new Set(set.provenance.map(p => p.capabilityFlag));
    expect(capabilityFlags.has('network-access')).toBe(true);
    expect(capabilityFlags.has('sandbox-mode')).toBe(true);
    // Each provenance entry must carry at least one granted field.
    for (const entry of set.provenance) {
      expect(entry.grantedFields.length).toBeGreaterThan(0);
    }
  });

  it('capabilityFlagToApptainerFlags is exhaustive across the CapabilityFlag union', () => {
    for (const t of CAPABILITY_FLAGS) {
      const flags = capabilityFlagToApptainerFlags(t);
      expect(Array.isArray(flags)).toBe(true);
      expect(flags.length).toBeGreaterThan(0);
    }
  });
});

// =====================================================================
// AC-O5 — unknown capability → typed reject
// =====================================================================

describe('AC-O5: unknown capability rejection', () => {
  it('non-canonical CapabilityFlag string throws UnknownCapabilityError (not generic Error)', () => {
    let caught: unknown;
    try {
      compileCapabilityBoundingSet(['gpu-count-4'] as unknown as CapabilityFlag[]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownCapabilityError);
    expect((caught as UnknownCapabilityError).kind).toBe('unknown-capability');
  });

  it('error names the offending value for audit', () => {
    try {
      compileCapabilityBoundingSet(['rogue'] as unknown as CapabilityFlag[]);
    } catch (e) {
      const err = e as UnknownCapabilityError;
      expect(err.offendingValue).toBe('rogue');
    }
  });

  it('rejects methodology-skill because methodology is a TraitModule, not a CapabilityFlag', () => {
    expect(() =>
      compileCapabilityBoundingSet(['methodology-skill'] as string[]),
    ).toThrow(UnknownCapabilityError);
  });
});

// =====================================================================
// Surface-widening proof — capabilityFlags is now ReadonlyArray<CapabilityFlag>
// =====================================================================

describe('§6.7 boundary: ComputeCapabilitySurface.capabilityFlags is typed CapabilityFlag', () => {
  it('compute-capability.ts imports CapabilityFlag from contracts/capability-flag', () => {
    expect(CAPABILITY_SOURCE).toMatch(
      /import\s+type\s*\{\s*CapabilityFlag\s*\}\s*from\s*['"]\.\.\/contracts\/capability-flag\.js['"]/,
    );
  });

  it('capabilityFlags field is typed ReadonlyArray<CapabilityFlag>', () => {
    expect(CAPABILITY_SOURCE).toMatch(/readonly\s+capabilityFlags\?\s*:\s*ReadonlyArray<CapabilityFlag>/);
  });
});
