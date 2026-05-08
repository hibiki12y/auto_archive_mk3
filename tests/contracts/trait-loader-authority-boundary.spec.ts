/**
 * Risk 10 — regression coverage for the loader -> runtime authority
 * boundary.
 *
 * Contract being pinned (audit Risk 10 §06):
 *   `src/core/trait-module-loader.ts` is the authoritative source for trait
 *   admission. The AgentRuntime decorator wiring in
 *   `src/runtime/agent-runtime.ts` MUST NOT instantiate or admit a trait
 *   that the loader has rejected.
 *
 * Mechanism today (verified by these tests):
 *   - `parseTraitModuleManifest` rejects manifests that violate manifest
 *     shape rules or claim reserved kernel-authority keys.
 *   - `loadTraitRuntimeDriverDecorator` returns `{ status: 'failed', ... }`
 *     for any rejection path (capability boundary, trust boundary,
 *     non-decorator hook kind, missing export, ...). The result has
 *     `decorator: undefined` — the only field the runtime accepts as input
 *     for `traitRuntimeDecorators[].decorator`.
 *   - The `AgentRuntimeTraitRuntimeDecoratorBinding` interface requires
 *     `decorator: TraitRuntimeDriverDecorator` as a non-optional field, so
 *     a loader-rejected load cannot be passed through to the runtime
 *     without an explicit (and observable in code review) cast.
 *
 * Scope: regression coverage only. No production code touched. If a future
 * refactor weakens any of these boundary assertions, these tests fail.
 */
import { describe, expect, it } from 'vitest';

import {
  loadTraitRuntimeDriverDecorator,
  parseTraitModuleManifest,
  type TraitRuntimeDriverDecoratorLoad,
} from '../../src/core/trait-module-loader.js';
import type {
  TraitModuleId,
  TraitModuleManifest,
} from '../../src/contracts/trait-module.js';

function makeManifest(overrides: Partial<TraitModuleManifest> = {}): TraitModuleManifest {
  return {
    schemaVersion: 1,
    id: 'trait.test.boundary.v1' as TraitModuleId,
    name: 'boundary-test',
    version: '1.0.0',
    trustBoundary: 'repository-owned',
    layout: {
      root: 'traits/boundary-test',
      manifest: 'trait.json',
      instruction: 'TRAIT.md',
    },
    instructions: {
      entrypoint: 'TRAIT.md',
      format: 'markdown',
      summary: 'boundary test trait',
    },
    schedule: { mode: 'none' },
    runtime: {
      hook: 'evidence-decorator',
      modulePath: 'traits/boundary-test/runtime/decorator.mjs',
      exportName: 'decorate',
      enforcement: 'advisory',
      summary: 'evidence decorator',
    },
    admission: {
      defaultRequested: false,
      requiredCapabilityFlags: [],
      forbiddenCapabilityFlags: [],
      provenance: 'trait-loader-authority-boundary-test',
    },
    sourceMapIds: [],
    ...overrides,
  };
}

describe('Risk 10 — TraitModule loader authority boundary', () => {
  it('parseTraitModuleManifest rejects reserved kernel-authority claims (terminalCauseRewrite)', () => {
    // The loader is the authoritative gate for what becomes a TraitModule
    // manifest. A future refactor that loosens the reserved-key denylist
    // would let a manifest claim kernel-authority surfaces — surface that
    // the AgentRuntime would otherwise have no contract-level reason to
    // refuse downstream.
    expect(() =>
      parseTraitModuleManifest({
        ...makeManifest(),
        terminalCauseRewrite: true,
      }),
    ).toThrow(/terminalCauseRewrite is reserved for kernel-owned authority/);
  });

  it('parseTraitModuleManifest rejects malformed trait id (non-trait.<ns>.vN format)', () => {
    expect(() =>
      parseTraitModuleManifest({
        ...makeManifest(),
        id: 'not-a-trait-id',
      }),
    ).toThrow(/id must match trait\.<namespace>\.vN/);
  });

  it('loadTraitRuntimeDriverDecorator returns failed (no decorator) when manifest declares hook=none', async () => {
    const manifest = makeManifest({ runtime: { hook: 'none' } });
    const result = await loadTraitRuntimeDriverDecorator(manifest, {
      workspaceRoot: process.cwd(),
      importModule: async () => ({ decorate: () => undefined }),
    });

    // Skipped is the formal not-applicable status; the contract guarantees
    // there is no `decorator` to admit, exactly like a hard rejection.
    expect(result.status).toBe('skipped');
    expect((result as TraitRuntimeDriverDecoratorLoad).decorator).toBeUndefined();
  });

  it('loadTraitRuntimeDriverDecorator returns failed when the manifest hook kind is module-entrypoint (wrong shape for decorator path)', async () => {
    const manifest = makeManifest({
      runtime: {
        hook: 'module-entrypoint',
        modulePath: 'traits/boundary-test/runtime/entry.mjs',
        exportName: 'entry',
        enforcement: 'advisory',
        summary: 'wrong shape for decorator',
      },
    });
    const result = await loadTraitRuntimeDriverDecorator(manifest, {
      workspaceRoot: process.cwd(),
      importModule: async () => ({ entry: () => undefined }),
    });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('runtime-export-invalid');
    expect(result.decorator).toBeUndefined();
    expect(result.errorMessage).toMatch(/not an evidence-decorator/);
  });

  it('loadTraitRuntimeDriverDecorator rejects workspace-local trust boundary unless explicitly allowed', async () => {
    const manifest = makeManifest({ trustBoundary: 'workspace-local' });
    const rejected = await loadTraitRuntimeDriverDecorator(manifest, {
      workspaceRoot: process.cwd(),
      importModule: async () => ({ decorate: () => undefined }),
      // allowWorkspaceLocal omitted — defaults to false
    });
    expect(rejected.status).toBe('failed');
    expect(rejected.errorCode).toBe('runtime-trust-boundary-rejected');
    expect(rejected.decorator).toBeUndefined();

    // And the inverse: explicit opt-in flips the rejection.
    const admitted = await loadTraitRuntimeDriverDecorator(manifest, {
      workspaceRoot: process.cwd(),
      importModule: async () => ({ decorate: (d: unknown) => d }),
      allowWorkspaceLocal: true,
    });
    expect(admitted.status).toBe('loaded');
    expect(admitted.decorator).toBeTypeOf('function');
  });

  it('loadTraitRuntimeDriverDecorator returns failed (no decorator) when the export resolves to a non-function value', async () => {
    // A "trait" whose runtime module deserializes to something that is
    // not a callable decorator. The runtime would have no way to compose
    // it; the loader is the gate that catches this.
    const manifest = makeManifest();
    const result = await loadTraitRuntimeDriverDecorator(manifest, {
      workspaceRoot: process.cwd(),
      importModule: async () => ({ decorate: 'not a function' }),
    });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('runtime-export-invalid');
    expect(result.decorator).toBeUndefined();
    expect(result.errorMessage).toMatch(/is not a function/);
  });

  it('a loader-rejected result has no `decorator` field — the runtime cannot admit it without explicit unsafe casting', async () => {
    // Structural authority: the AgentRuntimeTraitRuntimeDecoratorBinding
    // interface requires `decorator: TraitRuntimeDriverDecorator`. Because
    // a loader-rejected load surface returns `decorator: undefined`, the
    // ONLY way to feed it to the runtime is an unsafe cast that is loud
    // in code review. This test pins that the rejection path never
    // produces a decorator value.
    const manifest = makeManifest({ trustBoundary: 'external' });
    const rejected = await loadTraitRuntimeDriverDecorator(manifest, {
      workspaceRoot: process.cwd(),
      importModule: async () => ({ decorate: () => undefined }),
      // allowExternal omitted — defaults to false
    });

    expect(rejected.status).toBe('failed');
    expect(rejected.errorCode).toBe('runtime-trust-boundary-rejected');
    expect(rejected.decorator).toBeUndefined();
    // The status field is the discriminator the runtime composition root
    // is expected to test BEFORE constructing a binding. Pinning the
    // shape here means a future refactor that returns a bare function or
    // a partial result will fail this assertion.
    expect(Object.keys(rejected)).not.toContain('decorator');
  });
});
